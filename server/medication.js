// The Medication module engine (opt-in): a calm adherence LOGGER, not an advisor. "med amlodipine" marks a
// dose taken today; "med morning" logs a whole named template; "med all" completes the day's scheduled meds.
// Each med owns one named metric (metrics.kind='med'), so a dose is just a metric_value and "taken today" is
// derived from metricValuesSince — there is no med-log table, and `chart amlodipine` reuses the metric chart.
// Med metrics are flagged so they never appear in the generic tally / Metrics view (see repo.listMetrics).
// SAFETY: this file never calls an LLM. It records only what the user types — no guessed doses, no drug or
// interaction info, no dosing advice. The chat surface (server/features/medication.js) is thin over this.
import {
  getMed, listMeds, upsertMed, setMedMetric, deleteMed,
  getMedTemplate, getMedTemplateById, listMedTemplates, upsertMedTemplate, setMedTemplateReminder, deleteMedTemplate,
  getOrCreateMetric, getMetric, insertMetricValue, metricValuesBetween, deleteMetricValuesByIds,
} from './repo.js';
import { setDialogState, clearDialogState, medReminderAnswer } from './dialog.js';
import { recordUndo } from './undo.js';
import { renderMetricChart } from './charts.js';
import { dayStartOf } from '../shared/timeframe.js';

// Shown on opt-in and in the web view footer (mirrors the journal's code-appended disclaimer). Not medical advice.
export const MED_DISCLAIMER = '💊 Medication tracks only what you log — it’s a reminder-and-adherence journal, not medical advice. It never suggests doses or drug info. Talk to your pharmacist or doctor about your medications.';

const fmtClock = (mod) => `${String(Math.floor(mod / 60)).padStart(2, '0')}:${String(mod % 60).padStart(2, '0')}`;
const parseMeds = (json) => { try { const a = JSON.parse(json || '[]'); return Array.isArray(a) ? a.filter((s) => typeof s === 'string' && s.trim()) : []; } catch { return []; } };

// The per-med adherence metric shares the med's name (so `chart amlodipine` resolves it), summed per day,
// target 1 dose/day, flagged kind='med' so it stays out of the generic tally. Created lazily and linked back.
function ensureMedMetric(userId, med) {
  const m = getOrCreateMetric(userId, med.name, { aggregation: 'sum', target: 1, kind: 'med' });
  if (med.metric_id !== m.id) setMedMetric(userId, med.id, m.id);
  return m;
}

// Get an existing med (± a trailing 's' fallback, like findFood) or create it on first use.
function findOrCreateMed(userId, name) {
  const n = name.trim();
  const hit = getMed(userId, n) || (n.endsWith('s') ? getMed(userId, n.slice(0, -1)) : getMed(userId, `${n}s`));
  return hit || upsertMed(userId, { name: n });
}

const DAY_MS = 86400000;
// "Taken today" = a dose recorded within THIS logical day only — the window [dayStartOf(now), +24h). Bounded
// above (not a bare "since") so a dose dated to a later day never counts as today's — and a 1am dose still
// falls in the prior day, matching the app-wide 02:00 rollover.
function takenToday(userId, metricId, now = Date.now()) {
  if (metricId == null) return false;
  const start = dayStartOf(now);
  return metricValuesBetween(userId, metricId, start, start + DAY_MS).length > 0;
}

// Log one dose (always inserts — a second "med amlodipine" is a legit second dose for twice-daily meds).
function logDose(userId, med, now = Date.now()) {
  const metric = ensureMedMetric(userId, med);
  const label = `💊 ${med.name}`;
  const id = insertMetricValue({ userId, metricId: metric.id, value: 1, note: med.dose || null, entryLabel: label, recordedAt: now });
  recordUndo(userId, 'metric_log', { ids: [id] }, `↩ Undid “${label}”.`);
  return metric;
}

// ── Logging ──────────────────────────────────────────────────────────────

