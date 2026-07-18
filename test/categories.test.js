// The well-being taxonomy (v: more category differentiation): Projects is no longer a dumping ground —
// Self-care / Recreation / Enrichment / Social / Admin are first-class, 'entertainment' is a legacy alias,
// and fuzzy /task:<word> matching covers the new buckets. Single source of truth: shared/categories.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-cats-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { ingest } = await import('../server/ingest.js');
const { defaultUserId, insertTask, setTaskStatus } = await import('../server/repo.js');
const { summarize } = await import('../server/summary.js');
const { closestCategory, CATEGORIES, CATEGORY_LABELS, CATEGORY_GUIDE } = await import('../shared/categories.js');

migrate();
const uid = defaultUserId();
const cat = async (text) => (await ingest({ text })).task.category;

test('the new well-being categories exist; entertainment is retired but still labels old rows', () => {
  for (const k of ['selfcare', 'recreation', 'enrichment', 'social', 'admin']) {
    assert.ok(CATEGORIES.includes(k), `${k} is an active category`);
  }
  assert.ok(!CATEGORIES.includes('entertainment'), 'entertainment is no longer offered to the classifier');
  assert.equal(CATEGORY_LABELS.entertainment, 'Fun', 'legacy entertainment rows still render as Fun');
  assert.equal(CATEGORY_LABELS.household, 'Home');
  assert.equal(CATEGORY_LABELS.selfcare, 'Self-care');
  assert.match(CATEGORY_GUIDE, /selfcare \(Self-care\)/, 'the classifier guide is derived from the meta');
});

test('closestCategory resolves the new buckets and their friendly words (and still gives up on non-categories)', () => {
  assert.equal(closestCategory('learning'), 'enrichment');
  assert.equal(closestCategory('self care'), 'selfcare');
  assert.equal(closestCategory('admin'), 'admin');
  assert.equal(closestCategory('friends'), 'social');
  assert.equal(closestCategory('home'), 'household');
  assert.equal(closestCategory('entertainment'), 'recreation'); // legacy word folds forward to its successor
  assert.equal(closestCategory('dentist'), null);                // still resolves to null rather than guessing
});

test('the mock classifier differentiates instead of dumping everything into Projects', async () => {
  assert.equal(await cat('meditate for ten minutes'), 'selfcare');
  assert.equal(await cat('study spanish vocab'), 'enrichment');
  assert.equal(await cat('call my sister'), 'social');
  assert.equal(await cat('pay the electric bill'), 'admin');
  assert.equal(await cat('watch a movie'), 'recreation');
});

test('fuzzy-match collisions from the review are resolved', () => {
  assert.equal(closestCategory('talk'), 'social');     // was → 'task' (Projects) via edit distance
  assert.equal(closestCategory('run'), 'health');      // was → 'recreation' (edit distance to "fun")
  assert.equal(closestCategory('read'), 'recreation'); // was → null (ambiguous); aligned with the mock
  assert.equal(closestCategory('task'), 'task');       // exact match still wins over any synonym
});

test('the weekly summary shows friendly category LABELS, not raw keys', () => {
  const t = insertTask({ userId: uid, summary: 'watch a documentary', category: 'recreation', effortLevel: 'low' });
  setTaskStatus(uid, t.id, 'done', Date.now() - 60000); // a minute ago, safely inside the half-open week range
  const s = summarize(uid, 'this_week');
  assert.match(s.narrative, /Recreation/);          // label
  assert.doesNotMatch(s.narrative, /\brecreation\b/); // never the raw key
});
