// Bootstrap KEK: with NO env KEK the app auto-generates an on-box key (enc:t1) so nothing is plaintext;
// when an env KEK later arrives, boot migration re-keys everything to enc:v1 and retires the key file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-kek-'));
delete process.env.KEK; // the whole point: boot with no env KEK
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const crypto = await import('../server/crypto.js');
const { migrate, db } = await import('../server/db.js');
const settings = await import('../server/settings.js');

migrate();
const KEK_FILE = `${process.env.DATA_DIR}.kek`;
const rawSetting = (key) => db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? '';

test('no env KEK → generates an on-box bootstrap key (enc:t1), as a sibling of the data dir', () => {
  assert.equal(crypto.kekSource(), 'temp');
  assert.ok(existsSync(KEK_FILE), 'bootstrap key file should exist');
  assert.ok(!existsSync(join(process.env.DATA_DIR, '.kek')), 'and NOT inside the data dir');
  const enc = crypto.encryptSecret('abc');
  assert.match(enc, /^enc:t1:/);
  assert.equal(crypto.decryptSecret(enc), 'abc');
});

test('secrets saved without an env KEK are enc:t1 at rest (never plaintext)', () => {
  settings.setTelegramConfig({ botToken: 'tok-123' });
  settings.setLlmConfig({ openai: { apiKey: 'sk-temp-key' } });
  assert.ok(rawSetting('telegram').includes('enc:t1:') && !rawSetting('telegram').includes('tok-123'));
  assert.ok(rawSetting('llm').includes('enc:t1:') && !rawSetting('llm').includes('sk-temp-key'));
  assert.equal(settings.getTelegramConfig().botToken, 'tok-123');
  assert.equal(settings.getLlmConfig().openai.apiKey, 'sk-temp-key');
});

test('when an env KEK arrives, boot migration re-keys enc:t1 → enc:v1 and deletes the bootstrap file', () => {
  // Simulate a restart that now has an env KEK (the bootstrap file is still on disk to migrate off).
  crypto.initKek({ envRaw: randomBytes(32).toString('base64'), file: KEK_FILE });
  assert.equal(crypto.kekSource(), 'env');
  assert.equal(crypto.needsRekey(), true);

  settings.migrateSecretsAtRest();

  assert.ok(rawSetting('telegram').includes('enc:v1:') && !rawSetting('telegram').includes('enc:t1:'));
  assert.ok(rawSetting('llm').includes('enc:v1:') && !rawSetting('llm').includes('enc:t1:'));
  assert.equal(crypto.needsRekey(), false);
  assert.ok(!existsSync(KEK_FILE), 'bootstrap key file is retired after a clean migration');
  // Values survive the re-key, now readable under the env KEK.
  assert.equal(settings.getTelegramConfig().botToken, 'tok-123');
  assert.equal(settings.getLlmConfig().openai.apiKey, 'sk-temp-key');
});

test('a second migration pass with no bootstrap file is a no-op', () => {
  assert.doesNotThrow(() => settings.migrateSecretsAtRest());
  assert.equal(settings.getLlmConfig().openai.apiKey, 'sk-temp-key');
});
