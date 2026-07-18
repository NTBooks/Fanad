// The interactive-menu codec + button-tree builders (pure; no DB/LLM/Telegram). PLAN: interactive menus.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeToken, decodeToken, isStructured, MENU_LABELS,
  taskActionMenu, taskMoreMenu, priorityMenu, scheduleMenu, categoryMenu,
  listPageKeyboard, startedMenu, justFiledMenu, hubMenu, hubGroupMenu, taskFilterKeyboard,
  guideMenu, GUIDE_BACK, commandHubMenu, COMMAND_BACK,
} from '../server/menu.js';
import { CATEGORIES } from '../shared/categories.js';
import { GUIDE_TOPICS, COMMAND_SECTIONS } from '../shared/copy.js';

// Every legacy option label any surface returns today — none may be mistaken for a structured token.
const LEGACY_LABELS = [
  'yes', 'no', 'smaller', 'not today', 'something smaller', 'done for now', 'done',
  'reword', 'break it down', 'snooze', 'keep',
  'High five! 🙌', 'Glad that’s over 😮‍💨', 'OK',
  'start it', 'mark it done', 'no, it’s new',
  '/whatdo', '/tasks', '/notes', '/me', '/howto', '/rules', '/guide', '/summary',
];

test('encode/decode round-trips every token shape', () => {
  assert.deepEqual(decodeToken(encodeToken(['a', 'done', 42])), { ns: 'a', verb: 'done', taskId: 42, value: null });
  assert.deepEqual(decodeToken(encodeToken(['a', 'snz', 7])), { ns: 'a', verb: 'snz', taskId: 7, value: null });
  assert.deepEqual(decodeToken(encodeToken(['a', 'prio', 42, 3])), { ns: 'a', verb: 'prio', taskId: 42, value: '3' });
  assert.deepEqual(decodeToken(encodeToken(['a', 'cat', 42, 'health'])), { ns: 'a', verb: 'cat', taskId: 42, value: 'health' });
  assert.deepEqual(decodeToken(encodeToken(['a', 'sch', 42, 'tom'])), { ns: 'a', verb: 'sch', taskId: 42, value: 'tom' });
  assert.deepEqual(decodeToken(encodeToken(['m', 'act', 42])), { ns: 'm', verb: 'act', taskId: 42, value: null });
  assert.deepEqual(decodeToken(encodeToken(['m', 'more', 42])), { ns: 'm', verb: 'more', taskId: 42, value: null });
  assert.deepEqual(decodeToken('m:list'), { ns: 'm', verb: 'list', taskId: null, value: null });
  assert.deepEqual(decodeToken('m:hub'), { ns: 'm', verb: 'hub', taskId: null, value: null });
  assert.deepEqual(decodeToken('m:hub:do'), { ns: 'm', verb: 'hub', taskId: null, value: 'do' });
  assert.deepEqual(decodeToken('x'), { ns: 'x', verb: null, taskId: null, value: null });
});

test('decodeToken returns null for legacy labels and garbage', () => {
  for (const lbl of LEGACY_LABELS) assert.equal(decodeToken(lbl), null, `legacy "${lbl}" must not decode`);
  assert.equal(decodeToken('a:done:notanumber'), null);  // bad taskId
  assert.equal(decodeToken('m:act:'), null);              // missing taskId
  assert.equal(decodeToken(''), null);
  assert.equal(decodeToken(null), null);
});

test('isStructured: true only for a:/m:/x, false for every legacy label', () => {
  assert.equal(isStructured('a:done:42'), true);
  assert.equal(isStructured('m:list'), true);
  assert.equal(isStructured('x'), true);
  for (const lbl of LEGACY_LABELS) assert.equal(isStructured(lbl), false, `legacy "${lbl}" must be unstructured`);
});

test('encodeToken throws above the 60-byte cap (e.g. a pathological category key)', () => {
  const longKey = 'x'.repeat(60);
  assert.throws(() => encodeToken(['a', 'cat', 999999999, longKey]), /too long/);
});

test('button builders are well-formed { text, data } rows', () => {
  const task = { id: 5, priority: 3, category: 'health' };
  for (const rows of [taskActionMenu(task), taskMoreMenu(task), startedMenu(task), priorityMenu(5, 3), scheduleMenu(5), categoryMenu(5, 'health')]) {
    assert.ok(Array.isArray(rows) && rows.length);
    for (const row of rows) for (const b of row) {
      assert.equal(typeof b.text, 'string');
      assert.equal(typeof b.data, 'string');
    }
  }
  // Every action menu ends with a Back affordance.
  const back = (rows) => rows.flat().some((b) => b.text === MENU_LABELS.back);
  assert.ok(back(taskMoreMenu(task)) && back(priorityMenu(5)) && back(scheduleMenu(5)) && back(categoryMenu(5)));
});

