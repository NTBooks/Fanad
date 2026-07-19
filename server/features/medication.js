// The Medication module (opt-in): chat surface over server/medication.js. "med amlodipine" logs a dose,
// "med morning" logs a named template, "med all" completes the day, "meds" shows today's adherence. Each med
// is tracked as its own metric (kind='med') so it stays out of the generic tally but still charts via
// "chart <name>". Logging lands under the user like Diet, so WRITE commands are notebook-guarded (a med log
// belongs in your Main space, not a scratch notebook). "undo" (app-wide) takes back the last dose — there is
// no separate "med undo". SAFETY: the engine never calls an LLM; nothing here guesses a dose.
import {
  addMed, listMedsText, deleteMedText, medChartReply,
  defineTemplate, listTemplatesText, showTemplateText, deleteTemplateText, setTemplateReminderText,
  logMedToken, medAll, todayView, medReminderStep,
} from '../medication.js';
import { notebookGuardAnswer, setDialogState, clearDialogState } from '../dialog.js';
import { registerFeature, tryFeatureCommand } from './registry.js';
import { getCurrentNotebookId, clearCurrentNotebookId } from '../settings.js';
import { getNotebook, effectiveUserId } from '../repo.js';

// "med add <name> [dose]" — a dose is a trailing number+unit clause ("5mg", "1 tablet", "1000 iu"); anything
// before it (which may be multi-word, e.g. "vitamin d") is the name. No dose clause ⇒ the whole rest is the name.
const DOSE_TAIL = /^(.*?\S)\s+(\d[\d./]*\s*(?:mg|mcg|ug|µg|g|ml|units?|iu|tabs?|tablets?|pills?|caps?|capsules?|drops?|puffs?|sprays?|tsp|tbsp|cc)\b.*)$/i;
function parseMedAdd(rest) {
  const m = DOSE_TAIL.exec(rest.trim());
  return m ? { name: m[1].trim(), dose: m[2].trim() } : { name: rest.trim(), dose: null };
}

// Each run() re-checks the gate itself: an off module answers with the turn-on offer, never silence.
const gated = (fn) => (ctx, hit) => (ctx.isOn('medication') ? fn(ctx, hit) : ctx.offerOn('medication'));

// Med adherence is one lifelong record, so it lives in the MAIN space — logging from inside a notebook is
// almost always an accident (it lands where the today view / chart won't look). Every WRITE command gets this
// guard: warn, offer a one-tap switch to Main (the command re-runs there), allow "log here" on purpose, or
// cancel. Read-only commands (list/templates/show/meds) stay unguarded. Mirrors diet's nbGuard exactly.
const nbGuard = (fn) => gated((ctx, hit) => {
  const nbId = ctx.nbOk ? null : getCurrentNotebookId(ctx.identityId);
  if (nbId == null) return fn(ctx, hit);
  const nb = getNotebook(nbId);
  setDialogState(ctx.userId, { type: 'med_notebook', prompt: 'log in Main?', data: { text: ctx.t } });
  return {
    text: `⚠️ You're in 📓 ${nb?.notebook_name || 'a notebook'} — med logs live in your Main space, where the today view and charts look. Switch to Main and run that there?`,
    options: ['Switch to Main', 'Log here', 'Cancel'],
  };
});

// The med_notebook answer: switch → back to Main and re-run the saved command there; here → re-run in the
// notebook on purpose; cancel/escape → nothing logged. Re-run goes back through the registry with nbOk so it
// can't re-arm the guard. Mirrors diet's handleDietNotebook.
async function handleMedNotebook(userId, text, ds, extras = {}) {
  const ans = notebookGuardAnswer(text);
  if (!ans) return 'Reply “switch” to log it in Main, “log here” to keep it in this notebook, or “cancel”.';
  clearDialogState(userId);
  const pending = (ds.data?.text || '').trim();
  const { identityId, channel, energy, isOn, offerOn } = extras;
  if (ans === 'cancel' || !pending || identityId == null) return 'Okay — nothing logged.';
  const rerun = async (uid) => {
    const hit = await tryFeatureCommand({ userId: uid, identityId, t: pending, lower: pending.toLowerCase(), channel, energy, isOn, offerOn, nbOk: true });
    return hit ? hit.reply : 'Hmm — I couldn’t re-run that one. Try typing it again.';
  };
  if (ans === 'here') return rerun(userId);
  clearCurrentNotebookId(identityId);            // switch to Main…
  const out = await rerun(effectiveUserId(identityId)); // …and log it there
  const prefix = '📖 Switched to Main.\n';
  return typeof out === 'string' ? prefix + out : { ...out, text: prefix + (out.text || '') };
}

