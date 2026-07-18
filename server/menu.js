// Interactive-menu layer: the token codec + button-tree builders shared by Telegram (inline keyboards,
// edited in place) and the web (click-buttons, appended as a fresh turn). PURE — no DB, no Telegram, no
// LLM — so it unit-tests in isolation. The dispatcher that DOES the work lives in chat.js (handleAction);
// this module only encodes/decodes the compact `callback_data` tokens and lays out the buttons.
//
// Why a token, not the visible label: a per-task button has to say "raise priority on THIS task" without
// the user ever seeing a raw DB id. The label stays a position/verb; the id rides invisibly in the token.
// A DB id (not a list position) is used so the token survives the list re-rendering under it.
import { CATEGORIES, CATEGORY_LABELS, CATEGORY_ORDER } from '../shared/categories.js';
import { GUIDE_LABELS, COMMAND_SECTIONS } from '../shared/copy.js';

// Telegram caps callback_data at 64 BYTES (UTF-8). We assert a 60-byte ceiling (4-byte margin) so a future
// pathologically-long custom category fails loudly in dev/tests instead of silently truncating in Telegram.
const MAX_TOKEN_BYTES = 60;

// Join parts into a `ns:verb:…` token. Throws if it would exceed the byte cap (only `a:cat:<id>:<key>`
// has unbounded input — every other token is tiny). taskIds and presets are ASCII, so byteLength==length
// for them; only a multi-byte custom-category key could differ, which the assert still catches.
export function encodeToken(parts) {
  const token = parts.map((p) => String(p)).join(':');
  if (Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) {
    throw new Error(`callback token too long (${Buffer.byteLength(token, 'utf8')}B > ${MAX_TOKEN_BYTES}): ${token}`);
  }
  return token;
}
const tok = (...parts) => encodeToken(parts);
const btn = (text, data) => ({ text, data });
// A small "✕" dismiss for a non-list panel (guide/command help screens): the "m:hide:x" generic-dismiss token
// just asks the channel to remove the message (Telegram deletes it; web prunes it) — it clears no task state,
// unlike the bare "m:hide" a task list uses.
export const CLOSE_BTN = { text: '✕', data: 'm:hide:x' };
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

// A token is "structured" (a menu/action) vs a legacy plain answer ("yes", "/whatdo", "start it"). The
// namespaces `a:` (act) and `m:` (menu), plus the bare `x` (dismiss), are reserved — no existing option
// label starts with them, so this never misfires on a legacy callback. The web mirrors this exact test.
export function isStructured(data) {
  const s = String(data ?? '');
  return s === 'x' || /^[am]:/.test(s);
}

// Decode a structured token to { ns, verb, taskId, value } — or null for a legacy label / garbage. The
// dispatcher (chat.js) switches on ns+verb. taskId is a parsed integer where the shape carries one; value
// is the trailing segment (priority level, preset, category key, hub group) or null.
export function decodeToken(data) {
  const s = String(data ?? '');
  if (!isStructured(s)) return null;
  if (s === 'x') return { ns: 'x', verb: null, taskId: null, value: null };
  const seg = s.split(':');
  const ns = seg[0];
  const verb = seg[1] || null;
  // A real task id is a positive integer; an empty/blank segment (e.g. "m:act:") must NOT coerce to 0.
  const intAt = (i) => { const raw = seg[i]; if (raw == null || raw === '') return null; const n = Number(raw); return Number.isInteger(n) && n > 0 ? n : null; };

  if (ns === 'a') {
    // a:<verb>:<taskId>[:<value>]  — done|start|unstart|drop|snz (no value) · prio|cat|sch|rem (value)
    const taskId = intAt(2);
    if (taskId == null) return null;
    return { ns, verb, taskId, value: seg[3] ?? null };
  }
  if (ns === 'm') {
    // No-taskId menus: m:list, m:hub[:group], m:page:<next|prev>, m:cmd[:section], m:hide (dismiss a list),
    // m:lnav:<out|top|next|prev|exit> (the lists outliner's navigation buttons), m:optin|optout:<module>
    // (per-user module toggles from the "modules" screen / an "it's off" offer — value is the module name),
    // m:syson|sysoff:<module> (OWNER-ONLY system-wide module toggles from the "system" board / Settings → Modules),
    // m:tmr:<timerId> (cancel a running one-shot timer — the id is a TIMER row, not a task, so it rides in value).
    // m:jch|jca|jnt|jop|jsm|jtr:<value> (the Journal module's card buttons — journal/entry row ids, some
    // dot-paired like "<entryId>.<pos>", so they ride in value, never taskId).
    // m:bch|bca|blg|bdn|bop|bhi|bas|bsv:<value> (the Batches module's card buttons — batch row ids, bch
    // dot-paired like "<batchId>.<pos>"; same value-not-taskId rule as the journal's).
    // m:hacal:<value> (the Home Assistant module's "push to the house calendar" — the value is a TASK id,
    // but it rides in value so the handler can ownership-check + reply on its own terms, like m:tmr).
    if (verb === 'list' || verb === 'hub' || verb === 'page' || verb === 'cmd' || verb === 'hide' || verb === 'lnav'
        || verb === 'optin' || verb === 'optout' || verb === 'syson' || verb === 'sysoff' || verb === 'tmr'
        || verb === 'jch' || verb === 'jca' || verb === 'jnt' || verb === 'jop' || verb === 'jsm' || verb === 'jtr'
        || verb === 'bch' || verb === 'bca' || verb === 'blg' || verb === 'bdn' || verb === 'bop' || verb === 'bhi'
        || verb === 'bas' || verb === 'bsv' || verb === 'hacal') {
      return { ns, verb, taskId: null, value: seg[2] ?? null };
    }
    // m:<act|more|prio|sch|rem|cat>:<taskId>
    const taskId = intAt(2);
    if (taskId == null) return null;
    return { ns, verb, taskId, value: null };
  }
  return null;
}

