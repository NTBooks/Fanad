// scheduler.js delivery edges the existing wakeup/reminder/timer tests don't reach: a Slack owner's nudge
// goes to their own DM (never Telegram), one failing push can't take down the rest of the tick — and can't
// cause a re-fire (the stamp lands first) — a reminder's photo rides along, finished tasks never remind,
// and a reminder set INSIDE a notebook reaches the notebook OWNER's channel (sub-users have none).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-sched-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { fireDueWakeups, fireDueReminders, fireDueTimers } = await import('../server/scheduler.js');
const {
  defaultUserId, getOrCreateTelegramUser, getOrCreateSlackUser, createNotebook,
  insertSchedule, insertTask, insertImage, setTaskStatus, listUnseenWakeups,
  insertTimer, ROOT_USER_ID,
} = await import('../server/repo.js');
const { setTelegramConfig } = await import('../server/settings.js');

migrate();

const minuteOf = (now) => new Date(now).getHours() * 60 + new Date(now).getMinutes();

test('a Slack owner’s wake-up goes to THEIR Slack DM — and never to Telegram', async () => {
  const sal = getOrCreateSlackUser('U777001', 'sal');
  insertSchedule(sal, minuteOf(Date.now()));
  const tg = []; const sl = [];
  const fired = await fireDueWakeups(Date.now(), {
    send: (text, chatId) => { tg.push(chatId); return true; },
    sendSlackFn: (text, slackId) => { sl.push(slackId); return true; },
  });
  assert.equal(fired.length, 1);
  assert.deepEqual(sl, ['U777001'], 'delivered to the owner’s own Slack id');
  assert.equal(tg.length, 0, 'the Telegram sender is never touched for a Slack account');
  assert.ok(listUnseenWakeups(sal).length >= 1, 'the web queue copy is kept too');
});

test('one throwing push neither aborts the other reminders nor causes a re-fire', async () => {
  const now = Date.now();
  const grumpy = getOrCreateTelegramUser(777002, 'grumpy');
  const happy = getOrCreateTelegramUser(777003, 'happy');
  insertTask({ userId: grumpy, summary: 'doomed delivery', remindAt: now - 1000 });
  insertTask({ userId: happy, summary: 'fine delivery', remindAt: now - 1000 });

  // A SYNCHRONOUS throw from the sender is the worst case: it escapes pushToOwner into the loop body.
  // Each row is wrapped in its own try/catch precisely so this can't swallow the rest of the tick.
  const sent = [];
  const send = (text, chatId) => {
    if (chatId === 777002) throw new Error('bot exploded');
    sent.push(chatId); return true;
  };
  const fired = await fireDueReminders(now, { send });
  assert.equal(fired.length, 1, 'the throwing row is dropped from `fired`, the rest continue');
  assert.deepEqual(sent, [777003]);
  // The web-queue copy was written BEFORE the push, so even the failed row's nudge is not lost outright.
  assert.ok(listUnseenWakeups(grumpy).some((w) => /doomed delivery/.test(w.text)));

  // reminded_at is stamped FIRST, so the failed push must not earn a second ring on the next tick.
  assert.equal((await fireDueReminders(now + 60000, { send })).length, 0, 'no re-fire for either row');
});

test('an async send REJECTION is contained: the reminder still counts as fired', async () => {
  const now = Date.now();
  const uid = getOrCreateTelegramUser(777004, 'flaky');
  insertTask({ userId: uid, summary: 'flaky network', remindAt: now - 1000 });
  // A rejecting promise (the common failure: Telegram API down) is handled inside pushToOwner — if it ever
  // became an unhandled rejection it would crash the whole process on modern Node.
  const fired = await fireDueReminders(now, { send: () => Promise.reject(new Error('net down')) });
  assert.equal(fired.length, 1, 'delivery failure does not undo the fire');
  assert.ok(listUnseenWakeups(uid).some((w) => /flaky network/.test(w.text)), 'web queue still has it');
});

test('a reminder carries the task’s photo file_id to the push', async () => {
  const now = Date.now();
  const uid = getOrCreateTelegramUser(777005, 'shutterbug');
  const task = insertTask({ userId: uid, summary: 'hang the picture', remindAt: now - 1000 });
  insertImage({ userId: uid, taskId: task.id, fileId: 'PHOTO-abc123' });
  let pushed = null;
  await fireDueReminders(now, { send: (text, chatId, photo) => { pushed = photo; return true; } });
  assert.equal(pushed, 'PHOTO-abc123', 'the filed photo rides along by file_id');
});

test('done and archived tasks never remind; a just-expired one still gets its single nudge', async () => {
  const now = Date.now();
  const uid = getOrCreateTelegramUser(777006, 'tidy');
  const doneTask = insertTask({ userId: uid, summary: 'already done', remindAt: now - 1000 });
  setTaskStatus(uid, doneTask.id, 'done');
  const archived = insertTask({ userId: uid, summary: 'already archived', remindAt: now - 1000 });
  setTaskStatus(uid, archived.id, 'archived');
  // The deadline sweep may have already expired an "on <when>" task by the time its reminder fires —
  // the user still deserves the one nudge they asked for (allDueReminders excludes only done/archived).
  const expired = insertTask({ userId: uid, summary: 'slipped past the deadline', remindAt: now - 1000 });
  setTaskStatus(uid, expired.id, 'expired');

  const fired = await fireDueReminders(now, { send: () => true });
  assert.equal(fired.length, 1, 'only the expired task fires; done/archived are silent');
  assert.match(fired[0], /slipped past the deadline/);
});

