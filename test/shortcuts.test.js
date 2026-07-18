// Leading single-letter shortcuts — "n …"→/note, "t …"→/task, "d …"→/done, "s …"→/step, "r …"→/recall,
// "g …"→guide, and a bare "w"→/whatdo. They expand to the canonical command ONLY at the very start of a
// message; a bare letter stays itself ("n" = "no"); a letter glued to more text ("turn") is never a command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-shortcuts-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage } = await import('../server/chat.js');
const { clearDialogState } = await import('../server/dialog.js');
const { defaultUserId, listTasks } = await import('../server/repo.js');

migrate();
const uid = defaultUserId();
// Modules are per-user opt-in (default OFF); these behaviour tests run as the root user with all on.
(await import('../server/settings.js')).setUserFeatures(uid, { notes: true, lists: true, metrics: true, vouch: true });
// Each `say` is an independent turn (clears any open question first); `send` keeps dialog state across turns.
// Note: clearDialogState does NOT wipe the last listing, so "/tasks" then say("d N") still resolves N.
const say = (text) => { clearDialogState(uid); return handleMessage({ userId: uid, text }); };
const send = (text) => handleMessage({ userId: uid, text });

test('"n <text>" files a note', async () => {
  assert.match((await say('n the spare key is under the blue pot')).reply, /Noted/);
});

test('"t <text>" files a task', async () => {
  assert.match((await say('t book the dentist by friday')).reply, /Filed/);
});

test('"s <text>" adds a step to the most-recent open task', async () => {
  await say('t mow the lawn');
  const out = await say('s rake the clippings after');
  assert.match(out.reply, /Step 1 added to .*lawn/i);
});

test('"d <N>" finishes item N on the current listing', async () => {
  await say('t alpha shortcut target');
  const list = (await say('/tasks all')).reply;          // flat numbered slice; listing survives the next say
  const pos = Number(new RegExp('(\\d+)\\.[^\\n]*alpha shortcut target', 'i').exec(list)?.[1]);
  assert.ok(pos, 'the target task should appear in the listing');
  assert.match((await say(`d ${pos}`)).reply, /Done/);
});

test('"r <text>" routes to recall — searches notes, never files a task', async () => {
  await say('n the router password is on the fridge');
  const before = listTasks(uid).length;
  const out = await say('r router password');
  assert.equal(listTasks(uid).length, before);           // recall doesn't create a task
  assert.doesNotMatch(out.reply, /Filed|don.t know/i);   // and didn't fall through to capture / unknown
});

test('bare "u" pops the undo stack — takes back the last capture', async () => {
  await say('t undo shortcut target');
  const before = listTasks(uid).length;
  const out = await say('u');
  assert.match(out.reply, /↩ Undid that — “undo shortcut target”/);
  assert.equal(listTasks(uid).length, before - 1);
});

test('bare "w" asks what to do next (argless, no trailing text needed)', async () => {
  await say('t something worth suggesting');
  const out = await say('w');
  assert.match(out.reply, /💡/);
  assert.equal(out.mode, 'suggestion');
});

test('"g <topic>" opens the topic guide, including the new shortcuts guide', async () => {
  assert.match((await say('g steps')).reply, /Guide: Steps/);
  assert.match((await say('g shortcuts')).reply, /Guide: Shortcuts/);
});

test('the shortcuts guide also resolves the normal ways', async () => {
  assert.match((await say('guide shortcuts')).reply, /Guide: Shortcuts/);   // canonical
  assert.match((await say('shortcuts guide')).reply, /Guide: Shortcuts/);   // reversed phrasing
  assert.match((await say('guide letters')).reply, /Guide: Shortcuts/);     // alias
});

test('a bare letter is NOT a shortcut — "n" still means "no"', async () => {
  const before = listTasks(uid).length;
  const out = await say('n');
  assert.equal(out.reply, '👍');                          // FILLER_RE handles a lone "no"
  assert.equal(listTasks(uid).length, before);           // and it filed nothing
});

test('"y" is never a shortcut (reserved as "yes")', async () => {
  assert.equal((await say('y')).reply, '👍');
});

test('a real sentence whose first word starts with a shortcut letter is untouched', async () => {
  // "turn …" begins with t but the letter isn't standalone (no space after it) → files as a task.
  assert.match((await say('turn left at the light')).reply, /Filed/);
});

test('a shortcut escapes an open question, just like the typed command', async () => {
  await say('t a task to be suggested');
  await send('/whatdo');                                  // arms the suggestion dialog (no clear)
  const out = await send('n jot this down mid-suggestion');
  assert.match(out.reply, /Noted/);                       // escaped the dialog and filed the note
});
