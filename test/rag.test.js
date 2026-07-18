// Phase-3 suggestion-engine tests with the mock LLM (deterministic).
// Verifies the closed-world invariant: the engine only ever recommends the user's own rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-rag-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { ingest } = await import('../server/ingest.js');
const { suggestTask } = await import('../server/rag/index.js');
const { listAvailableTasksWithVectors, setTaskStatus, defaultUserId } = await import('../server/repo.js');
const settings = await import('../server/settings.js');
const aiLog = await import('../server/aiLog.js');

migrate();
await ingest({ text: 'email the client about the invoice' }); // work / medium
await ingest({ text: 'clean the garage real quick' });        // household / trivial
await ingest({ text: 'go for a run' });                        // health / medium

test('suggestTask only ever recommends a real available task (closed-world)', async () => {
  const out = await suggestTask({ userId: defaultUserId(), state: { energy: 'low' } });
  assert.ok(out.recommendation, 'should have a recommendation');
  const availableIds = listAvailableTasksWithVectors(defaultUserId()).map((t) => t.id);
  assert.ok(availableIds.includes(out.recommendation.taskId), 'recommended id must be a real available task');
  assert.ok(out.candidates.length > 0);
  assert.ok(out.recommendation.message.length > 0);
});

test('low energy biases away from high-effort tasks', async () => {
  const out = await suggestTask({ userId: defaultUserId(), state: { energy: 'low' } });
  assert.notEqual(out.recommendation.effort_level, 'high');
});

test('the LLM decides over the shortlist (not just phrasing), and the choice stays closed-world + logged', async () => {
  settings.setAiLogConfig({ enabled: true });
  aiLog.clearAiLog();
  const out = await suggestTask({ userId: defaultUserId(), state: { energy: 'low' } });
  const ev = aiLog.getAiLog().logs.find((l) => l.kind === 'suggest');
  assert.ok(ev, 'a suggest decision event is logged');
  assert.equal(ev.meta.llmDecided, true, 'the model chose from the shortlist (not a silent fallback)');
  assert.ok(ev.meta.candidates.length >= 1, 'the shortlist is recorded');
  // closed-world: whatever the model returned, the chosen task is one of the real candidates
  assert.ok(ev.meta.candidates.some((c) => c.id === out.recommendation.taskId));
  settings.setAiLogConfig({ enabled: false });
});

test('no available tasks → gentle no-op, no invented task', async () => {
  for (const t of listAvailableTasksWithVectors(defaultUserId())) setTaskStatus(defaultUserId(), t.id, 'done');
  const out = await suggestTask({ userId: defaultUserId() });
  assert.equal(out.recommendation, null);
  assert.ok(out.message.length > 0);
});
