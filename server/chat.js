// The single text-in / text-out brain shared by the web chat AND Telegram. The organizing rule:
//   ASK A QUESTION → run a command.  MAKE A STATEMENT → file a task, OR answer Fanad's open question.
// Replies are usually plain text; a handler may return { text, image, mode, options } for charts + the
// mode affordances (§ Workstream 6). Stats are deterministic (not LLM). §5/§6/§11.
import { ingest, recordSnapshot, composeTaskFields } from './ingest.js';
import { suggestTask, embedTask, recallNotes, llmRefine, llmDecompose, phaseOf, effortFit, recency, contextScore, dueBoost } from './rag/index.js';
import { summarize } from './summary.js';
import { classifyIntent } from './services/llm/classify-intent.js';
import { dueLabel, whenLabel, presetDue, presetRemind, isDueToday } from './services/llm/deadline.js';
import { isSuggestRequest } from '../shared/intent.js';
import { closestCategory, CATEGORIES, CATEGORY_LABELS, CATEGORY_ORDER } from '../shared/categories.js';
import { priorityMark, priorityLabel } from '../shared/priority.js';
import { ARGLESS_COMMANDS, SHORTCUT_WITH_TEXT, SHORTCUT_BARE, COMMAND_FEATURES } from '../shared/commands.js';
import {
  ROOT_USER_ID,
  defaultUserId, listTasks, setTaskStatus as repoSetTaskStatus, setTaskPriority, setTaskCategory, setTaskSchedule, setTaskReminder, getTask, listNotes, getNote, reviewNote, insertTask, deleteNote,
  latestMood, resolveSuggestion, incrementRefusal, resetRefusal, setSnoozed, setGroomed, updateTaskSummary,
  sweepSnoozed, expireDueTasks, insertSchedule, listSchedules, deleteSchedule, insertTaskOutcome, updateOutcomeSentiment,
  insertMessage, setMessageReaction, getImage, getImageForTask, getImageForNote, setImageTask, setSnapshotMood,
  taskIdsWithImages, reassignTaskCategory, listSleptTasks, countSleptTasks, wakeTasks, listSnoozedTasks,
  parseSteps, parseLink, addTaskStep, setStepsDone, removeTaskStep,
  saveTemplate, getTemplate, listTemplates, deleteTemplate, materializeTemplate,
  deleteAllUserData,
  getUser, isOwner, isVouched, getActiveVouch, addVouch, listVouchesBy, normUsername,
  vouchDepthOf, countActiveVouches, hasSpeedDial, isSpeedDialOnly, speedDialWelcomed, markSpeedDialWelcomed,
  getListItem, listChildren, countListChildren, insertListItem, renameListItem, deleteListItem, listItemPath,
  effectiveUserId, accountIdFor, createNotebook, getNotebook, getNotebookByName, listNotebooks, renameNotebook,
  retireNotebook, recoverNotebook, listRetiredNotebooks,
} from './repo.js';
import { timeOfDay, extractEmojis, extractMood } from '../shared/state.js';
import { decideReaction } from '../shared/reaction.js';
import { currentWeather } from './weather.js';
// Opt-in feature modules (timer, metrics — see server/features/): imported for their registration side
// effect; route()/DIALOG_HANDLERS/handleAction consult the registry at fixed points below.
import './features/index.js';
import { tryFeatureCommand, featureDialogHandlers, featureMenuAction } from './features/registry.js';
import { speedDialGate, padView, fireSlot, welcomePad } from './speeddial.js';
import { getRetentionConfig, getTelegramConfig, getSiteConfig, getAuthConfig, getUserFeatures, setUserFeatures, OPTIN_FEATURES, getCurrentNotebookId, setCurrentNotebookId, clearCurrentNotebookId, getGuardConfig, setGuardConfig, isSystemModuleOn, getSystemModules, setSystemModules, getHomeAssistantConfig } from './settings.js';
import { markConfigDirty } from './clientConfig.js';
import { authModeIsSimple, createWebLinkToken, WEB_LINK_TTL_MS, mintCliToken, CLI_TOKEN_DEFAULT_TTL_DAYS } from './auth.js';
import { runAsLlmUser } from './services/llm/context.js';
import { notifyOwner } from './notifyOwner.js';
import { config } from './config.js';
import { archiveUserData } from './retention.js';
import {
  getDialogState, setDialogState, clearDialogState, dialogIsStale, answersPendingState,
  reactionAnswer, groomingAnswer, taskFilterAnswer, feedbackAnswer, referenceAnswer,
  deleteConfirmAnswer, haTokenConfirmAnswer,
  setListing, resolveListing, setPageState, getPageState,
  getListCursor, setListCursor, clearListCursor,
  getTaskLock, setTaskLock, clearTaskLock, parseLockTarget,
  dailyShownRecently, markDailyShown,
} from './dialog.js';
import {
  decodeToken, MENU_LABELS,
  taskActionMenu, taskMoreMenu, priorityMenu, scheduleMenu, reminderMenu, categoryMenu, stepsEmptyMenu,
  listPageKeyboard, listNavKeyboard, stepsKeyboard, startedMenu, justFiledMenu, hubMenu, hubGroupMenu,
  taskFilterKeyboard, guideMenu, GUIDE_BACK, commandHubMenu, COMMAND_BACK, CLOSE_BTN,
} from './menu.js';
import { dossier, rebuildDossier } from './dossier.js';
import { undoCommand, recordUndo } from './undo.js';
import { addCustomCategory, removeCategory } from './categories.js';
import { RULES, HOWTO, guideFor, guideKey, GUIDE_TOPICS, HELP_RE, COMMANDS_INTRO, COMMAND_SECTIONS, liveSections, DELETION_CHANNEL_REMINDER } from '../shared/copy.js';
import { icsForTask, taskEventTime } from './calendar.js';
import { html, title, b, dim, em, esc, raw, code, a } from '../shared/richtext.js';

// ── Feature modules (PER-USER opt-in). Tasks are the core engine — ALWAYS on. Notes / Lists / Metrics are
// OFF until the user turns them on ("optin lists"), so a new account sees only Tasks. Vouch is OFF too, but
// auto-on for the deployment owner so headless onboarding stays zero-step (claim the bot → vouch right away).
// makeIsOn(userId) reads the per-user blob (+ the owner rule) ONCE per turn and returns the gate that
// route()/handleAction() pass down — the single place the brain asks "is this surface on for THIS user?".
function makeIsOn(userId) {
  const f = getUserFeatures(userId);
  const owner = isOwner(userId);
  return (name) => {
    if (name === 'tasks') return true;
    // System-wide gate: a module the owner has disabled for the whole deployment is off for every non-owner,
    // whatever their opt-in. The owner keeps access (preview/test a "dark" module before releasing it).
    if (!owner && !isSystemModuleOn(name)) return false;
    // Vouch is owner-auto-on, else per-user opt-in — BUT a speed-dial-limited (locked-down) account never gets
    // it: their whole surface is the 0-9 pad, and vouching lets anyone grow the access whitelist, so a locked
    // account could vouch in a NOT-limited alt and slip its own lockdown. Denying vouch here (the single gate)
    // keeps that shut on every surface, not just the route()/handleAction() short-circuits. Owner is exempt.
    if (name === 'vouch') return owner || (f.vouch && !isSpeedDialOnly(userId));
    return !!f[name]; // notes · lists · metrics — default off
  };
}
// Exposed so the Slack adapter (which handles its own platform-keyed vouch) shares the exact same gate.
export function isFeatureOnFor(userId, name) { return makeIsOn(userId)(name); }

// ── Module on/off plumbing: labels, the confirmations after a toggle, and the gentle "it's off — turn it on?"
// offer shown when someone reaches a module that's off for them. The offer carries a one-tap turn-on button
// (m:optin:<module>) and a "Not now" that just dismisses it — discoverable without re-cluttering the surface.
const OPTIN_MODULES = OPTIN_FEATURES; // notes · lists · metrics · vouch · notebook
const MODULE_LABEL = { notes: 'Notes', lists: 'Lists', metrics: 'Metrics', diet: 'Diet', vouch: 'Vouch', notebook: 'Notebooks', timer: 'Timer', journal: 'Journal', batches: 'Batches', homeassistant: 'Home Assistant', medication: 'Medication' };
const MODULE_OFF_TEXT = {
  metrics: 'Metrics are off for you — turn them on to use track / measure / tally / chart.',
  diet: 'Diet is off for you — turn it on to log what you eat by weight: “eat 4 oz chicken breast”, a canonical food list, and recipes.',
  notes: 'Notes are off for you — turn them on to jot things down and recall them later.',
  lists: 'Lists are off for you — turn them on to keep nestable lists.',
  vouch: 'Vouching is off for you — turn it on to add people by endorsement.',
  notebook: 'Notebooks are off for you — turn them on to keep separate, private spaces for tasks, notes & lists.',
  timer: 'The Timer is off for you — turn it on to get a one-shot ding (“timer 10 minutes”) when time’s up.',
  journal: 'The Journal is off for you — turn it on to keep a daily checklist + note I can read for trends over time (great for food, symptoms, even a pet).',
  batches: 'Batches are off for you — turn them on to track each run of a process (a brew, a bake, a batch of soap): directions from a template, a dated log, and an outcome per run.',
  homeassistant: 'Home Assistant is off for you — turn it on to ring the house when a timer or reminder fires, talk to HA with “ha <command>”, and push dated tasks onto the house calendar.',
  medication: 'Medication is off for you — turn it on to log when you take your meds (“med amlodipine”), group them into daily templates (“med template morning = …”), and track adherence. A logger, not medical advice.',
};
const MODULE_ON_MSG = {
  notes: '✓ Notes on. Jot with “note …”, see them with /notes, pull one back with /recall.',
  lists: '✓ Lists on. Make nestable lists with /lists and “/list <name>”.',
  metrics: '✓ Metrics on. Use track / measure / tally / chart.',
  diet: '✓ Diet on. “eat 4 oz chicken breast” logs it (I learn your foods as we go) · “foods” lists them · “recipe new chili” builds a recipe · “weight 182” tracks weight.',
  vouch: '✓ Vouch on. Add someone with “vouch @username”.',
  notebook: '✓ Notebooks on. Open a fresh space with “notebook <name>”, list them with “notebook”, head home with “notebook main”.',
  timer: '✓ Timer on. “timer 10 minutes” sets a ding (label it: “timer 12 min pasta”); bare “timer” shows what’s running; “timer off 1” cancels.',
  journal: '✓ Journal on. “journal new food” starts one, “journal template <name>” gives it a daily checklist, “entry” opens today. “guide journal” walks you through it.',
  batches: '✓ Batches on. Save a task with steps as a template first (“template <task N> sourdough”), then “batch new sourdough” opens run #1 — “batch log <text>” keeps the diary, “batch done” closes it. “guide batches” walks you through it.',
  homeassistant: '✓ Home Assistant on. Your timer dings and reminders now ring the house · “ha <command>” talks to HA (“ha turn off the kitchen light”) · “ha test” rings the outputs · “ha” shows status.',
  medication: '✓ Medication on. “med add amlodipine 5mg” · log a dose with “med amlodipine” · group them: “med template morning = amlodipine, metformin” (I’ll offer a daily reminder) · “meds” shows today. It logs only what you type — not medical advice.',
};
const MODULE_OFF_MSG = {
  notes: '✓ Notes hidden. Your notes are kept — “optin notes” brings them back.',
  lists: '✓ Lists hidden. Your lists are kept — “optin lists” brings them back.',
  metrics: '✓ Metrics hidden. Your data is kept — “optin metrics” brings it back.',
  diet: '✓ Diet hidden. Your foods, recipes and logs are kept — “optin diet” brings them back.',
  vouch: '✓ Vouch hidden. “optin vouch” turns it back on.',
  notebook: '✓ Notebooks hidden, and you’re back in your main space. Your notebooks and their data are kept — “optin notebook” brings them back.',
  timer: '✓ Timer hidden. Anything already running will still ring — “optin timer” brings the commands back.',
  journal: '✓ Journal hidden. Your journals and their entries are kept (and I’ll still tidy summaries overnight) — “optin journal” brings them back.',
  batches: '✓ Batches hidden. Your runs and their logs are kept — “optin batches” brings them back.',
  homeassistant: '✓ Home Assistant hidden. The house stays quiet for your dings — “optin ha” brings it back.',
  medication: '✓ Medication hidden. Your meds, templates and dose history are kept, and reminders stop — “optin medication” brings it back.',
};
function offerOn(name) {
  return {
    text: MODULE_OFF_TEXT[name] || 'That module is off — say “optin <name>” to turn it on.',
    buttons: [[{ text: `Turn on ${MODULE_LABEL[name]}`, data: `m:optin:${name}` }, { text: 'Not now', data: 'm:hide:x' }]],
  };
}
function moduleKey(word) {
  const w = String(word || '').trim().toLowerCase();
  if (/^notes?$/.test(w)) return 'notes';
  if (/^lists?$/.test(w)) return 'lists';
  if (/^metrics?$/.test(w)) return 'metrics';
  if (/^(diet|foods?|nutrition|calories?|eat)$/.test(w)) return 'diet';
  if (/^vouch(?:ing)?$/.test(w)) return 'vouch';
  if (/^notebooks?$/.test(w)) return 'notebook';
  if (/^timers?$/.test(w)) return 'timer';
  if (/^(journals?|diar(?:y|ies))$/.test(w)) return 'journal';
  if (/^batch(?:es)?$/.test(w)) return 'batches';
  if (/^(ha|home[- ]?assistant|house)$/.test(w)) return 'homeassistant';
  if (/^(medication|medications|meds?|rx|pills?)$/.test(w)) return 'medication';
  return null;
}
// Turn one module on/off for a user (opt-out HIDES, never deletes — the data is preserved). Returns the
// confirmation. Shared by the "optin/optout <module>" commands and the inline m:optin / m:optout buttons.
function setModule(userId, mod, on) {
  if (!OPTIN_MODULES.includes(mod)) return null;
  // A module disabled system-wide is invisible to non-owners — they can't opt INTO it (a stale m:optin button
  // or the like). Ignore quietly; the owner keeps access, so they may still opt in to preview it.
  if (on && !isSystemModuleOn(mod) && !isOwner(userId)) return null;
  // A speed-dial pad-holder never gets raw Home Assistant — their curated pad is their whole line to the
  // house, so block a homeassistant opt-in for them (a stale offer button, etc.). The owner is exempt.
  if (on && mod === 'homeassistant' && hasSpeedDial(userId) && !isOwner(userId)) return null;
  setUserFeatures(userId, { [mod]: on });
  // Opting OUT of Notebooks returns you to your main space — otherwise you'd be stuck inside a notebook whose
  // switch commands ("notebook main") are now hidden. The notebook data itself is kept (opt-out never deletes).
  if (mod === 'notebook' && !on) clearCurrentNotebookId(userId);
  // The confirmation is one-shot — a ✕ lets the user clear it once read, instead of it sitting in the log.
  return { text: on ? MODULE_ON_MSG[mod] : MODULE_OFF_MSG[mod], buttons: [[CLOSE_BTN]] };
}
function optModuleCmd(userId, rest, on) {
  const mod = moduleKey(rest);
  // Unknown word, OR a module that's invisible to this user (disabled system-wide, non-owner) — treat both the
  // same: there's no such module to toggle, so point them at the ones they can actually use.
  if (!mod || (!isSystemModuleOn(mod) && !isOwner(userId))) return 'Which module? Try “optin lists”, “optin notes”, “optin metrics”, or “optin vouch”. (See “modules”.)';
  return setModule(userId, mod, on);
}
// The "modules" screen — each optional module with its current state and a tap to flip it. Tasks are omitted
// (always on). The owner sees Vouch as on (auto-on) even before any opt-in.
function modulesReply(userId, isOn) {
  // A module disabled system-wide is hidden from non-owners (invisible, not just off). The owner still sees
  // every module (including "dark" ones) so they can opt in to preview before releasing.
  const owner = isOwner(userId);
  const rows = OPTIN_MODULES.filter((mod) => owner || isSystemModuleOn(mod)).map((mod) => {
    const on = isOn(mod);
    return [{ text: `${on ? '🟢' : '⚪'} ${MODULE_LABEL[mod]} — ${on ? 'on' : 'off'}`, data: `m:${on ? 'optout' : 'optin'}:${mod}` }];
  });
  return { text: '🧩 Your modules — tap one to turn it on or off. Tasks are always on.', buttons: rows };
}

// ── System-wide module availability (OWNER only): release modules over time or gate them for the WHOLE
// deployment — the global layer ABOVE each person's optin/optout. A disabled module is off AND invisible for
// every non-owner (their commands fall through, it's hidden from menus/help/nudges); the owner keeps access so
// they can preview a "dark" module before releasing it. "system" shows the board; "system enable|disable <mod>"
// flips one from chat; the same board lives in Settings → Modules. Every write bumps the web config version
// (markConfigDirty) so open browsers pick it up on their next heartbeat. Reads/writes the GLOBAL system_modules
// blob (settings.js), never a per-user one.
function systemModulesReply() {
  const sys = getSystemModules();
  const rows = OPTIN_MODULES.map((mod) => {
    const on = sys[mod] === true;
    return [{ text: `${on ? '🟢' : '🚫'} ${MODULE_LABEL[mod]} — ${on ? 'enabled' : 'disabled'}`, data: `m:${on ? 'sysoff' : 'syson'}:${mod}` }];
  });
  return { text: '🛠️ System modules — tap to enable/disable a module for EVERYONE. A disabled module is hidden for all non-owners (you keep access to preview). Tasks are always on.', buttons: rows };
}
function setSystemModule(mod, on) {
  if (!OPTIN_MODULES.includes(mod)) return false;
  setSystemModules({ [mod]: on });
  markConfigDirty(); // bump the web config version so open browsers refresh their available-module list
  return true;
}
// The owner's "system …" command. "system" / "system status" show the board; "system enable|disable|on|off
// <module>" flips one. route() only sends the owner here, and only for these exact forms — "system is slow"
// still files as a task, even for the owner.
function systemCommand(arg) {
  const a = (arg || '').trim().replace(/\s+/g, ' ');
  if (!a || /^status$/i.test(a)) return systemModulesReply();
  const spec = /^(enable|disable|on|off)\s+(.+)$/i.exec(a);
  if (!spec) return systemModulesReply();
  const on = /^(enable|on)$/i.test(spec[1]);
  const mod = moduleKey(spec[2]);
  if (!mod) return `Which module? Try “system disable journal”. Modules: ${OPTIN_MODULES.join(', ')}.`;
  setSystemModule(mod, on);
  return { text: `${on ? '🟢' : '🚫'} ${MODULE_LABEL[mod]} is now ${on ? 'ENABLED' : 'DISABLED'} system-wide${on ? '.' : ' — hidden for everyone but you.'}`, buttons: [[CLOSE_BTN]] };
}

// ── Module-detection nudge: when a capture clearly belongs to an OFF module, offer a one-tap turn-on (at most
// once a day per module, via the daily-shown gate). It NEVER auto-acts — the task is filed as usual
// and the nudge only adds the offer, keeping the "suggest, never invent" invariant.
const MODULE_NUDGE_TEXT = {
  lists: 'That looked like a list — want to keep it as one? You can turn on Lists.',
  diet: 'Tracking what you eat? The Diet module logs calories by weight and learns your foods.',
  timer: 'Want an actual ding? The Timer module can ping you when time’s up.',
};
function detectModuleHint(text) {
  const t = String(text || '');
  if ((t.match(/^\s*(?:[-*•]|\d+[.)])\s+\S/gm) || []).length >= 2) return 'lists';
  if (/\b(ate|eat|eating|meal|breakfast|lunch|dinner|snack|calories?|protein|carbs?|weigh(?:ed|t)?)\b/i.test(t)) return 'diet';
  if (/\b(timers?|countdown)\b/i.test(t)) return 'timer';
  return null;
}
function maybeModuleNudge(reply, { userId, isOn, text }) {
  const mod = detectModuleHint(text);
  if (!mod || isOn(mod) || !MODULE_NUDGE_TEXT[mod]) return reply;
  // Don't nudge toward a module that's disabled system-wide (invisible to non-owners) — tapping it would be
  // futile. The owner keeps access, so they still get the nudge for a "dark" module they haven't opted into.
  if (!isSystemModuleOn(mod) && !isOwner(userId)) return reply;
  const slot = `module_nudge:${mod}`;
  if (dailyShownRecently(userId, slot)) return reply;
  markDailyShown(userId, slot);
  reply.text = `${reply.text}\n\n${MODULE_NUDGE_TEXT[mod]}`;
  reply.buttons = [...(reply.buttons || []), [{ text: `Turn on ${MODULE_LABEL[mod]}`, data: `m:optin:${mod}` }]];
  return reply;
}

