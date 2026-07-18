// The global browser-demo-account cap (MAX_WEB_DEMO_ACCOUNTS → config.limits.maxWebDemoAccounts): a hard
// backstop behind the per-IP limits so no address-hopping actor can fill the box with TOTP-free accounts.
// It's env-set (read at config load), so it gets its own file. Seat cap is off here so the global cap is the
// one under test.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-webdemo-cap-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';
process.env.MAX_WEB_DEMO_ACCOUNTS = '1'; // must be set BEFORE config.js loads

const express = (await import('express')).default;
const { migrate } = await import('../server/db.js');
migrate();
const { config } = await import('../server/config.js');
const { sessionMiddleware, apiAuthGate } = await import('../server/auth.js');
const authRouter = (await import('../server/routes/auth.js')).default;
const apiRouter = (await import('../server/routes/api.js')).default;
const { setAuthConfig, setGuardConfig } = await import('../server/settings.js');
const { getUserByUsername, countWebAccounts } = await import('../server/repo.js');

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
setGuardConfig({ demoSignupOpen: true, demoSignupsPerIp: 0 }); // seat cap off — isolate the global cap

test('the env cap is loaded and countWebAccounts starts at zero on a fresh box', () => {
  assert.equal(config.limits.maxWebDemoAccounts, 1);
  assert.equal(countWebAccounts(), 0);
});

test('once the global cap is reached, further browser signups are refused (403)', async () => {
  assert.equal((await reg('capone')).status, 200);
  assert.equal(countWebAccounts(), 1, 'the one demo account counts');
  const second = await reg('captwo');
  assert.equal(second.status, 403, 'the box is full');
  assert.equal(getUserByUsername('captwo'), null, 'a capped request creates no row');
});
