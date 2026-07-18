// The "AI activity log" (server/aiLog.js): a bounded, operator-toggled capture of every LLM call so you can
// SEE what the model is doing. Verifies <think> capture, on/off gating, purpose tagging, failure recording
// (the silent-fallback symptom made visible), and the ring-buffer bound. Uses the deterministic mock provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-ailog-'));
process.env.KEK = Buffer.alloc(32, 9).toString('base64');

const { migrate } = await import('../server/db.js');
const settings = await import('../server/settings.js');
const llm = await import('../server/services/llm/index.js');
const aiLog = await import('../server/aiLog.js');

migrate();
settings.setLlmConfig({ provider: 'mock', embedProvider: 'mock' });

test('splitThink extracts the reasoning and returns only the visible answer', () => {
  const { visible, reasoning } = llm.splitThink('<think>weighing the options</think>\nDo the dishes.');
  assert.equal(visible, 'Do the dishes.');
  assert.match(reasoning, /weighing the options/);
  // no <think> block → reasoning empty, content just trimmed (unchanged contract for non-reasoning models)
  const plain = llm.splitThink('  just text  ');
  assert.equal(plain.visible, 'just text');
  assert.equal(plain.reasoning, '');
});

test('records calls only when enabled, tagged by purpose; failures are captured too; clear empties it', async () => {
  // OFF (default) → nothing recorded, even though the call runs and returns normally
  settings.setAiLogConfig({ enabled: false });
  aiLog.clearAiLog();
  const off = await llm.chat({ messages: [{ role: 'user', content: 'call the dentist' }], purpose: 'classify-task' });
  assert.equal(typeof off, 'string');               // caller still gets clean text
  assert.equal(aiLog.getAiLog().logs.length, 0);     // …but nothing was logged

  // ON → the call is captured with its purpose + provider, and the caller still gets clean text
  settings.setAiLogConfig({ enabled: true });
  aiLog.clearAiLog();
  await llm.chat({ messages: [{ role: 'user', content: 'call the dentist' }], purpose: 'classify-task' });
  const [entry] = aiLog.getAiLog().logs;
  assert.equal(entry.kind, 'chat');
  assert.equal(entry.purpose, 'classify-task');
  assert.equal(entry.provider, 'mock');
  assert.equal(entry.ok, true);
  assert.match(entry.prompt, /call the dentist/);

  // embeddings are logged too (lightweight) — this is what reveals whether the similarity term even fires
  await llm.embed('call the dentist');
  const emb = aiLog.getAiLog().logs.find((l) => l.kind === 'embed');
  assert.ok(emb && emb.ok === true);

  // a FAILED call is recorded with ok:false — the silent-fallback symptom, now visible
  aiLog.clearAiLog();
  await assert.rejects(llm.chat({ messages: [{ role: 'user', content: '__llm_http_500__' }], purpose: 'classify-task' }));
  const [fail] = aiLog.getAiLog().logs;
  assert.equal(fail.ok, false);
  assert.match(fail.error, /500/);

  // clear empties the buffer
  aiLog.clearAiLog();
  assert.equal(aiLog.getAiLog().logs.length, 0);
});

test('the ring buffer is bounded — oldest entries roll off', async () => {
  settings.setAiLogConfig({ enabled: true });
  aiLog.clearAiLog();
  for (let i = 0; i < 160; i++) {
    await llm.chat({ messages: [{ role: 'user', content: `task ${i}` }], purpose: 'classify-task' });
  }
  assert.ok(aiLog.getAiLog().logs.length <= 150, `expected ≤150, got ${aiLog.getAiLog().logs.length}`);
});
