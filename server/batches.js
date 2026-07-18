// The process-batch engine (opt-in "batches" module) — tracking RUNS of a repeatable process
// (fermentation, brewing, baking, soap…). A batch opens as a task_template SNAPSHOT (directions copied
// RESET, the journal rule), collects ticked steps + dated log lines while it runs, and closes with an
// outcome. Engine only — command parsing lives in features/batches.js, following the metrics.js split.
// Deliberately NO AI passes and NO proactive anything: a batch moves only when the user says so.
import {
  getTemplate, listTemplates, createTemplateFromSteps, getBatchById, insertBatch, listBatches, latestOpenBatch,
  updateBatchChecklist, closeBatchRow, insertBatchLogLine,
  rejectTemplateVersion, unrejectTemplateVersion, rejectedVersionNames,
} from './repo.js';
import { parseChecklist } from './journal.js';

// ── Which batch did they mean? Named → that process's latest open run; bare → the latest-opened open run.
// A miss returns { error } copy the caller can hand straight back. ──
export function resolveOpenBatch(userId, name = null) {
  const batch = latestOpenBatch(userId, name);
  if (batch) return { batch };
  if (name) return { error: `No open “${String(name).trim()}” batch — “batch new ${String(name).trim()}” starts one, “batch history ${String(name).trim()}” shows past runs.` };
  return { error: 'No open batches — “batch new <name>” starts one from your /templates.' };
}

// ── Template FAMILY + versioning (by NAME convention, parsed in JS — never SQL LIKE, since #/%/_ in a base
// make it fragile). A process is a family of templates: the base "sourdough" is version 1 (no suffix), and
// "batch save" mints "sourdough #2", "#3"… `versionOf` re-verifies the prefix so "stew #2 #3" belongs to
// family "stew #2", not "stew". ──
const VER_RE = /^(.*\S)\s+#(\d+)$/;
export function familyOf(name) {
  const m = VER_RE.exec(String(name || '').trim());
  return m ? { base: m[1], n: Number(m[2]) } : { base: String(name || '').trim(), n: 1 };
}
function versionOf(base, name) {
  const b = base.trim().toLowerCase(); const nm = String(name).trim();
  if (nm.toLowerCase() === b) return 1;
  const m = VER_RE.exec(nm);
  return (m && m[1].trim().toLowerCase() === b) ? Number(m[2]) : null;
}
// All templates in a family, ascending by version, each tagged with its rejected flag.
export function familyTemplates(userId, base) {
  const rejected = rejectedVersionNames(userId);
  return listTemplates(userId)
    .map((tpl) => ({ tpl, n: versionOf(base, tpl.name) }))
    .filter((x) => x.n != null)
    .map((x) => ({ ...x, rejected: rejected.has(x.tpl.name.toLowerCase()) }))
    .sort((a, b) => a.n - b.n);
}
// The version "batch new <base>" snapshots: the highest NON-rejected version (or null if all rejected/none).
export function latestFamilyTemplate(userId, base) {
  const active = familyTemplates(userId, base).filter((x) => !x.rejected);
  return active.length ? active[active.length - 1].tpl : null;
}
// The name "batch save" mints next: max over ALL versions (incl. rejected — those rows still exist) + 1.
export function nextVersionName(userId, base) {
  const fam = familyTemplates(userId, base);
  const max = fam.length ? fam[fam.length - 1].n : 0;
  return `${base} #${max + 1}`;
}

// Resolve the template a "batch new <text>" should snapshot. Explicit "base #N" opens that exact version
// (even if rejected — an explicit ask wins); a "#N" that doesn't exist errors naming the latest rather than
// silently substituting. Bare "<base>" picks the latest NON-rejected family version. Returns
// { base, tpl } or { error }.
export function resolveNewBatchTemplate(userId, text) {
  const raw = String(text || '').trim();
  if (!raw) return { error: 'What process? Try: batch new sourdough   (named after one of your /templates)' };
  const m = VER_RE.exec(raw);
  if (m) {
    const base = m[1]; const n = Number(m[2]);
    const exact = n === 1 ? getTemplate(userId, base) : getTemplate(userId, raw);
    if (exact) return { base, tpl: exact };
    const latest = latestFamilyTemplate(userId, base);
    if (latest) return { error: `No “${raw}” — the latest “${base}” version is “${latest.name}”. Try “batch new ${base}”.` };
    // no family at all → fall through to the standard "no template" error below (base is the bare name)
    return noTemplateError(base);
  }
  const tpl = latestFamilyTemplate(userId, raw);
  if (tpl) return { base: raw, tpl };
  return noTemplateError(raw);
}
const noTemplateError = (name) => ({ error: `No template called “${name}” — a batch's directions come from a template. /templates lists yours, and “template <task N> <name>” saves one.` });

