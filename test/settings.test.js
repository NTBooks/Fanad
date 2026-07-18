// DB-backed LLM settings: defaults, persistence, merge, cache invalidation. No .env required.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-settings-')); // note: LLM_PROVIDER intentionally unset

const { migrate } = await import('../server/db.js');
const { getLlmConfig, setLlmConfig, getSetting } = await import('../server/settings.js');

migrate();

test('defaults to local LM Studio with no env and no saved settings', () => {
  const c = getLlmConfig();
  assert.equal(c.provider, 'lmstudio');
  assert.equal(c.baseUrl, 'http://127.0.0.1:1234/v1');
});

test('saving config persists and overrides defaults', () => {
  setLlmConfig({ baseUrl: 'http://192.168.1.50:1234/v1', chatModel: 'google/gemma-4-12b-qat', embedModel: 'nomic-embed-text' });
  const c = getLlmConfig();
  assert.equal(c.baseUrl, 'http://192.168.1.50:1234/v1');
  assert.equal(c.chatModel, 'google/gemma-4-12b-qat');
  assert.equal(c.embedModel, 'nomic-embed-text');
  // persisted to the DB (not just the cache)
  assert.equal(getSetting('llm').chatModel, 'google/gemma-4-12b-qat');
});

test('partial updates merge (do not clobber other fields)', () => {
  setLlmConfig({ chatModel: 'qwen2.5-7b-instruct' });
  const c = getLlmConfig();
  assert.equal(c.chatModel, 'qwen2.5-7b-instruct');
  assert.equal(c.baseUrl, 'http://192.168.1.50:1234/v1'); // unchanged
  assert.equal(c.embedModel, 'nomic-embed-text');         // unchanged
});
