// "Add to calendar" — build a standard iCalendar (.ics) VEVENT for a DATED task so the user can drop it
// into their OWN calendar (Apple / Google / Outlook) and, if they want it to repeat, make it recur THERE.
// Fanad deliberately has no recurring tasks (recurrence = nagging = stress); the calendar owns time pressure,
// on the user's terms. Surfaced by chat.js (the `· 📅 /cal_N` marker + `/cal N` command) and the
// GET /api/tasks/:id/event.ics endpoint. Pure + deterministic (no I/O) so it's unit-testable.
//
// Date semantics mirror how capture stores dates (services/llm/deadline.js):
//   • "on <when> <time>"  → remind_at === due_at === that moment      → a TIMED event there
//   • "remind me at <time>" → remind_at = that moment, no due_at (a pure reminder)   → a TIMED event there
//   • "on <when>" (no time) → remind_at = 09:00 (a nudge), due_at = end-of-day (they differ) → ALL-DAY
//   • "by <when>" date-only → due_at = end-of-local-day (23:59:59.999), no remind_at  → a TIMED 5pm block
//   • "by 5pm" (a clock time) → due_at = that moment, no remind_at                              → TIMED
// A date-only deadline has no clock time of its own. We deliberately DON'T drop it on the calendar at its
// 23:59 end-of-day sentinel (it imported as an awkward ~11:50 PM event); instead we anchor the block to a
// sane late-afternoon default so it reads like a "get it done by today" reminder.
const DEFAULT_EVENT_MS = 30 * 60000; // a timed event carries no duration of its own → a gentle 30-min block
const DAY_MS = 86400000;
const DEADLINE_HOUR = 17;            // 5pm — where a date-only deadline's calendar block lands

const isEndOfDay = (ts) => {
  const d = new Date(ts);
  return d.getHours() === 23 && d.getMinutes() === 59 && d.getSeconds() === 59;
};
// The 5pm moment on a timestamp's LOCAL day — the calendar slot for a date-only deadline.
const deadlineClock = (ts) => { const d = new Date(ts); d.setHours(DEADLINE_HOUR, 0, 0, 0); return d.getTime(); };

// Resolve a task's single calendar moment. → { at: epoch-ms, allDay: bool } or null when undated.
export function taskEventTime(task) {
  const remind = task?.remind_at != null && !Number.isNaN(Number(task.remind_at)) ? Number(task.remind_at) : null;
  const due = task?.due_at != null && !Number.isNaN(Number(task.due_at)) ? Number(task.due_at) : null;
  if (remind != null) {
    // A reminder pinned to a clock time → a TIMED event. Two shapes carry a real time: "on <when> <time>"
    // (remind === due) and a pure "remind me at <time>" (due is null). The dateless "on <when>" path is the
    // only remind-with-a-DIFFERING-due case (a 09:00 nudge + end-of-day due) → it stays all-day.
    if (due == null || remind === due) return { at: remind, allDay: false }; // user named a time
    return { at: remind, allDay: true };                                     // 09:00 default → date-only
  }
  if (due != null) {
    return isEndOfDay(due)
      ? { at: deadlineClock(due), allDay: false }  // date-only deadline → a 5pm timed block (not the 23:59 sentinel)
      : { at: due, allDay: false };                // an explicit clock-time deadline ("by 5pm") → that exact moment
  }
  return null;
}

const pad = (n) => String(n).padStart(2, '0');
// Timed events are emitted in UTC (…Z) — unambiguous across the importer's timezone.
const utcStamp = (ts) => {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
    + `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
};
// All-day events use the LOCAL calendar date (so "Friday" stays Friday for the user), with no time/zone.
const localDate = (ts) => { const d = new Date(ts); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`; };

// Escape per RFC 5545 §3.3.11 (backslash, semicolon, comma, newline). Property values only.
const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

const slug = (s) => (String(s || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)) || 'task';

// Build the .ics for a task. now is injectable so DTSTAMP is testable. Returns { filename, ics } or null.
export function icsForTask(task, now = Date.now()) {
  const ev = taskEventTime(task);
  if (!ev) return null;
  const uid = `fanad-task-${task.id}-${task.user_id}@fanad`;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Fanad//Lighthouse//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${utcStamp(now)}`,
  ];
  if (ev.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${localDate(ev.at)}`, `DTEND;VALUE=DATE:${localDate(ev.at + DAY_MS)}`);
  } else {
    lines.push(`DTSTART:${utcStamp(ev.at)}`, `DTEND:${utcStamp(ev.at + DEFAULT_EVENT_MS)}`);
  }
  lines.push(`SUMMARY:${esc(task.summary)}`);
  // The verbatim capture makes a useful note in the event body (only when it adds something).
  const desc = task.original_text && task.original_text !== task.summary ? task.original_text : '';
  if (desc) lines.push(`DESCRIPTION:${esc(desc)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return { filename: `${slug(task.summary)}.ics`, ics: `${lines.join('\r\n')}\r\n` };
}
