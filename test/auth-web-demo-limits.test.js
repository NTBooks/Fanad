// Per-IP abuse controls on the browser demo-register door: the seat cap (guard.demoSignupsPerIp, live) and
// the request-rate throttle (5 / 10 min, fixed). Both are module-level in routes/auth.js, so this file drives
// them in a deliberate order — seat cap first, then throttle — since a tripped throttle can't reset mid-run.
// The global maxWebDemoAccounts cap needs its own env and lives in auth-web-demo-cap.test.js.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-webdemo-lim-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';
delete process.env.MAX_WEB_DEMO_ACCOUNTS; // global cap OFF here — one cap under test at a time

const express = (await import('express')).default;
const { migrate } = await import('../server/db.js');
migrate();
const { sessionMiddleware, apiAuthGate } = await import('../server/auth.js');
const authRouter = (await import('../server/routes/auth.js')).default;
const apiRouter = (await import('../server/routes/api.js')).default;
const { setAuthConfig, setGuardConfig } = await import('../server/settings.js');
const { getUserByUsername } = await import('../server/repo.js');

const app = express();
app.use(express.json());
app.use(sessionMiddleware);
app.use('/api/auth', authRouter);
app.use('/api', apiAuthGate, apiRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.closeAllConnections?.(); server.close(); });

const reg = (username) => fetch(`${base}/api/auth/register`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, password: 'passphrase1' }),
});

setAuthConfig({ mode: 'simple', allowRegistration: true });

test('per-IP SEAT cap: past guard.demoSignupsPerIp new signups from one address are refused (429)', async () => {
  setGuardConfig({ demoSignupOpen: true, demoSignupsPerIp: 2 });
  assert.equal((await reg('seat1')).status, 200);
  assert.equal((await reg('seat2')).status, 200);
  const third = await reg('seat3');
  assert.equal(third.status, 429, 'the 3rd seat from this IP is capped');
  assert.equal(getUserByUsername('seat3'), null, 'a capped request creates no row');
});

test('per-IP request THROTTLE: past 5 requests in the window one address is rate-limited (429)', async () => {
  setGuardConfig({ demoSignupsPerIp: 0 }); // seat cap OFF so the throttle is what fires
  // The seat test above already spent 3 throttle slots (2 ok + 1 recorded-then-capped); two more reach 5…
  assert.equal((await reg('thr4')).status, 200);
  assert.equal((await reg('thr5')).status, 200);
  const sixth = await reg('thr6');
  assert.equal(sixth.status, 429, 'the 6th request in the window is throttled');
  assert.equal(getUserByUsername('thr6'), null, 'a throttled request creates no row');
});
