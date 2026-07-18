// The opt-in Timer module: "/timer 10 minutes" sets a one-shot ding (NOT a task), bare "timer" lists what's
// running, "timer off 1" / the ✕ button cancels, and the scheduler rings each due timer exactly once on the
// owner's own channel. The duration parser is deterministic for the plain forms (the offline/mock path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-timer-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate, db } = await import('../server/db.js');
const { handleMessage, handleAction } = await import('../server/chat.js');
const { clearDialogState } = await import('../server/dialog.js');
const { defaultUserId, getOrCreateTelegramUser, activeTimers, insertTimer, listUnseenWakeups, listTasks } = await import('../server/repo.js');
const { setUserFeatures } = await import('../server/settings.js');
const { fireDueTimers } = await import('../server/scheduler.js');
const { parseDuration, durationLabel } = await import('../server/services/llm/duration.js');

migrate();
const uid = defaultUserId();
const say = async (text) => { clearDialogState(uid); return handleMessage({ text }); };
const reply = async (text) => (await say(text)).reply;
const timerOn = (on = true) => setUserFeatures(uid, { timer: on });
const clearTimers = () => db.prepare('DELETE FROM timers').run();

// ── the pure duration parser (deterministic, offline) ──

test('parseDuration reads the plain forms', () => {
  assert.equal(parseDuration('10 minutes').ms, 10 * 60000);
  assert.equal(parseDuration('10 min').ms, 10 * 60000);
  assert.equal(parseDuration('10m').ms, 10 * 60000);
  assert.equal(parseDuration('2 hours').ms, 2 * 3600000);
  assert.equal(parseDuration('1.5 hours').ms, 90 * 60000);
  assert.equal(parseDuration('90 mins').ms, 90 * 60000);
  assert.equal(parseDuration('45 seconds').ms, 45000);
  assert.equal(parseDuration('2 days').ms, 2 * 86400000);
});

test('parseDuration sums combined chunks ("1h 30m", "1 hour and 15 minutes", "1h30m")', () => {
  assert.equal(parseDuration('1h 30m').ms, 90 * 60000);
  assert.equal(parseDuration('1h30m').ms, 90 * 60000);
  assert.equal(parseDuration('1 hour and 15 minutes').ms, 75 * 60000);
});

test('parseDuration reads spoken amounts ("an hour", "half an hour", "an hour and a half")', () => {
  assert.equal(parseDuration('an hour').ms, 3600000);
  assert.equal(parseDuration('one hour').ms, 3600000);
  assert.equal(parseDuration('half an hour').ms, 30 * 60000);
  assert.equal(parseDuration('a quarter of an hour').ms, 15 * 60000);
  assert.equal(parseDuration('an hour and a half').ms, 90 * 60000);
  assert.equal(parseDuration('five minutes').ms, 5 * 60000);
});

test('parseDuration leaves the label behind, wherever it sits', () => {
  assert.deepEqual(parseDuration('12 min pasta'), { ms: 12 * 60000, clean: 'pasta' });
  assert.deepEqual(parseDuration('pasta 12 min'), { ms: 12 * 60000, clean: 'pasta' });
  assert.equal(parseDuration('for 10 minutes').clean, '');
  assert.equal(parseDuration('20 min for the laundry').clean, 'the laundry');
});

test('parseDuration rejects text with no amount of time (incl. "10 months")', () => {
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration('pasta'), null);
  assert.equal(parseDuration('10 months'), null); // months never half-match the bare "m" unit
});

test('durationLabel speaks in days/hours/minutes', () => {
  assert.equal(durationLabel(10 * 60000), '10 min');
  assert.equal(durationLabel(90 * 60000), '1 h 30 min');
  assert.equal(durationLabel(2 * 3600000), '2 h');
  assert.equal(durationLabel(26 * 3600000), '1 day 2 h');
  assert.equal(durationLabel(30000), 'under a minute');
});

// ── the module gate ──

test('with Timer off, /timer offers the one-tap turn-on and sets nothing', async () => {
  timerOn(false); clearTimers();
  const r = await say('/timer 10 minutes');
  assert.match(r.reply, /Timer is off/i);
  const datas = (r.buttons || []).flat().map((b) => b.data);
  assert.ok(datas.includes('m:optin:timer'), 'offer has a Turn-on-Timer button');
  assert.equal(activeTimers(uid).length, 0);
});

test('with Timer off, a bare "set a timer …" statement still files as a TASK (plus the module nudge)', async () => {
  timerOn(false); clearTimers();
  const before = listTasks(uid).length;
  const r = await say('set a timer for the roast');
  assert.equal(listTasks(uid).length, before + 1, 'filed as an ordinary task');
  assert.match(r.reply, /Timer module/i, 'carries the gentle turn-on nudge');
  assert.equal(activeTimers(uid).length, 0);
});

// ── setting, listing, canceling ──

test('"/timer 10 minutes" sets a one-shot timer (and never touches the task list)', async () => {
  timerOn(); clearTimers();
  const before = listTasks(uid).length;
  const t0 = Date.now();
  const r = await say('/timer 10 minutes');
  assert.match(r.reply, /⏰ Timer set — 10 min/);
  const rows = activeTimers(uid);
  assert.equal(rows.length, 1);
  assert.ok(Math.abs(rows[0].fire_at - (t0 + 10 * 60000)) < 5000, 'fires ~10 minutes out');
  assert.equal(listTasks(uid).length, before, 'no task was filed');
});

