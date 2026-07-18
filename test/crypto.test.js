// Secret-at-rest encryption: KEK lifecycle, the tagged format, fail-closed decryption, and the
// end-to-end guarantee that LLM keys + the Telegram token are stored as ciphertext but read back clear.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-crypto-'));
process.env.KEK = randomBytes(32).toString('base64'); // crypto.js reads + deletes this at import time
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const crypto = await import('../server/crypto.js');
const { migrate, db } = await import('../server/db.js');
const settings = await import('../server/settings.js');

migrate();
const rawSetting = (key) => db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? '';

test('the KEK is consumed from process.env at load (anti-enumeration)', () => {
  assert.equal(process.env.KEK, undefined);
  assert.equal(crypto.kekPresent(), true);
});

test('encryptSecret → tagged ciphertext that round-trips', () => {
  const enc = crypto.encryptSecret('sk-secret-123');
  assert.match(enc, /^enc:v1:/);
  assert.notEqual(enc, 'sk-secret-123');
  assert.equal(crypto.decryptSecret(enc), 'sk-secret-123');
});

test('a fresh nonce per call → same plaintext encrypts differently', () => {
  assert.notEqual(crypto.encryptSecret('same'), crypto.encryptSecret('same'));
});

test('legacy plaintext and empty/null values pass through unchanged', () => {
  assert.equal(crypto.decryptSecret('plain-old-key'), 'plain-old-key'); // no enc: tag → not ours
  assert.equal(crypto.decryptSecret(''), '');
  assert.equal(crypto.decryptSecret(null), null);
  assert.equal(crypto.encryptSecret(''), '');
  assert.equal(crypto.encryptSecret(null), null);
});

test('tampered ciphertext fails closed → null (GCM authenticates)', () => {
  const enc = crypto.encryptSecret('top-secret');
  const tampered = `${enc.slice(0, -4)}AAAA`;
  assert.equal(crypto.decryptSecret(tampered), null);
});

test('LLM API key is stored encrypted at rest but read back in clear', () => {
  settings.setLlmConfig({ openai: { apiKey: 'sk-live-xyz' } });
  const raw = rawSetting('llm');
  assert.ok(!raw.includes('sk-live-xyz'), 'plaintext key must not be in the DB');
  assert.ok(raw.includes('enc:v1:'), 'DB value should hold ciphertext');
  assert.equal(settings.getLlmConfig().openai.apiKey, 'sk-live-xyz'); // decrypted for use
});

test('Telegram bot token is encrypted at rest and decrypted on read', () => {
  settings.setTelegramConfig({ botToken: '123456:ABC-DEF' });
  const raw = rawSetting('telegram');
  assert.ok(!raw.includes('123456:ABC-DEF'));
  assert.ok(raw.includes('enc:v1:'));
  assert.equal(settings.getTelegramConfig().botToken, '123456:ABC-DEF');
});

test('re-saving other LLM fields keeps the previously-encrypted key intact', () => {
  settings.setLlmConfig({ openai: { chatModel: 'gpt-4o' } }); // no key in this patch
  assert.equal(settings.getLlmConfig().openai.apiKey, 'sk-live-xyz');
  assert.equal(settings.getLlmConfig().openai.chatModel, 'gpt-4o');
});
