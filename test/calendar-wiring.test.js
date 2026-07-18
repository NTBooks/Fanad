// "Add to calendar" wiring through the chat brain: dated captures + /tasks rows + /cal N carry the .ics
// (Telegram document) and a download URL (web). Undated tasks carry neither. See server/calendar.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-cal-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage } = await import('../server/chat.js');

migrate();
const say = (text) => handleMessage({ text });
// A weekday a couple of days out, so "on <weekday> 3pm" is always in the FUTURE — "friday 3pm" run on a Friday
// after 3pm resolves to today-in-the-past, which expires the task (it drops off /tasks and loses its 📅 marker).
// Two days out is never today and is future at any clock time, keeping this end-to-end test clock-independent.
const FUTURE_WEEKDAY = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][(new Date().getDay() + 2) % 7];

test('filing a DATED task attaches an add-to-calendar (download URL + .ics document)', async () => {
  const r = await say(`call mom on ${FUTURE_WEEKDAY} 3pm`);
  assert.match(r.reply, /Filed/i);
  assert.match(r.calendarUrl || '', /^\/api\/tasks\/\d+\/event\.ics$/, 'web download URL');
  assert.ok(r.document?.content?.includes('BEGIN:VCALENDAR'), 'Telegram .ics bytes');
  assert.match(r.document.content, /DTSTART:\d{8}T\d{6}Z/, 'a clock time → a timed event');
});

test('an UNDATED task gets no calendar affordance', async () => {
  const r = await say('water the plants');
  assert.equal(r.calendarUrl, null);
  assert.equal(r.document, null);
});

test('/tasks shows a tappable 📅 /cal_N on the dated row, and /cal N returns the event', async () => {
  const list = await say('/tasks');
  const m = list.reply.match(/📅 \/cal_(\d+)/);
  assert.ok(m, 'a dated row offers a tappable /cal_N');
  const r = await say(`/cal ${m[1]}`);
  assert.match(r.reply, /calendar/i);
  assert.match(r.calendarUrl || '', /\/api\/tasks\/\d+\/event\.ics/);
  assert.ok(r.document?.content?.includes('BEGIN:VEVENT'));
});

test('/cal on a position that is not on the list is handled, not crashed', async () => {
  const r = await say('/cal 99');
  assert.equal(typeof (r.reply ?? r), 'string');
  assert.doesNotMatch(String(r.reply ?? r), /BEGIN:VCALENDAR/);
});