// ── "Meant to log food?" hint — the mirror of maybeModuleNudge for when Diet is already ON. The command
// grammar (a statement files a task) collides with the now-universal ChatGPT reflex of typing a food-diary
// paragraph ("here's everything I ate today…"), which otherwise lands as a mis-titled task. When a captured
// statement clearly READS like a food log, we still file the task but append a one-line teach of `eat`. Zero
// token (pure regex, no LLM), once a day, text-only — it never auto-acts on the food.
// Deliberately STRICTER than detectModuleHint's diet branch: that loose match is fine to offer an OFF module,
// but this fires while Diet is ON, so a false positive ("cook dinner for mom", "I had a rough day") is pure
// nag. Precision is favoured hard — fire only on a direct calorie ask, or a first-person "I ate/had…" clause
// that ALSO carries a food/meal word; a bare food noun ("buy milk") never trips it. (An "eat …" message is a
// diet command and never reaches capture, so it's out of scope here.)
const CALORIE_ASK_RE = /\bhow many calories\b|\bcount(?:ing)? (?:my |the )?calories\b|\btotal calories\b|\bcalorie count\b|\bcalories (?:did i|i ate|i had|today)\b/i;
const FIRST_PERSON_EAT_RE = /\bi(?:['’]ve|\s+have)?\s+(?:ate|eaten|had|drank|snacked)\b/i;
const EAT_FOOD_WORD_RE = /\b(?:ate|eat|eating|meal|breakfast|lunch|dinner|snack|calories?|protein|carbs?)\b/i;
function looksLikeFoodLog(text) {
  const t = String(text || '');
  if (CALORIE_ASK_RE.test(t)) return true;
  return FIRST_PERSON_EAT_RE.test(t) && EAT_FOOD_WORD_RE.test(t);
}
const EAT_HINT_TEXT = em('Meant to log food? Start with “eat” — e.g. “eat oatmeal, chips”.').toString();
function maybeEatHint(reply, { userId, isOn, text }) {
  if (!isOn('diet') || !looksLikeFoodLog(text)) return reply;
  const slot = 'eat_hint';
  if (dailyShownRecently(userId, slot)) return reply;
  markDailyShown(userId, slot);
  reply.text = `${reply.text}\n\n${EAT_HINT_TEXT}`;
  return reply;
}

// Topic guides gated behind a module — only resolved / advertised while that module is on for the user.
const GUIDE_GATED = new Set(['metrics', 'diet', 'notes', 'lists', 'timer', 'journal', 'batches', 'medication']);
const guideTopicOn = (key, isOn) => !GUIDE_GATED.has(key) || isOn(key);
const liveGuideTopics = (isOn) => GUIDE_TOPICS.filter((k) => guideTopicOn(k, isOn));  // gated topics included only when on

// The full command reference now lives as tappable SECTIONS (COMMAND_SECTIONS in shared/copy.js). "/commands"
// pops a short hub of section buttons; tapping one expands that section's lines IN PLACE with a "‹ All
// sections" footer — the same progressive-disclosure shape as the /guide hub, instead of one busy wall.
// liveSections() drops any section/line for a feature that's currently OFF, so the help shows only what's
// installed. A section expands to: a BOLD header, then its lines escaped (so the literal "<words>"/"&" in the
// copy are valid HTML) — the bare /command tokens survive escaping untouched, so they still auto-link / chip.
const commandSectionText = (s) => [b(s.label).toString(), ...s.lines.map((l) => esc(l))].join('\n');
const liveCommandSections = (isOn) => liveSections(isOn);
const commandsHub = (isOn) => ({ text: COMMANDS_INTRO, buttons: commandHubMenu(liveCommandSections(isOn)) });
const commandSectionReply = (key, isOn) => {
  const s = liveCommandSections(isOn).find((x) => x.key === key);
  return s ? { text: commandSectionText(s), buttons: COMMAND_BACK, html: true } : commandsHub(isOn);
};

// A multi-paragraph doc (a guide / the rules / the how-to) as rich text: bold the heading line, escape the
// rest (guides carry literal "<when>"/"&" that would otherwise break HTML mode). `/command` examples in the
// body survive escaping, so they stay tappable. Returns an html:true reply; `extra` adds buttons etc.
const richDoc = (text, extra = {}) => {
  const [head, ...rest] = String(text).split('\n');
  return { text: [b(head).toString(), ...rest.map(esc)].join('\n'), html: true, ...extra };
};

// The Rules of Fanad + the onboarding how-to now live in shared/copy.js — one source for the Telegram
// greetings AND the web client (served via /api/config), so the two channels can't drift.
const WELCOME = RULES;

// The /start greeting (Telegram's Start button, or typed): the rules of Fanad, then how to fill it.
const START = `${RULES}\n\n${HOWTO}`;

// The guide HUB — what "guide"/"help" pop now: a short, breezy intro + a tap-per-topic keyboard, instead of
// one wall of prose. Each topic opens its own short panel (with a "‹ All topics" footer); the full command
// list still lives at /commands. Topics are gated (metrics only when on), so the hub built here mirrors that.
const GUIDE_HUB_TEXT = '✨ The Fanad guide — tap a topic and I’ll keep it short.';
const guideHub = (isOn) => ({ text: b(GUIDE_HUB_TEXT).toString(), buttons: guideMenu(liveGuideTopics(isOn)), html: true });

// The first-step warning for /requestdeletion. Deliberately blunt and exhaustive — the command never acts
// on this turn; it arms a one-shot confirm and waits for the explicit word (see handleDeleteConfirm).
const DELETE_WARNING = '⚠️ Delete everything?\n\n'
  + 'This permanently erases ALL of your data — every task, note, message, mood, metric, reminder, template, '
  + 'and the preferences I’ve learned about you. It cannot be undone.\n\n'
  + 'Type DELETE to confirm, or anything else to cancel.';

// Leading single-letter shortcuts, so a common command needn't be typed out. Two shapes, both ONLY at the
// very START of a message:
//   • "<letter> <text>" → a command that takes text  — "n spare key" → "/note spare key", "d 3" → "/done 3".
//   • a bare "<letter>"  → an argument-free command   — "w" → "/whatdo" (joins bare "c", the command menu).
// We rewrite to the canonical SLASH form so a shortcut escapes an open question exactly like the full command
// would (see answersPendingState). A bare letter expands ONLY when it maps to an arg-free command, so "n" on
// its own stays a "no" (it's in FILLER_RE) and is never read as an empty /note. "y" is deliberately unmapped:
// it reads as "yes" (and as yes/no in some other languages). The raw text is snapshotted before this, so the
// user's history still shows exactly what they typed. Documented in the "shortcuts" topic guide (copy.js).
// The letter table itself lives in shared/commands.js (SHORTCUTS) so the web legend reads the same data
// via /api/config; SHORTCUT_WITH_TEXT / SHORTCUT_BARE imported above are derived from it unchanged.

const GREETING_RE = /^(hi+|hello+|hey+|heya|hiya|yo|howdy|sup|good\s*(morning|afternoon|evening|day))(\s+(there|fanad))?\s*[!.…]*$/i;
// Standalone filler / yes-no / acknowledgment words. When one of these arrives with NOTHING to answer
// (any open question was handled or cleared earlier in route), it's never a task — double-tapping "no"
// must not file a task called "no". Acknowledged gently instead of captured. Mood emoji/words are caught
// before this. ("/task no" is the escape hatch if someone really wants a task literally named "no".)
const FILLER_RE = /^(?:y|n|ya|yah|yep|yup|yeah|yes+|no+|nope|nah+|naw|ok|okay|okey|kk?|sure|alright|aight|right|correct|hmm+|hm|huh|eh|oh+|ah+|lol|lmao|nvm|never\s*mind)[\s.!?]*$/i;
const THANKS_RE = /^(?:thanks?|thank\s*you|thx|ty|tysm|np|yw|cheers)[\s.!?]*$/i;

// Mood → energy, which sizes suggestions (anti-overwhelm). Read your last EXPRESSED mood, not the last
// message, so a 😴 keeps steering until you tell me otherwise.
const MOOD_WINDOW = 6 * 60 * 60 * 1000; // a mood older than ~6h stops steering
const LOW_MOOD = /[😴🥱💤😪🛌😞😔😟😣😢😭🙁🥺🤒🤕🤧🥴😵🤢🤮🥶😫😩😓😰😨🫠]/u;     // tired · sad · sick · drained
const HIGH_MOOD = /[😀😃😄😁😆😊🤩🥳😎💪🔥⚡🚀✨⭐💯🙌🤗😍🥰]/u;                     // bright · pumped · happy
const HUNGRY = /[😋🤤🍔🍕🍟🍿🥪🍜🍳🥗🍱🍩]/u;                                       // hungry → take it gentle

const CONF_MIN = 0.5;             // below this, a "question" guess is too weak → treat as a statement
const GROOM_THRESHOLD = 3;        // refusals before we offer to reshape a task (§11)
const GROOM_TASK_COOLDOWN = 72 * 60 * 60 * 1000;
const DAY = 86400000;

const startOfTomorrow = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() + DAY; };
const inAWeek = () => Date.now() + 7 * DAY;

// Infer an energy level when the user didn't say one — from their last expressed mood, then time of day.
function inferEnergy(userId) {
  const mood = latestMood(userId, Date.now() - MOOD_WINDOW) || '';
  if (LOW_MOOD.test(mood) || HUNGRY.test(mood)) return 'low';
  if (HIGH_MOOD.test(mood)) return 'high';
  const tod = timeOfDay();
  if (tod === 'night' || tod === 'early_morning') return 'low';
  return 'medium';
}

// Current-state snapshot prepended to every reply.
export function getStatus(userId) {
  const mood = latestMood(userId, Date.now() - MOOD_WINDOW);
  const w = currentWeather();
  return {
    mood: mood || null,
    weather: w ? `${w.emoji} ${w.weather}` : null,
    temp: w ? w.temp : null,
    tempUnit: w ? w.unit : null,
    time: timeOfDay().replace('_', ' '),
  };
}

export function formatStatusText(s) {
  const parts = [];
  if (s.mood) parts.push(`mood: ${s.mood}`);
  if (s.weather) parts.push(`weather: ${s.weather}`);
  if (s.temp != null) parts.push(`temp: ${s.temp}°${s.tempUnit || ''}`);
  if (s.time) parts.push(s.time);
  return parts.length ? `[ ${parts.join(' · ')} ]` : '';
}

// ── shared command bodies (used by both the slash matches and the LLM-intent dispatch) ──
const MANY_TASKS = 8;               // above this, /tasks asks you to narrow instead of dumping the list
const EFF_RANK = { high: 0, medium: 1, low: 2, trivial: 3 };
const catLabel = (c) => CATEGORY_LABELS[c] || c; // labels (+ legacy) live in shared/categories.js

// "Did an open-list task change this turn?" — set whenever a task's status flips (done / start / drop /
// expire), so a channel can quietly refresh a list it's already showing. Keyed by userId (concurrent users
// don't clobber each other); cleared at the start of each turn and consumed by handleMessage. setTaskStatus
// is wrapped here (one chokepoint) so every done/start/drop — typed, a tapped /done_N link, or batch — marks
// it without touching each call site. (Snooze/priority/category/reschedule are tap-only and detected by verb
// in the Telegram adapter, so they don't need the flag.)
const taskListDirty = new Set();
const setTaskStatus = (userId, ...rest) => { taskListDirty.add(userId); return repoSetTaskStatus(userId, ...rest); };
// The stored id of THIS turn's user message (set in route() right after recordSnapshot files it) —
// consumed by handleMessage to stamp the decided reaction onto that row so scroll-back can replay it.
// Same per-turn scratch pattern as taskListDirty.
const lastUserMsg = new Map();
// Compact deadline / reminder / priority markers for a task line. An "on <when>" task carries both a
// reminder AND a deadline at the same moment, so we show just the reminder (🔔) and suppress the ⏳ to
// avoid saying the same time twice; a plain "by <when>" deadline shows ⏳.
// The marker CHIPS for a task, as bare strings (no separators): a priority mark, a deadline (⏳) OR a one-time
// reminder (🔔, which suppresses the ⏳ when they share a moment), plus whether that deadline is URGENT
// (overdue / due today) — so a rich view can make it pop instead of dimming it with the rest.
function markerParts(task, { dueWord = false } = {}) {
  const remind = task.remind_at && !task.reminded_at ? `🔔 ${whenLabel(task.remind_at)}` : '';
  const due = task.due_at && !task.expired_at && !remind ? `⏳ ${dueWord ? 'due ' : ''}${dueLabel(task.due_at)}` : '';
  const pr = task.priority ? priorityMark(task.priority) : '';
  const urgentDue = !!due && ['overdue', 'today'].includes(dueLabel(task.due_at));
  return { pr, due, remind, urgentDue };
}
// The plain " · "-joined marker tail (priority + deadline/reminder) — used by the non-HTML surfaces (the
// sleeping taskLine). Order: priority, then the deadline or reminder.
function taskMarkers(task, opts = {}) {
  const { pr, due, remind } = markerParts(task, opts);
  return [pr, due, remind].filter(Boolean).map((x) => ` · ${x}`).join('');
}
// The rich meta line for a row/confirmation: category·difficulty·priority(+reminder/non-urgent deadline)
// DIMMED as one unit, with an URGENT deadline pulled out and BOLDED so it actually catches the eye. `lead` is
// the already-built "category · difficulty" (or just the difficulty in the grouped view). Returns a Safe.
function taskMetaLine(lead, task, opts = {}) {
  const { pr, due, remind, urgentDue } = markerParts(task, opts);
  const dimmed = [lead, pr, remind, urgentDue ? '' : due].filter(Boolean).join(' · ');
  return urgentDue ? html`${dim(dimmed)} · ${b(due)}` : dim(dimmed);
}
// The "✓ Filed" confirmation for a freshly-captured task: bold title, then the category·difficulty·marker
// meta dimmed as one unit. HTML — every caller wraps it in an html:true reply (or via logged()/withCalendar).
function filedLine(task) {
  const lead = `${catLabel(task.category)} · ${task.effort_level}`;
  return html`✓ Filed: ${title(`“${task.summary}”`)} · ${taskMetaLine(lead, task, { dueWord: true })}`.toString();
}
// Mark a reply as a just-logged-a-task confirmation — the one moment the ambient status header (mood · time ·
// weather) rides along, since it's the context the task was captured in. Every other reply suppresses the
// header (the channels gate on this flag), so the thread isn't noisy. Accepts a string or a reply object.
// A just-logged-a-task confirmation: carries the status header (logged:true) and is rendered as rich text
// (html:true) — every caller builds its text with richtext (filedLine, or title()/dim() inline).
const logged = (reply) => (typeof reply === 'string' ? { text: reply, logged: true, html: true } : { ...reply, logged: true, html: true });
function countBy(arr, keyFn) { const m = {}; for (const x of arr) { const k = keyFn(x); m[k] = (m[k] || 0) + 1; } return m; }
// "Open" = available or in-progress, EXCLUDING auto-slept tasks (they drift off the list until revived).
// Sweep expired snoozes back in and retire anything past its deadline first, so the list stays current.
function openTasks(userId) {
  sweepSnoozed(userId);
  expireDueTasks(userId);
  return listTasks(userId).filter((x) => (x.status === 'available' || x.status === 'in_progress') && !x.slept_at);
}

// Every in_progress task, newest started_at first. Normally at most one (the repo's single-active
// invariant), but transitionTask reads it BEFORE starting to know what's about to be paused.
function startedTasks(userId) {
  return listTasks(userId).filter((x) => x.status === 'in_progress')
    .sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
}
// The task you most recently started (in_progress, newest started_at first). The bare-finish word and
// "/guess" both act on it — "the thing I'm working on right now".
function startedTask(userId) {
  return startedTasks(userId)[0] || null;
}

const PAGE_SIZE = 7; // anti-overwhelm: at most this many task rows per page

// Context for the relevance tail — computed ONCE per listing, not per task.
function listingContext(userId) {
  const now = Date.now();
  return { userId, phase: phaseOf(timeOfDay(now)), hour: new Date(now).getHours(), weather: currentWeather()?.weather || null, energy: inferEnergy(userId), ms: now };
}

// "Smart fit", cheaply: an O(1) score reusing the suggestion engine's PURE signals (no embeddings, no DB
// aggregates) so a whole list ranks without the per-task cost of suggestTask. The relevance TAIL after the
// hard sort keys. See rag/index.js for the shared pieces.
function cheapRelevance(task, ctx) {
  let s = 0;
  s += 0.20 * recency(task.created_at);
  s += 0.15 * effortFit(task.effort_level, ctx.energy);
  s += contextScore(task, ctx);                  // day/night + usual-hour + same-weather fit
  s += dueBoost(task, ctx.ms);                   // a live deadline lifts it, sharply as it nears
  s -= 0.08 * (task.refusal_count || 0);          // gently sink repeatedly-refused tasks
  if (task.last_suggested_at && ctx.ms - task.last_suggested_at < 6 * 3600000) s -= 0.30; // anti-repeat
  return s;
}

// Rank: in-progress → manual priority → live deadline (soonest) → effort → smart-fit relevance.
function rankTasks(tasks, ctx) {
  return tasks
    .map((t) => ({ t, rel: cheapRelevance(t, ctx) }))
    .sort((a, b) =>
      (a.t.status === 'in_progress' ? 0 : 1) - (b.t.status === 'in_progress' ? 0 : 1)
      || (b.t.priority || 0) - (a.t.priority || 0)
      || (a.t.due_at ? 0 : 1) - (b.t.due_at ? 0 : 1)
      || (a.t.due_at || 0) - (b.t.due_at || 0)
      || EFF_RANK[a.t.effort_level] - EFF_RANK[b.t.effort_level]
      || b.rel - a.rel)
    .map((x) => x.t);
}

const taskLine = (t) => `${t.summary}${t.status === 'in_progress' ? ' ▶' : ''} · ${catLabel(t.category)} · ${t.effort_level}${taskMarkers(t)}`;

// ── Task STEPS rendering (the "step"/"start"/"done N" flow). STEP_RE matches the add-a-step command and its
// spoken aliases (step / substep / subtask), shared by the command matcher and the stepping handler. ──
const STEP_RE = /^\/?(?:steps?|substeps?|subtasks?)\b/i;
const stepBody = (text) => String(text || '').replace(/^\/?(?:steps?|substeps?|subtasks?)\b[\s:]*/i, '').trim();
// Removing a step (the mirror of marking one done). "unstep"/"delstep" stand alone; the everyday verbs need
// the word "step" so they never collide with /drop (a task) or /delete & /forget (a note), nor swallow a new
// task statement. UNSTEP_RE then strips the verb, leaving the index list ("2" / "3 4" / "all").
const UNSTEP_RE = /^\/?(?:unsteps?|delsteps?|(?:remove|delete|drop|del|rm)\s+steps?)\b/i;
const unstepArgs = (text) => String(text || '').replace(UNSTEP_RE, '').trim();
const removeWhich = (rest) => (/^all\b/i.test(rest) ? 'all' : parsePositionList(rest)); // 'all' | number[] | null
// The checkbox + number prefix stays BARE; only the user's step text is escaped (no tag) — so it's valid
// inside the html:true step replies, while "☐ 1. <text>" reads exactly as before.
function stepsChecklist(steps) {
  return (steps || []).map((s, i) => `${s.done ? '☑' : '☐'} ${i + 1}. ${esc(s.text)}`).join('\n');
}
const normForCompare = (x) => (x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Worth showing alongside `base`? Non-empty and not an EXACT restatement (case/punctuation aside). Unlike
// meaningfullyDifferent, this does NOT suppress a value that merely CONTAINS the base: your verbatim capture
// is usually the LLM summary PLUS the trailing context the summary trimmed ("…about my crown", "…tomorrow"),
// and surfacing that dropped context the moment you start is the whole point of trapping it.
function differsFrom(s, base) {
  const a = normForCompare(s);
  return !!a && a !== normForCompare(base);
}
// Is `s` worth showing next to `base`? Non-empty, not a trivial restatement, AND not a mere substring of it —
// used for the fuller LLM read, which shouldn't echo when it barely differs from the summary / original.
function meaningfullyDifferent(s, base) {
  const a = normForCompare(s); const b = normForCompare(base);
  return !!a && a !== b && !b.includes(a) && !a.includes(b);
}
// The lines shown when a task is started: the started line, then ALWAYS your verbatim words when they aren't
// an exact restatement of the title (the LLM title trims context, so it can be a perfect prefix yet still
// drop the part you cared about), then the fuller LLM paragraph (only when it adds beyond both).
function startedHeader(task) {
  // Bold title (clickable when the task carries a link); the verbatim 📄 line stays plain-but-escaped (your
  // own words, read straight); the fuller LLM paragraph is dimmed (a secondary paraphrase). All html — the
  // started reply is html:true. A single-task card keeps Telegram's preview card — informative here.
  const link = parseLink(task);
  const name = link ? b(html`“${a(link.url, task.summary)}”`) : title(`“${task.summary}”`);
  const lines = [html`▶ Started: ${name}.`.toString()];
  if (differsFrom(task.original_text, task.summary)) lines.push(html`📄 ${task.original_text.trim()}`.toString());
  if (meaningfullyDifferent(task.llm_summary, task.summary)
      && meaningfullyDifferent(task.llm_summary, task.original_text)) lines.push(em(task.llm_summary.trim()).toString());
  return lines;
}
// A light re-render of the checklist + step buttons (used after each tick; doesn't repeat the header).
function stepsView(task) {
  const steps = parseSteps(task);
  const done = steps.filter((s) => s.done).length;
  return { text: `Steps (${done}/${steps.length}):\n${stepsChecklist(steps)}`, buttons: stepsKeyboard(task.id, steps), html: true };
}

// Render a removeTaskStep result. The numbers in the message are the ORIGINAL positions taken out; the
// re-rendered checklist shows the new, compacted numbering. `rearm` (inside a stepping session) drops the
// session when the last step goes, so the now-stepless task isn't left waiting on "done <n>".
function stepRemovalReply(userId, taskId, res, { rearm = false } = {}) {
  if (!res) { if (rearm) clearDialogState(userId); return 'That task’s gone now.'; }
  if (!res.removed.length) {
    if (res.total === 0) return 'No steps to remove there.';
    const v = stepsView(getTask(userId, taskId));
    return { text: `That step number isn’t on the list.\n${v.text}`, buttons: v.buttons, html: true };
  }
  const note = `🗑 Removed step${res.removed.length === 1 ? '' : 's'} ${res.removed.join(', ')}.`;
  if (res.total === 0) {
    if (rearm) clearDialogState(userId);
    return `${note} “${getTask(userId, taskId).summary}” has no steps now — add some with “step …”, or say “done” when you finish.`;
  }
  const v = stepsView(getTask(userId, taskId));
  return { text: `${note}\n${v.text}`, buttons: v.buttons, html: true };
}

// A tappable "📷 /pic_N" tail on a row whose task has a photo. The underscore form is what Telegram
// auto-links into a single tappable command (a spaced "/pic N" would only send "/pic") — "/pic N" still
// works when typed. `n` is the row's list position, so the link re-sends THAT task's photo.
function picMarker(task, withPic, n) {
  return withPic.has(task.id) ? ` · 📷 /pic_${n}` : '';
}

// Tappable per-task action links on a listing row, right next to the task — "▶ /start_N" (only when it
// isn't already running) and "✓ /done_N". The underscore form is what Telegram auto-links into one command
// (like /pic_N / /cal_N), and the web renders "/verb_N" as a one-tap command too. `n` is the row position,
// resolved against the current listing — so the action hits the task you're looking at.
function actionMarkers(task, n) {
  const start = task.status === 'in_progress' ? '' : ` · ▶ /start_${n}`;
  return `${start} · ✓ /done_${n}`;
}

// A tappable "📅 /cal_N" tail on a row whose task has a DATE — drop it into your own calendar (and make it
// recur THERE if you want; Fanad never nags about time). Mirrors picMarker; `n` is the row's list position.
// Telegram auto-links "/cal_N"; the web's /cal reply renders the calendar URL as a download link.
function calMarker(task, n) {
  return taskEventTime(task) ? ` · 📅 /cal_${n}` : '';
}

// Attach "add to calendar" affordances to a reply for a DATED task: a download URL (web renders a link) and
// the .ics bytes as a document (Telegram sends a file). No-op when the task has no date — returns the reply
// unchanged (string or object). The endpoint is user-scoped, so the raw id in the URL never crosses tenants.
function withCalendar(reply, task) {
  const ev = task ? icsForTask(task) : null;
  if (!ev) return reply;
  const r = typeof reply === 'string' ? { text: reply } : { ...reply };
  r.calendarUrl = `/api/tasks/${task.id}/event.ics`;
  r.document = { filename: ev.filename, content: ev.ics, mime: 'text/calendar' };
  return r;
}

// One task as THREE lines so a busy row never mashes the name together with all its chips: the name on its
// own line, BOLD; an indented META line — category · difficulty · any priority/deadline marks — de-emphasised
// as ONE italic unit (no literal brackets; the styling IS the de-emphasis, and keeping it a single tag means
// an emoji+word marker like "🔴 high" stays contiguous so the wire text never splits it); then the tappable
// CONTROLS on their own line (▶ /start_N · ✓ /done_N · 📷 /pic_N · 📅 /cal_N) — left bare so /start_N
// auto-links on Telegram and chips on the web. `pad` indents grouped rows under their category header; the
// two meta lines sit one step further in. `category` is dropped in the grouped view (the header says it).
function taskRow(t, n, withPic, { category = true, pad = '' } = {}) {
  const cat = category ? `${catLabel(t.category)} · ` : '';
  const lead = `${cat}${t.effort_level}`; // "Home · low" (slice) or "low" (grouped — header has the category)
  const actions = `${actionMarkers(t, n)}${picMarker(t, withPic, n)}${calMarker(t, n)}`.replace(/^ · /, '');
  const flag = t.status === 'in_progress' ? ' ▶' : '';
  // A task captured with a pasted URL renders its title AS the link (bold + clickable on every surface).
  // List messages suppress Telegram's preview card (see the channel's link_preview_options), so this stays
  // one tidy line. a() falls back to plain text on a non-http(s) href, so the row can never lose its title.
  const link = parseLink(t);
  const name = link ? b(a(link.url, t.summary)) : title(t.summary);
  return html`${raw(pad)}${n}. ${name}${raw(flag)}\n${raw(pad)}   ${taskMetaLine(lead, t)}\n${raw(pad)}   ${raw(actions)}`.toString();
}

// Grouped view for a SMALL list (≤ MANY_TASKS): category headers, ranked within each group, numbered 1..N
// continuously. No pagination — it's small by construction. Returns { text, ids }.
function formatTasksGrouped(tasks, ctx) {
  const groups = new Map();
  for (const t of rankTasks(tasks, ctx)) { if (!groups.has(t.category)) groups.set(t.category, []); groups.get(t.category).push(t); }
  const cats = [...groups.keys()].sort((a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b));
  const withPic = taskIdsWithImages(ctx.userId);
  const lines = []; const ids = [];
  for (const c of cats) {
    lines.push(b(`${catLabel(c)} (${groups.get(c).length})`).toString()); // bold category header (anchors the group)
    for (const t of groups.get(c)) {
      const n = ids.length + 1;
      lines.push(taskRow(t, n, withPic, { category: false, pad: '  ' })); // category is the group header here
      ids.push(t.id);
    }
  }
  return { text: lines.join('\n'), ids };
}

// Flat RANKED + PAGINATED slice (a drill-in: one category/difficulty, or "all"). Numbers restart at 1 on
// every page so "/done 1" is always the top row on screen; the footer shows the absolute range.
function formatTasksSlice(tasks, ctx, offset = 0) {
  const ranked = rankTasks(tasks, ctx);
  const total = ranked.length;
  const lastPageStart = total ? (Math.ceil(total / PAGE_SIZE) - 1) * PAGE_SIZE : 0;
  const start = Math.max(0, Math.min(offset, lastPageStart));
  const window = ranked.slice(start, start + PAGE_SIZE);
  const withPic = taskIdsWithImages(ctx.userId);
  const lines = window.map((t, i) => taskRow(t, i + 1, withPic)); // flat slice keeps category on the meta line
  return { text: lines.join('\n'), ids: window.map((t) => t.id), total, start, end: start + window.length };
}

// Re-state the moves available against the numbers we just printed, so the user never has to remember them.
// Dimmed (italic) — it's a soft teaching aside under the list, not part of it. (List replies are html:true.)
const TASK_LIST_HINT = em('(“done 1” → finish · “start 1” → begin · “/drop 1” → clear · a few at once: “done 1 2 3”)').toString();
// One tap to dismiss a task list (Telegram deletes the message, web prunes it) so it's hidable and a single
// live copy never piles up. A structured m:hide token → handleAction clears the listing/page state.
const HIDE_LIST_BTN = [{ text: '✕ Hide', data: 'm:hide' }];

// A gentle one-liner about tasks that have drifted off to sleep (only shown when there are any). The count
// is dimmed; "/sleeping" stays bare so it auto-links / chips. Lives only on html:true list replies.
function sleepingNote(userId) {
  const n = countSleptTasks(userId);
  return n ? `\n${em(`💤 ${n} sleeping —`)} /sleeping to see them.` : '';
}
const filterLabel = (filter) =>
  (filter?.all ? 'your tasks' : filter?.today ? 'tasks due today' : filter?.category ? catLabel(filter.category) : filter?.effort ? `${filter.effort} tasks` : 'your tasks');

// Persist the order we just rendered so "/done N" etc. resolve N against THIS list. Small grouped view →
// no paging cursor.
function showTasks(userId, rendered) {
  setListing(userId, 'task', rendered.ids);
  setPageState(userId, null);
  const body = rendered.ids.length ? `${rendered.text}\n${TASK_LIST_HINT}` : rendered.text;
  // Per-task actions live as tappable "▶ /start_N · ✓ /done_N" links on each row, and a small grouped view
  // (≤ MANY_TASKS) never paginates — so the only control is a single "✕ Hide" to dismiss the list when done
  // with it. `listing` lets Telegram drop the previous list when this one opens (anti-clutter). `html`: bold
  // titles + dimmed meta (rows are richtext).
  return { text: `${body}${sleepingNote(userId)}`, buttons: rendered.ids.length ? [HIDE_LIST_BTN] : null, listing: true, listKind: 'task', html: true };
}

// Persist a paginated slice: the visible ids (for "/done N") + a paging cursor (only when there's more than
// one page, so "next"/"prev" are live only while paging). Renders the intro + "Page x/y" footer.
function showSlice(userId, slice, { filter, label }) {
  setListing(userId, 'task', slice.ids);
  const multi = slice.total > PAGE_SIZE;
  setPageState(userId, multi ? { offset: slice.start, total: slice.total, filter, label } : null);
  const pages = Math.max(1, Math.ceil(slice.total / PAGE_SIZE));
  const page = Math.floor(slice.start / PAGE_SIZE) + 1;
  const intro = multi ? `Here’s a slice of ${b(label)}:\n\n` : '';
  // Page x/y footer only; the ‹ Prev / Next → buttons below do the paging (typed "next"/"prev" still work).
  const footer = multi ? `\n${dim(`Page ${page}/${pages} · showing ${slice.start + 1}–${slice.end} of ${slice.total}`)}` : '';
  const text = `${intro}${slice.text}\n${TASK_LIST_HINT}${footer}${sleepingNote(userId)}`;
  // No number buttons — per-row "▶ /start_N · ✓ /done_N" links act on each task. Just the page controls (only
  // the directions that exist — no dead-end Prev on page 1 / Next on the last page) and a "✕ Hide" to dismiss.
  const pageRows = multi ? (listPageKeyboard({ hasPrev: slice.start > 0, hasNext: slice.end < slice.total }) || []) : [];
  const buttons = [...pageRows, HIDE_LIST_BTN];
  return { text, buttons, listing: true, listKind: 'task', html: true };
}

// A lot of tasks → a compact COUNTS overview + a follow-up to drill into one slice (the top PAGE_SIZE of it).
function tasksOverview(userId, open) {
  const byCat = countBy(open, (t) => t.category);
  const byEff = countBy(open, (t) => t.effort_level);
  const cats = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]);
  const effs = ['trivial', 'low', 'medium', 'high'].filter((e) => byEff[e]);
  const options = [...cats, ...effs].slice(0, 8); // raw names so the chips parse back exactly
  setDialogState(userId, { type: 'task_filter', prompt: 'narrow tasks', data: { options } });
  setListing(userId, 'task', []); // no numbers shown yet → don't let "/done N" hit a stale list
  setPageState(userId, null);
  // A short, scannable intro; the per-kind / per-difficulty breakdown (with counts) lives on the chips below
  // so the message never becomes a run-on wall. Tapping a chip filters; 📅 Today / 📋 All are always offered.
  return {
    text: `🌊 You've got ${b(`${open.length} open tasks`)} — too many to list at once.\n`
      + `\nTap a kind or difficulty below to see its top ${PAGE_SIZE} — or grab 📅 Today / 📋 All.${sleepingNote(userId)}`,
    mode: 'filter',
    buttons: [...taskFilterKeyboard({ cats, byCat, effs, byEff }), HIDE_LIST_BTN],
    listing: true,
    html: true,
  };
}