test('startedMenu carries an ⏸ Unstart (a:unstart) beside Done and Snooze', () => {
  const datas = startedMenu({ id: 5 }).flat().map((b) => b.data);
  assert.ok(datas.includes('a:unstart:5'), 'started card offers the way back to not-started');
  assert.ok(datas.includes('a:done:5') && datas.includes('a:snz:5'));
});

test('priorityMenu marks the current level with a check', () => {
  const rows = priorityMenu(5, 2);
  const med = rows.flat().find((b) => b.data === 'a:prio:5:2');
  const high = rows.flat().find((b) => b.data === 'a:prio:5:3');
  assert.match(med.text, /✓/);
  assert.doesNotMatch(high.text, /✓/);
});

test('categoryMenu covers every live category exactly once', () => {
  const cells = categoryMenu(5).flat().filter((b) => b.data.startsWith('a:cat:'));
  const keys = cells.map((b) => decodeToken(b.data).value).sort();
  assert.deepEqual(keys, [...CATEGORIES].sort());
});

test('listPageKeyboard shows only the page directions that exist (m:page tokens)', () => {
  assert.equal(listPageKeyboard({ hasPrev: false, hasNext: false }), null, 'single page → no controls');
  assert.deepEqual(listPageKeyboard({ hasNext: true }), [[{ text: 'Next →', data: 'm:page:next' }]]);
  assert.deepEqual(listPageKeyboard({ hasPrev: true }), [[{ text: '‹ Prev', data: 'm:page:prev' }]]);
  const both = listPageKeyboard({ hasPrev: true, hasNext: true }).flat().map((b) => b.data);
  assert.deepEqual(both, ['m:page:prev', 'm:page:next']);
});

test('m:page tokens decode to a no-task paging direction', () => {
  assert.deepEqual(decodeToken('m:page:next'), { ns: 'm', verb: 'page', taskId: null, value: 'next' });
  assert.deepEqual(decodeToken('m:page:prev'), { ns: 'm', verb: 'page', taskId: null, value: 'prev' });
});

test('justFiledMenu offers Suggest steps + an Edit on the freshly-filed card', () => {
  assert.deepEqual(justFiledMenu({ id: 9 }), [[
    { text: MENU_LABELS.guess, data: 'a:guess:9' },
    { text: MENU_LABELS.edit, data: 'm:act:9' },
  ]]);
});

test('taskActionMenu adds "💡 Suggest steps" only when guess:true', () => {
  const plain = taskActionMenu({ id: 5 }).flat().map((b) => b.data);
  assert.ok(!plain.includes('a:guess:5'), 'default menu has no guess row');
  const withGuess = taskActionMenu({ id: 5 }, { guess: true });
  assert.deepEqual(withGuess[0], [{ text: MENU_LABELS.guess, data: 'a:guess:5' }], 'guess is the first row');
  assert.ok(withGuess.flat().some((b) => b.data === 'a:done:5'), 'still keeps the usual actions');
});

test('taskFilterKeyboard: counted PLAIN chips (categories + difficulties) + Today/All, none structured', () => {
  const rows = taskFilterKeyboard({
    cats: ['household', 'task'], byCat: { household: 8, task: 3 },
    effs: ['low', 'high'], byEff: { low: 5, high: 2 },
  });
  const chips = rows.flat();
  // Every chip carries a tappable label + a PLAIN (non-structured) filter word, so a tap routes like typing it.
  for (const b of chips) {
    assert.equal(typeof b.text, 'string');
    assert.equal(isStructured(b.data), false, `chip "${b.data}" must not look like a menu token`);
  }
  // Categories use their label + count; the data is the raw key (parses back to the category filter).
  assert.ok(chips.some((b) => b.data === 'household' && /\(8\)/.test(b.text)));
  assert.ok(chips.some((b) => b.data === 'task'));
  // Difficulties carry their effort level + count.
  assert.ok(chips.some((b) => b.data === 'low' && /\(5\)/.test(b.text)));
  // Always offers the 📅 Today and 📋 All shortcuts.
  assert.ok(chips.some((b) => b.data === 'today'));
  assert.ok(chips.some((b) => b.data === 'all'));
});

