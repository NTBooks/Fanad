// Regression tests for the UX tweak batch: explicit-note trailing "?", the bare-word ("all") guard, the
// conditional "‹ Back to list" button, the "✕ Hide" list dismissal, and the note-capture `kind` signal the
// Telegram adapter uses to ack with a ✍ reaction. All go through the brain (handleMessage/handleAction).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-tweaks-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage, handleAction } = await import('../server/chat.js');
const { clearDialogState, resolveListing } = await import('../server/dialog.js');
const { defaultUserId, insertTask, listTasks, listNotes } = await import('../server/repo.js');

migrate();
// Modules are per-user opt-in (default OFF); these behaviour tests run as the root user with all on.
(await import('../server/settings.js')).setUserFeatures(1, { notes: true, lists: true, metrics: true, vouch: true });
const uid = defaultUserId();
const say = (text) => { clearDialogState(uid); return handleMessage({ text }); }; // listing/page survive a dialog clear
const datas = (r) => (r.buttons || []).flat().map((b) => b.data);
const openTasks = () => listTasks(uid).filter((t) => t.status === 'available' || t.status === 'in_progress');

// ── Item 8: a bare list-answer word must never be filed as a task ──
test('item 8: a bare "all" with nothing listed is not filed as a task', async () => {
  const r = await say('all'); // nothing has been listed yet → no live list to apply it to
  assert.equal(listTasks(uid).filter((t) => t.summary.toLowerCase() === 'all').length, 0, 'no task named "all"');
  assert.match(r.reply ?? r.text, /reply to a list|nothing/i);
});

test('item 8: a bare "all" WHILE a list is in view re-applies it as a filter (acts on the last list)', async () => {
  for (let i = 1; i <= 3; i++) insertTask({ userId: uid, summary: `task ${i}`, category: 'task', effortLevel: 'low' });
  await say('/tasks');                    // arm a listing
  const before = openTasks().length;
  const r = await say('all');             // a single word → applies to "the last asked thing"
  assert.equal(r.listing, true, '"all" shows the task list, not a new task');
  assert.equal(openTasks().length, before, 'no task was created from "all"');
});

test('item 8: bare "tasks"/"Tasks" is the /tasks command, never the Projects category or a "reply to a list" nudge', async () => {
  for (let i = 1; i <= 3; i++) insertTask({ userId: uid, summary: `proj ${i}`, category: 'task', effortLevel: 'low' });
  const r = await say('tasks');                       // the word collides with the 'task' category key — must not slice
  assert.equal(r.listing, true, 'shows the task list');
  assert.doesNotMatch(r.reply ?? r.text, /reply to a list/i, 'not read as a stray filter word');
  assert.equal(listTasks(uid).filter((t) => t.summary.toLowerCase() === 'tasks').length, 0, 'no task named "tasks"');
  assert.equal((await say('Tasks')).listing, true, 'capital "Tasks" too');
  // bare "notes" === /notes (don't file a junk task named "notes")
  await say('note the gate code is 4417');             // seed one note so the inbox isn't empty
  assert.match((await say('notes')).reply ?? '', /waiting|inbox/i, 'bare "notes" shows the inbox');
  assert.equal(listTasks(uid).filter((t) => t.summary.toLowerCase() === 'notes').length, 0, 'no task named "notes"');
});

// ── Item 2: an EXPLICIT note may end in "?" and still files (not rerouted to the question/whatdo flow) ──
test('item 2: "/note …?" and the "n …?" shortcut file a note despite the trailing question mark', async () => {
  const r1 = await say('/note did I lock the door?');
  assert.equal(r1.kind, 'note', '/note …? files a note');
  const r2 = await say('n call the vet about the booster?');
  assert.equal(r2.kind, 'note', 'the "n …?" shortcut files a note too');
  assert.ok(listNotes(uid, { status: 'new' }).some((n) => /lock the door/.test(n.text)), 'the "?" is kept in the note');
});