function listTasksReply(userId, filter = null) {
  let open = openTasks(userId);
  if (!open.length) { setListing(userId, 'task', []); setPageState(userId, null); return `No open tasks. ✨  Tell me something you want to do.${sleepingNote(userId)}`; }
  const ctx = listingContext(userId);
  if (filter?.all) return showSlice(userId, formatTasksSlice(open, ctx, 0), { filter, label: 'your tasks' });
  if (filter?.today) {
    open = open.filter((t) => isDueToday(t));
    if (!open.length) { setListing(userId, 'task', []); setPageState(userId, null); return `Nothing due today. 🌱  (try /tasks for everything)${sleepingNote(userId)}`; }
    return showSlice(userId, formatTasksSlice(open, ctx, 0), { filter, label: 'due today' });
  }
  if (filter?.category) open = open.filter((t) => t.category === filter.category);
  if (filter?.effort) open = open.filter((t) => t.effort_level === filter.effort);
  if ((filter?.category || filter?.effort) && !open.length) {
    return `Nothing in “${filter.category || filter.effort}” right now. (try /tasks for everything)`;
  }
  if (filter) return showSlice(userId, formatTasksSlice(open, ctx, 0), { filter, label: filterLabel(filter) });
  if (open.length <= MANY_TASKS) return showTasks(userId, formatTasksGrouped(open, ctx));
  return tasksOverview(userId, open);
}

// "next"/"prev" — re-derive the open set + the stored filter, then render the adjacent page.
function handleListPage(userId, dir) {
  const st = getPageState(userId);
  if (!st) return 'Nothing to page through right now — try /tasks.';
  let open = openTasks(userId);
  if (st.filter?.category) open = open.filter((t) => t.category === st.filter.category);
  else if (st.filter?.effort) open = open.filter((t) => t.effort_level === st.filter.effort);
  else if (st.filter?.today) open = open.filter((t) => isDueToday(t));
  const newOffset = (st.offset || 0) + dir * PAGE_SIZE;
  if (newOffset < 0) return 'You’re on the first page. (say “next” for more)';
  if (newOffset >= open.length) return `That’s the end — ${open.length} in “${st.label}”. (“prev” to go back)`;
  return showSlice(userId, formatTasksSlice(open, listingContext(userId), newOffset), { filter: st.filter, label: st.label });
}

// Answer to the "which tasks?" follow-up: a category/effort filter, "all", or something we didn't catch.
function handleTaskFilter(userId, text) {
  const f = taskFilterAnswer(text);
  const open = openTasks(userId);
  // Didn't catch a category/difficulty: re-ask (if still a lot) instead of dumping the whole list.
  if (!f && open.length > MANY_TASKS) {
    const ov = tasksOverview(userId, open); // re-arms the task_filter dialog
    return { ...ov, text: `Which would you like — a category or a difficulty? (or say “all”)` };
  }
  clearDialogState(userId);
  if (!f) return showTasks(userId, formatTasksGrouped(open, listingContext(userId)));
  return listTasksReply(userId, f); // delegates: f.all → flat slice, category/effort → filtered slice
}

// ── sleeping (auto-slept) tasks ──
function sleepingReply(userId) {
  const slept = listSleptTasks(userId);
  if (!slept.length) { setListing(userId, 'task', []); return 'Nothing sleeping right now. 🌱'; }
  setListing(userId, 'task', slept.map((t) => t.id));
  setPageState(userId, null);
  const withPic = taskIdsWithImages(userId);
  const lines = slept.map((t, i) => `${i + 1}. ${taskLine(t)}${picMarker(t, withPic, i + 1)}${calMarker(t, i + 1)}`);
  return { text: `💤 ${slept.length} sleeping (untouched for a while):\n${lines.join('\n')}\n(“/revive 1” to bring one back · a few: “/revive 1 2 3”)`, listing: true };
}
function reviveCmd(userId, text) {
  const positions = parsePositionList(text);
  if (!positions) return 'Which one? Try “/sleeping”, then “/revive 1” (or a few: “/revive 1 2 3”).';
  const { pairs, missing } = resolveListing(userId, 'task', positions);
  const woke = pairs.length ? wakeTasks(userId, pairs.map((p) => p.id)) : 0;
  if (!woke) return 'I couldn’t match those to the sleeping list — try “/sleeping” first.';
  const miss = missing.length ? ` (couldn’t find ${missing.map((mm) => `#${mm}`).join(', ')})` : '';
  return `☀️ Revived ${woke} task${woke === 1 ? '' : 's'} — back on your list.${miss}`;
}
// ── snoozed tasks (manually tucked away) — the escape hatch so snooze isn't a black hole ──
function snoozedReply(userId) {
  sweepSnoozed(userId); // elapsed timers wake first, so the list only shows genuinely-future snoozes
  const snoozed = listSnoozedTasks(userId);
  if (!snoozed.length) { setListing(userId, 'task', []); return 'Nothing snoozed right now. 🌱'; }
  setListing(userId, 'task', snoozed.map((t) => t.id));
  setPageState(userId, null);
  const withPic = taskIdsWithImages(userId);
  const lines = snoozed.map((t, i) => `${i + 1}. ${taskLine(t)} · wakes ${whenLabel(t.snoozed_until)}${picMarker(t, withPic, i + 1)}${calMarker(t, i + 1)}`);
  return { text: `😴 ${snoozed.length} snoozed:\n${lines.join('\n')}\n(“/unsnooze 1” to bring one back now · a few: “/unsnooze 1 2 3”)`, listing: true };
}
function unsnoozeCmd(userId, text) {
  const positions = parsePositionList(text);
  if (!positions) return 'Which one? Try “/snoozed”, then “/unsnooze 1” (or a few: “/unsnooze 1 2 3”).';
  const { pairs, missing } = resolveListing(userId, 'task', positions);
  // Only rows that are STILL snoozed — a stale listing position must never reset a live task's markers.
  // The full rows are read BEFORE the flip: 'available' clears snoozed_until, and undo needs the wake time.
  const targets = pairs.map((p) => getTask(userId, p.id)).filter((x) => x?.status === 'snoozed');
  for (const r of targets) setTaskStatus(userId, r.id, 'available');
  if (!targets.length) return 'I couldn’t match those to the snoozed list — try “/snoozed” first.';
  recordUndo(userId, 'task_status', { items: targets.map((r) => statusItem(r, 'available')) },
    `↩ Snoozed ${targets.map((r) => `“${r.summary}”`).join(', ')} again.`);
  const miss = missing.length ? ` (couldn’t find ${missing.map((mm) => `#${mm}`).join(', ')})` : '';
  return `☀️ Unsnoozed ${targets.length} task${targets.length === 1 ? '' : 's'} — back on your list.${miss}`;
}
// Put a started task back to 'available' without finishing it — the inverse of start (setTaskStatus also
// NULLs started_at so a later restart stamps fresh). A live stepping session pinned to it is dropped so
// "done" can't tick a no-longer-started task's steps; an edit-mode session (🪜 Steps) survives — it's about
// editing the checklist, not working it.
function unstartTask(userId, task) {
  const ds = getDialogState(userId);
  if (ds?.type === 'stepping' && ds.data?.taskId === task.id && !ds.data?.edit) clearDialogState(userId);
  setTaskStatus(userId, task.id, 'available');
  recordUndo(userId, 'task_status', { items: [statusItem(task, 'available')] },
    `↩ Started “${task.summary}” again.`);
  return `⏸ Put “${task.summary}” back on your list — not started, not lost.`;
}
function notesReply(userId) {
  const inbox = listNotes(userId, { status: 'new' });
  if (!inbox.length) { setListing(userId, 'note', []); return 'Your note inbox is empty. ✨  Text “note …” to jot something.'; }
  const shown = inbox.slice(0, 15);
  setListing(userId, 'note', shown.map((n) => n.id)); // "/promote N" / "/forget N" resolve against this order
  return { text: `📝 ${inbox.length} waiting:\n${shown.map((n, i) => `${i + 1}. ${n.text.slice(0, 80)}`).join('\n')}\n(“/promote 3” → task · “/forget 3” — or a few: “forget 1 2 3” — → delete)`, listing: true };
}

// ─────────────────────────── Lists — a nestable outliner (db.js v19 / repo.js) ───────────────────────────
// Separate from tasks and notes: a tree the user navigates INTO and OUT of. /lists opens it; each row carries a
// tappable "/sub_N" to descend into item N (which is itself a list of sub-items); typing a line adds an item to
// the open list; "out"/"top" climb, "next"/"prev" page, "exit" leaves. The state is the list cursor (dialog.js)
// + the 'list' listing (so "del N" / "rename N" / "/sub_N" resolve a position) + an armed list_nav dialog (so a
// typed line is read as a new item). Numbers restart at 1 each page, like the task slices.
const LIST_PAGE_SIZE = 10;

// One list row: "N. <title> (childCount)   /sub_N". The "/sub_N" mirrors a task row's "/done_N" tappable link —
// the client auto-chips it. A dim "(n)" flags that the item itself holds sub-items (so it's a list you can open).
function listRow(item, n) {
  const count = item.child_count ? em(` (${item.child_count})`) : raw('');
  return html`${n}. ${item.title}${count}   ${raw(`/sub_${n}`)}`.toString();
}

// The dim teaching aside under a list view — tailored to whether we're at the top or inside a list.
const listHint = (atTop) => em(atTop
  ? '(type a name to start a list · /sub_1 to open one · “exit” to leave)'
  : '(type to add an item · /sub_1 to open one · “out” · “top” · “del 1” · “rename 1 …” · “exit”)').toString();

// Render the current list view and persist everything it depends on. nodeId === null ⇒ the top-level lists. A
// nodeId that was deleted out from under us falls back to the top rather than erroring. Returns a list reply.
function listView(userId, nodeId = null, page = 0) {
  if (nodeId != null && !getListItem(userId, nodeId)) { nodeId = null; page = 0; }
  const atTop = nodeId == null;
  const children = listChildren(userId, nodeId);
  const total = children.length;
  const pages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
  const p = Math.max(0, Math.min(page, pages - 1));
  const start = p * LIST_PAGE_SIZE;
  const slice = children.slice(start, start + LIST_PAGE_SIZE);

  setListCursor(userId, { nodeId: atTop ? null : nodeId, page: p });
  setListing(userId, 'list', slice.map((c) => c.id)); // positions resolve against the VISIBLE slice
  setDialogState(userId, { type: 'list_nav', data: { nodeId: atTop ? null : nodeId } });

  const crumb = atTop ? 'Your lists' : (listItemPath(userId, nodeId).join(' › ') || 'Your lists');
  const countTail = total ? em(` · ${total} item${total === 1 ? '' : 's'}`) : raw('');
  const header = html`📑 ${b(crumb)}${countTail}`.toString();

  let body;
  if (!total) {
    body = atTop
      ? 'No lists yet. Type a name to start one (“Groceries”), or “/list Groceries”. 🌱'
      : 'This list is empty. Type an item to add it, or “out” to go back. 🌱';
  } else {
    const rows = slice.map((c, i) => listRow(c, i + 1)); // 1..N per page; the footer shows the absolute range
    const footer = pages > 1 ? `\n${dim(`Page ${p + 1}/${pages} · showing ${start + 1}–${start + slice.length} of ${total}`)}` : '';
    body = `${rows.join('\n')}${footer}`;
  }

  const buttons = listNavKeyboard({ atTop, hasParent: !atTop, hasPrev: p > 0, hasNext: start + slice.length < total });
  return { text: `${header}\n${body}\n${listHint(atTop)}`, buttons, listing: true, html: true };
}

const listsHome = (userId) => listView(userId, null, 0);
const listTop = (userId) => listView(userId, null, 0);

// Descend into item N on the current view (the "/sub_N" link / "open N"); item N becomes the open list.
function listDescend(userId, pos) {
  const { pairs, total } = resolveListing(userId, 'list', [pos]);
  if (!pairs.length) return noListingReply(total, 'list');
  const node = getListItem(userId, pairs[0].id);
  if (!node) return 'That item isn’t on your list anymore. Try /lists.';
  return listView(userId, node.id, 0);
}

// Up one level: to the open list's parent (which may be the top). Already at the top → just re-show it.
function listOut(userId) {
  const cur = getListCursor(userId);
  if (!cur || cur.nodeId == null) return listView(userId, null, 0);
  const node = getListItem(userId, cur.nodeId);
  return listView(userId, node ? node.parent_id : null, 0);
}

const listPageNav = (userId, dir) => {
  const cur = getListCursor(userId) || { nodeId: null, page: 0 };
  return listView(userId, cur.nodeId, (cur.page || 0) + dir);
};

function listExit(userId) {
  clearDialogState(userId);
  clearListCursor(userId);
  setListing(userId, 'list', []); // drop the numbering so a stray "/sub_N" can't hit a list that's no longer shown
  return 'Closed your lists. 🌱  (“/lists” opens them again)';
}

// Add a typed line as an item to the OPEN list (or, at the top, as a new top-level list), then re-render —
// landing on the last page so the freshly-added item is in view.
function addListItemReply(userId, title) {
  const t = (title || '').trim();
  if (!t) return listsHome(userId);
  const cur = getListCursor(userId) || { nodeId: null, page: 0 };
  const parentId = cur.nodeId ?? null;
  if (parentId != null && !getListItem(userId, parentId)) return listView(userId, null, 0); // parent vanished → home
  const item = insertListItem({ userId, parentId, title: t });
  recordUndo(userId, 'list_add', { itemId: item.id }, `↩ Took “${t}” back off the list.`);
  const total = countListChildren(userId, parentId);
  return listView(userId, parentId, Math.ceil(total / LIST_PAGE_SIZE) - 1);
}

// "/sub_N <text>" — quick-add a child UNDER item N without descending; stay on the current view (item N's
// child count ticks up). The calm way to outline fast: "/sub_1 milk", "/sub_1 eggs", then "/sub_1" to go in.
function subAddReply(userId, pos, title) {
  const t = (title || '').trim();
  if (!t) return listDescend(userId, pos);
  const { pairs, total } = resolveListing(userId, 'list', [pos]);
  if (!pairs.length) return noListingReply(total, 'list');
  const node = getListItem(userId, pairs[0].id);
  if (!node) return 'That item isn’t on your list anymore. Try /lists.';
  const item = insertListItem({ userId, parentId: node.id, title: t });
  recordUndo(userId, 'list_add', { itemId: item.id }, `↩ Took “${t}” back off the list.`);
  const cur = getListCursor(userId) || { nodeId: null, page: 0 };
  return listView(userId, cur.nodeId, cur.page || 0);
}

function delListItemReply(userId, pos) {
  const { pairs, total } = resolveListing(userId, 'list', [pos]);
  if (!pairs.length) return noListingReply(total, 'list');
  deleteListItem(userId, pairs[0].id); // cascades the whole subtree
  const cur = getListCursor(userId) || { nodeId: null, page: 0 };
  return listView(userId, cur.nodeId, cur.page || 0);
}

function renameListItemReply(userId, pos, title) {
  const t = (title || '').trim();
  if (!t) return 'Rename what? Try “rename 2 New title”.';
  const { pairs, total } = resolveListing(userId, 'list', [pos]);
  if (!pairs.length) return noListingReply(total, 'list');
  renameListItem(userId, pairs[0].id, t);
  const cur = getListCursor(userId) || { nodeId: null, page: 0 };
  return listView(userId, cur.nodeId, cur.page || 0);
}