export function logMed(userId, name, now = Date.now()) {
  const med = findOrCreateMed(userId, name);
  logDose(userId, med, now);
  const dose = med.dose ? ` (${med.dose})` : '';
  return `✅ Logged ${med.name}${dose} — taken today.\n${todaySummaryLine(userId, now)}`;
}

// Log every member of a named template that hasn't been taken today; report ✓ (just logged) vs already-done.
export function logTemplate(userId, tplName, now = Date.now()) {
  const tpl = getMedTemplate(userId, tplName);
  if (!tpl) return null; // caller falls through to logMed
  const names = parseMeds(tpl.meds_json);
  if (!names.length) return `“${tpl.name}” has no meds yet. Add some with: med template ${tpl.name} = <med1>, <med2>`;
  const done = []; const already = [];
  for (const nm of names) {
    const med = findOrCreateMed(userId, nm);
    const metric = ensureMedMetric(userId, med);
    if (takenToday(userId, metric.id, now)) { already.push(med.name); continue; }
    logDose(userId, med, now);
    done.push(med.name);
  }
  const parts = [];
  if (done.length) parts.push(`✅ Logged ${tpl.name}: ${done.join(', ')}`);
  if (already.length) parts.push(`already taken today: ${already.join(', ')}`);
  if (!done.length) return `👍 ${tpl.name} was already done today (${already.join(', ')}).`;
  return `${parts.join(' · ')}.\n${todaySummaryLine(userId, now)}`;
}

// "med all" — complete every scheduled med (a template member) not yet taken today.
export function medAll(userId, now = Date.now()) {
  const tpls = listMedTemplates(userId);
  const names = [...new Set(tpls.flatMap((t) => parseMeds(t.meds_json)))];
  if (!names.length) return 'No med templates yet. Build one with: med template morning = amlodipine, metformin';
  const done = []; const already = [];
  for (const nm of names) {
    const med = findOrCreateMed(userId, nm);
    const metric = ensureMedMetric(userId, med);
    if (takenToday(userId, metric.id, now)) { already.push(med.name); continue; }
    logDose(userId, med, now);
    done.push(med.name);
  }
  if (!done.length) return `👍 All your scheduled meds were already taken today (${already.join(', ')}).`;
  const tail = already.length ? ` (already done: ${already.join(', ')})` : '';
  return `✅ Logged all remaining meds: ${done.join(', ')}${tail}.\n${todaySummaryLine(userId, now)}`;
}

// Resolve a bare "med <token>": a template name logs the whole template; anything else logs a single med.
export function logMedToken(userId, token, now = Date.now()) {
  const tpl = logTemplate(userId, token, now);
  return tpl != null ? tpl : logMed(userId, token, now);
}

// ── Today's adherence view (the `meds` screen) ─────────────────────────────

function tick(userId, med, now) {
  const metric = getMetric(userId, med.name);
  return takenToday(userId, metric?.id, now) ? '☑' : '☐';
}

// A compact one-liner appended after a log — how many of today's scheduled meds are done.
function todaySummaryLine(userId, now = Date.now()) {
  const names = [...new Set(listMedTemplates(userId).flatMap((t) => parseMeds(t.meds_json)))];
  if (!names.length) return 'Tip: group your meds into a template — “med template morning = …”.';
  let taken = 0;
  for (const nm of names) { const met = getMetric(userId, nm); if (takenToday(userId, met?.id, now)) taken += 1; }
  return `Today: ${taken}/${names.length} scheduled meds taken.`;
}

