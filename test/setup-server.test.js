// First-run setup wizard (installer.bat → server/scripts/setup-server.js): the .env it renders,
// the never-overwrite guarantee, and the HTTP form round-trip. The wizard runs before npm install,
// so this also pins its zero-dependency contract (node built-ins only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'fanad-setup-'));
process.env.SETUP_ENV_PATH = join(dir, '.env'); // module reads this at import time
const { buildEnvFile, createSetupServer } = await import('../server/scripts/setup-server.js');

const envMap = (text) => Object.fromEntries(
  text.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

test('defaults: empty form → local lmstudio, cloud gate OFF, port 8787', () => {
  const env = envMap(buildEnvFile({}));
  assert.equal(env.PORT, '8787');
  assert.equal(env.LLM_PROVIDER, 'lmstudio');
  assert.equal(env.EMBED_PROVIDER, 'lmstudio');
  assert.equal(env.LLM_ALLOW_CLOUD, '');
  assert.equal(env.TELEGRAM_BOT_TOKEN, '');
});

test('picking a cloud provider flips LLM_ALLOW_CLOUD on; ollama routes the base URL', () => {
  const cloud = envMap(buildEnvFile({ llm_provider: 'anthropic', anthropic_key: 'sk-ant-x' }));
  assert.equal(cloud.LLM_ALLOW_CLOUD, '1');
  assert.equal(cloud.ANTHROPIC_API_KEY, 'sk-ant-x');
  const ollama = envMap(buildEnvFile({ llm_provider: 'ollama', base_url: 'http://10.0.0.5:11434/v1' }));
  assert.equal(ollama.OLLAMA_BASE_URL, 'http://10.0.0.5:11434/v1');
  assert.equal(ollama.LMSTUDIO_BASE_URL, '');
});

test('hostile values are neutralized: no newline injection, bogus provider/port fall back', () => {
  const env = envMap(buildEnvFile({
    telegram_token: '123:abc\nKEK=stolen', llm_provider: 'evil', embed_provider: 'anthropic', port: '999999',
  }));
  assert.equal(env['KEK=stolen'], undefined); // the \n was collapsed, not a new line
  assert.match(env.TELEGRAM_BOT_TOKEN, /123:abc/);
  assert.equal(env.LLM_PROVIDER, 'lmstudio'); // allowlist fallback
  assert.equal(env.EMBED_PROVIDER, 'lmstudio'); // anthropic has no embeddings API
  assert.equal(env.PORT, '65535');
});

// Declared BEFORE the .env-writing round-trip test on purpose: /restore only works while no .env exists.
test('POST /restore lands a backup in DATA_DIR (with the key) before setup has run', async () => {
  const { zipSync } = await import('../server/zip.js');
  const scratch = mkdtempSync(join(tmpdir(), 'fanad-setup-restore-'));
  process.env.DATA_DIR = join(scratch, 'data'); // resolveDataDir reads env at call time
  // A minimal structurally-valid SQLite file: correct magic + user_version 1 at header offset 60.
  const fakeDb = Buffer.alloc(100);
  fakeDb.write('SQLite format 3\0', 0, 'latin1');
  fakeDb.writeUInt32BE(1, 60);
  const zip = zipSync([
    {
      name: 'manifest.json',
      data: Buffer.from(JSON.stringify({ kind: 'fanad-instance-package', formatVersion: 1, schemaVersion: 1, kekSource: 'temp', kekIncluded: true })),
    },
    { name: 'kek', data: Buffer.alloc(32, 5) },
    { name: 'data/fanad.db', data: fakeDb },
    { name: 'data/images/1/pic.png', data: Buffer.from([1, 2, 3]) },
  ]);

  const server = createSetupServer(() => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const junk = await fetch(`${base}/restore`, { method: 'POST', body: Buffer.from('not a zip') });
    assert.equal(junk.status, 400);
    assert.match((await junk.json()).error, /not a zip/i);

    const r = await fetch(`${base}/restore`, { method: 'POST', headers: { 'content-type': 'application/zip' }, body: zip });
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.equal(out.ok, true);
    assert.equal(out.fileCount, 2);
    assert.equal(out.kekIncluded, true);
    assert.deepEqual(readFileSync(join(process.env.DATA_DIR, 'fanad.db')), fakeDb);
    assert.deepEqual(readFileSync(join(process.env.DATA_DIR, 'images', '1', 'pic.png')), Buffer.from([1, 2, 3]));
    assert.deepEqual(readFileSync(`${process.env.DATA_DIR}.kek`), Buffer.alloc(32, 5)); // key beside the data dir
  } finally {
    server.close();
    delete process.env.DATA_DIR;
  }
});

test('HTTP round-trip: GET serves the form, POST writes .env once, a second POST refuses', async () => {
  const server = createSetupServer(() => {}); // no-op onSaved: the test drives shutdown
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const form = await (await fetch(`${base}/`)).text();
  assert.match(form, /Fanad/);
  assert.match(form, /telegram_token/);

  const save = await fetch(`${base}/save`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ port: '9090', telegram_token: '42:token', llm_provider: 'ollama' }),
  });
  assert.equal(save.status, 200);
  assert.match(await save.text(), /Setup complete/);
  assert.equal(existsSync(process.env.SETUP_ENV_PATH), true);
  const written = envMap(readFileSync(process.env.SETUP_ENV_PATH, 'utf8'));
  assert.equal(written.PORT, '9090');
  assert.equal(written.TELEGRAM_BOT_TOKEN, '42:token');
  assert.equal(written.LLM_PROVIDER, 'ollama');

  // Never-overwrite: the file now exists, so a second save must 409 and leave it untouched.
  const again = await fetch(`${base}/save`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ port: '1111' }),
  });
  assert.equal(again.status, 409);
  assert.equal(envMap(readFileSync(process.env.SETUP_ENV_PATH, 'utf8')).PORT, '9090');

  // And GET now reports "already ran" instead of offering the form again.
  assert.match(await (await fetch(`${base}/`)).text(), /Setup already ran/);

  // Restore is a first-run tool: once .env exists it refuses too (delete .env to redo setup).
  const restore = await fetch(`${base}/restore`, { method: 'POST', body: Buffer.from('irrelevant') });
  assert.equal(restore.status, 409);
  server.close();
});