// The list_nav dialog handler: a navigation word acts, anything else is a new item for the open list. (Slash
// and guide commands never reach here — they escape the dialog upstream; bare "lists"/"tasks"/"notes" are
// intercepted before the dialog check, so they exit list mode too.)
function handleListNav(userId, text) {
  const s = (text || '').trim();
  let m;
  if (/^(exit|close|quit|leave|done|stop)$/i.test(s)) return listExit(userId);
  if (/^(top|home|root)$/i.test(s)) return listTop(userId);
  if (/^(out|up|back|parent)$/i.test(s)) return listOut(userId);
  if (/^(next|more|forward)$/i.test(s)) return listPageNav(userId, +1);
  if (/^(prev|previous)$/i.test(s)) return listPageNav(userId, -1);
  if ((m = /^(?:sub|open|into|go)\s+#?(\d+)\s+([\s\S]+)$/i.exec(s))) return subAddReply(userId, Number(m[1]), m[2]);
  if ((m = /^(?:sub|open|into|go)\s+#?(\d+)$/i.exec(s))) return listDescend(userId, Number(m[1]));
  if ((m = /^(?:del|delete|remove|rm|drop)\s+#?(\d+)$/i.exec(s))) return delListItemReply(userId, Number(m[1]));
  if ((m = /^(?:rename|rn|edit)\s+#?(\d+)\s+([\s\S]+)$/i.exec(s))) return renameListItemReply(userId, Number(m[1]), m[2]);
  return addListItemReply(userId, s);
}
async function recallReply(userId, query) {
  const hits = await recallNotes(userId, (query || '').trim());
  return hits.length ? hits.slice(0, 6).map((n) => `• ${n.text}`).join('\n') : 'No matching notes.';
}
function dossierReply(userId) {
  const d = dossier(userId);
  if (!d.totalDone && !d.refused && !d.snoozed && !d.dropped) {
    return "I'm still getting to know you — finish a few things and ask again. 🌱";
  }
  const cats = d.topCategories.length
    ? d.topCategories.map((c) => `${catLabel(c.category)} (${c.done}${c.bestPhase ? `, mostly by ${c.bestPhase}` : ''})`).join(' · ')
    : '—';
  return [
    '✨ What I’ve learned about you',
    `• Finished ${d.totalDone} task${d.totalDone === 1 ? '' : 's'} — about ${Math.round(d.completionRate * 100)}% of what you added.`,
    `• You lean into: ${cats}`,
    d.moodBaseline ? `• Your usual mood: ${d.moodBaseline}` : null,
    (d.snoozed || d.dropped) ? `• Set aside: ${d.snoozed} snoozed · ${d.dropped} let go` : null,
    '(I use this to suggest the right thing at the right time.)',
  ].filter(Boolean).join('\n');
}
// ── "vouch @username": grow the access list by personal endorsement. ANY authorized user can vouch — that's
// the growth mechanism — and the voucher's identity is recorded (repo addVouch) so it stays accountable.
// Revoke lives in the web admin (cascade). A Telegram handle starts with a letter and is letters/digits/
// underscores (3–32 chars — lenient about grandfathered short handles; rejects words like "hi" and numbers).
const VOUCH_HANDLE_RE = /^[a-z][a-z0-9_]{2,31}$/;
// Exported: the public /demo signup page (routes/demo.js) validates visitor-typed handles with the SAME
// rule, so a handle that would be rejected here can't sneak onto the whitelist through the web door.
export function vouchHandle(s) {
  const u = normUsername(s);
  return VOUCH_HANDLE_RE.test(u) ? u : null;
}
// Bare "vouch" → who this user has vouched in + how to add someone.
function vouchListReply(userId) {
  const mine = listVouchesBy(userId);
  const how = 'Add someone with “vouch @username” — they’ll be able to message me, and you’ll be on record as who let them in.';
  if (!mine.length) return `You haven’t vouched anyone in yet.\n${how}`;
  return `🤝 You’ve vouched in ${mine.length}: ${mine.map((u) => `@${u}`).join(', ')}\n${how}`;
}
function vouchCommand(userId, rest) {
  if (!rest || !rest.trim()) return vouchListReply(userId);
  const target = vouchHandle(rest);
  if (!target) {
    return 'That doesn’t look like a Telegram username. Try “vouch @username” (letters, numbers, underscores).';
  }
  const me = getUser(userId);
  const myName = me?.display_name ? normUsername(me.display_name) : null;
  if (myName && target === myName) return 'You’re already in — no need to vouch for yourself. 🙂';
  // Already on the manually-configured seed allowlist? Then they're in regardless of vouches.
  const seeds = (getTelegramConfig().allowedUsername || '').toLowerCase().split(/[,\s]+/).map((u) => u.replace(/^@/, '')).filter(Boolean);
  if (seeds.includes(target)) return `@${target} is already on the access list. 👍`;
  if (isVouched(target)) {
    const cur = getActiveVouch(target);
    const by = cur?.voucher_username ? ` (vouched in by @${cur.voucher_username})` : '';
    return `@${target} is already vouched in${by}. 👍`;
  }
  // ── Demo guardrails (config.limits + the runtime freeze switch; the OWNER is exempt — vouching is their
  // job). Checked only for a NEW vouch (the idempotent "already in" replies above stay cap-free). ──
  const owner = isOwner(userId);
  const { vouchCapPerUser, vouchMaxDepth, maxVouchedUsers } = config.limits;
  if (!owner) {
    if (getGuardConfig().vouchFrozen) return '🧊 Vouching is paused right now — the host has frozen new invites.';
    if (vouchCapPerUser && listVouchesBy(userId).length >= vouchCapPerUser) {
      return `You’ve used all ${vouchCapPerUser} of your invites — ask the host if you need another.`;
    }
    // A user AT the max depth may not vouch (their invitee would exceed it). Depth walks the handle's own
    // vouch chain, so seeds/owner (no vouch row) are depth 0 and unaffected.
    if (vouchMaxDepth && myName && vouchDepthOf(myName) >= vouchMaxDepth) {
      return 'Invites from invited guests are off right now — ask the host to vouch them in directly.';
    }
    if (maxVouchedUsers && countActiveVouches('telegram') >= maxVouchedUsers) {
      return 'The guest list is full — ask the host to free up a seat.';
    }
  }
  const res = addVouch({ username: target, voucherUserId: userId, voucherUsername: myName, voucherTelegramId: me?.telegram_id ?? null });
  if (!res) return 'That doesn’t look like a Telegram username. Try “vouch @username”.';
  // Heads-up to the host when anyone ELSE grows the guest list (their own vouches need no echo).
  if (!owner) {
    const seatsUsed = countActiveVouches('telegram');
    notifyOwner(`🤝 @${myName || `user ${userId}`} vouched in @${target} — ${seatsUsed}${maxVouchedUsers ? `/${maxVouchedUsers}` : ''} seats used.`);
  }
  return `✅ Vouched. @${target} can message me now — they’ll get in next time they write. You’re on record as who let them in.`;
}

// The "c" / "/menu" shortcut: the no-argument commands as tap-to-run chips. Telegram renders these as
// command "bubbles"; the web shows them as quick-reply chips. `/tally` only shows when Metrics is on.
function commandMenu(isOn) {
  // Drop the chip for any module that's off for this user (so a disabled surface never offers a one-tap
  // that just bounces with "…is off"). The command→module map is COMMAND_FEATURES (shared/commands.js),
  // the same data the web legend filters by; commands absent from it (the tasks core) are always on.
  const options = ARGLESS_COMMANDS.filter((c) => !COMMAND_FEATURES[c] || isOn(COMMAND_FEATURES[c]));
  // `options` stays for the flat list (and the existing tests); `buttons` is the navigable hub — top-level
  // groups that expand in place to their commands (a tap on a leaf runs the command via the ordinary path).
  return { text: 'Tap one — these all run on their own: ✨', options, buttons: hubMenu() };
}
function setMood(userId, text, channel) {
  const emojis = extractMood(text);
  if (!emojis) return 'Tell me how you feel — an emoji like “mood 😴”, or a word like “mood overwhelmed”.';
  // The step-2 snapshot already captured the emoji; record one more so an emoji-only mood always lands.
  recordSnapshot({ userId, channel, text: emojis });
  // If the user SENT an emoji, the ack can be a reaction on their message — no "Mood set:" text needed
  // (kind:'mood' tells the Telegram adapter to react instead of replying; web still shows the text). But if we
  // INFERRED the emoji from words ("overwhelmed" → 😰), send the text so they can SEE which emoji we chose.
  const literal = extractEmojis(text);
  if (literal) return { text: `Mood set: ${emojis}`, kind: 'mood', moodEmoji: literal };
  return `Mood set: ${emojis}`;
}
function captureSnippetWords(userId, query) {
  const q = (query || '').trim().toLowerCase();
  const open = listTasks(userId).filter((x) => x.status !== 'done' && x.status !== 'archived');
  if (!q) return null;
  return open.find((x) => x.summary.toLowerCase().includes(q))
      || open.find((x) => q.split(/\s+/).some((w) => w.length > 2 && x.summary.toLowerCase().includes(w)))
      || null;
}

// ── wake-up check-ins (§10) ──
function parseClock(s) {
  // Accept friendly meridiem forms: am/pm, a/p, a.m./p.m. — any case, optional space (e.g. "8", "8pm", "8 p.m.").
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?m?\.?)?$/i.exec((s || '').trim());
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2] || 0); const ap = m[3]?.toLowerCase();
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
const fmtClock = (mod) => `${String(Math.floor(mod / 60)).padStart(2, '0')}:${String(mod % 60).padStart(2, '0')}`;

function wakeListReply(userId) {
  const rows = listSchedules(userId);
  if (!rows.length) return 'No check-ins yet. Set one with “/wake 8:30”.';
  return `⏰ Check-ins:\n${rows.map((s) => `#${s.id} ${fmtClock(s.minute_of_day)}${s.enabled ? '' : ' (off)'}`).join('\n')}\n(“/wake off <id>” to remove)`;
}
// Returns a reply, or null when the text after "wake" isn't a recognizable subcommand (→ let it fall through).
function wakeCommand(userId, t) {
  const rest = t.replace(/^\/?wakes?(?:list)?\s*/i, '').trim();
  if (!rest || /^list$/i.test(rest)) return wakeListReply(userId);
  let mm;
  if ((mm = /^(off|delete|remove|stop)\s+#?(\d+)/i.exec(rest))) {
    return deleteSchedule(userId, Number(mm[2])) ? `Removed check-in #${mm[2]}.` : `I couldn't find check-in #${mm[2]}.`;
  }
  const minute = parseClock(rest);
  if (minute == null) return null;
  const s = insertSchedule(userId, minute);
  // If the time already passed today, it fires tomorrow — say so, so "nothing happened" isn't a surprise.
  const now = new Date();
  const soonest = minute > now.getHours() * 60 + now.getMinutes() ? 'today' : 'tomorrow';
  return `⏰ I'll check in at ${fmtClock(minute)} (${soonest}). (“/wakelist” · “/wake off ${s.id}”)`;
}

// ── Timers (opt-in module): a one-shot "ding me in N minutes" — NOT a task, nothing lands on any list.
// "timer 10 minutes [label]" sets one (the amount is read by the duration parser, LLM fallback for fuzzy
// phrasing); bare "timer" lists what's running; "timer off N" cancels the Nth (soonest-first — small,
// short-lived listings, so positions are stable enough; the ✕ buttons carry the real id in their token).
// ── category / difficulty lock (bulk add, no per-task guessing) ──
const UNLOCKED_MSG = '🔓 Unlocked — I’ll sort each task on its own again.';
function lockStatusReply(userId) {
  const lock = getTaskLock(userId);
  if (!lock) return '🔓 Not locked. “/lock work” pins a category for the tasks you add next (or “/lock high” for difficulty, or both: “/lock errand low”). A brand-new one-word name like “/lock gardening” creates that category. “/unlock” clears it.';
  const bits = [];
  if (lock.category) bits.push(catLabel(lock.category));
  if (lock.effort) bits.push(`${lock.effort} effort`);
  return `🔒 Locked to ${bits.join(' · ')} — new tasks skip the guessing. “/unlock” to clear.`;
}
function lockCommand(userId, rest) {
  const r = (rest || '').trim();
  if (!r || /^(status|show|\?)$/i.test(r)) return lockStatusReply(userId);
  if (/^(off|none|clear|unlock|stop)$/i.test(r)) { clearTaskLock(userId); return UNLOCKED_MSG; }
  const target = parseLockTarget(r);
  if (target) { setTaskLock(userId, target); return lockStatusReply(userId); }
  // Nothing known matched. If it's a single clean word, take "/lock <word>" as "mint this category and lock
  // to it" — added for good (persisted + classifiable from now on), not just for this run.
  const created = addCustomCategory(r);
  if (created) {
    setTaskLock(userId, { category: created.key });
    return `🆕 New category “${created.label}” — added for good.\n${lockStatusReply(userId)}`;
  }
  return `I couldn't read “${r}” as a category or difficulty. Try “/lock work”, “/lock high”, “/lock errand low” — or a brand-new one-word name like “/lock gardening”.`;
}

// An emoji reaction left on one of Fanad's replies → a learning signal. Positive/negative reactions on a
// suggestion teach the per-category affinity; every reaction is also a mood beat.
const REACTION_SENTIMENT = {
  '🙌': 'positive', '🙏': 'positive', '👍': 'positive', '🔥': 'positive', '💯': 'positive',
  '😊': 'positive', '😂': 'positive', '❤️': 'positive', '⚡': 'positive',
  '🙁': 'negative', '👎': 'negative', '🤮': 'negative', '💩': 'negative',
  '💤': 'tired', '😴': 'tired',
};
export function applyReaction(userId, emoji, ref = null) {
  if (!emoji) return null;
  userId = effectiveUserId(userId); // a reaction is a mood/learning beat on the CURRENT notebook (callers pass identity)
  const sentiment = REACTION_SENTIMENT[emoji] || null;
  recordSnapshot({ userId, channel: 'web', text: emoji }); // the emoji is also a mood beat
  if (ref && ref.taskId && ref.category && (sentiment === 'positive' || sentiment === 'negative')) {
    const now = Date.now();
    insertTaskOutcome({
      userId, taskId: ref.taskId, category: ref.category, outcome: 'reaction', sentiment,
      ctxPhase: phaseOf(timeOfDay(now)), ctxHour: new Date(now).getHours(), ctxDow: new Date(now).getDay(),
      ctxWeather: currentWeather()?.weather || null, ctxMood: emoji, ctxEnergy: inferEnergy(userId), at: now,
    });
  }
  rebuildDossier(userId);
  return sentiment;
}

// Capture a meaningful outcome (done/refused/snoozed/dropped) with full context — the learning ledger.
function logOutcome(userId, task, outcome, sentiment = null) {
  if (!task) return null;
  const now = Date.now();
  return insertTaskOutcome({
    userId, taskId: task.id, category: task.category, outcome, sentiment,
    ctxPhase: phaseOf(timeOfDay(now)), ctxHour: new Date(now).getHours(), ctxDow: new Date(now).getDay(),
    ctxWeather: currentWeather()?.weather || null,
    ctxMood: latestMood(userId, now - MOOD_WINDOW), ctxEnergy: inferEnergy(userId), at: now,
  });
}

// One undo-stack item for a status flip: the task's PRIOR state (read before the write — 'available'
// clears snoozed_until, so the wake time must be captured here) + the state we set + the outcome-ledger
// row to retract. server/undo.js applies these; recordUndo stores them under kind 'task_status'.
function statusItem(before, to, outcomeId = null) {
  const it = { taskId: before.id, prev: before.status, to };
  if (before.status === 'snoozed' && before.snoozed_until) it.until = before.snoozed_until;
  if (outcomeId) it.outcomeId = outcomeId;
  return it;
}

function transitionTask(userId, id, status) {
  // One task at a time: the repo pauses any other in_progress sibling inside setTaskStatus. Read them
  // FIRST so the reply can name what got paused. `before` is the undo snapshot — same read-first rule.
  const paused = status === 'in_progress' ? startedTasks(userId).filter((x) => x.id !== id) : [];
  const before = getTask(userId, id);
  const task = setTaskStatus(userId, id, status);
  if (!task) return "I couldn't find that one.";
  if (status === 'in_progress') {
    if (before.status !== 'in_progress') {
      recordUndo(userId, 'task_status', { items: [statusItem(before, 'in_progress')] },
        `↩ Unstarted “${task.summary}” — back on your list.`);
    }
    // Any prior stepping session points at a task that was just paused — drop it so a stepless start
    // can't leave "done" ticking the OLD task's steps. (Only stepping: a button-tap start bypasses
    // answersPendingState, so an unrelated pending dialog shouldn't be collateral.) Re-armed below when
    // this task has steps.
    if (getDialogState(userId)?.type === 'stepping') clearDialogState(userId);
    // Write out the original note + the fuller LLM read + the steps (in add-order) so the whole task is in
    // front of you as you begin. With steps, arm "stepping" mode so "done"/"done N"/"done all" tick them.
    const steps = parseSteps(task);
    const lines = startedHeader(task);
    let buttons;
    if (steps.length) {
      lines.push('', 'Steps:', stepsChecklist(steps));
      buttons = stepsKeyboard(task.id, steps);
      setDialogState(userId, { type: 'stepping', data: { taskId: task.id } });
    } else {
      buttons = startedMenu(task, hasLiveList(userId));   // no steps yet → offer "💡 Suggest steps" alongside the usual actions
    }
    if (paused.length) {
      lines.push('', html`⏸ Paused: ${paused.map((p) => `“${p.summary}”`).join(', ')} — one thing at a time.`.toString());
    }
    const text = lines.join('\n');
    // Starting a task that was filed with a photo? Surface the photo so it's in front of you too.
    const img = getImageForTask(userId, task.id);
    const reply = { text, html: true };
    if (buttons) reply.buttons = buttons;
    if (img) reply.photo = img.file_id;
    return reply;
  }
  // Completed: record it, refresh the dossier, and quietly ask how it felt.
  const outcomeId = logOutcome(userId, task, 'done');
  if (before.status !== 'done') {
    recordUndo(userId, 'task_status', { items: [statusItem(before, 'done', outcomeId)] },
      `↩ Not done after all — “${task.summary}” is back on your list.`);
  }
  rebuildDossier(userId);
  setDialogState(userId, { type: 'done_feedback', prompt: 'how did that feel?', data: { outcomeId } });
  return {
    text: html`✓ Done: ${title(`“${task.summary}”`)}.`.toString(), mode: 'done', html: true,
    options: ['High five! 🙌', 'Glad that’s over 😮‍💨', 'OK'],
    ref: { kind: 'done', taskId: task.id, category: task.category },
  };
}

// A bare list of list-positions — "3", "1 2 3", "1,2,3", "#1, #2" (commas and/or spaces, optional #).
// Returns the de-duped positions, or null when the text isn't purely numbers (so "done laundry" still
// falls through to matching by name).
function parsePositionList(s) {
  const trimmed = (s || '').trim();
  if (!/^#?\d+(?:\s*[,\s]\s*#?\d+)*$/.test(trimmed)) return null;
  return [...new Set(trimmed.split(/[,\s]+/).map((x) => Number(x.replace(/^#/, ''))))];
}

// A typed position that maps to nothing on the last list → steer the user back to a fresh, numbered list.
function noListingReply(total, kind = 'task') {
  const cmd = kind === 'note' ? '/notes' : kind === 'list' ? '/lists' : '/tasks';
  return total
    ? `That number isn't on the list — I showed ${total}. Run ${cmd} to see them again.`
    : `I don't have a current list to number against. Run ${cmd} first, then pick a number.`;
}

// ── Task templates: a saved blueprint (a task's shape + step checklist) re-created on demand by name — the
// calm alternative to recurring tasks. Reuses repo's saveTemplate / materializeTemplate / … (see repo.js).
const TEMPLATE_USAGE = 'Templates reuse a task without it repeating on a schedule. Save one from your list: “/template 3 weekly-review” (item 3). Start a fresh copy anytime: “/template weekly-review”. See yours with “/templates”, or “guide templates”.';
const stepCountLabel = (n) => (n ? ` (${n} step${n === 1 ? '' : 's'})` : '');

function templatesListReply(userId) {
  const rows = listTemplates(userId);
  if (!rows.length) return 'No templates yet. Save one from your list: “/template 3 weekly-review” saves item 3 — then start a fresh copy anytime with “/template weekly-review”.';
  const lines = rows.map((tpl) => `• ${tpl.name} — “${tpl.summary}”${stepCountLabel(parseSteps({ steps_json: tpl.steps_json }).length)}`);
  return `🗂 Your templates:\n${lines.join('\n')}\n(“/template <name>” → a fresh copy · “/template retire <name>” → remove)`;
}

function saveTemplateReply(userId, pos, name) {
  const { pairs, total } = resolveListing(userId, 'task', [pos]);
  if (!pairs.length) return noListingReply(total, 'task');
  const res = saveTemplate(userId, pairs[0].id, name || getTask(userId, pairs[0].id)?.summary || '');
  if (!res) return 'I couldn’t save that one — it may have moved off your list.';
  return `🗂 ${res.overwrote ? 'Updated' : 'Saved'} template “${res.template.name}”${stepCountLabel(res.stepCount)}. Start a fresh copy anytime: “/template ${res.template.name}”.`;
}

async function loadTemplateReply(userId, name) {
  const task = materializeTemplate(userId, name);
  if (!task) return `No template called “${name.trim()}”. See your saved ones with “/templates”.`;
  await embedTask(task);
  recordUndo(userId, 'task_capture', { taskId: task.id }, `↩ Undid that — the fresh “${task.summary}” copy is gone.`);
  const n = parseSteps(task).length;
  return logged(`📋 Fresh copy on your list:\n${filedLine(task)}${n ? `${stepCountLabel(n)} — say “start” to walk through it.` : ''}`);
}

function retireTemplateReply(userId, name) {
  return deleteTemplate(userId, name) ? `Retired the “${name.trim()}” template.` : `No template called “${name.trim()}”.`;
}

// Batch finish/start: mark several tasks at once and report what landed vs. what was missing — by the
// position the user typed (resolved upstream to {pos,id} pairs), never a DB id. `missing` are positions
// that pointed past the end of the last list. Skips the per-task "how did that feel?" prompt.
function transitionTasks(userId, pairs, status, missing = []) {
  const hit = []; const gone = [...missing]; const items = [];
  for (const { pos, id } of pairs) {
    const before = getTask(userId, id);
    const task = setTaskStatus(userId, id, status);
    if (!task) { gone.push(pos); continue; }
    const outcomeId = status === 'done' ? logOutcome(userId, task, 'done') : null;
    if (before && before.status !== status) items.push(statusItem(before, status, outcomeId));
    hit.push(task);
  }
  if (items.length) {
    const titles = hit.map((x) => `“${x.summary}”`).join(', ');
    recordUndo(userId, 'task_status', { items }, status === 'done'
      ? `↩ Not done after all — ${titles} back on your list.`
      : `↩ Unstarted ${titles} — back on your list.`);
  }
  if (hit.length && status === 'done') rebuildDossier(userId);
  const verb = status === 'in_progress' ? '▶ Started' : '✓ Done';
  const parts = [];
  if (hit.length) parts.push(`${verb}: ${hit.map((x) => `“${x.summary}”`).join(', ')}.`);
  if (gone.length) parts.push(`Couldn't find #${gone.sort((a, b) => a - b).join(', #')}.`);
  return parts.join(' ') || 'I couldn’t find any of those tasks.';
}

// Batch /drop: archive several tasks and log each as "dropped" — reported by typed position, not DB id.
function dropTasks(userId, pairs, missing = []) {
  const removed = []; const gone = [...missing]; const items = [];
  for (const { pos, id } of pairs) {
    const before = getTask(userId, id);
    const task = setTaskStatus(userId, id, 'archived');
    if (!task) { gone.push(pos); continue; }
    const outcomeId = logOutcome(userId, task, 'dropped');
    if (before && before.status !== 'archived') items.push(statusItem(before, 'archived', outcomeId));
    removed.push(task);
  }
  if (items.length) {
    recordUndo(userId, 'task_status', { items },
      `↩ Put ${removed.map((x) => `“${x.summary}”`).join(', ')} back on your list.`);
  }
  const parts = [];
  if (removed.length) parts.push(`Removed ${removed.map((x) => `“${x.summary}”`).join(', ')} from your list.`);
  if (gone.length) parts.push(`Couldn't find #${gone.sort((a, b) => a - b).join(', #')}.`);
  return parts.join(' ') || 'I couldn’t find any of those tasks.';
}

// The note-inbox mirror of dropTasks: forget one OR several notes by listing position ("/forget 1 2 3").
// Each id was resolved up front, so deleting them in a loop can't renumber the ones still to go.
function deleteNotes(userId, pairs, missing = []) {
  const gone = [...missing];
  let removed = 0;
  for (const { pos, id } of pairs) { if (deleteNote(userId, id)) removed += 1; else gone.push(pos); }
  if (!removed) return "Those notes are gone now.";
  const head = removed === 1 ? '🗑 Deleted that note.' : `🗑 Deleted ${removed} notes.`;
  const tail = gone.length ? ` Couldn't find #${gone.sort((a, b) => a - b).join(', #')}.` : '';
  return head + tail;
}

// Does this statement look like it ACTS ON an existing task ("let's do the lawnmower one") rather than
// creating a new one? Returns the single open task it clearly points to, else null.
const ACTION_RE = /^(let'?s|lets|i'?ll|i\s+will|let\s+me|start|do|work\s+on|tackle|finish|knock\s+out|get\s+to|try)\b/;
function referencedTask(userId, text) {
  const s = (text || '').trim().toLowerCase();
  if (!(ACTION_RE.test(s) || /\bthe\b.+\bone\b/.test(s))) return null;
  const ref = s
    .replace(/^(let'?s|lets|i'?ll|i will|let me|please)\s+/, '')
    .replace(/^(do|start|tackle|work on|finish|knock out|try|get to)\s+/, '')
    .replace(/\b(the|a|an|one|that|this)\b/g, ' ').trim();
  const words = ref.split(/\s+/).filter((w) => w.length > 3);
  if (!words.length) return null;
  const open = listTasks(userId).filter((x) => x.status === 'available' || x.status === 'in_progress');
  const matches = open.filter((x) => { const sum = x.summary.toLowerCase(); return words.some((w) => sum.includes(w)); });
  return matches.length === 1 ? matches[0] : null; // only when it's unambiguous
}

async function captureSnippet({ userId, text, channel, messageId, snapshotId, imageId = null, isOn = null }) {
  // A photo is new content — never read its caption as a reference to an existing task. (Text-only
  // statements still get the "did you mean…?" guard against filing a near-duplicate.)
  if (imageId == null) {
    const refd = referencedTask(userId, text);
    if (refd) {
      setDialogState(userId, { type: 'task_reference', prompt: refd.summary, data: { taskId: refd.id, text } });
      return { text: `Did you mean “${refd.summary}”?`, mode: 'confirm', options: ['start it', 'mark it done', 'no, it’s new'] };
    }
  }
  // Only let a "note …" prefix become a note when Notes is actually on for this person. When it's off — opted
  // out, or disabled system-wide (then this fall-through is the ONLY way "note …" reaches here) — it files as a
  // task, so a disabled module never silently captures. isOn null (direct callers) keeps the default behavior.
  const allowNotes = isOn ? isOn('notes') : true;
  const out = await ingest({ channel, userId, text: text.slice(0, 2000), messageId, snapshotId, imageId, allowNotes });
  // Show the photo back with its confirmation (a bare photo lands in the inbox; a captioned one files a task).
  const img = imageId != null ? getImage(userId, imageId) : null;
  if (out.kind === 'note') {
    // `kind:'note'` lets the Telegram adapter ack with a ✍️ reaction on the user's own message instead of a
    // "📝 Noted." text bubble (a bare note then carries no text at all — the reaction is the whole reply).
    return img ? { text: '📝 Noted.', photo: img.file_id, kind: 'note' } : { text: '📝 Noted.', kind: 'note' };
  }
  const line = filedLine(out.task);
  // "Alter the item you just added": a single ⋯Edit affordance on the confirmation opens the task's menu.
  const base = img ? { text: line, photo: img.file_id } : { text: line };
  base.buttons = justFiledMenu(out.task);
  // If the raw input looks like it belongs to an off module (a pasted checklist, a meal log…), offer to turn
  // it on — once a day, non-blocking. The task is still filed exactly as usual; the nudge only adds the offer.
  // maybeEatHint is the mirror for when Diet is already ON: a food-diary paragraph still files a task but gets
  // taught the `eat` command. The two never both fire (the nudge bails when the module is on).
  const ctx = { userId, isOn, text };
  const withNudge = isOn ? maybeEatHint(maybeModuleNudge(base, ctx), ctx) : base;
  return logged(withCalendar(withNudge, out.task));
}

async function handleTaskReference(userId, text, ds) {
  const a = referenceAnswer(text);
  const { taskId, text: original } = ds.data || {};
  clearDialogState(userId);
  if (a === 'start') return transitionTask(userId, taskId, 'in_progress');
  if (a === 'done') return transitionTask(userId, taskId, 'done');
  // "no, it's new" → file the user's original words as a fresh task.
  const out = await ingest({ channel: 'web', userId, text: (original || text).slice(0, 2000) });
  if (out.kind === 'note') return { text: '📝 Noted.', kind: 'note' };
  return logged(withCalendar({ text: filedLine(out.task), buttons: justFiledMenu(out.task) }, out.task));
}

// ── the suggestion / coaching loop (§11) ──
// Always lead with the user's OWN words (verbatim summary); the warm reason rides along only if it
// adds something beyond the title (so a paraphrase never hides what the task actually was).
function suggestionReply(rec, lead, img = null) {
  // Bold the suggested task (your own words); the learned "why" + any coaching message ride along dimmed; the
  // yes/done/no/smaller hint is a soft aside. LLM text (why/message) is escaped via the html`` interpolation.
  const head = lead ? html`${lead}\n` : raw('');
  const why = rec.why ? html` — ${em(rec.why)}` : raw('');
  const reason = rec.message && rec.message.trim() && !rec.message.includes(rec.summary) ? html`\n${rec.message.trim()}` : raw('');
  const hint = em('(“yes” to start · “done” if it’s finished · “no” · “smaller”)');
  const out = {
    text: html`💡 ${head}How about ${title(`“${rec.summary}”`)}?${why}${reason}\n${hint}`.toString(),
    html: true,
    mode: 'suggestion', options: ['yes', 'done', 'no', 'smaller'],
    // Keep the yes/done/no/smaller answers (they route through the suggestion dialog) and add one quiet
    // ⋯Edit that opens the task's action menu — editing a suggested task without breaking the dialog state.
    buttons: [
      ['yes', 'done', 'no', 'smaller'].map((o) => ({ text: o, data: o })),
      [{ text: MENU_LABELS.edit, data: `m:act:${rec.taskId}` }],
    ],
    ref: { kind: 'suggestion', taskId: rec.taskId, category: rec.category },
  };
  // Recall the photo filed with this task (if any) and present it alongside the suggestion.
  if (img) out.photo = img.file_id;
  return out;
}

async function startSuggestion(userId, { channel, energy, today = false }) {
  const e = energy || inferEnergy(userId);
  const mood = latestMood(userId, Date.now() - MOOD_WINDOW);
  const out = await suggestTask({ userId, state: { energy: e, mood, channel }, filter: today ? { today: true } : null });
  if (!out.recommendation) return out.message;
  setDialogState(userId, {
    type: 'suggestion_reaction', prompt: out.recommendation.message,
    data: { taskId: out.recommendation.taskId, eventId: out.eventId, energy: e, lastTaskId: null, phase: 'react', today },
  });
  return suggestionReply(out.recommendation, undefined, getImageForTask(userId, out.recommendation.taskId));
}

// Offer a different (optionally smaller) task, excluding the one(s) just declined. `today` keeps a
// "what's next today" session scoped to today's tasks across "smaller" / "no" follow-ups.
async function offerNext(userId, { excludeId, channel, makeSmaller, today = false }) {
  const energy = makeSmaller ? 'low' : inferEnergy(userId);
  const mood = latestMood(userId, Date.now() - MOOD_WINDOW);
  const out = await suggestTask({ userId, state: { energy, mood, channel, lastTaskId: excludeId }, exclude: excludeId != null ? [excludeId] : [], filter: today ? { today: true } : null });
  if (!out.recommendation) { clearDialogState(userId); return today ? "That's everything due today — nice work. 🌱" : "That's everything for now — nice job. 🌱"; }
  setDialogState(userId, {
    type: 'suggestion_reaction', prompt: out.recommendation.message,
    data: { taskId: out.recommendation.taskId, eventId: out.eventId, energy, lastTaskId: excludeId, phase: 'react', today },
  });
  return suggestionReply(
    out.recommendation,
    makeSmaller ? "Sure — here's a smaller one:" : undefined,
    getImageForTask(userId, out.recommendation.taskId),
  );
}

const groomCooldownClear = (task) => !task.last_groomed_at || (Date.now() - task.last_groomed_at) > GROOM_TASK_COOLDOWN;

function groomingOffer(userId, task) {
  setDialogState(userId, { type: 'grooming_choice', prompt: task.summary, data: { taskId: task.id } });
  return {
    text: `You've passed on “${task.summary}” a few times — no judgment. Want me to reword it, break it into steps, snooze it, or keep it as is?`,
    mode: 'grooming', options: ['reword', 'break it down', 'snooze', 'keep'],
  };
}

async function handleSuggestionReaction(userId, text, ds, { channel }) {
  const { taskId, eventId, lastTaskId, phase = 'react', today = false } = ds.data || {};
  const a = reactionAnswer(text);

  // Phase 'offer': after a "no" we asked "something smaller, or done for now?". The task was just turned
  // down, so it's NO LONGER something to complete — only "smaller" (or a "yes" to it) keeps going; "done
  // for now", a bare "done", "no", or anything else simply ends the session. This must run before the
  // 'complete' branch below: otherwise a typed "done" here read as 'complete' and closed the very task the
  // user had just declined (the "done for now" bug).
  if (phase === 'offer') {
    if (a === 'smaller' || a === 'affirm') return offerNext(userId, { excludeId: lastTaskId ?? taskId, channel, makeSmaller: true, today });
    clearDialogState(userId);
    return "Okay — I'm here when you want the next one. 🌱";
  }

  // "done" / "did it" completes the task being actively suggested (phase 'react').
  if (a === 'complete') {
    resolveSuggestion(userId, eventId, 'done');
    clearDialogState(userId);
    return transitionTask(userId, taskId, 'done');
  }

  if (a === 'affirm') {
    resolveSuggestion(userId, eventId, 'accepted');
    const before = getTask(userId, taskId);
    const task = setTaskStatus(userId, taskId, 'in_progress');
    if (task && before && before.status !== 'in_progress') {
      recordUndo(userId, 'task_status', { items: [statusItem(before, 'in_progress')] },
        `↩ Unstarted “${task.summary}” — back on your list.`);
    }
    clearDialogState(userId);
    return task ? `▶ Started: “${task.summary}”. You've got this. 💪` : "Hmm, I can't find that one anymore.";
  }
  if (a === 'snooze') {
    resolveSuggestion(userId, eventId, 'snoozed');
    const before = getTask(userId, taskId);
    const task = setSnoozed(userId, taskId, startOfTomorrow());
    const outcomeId = logOutcome(userId, task, 'snoozed');
    if (task && before && before.status !== 'snoozed') {
      recordUndo(userId, 'task_status', { items: [statusItem(before, 'snoozed', outcomeId)] },
        `↩ Unsnoozed “${task.summary}” — back on your list.`);
    }
    clearDialogState(userId);
    return task ? `Tucked “${task.summary}” away till tomorrow. 🌱` : 'Okay — set aside.';
  }
  if (a === 'stop') { clearDialogState(userId); return "Sounds good — I'm here when you want the next one. 🌱"; }
  if (a === 'smaller') return offerNext(userId, { excludeId: taskId, channel, makeSmaller: true, today });
  if (a === 'refuse') {
    resolveSuggestion(userId, eventId, 'refused');
    const t = incrementRefusal(userId, taskId);
    logOutcome(userId, t, 'refused');
    if (t && (t.refusal_count || 0) >= GROOM_THRESHOLD && groomCooldownClear(t)) return groomingOffer(userId, t);
    // Coach: ask, don't immediately push another one.
    setDialogState(userId, {
      type: 'suggestion_reaction', prompt: 'smaller or done?',
      data: { taskId, eventId: null, energy: ds.data?.energy, lastTaskId: taskId, phase: 'offer', today },
    });
    return { text: "Okay, that's fine. Want something smaller, or done for now?", mode: 'suggestion', options: ['something smaller', 'done for now'] };
  }
  // An "answer" we couldn't parse → gentle re-prompt, stay armed.
  return { text: 'Want to start it, try something smaller, or done for now?', mode: 'suggestion', options: ['yes', 'smaller', 'done'] };
}

async function handleGroomingChoice(userId, text, ds) {
  const task = getTask(userId, ds.data?.taskId);
  if (!task) { clearDialogState(userId); return "That one's gone now."; }
  const choice = groomingAnswer(text);
  clearDialogState(userId);

  if (choice === 'refine') {
    const reworded = await llmRefine(task);
    setGroomed(userId, task.id); resetRefusal(userId, task.id);
    if (reworded) { const t = updateTaskSummary(userId, task.id, reworded); await embedTask(t); return { text: html`Reworded it: ${title(`“${reworded}”`)}. Fresh start. 🌱`.toString(), html: true }; }
    return { text: html`Kept ${title(`“${task.summary}”`)} — couldn't improve the wording just now, but I reset the count.`.toString(), html: true };
  }
  if (choice === 'decompose') {
    const steps = await llmDecompose(task);
    setGroomed(userId, task.id);
    if (steps) {
      for (const s of steps) { const child = insertTask({ userId, summary: s, category: task.category, effortLevel: 'low' }); await embedTask(child); }
      setTaskStatus(userId, task.id, 'archived');
      return { text: `Broke it into ${steps.length} smaller steps:\n${steps.map((s) => `• ${esc(s)}`).join('\n')}`, html: true };
    }
    resetRefusal(userId, task.id);
    return `Kept “${task.summary}” — couldn't break it down just now, but I reset the count.`;
  }
  if (choice === 'snooze') {
    setSnoozed(userId, task.id, inAWeek());
    const outcomeId = logOutcome(userId, task, 'snoozed');
    recordUndo(userId, 'task_status', { items: [statusItem(task, 'snoozed', outcomeId)] },
      `↩ Unsnoozed “${task.summary}” — back on your list.`);
    return `Snoozed “${task.summary}” for a week. 🌱`;
  }
  if (choice === 'archive') {
    setTaskStatus(userId, task.id, 'archived');
    const outcomeId = logOutcome(userId, task, 'dropped');
    recordUndo(userId, 'task_status', { items: [statusItem(task, 'archived', outcomeId)] },
      `↩ Put “${task.summary}” back on your list.`);
    return `Removed “${task.summary}” from your list.`;
  }
  setGroomed(userId, task.id); // keep / unrecognized → leave as is, just back off
  return `Kept “${task.summary}” as is. 🌱`;
}

// The quiet sentiment buttons after a completion — High five / Glad that's over / OK → learning signal.
function handleDoneFeedback(userId, text, ds) {
  const fb = feedbackAnswer(text);
  clearDialogState(userId);
  if (fb && ds.data?.outcomeId) updateOutcomeSentiment(userId, ds.data.outcomeId, fb);
  if (fb === 'highfive') return 'High five! 🙌';
  if (fb === 'relief') return 'Glad that’s behind you. 🌱';
  // A shrug/ok has nothing to say back — ack as a 🌱 REACTION on the user's message, not an emoji-only
  // bubble (which Telegram renders huge). The text only shows where no reaction can land (a tapped "OK"
  // chip has no user message to react to), so it carries a word to keep it from rendering as jumbo emoji.
  return { text: 'Okay. 🌱', kind: 'ack', ackEmoji: '🌱' };
}

// "Stepping" — armed when a task with steps is started. While it's open, the next message ticks steps off:
// "done" → the next open step · "done 2 3" → those steps · "done all" → all of them; "step …" adds another;
// "stop"/"pause" leaves without finishing. Ticking the last step (or "done all") completes the parent task,
// reusing transitionTask's normal "how did that feel?" flow. Anything non-step escapes upstream
// (answersPendingState), so a new task / a question / "/tasks" just drops the session — steps stay saved.
async function handleStepping(userId, text, ds) {
  const taskId = ds.data?.taskId;
  const task = taskId ? getTask(userId, taskId) : null;
  if (!task) { clearDialogState(userId); return "That task’s gone now."; }
  // A context switch made elsewhere (web board, another channel) can pause the pinned task out from under
  // this session — if a DIFFERENT task is in progress now, don't tick the old one's steps. Two deliberate
  // exceptions keep the 🪜 Steps card honest: `edit:true` sessions (opened on purpose, any status), and
  // NOT a bare status check (the card arms this on a not-yet-started task).
  const current = startedTask(userId);
  if (!ds.data?.edit && current && current.id !== task.id) {
    clearDialogState(userId);
    return `You’re on “${current.summary}” now — “${task.summary}” isn’t in progress anymore. Its steps stay saved.`;
  }
  const s = text.trim().toLowerCase();

  // Add another step to the task you're working (numbers stay literal while focused on this one).
  if (STEP_RE.test(s)) {
    const body = stepBody(text);
    if (!body) return 'What’s the step? e.g. “step rinse the pan”.';
    const r = addTaskStep(userId, taskId, body);
    const v = stepsView(getTask(userId, taskId));
    return { text: html`✓ Step ${r.index} added to ${`“${task.summary}”`}: ${body}\n${raw(v.text)}`.toString(), buttons: v.buttons, html: true };
  }
  // Remove a step (the mirror of ticking one done): "unstep 2", "remove step 3 4", "unstep all". The list
  // re-numbers after; removing the last one leaves the task stepless and ends the session.
  if (UNSTEP_RE.test(s)) {
    const which = removeWhich(unstepArgs(text));
    if (!which) return 'Which step? e.g. “unstep 2”, or “unstep all”.';
    return stepRemovalReply(userId, taskId, removeTaskStep(userId, taskId, which), { rearm: true });
  }
  // Leave without completing — steps stay saved for next time.
  if (/^(stop|pause|cancel|exit|leave|nvm|never ?mind|not now)\b/.test(s)) {
    clearDialogState(userId);
    const left = parseSteps(task).filter((x) => !x.done).length;
    return left ? `Paused — ${left} step${left === 1 ? '' : 's'} left on “${task.summary}”. Steps stay saved.`
                : `Paused “${task.summary}”.`;
  }

  let which;
  if (/\ball\b/.test(s)) which = 'all';
  else { const pos = parsePositionList(text.replace(/^[^0-9]*/, '')); which = pos || 'next'; } // bare done → next

  const res = setStepsDone(userId, taskId, which, true);
  if (!res || res.total === 0) { clearDialogState(userId); return transitionTask(userId, taskId, 'done'); }
  if (res.allDone) {                                              // every step ticked → finish the task
    clearDialogState(userId);
    const out = await transitionTask(userId, taskId, 'done');     // done_feedback armed as usual
    const head = `✅ All ${res.total} steps done.\n`;
    return typeof out === 'string' ? head + out : { ...out, text: head + out.text };
  }
  const v = stepsView(getTask(userId, taskId));
  const note = res.changed.length
    ? `Ticked step${res.changed.length === 1 ? '' : 's'} ${res.changed.join(', ')}.`
    : 'Those were already ticked.';
  return { text: `${note}\n${v.text}`, buttons: v.buttons, html: true };
}

// Turn an LLM provider error into a short, human reason for why a call failed — so "/guess" can name the
// cause (quota, key, server) rather than hiding it. The provider's own message (e.g. "prepayment credits are
// depleted") rides through on the Error, so we key off both the HTTP status and recognizable wording.
function describeLlmError(err) {
  const status = err?.status;
  const m = (err?.message || '').toLowerCase();
  if (status === 429 || /quota|credit|exhaust|rate.?limit|resource_exhausted|billing/.test(m)) return 'it’s out of credits or rate-limited right now';
  if (status === 401 || status === 403 || /api key|unauthor|forbidden|permission/.test(m)) return 'the API key was rejected';
  if (status === 404 || /no longer available|not found|not_found|is not supported|unknown model/.test(m)) return 'that model id is retired or wrong — update it in Settings';
  if (status >= 500 || /timeout|timed out|econn|fetch failed|network/.test(m)) return 'the provider isn’t responding';
  return 'it’s unavailable right now';
}

// "/guess" — let the LLM break the task you're working on into a checklist, saved on the task so the normal
// stepping flow ("done" / "done 2" / "done all") can walk it. `task` is already resolved + owned. If it already
// has steps we DON'T re-ask the model — just re-open the checklist (idempotent, cheap). Returns a { text,
// buttons } card (step toggles), or a plain string when the model couldn't help.
//
// This is the ONE place Fanad lets the model SYNTHESIZE from its training rather than the user's own data
// (synthesize:true). That's a deliberate break from the "grounded in your data" thesis — so it's surfaced as
// a plainly-labeled guess the user edits freely (add with "step …", remove with "unstep 2"), never as fact.
async function guessSteps(userId, task) {
  const had = parseSteps(task).length;
  if (!had) {
    let guessed;
    try {
      guessed = await llmDecompose(task, { synthesize: true });
    } catch (err) {
      // The model itself was unavailable (out of credits, rate-limited, bad key, unreachable) — say so plainly
      // instead of a vague "couldn't guess", so a billing/quota problem isn't mistaken for "the model can't help".
      return `Couldn’t reach the model to break that down — ${describeLlmError(err)}. Your task is untouched; try “/guess” again later, or add your own: “step <text>”.`;
    }
    if (!guessed) return `I couldn't guess steps for “${task.summary}” just now — you can add your own: “step <text>”.`;
    for (const s of guessed) addTaskStep(userId, task.id, s);
  }
  const steps = parseSteps(getTask(userId, task.id));
  // Guessing for a task that ISN'T in progress (e.g. via the 🪜 Steps card or ✓ Filed's 💡 button) is an
  // edit-mode session — flag it so handleStepping's staleness guard doesn't drop it while another task runs.
  setDialogState(userId, { type: 'stepping', data: { taskId: task.id, ...(task.status !== 'in_progress' ? { edit: true } : {}) } });
  const head = had
    ? html`${title(`“${task.summary}”`)} already has ${steps.length} step${steps.length === 1 ? '' : 's'}:`
    : html`💡 A guess at the steps for ${title(`“${task.summary}”`)} (my own best guess, not from your notes — edit freely):`;
  const hint = '\nTick off with “done” / “done 2” / “done all” · add “step …” · remove “unstep 2”.';
  return { text: html`${head}\n${raw(stepsChecklist(steps))}${hint}`.toString(), buttons: stepsKeyboard(task.id, steps), html: true };
}

// The "/guess" command: act on the task you most recently started. Guides you if nothing's in progress.
async function guessStepsReply(userId) {
  const ip = startedTask(userId);
  if (!ip) return 'Nothing’s started yet — start a task first (e.g. “/start 3”), then “/guess” breaks it into steps.';
  return guessSteps(userId, ip);
}

// The second step of /requestdeletion. Only an explicit "delete" word erases; "cancel" — or escaping with
// any other message (handled upstream in answersPendingState) — leaves everything untouched. On confirm:
// optionally archive a copy first (retention), then wipe the DB. The reply is marked `ephemeral` so it is
// NOT persisted — we just erased the whole thread and won't write a fresh row back into it. The user's own
// "delete" message was recorded at the top of route() and is wiped by the purge here, so the slate is truly
// clean. We then remind them to also clear their side of the chat (Telegram keeps copies on both ends).
async function handleDeleteConfirm(userId, text, _ds, { channel } = {}) {
  clearDialogState(userId);
  if (deleteConfirmAnswer(text) !== 'confirm') return 'Okay — nothing was deleted. Your data is safe. 🌱';

  let kept = '';
  if (getRetentionConfig().enabled) {
    try {
      const res = archiveUserData(userId);
      kept = `\n\n🗄 Retention is on, so a copy was archived first (${res.files} files · ${Math.round(res.bytes / 1024)} KB) in your folder.`;
    } catch (err) {
      console.warn('[requestdeletion] retention export failed:', err?.message || err);
      kept = '\n\n⚠️ Retention is on, but the backup export failed — I went ahead with the deletion anyway.';
    }
  }
  deleteAllUserData(userId);

  // Every channel keeps its own copy of the conversation until the user clears it — something I can't do
  // for them. The per-channel wording lives with the rest of the copy (shared/copy.js), not in the brain.
  const reminder = DELETION_CHANNEL_REMINDER[channel] || DELETION_CHANNEL_REMINDER.web;

  return {
    text: `🧹 Done. Your tasks, notes, messages, moods, metrics, reminders, templates, and everything I’d learned are erased. `
      + `I’m not even saving this message.${kept}${reminder}`,
    ephemeral: true,
  };
}

const DIALOG_HANDLERS = {
  ...featureDialogHandlers(), // module-owned dialogs (meal_confirm → features/metrics.js)
  suggestion_reaction: handleSuggestionReaction,
  grooming_choice: handleGroomingChoice,
  task_filter: handleTaskFilter,
  done_feedback: handleDoneFeedback,
  task_reference: handleTaskReference,
  stepping: handleStepping,
  delete_confirm: handleDeleteConfirm,
  ha_token_confirm: handleHaTokenConfirm,
  list_nav: handleListNav,
};

// ── LLM-intent dispatch: a QUESTION maps to a command ──
// ── Notebooks — a personal, isolated "second space" (its own tasks, notes, lists — everything), like a fresh
// account you can switch into and back out of. A notebook is a sub-user OWNED by you (repo.createNotebook);
// switching just points your turns at it (repo.effectiveUserId). Every notebook command acts on your IDENTITY
// account (the owner of the set), never the notebook you're currently in — so "notebook main" always brings you
// home and notebooks never nest. Gated by the per-person "notebook" opt-in (a shared preference, so every
// notebook inherits your module choices). Isolation is inherited: a sub-user carries no channel identity, so
// nothing but you can resolve to it, and every row stays user_id-scoped (see repo.effectiveUserId guardrails).
const NOTEBOOK_MAIN_WORDS = /^(main|default|home|exit|out|none)$/i;
const notebookLabel = (nb) => `📓 ${nb.notebook_name}`;

function notebookError(code, name = '', oldName = '') {
  switch (code) {
    case 'blank': return 'Give the notebook a name: “notebook work”.';
    case 'reserved': return `“${name}” is a reserved word — pick another name (“main”, “home” and the like mean “go back to your default space”).`;
    case 'toolong': return 'That name’s a touch long — keep a notebook name under 40 characters.';
    case 'exists': return `You already have a notebook called “${name}”. Switch to it with “notebook ${name}”.`;
    case 'notfound': return `You don’t have a notebook called “${oldName}”. See yours with “notebook”.`;
    default: return 'Sorry — I couldn’t do that with your notebooks just now.';
  }
}

function notebooksHome(identityId) {
  const nbs = listNotebooks(identityId);
  const curId = getCurrentNotebookId(identityId);
  const cur = curId == null ? null : getNotebook(curId);
  const where = cur ? notebookLabel(cur) : '📖 main (your default space)';
  const lines = [
    '📓 Notebooks — a separate, private space for tasks, notes & lists.',
    `You’re in: ${where}`,
  ];
  if (nbs.length) lines.push('', ...nbs.map((n) => `• ${n.notebook_name}${n.id === curId ? ' — you’re here' : ''}`));
  else lines.push('', 'No notebooks yet. Make one just by naming it: “notebook work”.');
  const retiredCount = listRetiredNotebooks(identityId).length;
  if (retiredCount) lines.push('', `🗄 ${retiredCount} retired — “notebook retired” to see or recover them.`);
  lines.push('', 'Switch or create: “notebook <name>” · back home: “notebook main” · rename: “notebook rename <old> <new>” · hide one: “notebook retire <name>”.');
  // Chips are PLAIN commands (routed like typing them, on both channels) — skip ones too long for a callback,
  // and the one you're already in. A "back to main" chip shows only when you're inside a notebook.
  const rows = [];
  const chips = nbs
    .filter((n) => n.id !== curId && Buffer.byteLength(`notebook ${n.notebook_name}`, 'utf8') <= 60)
    .slice(0, 6).map((n) => ({ text: notebookLabel(n), data: `notebook ${n.notebook_name}` }));
  for (let i = 0; i < chips.length; i += 2) rows.push(chips.slice(i, i + 2));
  if (curId != null) rows.push([{ text: '📖 Back to main', data: 'notebook main' }]);
  return { text: lines.join('\n'), buttons: rows.length ? rows : undefined };
}

function switchToMain(identityId) {
  if (getCurrentNotebookId(identityId) == null) return { text: '📖 You’re already in your main space.' };
  clearCurrentNotebookId(identityId);
  return { text: '📖 Back in your main space. Your notebooks are kept — say “notebook” to see them.' };
}

function switchNotebook(identityId, name) {
  const existing = getNotebookByName(identityId, name);
  if (existing) {
    setCurrentNotebookId(identityId, existing.id);
    return { text: `${notebookLabel(existing)} — you’re in. This space has its own tasks, notes & lists. Say “notebook main” to head back.` };
  }
  const res = createNotebook(identityId, name);
  if (res.error) return { text: notebookError(res.error, String(name || '').trim()) };
  setCurrentNotebookId(identityId, res.notebook.id);
  return { text: `✓ Made a new notebook ${notebookLabel(res.notebook)} and switched you in — a clean space for tasks, notes & lists. “notebook main” takes you home.` };
}

// "rename <old> <new>". <old> must be an EXISTING notebook, so we match the LONGEST existing name that the
// text starts with (case-insensitively) — that way multi-word names ("weekly review") rename cleanly, and the
// remainder is the new (also possibly multi-word) name. No quoting needed for the common case.
function renameNotebookCmd(identityId, rest) {
  const r = String(rest || '').trim();
  if (!r) return { text: 'Rename a notebook: “notebook rename <old> <new>”.' };
  const low = r.toLowerCase();
  let oldName = null;
  for (const n of listNotebooks(identityId)) {
    const nm = n.notebook_name;
    const nl = nm.toLowerCase();
    if ((low === nl || low.startsWith(`${nl} `)) && (!oldName || nm.length > oldName.length)) oldName = nm;
  }
  if (oldName == null) return { text: notebookError('notfound', '', r.split(/\s+/)[0] || '') };
  const newName = r.slice(oldName.length).trim();
  if (!newName) return { text: 'Rename a notebook: “notebook rename <old> <new>”.' };
  const res = renameNotebook(identityId, oldName, newName);
  if (res.error) return { text: notebookError(res.error, newName, oldName) };
  return { text: `✓ Renamed to ${notebookLabel(res.notebook)}.` };
}

// Retire = hide (repo keeps every row; the name frees up for a fresh notebook). The whole `rest` is the
// name, so multi-word names need no quoting. Retiring the space you're in lands you back in main.
function retireNotebookCmd(identityId, rest) {
  const name = String(rest || '').trim();
  if (!name) return { text: 'Retire (hide) a notebook: “notebook retire <name>”. It’s kept — “notebook recover <name>” brings it back.' };
  const wasHere = (() => { const nb = getNotebookByName(identityId, name); return !!nb && getCurrentNotebookId(identityId) === nb.id; })();
  const res = retireNotebook(identityId, name);
  if (res.error) return { text: notebookError(res.error, name, name) };
  return {
    text: `🗄 Retired ${notebookLabel(res.notebook)}${wasHere ? ' — you’re back in your main space' : ''}. Everything in it is kept, just hidden. `
      + `“notebook recover ${res.notebook.notebook_name}” brings it back.`,
  };
}

// Recover un-hides. If a live notebook took the name meanwhile, repo brings it back as "name 2"/"name 3"…
// and we say so. Recovery doesn't switch you in — it just puts the notebook back on the shelf.
function recoverNotebookCmd(identityId, rest) {
  const name = String(rest || '').trim();
  if (!name) return retiredNotebooksList(identityId);
  const res = recoverNotebook(identityId, name);
  if (res.error) return { text: `You don’t have a retired notebook called “${name}”. See them with “notebook retired”.` };
  const nb = res.notebook;
  const text = res.renamedFrom
    ? `✓ Recovered as ${notebookLabel(nb)} — you already have a live “${res.renamedFrom}”, so it came back under a fresh name.`
    : `✓ Recovered ${notebookLabel(nb)} — it’s back in your notebooks.`;
  const rows = Buffer.byteLength(`notebook ${nb.notebook_name}`, 'utf8') <= 60
    ? [[{ text: `Switch to ${notebookLabel(nb)}`, data: `notebook ${nb.notebook_name}` }]] : undefined;
  return { text, buttons: rows };
}

function retiredNotebooksList(identityId) {
  const retired = listRetiredNotebooks(identityId);
  if (!retired.length) return { text: '🗄 No retired notebooks. Hide one with “notebook retire <name>”.' };
  const lines = ['🗄 Retired notebooks — hidden, not deleted. Recover one to bring it (and everything in it) back:', '',
    ...retired.map((n) => `• ${n.notebook_name}`)];
  // Duplicate retired names recover most-recent-first, so one chip per distinct name is enough.
  const seen = new Set();
  const chips = retired
    .filter((n) => { const k = n.notebook_name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .filter((n) => Buffer.byteLength(`notebook recover ${n.notebook_name}`, 'utf8') <= 60)
    .slice(0, 6).map((n) => ({ text: `♻️ ${n.notebook_name}`, data: `notebook recover ${n.notebook_name}` }));
  const rows = [];
  for (let i = 0; i < chips.length; i += 2) rows.push(chips.slice(i, i + 2));
  return { text: lines.join('\n'), buttons: rows.length ? rows : undefined };
}

// The full notebook command family (bare or slash), already gated ON. `rest` is everything after "notebook".
function notebookCommand(identityId, rest) {
  const r = String(rest || '').trim();
  if (!r) return notebooksHome(identityId);
  let mm;
  if ((mm = /^rename\b\s*([\s\S]*)$/i.exec(r))) return renameNotebookCmd(identityId, mm[1]);
  if ((mm = /^retire\b\s*([\s\S]*)$/i.exec(r))) return retireNotebookCmd(identityId, mm[1]);
  if ((mm = /^(?:recover|unretire)\b\s*([\s\S]*)$/i.exec(r))) return recoverNotebookCmd(identityId, mm[1]);
  if (/^retired$/i.test(r)) return retiredNotebooksList(identityId);
  if (/^(list|ls)$/i.test(r)) return notebooksHome(identityId);
  if (NOTEBOOK_MAIN_WORDS.test(r)) return switchToMain(identityId);
  return switchNotebook(identityId, r);
}

// ── /web: a one-time browser sign-in link for a chat-only user ──
// The bot already proved who you are (only authorized senders reach the brain), so it can hand you a link
// that opens the web UI signed in as YOU — no password to invent for an account you only ever use from
// Telegram or Slack. Two admin switches gate it: a Site URL (else there's no address to point at — an
// ADVANCED option in Settings → Security) and web login ON (under mode 'none' sessions are ignored and
// every web visitor acts as root — a link there would open the WRONG person's data, so refuse instead).
// Root is refused a link outright: the operator's mandatory 2FA must not be bypassable from a chat surface.
// ── "demo …": the owner's live kill switches (settings guard blob — no redeploy). "demo pause" closes every
// non-owner surface (Telegram/Slack go silent, the web API 503s); "demo freeze" stops NEW vouches only.
// Bare "demo" / "demo status" reports both switches. route() only sends the owner here, and only for these
// exact forms — "demo the new build to Sarah" still files as a task, even for the owner.
function demoCommand(arg) {
  const a = (arg || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const statusReply = () => {
    const g = getGuardConfig();
    return [
      `🛡️ Demo switches — access: ${g.demoPaused ? '⏸️ PAUSED (owner-only)' : '▶️ open'} · vouching: ${g.vouchFrozen ? '🧊 FROZEN' : '🤝 open'} · signup page: ${g.demoSignupOpen ? '🎟️ OPEN' : '🚪 closed'}`,
      'Flip them with “demo pause” / “demo resume” · “demo freeze” / “demo unfreeze” · “demo signup on” / “demo signup off”. Also in Settings → Security.',
    ].join('\n');
  };
  if (!a || a === 'status') return statusReply();
  if (a === 'pause') { setGuardConfig({ demoPaused: true }); return '⏸️ Demo paused — everyone but you is shut out (bots go silent, the web says “back soon”). “demo resume” reopens it.'; }
  if (a === 'resume' || a === 'unpause') { setGuardConfig({ demoPaused: false }); return '▶️ Demo resumed — everyone’s back in.'; }
  if (a.startsWith('freeze')) { setGuardConfig({ vouchFrozen: true }); return '🧊 Vouching frozen — no new invites until “demo unfreeze”. Existing guests are unaffected.'; }
  if (a.startsWith('unfreeze') || a.startsWith('thaw')) { setGuardConfig({ vouchFrozen: false }); return '🤝 Vouching is open again.'; }
  // The public self-signup page (routes/demo.js): visitors enter their Telegram handle and get vouched in
  // by the demo service account. OPENS a door, so it's opt-in per incident-free stretch, like the others.
  if (/^signups? on$/.test(a)) { setGuardConfig({ demoSignupOpen: true }); return '🎟️ Demo signups are OPEN — the /demo page now vouches visitors in (they show as “vouched by @demo”). “demo signup off” closes it.'; }
  if (/^signups? off$/.test(a)) { setGuardConfig({ demoSignupOpen: false }); return '🚪 Demo signups are closed — the /demo page shows “closed” and takes no requests. Existing guests keep their access.'; }
  return statusReply();
}

// Acts on the IDENTITY (a notebook is a space, not an account — sessions are only minted for identity rows).
function webReply(identityId, channel) {
  if (channel === 'web') {
    return 'You’re already in the browser 🙂 — /web is for Telegram or Slack, where it makes a one-time link that opens Fanad here, signed in as you.';
  }
  // Every chat-side reply here is one-shot informational (a link that spends itself, or a "can't do it"
  // note) — each carries a ✕ so it can be cleared from the chat log once read (anti-clutter, and the link
  // message in particular shouldn't have to linger after its token is spent).
  const close = { buttons: [[CLOSE_BTN]] };
  // Belt-and-braces beside the API's demo gate: no fresh sign-in links while the demo is paused (a paused
  // non-owner can't even reach this — authorize() drops them — but a link minted now would outlive a resume/
  // re-pause window, so refuse at the source too).
  if (getGuardConfig().demoPaused && !isOwner(identityId)) {
    return { text: '⏸️ The demo is paused right now — sign-in links are off until the host resumes it.', ...close };
  }
  // Admin-settings hints are owner-only: a null here makes route() fall through, so for everyone
  // else a "web" on an unconfigured server just files as a task (as if the surface didn't exist).
  const siteUrl = getSiteConfig().url;
  if (!siteUrl) {
    if (!isOwner(identityId)) return null;
    return { text: 'I can’t make a browser link yet — this server has no Site URL set. Add one under Settings → Security → Advanced → Site URL, then send /web again.', ...close };
  }
  if (!authModeIsSimple()) {
    if (!isOwner(identityId)) return null;
    return { text: 'Web login is off on this server, so a sign-in link wouldn’t open anyone’s account. Turn it on under Settings → Security → Login requirement, then send /web again.', ...close };
  }
  if (identityId === ROOT_USER_ID) {
    return { text: 'You’re the root operator — sign in to the web UI with your username, password, and 2FA code instead.', ...close };
  }
  const minutes = Math.round(WEB_LINK_TTL_MS / 60000);
  return {
    text: [
      '🔗 Your one-time sign-in link:',
      '',
      `${siteUrl}/web/${createWebLinkToken(identityId)}`,
      '',
      `It opens a page with one button — tap it and Fanad opens in your browser, already signed in as you. It works once and expires in ${minutes} minutes — run /web again whenever you need a fresh one.`,
    ].join('\n'),
    ...close,
  };
}

// 💻 "cmd" — mint a CLI claim token and hand back the ready-to-paste connect line for the terminal
// client. Works from ANY channel: the web session is the account's authenticated surface,
// and a Telegram/Slack DM only reaches here through authorize() — the same vouched-in identity proof
// /web itself leans on to hand out sign-in links — so bouncing chat users through the browser first
// added a hop without adding trust. The token stays shown-once, hash-stored, expiring, and revocable
// from Settings. Acts on the IDENTITY; a notebook mints for its parent account (tokens are
// account-level credentials — mintCliToken refuses notebook rows).
function cmdReply(identityId, channel) {
  const close = { buttons: [[CLOSE_BTN]] };
  // Owner opt-in (default off): no terminal tokens exist as a surface until the admin enables it.
  // Only the owner ever lands here while it's off — route()'s dispatch gate makes a non-owner's
  // "cmd" fall through to task capture (admin-settings hints are owner-only).
  if (!getAuthConfig().cliEnabled) {
    return {
      text: '💻 The terminal client is currently disabled. Enable it under Settings → Security → Terminal client tokens, then send “cmd” again.',
      ...close,
    };
  }
  let token;
  try {
    token = mintCliToken(accountIdFor(identityId), { label: `via cmd (${channel}) · ${new Date().toISOString().slice(0, 10)}` });
  } catch (err) {
    return { text: `I couldn’t mint a terminal token: ${err.message}`, ...close };
  }
  const serverUrl = getSiteConfig().url || `http://localhost:${config.port}`;
  // The connect line rides in <code> so Telegram renders it monospace tap-to-copy (web shows its pill).
  return {
    text: [
      '💻 Your terminal connect command — shown ONCE (only its hash is stored):',
      '',
      code(`npx github:NTBooks/Fanad ${serverUrl} ${token}`).toString(),
      '',
      `Paste it into any terminal with Node.js 24+ installed; npx fetches the client from the repo, so no checkout or pre-downloaded source is needed. The token acts as you, chat only — never Settings — and expires in ${CLI_TOKEN_DEFAULT_TTL_DAYS} days. Manage or revoke: Settings → Security → Terminal client tokens.`,
    ].join('\n'),
    html: true,
    ...close,
  };
}

// 🔑 "token" — mint a READ-ONLY, non-expiring claim token for the sender's own account, so an outside app
// (a Home Assistant dashboard, a wall tablet) can read /api/ha/summary. Deliberately its own command, NOT
// `/cmd`: that mints a FULL, 90-day terminal-client credential; this is the safe, long-lived read credential
// dashboards actually want. Two-step by design — a warning + yes/no confirm — because the raw token arrives
// over the chat channel. Any authorized user can mint their OWN (mintCliToken is per-account, refuses
// notebook rows); the gate at the call site mirrors /cmd (owner, or the terminal client enabled).
function startHaTokenConfirm(userId) {
  const close = { buttons: [[CLOSE_BTN]] };
  if (!getAuthConfig().cliEnabled) {
    return { text: '💻 The terminal client is currently disabled. Enable it under Settings → Security → Terminal client tokens, then send “token” again.', ...close };
  }
  setDialogState(userId, { type: 'ha_token_confirm', prompt: 'mint a read-only access token?' });
  return {
    text: [
      '🔑 Mint a read-only access token?',
      '',
      'This creates a long-lived token that lets an outside app (like a Home Assistant dashboard) READ your Fanad numbers — task counts, deadlines, and any modules you have on. It:',
      '• can only read — it can never post chat or change anything,',
      '• never expires until you revoke it (Settings → Security → Terminal client tokens),',
      '• covers only YOUR data (and whichever notebook you’re in when it’s read).',
      '',
      '⚠️ Anyone who has the token can read those numbers, and it will arrive here in chat — so copy it, then delete the message.',
      '',
      'Reply “yes” to mint it, or “no” to cancel.',
    ].join('\n'),
    ...close,
  };
}

function handleHaTokenConfirm(userId, text, _ds, { channel = 'web', identityId = userId } = {}) {
  const close = { buttons: [[CLOSE_BTN]] };
  clearDialogState(userId);
  if (haTokenConfirmAnswer(text) !== 'yes') return { text: 'Okay — no token minted.', ...close };
  // Re-check the switch: the owner could have turned the terminal client off between the prompt and the reply.
  if (!getAuthConfig().cliEnabled) return { text: '💻 The terminal client is disabled now — nothing minted.', ...close };
  let token;
  try {
    token = mintCliToken(accountIdFor(identityId), { label: `read-only via chat (${channel}) · ${new Date().toISOString().slice(0, 10)}`, ttlDays: 0, scope: 'read' });
  } catch (err) {
    return { text: `I couldn’t mint a token: ${err.message}`, ...close };
  }
  const serverUrl = getSiteConfig().url || `http://localhost:${config.port}`;
  return {
    text: [
      '🔑 Your read-only token — shown ONCE (only its hash is stored):',
      '',
      code(token).toString(),
      '',
      `Point a dashboard at ${serverUrl}/api/ha/summary with the header  Authorization: Bearer <token>. It never expires and can only read. Revoke anytime: Settings → Security → Terminal client tokens. Copy it now, then delete this message.`,
    ].join('\n'),
    html: true,
    ...close,
  };
}

async function dispatchIntent(intent, args, { userId, t, channel, energy, isOn, moduleAvailable = () => true }) {
  switch (intent) {
    case 'whatdo': return startSuggestion(userId, { channel, energy, today: /\btoday\b/i.test(args.text || t) });
    case 'summary': return summarize(userId, (args.timeframe || 'this week').replace(/\s+/g, '_')).narrative;
    case 'tasks': return listTasksReply(userId, taskFilterAnswer(args.text || ''));
    case 'notes': return moduleAvailable('notes') ? (isOn('notes') ? notesReply(userId) : offerOn('notes')) : startSuggestion(userId, { channel, energy });
    case 'recall': return moduleAvailable('notes') ? (isOn('notes') ? recallReply(userId, args.text || t) : offerOn('notes')) : startSuggestion(userId, { channel, energy });
    case 'mood_set': return setMood(userId, args.emoji || t, channel);
    case 'done': { const task = captureSnippetWords(userId, args.text || t); return task ? transitionTask(userId, task.id, 'done') : 'Which one? Try /tasks, then “done <number>”.'; }
    case 'start': { const task = captureSnippetWords(userId, args.text || t); return task ? transitionTask(userId, task.id, 'in_progress') : 'Which one? Try /tasks, then “start <number>”.'; }
    default: return startSuggestion(userId, { channel, energy });
  }
}

// `userId` is the EFFECTIVE user (the current notebook's sub-user, or the identity when in the main space) —
// what every data/dialog/mood/capture call scopes to. `identityId` is the real channel account: the owner of
// the notebook set, and the key for the shared, per-person things (the module opt-ins, vouch/ownership).
// handleMessage resolves both and passes them in; tests/callers that pass only userId get identityId === userId.
async function route({ userId, identityId = userId, text, energy = null, channel = 'web', imageId = null, action = null }) {
  taskListDirty.delete(userId); // start clean; a mutation this turn re-sets it (consumed by handleMessage)
  lastUserMsg.delete(userId); // ditto — the action path below returns early, and a tap must never stamp a stale row
  // A tapped/clicked interactive button: dispatch the structured token, not a text turn (no mood snapshot,
  // no capture). The web reaches menus through here; Telegram calls handleAction directly to edit in place.
  // Hand it the IDENTITY — handleAction re-resolves the effective notebook itself (so a Telegram tap is scoped too).
  if (action) return handleAction(identityId, action, { channel });
  // The per-person module gate for this turn — read once (on the identity, so a notebook inherits your module
  // choices), passed to every command guard / help / menu builder.
  const isOn = makeIsOn(identityId);
  // Is a module even AVAILABLE to this person? isOn answers "on for you?"; moduleAvailable answers "does this
  // module exist for you at all?" — false only for a non-owner when it's disabled system-wide. The owner keeps
  // access (preview). Used to make a disabled module's commands fall through (invisible) rather than offer to
  // turn it on. A registry module is filtered out of tryFeatureCommand the same way (via ctx.moduleAvailable).
  const moduleAvailable = (name) => isOwner(identityId) || isSystemModuleOn(name);
  let t = (text || '').trim();
  if (!t && imageId == null) return '';
  let lower = t.toLowerCase();
  let m;

  // Speed Dial LOCKDOWN — an account the owner limited to speed dial reaches NOTHING but its 0-9 pad. Placed
  // ahead of the snapshot/command/capture chain so a limited person's messages never file a task or hit the
  // LLM; a bare 1-9 / "dial N" fires a slot, "0" or anything else (incl. a caption-less photo) re-shows the
  // pad — so a limited account already sees its pad on first contact. The owner is never limited. Button taps
  // take the same gate in handleAction(). (A FULL-account pad-holder's first-contact welcome rides ALONGSIDE
  // their normal reply instead of swallowing it — handleMessage, below.)
  if (isSpeedDialOnly(identityId) && !isOwner(identityId)) return speedDialGate(identityId, t);

  // (2) Capture mood/time for EVERY message (so the status chip + energy stay fresh). Reused by a capture.
  const snap = recordSnapshot({ userId, channel, text: t });
  lastUserMsg.set(userId, snap.messageId);

  // A photo with no caption: nothing to parse as a command — file it straight away (the image rides along).
  if (!t && imageId != null) {
    return captureSnippet({ userId, text: '', channel, messageId: snap.messageId, snapshotId: snap.snapshotId, imageId, isOn });
  }

  // Expand a leading single-letter shortcut into the full command, then let the rest of route() handle it
  // unchanged. Done on a COPY of the routing text (the raw was already snapshotted), before any command /
  // dialog matching below, so a shortcut behaves identically to the typed command — including escaping an
  // open question. See SHORTCUT_WITH_TEXT / SHORTCUT_BARE above for the "why only with text / why not y" rule.
  let sc;
  if ((sc = /^([a-z])\s+([\s\S]+)$/i.exec(t)) && SHORTCUT_WITH_TEXT[sc[1].toLowerCase()]) {
    t = `${SHORTCUT_WITH_TEXT[sc[1].toLowerCase()]} ${sc[2].trim()}`;
    lower = t.toLowerCase();
  } else if (SHORTCUT_BARE[lower]) {
    t = SHORTCUT_BARE[lower];
    lower = t;
  }

  // A bare "c" (or /menu) always pops the tappable command menu — even mid-question, so it escapes and
  // clears any open prompt rather than being read as that prompt's answer. (The text command reference is
  // "/commands", handled below alongside /help.)
  if (lower === 'c' || lower === '/c' || lower === '/menu') {
    clearDialogState(userId);
    return commandMenu(isOn);
  }

  // Bare "tasks"/"todos" (no slash) === "/tasks": ALWAYS show the list — never the "Projects" (task) CATEGORY,
  // and never an answer to an open prompt. The word IS the command's name; reading it as a one-category filter
  // (its plural collides with the 'task' category key, so taskFilterAnswer("tasks") → {category:'task'}) was the
  // "I said 'tasks' and got a slice" bug. Matched here, ahead of the dialog/bare-word guard, so it escapes just
  // like "/tasks". The category stays reachable via its chip or "/tasks projects" — the chip sends the key
  // 'task' (singular), which is deliberately NOT caught here, so the overview's narrowing still works.
  if (lower === 'tasks' || lower === 'todos' || lower === 'to-dos' || lower === 'to dos') {
    clearDialogState(userId);
    return listTasksReply(userId);
  }
  // Same treatment for bare "notes" (no slash) === "/notes": show the inbox, never file a junk task called
  // "notes". ("note" singular is left alone — it's the /note capture verb.)
  if (lower === 'notes' && moduleAvailable('notes')) {
    clearDialogState(userId);
    return isOn('notes') ? notesReply(userId) : offerOn('notes');
  }
  // "undo" — take back the last undoable thing (server/undo.js pops the undo stack; empty stack earns the
  // "can't undo" note). Matched HERE, ahead of the open-question check, because the canonical moment to type
  // it is right after a "done"/"snoozed" reply has armed a dialog — it must escape that question, never be
  // read as its answer. Core, not a module: what it reverts spans capture, tasks, diet, metrics, timers.
  if (lower === 'undo' || lower === '/undo') {
    clearDialogState(userId);
    const u = undoCommand(userId);
    if (u.tasksChanged) taskListDirty.add(userId); // a hanging task list refreshes in place after the revert
    return u.reply;
  }

  // ── Lists — a nestable outliner, separate from tasks/notes. Handled HERE, before the open-question check, so
  // a list-navigation command works WHETHER OR NOT a dialog is open: a slash command escapes any open question
  // anyway, and these re-arm the list_nav dialog + cursor themselves. Reading the cursor here (before the
  // dialog-escape branch below) is why /sub_N / /list still know which list is open. Bare "lists" === "/lists".
  // When the Lists feature is off, every list command shape gets the gentle off-note instead.
  if (!isOn('lists') && moduleAvailable('lists')
      && (lower === '/lists' || lower === 'lists' || lower === '/list' || /^\/list\s/i.test(lower) || /^\/sub(?:[\s_]|$)/i.test(lower))) {
    clearDialogState(userId);
    return offerOn('lists');
  }
  // The real list handlers below carry an isOn('lists') gate so that when Lists is disabled system-wide (the
  // guard above is skipped, moduleAvailable false) they fall through instead of running for an unavailable
  // module. When Lists is merely off-for-you the guard above already returned the offer before reaching here.
  if ((lower === '/lists' || lower === 'lists') && isOn('lists')) { clearDialogState(userId); return listsHome(userId); }
  // /sub_N — descend into item N (a tappable "/sub_N" link sits on every list row); "/sub_N <text>" quick-adds
  // a child under item N without descending. "/sub" · "/sub 2" · "/sub_2" · "/sub2" all parse; bare "/sub" guides.
  if (isOn('lists') && /^\/sub(?:[\s_]|$)/i.test(lower)) {  // /sub · /sub_1 · /sub 1 · /sub_1 milk — but not /subway
    if ((m = /^\/sub[\s_]*#?(\d+)(?:\s+([\s\S]+))?$/i.exec(t))) {
      const extra = (m[2] || '').trim();
      return extra ? subAddReply(userId, Number(m[1]), extra) : listDescend(userId, Number(m[1]));
    }
    return 'Open a list first: /lists, then tap a “/sub_N” link (or “/sub 1”) to go into item 1.';
  }
  // /list <name> — create a list: a new top-level list, or (when a list is open) an item inside it. Bare "/list"
  // just opens the lists hub. (/list used to alias /tasks; /tasks covers that, so the name is the outliner's now.)
  if (lower === '/list' && isOn('lists')) { clearDialogState(userId); return listsHome(userId); }
  if (isOn('lists') && (m = /^\/list\s+([\s\S]+)$/i.exec(t))) return addListItemReply(userId, m[1].trim());

  // (3) Open question? A statement answers it; a question / new command escapes it.
  const ds = getDialogState(userId);
  if (ds) {
    // Escaping (or expiring) a list_nav dialog leaves list mode → drop the cursor too, so a later bare "out"/
    // "top" isn't read against a list you've walked away from. (List commands above re-arm both, so they're safe.)
    if (dialogIsStale(ds)) { clearDialogState(userId); if (ds.type === 'list_nav') clearListCursor(userId); }
    else if ((await answersPendingState(ds, t)) === 'answer') return DIALOG_HANDLERS[ds.type](userId, t, ds, { channel, energy, identityId, isOn, offerOn });
    else { clearDialogState(userId); if (ds.type === 'list_nav') clearListCursor(userId); }
  }

  // (4) Explicit slash / keyword commands — deterministic, never hit the LLM.
  // PRINCIPLE: the leading "/" is an OPTIONAL prefix — it never changes WHAT a command does. Its only
  // jobs are to escape an open question (step 3 above) and to aid discovery. So "/sleeping" === "sleeping",
  // "/mood 🙂" === "mood 🙂", "/done 3" === "done 3". A new command MUST accept both forms identically.
  // Telegram auto-sends a bare "/start" the first time someone opens the bot (the Start button). A
  // brand-new user (no tasks yet) gets onboarding — the rules + how to fill Fanad; a returning user gets
  // the command list. ("/start 3" starts task 3 — matched by the done|finish|start regex further down.)
  if (lower === '/start') return listTasks(userId).length ? commandsHub(isOn) : START;
  // Topic guides — a deep walkthrough of one feature, "guide <topic>" (the "<topic> guide" word-order works
  // too, but only when <topic> is a real guide, so "travel guide" still files as a task). Each resolved
  // guide is one short panel with a "‹ All topics" footer; an unknown topic drops back to the hub.
  if ((m = /^\/?guide\s+(.+)$/i.exec(t)) || ((m = /^(.+?)\s+guide$/i.exec(t)) && guideFor(m[1]))) {
    const key = guideKey(m[1]);
    if (key && !guideTopicOn(key, isOn)) return moduleAvailable(key) ? offerOn(key) : commandsHub(isOn); // a gated guide whose module is off; a module disabled system-wide has no guide to show (non-owner) → the hub
    const text = guideFor(m[1]);
    if (text) return richDoc(text, { buttons: GUIDE_BACK });
    const topics = liveGuideTopics(isOn);
    return { text: `No guide called “${m[1].trim()}” yet. I have: ${topics.join(', ')}. Tap one:`, buttons: guideMenu(topics) };
  }
  // Bare "guide"/"help" (and the close help variants) pop the tappable topic hub — not a wall. Deterministic,
  // never the LLM (so an actionable task like "look up how to clear tasks" can't be mistaken for help). The
  // help variants match the WHOLE message (HELP_RE), so "help me move the couch" still files as a task.
  if (lower === '/help' || lower === 'guide' || lower === '/guide' || HELP_RE.test(t)) return guideHub(isOn);
  if (lower === '/commands' || lower === 'commands') return commandsHub(isOn); // tappable section hub (drift-guard expands the sections)
  if (lower === '/rules' || lower === 'rules') return richDoc(RULES);
  if (lower === '/howto' || lower === 'howto' || lower === 'how') return richDoc(HOWTO);
  if (lower === '/me' || lower === '/dossier') return dossierReply(userId);
  // 🔗 /web — a one-time link that opens the web UI signed in as this chat user (see webReply above).
  // A null means webReply had only an admin-settings hint to offer and the sender isn't the owner:
  // fall through, so their "web" files as a task like any other word.
  if (lower === '/web' || lower === 'web') {
    const r = webReply(identityId, channel);
    if (r) return r;
  }
  // 💻 cmd — mint a terminal-client claim token from any channel (see cmdReply above). Exact-match, so
  // "cmd to clear the cache" still files as a task — and while the surface is disabled, only the owner
  // matches at all (the enable-it hint is an admin instruction), so a non-owner's "cmd" files as a task too.
  if ((lower === '/cmd' || lower === 'cmd') && (getAuthConfig().cliEnabled || isOwner(identityId))) return cmdReply(identityId, channel);
  // 🔑 token — mint a READ-ONLY, non-expiring token for a dashboard / Home Assistant (see startHaTokenConfirm).
  // Exact-match the request phrases so "token for the parking garage" still files as a task; same enable/owner
  // gate as cmd, so a non-owner's "token" files as a task while the terminal client is off.
  if (/^\/?(?:token|newtoken|mint(?:\s+a)?\s+token|create(?:\s+a)?\s+token|new\s+token|get(?:\s+a)?\s+token)$/i.test(lower)
    && (getAuthConfig().cliEnabled || isOwner(identityId))) return startHaTokenConfirm(userId);
  // 🛡️ demo — the owner's kill switches (see demoCommand above). The tight verb list keeps "demo the new
  // build to Sarah" filing as a task; non-owners never match, so for them even "demo pause" is just a task.
  if ((m = /^\/?demo(?:\s+(pause|resume|unpause|status|freeze|unfreeze|thaw|signups?\s+on|signups?\s+off)(?:\s+vouch(?:ing|es)?)?)?\s*$/i.exec(t)) && isOwner(identityId)) {
    return demoCommand(m[1] || '');
  }
  // ── "system …": the owner's SYSTEM-WIDE module switches (global system_modules blob — no redeploy). Enable/
  // disable a module for the whole deployment (release over time, or gate one). Only the exact forms match, and
  // only for the owner — "system is slow" still files as a task. Same board also lives in Settings → Modules.
  if ((m = /^\/?system(?:\s+(status|(?:enable|disable|on|off)\s+.+))?\s*$/i.exec(t)) && isOwner(identityId)) {
    return systemCommand(m[1] || '');
  }
  // ── Per-user modules: turn an optional surface on/off for yourself (all default off; Tasks is always on).
  // "modules" shows the current state with tap-to-toggle; "optin lists" / "optout metrics" flip one. Opt-out
  // HIDES, never deletes — the data is kept and re-appears on the next opt-in. The slash is optional as usual.
  // Module on/off + the modules screen are PER-PERSON (the opt-ins are shared across your notebooks), so they
  // act on the identity — not whichever notebook you're currently in.
  if (lower === '/modules' || lower === 'modules' || lower === '/module' || lower === 'module') return modulesReply(identityId, isOn);
  if ((m = /^\/?opt[\s-]?in\b\s*(.*)$/i.exec(t))) return optModuleCmd(identityId, m[1], true);
  if ((m = /^\/?opt[\s-]?out\b\s*(.*)$/i.exec(t))) return optModuleCmd(identityId, m[1], false);
  // "vouch @username" — whitelist someone by endorsement (any authorized user; record kept). Bare "vouch"
  // lists who you've vouched in. "/" optional like every command; "\b" so "vouchsafe …" still files as a task.
  // Gated by the Vouch toggle: when off, the access list is locked (the owner manages it in Settings only).
  if ((m = /^\/?vouch\b\s*([\s\S]*)$/i.exec(t)) && moduleAvailable('vouch')) return isOn('vouch') ? vouchCommand(identityId, m[1]) : offerOn('vouch');
  // Notebooks — switch into a separate, isolated space (its own tasks/notes/lists), or back to main. Every form
  // acts on the IDENTITY account, so it behaves the same whichever space you're in, and clears the current
  // space's open question first. The "/notebook …" (slash) form is explicit and offers to turn the module on
  // when it's off; the bare "notebook …" form only engages when the module is ON, so a task like "notebook for
  // school" still files normally for anyone who hasn't opted in. See the notebookCommand family above.
  {
    const nbSlash = /^\/notebooks?(?:\s|$)/i.test(lower);
    const nbBare = /^notebooks?(?:\s|$)/i.test(lower);
    if ((nbSlash || (nbBare && isOn('notebook'))) && moduleAvailable('notebook')) {
      if (!isOn('notebook')) return offerOn('notebook'); // only reachable via the explicit slash form
      clearDialogState(userId);
      return notebookCommand(identityId, t.replace(/^\/?notebooks?\b/i, ''));
    }
  }
  if (lower === '/tasks') return listTasksReply(userId);
  if (lower.startsWith('/tasks ')) {
    return listTasksReply(userId, taskFilterAnswer(t.replace(/^\/tasks\s+/i, '')));
  }
  // 📷 /pic N — re-send the photo attached to the Nth task on the LAST listing, captioned with its summary.
  // Tapping the "/pic_N" link on a photo-bearing row fires this; "/pic 3", "/pic_3", "/pic3" and the
  // /photo //image //img aliases all resolve here. N is a position on the current list (like /done N).
  if (/^\/(?:pic|photo|image|img)\s*$/i.test(lower)) {
    return 'Which one? Run /tasks, then tap the “📷 /pic_N” link on a task that has a photo.';
  }
  if ((m = /^\/(?:pic|photo|image|img)[\s_]*#?(\d+)\s*$/i.exec(t))) {
    const { pairs, total } = resolveListing(userId, 'task', [Number(m[1])]);
    if (!pairs.length) return noListingReply(total, 'task');
    const task = getTask(userId, pairs[0].id);
    const img = task ? getImageForTask(userId, task.id) : null;
    if (!img) return task ? `“${task.summary}” doesn’t have a photo attached.` : 'That task’s gone now.';
    return { text: `📷 ${task.summary}`, photo: img.file_id };
  }
  // 📅 /cal N — add the Nth listed task to your calendar (.ics). Tapping the "/cal_N" link on a dated row
  // fires this; "/cal 3", "/cal_3", "/cal3" and the /calendar //ical //ics aliases all resolve here. N is a
  // position on the current list (like /done N). The user makes it recur in their OWN calendar if they want.
  if (/^\/(?:cal|calendar|ical|ics)\s*$/i.test(lower)) {
    return 'Which one? Run /tasks, then tap the “📅 /cal_N” link on a task that has a date.';
  }
  if ((m = /^\/(?:cal|calendar|ical|ics)[\s_]*#?(\d+)\s*$/i.exec(t))) {
    const { pairs, total } = resolveListing(userId, 'task', [Number(m[1])]);
    if (!pairs.length) return noListingReply(total, 'task');
    const task = getTask(userId, pairs[0].id);
    if (!task) return 'That task’s gone now.';
    if (!taskEventTime(task)) return `“${task.summary}” doesn’t have a date to add — set one with “… by friday” or “… on friday 3pm”.`;
    // The Home Assistant module adds a one-tap "push it onto the HOUSE calendar" beside the .ics download
    // (only when the module is on for this user AND the owner has configured a target calendar entity).
    const haCal = isOn('homeassistant') && getHomeAssistantConfig().calendar.entity
      ? { buttons: [[{ text: '🏠 To HA calendar', data: `m:hacal:${task.id}` }]] } : null;
    return withCalendar({ text: `📅 Add “${task.summary}” to your calendar`, ...(haCal || {}) }, task);
  }
  // Page the current task slice. Only when a paged listing is actually open, so "next"/"back" aren't
  // stolen from normal use; whole-word match so "next-door fence" still files as a task.
  if (getPageState(userId) && /^\/?(next|more|prev|back|previous)$/i.test(lower)) {
    return handleListPage(userId, /^\/?(next|more)$/i.test(lower) ? +1 : -1);
  }
  // Auto-slept tasks: list them, or revive by position.
  if (lower === '/sleeping' || lower === 'sleeping' || lower === '/stale' || lower === '/dormant') return sleepingReply(userId);
  if (lower === '/revive' || lower === 'revive') return sleepingReply(userId); // bare → show the sleeping list
  if ((m = /^\/?revive\s+(.+)$/i.exec(t))) return reviveCmd(userId, m[1]);
  // Manually-snoozed tasks: list them (with wake times), or unsnooze by position.
  if (lower === '/snoozed' || lower === 'snoozed') return snoozedReply(userId);
  if (lower === '/unsnooze' || lower === 'unsnooze') return snoozedReply(userId); // bare → show the snoozed list
  if ((m = /^\/?unsnooze[\s_]+(.+)$/i.exec(t))) return unsnoozeCmd(userId, m[1]);

  // /task[:category] <text> — file a task with an explicit category and any inline metadata: a deadline
  // ("… by Friday"), an "on <when>" schedule (deadline + a one-time reminder), and a manual priority
  // ("high priority", "p1"). The verbatim text is kept; the summary is the LLM-trimmed core. A live
  // deadline lifts ranking, then retires the task to the gentle 'expired' status once it passes.
  if (/^\/task(?::[a-z]+)?\s*$/i.test(t)) return 'Try “/task buy milk” — or set a category and deadline: “/task:health dentist by friday”.';
  if ((m = /^\/task(?::([a-z]+))?\s+([\s\S]+)$/i.exec(t))) {
    const body = m[2].trim();
    // Fuzzy-match the given category word ("chores"→household, "fitnes"→health); if nothing's close, the
    // classifier (or an active lock) decides from the task text.
    const override = m[1] ? closestCategory(m[1]) : null;
    const f = await composeTaskFields({ body, userId, now: Date.now(), categoryOverride: override });
    const nowWx = currentWeather();
    const task = insertTask({
      userId, summary: f.summary, category: f.category, effortLevel: f.effortLevel,
      sourceMessageId: snap.messageId, createdWeather: nowWx ? nowWx.weather : null,
      dueAt: f.dueAt, dueKind: f.dueKind, originalText: f.originalText, llmSummary: f.llmSummary,
      priority: f.priority, remindAt: f.remindAt, linkJson: f.linkJson,
    });
    if (f.mood && !extractMood(body)) setSnapshotMood(userId, snap.snapshotId, f.mood);
    await embedTask(task);
    recordUndo(userId, 'task_capture', { taskId: task.id }, `↩ Undid that — “${task.summary}” is off your list.`);
    return logged(withCalendar({ text: filedLine(task), buttons: justFiledMenu(task) }, task));
  }

  // /today <text> (the "x" shortcut) — file a task due by the END OF TODAY. Like /task, but the deadline is
  // PINNED to today (honoring the small-hours rollover) regardless of any date words in the text — a deadline
  // only, no reminder. It then surfaces in "/tasks today" and "what's next today", and retires after midnight.
  // The slash is required (no bare "today …"): a sentence often opens with "today", so we don't hijack it.
  if (/^\/today\s*$/i.test(t)) return 'Try “/today buy milk” (or just “x buy milk”) — I’ll set it due today.';
  if ((m = /^\/today\s+([\s\S]+)$/i.exec(t))) {
    const body = m[1].trim();
    const f = await composeTaskFields({ body, userId, now: Date.now() });
    const todayDue = presetDue('today');
    const nowWx = currentWeather();
    const task = insertTask({
      userId, summary: f.summary, category: f.category, effortLevel: f.effortLevel,
      sourceMessageId: snap.messageId, createdWeather: nowWx ? nowWx.weather : null,
      dueAt: todayDue.dueAt, dueKind: todayDue.dueKind, originalText: f.originalText, llmSummary: f.llmSummary,
      priority: f.priority, remindAt: null, linkJson: f.linkJson,
    });
    if (f.mood && !extractMood(body)) setSnapshotMood(userId, snap.snapshotId, f.mood);
    await embedTask(task);
    recordUndo(userId, 'task_capture', { taskId: task.id }, `↩ Undid that — “${task.summary}” is off your list.`);
    return logged(withCalendar({ text: filedLine(task), buttons: justFiledMenu(task) }, task));
  }

  // "step <text>"     → add a step under the task you're WORKING (in progress), else the most-recent open
  //                     task (the one you just added) — same "current task" rule as unstep and /guess.
  // "step <N> <text>" → add a step under task #N on the CURRENT listing (resolveListing, like /done N).
  // "substep"/"subtask" work too. The slash form ("/step …") always escapes an open question. While a task
  // with steps is being worked, this is intercepted earlier by handleStepping (so it stays focused there).
  if (STEP_RE.test(t)) {
    const body = stepBody(t);
    if (!body) return 'Add a step: “step buy milk”. Or to a listed task: “step 2 buy milk”.';
    let targetId = null; let stepText = body; let hint = '';
    const lead = /^#?(\d+)\s+([\s\S]+)$/.exec(body);            // leading integer ⇒ a listing position
    if (lead) {
      const { pairs, total } = resolveListing(userId, 'task', [Number(lead[1])]);
      if (!pairs.length) return noListingReply(total, 'task');
      targetId = pairs[0].id; stepText = lead[2].trim();
    } else {
      const started = startedTask(userId);
      const open = listTasks(userId).filter((x) => (x.status === 'available' || x.status === 'in_progress') && !x.slept_at);
      if (!open.length) return 'No task to add a step to yet — add a task first, then “step <text>”.';
      targetId = started ? started.id : open[0].id; // working task first; else newest open (created_at DESC ⇒ [0])
      // Nothing started and several candidates → the pick was a guess; show how to aim precisely.
      if (!started && open.length > 1) hint = '\n(“step N <text>” targets task #N from /tasks.)';
    }
    const res = addTaskStep(userId, targetId, stepText);
    if (!res) return 'That task’s gone now.';
    return `✓ Step ${res.index} added to “${res.task.summary}”: ${stepText}${hint}`;
  }

  // "unstep 2" / "remove step 3 4" / "unstep all" → remove steps from the task you're working on (the most-
  // recently-started one that has steps, else the newest open task that has steps). The mirror of "done N";
  // the checklist re-numbers after. While a stepping session is open this is intercepted earlier (it stays
  // focused there); here it's the out-of-session form.
  if (UNSTEP_RE.test(t)) {
    const which = removeWhich(unstepArgs(t));
    if (!which) return 'Which step? e.g. “unstep 2”, or “unstep all”.';
    const started = startedTask(userId);
    const target = (started && parseSteps(started).length) ? started : openTasks(userId).find((x) => parseSteps(x).length);
    if (!target) return 'No task with steps to trim yet — add some with “step …”.';
    return stepRemovalReply(userId, target.id, removeTaskStep(userId, target.id, which));
  }

  // "/guess" — ask the LLM to break the task you're working on into a few first steps, saved as its checklist
  // so the normal stepping flow walks them. The slash always runs (and guides you if nothing's started); per
  // the optional-slash rule, bare "guess"/"guess steps" do the same. The looser natural phrasings ("break it
  // down") only fire when something IS in progress, so they never swallow a real task.
  if (lower === '/guess' || lower === '/guess steps' || lower === 'guess' || lower === 'guess steps') return guessStepsReply(userId);
  if ((lower === 'break it down' || lower === 'break it into steps' || lower === 'break into steps') && startedTask(userId)) {
    return guessStepsReply(userId);
  }

  // Task templates — a saved blueprint (a task's shape + step checklist) re-created on demand by name; the
  // calm alternative to recurring tasks (Fanad has none, on purpose). Number-first ⇒ SAVE the listed task;
  // a name ⇒ LOAD a fresh copy. The slash form is always explicit; the BARE form only fires when it resolves
  // (a valid position, a retire-keyword on an existing template, or an existing name), so plain speech like
  // “template my resume” still files as a task.
  if (lower === '/templates' || lower === 'templates') return templatesListReply(userId);
  if ((m = /^\/?template\s+([\s\S]+)$/i.exec(t))) {
    const rest = m[1].trim();
    const isSlash = t.startsWith('/');
    let mm;
    if ((mm = /^(?:retire|delete|remove|forget)\s+([\s\S]+)$/i.exec(rest))) {
      const nm = mm[1].trim();
      if (isSlash || getTemplate(userId, nm)) return retireTemplateReply(userId, nm);
    } else if ((mm = /^#?(\d+)(?:\s+([\s\S]+))?$/.exec(rest))) {
      const pos = Number(mm[1]);
      if (isSlash || resolveListing(userId, 'task', [pos]).pairs.length) return saveTemplateReply(userId, pos, (mm[2] || '').trim());
    } else if (isSlash || getTemplate(userId, rest)) {
      return loadTemplateReply(userId, rest);
    }
    // bare form that didn't resolve to a real position/template → fall through and capture as content.
  }
  if (lower === '/template' || lower === 'template') return TEMPLATE_USAGE;

  // Wake-up check-ins: "/wake 8:30" / "/wakelist" / "/wake off 2". Non-time text falls through to capture.
  // The slash forms are real commands, so they escape an open question instead of being read as its answer.
  if (lower === 'wake' || lower === 'wakes' || lower === '/wake' || lower === '/wakes'
      || lower === 'wakelist' || lower === '/wakelist' || /^\/?wakes?\s+/i.test(t)) {
    const out = wakeCommand(userId, t);
    if (out != null) return out;
  }

  // (4b) Opt-in feature modules (timer, metrics — server/features/). ONE fixed point in the guard chain:
  // after the dialog escape, among the explicit commands, before the done/start verbs. A module's patterns
  // are matched in registration order (features/index.js); its reply is final. Their shapes are disjoint
  // from every core matcher below by construction — verify that before moving a module's patterns here.
  {
    const hit = await tryFeatureCommand({ userId, identityId, t, lower, channel, energy, isOn, offerOn, moduleAvailable });
    if (hit) return hit.reply;
  }

  // "done 3" / "start 3" — and the tappable underscore form "/done_3" / "/start_3" on a listing row (the
  // [\s_]+ separator accepts both). The same handler resolves a position OR matches a task by name.
  if ((m = /^\/?(done|finish|start)[\s_]+(.+)$/i.exec(t))) {
    const status = /start/i.test(m[1]) ? 'in_progress' : 'done';
    const positions = parsePositionList(m[2]);
    if (positions) {
      const { pairs, missing, total } = resolveListing(userId, 'task', positions);
      if (!pairs.length) return noListingReply(total, 'task');
      // Starting is single-focus: "start 1 2 3" starts only the FIRST position — the single-active
      // invariant would silently pause each previous one anyway (accidental last-wins). The rest stay put.
      if (status === 'in_progress' && (pairs.length > 1 || missing.length)) {
        const out = await transitionTask(userId, pairs[0].id, status);
        const rest = pairs.slice(1).map((p) => `#${p.pos}`);
        const notes = [];
        if (rest.length) notes.push(`One thing at a time 🌱 — ${rest.join(', ')} stay${rest.length === 1 ? 's' : ''} on your list.`);
        if (missing.length) notes.push(`Couldn't find #${[...missing].sort((a, b) => a - b).join(', #')}.`);
        const tail = `\n${notes.join(' ')}`;
        return typeof out === 'string' ? out + tail : { ...out, text: out.text + tail };
      }
      // One item keeps the rich single-task flow ("how did that feel?"); several go batch.
      if (pairs.length === 1 && !missing.length) return transitionTask(userId, pairs[0].id, status);
      return transitionTasks(userId, pairs, status, missing);
    }
    const task = captureSnippetWords(userId, m[2]);
    if (task) return transitionTask(userId, task.id, status);
    // No matching task — and the slash is just an optional prefix, so "/done laundry" and bare "done
    // laundry" MUST agree. done/finish/start are common task VERBS, so we file the REMAINDER (m[2], the
    // text after the verb) as a new task — never a verb-named "done laundry". captureSnippet's "did you
    // mean…?" guard still fires if those words partly match an open task.
    return captureSnippet({ userId, text: m[2].trim(), channel, messageId: snap.messageId, snapshotId: snap.snapshotId, imageId, isOn });
  }
  // A bare finish/stop word (no id) closes whatever you most recently started — never files a task. Kept
  // generous on purpose: "end", "stop", "finish", "wrap up", "all set" all read as "I'm done with it",
  // since after a /start the obvious next single word is "I finished" (the "end" → filed-a-task bug).
  if (/^(?:done|did it|did that|finish|finished|finish it|complete[d]?|complete it|all done|all set|got it done|wrap(?:ped)?(?: it)?(?: up)?|that'?s (?:it|done)|i'?m done|end|ended|stop|stopped|✅|✓)\s*$/i.test(t)) {
    const ip = startedTask(userId);
    if (ip) return transitionTask(userId, ip.id, 'done');
    return "I don't see anything in progress — tell me what you finished, or ask /whatdo for a next step.";
  }
  // "unstart" — put the started task back to not-started WITHOUT finishing it. The bare form acts on the
  // single in-progress task (the single-active invariant makes "the task" unambiguous); "unstart 2" targets
  // a listing position. Never files a task — it only ever acts on something already started.
  if (/^\/?unstart\s*$/i.test(t)) {
    const ip = startedTask(userId);
    if (ip) return unstartTask(userId, ip);
    return "Nothing's in progress right now — /tasks lists what's open, “start 1” begins one.";
  }
  if ((m = /^\/?unstart[\s_]+(.+)$/i.exec(t))) {
    const positions = parsePositionList(m[1]);
    if (!positions) return 'Which one? Bare “unstart” pauses the task you started, or “unstart 2” by list position.';
    const { pairs, total } = resolveListing(userId, 'task', positions);
    if (!pairs.length) return noListingReply(total, 'task');
    const task = getTask(userId, pairs[0].id);
    if (!task) return 'That task’s gone now.';
    if (task.status !== 'in_progress') return `“${task.summary}” isn’t started — nothing to unstart.`;
    return unstartTask(userId, task);
  }

  // "/whatdo" → suggest one thing; "/whatdo today" (or any suggest-request mentioning today) scopes it to
  // tasks due by end of today. Broadened from a bare-equality check so the "today" qualifier is seen.
  if (/^\/?whatdo\b/i.test(lower) || isSuggestRequest(t)) return startSuggestion(userId, { channel, energy, today: /\btoday\b/i.test(t) });
  if (lower === '/notes' && moduleAvailable('notes')) return isOn('notes') ? notesReply(userId) : offerOn('notes');
  if (moduleAvailable('notes') && (m = /^\/recall\s+(.+)/i.exec(t))) return isOn('notes') ? recallReply(userId, m[1]) : offerOn('notes');
  // "/mood …" always; bare "mood …" only when it carries an emoji or a mood word (so "mood lighting" stays a task).
  if (lower === 'mood' || lower.startsWith('/mood') || (lower.startsWith('mood ') && extractMood(t))) {
    return setMood(userId, t.replace(/^\/?mood\b[\s:]*/i, '') || t, channel);
  }

  // Lock a category/difficulty for a run of quick adds. "/lock …" always; bare "lock …" only when the
  // rest names a real category/difficulty (so "lock the front door" still files as a task).
  if (lower === '/unlock' || lower === 'unlock') { clearTaskLock(userId); return UNLOCKED_MSG; }
  if (lower === '/lock' || lower === 'lock') return lockCommand(userId, '');
  if (lower.startsWith('/lock ')) return lockCommand(userId, t.slice(6));
  if (lower.startsWith('lock ') && parseLockTarget(t.slice(5))) return lockCommand(userId, t.slice(5));

  // HIDDEN maintenance command (deliberately absent from HELP / the menu / howto). "/remcat <category>
  // [destination]" retires <category> for good — a custom one is deleted, a built-in is hidden — and moves
  // every task in it to [destination] (default: other). Both names are fuzzy-matched; 'other' is protected
  // as the universal fallback, and you can't move a category into itself.
  if (lower === '/remcat') return 'Usage: /remcat <category> [destination] — removes the category and moves its tasks (default destination: other).';
  if ((m = /^\/remcat\s+(.+)$/i.exec(t))) {
    const parts = m[1].trim().split(/[\s,]+/).filter(Boolean);
    const from = closestCategory(parts[0]);
    if (!from || !CATEGORIES.includes(from)) return `No current category like “${parts[0]}”. Have: ${CATEGORIES.join(', ')}.`;
    if (from === 'other') return '“Other” is the catch-all — it can’t be removed.';
    const dest = parts[1] ? closestCategory(parts[1]) : 'other';
    if (!dest || !CATEGORIES.includes(dest)) return `No destination category like “${parts[1]}”. Pick one of: ${CATEGORIES.join(', ')}.`;
    if (dest === from) return 'Pick a destination different from the category you’re removing.';
    const fromLabel = catLabel(from); // capture before removal strips it from the label map
    const moved = reassignTaskCategory(from, dest);
    // Don't leave anyone locked to a key that no longer exists.
    const lk = getTaskLock(userId);
    if (lk?.category === from) { if (lk.effort) setTaskLock(userId, { effort: lk.effort }); else clearTaskLock(userId); }
    const res = removeCategory(from);
    if (!res) return `Couldn't remove “${from}”.`;
    return `🗑 Removed category “${fromLabel}” (${res.wasCustom ? 'custom' : 'built-in — hidden'}). Moved ${moved} task${moved === 1 ? '' : 's'} → ${catLabel(dest)}.`;
  }

  if (moduleAvailable('notes') && (m = /^\/promote\s+#?(\d+)/i.exec(t))) {
    if (!isOn('notes')) return offerOn('notes');
    const { pairs, total } = resolveListing(userId, 'note', [Number(m[1])]);
    if (!pairs.length) return noListingReply(total, 'note');
    const note = getNote(userId, pairs[0].id);
    if (!note) return "That note's gone now.";
    const f = await composeTaskFields({ body: note.text, userId, now: Date.now() });
    const task = insertTask({
      userId, summary: f.summary, category: f.category, effortLevel: f.effortLevel,
      dueAt: f.dueAt, dueKind: f.dueKind, originalText: f.originalText, llmSummary: f.llmSummary,
      priority: f.priority, remindAt: f.remindAt, linkJson: f.linkJson,
    });
    await embedTask(task);
    reviewNote(userId, note.id, { promotedTaskId: task.id });
    recordUndo(userId, 'task_capture', { taskId: task.id, noteId: note.id },
      `↩ Un-promoted — “${task.summary}” is off your list; the note is back in your inbox.`);
    // Carry any photo attached to the note over to the new task, so it's recalled with future suggestions.
    const img = getImageForNote(userId, note.id);
    if (img) setImageTask(userId, img.id, task.id);
    const marks = taskMarkers(task, { dueWord: true });
    return logged({ text: html`✓ Promoted to a task: ${title(`“${task.summary}”`)}.${marks ? dim(marks) : raw('')}`.toString(), buttons: justFiledMenu(task) });
  }
  // Forget note(s) by listing position — accepts several ("/forget 1 2 3"), like /drop. The slash is
  // OPTIONAL so a bare "forget 3" right after a note list acts on it — but the bare form fires ONLY when
  // the positions actually map onto the note listing, so prose like "delete 5 emails from boss" or
  // "forget to call mom" still files as a fresh note/task instead of silently deleting note 5.
  if (moduleAvailable('notes') && (m = /^(\/)?(?:forget|delete)\s+(?:notes?\s+)?(.+)$/i.exec(t))) {
    const isSlash = !!m[1];
    const positions = parsePositionList(m[2]);
    const resolved = positions ? resolveListing(userId, 'note', positions) : null;
    if (isSlash || resolved?.pairs.length) {
      if (!isOn('notes')) return offerOn('notes');
      if (!positions) return 'Which note? Run /notes, then “/forget 3” (or a few: “/forget 1 2 3”).';
      if (!resolved.pairs.length) return noListingReply(resolved.total, 'note');
      return deleteNotes(userId, resolved.pairs, resolved.missing);
    }
  }
  if ((m = /^\/drop\s+(.+)$/i.exec(t))) {
    const positions = parsePositionList(m[1]);
    if (!positions) return 'Which task? Try /tasks, then “/drop 3” (or a few: /drop 1 2 3).';
    const { pairs, missing, total } = resolveListing(userId, 'task', positions);
    if (!pairs.length) return noListingReply(total, 'task');
    return dropTasks(userId, pairs, missing);
  }

  // /requestdeletion — erase EVERYTHING we keep on this user. Destructive + irreversible, so it NEVER acts
  // on the first hit: it arms a one-shot confirm (delete_confirm dialog) and waits for the explicit word.
  // The leading "/" already escapes any other open question (answersPendingState). Any trailing args are
  // ignored — the bare command is what arms it. Documented in the Help section with the same warning.
  if (/^\/?requestdeletion\b/i.test(lower)) {
    setDialogState(userId, { type: 'delete_confirm', prompt: 'confirm full deletion' });
    return { text: DELETE_WARNING, mode: 'confirm', options: ['DELETE', 'cancel'] };
  }

  if (lower === '/summary' || lower.startsWith('/summary ')) {
    return summarize(userId, t.slice('/summary'.length).trim().replace(/\s+/g, '_') || 'this_week').narrative;
  }

  // (Metrics commands moved to features/metrics.js — matched at the (4b) registry hook above.)

  // (5) Unknown slash command (after all known ones). "/note …" is a real capture verb owned by ingest's
  // NOTE_RE in the fall-through below (so "/note buy milk" === bare "note buy milk") — let it pass.
  if (t.startsWith('/') && !/^\/note[\s:]/i.test(t)) return { text: "I don't know that one. Here's everything I can do:", buttons: commandHubMenu() };

  // (6) Greetings → canned welcome (cheap, offline-safe, before any LLM).
  if (GREETING_RE.test(t)) return WELCOME;

  // Emoji-only message → set mood, don't file a task.
  if (extractEmojis(t) && !/[a-z0-9]/i.test(t)) return setMood(userId, t, channel);

  // A bare acknowledgment with nothing pending (a stray "no"/"yes"/"ok"/"thanks") is not a task — e.g.
  // double-sending "no" used to file a task called "no". Acknowledge gently instead. A captioned image
  // still files (the photo is the content), so this only guards text-only messages.
  if (imageId == null && THANKS_RE.test(t)) return 'Anytime. 🌱';
  // Reaction-only ack (👍 on the user's own message), not an emoji-only bubble — see kind:'ack' in reaction.js.
  if (imageId == null && FILLER_RE.test(t)) return { text: '👍', kind: 'ack', ackEmoji: '👍' };

  // An EXPLICIT note ("/note …", "note …", or the expanded "n …") is a capture, never a question — even when
  // it ends in "?". Route it straight to the inbox so the trailing-"?" question heuristic can't hijack it
  // ("n call the vet?" should file, not run /whatdo). ("note" must be followed by space/colon, so "notebook"
  // and "noted it" still fall through to normal handling.) Works for a captioned photo too — captureSnippet
  // carries the imageId, and ingest files the note WITH its photo.
  if (moduleAvailable('notes') && /^\/?note[\s:]/i.test(t)) {
    if (!isOn('notes')) return offerOn('notes');
    return captureSnippet({ userId, text: t, channel, messageId: snap.messageId, snapshotId: snap.snapshotId, imageId, isOn });
  }

  // A bare list-answer word ("all", "today", "trivial", a category…) with nothing pending is almost always a
  // mis-sent reply to a list shown earlier — not a new task (the "I typed 'all' and it added a task" bug). If a
  // task list is still in view, re-apply it as a filter (the single word acts on "the last asked thing");
  // otherwise say so gently instead of filing a junk task. Real single-word tasks ("laundry", "gym") aren't
  // filter words, so taskFilterAnswer returns null for them and they still capture normally.
  if (imageId == null) {
    const fw = taskFilterAnswer(t);
    if (fw) {
      if (hasLiveList(userId)) return listTasksReply(userId, fw);
      return `I read “${t.trim()}” as a reply to a list, but nothing’s open right now — tell me a task, or try /tasks. 🌱`;
    }
  }

  // (7) Apply the rule: a QUESTION runs a command; a STATEMENT files a task (the safe default).
  const { kind, intent, confidence, args } = await classifyIntent(t);
  if (kind === 'question' && intent && confidence >= CONF_MIN) {
    return dispatchIntent(intent, args, { userId, t, channel, energy, isOn, moduleAvailable });
  }
  return captureSnippet({ userId, text: t, channel, messageId: snap.messageId, snapshotId: snap.snapshotId, imageId, isOn });
}

// Derive the "what does the next message do?" mode + quick-reply options from the resulting dialog state.
function modeFromDialog(ds) {
  if (ds?.type === 'suggestion_reaction') return 'suggestion';
  if (ds?.type === 'food_confirm' || ds?.type === 'eat_qty') return 'confirm';
  if (ds?.type === 'grooming_choice') return 'grooming';
  if (ds?.type === 'task_filter') return 'filter';
  if (ds?.type === 'done_feedback') return 'done';
  if (ds?.type === 'task_reference') return 'confirm';
  return 'capture';
}
function optionsFromDialog(ds) {
  switch (ds?.type) {
    case 'suggestion_reaction': return ds.data?.phase === 'offer' ? ['something smaller', 'done for now'] : ['yes', 'no', 'smaller', 'not today'];
    case 'food_confirm': return ['yes', 'no'];
    case 'grooming_choice': return ['reword', 'break it down', 'snooze', 'keep'];
    case 'task_filter': return ds.data?.options || [];
    case 'done_feedback': return ['High five! 🙌', 'Glad that’s over 😮‍💨', 'OK'];
    case 'task_reference': return ['start it', 'mark it done', 'no, it’s new'];
    default: return [];
  }
}

// ── interactive menus: act on a task by a tapped inline button (Telegram) or a clicked button (web) ──
// A structured callback token (a:* / m:*) carries the target task id + the action/submenu, so a button
// says "act on THIS task" with no raw id ever shown. Telegram calls this directly (editing the card in
// place); the web reaches it through route()'s `action` branch (appending a refreshed turn). Same
// dispatcher, same closed-world ownership — every mutator re-checks user_id, so a forged id just reads as
// "gone". Returns route()'s shape, plus an optional `toast` (Telegram's answerCallbackQuery flash; the
// web ignores it). Mutations REUSE the brain's existing flows (transitionTask / setSnoozed + logOutcome).
const optionsToButtons = (options) => (options && options.length ? [options.map((o) => ({ text: o, data: o }))] : null);
const goneCard = () => ({ text: 'That task isn’t on your list anymore.', buttons: null });
const card = (task, buttons, extra = {}) => ({ text: taskLine(task), buttons, ...extra });
// Is a task list actually in view right now? Only then does a "‹ Back to the list" button on a card point at
// something real — otherwise it would drop the user onto a stale, unrelated slice (the complaint behind the
// back-button tweak). A listing leaves its rendered ids behind (setListing); "✕ Hide"/a fresh empty list clears
// them, so this flips false the moment there's nothing to go back to.
const hasLiveList = (userId) => resolveListing(userId, 'task', [1]).total > 0;
// A task's home menu: the usual actions, plus "💡 Suggest steps" while it has none yet — so the break-it-
// down affordance shows every time the card is opened, not only the instant it's started. The "‹ Back" row
// rides only when a list is in view (caller passes `list`).
const taskHomeMenu = (task, list = false) => {
  const stepless = parseSteps(task).length === 0;
  // Top slot: stepless → offer the LLM guess; has steps → open the 🪜 checklist (edit without starting).
  return taskActionMenu(task, { guess: stepless, steps: !stepless, list });
};

// Re-render the listing a task card came from, so "‹ Back" returns to the SAME page, not page 1.
function relistTasks(userId) {
  const st = getPageState(userId);
  if (st) {
    let open = openTasks(userId);
    if (st.filter?.category) open = open.filter((x) => x.category === st.filter.category);
    else if (st.filter?.effort) open = open.filter((x) => x.effort_level === st.filter.effort);
    else if (st.filter?.today) open = open.filter((x) => isDueToday(x));
    return showSlice(userId, formatTasksSlice(open, listingContext(userId), st.offset || 0), { filter: st.filter, label: st.label });
  }
  return listTasksReply(userId);
}

// Re-render the CURRENT task list for a quiet in-place refresh (Telegram), after a task changed elsewhere.
// Side-effect-safe: it only re-renders a paged slice or the small grouped view — both keep setListing in
// sync (so /done_N stays correct) WITHOUT arming any dialog. Returns { text, buttons } / a string, or null
// when there's nothing to safely refresh into (no current list, or the counts-overview — which would re-arm
// its filter dialog, and has no row controls to act on anyway).
export function refreshedTaskList(userId) {
  userId = effectiveUserId(userId); // the Telegram adapter passes identity; refresh the notebook that's in view
  if (getPageState(userId)) return relistTasks(userId); // a paged slice — showSlice is dialog-free
  const open = openTasks(userId);
  if (!open.length || open.length > MANY_TASKS) return null;
  return showTasks(userId, formatTasksGrouped(open, listingContext(userId))); // small grouped view, dialog-free
}

export async function handleAction(userId, token, { channel = 'web' } = {}) {
  const d = decodeToken(token);
  if (!d) return { text: '✨', buttons: hubMenu() }; // unrecognized → safe fallback to the hub
  // Callers pass the IDENTITY account (web acting-user / the Telegram·Slack sender). A tap acts on the CURRENT
  // notebook's data, so resolve the effective user and use it for everything below; the module gate + the
  // optin/optout toggles stay on the identity (opt-ins are a shared, per-person preference).
  const identityId = userId;
  userId = effectiveUserId(identityId);
  const isOn = makeIsOn(identityId); // per-person module gate for this tap (help/menu chips + the optin/optout toggles)

  // Speed Dial: a pad button tap (m:sd:<n>) fires that slot for the person's OWN account (identity, so being
  // inside a notebook can't hide the pad). A LIMITED account may tap nothing else — any other token re-shows
  // the pad (x / hide still dismiss). The owner is never limited.
  if (d.ns === 'm' && d.verb === 'sd') return fireSlot(identityId, Number(d.value));
  if (isSpeedDialOnly(identityId) && !isOwner(identityId) && d.ns !== 'x' && !(d.ns === 'm' && d.verb === 'hide')) return padView(identityId);

  // Navigation with no task target.
  if (d.ns === 'x') return { text: '', buttons: null };
  // "✕ Hide" on a task list → dismiss it: clear the rendered ids/page cursor (so a stray "/done N" can't hit a
  // list that's no longer on screen) and signal the channel to remove the message (Telegram delete / web prune).
  if (d.ns === 'm' && d.verb === 'hide') {
    // A task list ("m:hide", no value) → clear its numbering + page cursor, and retire any "which tasks?"
    // narrowing prompt so a later word isn't read as its answer. A generic panel dismiss ("m:hide:x", used by
    // the help screens) touches none of that — it only asks the channel to remove the message.
    if (!d.value) {
      setListing(userId, 'task', []); setPageState(userId, null);
      if (getDialogState(userId)?.type === 'task_filter') clearDialogState(userId);
    }
    return { text: '', buttons: null, hide: true };
  }
  if (d.ns === 'm' && d.verb === 'list') return relistTasks(userId);
  if (d.ns === 'm' && d.verb === 'page') return handleListPage(userId, d.value === 'prev' ? -1 : +1);
  if (d.ns === 'm' && d.verb === 'hub') {
    const flags = { metrics: isOn('metrics'), notes: isOn('notes'), lists: isOn('lists') };
    if (d.value) return { text: 'Tap one: ✨', buttons: hubGroupMenu(d.value, flags) || hubMenu() };
    return { text: commandMenu(isOn).text, buttons: hubMenu() };
  }
  if (d.ns === 'm' && d.verb === 'cmd') return d.value ? commandSectionReply(d.value, isOn) : commandsHub(isOn);
  // Module on/off toggles — from the "modules" screen or an "it's off — turn it on?" offer. setModule HIDES on
  // opt-out (never deletes); an unknown module falls back to the modules screen rather than erroring.
  if (d.ns === 'm' && (d.verb === 'optin' || d.verb === 'optout')) {
    return setModule(identityId, d.value, d.verb === 'optin') || modulesReply(identityId, makeIsOn(identityId));
  }
  // System-wide module toggles (from the owner's "system" board or Settings → Modules). OWNER ONLY — guard here
  // too so a stale or forged token can never flip global availability. Non-owners get a silent no-op.
  if (d.ns === 'm' && (d.verb === 'syson' || d.verb === 'sysoff')) {
    if (!isOwner(identityId)) return { text: '', buttons: null };
    setSystemModule(d.value, d.verb === 'syson');
    return systemModulesReply();
  }
  // A feature module's own button token ("m:tmr:<id>" → features/timer.js) — the module handles it.
  if (d.ns === 'm') {
    const featAction = featureMenuAction(d.verb);
    if (featAction) return featAction(userId, d);
  }
  // Lists outliner navigation buttons (out/top/page/exit). Per-item descend is the "/sub_N" link on each row.
  if (d.ns === 'm' && d.verb === 'lnav') {
    if (d.value === 'out') return listOut(userId);
    if (d.value === 'top') return listTop(userId);
    if (d.value === 'next') return listPageNav(userId, +1);
    if (d.value === 'prev') return listPageNav(userId, -1);
    // "✕ Close" tap → clear list state AND signal the channel to remove the message (Telegram deletes it; web
    // prunes the bubble), so closing the outliner leaves no "Closed your lists" residue cluttering the chat. A
    // TYPED "close"/"exit" still gets that text confirmation via handleListNav — there's no message to delete there.
    if (d.value === 'exit') { listExit(userId); return { text: '', buttons: null, hide: true }; }
    return listsHome(userId);
  }

  // Everything else targets a task; resolve + ownership-check once (a forged/stale id → "gone").
  const task = getTask(userId, d.taskId);
  if (!task) return goneCard();

  // Submenu navigation — swap the keyboard only; never mutate the task or any open dialog state
  // (m:steps is the one deliberate exception: opening the checklist to edit arms a stepping session).
  if (d.ns === 'm') {
    if (d.verb === 'more') return card(task, taskMoreMenu(task));
    if (d.verb === 'prio') return card(task, priorityMenu(task.id, task.priority));
    if (d.verb === 'sch') return card(task, scheduleMenu(task.id));
    if (d.verb === 'rem') return card(task, reminderMenu(task.id));
    if (d.verb === 'cat') return card(task, categoryMenu(task.id, task.category));
    if (d.verb === 'steps') {
      // 🪜 Steps — open the checklist to EDIT, started or not. Arms an edit-mode stepping session pinned
      // HERE, so a typed "step …" / "unstep 2" / "done 2" lands on THIS task even while a different one is
      // in progress (handleStepping's staleness guard honors edit:true).
      setDialogState(userId, { type: 'stepping', data: { taskId: task.id, edit: true } });
      const steps = parseSteps(task);
      if (!steps.length) {
        return {
          text: html`🪜 ${`“${task.summary}”`} has no steps yet — ${'type “step <text>” to add one'}, or let me suggest a few.`.toString(),
          buttons: stepsEmptyMenu(task), html: true,
        };
      }
      const v = stepsView(task);
      return { ...v, text: html`🪜 ${`“${task.summary}”`}\n${raw(v.text)}\n${'Add “step …” · remove “unstep 2” · tick “done 2” (or tap a box).'}`.toString() };
    }
    return card(task, taskHomeMenu(task, hasLiveList(userId))); // 'act' (and any unknown m:) → the top action menu (+ Suggest/🪜 Steps slot)
  }

  // Actions (a:*) — mutate, then refresh the card with a gentle toast.
  if (d.verb === 'done') {
    const res = await transitionTask(userId, task.id, 'done'); // logs outcome, arms done_feedback
    if (typeof res === 'string') return goneCard();
    return { ...res, buttons: optionsToButtons(res.options), toast: 'Marked done ✓' };
  }
  if (d.verb === 'start') {
    const res = await transitionTask(userId, task.id, 'in_progress');
    const t2 = getTask(userId, task.id);
    if (!t2) return goneCard();
    // A task with steps comes back from transitionTask with its checklist text + step buttons (and arms
    // stepping); otherwise it falls back to the plain action menu. Spread the whole result so html/photo/ref
    // ride along — the started card is an HTML surface (bold title), and dropping the html flag printed raw
    // <b> tags. (Mirrors the done/guess/step branches, which also spread.)
    const obj = (res && typeof res === 'object') ? res : { text: String(res) };
    return { ...obj, buttons: obj.buttons || taskActionMenu(t2, { list: hasLiveList(userId) }), toast: 'Started ▶' };
  }
  // "💡 Suggest steps" on a started, stepless task → ask the LLM to guess a checklist, show it with the step
  // toggles, and arm stepping. The one sanctioned spot the model fills in from general know-how (see guessSteps).
  if (d.verb === 'guess') {
    const res = await guessSteps(userId, task);
    // A string means the model couldn't help / was unavailable — show that REASON (not the bare task line), so
    // a quota/billing failure is visible right on the card instead of a silent "No guess" toast.
    if (typeof res === 'string') return { text: res, buttons: startedMenu(task, hasLiveList(userId)), toast: 'No guess' };
    return { ...res, toast: 'Steps guessed 💡' };
  }
  // Tap a step's ☐/☑ to toggle it, or "✓ Done all" to tick everything. When the last open step is ticked
  // (or Done all), the parent task completes — reusing transitionTask's "how did that feel?".
  if (d.verb === 'step') {
    let res;
    if (d.value === 'all') res = setStepsDone(userId, task.id, 'all', true);
    else {
      const i = Number(d.value);
      const cur = parseSteps(task)[i - 1];
      if (!cur) return card(task, taskHomeMenu(task, hasLiveList(userId)));        // stale index → safe fallback
      res = setStepsDone(userId, task.id, [i], !cur.done);      // toggle
    }
    if (!res || res.total === 0) return card(task, taskHomeMenu(task, hasLiveList(userId)));
    if (res.allDone) {
      clearDialogState(userId);
      const done = await transitionTask(userId, task.id, 'done');
      if (typeof done === 'string') return goneCard();
      return { ...done, buttons: optionsToButtons(done.options), toast: 'All steps done ✓' };
    }
    const v = stepsView(getTask(userId, task.id));
    return { ...v, toast: d.value === 'all' ? 'Stepped ✓' : `Step ${d.value} ${res.changed.length ? 'updated' : 'unchanged'}` };
  }
  if (d.verb === 'drop') {
    setTaskStatus(userId, task.id, 'archived');
    const outcomeId = logOutcome(userId, task, 'dropped');
    recordUndo(userId, 'task_status', { items: [statusItem(task, 'archived', outcomeId)] },
      `↩ Put “${task.summary}” back on your list.`);
    // No "‹ Back to the list" here: the hanging list auto-refreshes in place after a mutation (MUTATING_VERBS),
    // so a back button would only point at an already-updated message — the stale-slice complaint.
    return { text: `Removed “${task.summary}” from your list.`, buttons: null, toast: 'Removed 🗑' };
  }
  if (d.verb === 'snz') {
    const snz = setSnoozed(userId, task.id, startOfTomorrow());
    const outcomeId = logOutcome(userId, snz, 'snoozed');
    recordUndo(userId, 'task_status', { items: [statusItem(task, 'snoozed', outcomeId)] },
      `↩ Unsnoozed “${task.summary}” — back on your list.`);
    return { text: `Tucked “${task.summary}” away till tomorrow. 🌱 (“/snoozed” shows it · “/unsnooze 1” brings it back)`, buttons: null, toast: 'Snoozed 😴' };
  }
  if (d.verb === 'unstart') {
    // Stale tap guard: the card may outlive the started state (task finished/paused since) — unstarting a
    // DONE task would silently reopen it, so only act on a live in_progress row.
    if (task.status !== 'in_progress') return card(task, taskHomeMenu(task, hasLiveList(userId)), { toast: 'Not started' });
    return { text: unstartTask(userId, task), buttons: null, toast: 'Unstarted ⏸' };
  }
  if (d.verb === 'prio') {
    const level = d.value === '0' ? null : Number(d.value);
    const t2 = setTaskPriority(userId, task.id, level);
    if (!t2) return goneCard();
    return card(t2, taskHomeMenu(t2, hasLiveList(userId)), { toast: level ? `Priority: ${priorityLabel(level)}` : 'Priority cleared' });
  }
  if (d.verb === 'cat') {
    // A failed move (e.g. the tapped category was retired via /remcat) must say so — silently re-showing
    // the same menu made the tap look like it did nothing.
    let t2; try { t2 = setTaskCategory(userId, task.id, d.value); }
    catch (err) { console.error('setTaskCategory failed:', err.message); return card(task, categoryMenu(task.id, task.category), { toast: 'Couldn’t move it — try another category?' }); }
    if (!t2) return goneCard();
    return card(t2, taskHomeMenu(t2, hasLiveList(userId)), { toast: `Moved to ${catLabel(t2.category)}` });
  }
  if (d.verb === 'sch') {
    const preset = presetDue(d.value);
    if (!preset) return card(task, scheduleMenu(task.id));
    const t2 = setTaskSchedule(userId, task.id, preset);
    if (!t2) return goneCard();
    return card(t2, taskHomeMenu(t2, hasLiveList(userId)), { toast: d.value === 'clear' ? 'Deadline cleared' : `Due ${dueLabel(t2.due_at)}` });
  }
  if (d.verb === 'rem') {
    const preset = presetRemind(d.value);
    if (!preset) return card(task, reminderMenu(task.id));
    const t2 = setTaskReminder(userId, task.id, preset.remindAt);
    if (!t2) return goneCard();
    return card(t2, taskHomeMenu(t2, hasLiveList(userId)), { toast: d.value === 'clear' ? 'Reminder cleared' : `🔔 ${whenLabel(t2.remind_at)}` });
  }
  return goneCard();
}

// Shape the re-rendered task list into the client-message contract so the web can swap it into the list
// bubble it's already showing, in place (its analogue of Telegram's refreshHangingList edit). Reuses the
// shared, side-effect-safe refreshedTaskList; null when there's nothing safe to refresh (no current list, or
// the counts-overview). listKind gates the client swap so only a TASK list is ever replaced.
function shapeRefreshedListing(userId) {
  const rl = refreshedTaskList(userId);
  if (!rl || typeof rl === 'string') return null;
  return { reply: rl.text ?? '', buttons: rl.buttons || null, html: !!rl.html, listing: true, listKind: 'task' };
}

// Ride the first-contact pad welcome ALONGSIDE a full-account pad-holder's normal first reply — append it below
// and add its tappable numbers — instead of swallowing their message (they still get their task filed / question
// answered). A reaction-only reply (mood/note/ack) or a dismissed list has no bubble to append to, so there the
// pad simply becomes the reply. One-time; the caller stamps welcomed_at.
function ridePadWelcome(r, userId) {
  const pad = welcomePad(userId);
  if (!pad?.text) return r;
  if (!r.text || r.hide || r.kind === 'note' || r.kind === 'mood' || r.kind === 'ack') {
    return { text: pad.text, buttons: pad.buttons };
  }
  return { ...r, text: `${r.text}\n\n${pad.text}`, buttons: [...(r.buttons || []), ...(pad.buttons || [])] };
}

export async function handleMessage(args = {}) {
  // The channel hands us the IDENTITY account; a turn's data/dialog/mood/transcript all belong to the space
  // (notebook or main) that identity is currently in — so resolve the effective user once and use it for the
  // whole turn. route() gets both (it needs the identity for the module gate + the notebook/vouch commands).
  const identityId = args.userId ?? defaultUserId();
  const userId = effectiveUserId(identityId);
  // The whole turn runs as this IDENTITY for LLM budgeting (llm/context.js) — notebooks share their
  // owner's daily cap. Budget/capacity throws become friendly replies, never silence: the user's message
  // was already stored by route()'s recordSnapshot before any LLM call, so nothing they sent is lost.
  // (Call sites with their own heuristic fallbacks swallow the throw internally and just degrade — also fine.)
  let out;
  try {
    out = await runAsLlmUser(identityId, () => route({ ...args, userId, identityId }));
  } catch (err) {
    if (err?.code === 'LLM_BUDGET') out = { text: 'You’ve hit today’s AI limit — it resets at midnight. Everything you sent is safe, and simple commands still work.' };
    else if (err?.code === 'LLM_BUSY') out = { text: 'I’m helping a lot of people right now — give me a minute and try again.' };
    else throw err;
  }
  let r = typeof out === 'string' ? { text: out } : (out || { text: '' });
  // First contact for a FULL-account pad-holder: ride their pad ALONGSIDE this reply (don't swallow the
  // message), once. Only on a typed message (never a button tap — a tapped menu/dialog step is no place to
  // graft the pad). A limited account already sees its pad on every message (route()'s gate); the owner is
  // never a guest. Stamp welcomed_at here so the pad rides exactly one turn.
  if (!args.action && !isOwner(identityId) && hasSpeedDial(identityId) && !isSpeedDialOnly(identityId) && !speedDialWelcomed(identityId)) {
    markSpeedDialWelcomed(identityId);
    r = ridePadWelcome(r, identityId);
  }
  const ds = getDialogState(userId);
  // Consume the "a task's list-state changed" flag ONCE here, for every channel, so it never leaks into the
  // next turn (Telegram/Slack read result.refreshList; the web also gets a re-rendered list to swap in).
  const listDirty = taskListDirty.delete(userId);
  const result = {
    reply: r.text ?? '',
    status: getStatus(userId),
    image: r.image || null,   // a chart's data: URI (rendered on web AND Telegram); NOT captured photos
    photo: r.photo || null,   // a Telegram file_id for a captured photo — re-sent by the Telegram adapter only
    calendarUrl: r.calendarUrl || null,
    document: r.document || null,
    mode: r.mode || modeFromDialog(ds),
    options: r.options || optionsFromDialog(ds),
    buttons: r.buttons || null,
    ref: r.ref || null,
    // A "this reply is a task/notes/sleeping LIST" hint. Telegram uses it to delete the previous list so
    // stacked, stale lists don't pile up (a chat-only nicety; the web keeps its scroll-back history).
    listing: r.listing || false,
    // Which kind of list this reply is (task/note/list). Only 'task' listings carry it (showTasks/showSlice);
    // the web uses it to swap the refreshed list into the RIGHT bubble and never turn a /notes list into tasks.
    listKind: r.listKind || null,
    // A task's open-list state changed this turn (done/start/drop) → Telegram quietly re-renders the list it's
    // already showing, so it never goes stale. Consumed once above so the flag never leaks into the next turn.
    refreshList: listDirty,
    // Web-only: the re-rendered task list to swap into the bubble the client is already showing (Telegram/Slack
    // re-render via their own adapters, so skip the extra render for them). null when there's nothing to refresh.
    refreshedListing: listDirty && args.channel === 'web' ? shapeRefreshedListing(userId) : null,
    // Did this turn LOG a task? Only then is the ambient status header (mood · time) worth showing — every
    // other reply suppresses it (channels gate on this), so the thread stays calm.
    logged: r.logged || false,
    // This reply's text is Telegram-safe HTML (built via shared/richtext.js) → Telegram sends it with
    // parse_mode:HTML and the web renders the whitelisted tag subset. Opt-in per message; plain otherwise.
    html: r.html || false,
    // 'note' on a capture confirmation → the Telegram adapter acks with a ✍️ reaction (and drops the text);
    // 'mood' → it acks with a mood reaction (and drops the "Mood set:" text; the web still shows it);
    // 'ack' → a contentless emoji reply (🌱/👍) becomes a reaction on EVERY surface — no bubble anywhere.
    kind: r.kind || null,
    // The emoji a 'mood' ack should react with (the one the user sent). Null otherwise.
    moodEmoji: r.moodEmoji || null,
    // The emoji a kind:'ack' should react with (Telegram/Slack constrain it to their allowed sets). Null otherwise.
    ackEmoji: r.ackEmoji || null,
    // The web's two-step reaction stamped on the USER's own message: the literal mood emoji for a 'mood'
    // set (no ALLOWED_REACTIONS filter — the web renders any emoji), ✍ for a filed note, else 🫡. Telegram
    // and Slack ignore this and compute their own filtered/mapped reaction. Stripped off button taps by
    // /api/action (no user message to react to — mirrors Telegram skipping the reaction on a tapped bubble).
    reaction: decideReaction({ kind: r.kind || null, moodEmoji: r.moodEmoji || null, ackEmoji: r.ackEmoji || null }),
    // A dismissed list ("✕ Hide") → the channel removes the message rather than rendering a reply (Telegram
    // deletes it; web prunes the listing bubble). Empty-text + hide ⇒ nothing is stored or shown.
    hide: r.hide || false,
  };
  // Stamp the decided reaction onto THIS turn's stored user message so the web can replay it on
  // scroll-back (Telegram's own servers persist theirs). Skipped when route() took the action path
  // (no user message this turn) or the turn erased the thread (the row is gone — setMessageReaction no-ops).
  const userMsgId = lastUserMsg.get(userId);
  lastUserMsg.delete(userId);
  if (userMsgId != null && result.reaction) setMessageReaction(userId, userMsgId, result.reaction);
  // Persist the bot's turn (the user's was already stored in route() via recordSnapshot) so the web UI
  // can replay both sides on scroll-back. The status chip rides along in raw_json. Captured photos are NOT
  // persisted: they're a Telegram-only feature (re-sent there by file_id), and the web UI doesn't show them.
  // options/ref are intentionally NOT stored — they're live affordances that would be stale once replayed.
  // An `ephemeral` reply (the /requestdeletion confirmation) is never stored: the turn just erased the whole
  // thread, so we won't write a fresh row back into it. A kind:'ack' turn isn't stored either — no surface
  // shows it as a bubble (the reaction on the user's message is the whole reply), so scroll-back shouldn't.
  if (result.reply.trim() && !r.ephemeral && r.kind !== 'ack') {
    // Surface the stored id so the web client can advance its live-poll cursor past its own turn (it won't
    // then re-fetch and duplicate the reply it already rendered optimistically). Telegram ignores it.
    result.messageId = insertMessage({
      userId, channel: args.channel || 'web', text: result.reply, role: 'bot',
      // Persist the listing flags too: so a list bubble restored from history/poll can still be superseded by
      // a later /tasks (no duplicate lists) and swapped in place after a page reload. `logged` rides along so
      // the ambient status chip (mood · time · weather) survives a reload — the web gates the chip on it, and
      // without it a reloaded task-capture silently lost its mood even though the mood is right there in status.
      raw: { status: result.status, html: result.html, listing: result.listing, listKind: result.listKind, logged: result.logged },
    });
  }
  return result;
}