// Open a new run: snapshot the latest family version's steps RESET, take the next batch_no. Records the
// batch's `name` = the family/BASE (so history groups all runs) and `template_name` = the exact version used.
export function openBatch(userId, name, now = Date.now()) {
  const r = resolveNewBatchTemplate(userId, name);
  if (r.error) return { error: r.error };
  const steps = parseChecklist(r.tpl.steps_json).map((s) => ({ text: s.text, done: false, completed_at: null }));
  if (!steps.length) return { error: `“${r.tpl.name}” has no steps to follow — add steps to a task and re-save the template first.` };
  const batch = insertBatch({
    userId, name: r.base, templateName: r.tpl.name, checklistJson: JSON.stringify(steps), openedAt: now,
  });
  return { batch, steps, version: r.tpl.name, base: r.base };
}

// Toggle checklist item(s) by 1-based position. `done` forces a state; null flips.
// Returns { batch, items, changed:[1-based], missing:[1-based] } or null if the batch isn't theirs.
export function toggleBatchItems(userId, batchId, positions, done = null, now = Date.now()) {
  const batch = getBatchById(userId, batchId);
  if (!batch) return null;
  const items = parseChecklist(batch.checklist_json);
  const changed = []; const missing = [];
  for (const pos of positions) {
    const i = Number(pos) - 1;
    if (i < 0 || i >= items.length) { missing.push(Number(pos)); continue; }
    const next = done == null ? !items[i].done : !!done;
    items[i] = { ...items[i], done: next, completed_at: next ? now : null };
    changed.push(i + 1);
  }
  const updated = changed.length ? updateBatchChecklist(userId, batchId, JSON.stringify(items)) : batch;
  return { batch: updated, items, changed, missing };
}

export function checkAllBatchItems(userId, batchId, now = Date.now()) {
  const batch = getBatchById(userId, batchId);
  if (!batch) return null;
  const items = parseChecklist(batch.checklist_json).map((i) => (i.done ? i : { ...i, done: true, completed_at: now }));
  return { batch: updateBatchChecklist(userId, batchId, JSON.stringify(items)), items };
}

// ── Step tweaking (OPEN batches only — closed runs are historical records). Each mirrors toggleBatchItems:
// getBatchById → parseChecklist → mutate → updateBatchChecklist. `null` = not theirs; `{error}` = closed. ──
function openBatchOr(userId, batchId) {
  const batch = getBatchById(userId, batchId);
  if (!batch) return { miss: true };
  if (batch.status !== 'open') return { batch, error: `“${batch.name}” #${batch.batch_no} is closed — closed runs are history. Start a fresh run to change steps.` };
  return { batch };
}
export function addBatchStep(userId, batchId, text) {
  const g = openBatchOr(userId, batchId);
  if (g.miss) return null;
  if (g.error) return { error: g.error };
  const clean = String(text || '').trim();
  if (!clean) return { error: 'Add what? Try: batch add fold the dough' };
  const items = parseChecklist(g.batch.checklist_json);
  items.push({ text: clean, done: false, completed_at: null });
  return { batch: updateBatchChecklist(userId, batchId, JSON.stringify(items)), items, index: items.length };
}
export function removeBatchStep(userId, batchId, positions) {
  const g = openBatchOr(userId, batchId);
  if (g.miss) return null;
  if (g.error) return { error: g.error };
  const items = parseChecklist(g.batch.checklist_json);
  const drop = new Set([...new Set((positions || []).map((n) => Number(n) - 1))].filter((i) => i >= 0 && i < items.length));
  const removed = [...drop].map((i) => i + 1).sort((a, b) => a - b);
  const missing = (positions || []).map(Number).filter((p) => p < 1 || p > items.length);
  const kept = items.filter((_, i) => !drop.has(i)); // survivors re-compact (positions shift down)
  const batch = removed.length ? updateBatchChecklist(userId, batchId, JSON.stringify(kept)) : g.batch;
  return { batch, items: kept, removed, missing };
}
export function editBatchStep(userId, batchId, pos, text) {
  const g = openBatchOr(userId, batchId);
  if (g.miss) return null;
  if (g.error) return { error: g.error };
  const clean = String(text || '').trim();
  if (!clean) return { error: 'Edit it to what? Try: batch edit 2 rest 20 min' };
  const items = parseChecklist(g.batch.checklist_json);
  const i = Number(pos) - 1;
  if (i < 0 || i >= items.length) return { batch: g.batch, items, missing: [Number(pos)] };
  items[i] = { ...items[i], text: clean }; // PRESERVE done + completed_at — a reword, not a reset
  return { batch: updateBatchChecklist(userId, batchId, JSON.stringify(items)), items, pos: Number(pos) };
}

