// .ics "add to calendar" builder (server/calendar.js). Pure module — no DB/LLM needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskEventTime, icsForTask } from '../server/calendar.js';

// Local-time builders so the all-day (end-of-day) heuristic is timezone-robust: we both CONSTRUCT and
// FORMAT in local time, so the asserted calendar date matches regardless of the test machine's TZ.
const endOfDay = (y, mo, d) => new Date(y, mo, d, 23, 59, 59, 999).getTime();
const at = (y, mo, d, h, mi = 0) => new Date(y, mo, d, h, mi, 0, 0).getTime();
const base = { id: 7, user_id: 1, summary: 'call the dentist' };

test('an undated task has no calendar event', () => {
  assert.equal(taskEventTime({ ...base }), null);
  assert.equal(icsForTask({ ...base }), null);
});

test('"by <date>" (date-only deadline) → a 5pm timed block, NOT a 23:59 all-day event', () => {
  const t = { ...base, due_at: endOfDay(2026, 5, 26) }; // Fri Jun 26 2026, 23:59:59 local
  assert.deepEqual(taskEventTime(t), { at: at(2026, 5, 26, 17), allDay: false }); // anchored to 5pm that day
  const { ics } = icsForTask(t);
  assert.match(ics, /DTSTART:\d{8}T\d{6}Z/);          // a timed event (5pm local, emitted UTC)
  assert.match(ics, /DTEND:\d{8}T\d{6}Z/);
  assert.doesNotMatch(ics, /VALUE=DATE/);             // NOT an all-day event
});

test('"by 5pm" (a clock-time deadline) → a 30-min timed event', () => {
  const t = { ...base, due_at: at(2026, 5, 26, 17) };
  assert.equal(taskEventTime(t).allDay, false);
  const { ics } = icsForTask(t);
  assert.match(ics, /DTSTART:\d{8}T\d{6}Z/);          // timed, UTC
  assert.match(ics, /DTEND:\d{8}T\d{6}Z/);
  assert.doesNotMatch(ics, /VALUE=DATE/);
});

test('"on <day> <time>" (remind_at === due_at) → a timed event', () => {
  const m = at(2026, 5, 26, 15);
  assert.equal(taskEventTime({ ...base, remind_at: m, due_at: m }).allDay, false);
});

test('"remind me at <time>" (remind_at set, NO due_at) → a timed event', () => {
  const m = at(2026, 5, 26, 21, 45);
  assert.deepEqual(taskEventTime({ ...base, remind_at: m }), { at: m, allDay: false }); // a pure reminder is timed
  const { ics } = icsForTask({ ...base, remind_at: m });
  assert.match(ics, /DTSTART:\d{8}T\d{6}Z/); // timed, UTC — not an all-day block
  assert.doesNotMatch(ics, /VALUE=DATE/);
});

test('"on <day>" with no time (09:00 nudge ≠ end-of-day) → an all-day event', () => {
  const t = { ...base, remind_at: at(2026, 5, 26, 9), due_at: endOfDay(2026, 5, 26) };
  assert.deepEqual(taskEventTime(t), { at: t.remind_at, allDay: true });
});

test('summary text is RFC-5545 escaped; description carried only when it adds something', () => {
  const t = { ...base, summary: 'pay rent, then call; soon', original_text: 'pay rent, then call; soon — ugh', due_at: endOfDay(2026, 5, 26) };
  const { ics, filename } = icsForTask(t);
  assert.match(ics, /SUMMARY:pay rent\\, then call\\; soon/);
  assert.match(ics, /DESCRIPTION:pay rent\\, then call\\; soon — ugh/);
  assert.match(filename, /\.ics$/);
  // identical original_text adds nothing → no DESCRIPTION line
  assert.doesNotMatch(icsForTask({ ...base, summary: 'x', original_text: 'x', due_at: endOfDay(2026, 5, 26) }).ics, /DESCRIPTION:/);
});

test('the event is a single well-formed VEVENT with a stable per-task UID', () => {
  const { ics } = icsForTask({ ...base, due_at: endOfDay(2026, 5, 26) }, 0);
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /UID:fanad-task-7-1@fanad/);
  assert.match(ics, /DTSTAMP:\d{8}T\d{6}Z/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
});
