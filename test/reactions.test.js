// Emoji reactions on Fanad's replies feed the learning signal: 👍🔥 on a suggestion lift that category,
// 🙁🤮💩 lower it, and any reaction is a mood beat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-react-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { applyReaction } = await import('../server/chat.js');
const { outcomeStats, defaultUserId } = await import('../server/repo.js');
const { affinityFromStats } = await import('../server/rag/index.js');

migrate();
const uid = defaultUserId();

test('a positive reaction on a suggestion lifts that category affinity', () => {
  applyReaction(uid, '🔥', { kind: 'suggestion', taskId: 1, category: 'work' });
  applyReaction(uid, '👍', { kind: 'suggestion', taskId: 1, category: 'work' });
  const rows = outcomeStats(uid, 'work', null);
  assert.ok(rows.some((r) => r.outcome === 'reaction' && r.sentiment === 'positive'));
  assert.ok(affinityFromStats(rows) > 0);
});

test('a negative reaction lowers it', () => {
  applyReaction(uid, '💩', { kind: 'suggestion', taskId: 2, category: 'errand' });
  assert.ok(affinityFromStats(outcomeStats(uid, 'errand', null)) < 0);
});

test('a 💤 reaction is just a mood beat (returns tired, no category signal)', () => {
  assert.equal(applyReaction(uid, '💤', null), 'tired');
});
