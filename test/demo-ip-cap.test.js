// Per-IP seat cap on the public /demo form (routes/demo.js): the throttle bounds request RATE, but without
// this a patient actor could trickle valid-looking junk handles in — one real seat each — and burn the whole
// MAX_VOUCHED_USERS guest list. So one address may CLAIM only a few seats (DEMO_SIGNUPS_PER_IP, 24h rolling).
// Only SUCCESSFUL new signups count, so an honest typo-then-retry still works. Global cap is set high here so
// it never masks the per-IP cap; the handler is driven directly with mock req/res.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-ipcap-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';
process.env.MAX_VOUCHED_USERS = '100'; // plenty of global seats — isolate the per-IP cap
process.env.DEMO_SIGNUPS_PER_IP = '3';  // a few per address, room for an honest mistake

const { migrate } = await import('../server/db.js');
const { setGuardConfig, setTelegramConfig } = await import('../server/settings.js');
const { isVouched, countActiveVouches } = await import('../server/repo.js');
const { setOwnerNotifier } = await import('../server/notifyOwner.js');
const { demoRequestHandler } = await import('../server/routes/demo.js');

migrate();
setTelegramConfig({ ownerId: null, allowedUsername: '' });
setGuardConfig({ demoSignupOpen: true, demoPaused: false, vouchFrozen: false });
setOwnerNotifier(async () => {}); // swallow the heads-up push

const mockRes = () => ({
  statusCode: 200, body: null,
  status(c) { this.statusCode = c; return this; },
  json(o) { this.body = o; return this; },
  type() { return this; },
  send(s) { this.body = s; return this; },
});
const request = (handle, ip) => {
  const res = mockRes();
  demoRequestHandler({ body: { handle }, ip }, res);
  return res;
};

test('a single IP may claim only DEMO_SIGNUPS_PER_IP seats; the next is refused (not vouched)', () => {
  const ip = '203.0.113.20';
  for (const h of ['aaa_one', 'aaa_two', 'aaa_three']) {
    assert.equal(request(h, ip).statusCode, 200, `${h} is within the allowance`);
    assert.ok(isVouched(h));
  }
  const over = request('aaa_four', ip);
  assert.equal(over.statusCode, 429, 'the 4th seat from this address is refused');
  assert.match(over.body.error, /already|activate|later/i);
  assert.equal(isVouched('aaa_four'), false, 'the over-cap handle is NOT vouched in — no seat consumed');
});

test('the cap is per-address: a different IP is unaffected', () => {
  assert.equal(request('bbb_one', '203.0.113.21').statusCode, 200);
  assert.ok(isVouched('bbb_one'));
});

test('a rejected (invalid) submission does NOT count toward the cap', () => {
  const ip = '203.0.113.22';
  assert.equal(request('hi', ip).statusCode, 400, 'too short — rejected, not filed');
  // The invalid one cost nothing, so all THREE valid signups still fit under the cap of 3.
  for (const h of ['ccc_one', 'ccc_two', 'ccc_three']) {
    assert.equal(request(h, ip).statusCode, 200, `${h} still fits — the invalid attempt was free`);
  }
});

test('an already-in resubmission (idempotent success) does NOT count toward the cap', () => {
  const ip = '203.0.113.23';
  assert.equal(request('ddd_one', ip).statusCode, 200);        // seat 1
  assert.equal(request('ddd_one', ip).body.already, true);     // resubmit — free
  assert.equal(request('ddd_two', ip).statusCode, 200);        // seat 2
  assert.equal(request('ddd_three', ip).statusCode, 200);      // seat 3 — only reached because the resubmit was free
  assert.ok(isVouched('ddd_three'));
});

test('the seats are real: they count against the global guest list', () => {
  // Sanity: everything above actually consumed global seats (no double-counting weirdness).
  assert.ok(countActiveVouches('telegram') >= 8);
});