export function todayView(userId, now = Date.now()) {
  const tpls = listMedTemplates(userId);
  const meds = listMeds(userId);
  if (!tpls.length && !meds.length) {
    return `No meds yet. Start with:\n• med add amlodipine 5mg\n• med template morning = amlodipine, metformin\nThen log with “med amlodipine” or “med morning”.\n\n${MED_DISCLAIMER}`;
  }
  const lines = ['💊 Today'];
  const inTemplate = new Set();
  for (const t of tpls) {
    const names = parseMeds(t.meds_json);
    names.forEach((n) => inTemplate.add(n.toLowerCase()));
    const when = t.remind_minute_of_day != null && t.reminder_enabled ? ` — 🔔 ${fmtClock(t.remind_minute_of_day)}` : '';
    lines.push(`\n${t.name}${when}`);
    if (!names.length) { lines.push('  (no meds yet)'); continue; }
    for (const nm of names) {
      const med = getMed(userId, nm) || { name: nm, dose: null };
      const dose = med.dose ? ` (${med.dose})` : '';
      lines.push(`  ${tick(userId, med, now)} ${med.name}${dose}`);
    }
  }
  const loose = meds.filter((m) => !inTemplate.has(m.name.toLowerCase()));
  if (loose.length) {
    lines.push('\nother meds');
    for (const med of loose) {
      const dose = med.dose ? ` (${med.dose})` : '';
      lines.push(`  ${tick(userId, med, now)} ${med.name}${dose}`);
    }
  }
  lines.push('\nLog with “med <name>”, a template with “med <template>”, or “med all”. “undo” takes back the last dose.');
  return lines.join('\n');
}

// ── Catalog (meds) ─────────────────────────────────────────────────────────

export function addMed(userId, name, dose = null) {
  const clean = name.trim();
  if (!clean) return 'Name the medication, e.g. “med add amlodipine 5mg”.';
  const existed = getMed(userId, clean);
  const med = upsertMed(userId, { name: clean, dose: dose ? dose.trim() : null });
  ensureMedMetric(userId, med);
  const doseTxt = med.dose ? ` (${med.dose})` : '';
  return `${existed ? '✍️ Updated' : '💊 Added'} ${med.name}${doseTxt}. Log a dose with “med ${med.name}”.`;
}

export function listMedsText(userId, now = Date.now()) {
  const meds = listMeds(userId);
  if (!meds.length) return 'No meds in your catalog yet. Add one: med add amlodipine 5mg';
  const lines = meds.map((m) => {
    const dose = m.dose ? ` — ${m.dose}` : '';
    return `${tick(userId, m, now)} ${m.name}${dose}`;
  });
  return `💊 Your meds:\n${lines.join('\n')}`;
}

export function deleteMedText(userId, name) {
  const med = getMed(userId, name.trim());
  if (!med) return `No med called “${name.trim()}”. See your list with “med list”.`;
  deleteMed(userId, med.name); // the adherence metric is kept (its history/chart survive)
  return `🗑️ Removed ${med.name} from your meds. Its dose history is kept (med chart ${med.name}).`;
}

// "med chart <name> [range]" — the per-med adherence chart. Self-contained (reuses renderMetricChart) so it
// works with the Medication module on and Metrics off. A trailing range token ("7d"/"90d"/"week") is optional.
const RANGE_TAIL = /^(.*?\S)\s+(\d+\s*[dwmy]|\d+\s*days?|week|month|year|all)$/i;
export function medChartReply(userId, arg) {
  const raw = (arg || '').trim();
  const mm = RANGE_TAIL.exec(raw);
  const name = (mm ? mm[1] : raw).trim();
  const range = mm ? mm[2].replace(/\s+/g, '') : '30d';
  if (!name) return 'Which med? e.g. “med chart amlodipine”.';
  const med = getMed(userId, name);
  const metricName = med ? med.name : name; // charts resolve the metric by the med's canonical name
  const r = renderMetricChart(userId, metricName, range);
  if (!r) return `No doses logged for “${name}” yet. Log one with “med ${name}”.`;
  return { text: `📈 ${metricName} adherence · ${r.label}${r.points ? '' : ' (no data yet)'}`, image: r.image };
}

// ── Templates ────────────────────────────────────────────────────────────