test('a reminder set inside a NOTEBOOK is pushed to the notebook owner’s own channel', async () => {
  const now = Date.now();
  const owner = getOrCreateTelegramUser(777007, 'nbowner');
  const nb = createNotebook(owner, 'renovation').notebook;
  insertTask({ userId: nb.id, summary: 'order the tiles', remindAt: now - 1000 });

  const sent = [];
  await fireDueReminders(now, { send: (text, chatId) => { sent.push(chatId); return true; } });
  // The sub-user has no channel identity of its own; COALESCE falls back to the PARENT's telegram id —
  // the genuine owner of that space, never the bot's claimed owner (the cross-user isolation rule).
  assert.deepEqual(sent, [777007], 'delivered to the parent’s own chat');
  assert.ok(listUnseenWakeups(nb.id).some((w) => /order the tiles/.test(w.text)),
    'the web-queue copy stays under the notebook, where the task lives');
});

// ── The owner-mirror exception: the deployment OWNER's platform-account dings also land in root's web
// queue (the web UI polls as root), while vouched non-owners stay fully isolated. ──

test('the OWNER’s Telegram timer ding is mirrored into root’s web queue', async () => {
  const now = Date.now();
  setTelegramConfig({ ownerId: 777010 });
  try {
    const owner = getOrCreateTelegramUser(777010, 'bosstg');
    insertTimer(owner, { durationMs: 60000, fireAt: now - 1000, label: 'tea' });
    const sent = [];
    const fired = await fireDueTimers(now, { send: (text, chatId) => { sent.push(chatId); return true; } });
    assert.equal(fired.length, 1);
    assert.deepEqual(sent, [777010], 'the push still goes only to the owner’s own chat');
    assert.ok(listUnseenWakeups(owner).some((w) => /tea/.test(w.text)), 'the owner row keeps its own copy');
    assert.ok(listUnseenWakeups(ROOT_USER_ID).some((w) => /tea/.test(w.text)),
      'root’s web queue got the mirror — the web UI (polling as root) sees the ding');
  } finally {
    setTelegramConfig({ ownerId: null });
  }
});

test('a NON-owner’s reminder never mirrors to root (isolation invariant intact)', async () => {
  const now = Date.now();
  setTelegramConfig({ ownerId: 777010 }); // someone else claimed the bot
  try {
    const guest = getOrCreateTelegramUser(777011, 'guest');
    insertTask({ userId: guest, summary: 'guest private errand', remindAt: now - 1000 });
    await fireDueReminders(now, { send: () => true });
    assert.ok(listUnseenWakeups(guest).some((w) => /guest private errand/.test(w.text)), 'the guest’s own queue has it');
    assert.ok(!listUnseenWakeups(ROOT_USER_ID).some((w) => /guest private errand/.test(w.text)),
      'nothing leaks into root’s web queue');
  } finally {
    setTelegramConfig({ ownerId: null });
  }
});

test('a root-owned timer inserts exactly one root wakeup (no double from the mirror)', async () => {
  const now = Date.now();
  const before = listUnseenWakeups(ROOT_USER_ID).length;
  insertTimer(defaultUserId(), { durationMs: 60000, fireAt: now - 1000, label: 'stretch' });
  await fireDueTimers(now, { send: () => true });
  const dings = listUnseenWakeups(ROOT_USER_ID).filter((w) => /stretch/.test(w.text));
  assert.equal(dings.length, 1, 'root is already the owner account — the mirror must not double-insert');
  assert.equal(listUnseenWakeups(ROOT_USER_ID).length, before + 1);
});

test('a reminder inside the OWNER’s notebook mirrors to root (account-level ownership)', async () => {
  const now = Date.now();
  setTelegramConfig({ ownerId: 777012 });
  try {
    const owner = getOrCreateTelegramUser(777012, 'nbboss');
    const nb = createNotebook(owner, 'garage').notebook;
    insertTask({ userId: nb.id, summary: 'drain the compressor', remindAt: now - 1000 });
    const sent = [];
    await fireDueReminders(now, { send: (text, chatId) => { sent.push(chatId); return true; } });
    assert.deepEqual(sent, [777012], 'pushed to the parent account’s own chat');
    assert.ok(listUnseenWakeups(nb.id).some((w) => /drain the compressor/.test(w.text)),
      'the notebook keeps its own web-queue copy');
    assert.ok(listUnseenWakeups(ROOT_USER_ID).some((w) => /drain the compressor/.test(w.text)),
      'the sub-user answers as its parent — the owner’s notebook reminder reaches the web too');
  } finally {
    setTelegramConfig({ ownerId: null });
  }
});
