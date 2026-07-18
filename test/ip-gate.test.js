// The web IP allowlist (ipGate.js): BlockList-backed exact + CIDR matching, IPv4-mapped normalization,
// the two hard exemptions (loopback, /api/health), and save-time validation naming the bad entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-ipgate-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const gate = await import('../server/ipGate.js');
const { setAuthConfig } = await import('../server/settings.js');
migrate();

test('parseAllowlist accepts IPs + CIDRs and names every bad entry', () => {
  const ok = gate.parseAllowlist(['192.168.1.0/24', '203.0.113.7', '2001:db8::/32', '::1']);
  assert.deepEqual(ok.errors, []);
  const bad = gate.parseAllowlist(['bogus', '1.2.3.4/99', '300.1.1.1', '10.0.0.0/8']);
  assert.deepEqual(bad.errors, ['bogus', '1.2.3.4/99', '300.1.1.1']);
});

test('normalizeIp unwraps IPv4-mapped addresses; isLoopback covers v4 + v6', () => {
  assert.equal(gate.normalizeIp('::ffff:192.168.1.9'), '192.168.1.9');
  assert.equal(gate.normalizeIp('2001:db8::1'), '2001:db8::1');
  assert.ok(gate.isLoopback('127.0.0.1'));
  assert.ok(gate.isLoopback('127.8.8.8'));
  assert.ok(gate.isLoopback('::1'));
  assert.ok(gate.isLoopback('::ffff:127.0.0.1'));
  assert.ok(!gate.isLoopback('192.168.1.1'));
});

test('ipAllowedBy: exact, CIDR, mapped-v4, and loopback-always-passes', () => {
  const list = ['192.168.1.0/24', '203.0.113.7'];
  assert.equal(gate.ipAllowedBy('192.168.1.50', list), true);
  assert.equal(gate.ipAllowedBy('::ffff:192.168.1.50', list), true);
  assert.equal(gate.ipAllowedBy('203.0.113.7', list), true);
  assert.equal(gate.ipAllowedBy('203.0.113.8', list), false);
  assert.equal(gate.ipAllowedBy('10.0.0.1', list), false);
  assert.equal(gate.ipAllowedBy('127.0.0.1', list), true, 'loopback can never be locked out');
  assert.equal(gate.ipAllowedBy('::1', list), true);
  assert.equal(gate.ipAllowedBy('garbage', list), false);
});

// A minimal req/res pair for exercising the middleware directly.
const fakeRes = () => ({
  code: null, body: null,
  status(c) { this.code = c; return this; },
  json(o) { this.body = o; return this; },
  type() { return this; },
  send(b) { this.body = b; return this; },
});
const run = (req) => {
  const res = fakeRes();
  let passed = false;
  gate.ipGate(req, res, () => { passed = true; });
  return { passed, res };
};

test('the middleware: empty list passes everyone; a live list gates API and static alike', () => {
  setAuthConfig({ ipAllowlist: [] });
  assert.equal(run({ path: '/api/tasks', ip: '203.0.113.99' }).passed, true, 'no list → open');

  setAuthConfig({ ipAllowlist: ['192.168.1.0/24'] });
  try {
    assert.equal(run({ path: '/api/tasks', ip: '192.168.1.10' }).passed, true, 'allowed IP passes');
    const apiBlocked = run({ path: '/api/tasks', ip: '203.0.113.99' });
    assert.equal(apiBlocked.passed, false);
    assert.equal(apiBlocked.res.code, 403);
    assert.ok(apiBlocked.res.body.error, 'API gets a JSON error');
    const staticBlocked = run({ path: '/', ip: '203.0.113.99' });
    assert.equal(staticBlocked.passed, false, 'static is gated too');
    assert.equal(staticBlocked.res.code, 403);
    assert.equal(run({ path: '/api/health', ip: '203.0.113.99' }).passed, true,
      '/api/health is exempt — the platform healthcheck probes from a docker bridge IP');
    assert.equal(run({ path: '/api/tasks', ip: '127.0.0.1' }).passed, true, 'loopback is exempt');
    assert.equal(run({ path: '/api/tasks', ip: '::ffff:192.168.1.77' }).passed, true, 'mapped v4 matches');
  } finally {
    setAuthConfig({ ipAllowlist: [] });
  }
});