// ── Voice-carrying labels, centralized so the deferred persona-pack work can move
// them behind t('menu.*') with a mechanical find-replace. Builders reference these only — never inline. ──
export const MENU_LABELS = {
  done: '✓ Done', start: '▶ Start', snooze: '😴 Snooze', unstart: '⏸ Unstart', more: '⋯ More', back: '‹ Back', edit: '⋯ Edit',
  doneAll: '✓ Done all', guess: '💡 Suggest steps', steps: '🪜 Steps',
  priority: '🔥 Priority', reschedule: '🗓 Reschedule', remind: '🔔 Remind', recategorize: '🏷 Category', drop: '🗑 Drop',
  prioHigh: '🔴 High', prioMed: '🟠 Med', prioLow: '🔵 Low', prioClear: 'Clear',
  schToday: 'Today', schTomorrow: 'Tomorrow', schWeekend: 'Weekend', schClear: 'Clear deadline',
  remIn1h: 'In 1h', remIn3h: 'In 3h', remEve: 'This evening', remMorn: 'Tomorrow 9am', remClear: 'Clear reminder',
  // Hub groups (the navigable `c` menu).
  hubDo: '▶ Do', hubKeep: '✚ Keep', hubMe: '📊 Stats', hubHelp: '❔ Help',
  // Lists outliner navigation.
  listOut: '↑ Out', listTop: '⤒ Top', listClose: '✕ Close',
};
const CHECK = ' ✓';

// The gentle TOP-LEVEL per-task menu: Done · Start · Snooze · ⋯More, then ‹Back to the list. Everything
// heavier (priority/reschedule/recategorize/drop) hides one tap behind ⋯More — the anti-"menu wall" choice.
// `guess:true` (caller decides, when the task has no steps yet) prepends "💡 Suggest steps" so the break-it-
// down affordance is reachable whenever the task is opened — not only at the instant it's started.
// `steps:true` (caller decides, when the task HAS steps) puts "🪜 Steps" in that same top slot instead —
// open/edit the checklist without starting the task. `list:true` (caller passes it only when a task list is
// actually in view) appends "‹ Back" to that list — otherwise the back row is omitted, so opening a card
// never offers a return to a stale, unrelated slice.
export function taskActionMenu(task, { guess = false, steps = false, list = false } = {}) {
  const rows = [];
  if (guess) rows.push([btn(MENU_LABELS.guess, tok('a', 'guess', task.id))]);
  else if (steps) rows.push([btn(MENU_LABELS.steps, tok('m', 'steps', task.id))]);
  rows.push(
    [btn(MENU_LABELS.done, tok('a', 'done', task.id)),
     btn(MENU_LABELS.start, tok('a', 'start', task.id)),
     btn(MENU_LABELS.snooze, tok('a', 'snz', task.id))],
    list ? [btn(MENU_LABELS.more, tok('m', 'more', task.id)), btn(MENU_LABELS.back, 'm:list')]
         : [btn(MENU_LABELS.more, tok('m', 'more', task.id))],
  );
  return rows;
}

