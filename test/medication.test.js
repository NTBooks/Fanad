// The Medication module (opt-in, ships dark): the adherence logger modeled on Diet. Covers opt-in gating,
// the add/log loop (dose-note parsing, auto-create on first use), one metric per med flagged kind='med' and
// kept OUT of the generic tally/listMetrics, named templates + the compact "=" parse, the med_reminder
// dialog, "med all", "taken today" derived across the 02:00 rollover, app-wide undo of a dose, the daily
// reminder firer (dedup + skip-when-already-taken + globally-dark ⇒ silent), and per-med charting. Runs on
// the mock provider — but the engine never calls the LLM, so nothing here depends on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-med-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate, db } = await import('../server/db.js');
migrate();
const { handleMessage } = await import('../server/chat.js');
const { clearDialogState } = await import('../server/dialog.js');
const { setUserFeatures, setSystemModules, isSystemModuleOn } = await import('../server/settings.js');
const { defaultUserId, getMetric, listMetrics, getMed, getMedTemplate } = await import('../server/repo.js');
const {
  logMed, todayData, allMedsTakenToday, catalogData, webSetTaken,
} = await import('../server/medication.js');
const { fireDueMedReminders } = await import('../server/scheduler.js');
const { dayStartOf } = await import('../shared/timeframe.js');

const uid = defaultUserId();
const raw = (text) => handleMessage({ text });                    // keeps dialog state (for the reminder flow)
const say = async (text) => { clearDialogState(uid); return (await raw(text)).reply; };

test('ships dark: on a fresh DB the medication system module is OFF (default-off)', () => {
  assert.equal(isSystemModuleOn('medication'), false);
});

test('off for the user → the command offers to turn it on, never files a task or errors', async () => {
  setUserFeatures(uid, { medication: false });
  const r = await say('med amlodipine');
  assert.match(r, /Medication is off/i);
  setUserFeatures(uid, { medication: true }); // …and everything below runs with it ON (owner bypasses the dark gate)
});

test('med add parses a trailing dose note; the name can be multi-word', async () => {
  assert.match(await say('med add amlodipine 5mg'), /Added amlodipine \(5mg\)/i);
  assert.equal(getMed(uid, 'amlodipine').dose, '5mg');
  assert.match(await say('med add vitamin d 1000 iu'), /Added vitamin d \(1000 iu\)/i);
  assert.equal(getMed(uid, 'vitamin d').dose, '1000 iu');
  assert.match(await say('med add fish oil'), /Added fish oil\b/i);         // no dose clause → whole rest is the name
  assert.equal(getMed(uid, 'fish oil').dose, null);
});

test('logging a med creates ONE metric per med, flagged kind=med and hidden from the generic tally', async () => {
  await say('med amlodipine');
  const m = getMetric(uid, 'amlodipine');
  assert.equal(m.kind, 'med');
  assert.equal(m.target, 1);            // one expected dose/day
  assert.equal(m.aggregation, 'sum');
  // listMetrics (tally / Metrics view / HA summary all use it) must NOT surface med metrics.
  assert.ok(!listMetrics(uid).some((x) => x.name === 'amlodipine'), 'med metric leaked into listMetrics');
  // …but getMetric-by-name still resolves it, so "med chart amlodipine" works.
  assert.ok(getMetric(uid, 'amlodipine'));
});

test('an unknown med is auto-created on first log', async () => {
  await say('med aspirin');
  assert.ok(getMed(uid, 'aspirin'), 'aspirin was not auto-created');
  assert.equal(getMetric(uid, 'aspirin').kind, 'med');
});

test('the compact "template = ..." parse auto-creates members and starts the reminder dialog', async () => {
  clearDialogState(uid);
  const r = (await raw('med template morning = amlodipine, metformin')).reply;
  assert.match(r, /Saved .?morning.?: amlodipine, metformin/i);
  assert.match(r, /reminder/i);                            // the dialog prompt
  const tpl = getMedTemplate(uid, 'morning');
  assert.deepEqual(JSON.parse(tpl.meds_json), ['amlodipine', 'metformin']);
  assert.ok(getMed(uid, 'metformin'), 'a template member unknown until now was auto-created');
  // answer the open dialog with a time → sets the reminder
  const done = (await raw('8am')).reply;
  assert.match(done, /08:00/);
  assert.equal(getMedTemplate(uid, 'morning').remind_minute_of_day, 480);
  assert.equal(getMedTemplate(uid, 'morning').reminder_enabled, 1);
});

test('declining the reminder dialog leaves no reminder', async () => {
  clearDialogState(uid);
  await raw('med template evening = metformin');
  const r = (await raw('no')).reply;
  assert.match(r, /No reminder/i);
  assert.equal(getMedTemplate(uid, 'evening').remind_minute_of_day, null);
});

