// Telegram message-handling logic (no live bot needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-tg-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleIncoming } = await import('../server/channels/telegram-handler.js');
const { finalizePlaceholder, inlineKeyboard, inlineButtons, supersedeList, createReactor, ackInBackground } = await import('../server/channels/telegram.js');
const { CLOSE_BTN } = await import('../server/menu.js');
const { setTelegramConfig } = await import('../server/settings.js');
const { listTasks, defaultUserId, insertImage, getImage } = await import('../server/repo.js');

migrate();
// Modules are per-user opt-in (default OFF); opt the root user into Notes/Lists/Vouch for the behaviour
// tests. Metrics is left OFF on purpose — the "c" menu test below asserts /tally stays hidden by default.
(await import('../server/settings.js')).setUserFeatures(1, { notes: true, lists: true, vouch: true });

// Stand in for the bot's photo handler: record an images row holding the Telegram file_id, then return the
// new image id (what the real handler hands to respond()/handleIncoming after capturing the file_id — no
// download, no bytes). Returns { imageId, fileId } so a test can assert the photo is re-sent by reference.
let fileSeq = 0;
function storeImage(userId) {
  const fileId = `tg-file-${++fileSeq}`;
  return { imageId: insertImage({ userId, fileId }).id, fileId };
}

// Runs first, before any task is filed: a brand-new user pressing Telegram's Start button (a bare
// "/start") gets onboarded with the rules + how-to-fill, not the command list.
test('/start onboards a brand-new user (no tasks) with the rules + how-to', async () => {
  const reply = (await handleIncoming({ text: '/start' })).reply;
  assert.match(reply, /Rules of Fanad/);         // the rules
  assert.match(reply, /How to fill your Fanad/); // and the how-to onboarding
});

test('plain text files a task and confirms', async () => {
  const r = await handleIncoming({ text: 'clean the garage real quick' });
  assert.match(r.reply, /Filed/);
  assert.ok(listTasks(defaultUserId()).length >= 1);
});

test('/help pops the topic hub; /commands pops the tappable section hub', async () => {
  const help = await handleIncoming({ text: '/help' });
  assert.ok(help.buttons.flat().some((b) => b.data === 'guide steps'));
  const cmds = await handleIncoming({ text: '/commands' });
  assert.ok(cmds.buttons.flat().some((b) => b.data === 'm:cmd:tasks'));
});

// Now that the user has tasks, a bare "/start" is a returning user, not onboarding → the command hub.
test('/start for a returning user (has tasks) shows the command hub', async () => {
  const r = await handleIncoming({ text: '/start' });
  assert.ok(r.buttons.flat().some((b) => b.data === 'm:cmd:tasks'));
});

test('/start 3 still starts a task, never onboards', async () => {
  const r = await handleIncoming({ text: '/start 1' });
  assert.doesNotMatch(r.reply, /Rules of Fanad/);
});

test('/whatdo returns a suggestion', async () => {
  assert.ok((await handleIncoming({ text: '/whatdo' })).reply.length > 0);
});

test('/tasks lists open tasks', async () => {
  assert.match((await handleIncoming({ text: '/tasks' })).reply, /garage|No open/);
});

test('“c” returns a tappable menu of the argless commands', async () => {
  const r = await handleIncoming({ text: 'c' });
  assert.ok(r.options?.includes('/whatdo') && r.options.includes('/tasks'));
  assert.ok(!r.options.includes('/tally')); // Metrics off by default → hidden from the menu
});

test('options render as inline bubbles (callback_data per button); a long menu grids 3-per-row', () => {
  assert.equal(inlineKeyboard([]), null);
  const few = inlineKeyboard(['yes', 'no', 'smaller']);
  assert.deepEqual(few.inline_keyboard, [[{ text: 'yes', callback_data: 'yes' }], [{ text: 'no', callback_data: 'no' }], [{ text: 'smaller', callback_data: 'smaller' }]]);
  const many = inlineKeyboard(['/whatdo', '/tasks', '/notes', '/lists', '/me']); // > 4 → grid
  assert.equal(many.inline_keyboard.length, 2);          // 3 + 2
  assert.equal(many.inline_keyboard[0].length, 3);
  assert.deepEqual(many.inline_keyboard[0][0], { text: '/whatdo', callback_data: '/whatdo' });
});

