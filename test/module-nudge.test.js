// Module-detection nudge: when a capture looks like it belongs to an OFF module (a pasted checklist → Lists,
// a meal log → Metrics), the task is filed as usual AND a one-tap "turn it on" is offered — at most once a
// day per module, and never auto-acting (it only offers; it never creates a list/metric or flips the module).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-nudge-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage, handleAction } = await import('../server/chat.js');
const { getUserFeatures, setUserFeatures, setSetting } = await import('../server/settings.js');

migrate();
const uid = 1;
const datasOf = (r) => (r.buttons || []).flat().map((b) => b.data);
// Reset a module's once-a-day nudge gate so a test can observe the first-time nudge deterministically.
const resetNudge = (mod) => setSetting(`daily_gate:module_nudge:${mod}:${uid}`, 0);

test('a pasted checklist files ONE task and offers to turn on Lists — without auto-acting', async () => {
  setUserFeatures(uid, { lists: false });
  resetNudge('lists');
  const r = await handleMessage({ text: '- buy milk\n- buy eggs' });
  assert.match(r.reply, /Filed|✓/i, 'still filed as an ordinary task');
  assert.ok(datasOf(r).includes('m:optin:lists'), 'offers a Turn-on-Lists button');
  assert.equal(getUserFeatures(uid).lists, false, 'the nudge only offers — it never turns the module on');
});

test('the nudge is throttled to once a day per module', async () => {
  setUserFeatures(uid, { lists: false }); // (slot is already marked by the previous test)
  const r = await handleMessage({ text: '- buy bread\n- buy jam' });
  assert.ok(!datasOf(r).includes('m:optin:lists'), 'a second checklist the same day does not nudge again');
});

test('a meal-shaped capture offers to turn on Diet', async () => {
  setUserFeatures(uid, { diet: false });
  resetNudge('diet');
  // Doesn't start with eat/ate (that's the command gate) — a plain capture with a food word in it.
  const r = await handleMessage({ text: 'had a big breakfast burrito' });
  assert.ok(datasOf(r).includes('m:optin:diet'), 'offers a Turn-on-Diet button');
});

test('an eat command with Diet off gets the module offer directly (the command gate, not the nudge)', async () => {
  setUserFeatures(uid, { diet: false });
  const r = await handleMessage({ text: 'ate a big breakfast burrito' });
  assert.ok(datasOf(r).includes('m:optin:diet'), 'the gate reply carries the turn-on button');
});

test('tapping the offer turns the module on', async () => {
  setUserFeatures(uid, { lists: false });
  await handleAction(uid, 'm:optin:lists');
  assert.equal(getUserFeatures(uid).lists, true);
});

test('no nudge once the module is already on', async () => {
  setUserFeatures(uid, { lists: true });
  resetNudge('lists');
  const r = await handleMessage({ text: '- already\n- have lists' });
  assert.ok(!datasOf(r).includes('m:optin:lists'), 'an on module is never nudged');
});

test('an ordinary one-line task triggers no nudge at all', async () => {
  setUserFeatures(uid, { lists: false, diet: false });
  resetNudge('lists'); resetNudge('diet');
  const r = await handleMessage({ text: 'water the plants' });
  const d = datasOf(r);
  assert.ok(!d.includes('m:optin:lists') && !d.includes('m:optin:diet'), 'no false-positive nudge');
});
