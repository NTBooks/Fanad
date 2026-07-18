// Tasks remember WHEN (and in what weather) they were created, and suggestions prefer a matching
// day-part / hour / weather. The scoring helper is pure, so we pin it directly. §3/§11.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-ctx-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { ingest } = await import('../server/ingest.js');
const { contextScore, phaseOf, affinityFromStats, whyReason } = await import('../server/rag/index.js');
const { insertTaskOutcome, outcomeStats, defaultUserId } = await import('../server/repo.js');

migrate();
const uid = defaultUserId();

test('phaseOf buckets the day correctly', () => {
  assert.equal(phaseOf('afternoon'), 'day');
  assert.equal(phaseOf('morning'), 'day');
  assert.equal(phaseOf('evening'), 'evening');
  assert.equal(phaseOf('night'), 'night');
  assert.equal(phaseOf('early_morning'), 'night');
});

test('contextScore: same context rewards, opposite day-part penalizes, no context is neutral', () => {
  assert.ok(contextScore({ created_tod: 'afternoon', created_hour: 14, created_weather: 'clear' },
    { phase: 'day', hour: 14, weather: 'clear' }) > 0);
  assert.ok(contextScore({ created_tod: 'night', created_hour: 2 },
    { phase: 'day', hour: 14, weather: null }) < 0);
  assert.equal(contextScore({}, { phase: 'day', hour: 14, weather: 'clear' }), 0);
});

test('a captured task remembers its creation hour and day-part', async () => {
  const { task } = await ingest({ text: 'remember when I was made' });
  assert.equal(typeof task.created_hour, 'number');
  assert.ok(task.created_tod);
});

test('affinityFromStats: completions are positive, refusals/drops negative, empty is zero', () => {
  assert.ok(affinityFromStats([{ outcome: 'done', sentiment: 'highfive', n: 3 }]) > 0);
  assert.ok(affinityFromStats([{ outcome: 'refused', sentiment: null, n: 3 }, { outcome: 'dropped', sentiment: null, n: 2 }]) < 0);
  assert.equal(affinityFromStats([]), 0);
});

test('whyReason explains only when the data supports it', () => {
  assert.match(whyReason({ category: 'work' }, { phase: 'day', hour: 10 }, 0.3), /usually get these/);
  assert.match(whyReason({ created_tod: 'morning', created_hour: 10 }, { phase: 'day', hour: 11 }, 0), /around when you noted/);
  assert.match(whyReason({ created_weather: 'rain' }, { phase: 'day', hour: 10, weather: 'rain' }, 0), /rain-day/);
  assert.equal(whyReason({}, { phase: 'day', hour: 10 }, 0), null);
});

test('the outcome ledger roundtrips and aggregates by category × day-part', () => {
  insertTaskOutcome({ userId: uid, category: 'work', outcome: 'done', sentiment: 'highfive', ctxPhase: 'day' });
  insertTaskOutcome({ userId: uid, category: 'work', outcome: 'done', sentiment: 'neutral', ctxPhase: 'day' });
  const rows = outcomeStats(uid, 'work', 'day');
  assert.equal(rows.reduce((s, r) => s + r.n, 0), 2);
  assert.ok(affinityFromStats(rows) > 0, 'two happy completions → positive affinity');
});
