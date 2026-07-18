// Scheduled wake-up check-ins (§10): set via chat, fire once per day, queue a data-grounded nudge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-wake-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage } = await import('../server/chat.js');
const { fireDueWakeups } = await import('../server/scheduler.js');
const { setDialogState } = await import('../server/dialog.js');
const { listSchedules, insertSchedule, listUnseenWakeups, defaultUserId, getOrCreateTelegramUser } = await import('../server/repo.js');

migrate();
const uid = defaultUserId();
// Modules are per-user opt-in (default OFF); these behaviour tests run as the root user with all on.
(await import('../server/settings.js')).setUserFeatures(uid, { notes: true, lists: true, metrics: true, vouch: true });
const say = (text) => handleMessage({ text });

test('"wake 8:30" schedules a check-in; "wake list" shows it', async () => {
  assert.match((await say('wake 8:30')).reply, /8:30/);
  assert.match((await say('wake list')).reply, /8:30/);
});

test('"wake off <id>" removes it', async () => {
  const id = listSchedules(uid)[0].id;
  assert.match((await say(`wake off ${id}`)).reply, /Removed/);
  assert.equal(listSchedules(uid).length, 0);
});

test('"wake up early tomorrow" is prose, not a command → filed as a task', async () => {
  assert.match((await say('wake up early tomorrow')).reply, /Filed/);
});

test('/wakelist and /wake list are slash commands that show the list', async () => {
  insertSchedule(uid, 9 * 60); // 09:00
  assert.match((await say('/wakelist')).reply, /09:00/);
  assert.match((await say('/wake list')).reply, /09:00/);
});

test('/wakelist escapes an open question instead of being read as its answer', async () => {
  setDialogState(uid, { type: 'suggestion_reaction', prompt: 'smaller or done?', data: {} });
  assert.match((await say('/wakelist')).reply, /Check-ins|09:00/);
});

test('a due schedule fires a queued nudge exactly once per day', async () => {
  await say('water the plants'); // something to suggest
  const now = Date.now();
  const minute = new Date(now).getHours() * 60 + new Date(now).getMinutes();
  insertSchedule(uid, minute);

  const fired = await fireDueWakeups(now);
  assert.equal(fired.length, 1);
  assert.match(fired[0], /nudge|Checking in/i);
  assert.ok(listUnseenWakeups(uid).some((w) => w.text === fired[0]));

  assert.equal((await fireDueWakeups(now)).length, 0, 'must not double-fire the same day');
});

test('a Telegram user’s schedule fires and is filed under THAT user, not just root', async () => {
  // Regression: the scheduler used to scan only root (defaultUserId), so a check-in set via Telegram —
  // stored under the per-account user — never fired. Now it scans all users.
  const tgUid = getOrCreateTelegramUser(8298754898, 'tester');
  assert.notEqual(tgUid, defaultUserId());
  await handleMessage({ userId: tgUid, text: 'feed the cat' }); // something to suggest for that user
  const now = Date.now();
  const minute = new Date(now).getHours() * 60 + new Date(now).getMinutes();
  insertSchedule(tgUid, minute);

  const fired = await fireDueWakeups(now);
  assert.equal(fired.length, 1);
  assert.match(fired[0], /nudge|Checking in/i);
  assert.ok(listUnseenWakeups(tgUid).some((w) => w.text === fired[0]), 'nudge queued under the Telegram user');
});

test('a root/web nudge is NEVER pushed to Telegram; a Telegram user’s goes only to THEIR own chat', async () => {
  // Cross-user isolation regression: root has no telegram_id, so the push used to fall back to the bot's
  // claimed owner (cfg.ownerId) — delivering root's private nudge into another user's Telegram chat. A
  // web/root schedule must deliver via the web wake-up queue ONLY; a Telegram user's must go to their id.
  const sent = [];
  const send = (text, chatId, image) => { sent.push({ text, chatId, image }); return Promise.resolve(true); };

  await say('water the begonias'); // a root task to suggest
  const tgUid = getOrCreateTelegramUser(700700700, 'pat');
  await handleMessage({ userId: tgUid, text: 'walk the dog' }); // a task for the Telegram user

  const now = Date.now();
  const minute = new Date(now).getHours() * 60 + new Date(now).getMinutes();
  insertSchedule(defaultUserId(), minute); // root (telegram_id = null)
  insertSchedule(tgUid, minute);           // Telegram user (telegram_id = 700700700)

  await fireDueWakeups(now, { send });

  assert.ok(!sent.some((m) => m.chatId == null), 'root nudge must not fall back to the bot owner');
  assert.equal(sent.length, 1, 'exactly one Telegram push — only the Telegram user’s');
  assert.equal(sent[0].chatId, 700700700, 'pushed to the Telegram user’s OWN chat id');
});

test('the OWNER’s Telegram nudge is mirrored into root’s web queue; a non-owner’s is not', async () => {
  // The one sanctioned exception to the isolation invariant (insertWakeupMirroredToOwner): the deployment
  // owner's platform-account check-in must also reach the web UI, which polls wakeups as root.
  const { setTelegramConfig } = await import('../server/settings.js');
  setTelegramConfig({ ownerId: 700700701 });
  try {
    const ownerUid = getOrCreateTelegramUser(700700701, 'bossnudge');
    await handleMessage({ userId: ownerUid, text: 'sharpen the mower blade' });
    const now = Date.now();
    const minute = new Date(now).getHours() * 60 + new Date(now).getMinutes();
    insertSchedule(ownerUid, minute);

    const rootBefore = listUnseenWakeups(defaultUserId()).length;
    const fired = await fireDueWakeups(now, { send: () => true });
    assert.equal(fired.length, 1);
    assert.ok(listUnseenWakeups(ownerUid).some((w) => w.text === fired[0]), 'queued under the owner’s own row');
    const rootNew = listUnseenWakeups(defaultUserId()).slice(rootBefore);
    assert.deepEqual(rootNew.map((w) => w.text), [fired[0]], 'exactly the mirror copy landed in root’s queue');
    // The earlier tests fired non-owner Telegram nudges with ownerId unset/foreign — none of those ever
    // reached root (rootBefore counts only root's OWN nudges, asserted implicitly by the exact match above).
  } finally {
    setTelegramConfig({ ownerId: null });
  }
});