// Under a STARTED task that has NO steps yet: lead with "💡 Suggest steps" (a:guess:<id>) — one tap asks the
// LLM to guess a checklist — then the everyday Done · Unstart · Snooze, and ⋯More (+ ‹Back only when a list
// is in view). No "▶ Start" (it's already started); ⏸ Unstart puts it back without finishing.
// Shown on both channels so the guess affordance has parity.
export function startedMenu(task, list = false) {
  return [
    [btn(MENU_LABELS.guess, tok('a', 'guess', task.id))],
    [btn(MENU_LABELS.done, tok('a', 'done', task.id)),
     btn(MENU_LABELS.unstart, tok('a', 'unstart', task.id)),
     btn(MENU_LABELS.snooze, tok('a', 'snz', task.id))],
    list ? [btn(MENU_LABELS.more, tok('m', 'more', task.id)), btn(MENU_LABELS.back, 'm:list')]
         : [btn(MENU_LABELS.more, tok('m', 'more', task.id))],
  ];
}

// The "⋯More" submenu: the heavier edits, each opening its own picker, plus 🪜 Steps (add/edit the
// checklist without starting the task), Drop, and ‹Back to the actions.
export function taskMoreMenu(task) {
  return [
    [btn(MENU_LABELS.priority, tok('m', 'prio', task.id)),
     btn(MENU_LABELS.reschedule, tok('m', 'sch', task.id))],
    [btn(MENU_LABELS.remind, tok('m', 'rem', task.id)),
     btn(MENU_LABELS.recategorize, tok('m', 'cat', task.id))],
    [btn(MENU_LABELS.steps, tok('m', 'steps', task.id)),
     btn(MENU_LABELS.drop, tok('a', 'drop', task.id))],
    [btn(MENU_LABELS.back, tok('m', 'act', task.id))],
  ];
}

// Priority picker — marks the current level so re-tapping it is a visible no-op (and Telegram's "not
// modified" is swallowed upstream). 0 = clear. Back to the ⋯More submenu.
export function priorityMenu(taskId, current = null) {
  const mark = (label, lvl) => label + (current === lvl ? CHECK : '');
  return [
    [btn(mark(MENU_LABELS.prioHigh, 3), tok('a', 'prio', taskId, 3)),
     btn(mark(MENU_LABELS.prioMed, 2), tok('a', 'prio', taskId, 2)),
     btn(mark(MENU_LABELS.prioLow, 1), tok('a', 'prio', taskId, 1))],
    [btn(mark(MENU_LABELS.prioClear, 0), tok('a', 'prio', taskId, 0)),
     btn(MENU_LABELS.back, tok('m', 'more', taskId))],
  ];
}

// Reschedule picker — gentle presets only (no free typing). Sets a DEADLINE. Back to ⋯More.
export function scheduleMenu(taskId) {
  return [
    [btn(MENU_LABELS.schToday, tok('a', 'sch', taskId, 'today')),
     btn(MENU_LABELS.schTomorrow, tok('a', 'sch', taskId, 'tom'))],
    [btn(MENU_LABELS.schWeekend, tok('a', 'sch', taskId, 'wknd')),
     btn(MENU_LABELS.schClear, tok('a', 'sch', taskId, 'clear'))],
    [btn(MENU_LABELS.back, tok('m', 'more', taskId))],
  ];
}

// Reminder picker — gentle, time-bearing presets (no free typing). Sets a one-time NUDGE the scheduler
// fires once, independent of any deadline (see setTaskReminder). Back to ⋯More.
export function reminderMenu(taskId) {
  return [
    [btn(MENU_LABELS.remIn1h, tok('a', 'rem', taskId, '1h')),
     btn(MENU_LABELS.remIn3h, tok('a', 'rem', taskId, '3h'))],
    [btn(MENU_LABELS.remEve, tok('a', 'rem', taskId, 'eve')),
     btn(MENU_LABELS.remMorn, tok('a', 'rem', taskId, 'morn'))],
    [btn(MENU_LABELS.remClear, tok('a', 'rem', taskId, 'clear')),
     btn(MENU_LABELS.back, tok('m', 'more', taskId))],
  ];
}

