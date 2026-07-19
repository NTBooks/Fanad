// Generalized "Fanad has an open question" state — the thing that makes a STATEMENT answer the
// question instead of becoming a task (the "no" fix). Generalizes the old pending-meal machine.
// Stored in app_settings (global for the single-user pilot; keyed by userId in the signatures so
// Phase-8 multi-user is a one-line change). Handlers live in chat.js (they need suggestTask/repo/metrics).
import { getSetting, setSetting } from './settings.js';
import { classifyIntent } from './services/llm/classify-intent.js';
import { CATEGORIES, EFFORT_LEVELS, closestCategory } from '../shared/categories.js';
import { isGuideCommand } from '../shared/copy.js';

const keyFor = (userId) => `dialog_state:${userId}`; // per-user, so two people never share a dialog
export const DIALOG_TTL_MS = 30 * 60 * 1000; // abandon a forgotten open question after 30 min

export function setDialogState(userId, st) { setSetting(keyFor(userId), { ...st, createdAt: st.createdAt ?? Date.now() }); }
export function getDialogState(userId) { return getSetting(keyFor(userId), null); }
export function clearDialogState(userId) { setSetting(keyFor(userId), null); }
export function dialogIsStale(ds, now = Date.now()) { return !ds || (now - (ds.createdAt || 0)) > DIALOG_TTL_MS; }

// ── "show this unsolicited nudge at most once a day" gate, per user. A reminder (e.g. the module-detection nudge)
// shouldn't repeat on every action — markDailyShown stamps when it last surfaced; dailyShownRecently reports
// whether that was within the last 24h. A rolling window (not a calendar day) keeps it timezone-free. Stored
// in app_settings, same store as the dialog state; `name` gives each nudge its own slot.
const DAY_MS = 24 * 60 * 60 * 1000;
const dailyGateKeyFor = (userId, name) => `daily_gate:${name}:${userId}`;
export function dailyShownRecently(userId, name, now = Date.now()) {
  return now - (getSetting(dailyGateKeyFor(userId, name), 0) || 0) < DAY_MS;
}
export function markDailyShown(userId, name, now = Date.now()) { setSetting(dailyGateKeyFor(userId, name), now); }

// ── "what I last showed you" → act on items by position (1..N), not by DB id ──
// When Fanad lists tasks/notes it renumbers them 1..N for THAT listing and remembers the order here,
// so "/done 2" means "the 2nd thing on the list in front of you" and the user never sees (or memorizes)
// a growing database id. Survives dialog clears (separate key); the next listing overwrites it.
const listingKeyFor = (userId) => `last_listing:${userId}`;

export function setListing(userId, kind, ids) {
  const all = getSetting(listingKeyFor(userId), {}) || {};
  all[kind] = ids;
  setSetting(listingKeyFor(userId), all);
}

// Pagination cursor for the task list, kept SEPARATE from the ids record above so "/done N" and the
// 'note' listing are untouched. Holds where we are and how to re-derive the next page: { offset, total,
// filter, label }. Overwritten by every task listing; the ids of the VISIBLE slice still live in setListing.
const pageKeyFor = (userId) => `last_page:${userId}`;
export function setPageState(userId, st) { setSetting(pageKeyFor(userId), st); }
export function getPageState(userId) { return getSetting(pageKeyFor(userId), null); }

// ── Lists cursor — "which list (tree node) am I inside, and on what page" ──
// The lists feature (chat.js) is a navigable outliner; this is the pointer it walks. Kept SEPARATE from the
// dialog state so a list-navigation slash command (/sub_N, /list …) — which escapes any open question — can
// still read WHERE we are after the dialog clears. `{ nodeId, page }`; nodeId === null means "the top-level
// lists". Set alongside the `list_nav` dialog on every list view, cleared when the user leaves list mode.
const listCursorKeyFor = (userId) => `list_cursor:${userId}`;
export function getListCursor(userId) { return getSetting(listCursorKeyFor(userId), null); }
export function setListCursor(userId, cur) { setSetting(listCursorKeyFor(userId), cur); }
export function clearListCursor(userId) { setSetting(listCursorKeyFor(userId), null); }

// Map the 1-based positions the user typed back to the ids we last listed for `kind`.
// → { pairs: [{pos,id}], missing: [positions with no item], total: how many were on that list }.
export function resolveListing(userId, kind, positions) {
  const ids = (getSetting(listingKeyFor(userId), {}) || {})[kind] || [];
  const pairs = []; const missing = [];
  for (const p of positions) {
    const id = ids[p - 1];
    if (id == null) missing.push(p); else pairs.push({ pos: p, id });
  }
  return { pairs, missing, total: ids.length };
}

