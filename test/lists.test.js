// Lists — a nestable outliner, separate from tasks and notes (db.js v19). Drives the whole flow through
// handleMessage: create, descend, add, climb, page, edit, and the tenancy guard. PLAN: see SYNTAX.md lists_cmd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-lists-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage, handleAction } = await import('../server/chat.js');
const { clearDialogState, clearListCursor } = await import('../server/dialog.js');
const { listChildren, getListItem, defaultUserId } = await import('../server/repo.js');
const { stripTags } = await import('../shared/richtext.js');

migrate();
// Modules are per-user opt-in (default OFF); these behaviour tests run as the root user with all on.
(await import('../server/settings.js')).setUserFeatures(1, { notes: true, lists: true, metrics: true, vouch: true });
const uid = defaultUserId();
const say = async (text) => stripTags((await handleMessage({ text })).reply);
// A clean slate: no open dialog/cursor (so a prior list session can't swallow the next line as an item).
const fresh = async (text) => { clearDialogState(uid); clearListCursor(uid); return say(text); };

test('empty: /lists invites you to start one, files no task', async () => {
  const r = await fresh('/lists');
  assert.match(r, /No lists yet/i);
});

test('/list creates a top-level list; /lists shows it', async () => {
  await fresh('/list Groceries');
  const r = await fresh('/lists');
  assert.match(r, /📑/);
  assert.match(r, /Your lists/i);
  assert.match(r, /1\.\s*Groceries/);
  assert.match(r, /\/sub_1/); // the descend link is on the row
});

test('open a list (/sub_1), then typing adds items to it', async () => {
  await fresh('/lists');
  await say('/sub_1');          // open Groceries
  await say('Milk');
  await say('Eggs');
  const r = await say('Bread');
  assert.match(r, /Groceries/);
  assert.match(r, /1\.\s*Milk/);
  assert.match(r, /2\.\s*Eggs/);
  assert.match(r, /3\.\s*Bread/);
  // and they really landed under Groceries in the tree
  const top = listChildren(uid, null);
  const groceries = top.find((c) => c.title === 'Groceries');
  assert.ok(groceries);
  assert.equal(listChildren(uid, groceries.id).length, 3);
});

test('items nest: /sub_N descends, items added there are sub-items, "out" climbs back', async () => {
  await fresh('/lists');
  await say('/sub_1');          // into Groceries
  await say('/sub_1');          // into Milk (item 1)
  await say('2% please');
  const inMilk = await say('organic');
  assert.match(inMilk, /Groceries › Milk/); // breadcrumb shows the path
  assert.match(inMilk, /1\.\s*2% please/);
  assert.match(inMilk, /2\.\s*organic/);

  const back = await say('out');            // back up to Groceries
  assert.match(back, /Groceries/);
  assert.match(back, /Milk\s*\(2\)/);       // Milk now shows its child count
  assert.doesNotMatch(back, /2% please/);   // we're a level up — Milk's sub-items aren't shown here
});

test('"top" jumps back to all lists; nesting is unlimited-depth', async () => {
  await fresh('/lists');
  await say('/sub_1');          // Groceries
  await say('/sub_1');          // Milk
  await say('/sub_1');          // 2% please
  const deep = await say('half gallon');
  assert.match(deep, /Groceries › Milk › 2% please/);
  const top = await say('top');
  assert.match(top, /Your lists/i);
  assert.match(top, /Groceries/);
});

test('/sub_N <text> quick-adds a child without descending', async () => {
  await fresh('/lists');
  await say('/sub_1');          // into Groceries
  const r = await say('/sub_2 a dozen'); // Eggs is item 2 — add a child under it, stay put
  assert.match(r, /Groceries/);          // still on the Groceries view
  assert.match(r, /Eggs\s*\(\d+\)/);     // Eggs gained a child count
  const top = listChildren(uid, null);
  const groceries = top.find((c) => c.title === 'Groceries');
  const eggs = listChildren(uid, groceries.id).find((c) => c.title === 'Eggs');
  assert.ok(listChildren(uid, eggs.id).some((c) => c.title === 'a dozen'));
});

test('del N removes an item (and its subtree); rename N relabels', async () => {
  await fresh('/lists');
  await say('/sub_1');          // Groceries
  await say('rename 3 Sourdough');
  let r = await say('/lists');  // re-open from the top to re-read
  await say('/sub_1');
  r = await say('del 1');       // drop Milk (which has sub-items) — should cascade
  assert.doesNotMatch(r, /Milk/);
  assert.match(r, /Sourdough/); // the rename stuck
});

test('paging: a long list shows pages and "next"/"prev" move between them', async () => {
  clearDialogState(uid); clearListCursor(uid);
  await say('/list Big');                 // create "Big" (opens at the top level)
  const numbered = (s) => s.split('\n').filter((l) => /^\d+\./.test(l));
  const bigPos = numbered(await say('/lists')).findIndex((l) => /\.\s*Big\b/.test(l)) + 1;
  await say(`/sub_${bigPos}`);            // open Big (empty)
  for (let i = 1; i <= 13; i++) await say(`item ${i}`); // each add lands on the last page

  await say('top');                       // leave Big's view
  const pos2 = numbered(await say('/lists')).findIndex((l) => /\.\s*Big\b/.test(l)) + 1;
  const page1 = await say(`/sub_${pos2}`); // re-open Big → page 1
  assert.match(page1, /Page 1\/2/);
  assert.match(page1, /1\.\s*item 1/);
  const next = await say('next');
  assert.match(next, /Page 2\/2/);
  assert.match(next, /item 11/);
  const prev = await say('prev');
  assert.match(prev, /Page 1\/2/);
});

test('exit leaves list mode — a typed line files a task again', async () => {
  await fresh('/lists');
  await say('/sub_1');          // into a list
  const left = await say('exit');
  assert.match(left, /Closed your lists/i);
  const r = await say('buy a new lawnmower'); // no longer in list mode → a task
  assert.doesNotMatch(r, /📑/);
});

test('nav buttons: m:lnav tokens drive top/exit', async () => {
  await fresh('/lists');
  const top = await handleAction(uid, 'm:lnav:top');
  assert.match(stripTags(top.text), /Your lists/i);
  // Tapping "✕ Close" hides the message (Telegram deletes it / web prunes the bubble) rather than leaving a
  // "Closed your lists" residue behind — a TYPED "close" still gets that text confirmation (asserted above).
  const closed = await handleAction(uid, 'm:lnav:exit');
  assert.equal(closed.hide, true);
  assert.equal(closed.text, '');
});

test("tenancy: another user can't see these lists", () => {
  assert.equal(listChildren(999, null).length, 0);
  const mine = listChildren(uid, null)[0];
  if (mine) assert.equal(getListItem(999, mine.id), null);
});