// Category picker — the live taxonomy (drops the legacy 'entertainment' key, which isn't in CATEGORIES),
// 3-per-row, current marked. A pathologically long custom key is dropped rather than overflow the token.
export function categoryMenu(taskId, current = null) {
  const keys = CATEGORY_ORDER.filter((k) => CATEGORIES.includes(k) && k.length <= 48);
  const cells = keys.map((k) => btn((CATEGORY_LABELS[k] || k) + (k === current ? CHECK : ''), tok('a', 'cat', taskId, k)));
  return [...chunk(cells, 3), [btn(MENU_LABELS.back, tok('m', 'more', taskId))]];
}

// Pagination controls under a paged listing: ‹ Prev / Next → (only the directions that exist). Structured
// m:page:<dir> tokens so a tap re-renders the adjacent page IN PLACE (Telegram) via handleListPage. Per-task
// actions aren't buttons anymore — they're the tappable "/start_N · /done_N" links right on each row.
export function listPageKeyboard({ hasPrev = false, hasNext = false } = {}) {
  const row = [];
  if (hasPrev) row.push(btn('‹ Prev', tok('m', 'page', 'prev')));
  if (hasNext) row.push(btn('Next →', tok('m', 'page', 'next')));
  return row.length ? [row] : null;
}

// Navigation under a LIST view (the outliner): a paging row (only the directions that exist), then the moves —
// ↑ Out (up to the parent, only when there is one), ⤒ Top (jump to the top-level lists, hidden when already
// there), and ✕ Close (leave list mode). Structured m:lnav:<dir> tokens so a tap re-renders in place. Per-item
// "descend into N" isn't a button — it's the tappable "/sub_N" link on each row (parity with /done_N on tasks).
export function listNavKeyboard({ atTop = false, hasParent = false, hasPrev = false, hasNext = false } = {}) {
  const rows = [];
  const page = [];
  if (hasPrev) page.push(btn('‹ Prev', tok('m', 'lnav', 'prev')));
  if (hasNext) page.push(btn('Next →', tok('m', 'lnav', 'next')));
  if (page.length) rows.push(page);
  const move = [];
  if (hasParent) move.push(btn(MENU_LABELS.listOut, tok('m', 'lnav', 'out')));
  if (!atTop) move.push(btn(MENU_LABELS.listTop, tok('m', 'lnav', 'top')));
  move.push(btn(MENU_LABELS.listClose, tok('m', 'lnav', 'exit')));
  rows.push(move);
  return rows;
}

// Under a STARTED task that has steps: one compact toggle per step (☐/☑ + position), 3-per-row, so a tap
// checks/unchecks that step in place. The DB id rides in the token (a:step:<id>:<n>), so it resolves even
// if the card re-renders. Then a "✓ Done all" (a:step:<id>:all) + ‹Back to the task's action menu.
export function stepsKeyboard(taskId, steps) {
  if (!steps || !steps.length) return null;
  const cells = steps.map((s, i) => btn(`${s.done ? '☑' : '☐'} ${i + 1}`, tok('a', 'step', taskId, i + 1)));
  const rows = chunk(cells, 3);
  rows.push([btn(MENU_LABELS.doneAll, tok('a', 'step', taskId, 'all')), btn(MENU_LABELS.back, tok('m', 'act', taskId))]);
  return rows;
}

// Under the 🪜 Steps card of a task with NO steps yet: the LLM guess as the friendly first move, then
// ‹Back to the task's action menu. (Typing "step <text>" is the other path — the card's text says so.)
export function stepsEmptyMenu(task) {
  return [
    [btn(MENU_LABELS.guess, tok('a', 'guess', task.id))],
    [btn(MENU_LABELS.back, tok('m', 'act', task.id))],
  ];
}

// On the "✓ Filed" capture confirmation (also promote / "it's new"): the friendly first move on a fresh,
// stepless task is breaking it down, so lead with "💡 Suggest steps" (a:guess) next to the unobtrusive ⋯Edit
// that opens the full action menu. A just-filed task never has steps yet, so the guess is always apt.
export function justFiledMenu(task) {
  return [[btn(MENU_LABELS.guess, tok('a', 'guess', task.id)), btn(MENU_LABELS.edit, tok('m', 'act', task.id))]];
}