test('extra words become the label, and the bare "timer" listing shows it with a cancel button', async () => {
  timerOn(); clearTimers();
  await say('timer 12 min pasta');
  const rows = activeTimers(uid);
  assert.equal(rows[0].label, 'pasta');
  const r = await say('timer');
  assert.match(r.reply, /1\. ⏰ .*pasta/);
  const datas = (r.buttons || []).flat().map((b) => b.data);
  assert.ok(datas.includes(`m:tmr:${rows[0].id}`), 'listing carries the ✕ cancel token');
});

test('"set a timer for half an hour" works bare once opted in', async () => {
  timerOn(); clearTimers();
  const r = await say('set a timer for half an hour');
  assert.match(r.reply, /⏰ Timer set — 30 min/);
  assert.equal(activeTimers(uid).length, 1);
});

test('"timer off 1" cancels by position; a bare "timer off" with one running cancels it', async () => {
  timerOn(); clearTimers();
  await say('timer 5 min eggs');
  await say('timer 20 min laundry');
  assert.equal(activeTimers(uid).length, 2);
  assert.match(await reply('timer off 1'), /Canceled the 5 min timer — eggs/);
  assert.equal(activeTimers(uid).length, 1);
  assert.match(await reply('timer off'), /Canceled the 20 min timer — laundry/);
  assert.equal(activeTimers(uid).length, 0);
});

test('the ✕ button cancels via handleAction, and a stale tap is a gentle no-op', async () => {
  timerOn(); clearTimers();
  await say('/timer 15 minutes tea');
  const row = activeTimers(uid)[0];
  const r = await handleAction(uid, `m:tmr:${row.id}`);
  assert.match(r.text, /Canceled the 15 min timer — tea/);
  assert.equal(activeTimers(uid).length, 0);
  const again = await handleAction(uid, `m:tmr:${row.id}`);
  assert.match(again.text, /already gone/i);
});

test('sub-minute and past-a-week spans are gently declined', async () => {
  timerOn(); clearTimers();
  assert.match(await reply('/timer 30 seconds'), /shortest timer/i);
  assert.match(await reply('/timer 8 days'), /past a week/i);
  assert.equal(activeTimers(uid).length, 0);
});

test('unreadable durations get a gentle how-to (mock LLM cannot rescue them)', async () => {
  timerOn(); clearTimers();
  assert.match(await reply('/timer sometime soonish'), /How long\?/i);
  assert.equal(activeTimers(uid).length, 0);
});

test('another user cannot see or cancel my timers', async () => {
  timerOn(); clearTimers();
  await say('/timer 10 minutes');
  const mine = activeTimers(uid)[0];
  const other = getOrCreateTelegramUser(778101, 'stranger');
  setUserFeatures(other, { timer: true });
  assert.match((await handleMessage({ userId: other, text: 'timer' })).reply, /No timers running/i);
  const r = await handleAction(other, `m:tmr:${mine.id}`);
  assert.match(r.text, /already gone/i, 'a forged id resolves to nothing');
  assert.equal(activeTimers(uid).length, 1, 'my timer survives');
});

// ── the scheduler ring ──

test('fireDueTimers rings a due timer exactly once, on the owner\'s own channel', async () => {
  timerOn(); clearTimers();
  const tgUser = getOrCreateTelegramUser(778102, 'dinger');
  db.prepare('UPDATE users SET telegram_id=? WHERE id=?').run(778102, tgUser);
  const now = Date.now();
  insertTimer(tgUser, { label: 'pasta', durationMs: 10 * 60000, fireAt: now - 1000 });
  insertTimer(uid, { label: null, durationMs: 5 * 60000, fireAt: now + 3600000 }); // not due yet

  const sent = [];
  const send = (text, chatId) => { sent.push({ text, chatId }); return true; };
  const fired = await fireDueTimers(now, { send, sendSlackFn: () => true });
  assert.equal(fired.length, 1, 'only the due timer rings');
  assert.match(fired[0], /⏰ Ding — 10 min is up: pasta/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 778102, 'pushed to the owner\'s own Telegram chat');
  assert.ok(listUnseenWakeups(tgUser).some((w) => /pasta/.test(w.text)), 'queued for the web too');

  const again = await fireDueTimers(now + 1000, { send, sendSlackFn: () => true });
  assert.equal(again.length, 0, 'a rung timer never re-fires');
  assert.equal(activeTimers(tgUser).length, 0, 'and it left the running list');
});

test('a canceled timer never rings', async () => {
  timerOn(); clearTimers();
  await say('/timer 2 minutes');
  await say('timer off');
  const fired = await fireDueTimers(Date.now() + 10 * 60000, { send: () => true, sendSlackFn: () => true });
  assert.equal(fired.length, 0);
});

// ── module lifecycle ──

test('optin/optout round-trips; opting out leaves a running timer to ring', async () => {
  timerOn(false); clearTimers();
  assert.match(await reply('optin timer'), /Timer on/i);
  await say('timer 3 min');
  assert.match(await reply('optout timer'), /still ring/i);
  assert.match(await reply('/timer'), /Timer is off/i, 'the commands are hidden');
  assert.equal(activeTimers(uid).length, 1, 'but the running timer survives to ring');
  const fired = await fireDueTimers(Date.now() + 10 * 60000, { send: () => true, sendSlackFn: () => true });
  assert.equal(fired.length, 1);
});

test('the timer guide is gated like its commands', async () => {
  timerOn(false);
  assert.match(await reply('guide timer'), /Timer is off/i);
  timerOn(true);
  assert.match(await reply('guide timer'), /Guide: Timer/i);
});
