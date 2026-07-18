// Data-grounded summaries: timeframe resolution + completed-task counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-summary-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { ingest } = await import('../server/ingest.js');
const { summarize } = await import('../server/summary.js');
const { setTaskStatus, listTasks, defaultUserId } = await import('../server/repo.js');
const { resolveTimeframe, dayStartOf } = await import('../shared/timeframe.js');

migrate();
await ingest({ text: 'email the client about the invoice' }); // work
await ingest({ text: 'clean the garage real quick' });        // household
for (const t of listTasks(defaultUserId())) setTaskStatus(defaultUserId(), t.id, 'done');

test('resolveTimeframe handles common phrases', () => {
  const w = resolveTimeframe('this week');
  assert.ok(w.start < w.end);
  assert.equal(w.label, 'this week');
  assert.equal(resolveTimeframe('today').label, 'today');
  assert.equal(resolveTimeframe('last week').label, 'last week');
});

test('the day rolls over at 02:00 local, not midnight', () => {
  const at = (day, h, min = 0) => new Date(2026, 5, day, h, min).getTime();
  assert.equal(dayStartOf(at(10, 1, 30)), at(9, 2), 'a 1:30am snack still belongs to the 9th');
  assert.equal(dayStartOf(at(10, 2)), at(10, 2), 'at 2:00am sharp the 10th begins');
  assert.equal(dayStartOf(at(10, 23, 59)), at(10, 2), 'late evening is squarely the 10th');
  assert.ok(resolveTimeframe('today').start === dayStartOf(Date.now()), "the 'today' tally window starts at the rollover");
});

test('summarize counts only real completed tasks (data-grounded)', () => {
  const s = summarize(defaultUserId(), 'this_week');
  assert.equal(s.count, 2);
  assert.match(s.narrative, /finished 2 things/);
  assert.equal(s.byCategory.work, 1);
  assert.equal(s.byCategory.household, 1);
  assert.equal(s.items.length, 2);
});

test('an empty timeframe is a gentle no-op (never fabricates)', () => {
  const s = summarize(defaultUserId(), 'last_week');
  assert.equal(s.count, 0);
  assert.match(s.narrative, /that's okay/i);
});
