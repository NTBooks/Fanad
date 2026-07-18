// The public /demo signup page (routes/demo.js): a visitor enters their Telegram handle and is vouched in
// by the demo service account — but ONLY while the owner's demoSignupOpen guard switch is on, and always
// behind the same public-safety gates as chat vouching (freeze switch, MAX_VOUCHED_USERS seat cap) plus a
// per-IP throttle. Exercises the route handlers directly with mock req/res — no live server needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-demo-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';
process.env.MAX_VOUCHED_USERS = '3'; // small seat cap so the "guest list full" gate is testable

const { migrate } = await import('../server/db.js');
const { setGuardConfig, setTelegramConfig } = await import('../server/settings.js');
const {
  addVouch, isVouched, getActiveVouch, listUsers, countActiveVouches, getOrCreateDemoServiceUserId, DEMO_VOUCHER_NAME,
} = await import('../server/repo.js');
const { setOwnerNotifier } = await import('../server/notifyOwner.js');
const { demoPageHandler, demoRequestHandler } = await import('../server/routes/demo.js');

migrate();
setTelegramConfig({ ownerId: null, allowedUsername: '' });

// Minimal Express req/res stand-ins: the handlers only touch body/ip and status/json/type/send.
const mockRes = () => ({
  statusCode: 200, body: null,
  status(c) { this.statusCode = c; return this; },
  json(o) { this.body = o; return this; },
  type() { return this; },
  send(s) { this.body = s; return this; },
});
const request = (handle, ip = '203.0.113.10') => {
  const res = mockRes();
  demoRequestHandler({ body: { handle }, ip }, res);
  return res;
};
const page = () => {
  const res = mockRes();
  demoPageHandler({}, res);
  return res.body;
};

test('signups are CLOSED by default: the POST refuses and the page says so (but still previews)', () => {
  const res = request('walkin', '203.0.113.1');
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /closed/i);
  assert.equal(isVouched('walkin'), false);
  const html = page();
  assert.match(html, /demo is closed/i, 'closed state renders a page, never a 404');
  assert.match(html, /og:title/, 'link-preview tags are present even while closed');
});

test('the page inlines the shared ocean sim as a classic script (both open and closed states)', () => {
  setGuardConfig({ demoSignupOpen: false });
  const closed = page();
  setGuardConfig({ demoSignupOpen: true });
  const open = page();
  for (const html of [closed, open]) {
    assert.match(html, /<div id="sea"[^>]*><canvas/, 'the sea canvas column is in the page');
    // The inline copy must be valid CLASSIC script: the module's `export ` keywords stripped, and
    // no early script-close — the mount call must land in the SAME script block as the sim source
    // (a stray close sequence anywhere in the sim once truncated the page and spilled code as text).
    assert.ok(!/^export /m.test(html), 'no module syntax leaked into the inline script');
    const seaScript = html.split('<script>').find((s) => s.includes('function makeSim'));
    assert.ok(seaScript, 'the sim source is inlined');
    const body = seaScript.slice(0, seaScript.indexOf('</script>'));
    assert.ok(body.includes('mountOcean(document.querySelector'), 'the sim script survives to its mount call un-truncated');
  }
  setGuardConfig({ demoSignupOpen: false });
});

test('open signups: a valid handle is vouched in by the demo service account, and the owner hears about it', async () => {
  setGuardConfig({ demoSignupOpen: true });
  assert.match(page(), /id="f"/, 'the open page renders the signup form');
  // Junk in, nothing on the whitelist: same handle rule as chat "vouch".
  const bad = request('hi', '203.0.113.2');
  assert.equal(bad.statusCode, 400);
  // A real signup — the owner gets the usual heads-up push.
  setTelegramConfig({ ownerId: 4242, allowedUsername: '' });
  const pushes = [];
  setOwnerNotifier(async (text) => { pushes.push(text); });
  const res = request('@Zoe_Demo', '203.0.113.2');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.handle, 'zoe_demo');
  assert.ok(isVouched('zoe_demo'));
  const row = getActiveVouch('zoe_demo');
  assert.equal(row.voucher_username, DEMO_VOUCHER_NAME, 'attributed to @demo, not the owner');
  assert.equal(Number(row.voucher_user_id), getOrCreateDemoServiceUserId());
  assert.equal(getOrCreateDemoServiceUserId(), getOrCreateDemoServiceUserId(), 'service account id is stable');
  assert.ok(listUsers().some((u) => u.display_name === DEMO_VOUCHER_NAME && u.telegram_id == null && u.slack_id == null),
    'the service account is an ordinary users row with no platform identity');
  await new Promise((r) => setImmediate(r)); // notifyOwner is fire-and-forget
  assert.match(pushes.join('\n'), /@zoe_demo/);
  setTelegramConfig({ ownerId: null });
});

test('re-requesting an already-vouched handle (or a seed) is an idempotent success, not an error', () => {
  const again = request('zoe_demo', '203.0.113.3');
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.already, true);
  setTelegramConfig({ allowedUsername: '@seeduser' });
  const seed = request('seeduser', '203.0.113.3');
  assert.equal(seed.statusCode, 200);
  assert.equal(seed.body.already, true);
  assert.equal(isVouched('seeduser'), false, 'a seed needs no vouch row');
  setTelegramConfig({ allowedUsername: '' });
});

test('the vouch freeze switch blocks NEW demo signups too', () => {
  setGuardConfig({ vouchFrozen: true });
  const res = request('frosty', '203.0.113.4');
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /paused/i);
  assert.equal(isVouched('frosty'), false);
  setGuardConfig({ vouchFrozen: false });
});

test('MAX_VOUCHED_USERS caps demo signups like any other vouch', () => {
  // zoe_demo holds seat 1; fill the rest of the cap (3) directly.
  addVouch({ username: 'seat_two', voucherUserId: 1, voucherUsername: 'owner' });
  addVouch({ username: 'seat_three', voucherUserId: 1, voucherUsername: 'owner' });
  assert.equal(countActiveVouches('telegram'), 3);
  const res = request('overflow', '203.0.113.5');
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /full/i);
});

test('a hammering IP is throttled', () => {
  // 5 requests per 10 minutes per IP; every request counts, whatever its outcome (all 403 "full" here).
  for (let i = 0; i < 5; i++) assert.equal(request(`spam_${i}`, '198.51.100.7').statusCode, 403);
  const sixth = request('spam_5', '198.51.100.7');
  assert.equal(sixth.statusCode, 429);
});

test('demo pause closes the signup page even while the signup switch is on', () => {
  setGuardConfig({ demoPaused: true });
  assert.equal(request('pausedout', '203.0.113.6').statusCode, 403);
  assert.match(page(), /demo is closed/i);
  setGuardConfig({ demoPaused: false });
});