// "med template morning = amlodipine, metformin" — split the RHS on commas; auto-create any unknown meds
// (same as logging an unknown one). Then START the reminder dialog (startMedReminder sets it). Returns the reply.
export function defineTemplate(userId, name, body) {
  const tname = name.trim();
  if (!tname) return 'Name the template, e.g. “med template morning = amlodipine, metformin”.';
  const names = body.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
  if (!names.length) return 'List the meds after “=”, e.g. “med template morning = amlodipine, metformin”.';
  const canonical = names.map((n) => findOrCreateMed(userId, n).name);
  const tpl = upsertMedTemplate(userId, { name: tname, medsJson: JSON.stringify([...new Set(canonical)]) });
  return startMedReminder(userId, tpl);
}

export function listTemplatesText(userId) {
  const tpls = listMedTemplates(userId);
  if (!tpls.length) return 'No med templates yet. Build one: med template morning = amlodipine, metformin';
  const lines = tpls.map((t) => {
    const names = parseMeds(t.meds_json);
    const when = t.remind_minute_of_day != null && t.reminder_enabled ? ` — 🔔 ${fmtClock(t.remind_minute_of_day)}` : '';
    return `• ${t.name}${when}: ${names.join(', ') || '(empty)'}`;
  });
  return `💊 Templates:\n${lines.join('\n')}\nLog one with “med <name>”.`;
}

export function showTemplateText(userId, name) {
  const tpl = getMedTemplate(userId, name.trim());
  if (!tpl) return `No template called “${name.trim()}”. See them with “med templates”.`;
  const names = parseMeds(tpl.meds_json);
  const when = tpl.remind_minute_of_day != null && tpl.reminder_enabled ? `🔔 daily at ${fmtClock(tpl.remind_minute_of_day)}` : 'no reminder';
  return `💊 ${tpl.name} (${when}):\n${names.map((n) => `  • ${n}`).join('\n') || '  (empty)'}\nSet the reminder: med template ${tpl.name} remind <time|off>`;
}

export function deleteTemplateText(userId, name) {
  const tpl = getMedTemplate(userId, name.trim());
  if (!tpl) return `No template called “${name.trim()}”.`;
  deleteMedTemplate(userId, tpl.name);
  return `🗑️ Deleted the ${tpl.name} template. Your meds and their history are untouched.`;
}

// Direct reminder set/clear (bypasses the dialog): "med template morning remind 8am" / "… remind off".
export function setTemplateReminderText(userId, name, timeArg) {
  const tpl = getMedTemplate(userId, name.trim());
  if (!tpl) return `No template called “${name.trim()}”. Create it first: med template ${name.trim()} = <meds>`;
  const arg = (timeArg || '').trim();
  if (/^(off|none|no|clear|cancel)$/i.test(arg)) {
    setMedTemplateReminder(userId, tpl.id, null, false);
    return `🔕 Reminder off for ${tpl.name}.`;
  }
  const ans = medReminderAnswer(arg);
  if (!ans || ans.type !== 'time') return `Give a time like “8am”, “20:00”, or “off”. e.g. med template ${tpl.name} remind 8am`;
  setMedTemplateReminder(userId, tpl.id, ans.minute, true);
  return `🔔 ${tpl.name} reminder set for ${fmtClock(ans.minute)} daily.`;
}

// ── Reminder dialog (copies diet's recipe_build shape) ─────────────────────

export function startMedReminder(userId, tpl) {
  setDialogState(userId, { type: 'med_reminder', data: { templateId: tpl.id, name: tpl.name }, prompt: 'want a daily reminder?' });
  const names = parseMeds(tpl.meds_json);
  return `💊 Saved “${tpl.name}”: ${names.join(', ')}.\nWant a daily reminder? Reply a time like “8am” (or “no”).`;
}

