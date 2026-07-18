// Post-hoc task edits (priority / category / schedule) + the reschedule-preset helper. PLAN: menus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-edit-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate, db } = await import('../server/db.js');
const { insertTask, getTask, defaultUserId, setTaskPriority, setTaskCategory, setTaskSchedule, setTaskReminder } = await import('../server/repo.js');
const { presetDue, presetRemind } = await import('../server/services/llm/deadline.js');

migrate();
const uid = defaultUserId();
const mkTask = (over = {}) => insertTask({ userId: uid, summary: 'water the plants', category: 'household', ...over });

test('setTaskPriority sets, clears, validates, and is ownership-scoped', () => {
  const t = mkTask();
  assert.equal(setTaskPriority(uid, t.id, 3).priority, 3);
  assert.equal(setTaskPriority(uid, t.id, null).priority, null);     // clear
  assert.throws(() => setTaskPriority(uid, t.id, 9), /invalid priority/);
  assert.equal(setTaskPriority(uid + 999, t.id, 2), null);           // not yours → null, no change
  assert.equal(getTask(uid, t.id).priority, null);
});

test('setTaskCategory recategorizes and rejects an unknown category', () => {
  const t = mkTask();
  assert.equal(setTaskCategory(uid, t.id, 'health').category, 'health');
  assert.throws(() => setTaskCategory(uid, t.id, 'not-a-category'), /invalid category/);
  assert.equal(setTaskCategory(uid + 999, t.id, 'work'), null);      // ownership
});

test('setTaskSchedule sets the deadline and clears expired_at / reminded_at', () => {
  const t = mkTask();
  // Simulate a task that had passed its old deadline and already fired a reminder.
  db.prepare('UPDATE tasks SET expired_at = ?, reminded_at = ? WHERE id = ?').run(Date.now() - 1000, Date.now() - 1000, t.id);
  const future = Date.now() + 3 * 86400000;
  const after = setTaskSchedule(uid, t.id, { dueAt: future, dueKind: 'by' });
  assert.equal(after.due_at, future);
  assert.equal(after.due_kind, 'by');
  assert.equal(after.expired_at, null);   // un-expired so taskMarkers shows the new ⏳
  assert.equal(after.reminded_at, null);
});

test('setTaskSchedule clear wipes the deadline', () => {
  const t = mkTask({ dueAt: Date.now() + 86400000, dueKind: 'by' });
  const after = setTaskSchedule(uid, t.id, { dueAt: null, dueKind: null, remindAt: null });
  assert.equal(after.due_at, null);
  assert.equal(after.due_kind, null);
});

test('setTaskReminder sets the reminder, PRESERVES the deadline, and re-arms reminded_at', () => {
  const due = Date.now() + 5 * 86400000;
  const t = mkTask({ dueAt: due, dueKind: 'by' });
  db.prepare('UPDATE tasks SET reminded_at = ? WHERE id = ?').run(Date.now() - 1000, t.id); // already fired once
  const at = Date.now() + 3600000;
  const after = setTaskReminder(uid, t.id, at);
  assert.equal(after.remind_at, at);
  assert.equal(after.reminded_at, null);    // re-armed so the new reminder is eligible to fire
  assert.equal(after.due_at, due);          // deadline left intact (unlike setTaskSchedule, which replaces it)
  assert.equal(after.due_kind, 'by');
  assert.equal(setTaskReminder(uid, t.id, null).remind_at, null);  // clear
  assert.equal(setTaskReminder(uid + 999, t.id, at), null);        // ownership-scoped
});

test('presetRemind builds the right shape for each preset', () => {
  const now = new Date(2026, 5, 24, 12, 0, 0).getTime(); // Wed Jun 24 2026, noon
  assert.deepEqual(presetRemind('clear', now), { remindAt: null });
  assert.equal(presetRemind('1h', now).remindAt, now + 60 * 60000);
  assert.equal(presetRemind('3h', now).remindAt, now + 3 * 60 * 60000);

  const eve = presetRemind('eve', now);                 // noon → 6pm today
  assert.equal(new Date(eve.remindAt).getHours(), 18);
  assert.equal(new Date(eve.remindAt).getDate(), 24);
  const lateEve = presetRemind('eve', new Date(2026, 5, 24, 20, 0, 0).getTime()); // 8pm → tomorrow 6pm
  assert.equal(new Date(lateEve.remindAt).getDate(), 25);
  assert.equal(new Date(lateEve.remindAt).getHours(), 18);

  const morn = presetRemind('morn', now);               // → tomorrow 9am
  assert.equal(new Date(morn.remindAt).getHours(), 9);
  assert.equal(new Date(morn.remindAt).getDate(), 25);

  assert.equal(presetRemind('nope', now), null);
});

test('presetDue builds the right shape for each preset', () => {
  const now = new Date(2026, 5, 24, 12, 0, 0).getTime(); // Wed Jun 24 2026, noon (no small-hours rollover)
  assert.deepEqual(presetDue('clear', now), { dueAt: null, dueKind: null, remindAt: null });

  const today = presetDue('today', now);
  assert.equal(today.dueKind, 'today');
  assert.equal(new Date(today.dueAt).getDate(), 24);

  const tom = presetDue('tom', now);
  assert.equal(tom.dueKind, 'by');
  assert.equal(new Date(tom.dueAt).getDate(), 25);

  const wknd = presetDue('wknd', now);
  assert.equal(wknd.dueKind, 'by');
  assert.equal(new Date(wknd.dueAt).getDay(), 0);  // upcoming Sunday
  assert.ok(wknd.dueAt > tom.dueAt);

  assert.equal(presetDue('nope', now), null);
});