test('med <template> logs its members and skips ones already taken today; med all finishes the day', async () => {
  // amlodipine was logged above; metformin has not been today.
  const r = await say('med morning');
  assert.match(r, /metformin/);                            // the not-yet-taken one is logged
  assert.match(r, /already taken today: amlodipine/i);     // the taken one is reported, not double-logged
  // now everything in morning is done
  const again = await say('med morning');
  assert.match(again, /already done today/i);
  // med all: nothing left across templates
  assert.match(await say('med all'), /already taken today/i);
});

test('the meds view shows today\'s checklist by template with ☑ / ☐', async () => {
  const r = await say('meds');
  assert.match(r, /morning/);
  assert.match(r, /☑ amlodipine/);
  assert.match(r, /☑ metformin/);
});

test('taken-today is DERIVED from the med metric within the 02:00-rollover day, not a stored flag', () => {
  clearDialogState(uid);
  // A brand-new isolated med so other tests' logs can't interfere.
  const now = Date.parse('2026-03-10T15:00:00');            // mid-afternoon
  logMed(uid, 'losartan', now);
  const metric = getMetric(uid, 'losartan');
  // logged "today" (same logical day) → taken
  assert.equal(allMedsTakenToday(uid, JSON.stringify(['losartan']), now), true);
  // the NEXT logical day (24h later, past the 02:00 boundary) → not taken
  assert.equal(allMedsTakenToday(uid, JSON.stringify(['losartan']), now + 24 * 3600 * 1000), false);
  // sanity: the dose landed on/after the day's 02:00 start
  const start = dayStartOf(now);
  assert.ok(start <= now && new Date(start).getHours() === 2);
});

test('undo (app-wide) takes back the last logged dose', async () => {
  clearDialogState(uid);
  await say('med add naproxen');
  await say('med naproxen');
  assert.equal(catalogData(uid).find((m) => m.name === 'naproxen').taken, true);
  const r = await say('undo');
  assert.match(r, /Undid .*naproxen/i);
  assert.equal(catalogData(uid).find((m) => m.name === 'naproxen').taken, false);
});

test('the web tick/untick helper logs and removes today\'s dose', () => {
  clearDialogState(uid);
  const now = Date.parse('2026-03-11T09:00:00');
  webSetTaken(uid, 'ibuprofen', true, now);
  assert.equal(allMedsTakenToday(uid, JSON.stringify(['ibuprofen']), now), true);
  webSetTaken(uid, 'ibuprofen', false, now);
  assert.equal(allMedsTakenToday(uid, JSON.stringify(['ibuprofen']), now), false);
});

test('med chart resolves the med metric by name', async () => {
  clearDialogState(uid);
  const r = await raw('med chart amlodipine');
  assert.match(r.text || r.reply || '', /amlodipine adherence/i);
});

// ── the daily reminder firer ──────────────────────────────────────────────
// A local time whose minute-of-day is 480 (08:00) — the "morning" reminder set above. We build a Date at
// 08:00 local so fireDueMedReminders' minute = h*60+m matches.
const at0800 = (dayOffset = 0) => { const d = new Date(2026, 5, 1 + dayOffset, 8, 0, 0); return d.getTime(); };

test('globally dark ⇒ the firer is silent even for a due, un-taken template', async () => {
  setSystemModules({ medication: false });               // dark
  // make morning un-taken "today" by choosing a day far from the earlier logs
  const fired = await fireDueMedReminders(at0800(30), { send: () => true, sendSlackFn: () => true });
  assert.deepEqual(fired, []);
});

test('when enabled: the firer nudges a due template, dedups within the day, and skips once all meds are taken', async () => {
  setSystemModules({ medication: true });
  const sent = [];
  const send = (text, chatId) => { sent.push({ text, chatId }); return true; };

  // Day A, 08:00: morning's meds are NOT logged for that logical day → one nudge.
  const dayA = at0800(31);
  const fired1 = await fireDueMedReminders(dayA, { send, sendSlackFn: () => true });
  assert.equal(fired1.length, 1);
  assert.match(fired1[0], /Time for your morning meds/i);

  // Same day, same minute again: last_reminded_day dedups → nothing.
  const fired2 = await fireDueMedReminders(dayA, { send, sendSlackFn: () => true });
  assert.deepEqual(fired2, []);

  // Day B, but log the meds first → the reminder is STAMPED (won't retry) but sends NO nudge.
  const dayB = at0800(32);
  logMed(uid, 'amlodipine', dayB);
  logMed(uid, 'metformin', dayB);
  const fired3 = await fireDueMedReminders(dayB, { send, sendSlackFn: () => true });
  assert.deepEqual(fired3, [], 'no nudge when the template is already done for the day');
});

test('todayData exposes the disclaimer for the web footer', () => {
  const d = todayData(uid);
  assert.match(d.disclaimer, /not medical advice/i);
  assert.ok(Array.isArray(d.templates) && Array.isArray(d.loose));
});