test('unknown command is handled gently', async () => {
  assert.match((await handleIncoming({ text: '/frobnicate' })).reply, /don't know/);
});

test('empty message produces no reply', async () => {
  assert.equal((await handleIncoming({ text: '   ' })).reply, null);
});

test('allowlist blocks strangers (silently), allows the owner (case/@ insensitive)', async () => {
  setTelegramConfig({ allowedUsername: 'alice' });
  assert.equal((await handleIncoming({ text: 'hi', username: 'rando' })).reply, null, 'a stranger gets no reply at all (silent drop)');
  assert.match((await handleIncoming({ text: 'water the plants', username: '@ALICE' })).reply, /Filed/);
});

test('ignores non-private chats (groups/channels)', async () => {
  assert.equal((await handleIncoming({ text: 'hi', chatType: 'group' })).reply, null);
});

test('the status header rides only on a task-capture reply, not on lists/guides', async () => {
  setTelegramConfig({ ownerId: null, allowedUsername: '' });
  assert.match((await handleIncoming({ text: 'wash the car' })).reply, /^\[ /, 'a capture leads with the [ … ] status header');
  assert.doesNotMatch((await handleIncoming({ text: '/tasks' })).reply, /^\[ /, 'a list has no header');
  assert.doesNotMatch((await handleIncoming({ text: '/howto' })).reply, /^\[ /, 'a guide has no header');
});

test('with no allowlist, first chatter claims the bot; others are turned away (silently)', async () => {
  setTelegramConfig({ ownerId: null, allowedUsername: '' });
  assert.match((await handleIncoming({ text: 'water the plants', fromId: 111 })).reply, /Filed/);
  assert.equal((await handleIncoming({ text: 'let me in', fromId: 222 })).reply, null, 'a non-owner gets pure silence');
});

// ── photos: caption → task, file_id stored + attached, re-sent (by reference) with the confirmation ──
test('a captioned photo files the task and re-sends it by file_id, attached to that task', async () => {
  setTelegramConfig({ ownerId: null, allowedUsername: '' }); // root user path (no fromId)
  const uid = defaultUserId();
  const { imageId, fileId } = storeImage(uid);
  const r = await handleIncoming({ text: 'receipt from the hardware store', imageId });
  assert.match(r.reply, /Filed/);
  assert.match(r.reply, /hardware store/);          // the caption IS the task text
  assert.equal(r.photo, fileId);                    // re-sent by file_id with the confirmation
  assert.ok(getImage(uid, imageId).task_id != null); // and associated with the new task
});

test('a captionless photo lands in the notes inbox (not the task list), file_id attached', async () => {
  setTelegramConfig({ ownerId: null, allowedUsername: '' });
  const uid = defaultUserId();
  const { imageId, fileId } = storeImage(uid);
  const r = await handleIncoming({ text: '', imageId });
  assert.match(r.reply, /Noted/);          // self-voicemail inbox, not a filed task
  assert.equal(r.photo, fileId);           // still shown back (by file_id) so the user sees what was kept
  const img = getImage(uid, imageId);
  assert.equal(img.task_id, null);
  assert.ok(img.note_id != null);          // attached to the note
});

// ── the "💭 thinking…" placeholder must never linger alongside the answer ──
function fakeCtx({ editThrows = false } = {}) {
  const calls = { edit: 0, del: 0, reply: 0, repliedMarkup: undefined };
  const ctx = {
    calls,
    api: {
      async editMessageText() { calls.edit += 1; if (editThrows) throw new Error('cannot edit'); return true; },
      async deleteMessage() { calls.del += 1; return true; },
    },
    async reply(_text, opts) { calls.reply += 1; calls.repliedMarkup = opts?.reply_markup; return { message_id: 999 }; },
  };
  return ctx;
}

test('placeholder: no keyboard + edit ok → morph in place (no delete, no resend)', async () => {
  const ctx = fakeCtx();
  const id = await finalizePlaceholder(ctx, 1, 42, 'answer', null);
  assert.equal(id, 42);
  assert.deepEqual([ctx.calls.edit, ctx.calls.del, ctx.calls.reply], [1, 0, 0]);
});

test('placeholder: edit fails → delete THEN resend, so both never show', async () => {
  const ctx = fakeCtx({ editThrows: true });
  const id = await finalizePlaceholder(ctx, 1, 42, 'answer', null);
  assert.equal(id, 999);
  assert.deepEqual([ctx.calls.edit, ctx.calls.del, ctx.calls.reply], [1, 1, 1]);
});

test('placeholder: a reply keyboard always replaces it (edit can’t carry one)', async () => {
  const ctx = fakeCtx();
  const km = { keyboard: [[{ text: 'yes' }]] };
  await finalizePlaceholder(ctx, 1, 42, 'pick', km);
  assert.deepEqual([ctx.calls.edit, ctx.calls.del, ctx.calls.reply], [0, 1, 1]);
  assert.deepEqual(ctx.calls.repliedMarkup, km);
});

test('placeholder: none present → just send the answer', async () => {
  const ctx = fakeCtx();
  await finalizePlaceholder(ctx, 1, null, 'hi', null);
  assert.deepEqual([ctx.calls.edit, ctx.calls.del, ctx.calls.reply], [0, 0, 1]);
});

// ── one live list per chat: a new list deletes the previous one (anti-clutter) ──
test('supersedeList drops the previous list per chat; chats are independent; same id is a no-op', () => {
  const deleted = [];
  const ctx = { api: { async deleteMessage(chatId, msgId) { deleted.push([chatId, msgId]); return true; } } };
  supersedeList(ctx, 10, 100);                 // first list in chat 10 → nothing to delete yet
  assert.deepEqual(deleted, []);
  supersedeList(ctx, 10, 101);                 // new list supersedes → delete 100
  assert.deepEqual(deleted, [[10, 100]]);
  supersedeList(ctx, 20, 200);                 // a different chat doesn't touch chat 10's list
  assert.deepEqual(deleted, [[10, 100]]);
  supersedeList(ctx, 10, 101);                 // re-tracking the SAME message must not delete it
  assert.deepEqual(deleted, [[10, 100]]);
  supersedeList(ctx, 10, 102);                 // next new list → delete 101
  assert.deepEqual(deleted, [[10, 100], [10, 101]]);
});

test('supersedeList is a no-op when the chat or message id is missing', () => {
  const ctx = { api: { async deleteMessage() { throw new Error('should not delete'); } } };
  supersedeList(ctx, null, 5);
  supersedeList(ctx, 7, null);                  // no throw, nothing deleted
});

// ── reactions must never block the reply or freeze grammY's strictly-sequential update loop ──
// (This was the "it hung + 👀 stuck + nothing in the logs" bug: the two-step reaction ack was awaited on the
// reply's critical path, so one stalled setMessageReaction froze the whole bot for up to the client timeout.)

test('ackInBackground is fire-and-forget: a HUNG reaction call never blocks the caller', async () => {
  let release;
  const hung = new Promise((res) => { release = res; }); // stands in for a stalled setMessageReaction
  let settled = false;
  const bg = ackInBackground(() => hung, '\u{1FAE1}').then(() => { settled = true; });
  await Promise.resolve(); // give any (wrongly) synchronous await a chance to run
  assert.equal(settled, false, 'the caller moved on while the reaction is still pending — the reply is not gated on it');
  release(true);
  await bg;
  assert.equal(settled, true, 'it does settle once the reaction resolves (just not on the critical path)');
});

test('ackInBackground: on a reaction-IS-reply turn, the text fallback fires ONLY if the reaction never lands', async () => {
  let sent = null;
  const fallback = () => { sent = 'text'; };
  await ackInBackground(() => Promise.resolve(false), '\u{1FAE1}', { isReply: true, fallback });
  assert.equal(sent, 'text', 'reaction failed → the saved mood/note is acked by text, never silence');
  sent = null;
  await ackInBackground(() => Promise.resolve(true), '\u{1FAE1}', { isReply: true, fallback });
  assert.equal(sent, null, 'reaction landed → no redundant text bubble');
  sent = null;
  await ackInBackground(() => Promise.resolve(false), '\u{1FAE1}', { isReply: false, fallback });
  assert.equal(sent, null, 'a decorative reaction never sends a fallback, even when it fails');
});

test('createReactor fires 👀 at once and swaps only after the 👀 SET resolves (no out-of-order re-stick)', async () => {
  const calls = [];
  let releaseThink;
  const ctx = { api: { setMessageReaction: (_cid, _mid, r) => {
    const emoji = r[0]?.emoji ?? '';
    calls.push(emoji);
    if (emoji === '\u{1F440}') return new Promise((res) => { releaseThink = res; }); // hold the 👀 SET open
    return Promise.resolve(true);
  } } };
  const { swap } = createReactor(ctx, { chatId: 1, userMsgId: 2, canReact: true });
  assert.deepEqual(calls, ['\u{1F440}'], '👀 fired at construction, before the brain runs');
  const done = swap('\u{1FAE1}'); // 🫡 — must wait for the 👀 SET first
  await Promise.resolve();
  assert.deepEqual(calls, ['\u{1F440}'], 'the decision is withheld while the 👀 SET is still pending');
  releaseThink(true);
  await done;
  assert.deepEqual(calls, ['\u{1F440}', '\u{1FAE1}'], 'decision sent only after 👀 confirmed');
});

test('createReactor: canReact=false (a tapped bubble / group) makes react + swap inert (no API call)', async () => {
  const ctx = { api: { setMessageReaction: () => { throw new Error('must not react on a bubble tap'); } } };
  const { swap } = createReactor(ctx, { chatId: null, userMsgId: null, canReact: false });
  assert.equal(await swap('\u{1FAE1}'), false, 'nothing to react to → resolves false, no throw');
});

// Pushed notifications (nudges/reminders) carry a one-tap dismiss whose token is the message-deleting one —
// handleMenuTap maps m:hide:x to ctx.deleteMessage (covered in tweaks.test.js), so the ✕ clears the nudge.
test('a pushed notification’s ✕ carries the message-deleting dismiss token', () => {
  const km = inlineButtons([[CLOSE_BTN]]);
  assert.deepEqual(km, { inline_keyboard: [[{ text: '✕', callback_data: 'm:hide:x' }]] });
});