// ── Category/difficulty LOCK (§ bulk add) ──
// Pin a category and/or effort so a run of quick adds all land there without the LLM guessing each one.
// Persists (until /unlock) per-user in app_settings, same store as the dialog state.
const lockKeyFor = (userId) => `task_lock:${userId}`;
export function getTaskLock(userId) { return getSetting(lockKeyFor(userId), null); }
export function setTaskLock(userId, lock) { setSetting(lockKeyFor(userId), lock); }
export function clearTaskLock(userId) { setSetting(lockKeyFor(userId), null); }

// Effort words (a superset of the canonical levels) → a canonical effort level. Checked before category,
// so "/lock high" pins difficulty rather than being edit-distanced onto a category.
const EFFORT_WORD = {
  trivial: 'trivial', tiny: 'trivial', quickest: 'trivial',
  low: 'low', easy: 'low', small: 'low', quick: 'low', light: 'low',
  medium: 'medium', med: 'medium', moderate: 'medium', normal: 'medium',
  high: 'high', hard: 'high', big: 'high', heavy: 'high', tough: 'high',
};
// Parse "/lock work", "/lock high", "/lock work high" → { category?, effort? } or null when nothing matched.
export function parseLockTarget(text) {
  const out = {};
  for (const tok of String(text || '').toLowerCase().split(/[\s,]+/).filter(Boolean)) {
    if (EFFORT_WORD[tok]) { out.effort = EFFORT_WORD[tok]; continue; }
    const cat = closestCategory(tok);
    if (cat) out.category = cat;
  }
  return out.category || out.effort ? out : null;
}

// ── Answer parsers (offline-safe, no LLM). Each returns a recognized answer or null. ──
// The food_confirm answer (diet.js): confirm/correct a guessed calorie DENSITY. A plain number is cal per
// unit — that's what the user looks up on the package — and "N total" (word required) is the whole
// portion's calories, which the engine divides back into a density before saving.
export function foodConfirmAnswer(text) {
  const s = (text || '').trim();
  const low = s.toLowerCase();
  // "save" is a yes-word — but "save meal …" is a COMMAND (features/diet.js), so it must escape a pending
  // confirm as a new intent instead of reading as "yes" to whatever was being asked.
  if (/^(y|yes|yep|yeah|ok|okay|sure|log|log it|confirm|save(?!\s+meal\b)|do it)\b/.test(low)) return { type: 'yes' };
  if (/^(n|no|nope|cancel|nvm|never ?mind|skip)\b/.test(low)) return { type: 'no' };
  let m = /^(?:total\s+)?(\d+(?:\.\d+)?)\s*(?:cal(?:ories)?|kcal)?\s+total$|^total\s+(\d+(?:\.\d+)?)\s*(?:cal(?:ories)?|kcal)?$/i.exec(s);
  if (m) return { type: 'total', v: Number(m[1] ?? m[2]) };
  m = /^(\d+(?:\.\d+)?)\s*(?:cal(?:ories)?|kcal)?\s*(?:\/|per\s+)?\s*(?:oz|ounce|g|gram|piece|each)?$/i.exec(s);
  if (m) return { type: 'calper', v: Number(m[1]) };
  return null;
}