registerFeature({
  name: 'medication',
  commands: [
    // "med add <name> [dose]" — define/update a med + eagerly create its adherence metric.
    { match: ({ t }) => /^\/?meds?\s+add\s+(.+)$/i.exec(t),
      run: nbGuard(({ userId }, m) => { const { name, dose } = parseMedAdd(m[1]); return addMed(userId, name, dose); }) },
    // "med list" / "meds list" / "med catalog" — the catalog (read-only).
    { match: ({ t }) => /^\/?meds?\s+(?:list|catalog)$/i.exec(t),
      run: gated(({ userId }) => listMedsText(userId)) },
    { match: ({ t }) => /^\/?meds?\s+(?:del|delete|rm|remove)\s+(.+)$/i.exec(t),
      run: nbGuard(({ userId }, m) => deleteMedText(userId, m[1].trim())) },
    // "med chart <name> [range]" — per-med adherence chart (read-only; works without the Metrics module).
    { match: ({ t }) => /^\/?meds?\s+chart\s+(.+)$/i.exec(t),
      run: gated(({ userId }, m) => medChartReply(userId, m[1].trim())) },
    // Templates — the compact "= <meds>" define MUST beat the generic "med template <name>" (show) below.
    { match: ({ t }) => /^\/?meds?\s+template\s+([^=]+?)\s*=\s*(.+)$/i.exec(t),
      run: nbGuard(({ userId }, m) => { clearDialogState(userId); return defineTemplate(userId, m[1].trim(), m[2].trim()); }) },
    // "med template <name> remind <time|off>" — set/clear the daily reminder directly (bypass the dialog).
    { match: ({ t }) => /^\/?meds?\s+template\s+(.+?)\s+remind(?:er)?\s+(.+)$/i.exec(t),
      run: nbGuard(({ userId }, m) => setTemplateReminderText(userId, m[1].trim(), m[2].trim())) },
    { match: ({ t }) => /^\/?meds?\s+template\s+(?:del|delete|rm|remove)\s+(.+)$/i.exec(t),
      run: nbGuard(({ userId }, m) => deleteTemplateText(userId, m[1].trim())) },
    // "med templates" / bare "med template" — list.
    { match: ({ t }) => /^\/?meds?\s+templates?$/i.exec(t),
      run: gated(({ userId }) => listTemplatesText(userId)) },
    { match: ({ t }) => /^\/?meds?\s+template\s+(.+)$/i.exec(t),
      run: gated(({ userId }, m) => showTemplateText(userId, m[1].trim())) },
    // "med all" — complete the day's scheduled meds.
    { match: ({ t }) => /^\/?meds?\s+all$/i.exec(t),
      run: nbGuard(({ userId }) => medAll(userId)) },
    // Bare "meds" / "/meds" — today's adherence view (read-only).
    { match: ({ lower }) => lower === 'meds' || lower === '/meds',
      run: gated(({ userId }) => todayView(userId)) },
    // Generic "med <token>" — a template name logs the whole template, else log a single med (auto-created on
    // first use). The negative lookahead keeps reserved sub-verbs (typed without args) from being logged as a
    // med named "add"/"template"/… — they fall through to normal handling instead.
    { match: ({ t }) => /^\/?meds?\s+(?!add\b|list\b|catalog\b|chart\b|del\b|delete\b|rm\b|remove\b|template\b|templates\b|all\b)(.+)$/i.exec(t),
      run: nbGuard(({ userId }, m) => logMedToken(userId, m[1].trim())) },
  ],
  dialogHandlers: {
    med_reminder: medReminderStep,
    med_notebook: handleMedNotebook,
  },
});
