// LLM_ALLOW_CLOUD hard-blocks cloud providers at the runtime factory (not just the settings write-path),
// and the local Ollama provider is never gated and defaults to its own :11434 base URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-flag-'));
delete process.env.LLM_ALLOW_CLOUD; // cloud OFF (default)
process.env.KEK = Buffer.alloc(32, 7).toString('base64');

const { migrate } = await import('../server/db.js');
const settings = await import('../server/settings.js');
const llm = await import('../server/services/llm/index.js');

migrate();

test('cloud provider is hard-blocked at the runtime factory when the flag is off', () => {
  settings.setLlmConfig({ provider: 'openai', embedProvider: 'openai' });
  assert.throws(() => llm.chat({ messages: [{ role: 'user', content: 'hi' }] }), /disabled/i);
  assert.throws(() => llm.embed('hello'), /disabled/i);
});

test('llmStatus reports the cloud provider as disabled (without throwing) so health stays up', async () => {
  const st = await llm.llmStatus();
  assert.equal(st.ok, false);
  assert.equal(st.provider, 'openai');
  assert.match(st.error, /disabled/i);
});

test('Ollama is a local provider: never gated, default base URL is :11434', async () => {
  settings.setLlmConfig({ provider: 'ollama', embedProvider: 'ollama' });
  assert.match(settings.getLlmConfig().baseUrl, /:11434/);
  const st = await llm.llmStatus();           // no Ollama running here → unreachable, but NOT "disabled"
  assert.equal(st.provider, 'ollama');
  assert.doesNotMatch(String(st.error || ''), /disabled/i);
});

test('LM Studio keeps its own :1234 default base URL', () => {
  settings.setLlmConfig({ provider: 'lmstudio', embedProvider: 'lmstudio' });
  assert.match(settings.getLlmConfig().baseUrl, /:1234/);
});
