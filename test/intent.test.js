// The question/statement classifier (the organizing rule). Under the mock provider it always falls to
// the deterministic heuristic — which is exactly what we want to pin here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-intent-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { classifyIntent, coerce, INTENTS } = await import('../server/services/llm/classify-intent.js');

test('a plain statement → kind=statement (gets filed as a task)', async () => {
  assert.equal((await classifyIntent('clean the garage real quick')).kind, 'statement');
});

test('"help" is not a routable LLM intent — it is a deterministic keyword in route()', () => {
  assert.ok(!INTENTS.includes('help'));
});

test('a "look up how to …" request → statement (task), never hijacked into a command', async () => {
  assert.equal((await classifyIntent('look up how to clear tasks')).kind, 'statement');
});

test('"what should I do next?" → question / whatdo', async () => {
  const r = await classifyIntent('what should I do next?');
  assert.equal(r.kind, 'question');
  assert.equal(r.intent, 'whatdo');
});

test('"what did I do last week?" → question / summary', async () => {
  assert.equal((await classifyIntent('what did I do last week?')).intent, 'summary');
});

test('a trailing-? question is treated as a question', async () => {
  assert.equal((await classifyIntent('is the report ready?')).kind, 'question');
});

test('bare "no" classifies as a statement — the dialog layer, not the classifier, stops it being filed', async () => {
  assert.equal((await classifyIntent('no')).kind, 'statement');
});

test('an unknown intent label from the LLM coerces to no intent (never dispatches)', () => {
  const r = coerce({ kind: 'question', intent: 'reward', confidence: 0.9 }, 'suggest a reward');
  assert.equal(r.intent, null);
});

test('"check hand in quests" → statement under the deterministic heuristic (files as a task)', async () => {
  assert.equal((await classifyIntent('check hand in quests')).kind, 'statement');
});
