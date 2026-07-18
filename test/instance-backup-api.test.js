// The BACKUP_MODE-gated instance export over real HTTP. api.test.js (which boots WITHOUT the flag) proves
// the 404 gate; this file boots WITH it and proves the happy path: the download really is a restorable
// package (validated with the same code the setup wizard uses), the KEK checkbox works, and the checkpoint
// leaves nothing behind in the WAL.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-bkapi-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';
process.env.BACKUP_MODE = '1';
// Force the on-box bootstrap KEK into a known scratch file so kekFileExists/kek entry are deterministic.
process.env.KEK_FILE = join(process.env.DATA_DIR, '..', `fanad-bkapi-kek-${process.pid}`);
writeFileSync(process.env.KEK_FILE, Buffer.alloc(32, 3));

const express = (await import('express')).default;
const { migrate } = await import('../server/db.js');
migrate();
const apiRouter = (await import('../server/routes/api.js')).default;
const { validateInstancePackage } = await import('../server/instancePackage.js');
const { defaultUserId, insertTask } = await import('../server/repo.js');

insertTask({ userId: defaultUserId(), summary: 'exported over http' });

const app = express();
app.use(express.json());
app.use('/api', apiRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
after(() => { server.closeAllConnections?.(); server.close(); });

test('GET /instance/status reports the flag and the key situation', async () => {
  const s = await (await fetch(`${base}/instance/status`)).json();
  assert.equal(s.backupMode, true);
  assert.equal(s.kekFileExists, true);
  assert.ok(['env', 'temp', 'none'].includes(s.kekSource));
});

test('GET /instance/export downloads a restorable package (KEK excluded by default)', async () => {
  const r = await fetch(`${base}/instance/export`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/zip');
  assert.match(r.headers.get('content-disposition'), /attachment; filename="fanad-backup-\d{8}-\d{6}\.zip"/);
  const v = validateInstancePackage(Buffer.from(await r.arrayBuffer()));
  assert.equal(v.kek, null, 'the key must not ride along unless asked for');
  assert.ok(v.files.some((f) => f.name === 'fanad.db'));
  assert.ok(!v.files.some((f) => f.name.includes('-wal')), 'checkpointed — no WAL in the package');
});

test('GET /instance/export?kek=1 includes the key file', async () => {
  const r = await fetch(`${base}/instance/export?kek=1`);
  const v = validateInstancePackage(Buffer.from(await r.arrayBuffer()));
  assert.deepEqual(v.kek, Buffer.alloc(32, 3));
  assert.equal(v.manifest.kekIncluded, true);
});
