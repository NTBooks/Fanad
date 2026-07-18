// Deterministic deadline parsing for advanced /task: trailing "today"/"by <date/time>", the small-hours
// rollover for "today", and the short human label. (The LLM fallback is exercised via the chat tests.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate DB + KEK to a temp dir: importing deadline.js pulls in the LLM factory → config/db/crypto, which
// would otherwise create artifacts in the repo's ./data. Set DATA_DIR before the (dynamic) import.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-deadline-'));
const { parseDeadline, dueLabel, mightHaveDeadline } = await import('../server/services/llm/deadline.js');

const endOfDay = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x.getTime(); };

// Fixed anchors so the relative math is deterministic. June 21 2026 is a Sunday.
const SUN_2PM = new Date(2026, 5, 21, 14, 0, 0).getTime();   // Sun, daytime
const MON_1AM = new Date(2026, 5, 22, 1, 0, 0).getTime();    // Mon, small hours (night rollover)

test('no trailing deadline → null', () => {
  assert.equal(parseDeadline('buy oat milk', SUN_2PM), null);
  assert.equal(parseDeadline('call mom', SUN_2PM), null);
});

test('a date used as content (not a trailing deadline) is ignored', () => {
  // "on friday" mid-phrase is content; only a trailing "by …"/"today" counts.
  assert.equal(parseDeadline('plan the party on friday with the team', SUN_2PM), null);
});

test('"today" by day → end of today', () => {
  const r = parseDeadline('finish the report today', SUN_2PM);
  assert.equal(r.kind, 'today');
  assert.equal(r.dueAt, endOfDay(SUN_2PM));
});

test('"today" said at 1am → end of the NEXT day (small-hours rollover)', () => {
  const r = parseDeadline('finish the report today', MON_1AM);
  assert.equal(r.kind, 'today');
  // Monday 1am → not end of Monday, but end of Tuesday.
  assert.equal(r.dueAt, endOfDay(new Date(2026, 5, 23, 12, 0, 0).getTime()));
  assert.ok(r.dueAt > endOfDay(MON_1AM));
});

test('"tonight" follows the same rule as today', () => {
  assert.equal(parseDeadline('ship it tonight', SUN_2PM).dueAt, endOfDay(SUN_2PM));
  assert.equal(parseDeadline('ship it tonight', MON_1AM).dueAt, endOfDay(new Date(2026, 5, 23).getTime()));
});

test('"by tomorrow" → end of tomorrow', () => {
  const r = parseDeadline('email the vendor by tomorrow', SUN_2PM);
  assert.equal(r.dueAt, endOfDay(new Date(2026, 5, 22, 9, 0, 0).getTime()));
});

test('"by friday" resolves to the upcoming Friday, end of day', () => {
  const r = parseDeadline('submit the form by friday', SUN_2PM); // Sun → Fri Jun 26
  assert.equal(r.kind, 'by');
  assert.equal(r.dueAt, endOfDay(new Date(2026, 5, 26, 12, 0, 0).getTime()));
});

test('"by next friday" jumps a week', () => {
  const r = parseDeadline('submit the form by next friday', SUN_2PM); // → Fri Jul 3
  assert.equal(r.dueAt, endOfDay(new Date(2026, 6, 3, 12, 0, 0).getTime()));
});

test('"by <time>" today, or tomorrow if already past', () => {
  const future = parseDeadline('call the bank by 5pm', SUN_2PM); // 2pm now → 5pm today
  assert.equal(future.dueAt, new Date(2026, 5, 21, 17, 0, 0, 0).getTime());
  const past = parseDeadline('call the bank by 9am', SUN_2PM);   // 2pm now → 9am tomorrow
  assert.equal(past.dueAt, new Date(2026, 5, 22, 9, 0, 0, 0).getTime());
});

test('"by <month> <day>" and "by M/D" resolve to that day, end of day', () => {
  assert.equal(parseDeadline('renew the passport by june 30', SUN_2PM).dueAt,
    endOfDay(new Date(2026, 5, 30).getTime()));
  assert.equal(parseDeadline('file taxes by 7/15', SUN_2PM).dueAt,
    endOfDay(new Date(2026, 6, 15).getTime()));
});

test('mightHaveDeadline gates the LLM: date-less text is skipped, temporal tails pass', () => {
  // No LLM round-trip for plainly date-less captures…
  assert.equal(mightHaveDeadline('clean the garage'), false);
  assert.equal(mightHaveDeadline('buy oat milk'), false);
  // …but fuzzy trailing deadlines (that the regex parser misses) still reach the LLM.
  assert.equal(mightHaveDeadline('wrap the deck up before the weekend'), true);
  assert.equal(mightHaveDeadline('get it done sometime next week'), true);
  assert.equal(mightHaveDeadline('finish the report by friday'), true);
});

test('dueLabel renders short, relative text', () => {
  assert.equal(dueLabel(endOfDay(SUN_2PM), SUN_2PM), 'today');
  assert.equal(dueLabel(endOfDay(new Date(2026, 5, 22).getTime()), SUN_2PM), 'tomorrow');
  assert.equal(dueLabel(endOfDay(new Date(2026, 5, 26).getTime()), SUN_2PM), 'Fri');
  assert.equal(dueLabel(endOfDay(new Date(2026, 6, 15).getTime()), SUN_2PM), 'Jul 15');
});