// The eat_qty answer (diet.js "How much …?"): an amount, optionally with a unit — "4", "4 oz", "120 g",
// "half a pound", "2 lbs" — or a decline.
export function qtyAnswer(text) {
  const s = (text || '').trim();
  const low = s.toLowerCase();
  if (/^(n|no|nope|cancel|nvm|never ?mind|skip|none)\b/.test(low)) return { type: 'no' };
  const UNIT = { oz: 'oz', ounce: 'oz', ounces: 'oz', g: 'g', gram: 'g', grams: 'g', lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb', piece: 'piece', pieces: 'piece' };
  let m = /^(\d+(?:\.\d+)?)\s*(oz|ounces?|grams?|g|lbs?|pounds?|pieces?)?$/i.exec(s);
  if (m) return { qty: Number(m[1]), unit: m[2] ? UNIT[m[2].toLowerCase()] : null };
  m = /^half\s+an?\s+(pound|lb)$/i.exec(low);
  if (m) return { qty: 0.5, unit: 'lb' };
  return null;
}

export function reactionAnswer(text) {
  const s = (text || '').trim().toLowerCase();
  if (/\b(smaller|something smaller|easier|simpler|too big|too much|less)\b/.test(s)) return 'smaller';
  // "done for now / that's it / stop" ENDS the session...
  if (/^(done for now|that'?s (it|enough|all)|i'?m done|stop|nothing( else)?|no more|all set)\b/.test(s)) return 'stop';
  // ...but "done / did it / finished" means I COMPLETED the suggested task.
  if (/^(done|did it|did that|finished|complete[d]?|got it done|all done|✅|✓)\b/.test(s)) return 'complete';
  if (/^(not today|later|tomorrow|another (time|day)|maybe later|not right now)\b/.test(s)) return 'snooze';
  if (/^(y|yes|yep|yeah|yup|ok|okay|sure|sounds good|let'?s go|lets go|go|do it|start|begin|alright)\b/.test(s)) return 'affirm';
  if (/^(n|no|nope|nah|not (that|now|it)|pass|skip)\b/.test(s)) return 'refuse';
  return null;
}

export function groomingAnswer(text) {
  const s = (text || '').trim().toLowerCase();
  if (/\b(refine|reword|rephrase|clearer|change the wording)\b/.test(s)) return 'refine';
  if (/\b(decompose|break (it )?(down|up)|smaller steps|split|steps)\b/.test(s)) return 'decompose';
  if (/^(snooze|not today|later|tomorrow|next week)\b/.test(s)) return 'snooze';
  if (/\b(archive|drop|delete|remove|forget it)\b/.test(s)) return 'archive';
  if (/^(keep|leave it|no|nothing|it'?s fine|as is)\b/.test(s)) return 'keep';
  return null;
}

// "which tasks?" answer → a filter by category or effort. STRICT: the whole reply must be a single
// category/difficulty word (or synonym), so "suggest a task" isn't misread as the "task" category.
export function taskFilterAnswer(text) {
  const s = (text || '').trim().toLowerCase();
  if (!s) return null;
  if (/^(all|everything|both|any)$/.test(s)) return { all: true };
  if (/^(today|due today|due)$/.test(s)) return { today: true };
  if (/^(trivial|tiny|quickest|easiest)$/.test(s)) return { effort: 'trivial' };
  if (/^(quick|easy|small|low|light)$/.test(s)) return { effort: 'low' };
  if (/^(medium|moderate|normal)$/.test(s)) return { effort: 'medium' };
  if (/^(hard|hardest|big|biggest|high|heavy|tough)$/.test(s)) return { effort: 'high' };
  if (EFFORT_LEVELS.includes(s)) return { effort: s };
  if (/^errands?$/.test(s)) return { category: 'errand' };
  if (/^(home|house|chores?|household)$/.test(s)) return { category: 'household' };
  if (/^(fun|entertainment|games?|recreation|hobby|hobbies)$/.test(s)) return { category: 'recreation' };
  if (/^(self[\s-]?care|wellbeing|well-being|rest)$/.test(s)) return { category: 'selfcare' };
  if (/^(learn(ing)?|study|enrichment|courses?)$/.test(s)) return { category: 'enrichment' };
  if (/^(social|friends?|family)$/.test(s)) return { category: 'social' };
  if (/^(admin|paperwork)$/.test(s)) return { category: 'admin' };
  if (/^(projects?|build)$/.test(s)) return { category: 'task' };
  for (const c of CATEGORIES) { if (s === c || s === `${c}s`) return { category: c }; }
  return null;
}

// Answer to "Did you mean <task>?" — start it / mark it done / it's a new one.
export function referenceAnswer(text) {
  const s = (text || '').trim().toLowerCase();
  if (/^(start|start it|begin|yes|yep|yeah|do it|let'?s|that one|first)\b/.test(s)) return 'start';
  if (/^(done|did it|finished|complete|mark .*done|already did)\b/.test(s)) return 'done';
  if (/^(no|new|it'?s new|nope|different|fresh|neither)\b/.test(s)) return 'new';
  return null;
}

// Confirm/cancel for the irreversible /requestdeletion. STRICT on purpose: only a message that is
// essentially just "delete" / "erase" / "confirm" (optionally "yes, delete everything") confirms — a bare
// "yes"/"ok" deliberately does NOT, so a casual reply can never erase an account by accident. Explicit
// cancel words cancel; anything else returns null and the caller treats it as a (safe) cancel-by-escape.
export function deleteConfirmAnswer(text) {
  const s = (text || '').trim().toLowerCase().replace(/[.!]+$/, '');
  if (/^(?:yes,?\s*)?(?:delete|erase|wipe)(?:\s+(?:it|all|everything|my data|my account))?$/.test(s)) return 'confirm';
  if (/^confirm(?:\s+deletion?)?$/.test(s)) return 'confirm';
  if (/^(cancel|no|nope|nah|stop|nvm|never ?mind|keep(?: it)?|abort|wait)$/.test(s)) return 'cancel';
  return null;
}

// Diet's "you're in a notebook" guard: the log belongs in Main. "switch" (or a plain yes) moves to Main
// and re-runs the command there; "log here" keeps it in the notebook on purpose; explicit no/cancel drops
// it. Anything else escapes as a new intent (no trap) — nothing gets logged.
export function notebookGuardAnswer(text) {
  const s = (text || '').trim().toLowerCase();
  if (/^(y|yes|yep|yeah|ok|okay|sure|switch(\s+to\s+main)?|main|go(\s+to)?\s+main)\b/.test(s)) return 'switch';
  if (/^(here|log\s+(it\s+)?here|keep\s+(it\s+)?here|stay|this\s+notebook)\b/.test(s)) return 'here';
  if (/^(n|no|nope|cancel|nvm|never ?mind|skip)\b/.test(s)) return 'cancel';
  return null;
}

// Sentiment after a completion (quiet, optional). Button labels map to a learning signal.
export function feedbackAnswer(text) {
  const s = (text || '').trim().toLowerCase();
  if (/high\s?five|🙌|✋|yay|woo+|nice|awesome|great|love it|proud/.test(s)) return 'highfive';
  if (/glad.*(over|done|behind)|finally|ugh|relief|relieved|phew|good riddance|thank ?(god|goodness)|😮‍💨|😅|😤/.test(s)) return 'relief';
  if (/^(ok|okay|k|meh|fine|alright|sure|cool|👍|🆗)\b/.test(s)) return 'neutral';
  return null;
}

// The med_reminder answer (medication.js "want a daily reminder?"): a clock time sets it ("8am", "8:30",
// "20:00"), a decline skips it ("no", "skip", "off"), a bare yes re-prompts for the time. Anything else
// returns null and escapes as a new intent — the reminder is optional, so a fresh command never gets trapped.
export function medReminderAnswer(text) {
  const s = (text || '').trim().toLowerCase().replace(/[.!]+$/, '');
  if (!s) return null;
  if (/^(no|nope|nah|n|none|skip|off|later|no thanks?|no reminder)$/.test(s)) return { type: 'no' };
  const m = /^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?m?\.?)?$/i.exec(s);
  if (m) {
    let h = Number(m[1]); const min = Number(m[2] || 0); const ap = m[3];
    if (ap === 'p' && h < 12) h += 12;
    if (ap === 'a' && h === 12) h = 0;
    if (h <= 23 && min <= 59) return { type: 'time', minute: h * 60 + min };
  }
  if (/^(y|yes|yep|yeah|sure|ok|okay|please)$/.test(s)) return { type: 'yes' };
  return null;
}

const FAST_ANSWER = {
  food_confirm: (t) => foodConfirmAnswer(t) != null,
  meal_confirm: (t) => foodConfirmAnswer(t) != null, // save-meal's total confirm reuses the same grammar
  eat_meal_confirm: (t) => foodConfirmAnswer(t) != null, // the ad-hoc plate's total confirm — same grammar
  eat_qty: (t) => qtyAnswer(t) != null,
  suggestion_reaction: (t) => reactionAnswer(t) != null,
  grooming_choice: (t) => groomingAnswer(t) != null,
  task_filter: (t) => taskFilterAnswer(t) != null,
  done_feedback: (t) => feedbackAnswer(t) != null,
  task_reference: (t) => referenceAnswer(t) != null,
  delete_confirm: (t) => deleteConfirmAnswer(t) != null,
  journal_delete: (t) => deleteConfirmAnswer(t) != null, // journal erase reuses the strict delete grammar
  batch_delete: (t) => deleteConfirmAnswer(t) != null,   // batches erase reuses it too
  diet_notebook: (t) => notebookGuardAnswer(t) != null,  // diet's switch-to-Main guard
  med_reminder: (t) => medReminderAnswer(t) != null,     // medication's "want a daily reminder?"
  med_notebook: (t) => notebookGuardAnswer(t) != null,   // medication's switch-to-Main guard
};

const CONF_NEW_INTENT = 0.8;

// The organizing rule applied to an OPEN QUESTION: is this message the ANSWER, or a NEW intent?
// A recognized answer → 'answer'. An explicit command or a clear question → 'new_intent'. A clearly
// fresh task statement → 'new_intent' (so a real new task mid-suggestion still gets captured).
// Default → 'answer' (a statement answers Fanad's open question).
export async function answersPendingState(ds, text) {
  const t = (text || '').trim();
  if (t.startsWith('/')) return 'new_intent';
  // Help/guide/rules/howto are navigation, never an answer — let the EXACT command forms (slashless "guide",
  // "help", "guide steps", …) escape, so an open question can't swallow them. Task-shaped phrases that just
  // contain those words ("help me move the couch", "travel guide") are NOT matched, so capture is unchanged.
  if (isGuideCommand(t)) return 'new_intent';
  // Working through a task's steps: only step-ish words act on them; everything else (a new task, a
  // question, "/tasks") escapes and drops the session — the steps stay saved. (The "/…" guard above already
  // escaped, so "/done N" completes TASK N, not a step.)
  if (ds.type === 'stepping') {
    return /^(done|did|finish(ed)?|complete[d]?|tick|check|all done|all|steps?|substeps?|subtasks?|unsteps?|delsteps?|(?:remove|delete|drop|del|rm)\s+steps?|stop|pause|cancel|exit|leave|nvm|never ?mind)\b/i.test(t)
      ? 'answer' : 'new_intent';
  }
  // Inside a list (the navigable outliner): the user is actively curating, so almost everything is an answer —
  // a navigation word (out/top/next/del N/…) or, by default, a new item to add to the open list. Only a slash
  // command or a guide command escapes (both already returned 'new_intent' above), plus the bare "lists"/"tasks"/
  // "notes"/menu words, which chat.js intercepts BEFORE this dialog check. So here, everything else is an answer.
  if (ds.type === 'list_nav') return 'answer';
  // Building a recipe: the user is dictating ingredients, so every non-slash / non-guide line is an answer
  // (an ingredient, "cooked 28 oz", "done", "cancel") — same total-capture rule as list_nav.
  if (ds.type === 'recipe_build') return 'answer';
  // "📝 Add note" on a journal entry: the user was ASKED for free text, so everything short of a slash /
  // guide command (both escaped above) IS the note — same total-capture rule as list_nav.
  if (ds.type === 'journal_note') return 'answer';
  // "📓 Add log line" / "how did it turn out?" / "➕ Add step" on a batch: also ASKED-for free text — same
  // total-capture rule (batch_done's handler has its own "skip" escape hatch).
  if (ds.type === 'batch_log' || ds.type === 'batch_done' || ds.type === 'batch_add_step') return 'answer';
  // Optional confirmations (feedback buttons, "did you mean…", the delete confirm): a recognized reply
  // counts, anything else just moves on (no trap) so the user is never stuck. For delete_confirm this is
  // the SAFE behavior — only an explicit confirm/cancel reaches the handler; any other message escapes and
  // is processed normally, so an ambiguous reply can never trigger the erase. Diet's questions
  // (food_confirm's guess, meal_confirm's total, eat_qty's "how much?") belong here too: their grammars
  // already cover every real answer (yes/no/a bare number/an amount), so a fresh bare command mid-question —
  // "eat skyr 140cal", "foods" — escapes and runs instead of being re-prompted at (the slash test above only
  // frees "/eat").
  if (ds.type === 'done_feedback' || ds.type === 'task_reference' || ds.type === 'delete_confirm' || ds.type === 'journal_delete'
    || ds.type === 'batch_delete'
    || ds.type === 'food_confirm' || ds.type === 'meal_confirm' || ds.type === 'eat_meal_confirm'
    || ds.type === 'eat_qty' || ds.type === 'diet_notebook'
    || ds.type === 'med_reminder' || ds.type === 'med_notebook') {
    return FAST_ANSWER[ds.type](t) ? 'answer' : 'new_intent';
  }
  if (FAST_ANSWER[ds.type]?.(t)) return 'answer';
  const { kind, confidence } = await classifyIntent(t);
  // A question is always a new command, never an answer to Fanad's question (the organizing rule).
  if (kind === 'question') return 'new_intent';
  // A clearly-fresh, multi-word task statement also abandons the open question and gets captured.
  if (confidence >= CONF_NEW_INTENT && t.split(/\s+/).length > 3) return 'new_intent';
  return 'answer';
}