test('item 2 guard does not over-capture: a real question still routes (not filed as a note)', async () => {
  const r = await say('what should I do?');
  assert.notEqual(r.kind, 'note', 'a genuine question is not swallowed as a note');
});

// ── Item 1: a captured note reply carries kind:'note' so Telegram can ack with a ✍ reaction (no text) ──
test('item 1: a note capture surfaces kind:"note" on the reply envelope', async () => {
  const r = await handleMessage({ text: 'note the spare key is under the mat' });
  assert.equal(r.kind, 'note');
  const t = await handleMessage({ text: 'buy stamps at the post office' });
  assert.equal(t.kind, null, 'a task capture carries no note kind');
});

// ── Item 9: "✕ Hide" dismisses a list and clears its numbering ──
test('item 9: a task list offers ✕ Hide, and tapping it clears the listing', async () => {
  const list = await say('/tasks');
  assert.ok(datas(list).includes('m:hide'), 'the list carries a Hide button');
  const out = await handleAction(uid, 'm:hide');
  assert.equal(out.hide, true, 'handleAction signals the channel to remove the message');
  assert.equal(out.text, '', 'nothing is rendered in its place');
  assert.equal(resolveListing(uid, 'task', [1]).total, 0, 'the rendered numbering is cleared');
});

// ── Item 4: the "‹ Back to list" button rides a task card only when a list is actually in view ──
test('item 4: a task card omits ‹ Back when no list is in view, and shows it when one is', async () => {
  const tk = insertTask({ userId: uid, summary: 'paint the fence', category: 'household', effortLevel: 'low' });
  await handleAction(uid, 'm:hide');                 // ensure no live list
  const noList = await handleAction(uid, `m:act:${tk.id}`);
  assert.ok(!datas(noList).includes('m:list'), 'no back-to-a-stale-slice button when nothing is listed');
  await say('/tasks');                                // now a list IS in view
  const withList = await handleAction(uid, `m:act:${tk.id}`);
  assert.ok(datas(withList).includes('m:list'), 'back-to-list returns when a list exists to go back to');
});

// ── Item 4/6: a drop/snooze action no longer dangles a back-to-list button ──
test('item 4/6: dropping a task returns no back-to-list button', async () => {
  const tk = insertTask({ userId: uid, summary: 'cancel the old subscription', category: 'admin', effortLevel: 'low' });
  const out = await handleAction(uid, `a:drop:${tk.id}`);
  assert.match(out.text, /Removed/);
  assert.equal(out.buttons, null, 'no “‹ Back” to a now-refreshed list after a mutation');
});

// ── Dismiss: the /tasks overview carries ✕ Hide; the help dismiss (m:hide:x) deletes without clearing state ──
test('the /tasks overview offers ✕ Hide, and a help dismiss leaves task numbering intact', async () => {
  for (let i = 0; i < 9; i++) insertTask({ userId: uid, summary: `ov ${i}`, category: 'recreation', effortLevel: 'low' });
  const ov = await say('/tasks');                                  // > MANY_TASKS ⇒ the counts overview
  assert.match(ov.reply ?? ov.text, /too many to list/i);
  assert.ok((ov.buttons || []).flat().some((b) => b.data === 'm:hide'), 'overview offers ✕ Hide');

  await say('/tasks recreation');                                  // arm a real listing (numbering in place)
  assert.ok(resolveListing(uid, 'task', [1]).total > 0, 'a listing exists');
  const helpDismiss = await handleAction(uid, 'm:hide:x');         // a help-panel ✕ — delete only
  assert.equal(helpDismiss.hide, true);
  assert.ok(resolveListing(uid, 'task', [1]).total > 0, 'm:hide:x leaves the task numbering intact');
  const listHide = await handleAction(uid, 'm:hide');              // a task-list ✕ Hide — clears its numbering
  assert.equal(listHide.hide, true);
  assert.equal(resolveListing(uid, 'task', [1]).total, 0, 'm:hide clears the task numbering');
});