export function medReminderStep(userId, text, ds) {
  const ans = medReminderAnswer(text);
  const { templateId, name } = ds.data;
  if (!ans) return `Reply a time like “8am”, “20:00”, or “no”.`;
  if (ans.type === 'yes') return 'What time? Reply like “8am” or “20:00” (or “no”).';
  clearDialogState(userId);
  if (ans.type === 'no') return `👍 No reminder for ${name}. You can add one later: med template ${name} remind <time>.`;
  const tpl = getMedTemplateById(userId, templateId);
  if (!tpl) return 'That template is gone now — nothing to remind on.';
  setMedTemplateReminder(userId, tpl.id, ans.minute, true);
  return `🔔 I’ll remind you about ${name} every day at ${fmtClock(ans.minute)}.`;
}

// Used by the scheduler (fireDueMedReminders) to skip a reminder whose meds are already all taken today.
export function allMedsTakenToday(userId, medsJson, now = Date.now()) {
  const names = parseMeds(medsJson);
  if (!names.length) return true;
  return names.every((nm) => { const m = getMetric(userId, nm); return takenToday(userId, m?.id, now); });
}

// The scheduler's reminder text for one due template.
export function medReminderText(tpl) {
  const names = parseMeds(tpl.meds_json);
  return `💊 Time for your ${tpl.name} meds: ${names.join(', ')}. Reply “med ${tpl.name}” when done.`;
}

// ── Structured data for the web view (routes return JSON, never the chat text above) ──────────────────────
function medEntry(userId, med, now) {
  const metric = getMetric(userId, med.name);
  return { id: med.id ?? null, name: med.name, dose: med.dose || null, notes: med.notes || null, taken: takenToday(userId, metric?.id, now) };
}
function tplData(userId, t, now, withMeds) {
  const names = parseMeds(t.meds_json);
  return {
    id: t.id, name: t.name, remindMinute: t.remind_minute_of_day, reminderEnabled: !!t.reminder_enabled,
    remindLabel: t.remind_minute_of_day != null ? fmtClock(t.remind_minute_of_day) : null,
    meds: withMeds ? names.map((nm) => medEntry(userId, getMed(userId, nm) || { name: nm }, now)) : names,
  };
}

// Today's adherence, by template + loose meds — the primary web payload (tap-to-tick reads `taken`).
export function todayData(userId, now = Date.now()) {
  const inTpl = new Set();
  const templates = listMedTemplates(userId).map((t) => {
    parseMeds(t.meds_json).forEach((n) => inTpl.add(n.toLowerCase()));
    return tplData(userId, t, now, true);
  });
  const loose = listMeds(userId).filter((m) => !inTpl.has(m.name.toLowerCase())).map((m) => medEntry(userId, m, now));
  return { templates, loose, disclaimer: MED_DISCLAIMER };
}
export function catalogData(userId, now = Date.now()) {
  return listMeds(userId).map((m) => medEntry(userId, m, now));
}
export function templatesData(userId) {
  return listMedTemplates(userId).map((t) => tplData(userId, t, Date.now(), false));
}

// Tick / untick one med for TODAY (the web checklist). taken=true logs a dose; taken=false removes today's
// dose(s) for it (the web analogue of "undo", scoped to that med + today).
export function webSetTaken(userId, name, taken, now = Date.now()) {
  const med = findOrCreateMed(userId, name);
  const metric = ensureMedMetric(userId, med);
  if (taken) { logDose(userId, med, now); return; }
  const start = dayStartOf(now);
  const todays = metricValuesBetween(userId, metric.id, start, start + DAY_MS);
  if (todays.length) deleteMetricValuesByIds(userId, todays.map((v) => v.id));
}
export function webAddMed(userId, name, dose = null) {
  const med = upsertMed(userId, { name: String(name).trim(), dose: dose ? String(dose).trim() : null });
  ensureMedMetric(userId, med);
  return med;
}
// Create/replace a template from the web editor (no reminder dialog — the web sets the time via its own field).
export function webSaveTemplate(userId, name, meds) {
  const canonical = (Array.isArray(meds) ? meds : []).map((n) => findOrCreateMed(userId, String(n).trim()).name).filter(Boolean);
  return upsertMedTemplate(userId, { name: String(name).trim(), medsJson: JSON.stringify([...new Set(canonical)]) });
}