// Graduate a batch's current (tweaked) steps into a NEW auto-numbered template version. Additive — never
// overwrites the original — so no confirm. Each save mints the next number (non-idempotent by design).
export function saveBatchAsVersion(userId, batchId) {
  const g = openBatchOr(userId, batchId);
  if (g.miss) return null;
  if (g.error) return { error: g.error };
  const items = parseChecklist(g.batch.checklist_json);
  if (!items.length) return { error: 'This batch has no steps to save — add one first (“batch add <text>”).' };
  const base = familyOf(g.batch.name).base;
  const src = getTemplate(userId, g.batch.template_name) || getTemplate(userId, base); // meta carrier (may be gone)
  const meta = src
    ? { summary: src.summary, category: src.category, effort_level: src.effort_level, original_text: src.original_text, llm_summary: src.llm_summary }
    : { summary: base };
  const versionName = nextVersionName(userId, base);
  const template = createTemplateFromSteps(userId, versionName, meta, items);
  return { template, versionName, base, stepCount: items.length };
}

// ── Reject / unreject a template VERSION out of the lineage (reversible soft-flag). Resolve (base, n) → the
// exact version's template name (n=1 → the base). Returns { error } on a bad ref; { versionName, base, n,
// latest, emptied } on success, where `latest` is the new latest-active version name (null if none left). ──
function resolveVersionName(userId, base, n) {
  const b = String(base || '').trim();
  const num = Number(n);
  if (num === 1 || !Number.isInteger(num)) return getTemplate(userId, b) ? b : null;
  const name = `${b} #${num}`;
  return getTemplate(userId, name) ? name : null;
}
export function rejectVersion(userId, base, n) {
  const name = resolveVersionName(userId, base, n);
  if (!name) return { error: `No “${String(base).trim()}” version #${n} — “batch versions ${String(base).trim()}” lists them.` };
  rejectTemplateVersion(userId, name);
  const latest = latestFamilyTemplate(userId, base);
  return { versionName: name, base: familyOf(name).base, n: Number(n), latest: latest ? latest.name : null, emptied: !latest };
}
export function unrejectVersion(userId, base, n) {
  const name = resolveVersionName(userId, base, n);
  if (!name) return { error: `No “${String(base).trim()}” version #${n} — “batch versions ${String(base).trim()}” lists them.` };
  unrejectTemplateVersion(userId, name);
  const latest = latestFamilyTemplate(userId, base);
  return { versionName: name, base: familyOf(name).base, n: Number(n), latest: latest ? latest.name : null };
}

// Append a dated log line to a batch (open or closed — a late tasting note is still data).
export function logLine(userId, batchId, text, now = Date.now()) {
  const batch = getBatchById(userId, batchId);
  if (!batch) return null;
  const line = insertBatchLogLine(userId, batchId, text, now);
  return { batch, line };
}

export function closeBatch(userId, batchId, outcome = null, now = Date.now()) {
  const batch = getBatchById(userId, batchId);
  if (!batch) return null;
  if (batch.status !== 'open') return { batch, already: true };
  return { batch: closeBatchRow(userId, batchId, outcome ? String(outcome).trim() : null, now), already: false };
}

// Past runs of a process, newest first, with checklist progress precomputed for rendering. `name` is the
// family/base, so all runs group here regardless of which version each was opened from.
export function batchHistory(userId, name) {
  return listBatches(userId, familyOf(name).base).map((b) => {
    const items = parseChecklist(b.checklist_json);
    return { ...b, done: items.filter((i) => i.done).length, total: items.length };
  });
}

// The recipe-version lineage of a process (family), ascending, each tagged n / rejected / latest-active /
// original. `latest` marks the version "batch new <base>" would snapshot. Empty array = no such family.
export function batchVersions(userId, base) {
  const fam = familyTemplates(userId, familyOf(base).base);
  if (!fam.length) return [];
  const latestActive = [...fam].reverse().find((x) => !x.rejected);
  return fam.map((x) => ({
    name: x.tpl.name, n: x.n, rejected: x.rejected,
    original: x.n === 1, latest: !!latestActive && x.tpl.name === latestActive.tpl.name,
    steps: parseChecklist(x.tpl.steps_json).length,
  }));
}