test('taskFilterKeyboard caps category chips and is 3-per-row', () => {
  const cats = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const byCat = Object.fromEntries(cats.map((c, i) => [c, i + 1]));
  const rows = taskFilterKeyboard({ cats, byCat, effs: [], byEff: {} });
  const catChips = rows.flat().filter((b) => cats.includes(b.data));
  assert.equal(catChips.length, 6, 'only the top 6 categories become chips (the rest reachable via All)');
  assert.ok(rows.every((r) => r.length <= 3), 'no row wider than 3');
});

test('guideMenu: PLAIN "guide <topic>" chips + rules/howto + a command-menu link', () => {
  const rows = guideMenu(['steps', 'capturing', 'metrics']); // a gated subset to prove filtering
  const chips = rows.flat();
  // Every chip EXCEPT the structured ✕ dismiss must route like a typed line.
  for (const b of chips.filter((b) => b.data !== 'm:hide:x')) assert.equal(isStructured(b.data), false, `guide chip "${b.data}" must route like a typed line`);
  assert.ok(chips.some((b) => b.data === 'guide steps'));
  assert.ok(chips.some((b) => b.data === 'guide capturing'));
  assert.ok(chips.some((b) => b.data === 'guide metrics'), 'shows a topic only when passed in (gating is the caller’s job)');
  assert.ok(chips.some((b) => b.data === 'rules') && chips.some((b) => b.data === 'howto'));
  assert.ok(chips.some((b) => b.data === '/menu'), 'a link out to the tappable command menu');
  assert.ok(chips.some((b) => b.data === 'm:hide:x'), 'a ✕ to dismiss the help screen');
  assert.ok(rows.every((r) => r.length <= 2), 'topics read as words → at most 2 per row');
  // A topic passed but unlabeled is simply skipped (never crashes / leaks a raw key).
  assert.deepEqual(guideMenu(['nope']).flat().filter((b) => b.data.startsWith('guide ')), []);
});

test('GUIDE_BACK is a plain "guide" tap back to the hub, plus a ✕ dismiss', () => {
  assert.deepEqual(GUIDE_BACK, [[{ text: '‹ All topics', data: 'guide' }, { text: '✕', data: 'm:hide:x' }]]);
  assert.equal(isStructured(GUIDE_BACK[0][0].data), false);
});

test('commandHubMenu: one structured m:cmd:<key> button per section; COMMAND_BACK reopens the hub', () => {
  const chips = commandHubMenu().flat();
  const sectionChips = chips.filter((b) => b.data !== 'm:hide:x'); // the ✕ dismiss isn't a section
  assert.equal(sectionChips.length, COMMAND_SECTIONS.length);
  for (const s of COMMAND_SECTIONS) {
    const chip = chips.find((b) => b.data === `m:cmd:${s.key}`);
    assert.ok(chip, `a button for the ${s.key} section`);
    assert.equal(chip.text, s.label);
    const d = decodeToken(chip.data);                 // resolves to a no-task section token
    assert.deepEqual(d, { ns: 'm', verb: 'cmd', taskId: null, value: s.key });
  }
  assert.ok(chips.some((b) => b.data === 'm:hide:x'), 'a ✕ to dismiss the hub');
  assert.ok(commandHubMenu().every((r) => r.length <= 2), 'labels read as words → at most 2 per row');
  // The back footer is the same token with no key → the dispatcher re-opens the hub, plus a ✕ dismiss.
  assert.deepEqual(COMMAND_BACK, [[{ text: '‹ All sections', data: 'm:cmd' }, { text: '✕', data: 'm:hide:x' }]]);
  assert.deepEqual(decodeToken('m:cmd'), { ns: 'm', verb: 'cmd', taskId: null, value: null });
});

test('every always-on guide topic has a chip in the hub', () => {
  const always = GUIDE_TOPICS.filter((t) => t !== 'metrics'); // metrics is gated
  const chips = guideMenu(always).flat().map((b) => b.data);
  for (const t of always) assert.ok(chips.includes(`guide ${t}`), `${t} should have a hub chip`);
});

test('the Stats hub group replaces the old "Me" label (no lamp emoji)', () => {
  assert.equal(MENU_LABELS.hubMe, '📊 Stats');
  assert.doesNotMatch(JSON.stringify(MENU_LABELS), /🪔/);
});

test('hub expands a group to plain command leaves + Back', () => {
  const top = hubMenu().flat();
  assert.ok(top.every((b) => b.data.startsWith('m:hub:')));
  const group = hubGroupMenu('do');
  assert.ok(group.flat().some((b) => b.data === '/whatdo'));   // a leaf is a plain command
  assert.ok(group.flat().some((b) => b.data === 'm:hub'));     // Back to the top hub
  assert.equal(hubGroupMenu('nope'), null);
});
