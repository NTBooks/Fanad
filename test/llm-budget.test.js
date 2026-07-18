// Per-user daily LLM budget (llmBudget.js + the llm/index.js chokepoint + the llm/context.js identity
// seam) — the cost control for a public demo on a paid cloud key. Non-owners get LLM_USER_DAILY_CALL_CAP
// calls/day (chat + embed, counted on attempt); the owner and unthreaded paths are exempt; over the cap
// the chokepoint throws code LLM_BUDGET before any provider work. The channel keeps replying either way:
// capture call sites all have heuristic fallbacks, so a broke user's tasks still file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-budget-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';
process.env.LLM_USER_DAILY_CALL_CAP = '3';

const { migrate } = await import('../server/db.js');
const { handleIncoming } = await import('../server/channels/telegram-handler.js');
const { setTelegramConfig } = await import('../server/settings.js');
const { getOrCreateTelegramUser, ROOT_USER_ID } = await import('../server/repo.js');
const { chat, embed } = await import('../server/services/llm/index.js');
const { runAsLlmUser } = await import('../server/services/llm/context.js');
const { usageToday, localDayKey, takeBudget } = await import('../server/llmBudget.js');
const { backfillBudget } = await import('../server/journal.js');

migrate();
setTelegramConfig({ ownerId: null, allowedUsername: '' });

const say = (text, fromId, username) => handleIncoming({ text, fromId, username });
const ask = () => chat({ messages: [{ role: 'user', content: 'water the plants' }] });

// alice claims the bot (owner); bob is vouched in — the budgeted demo guest.
assert.match((await say('claim the box', 1001, 'alice')).reply, /Filed/);
assert.match((await say('vouch @bob', 1001, 'alice')).reply, /Vouched/i);
const aliceId = getOrCreateTelegramUser(1001, 'alice');
const bobId = getOrCreateTelegramUser(1002, 'bob');

test('a non-owner is cut off at the cap; counting is on ATTEMPT and embed shares the pool', async () => {
  await runAsLlmUser(bobId, async () => {
    await ask(); // 1
    await ask(); // 2
    await embed('water the plants'); // 3 — embeds charge the same budget
    // 4/5: over — thrown SYNCHRONOUSLY at the factory (the guardCloud contract), before any provider work.
    assert.throws(ask, (err) => err.code === 'LLM_BUDGET');
    assert.throws(() => embed('x'), (err) => err.code === 'LLM_BUDGET');
  });
  assert.equal(usageToday(bobId), 5, 'refused attempts consume budget too (no free retry loops)');
});

test('the owner and root are exempt — and never even counted', async () => {
  await runAsLlmUser(aliceId, async () => {
    for (let i = 0; i < 6; i++) await ask(); // 2× the cap, no throw
  });
  await runAsLlmUser(ROOT_USER_ID, ask);
  assert.equal(usageToday(aliceId), 0);
  assert.equal(usageToday(ROOT_USER_ID), 0);
});

test('an unthreaded call path (no runAsLlmUser) is exempt, not broken', async () => {
  await ask(); // outside any ALS context — must not throw despite bob being over budget
});

test('the meter is per-DAY: only today’s row is read back', () => {
  assert.match(localDayKey(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(usageToday(9999), 0, 'a user with no row today has a zero spend');
});

test('an over-budget guest still gets service — capture degrades to heuristics, never silence', async () => {
  const r = await say('buy milk', 1002, 'bob');
  assert.match(r.reply, /\S/, 'a reply came back');
  assert.match(r.reply, /Filed/i, 'the task filed with fallback metadata (classify caught the budget throw)');
});

test('takeBudget is callable directly and throws the typed error', () => {
  assert.throws(() => { for (let i = 0; i < 10; i++) takeBudget(bobId, 'test'); }, (err) => err.code === 'LLM_BUDGET');
});

test('journal backfillBudget: uncapped for the owner, capped for a guest', () => {
  assert.equal(backfillBudget(aliceId).callsLeft, Infinity);
  assert.equal(backfillBudget(ROOT_USER_ID).callsLeft, Infinity);
  assert.equal(backfillBudget(bobId).callsLeft, 6);
  assert.equal(backfillBudget(bobId, 2).callsLeft, 2);
});