// The narrowing keyboard under the "you've got N open tasks" overview (an overwhelm guard, not a per-task
// menu). Each chip carries a PLAIN filter word — a category key, an effort level, "today", or "all" — NOT a
// structured a:/m: token, so a tap routes through the ordinary brain exactly like typing that word, and the
// armed task_filter dialog resolves it (the web mirrors this via isToken). The count rides in the label
// (same "(8)" style as the grouped view) so the breakdown stays readable without a wall of text. Categories
// first (top few by count, 3-per-row), then the present difficulties, then a 📅 Today · 📋 All row.
export function taskFilterKeyboard({ cats = [], byCat = {}, effs = [], byEff = {} } = {}) {
  const label = (k) => CATEGORY_LABELS[k] || k;
  const catCells = cats.slice(0, 6).map((c) => btn(`${label(c)} (${byCat[c]})`, c));
  const effCells = effs.map((e) => btn(`${e} (${byEff[e]})`, e));
  const rows = chunk(catCells, 3);
  if (effCells.length) rows.push(...chunk(effCells, 3));
  rows.push([btn('📅 Today', 'today'), btn('📋 All', 'all')]);
  return rows;
}

// The guide hub: tappable topic sections instead of one wall of text. Each topic chip carries a PLAIN
// "guide <key>" (so a tap routes through the brain exactly like typing it, on both channels), 2-per-row
// since the labels read as words. Below the topics: the rules + getting-started, then a link out to the
// tappable command menu. `liveTopics` is the gated set (metrics only appears when Metrics is on); we render
// them in GUIDE_LABELS order (newcomer-friendly), skipping any topic we have no label for.
export function guideMenu(liveTopics = []) {
  const live = new Set(liveTopics);
  const cells = Object.keys(GUIDE_LABELS).filter((k) => live.has(k)).map((k) => btn(GUIDE_LABELS[k], `guide ${k}`));
  const rows = chunk(cells, 2);
  rows.push([btn('📜 The rules', 'rules'), btn('🚀 Getting started', 'howto')]);
  rows.push([btn('📋 All commands', '/menu'), CLOSE_BTN]);
  return rows;
}

// The gentle footer under a single topic guide: one tap back to the hub, plus a ✕ to dismiss it outright. Kept
// shallow on purpose — a guide is a leaf, not a branch. (A plain "guide" token re-opens the hub via the path.)
export const GUIDE_BACK = [[{ text: '‹ All topics', data: 'guide' }, CLOSE_BTN]];

// The /commands hub: one tappable button per command SECTION (chat.js expands it in place to that section's
// lines). Same shape as the guide hub — sections instead of a wall. m:cmd:<key> is a structured token, so a
// tap edits in place on Telegram and posts to /api/action on the web. 2-per-row, since the labels read as words.
export function commandHubMenu(sections = COMMAND_SECTIONS) {
  return [...chunk(sections.map((s) => btn(s.label, tok('m', 'cmd', s.key))), 2), [CLOSE_BTN]];
}
// The footer under one expanded section: a tap back to the hub (m:cmd with no key → re-opens it), plus ✕ dismiss.
export const COMMAND_BACK = [[btn('‹ All sections', tok('m', 'cmd')), CLOSE_BTN]];

// The navigable `c` hub: top-level groups that expand in place (hubGroupMenu) to their argless commands.
// Leaf buttons carry a plain command string (e.g. "/whatdo") — NOT a structured token — so a tap routes
// through the ordinary command path on both channels (Telegram legacy callback / web /api/chat). Each group's
// `cmds(flags)` receives the live feature flags ({ metrics, notes, lists }) so a disabled feature's chip drops
// out — undefined flags default to ON, so the pure menu test (which passes none) sees every chip.
const HUB_GROUPS = [
  { key: 'do', label: () => MENU_LABELS.hubDo, cmds: () => ['/whatdo', '/tasks'] },
  { key: 'keep', label: () => MENU_LABELS.hubKeep, cmds: (f = {}) =>
      ['/notes', '/lists', '/sleeping'].filter((c) => (c !== '/notes' || f.notes !== false) && (c !== '/lists' || f.lists !== false)) },
  { key: 'me', label: () => MENU_LABELS.hubMe, cmds: (f = {}) => ['/me', '/summary', ...(f.metrics ? ['/tally'] : [])] },
  { key: 'help', label: () => MENU_LABELS.hubHelp, cmds: () => ['/howto', '/rules', '/guide', 'guide steps'] },
];
export function hubMenu() {
  return chunk(HUB_GROUPS.map((g) => btn(g.label(), tok('m', 'hub', g.key))), 2);
}
export function hubGroupMenu(key, flags = {}) {
  const g = HUB_GROUPS.find((x) => x.key === key);
  if (!g) return null;
  const leaves = g.cmds(flags).map((c) => btn(c, c)); // plain command → ordinary command path
  return [...chunk(leaves, 3), [btn(MENU_LABELS.back, 'm:hub')]];
}
