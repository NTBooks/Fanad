// Telegram interactive-menu adapter: structured taps edit the card in place (no placeholder), legacy taps
// keep routing through the brain, and the auth/group gates the structured path bypasses are re-added.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-tgmenu-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMenuTap, inlineButtons, noteChatMessage } = await import('../server/channels/telegram.js');
const { setTelegramConfig } = await import('../server/settings.js');
const { getOrCreateTelegramUser, insertTask, getTask } = await import('../server/repo.js');

migrate();
setTelegramConfig({ allowedUsername: 'alice' }); // deterministic auth: only @alice is allowed

// A fake grammY context recording the API calls a tap triggers (no live bot). `chatId` + `messageId` feed
// the stale-start check; the `api` recorders catch the fresh sends that check can trigger.
function fakeCtx({ data, from = { id: 12345, username: 'alice' }, photo = false, document = false, chatId = null, messageId = 99 } = {}) {
  const calls = { answer: [], editText: [], editCaption: [], editMarkup: 0, sendMessage: [], sendPhoto: [] };
  let nextId = 1000;
  return {
    calls,
    chat: { type: 'private', ...(chatId != null ? { id: chatId } : {}) },
    callbackQuery: { data, from, message: { message_id: messageId, ...(photo ? { photo: [{}] } : {}), ...(document ? { document: {} } : {}) } },
    answerCallbackQuery: async (o) => { calls.answer.push(o ?? null); },
    editMessageText: async (text, other) => { calls.editText.push({ text, other }); return { message_id: messageId }; },
    editMessageCaption: async (other) => { calls.editCaption.push(other); return { message_id: messageId }; },
    editMessageReplyMarkup: async () => { calls.editMarkup += 1; return { message_id: messageId }; },
    api: {
      sendMessage: async (chat, text, other) => { calls.sendMessage.push({ chat, text, other }); return { message_id: nextId++ }; },
      sendPhoto: async (chat, pic, other) => { calls.sendPhoto.push({ chat, pic, other }); return { message_id: nextId++ }; },
      editMessageText: async () => ({}), // refreshHangingList's in-place list refresh (no tracked list here)
    },
  };
}

test('inlineButtons maps { text, data } → { text, callback_data }, preserving rows', () => {
  assert.equal(inlineButtons(null), null);
  const kb = inlineButtons([[{ text: '✓ Done', data: 'a:done:5' }], [{ text: '‹ Back', data: 'm:list' }]]);
  assert.deepEqual(kb.inline_keyboard, [
    [{ text: '✓ Done', callback_data: 'a:done:5' }],
    [{ text: '‹ Back', callback_data: 'm:list' }],
  ]);
});

test('a structured tap edits the card in place with a toast (no new message)', async () => {
  const userId = getOrCreateTelegramUser(12345, 'alice');
  const t = insertTask({ userId, summary: 'call the bank', category: 'admin' });
  const ctx = fakeCtx({ data: `a:prio:${t.id}:3` });
  await handleMenuTap(ctx, ctx.callbackQuery.data);
  assert.equal(ctx.calls.answer.length, 1);
  assert.match(ctx.calls.answer[0].text, /high/i);                       // toast
  assert.equal(ctx.calls.editText.length, 1);                            // edited in place
  assert.ok(ctx.calls.editText[0].other.reply_markup.inline_keyboard);   // refreshed keyboard
  assert.equal(getTask(userId, t.id).priority, 3);
});

test('a structured tap on a photo card uses editMessageCaption, not editMessageText', async () => {
  const userId = getOrCreateTelegramUser(12345, 'alice');
  const t = insertTask({ userId, summary: 'water the plants', category: 'household' });
  const ctx = fakeCtx({ data: `m:act:${t.id}`, photo: true });
  await handleMenuTap(ctx, ctx.callbackQuery.data);
  assert.equal(ctx.calls.editCaption.length, 1);
  assert.equal(ctx.calls.editText.length, 0);
});

// Regression: a dated task's card is delivered as an .ics DOCUMENT (replyWithDocument), so its "⋯ Edit"
// (and Done/Start/Snooze) taps must edit the caption — editMessageText 400s on a media message and the tap
// would silently do nothing.
test('a structured tap on a document (.ics) card uses editMessageCaption, not editMessageText', async () => {
  const userId = getOrCreateTelegramUser(12345, 'alice');
  const t = insertTask({ userId, summary: 'dentist appointment', category: 'admin' });
  const ctx = fakeCtx({ data: `m:act:${t.id}`, document: true });
  await handleMenuTap(ctx, ctx.callbackQuery.data);
  assert.equal(ctx.calls.editCaption.length, 1);
  assert.ok(ctx.calls.editCaption[0].reply_markup.inline_keyboard); // the action menu actually appears
  assert.equal(ctx.calls.editText.length, 0);
});

test('the 🔔 Remind picker sets a one-time reminder in place, then clears it', async () => {
  const userId = getOrCreateTelegramUser(12345, 'alice');
  const t = insertTask({ userId, summary: 'book the dentist', category: 'health', dueAt: Date.now() + 3 * 86400000, dueKind: 'by' });
  // open the picker (m:rem) — edits the card in place, no mutation yet
  let ctx = fakeCtx({ data: `m:rem:${t.id}` });
  await handleMenuTap(ctx, ctx.callbackQuery.data);
  assert.equal(ctx.calls.editText.length, 1);
  assert.equal(getTask(userId, t.id).remind_at, null);
  // tap "In 1h" (a:rem:…:1h) — sets a future reminder, leaves the deadline intact
  ctx = fakeCtx({ data: `a:rem:${t.id}:1h` });
  await handleMenuTap(ctx, ctx.callbackQuery.data);
  assert.match(ctx.calls.answer[0].text, /🔔/);          // toast confirms the reminder
  const after = getTask(userId, t.id);
  assert.ok(after.remind_at > Date.now(), 'reminder set in the future');
  assert.ok(after.due_at > Date.now(), 'deadline preserved');
  // clear it (a:rem:…:clear)
  ctx = fakeCtx({ data: `a:rem:${t.id}:clear` });
  await handleMenuTap(ctx, ctx.callbackQuery.data);
  assert.match(ctx.calls.answer[0].text, /cleared/i);
  assert.equal(getTask(userId, t.id).remind_at, null);
});

test('a stranger tapping a structured button is turned away (no edit)', async () => {
  const ctx = fakeCtx({ data: 'a:done:1', from: { id: 999, username: 'rando' } });
  await handleMenuTap(ctx, ctx.callbackQuery.data);
  assert.match(ctx.calls.answer[0].text, /private/i);
  assert.equal(ctx.calls.editText.length, 0);
});

test('a structured tap in a group chat is silently dismissed', async () => {
  const ctx = fakeCtx({ data: 'a:done:1' });
  ctx.chat = { type: 'group' };
  await handleMenuTap(ctx, ctx.callbackQuery.data);
  assert.equal(ctx.calls.editText.length, 0);
  assert.equal(ctx.calls.editCaption.length, 0);
});

test('a start tap on the LATEST message still edits the card in place', async () => {
  const userId = getOrCreateTelegramUser(12345, 'alice');
  const t = insertTask({ userId, summary: 'freshest card', category: 'other' });
  noteChatMessage(501, 99);                                  // the tapped card IS the high-water mark
  const ctx = fakeCtx({ data: `a:start:${t.id}`, chatId: 501, messageId: 99 });
  await handleMenuTap(ctx, ctx.callbackQuery.data);
  assert.equal(ctx.calls.editText.length, 1);
  assert.equal(ctx.calls.sendMessage.length, 0);
  assert.equal(getTask(userId, t.id).status, 'in_progress');
});

test('a start tap on an OLDER message sends a fresh Started card and strips the old buttons', async () => {
  const userId = getOrCreateTelegramUser(12345, 'alice');
  const t = insertTask({ userId, summary: 'buried card', category: 'other' });
  noteChatMessage(502, 150);                                 // chat has moved on past message 99
  const ctx = fakeCtx({ data: `a:start:${t.id}`, chatId: 502, messageId: 99 });
  await handleMenuTap(ctx, ctx.callbackQuery.data);
  assert.equal(ctx.calls.sendMessage.length, 1, 'a fresh message was sent');
  assert.match(ctx.calls.sendMessage[0].text, /Started/);
  assert.equal(ctx.calls.editText.length, 0, 'the old card text is left as history');
  assert.equal(ctx.calls.editMarkup, 1, 'the old card lost its stale buttons');
  assert.equal(getTask(userId, t.id).status, 'in_progress');
});

test('a stale start on a photo-bearing task sends the photo fresh (the edit path would drop it)', async () => {
  const { insertImage } = await import('../server/repo.js');
  const userId = getOrCreateTelegramUser(12345, 'alice');
  const t = insertTask({ userId, summary: 'photo card task', category: 'other' });
  insertImage({ userId, taskId: t.id, fileId: 'tg-file-abc' });
  noteChatMessage(503, 200);
  const ctx = fakeCtx({ data: `a:start:${t.id}`, chatId: 503, messageId: 42 });
  await handleMenuTap(ctx, ctx.callbackQuery.data);
  assert.equal(ctx.calls.sendPhoto.length, 1, 'sent as a fresh photo card');
  assert.equal(ctx.calls.sendPhoto[0].pic, 'tg-file-abc');
  assert.match(ctx.calls.sendPhoto[0].other.caption, /Started/);
  assert.equal(ctx.calls.sendMessage.length, 0);
});

test('with no tracker entry (fresh restart) a start tap falls back to edit-in-place', async () => {
  const userId = getOrCreateTelegramUser(12345, 'alice');
  const t = insertTask({ userId, summary: 'post-restart card', category: 'other' });
  const ctx = fakeCtx({ data: `a:start:${t.id}`, chatId: 999_777, messageId: 99 }); // chat never noted
  await handleMenuTap(ctx, ctx.callbackQuery.data);
  assert.equal(ctx.calls.editText.length, 1);
  assert.equal(ctx.calls.sendMessage.length, 0);
});

test('a NON-start mutating tap on an older message still edits in place (scope is start only)', async () => {
  const userId = getOrCreateTelegramUser(12345, 'alice');
  const t = insertTask({ userId, summary: 'older prio card', category: 'other' });
  noteChatMessage(504, 300);
  const ctx = fakeCtx({ data: `a:prio:${t.id}:3`, chatId: 504, messageId: 42 });
  await handleMenuTap(ctx, ctx.callbackQuery.data);
  assert.equal(ctx.calls.editText.length, 1);
  assert.equal(ctx.calls.sendMessage.length, 0);
});

test('tapping a step toggle edits the card in place with a toast and a refreshed keyboard', async () => {
  const { addTaskStep, parseSteps } = await import('../server/repo.js');
  const userId = getOrCreateTelegramUser(12345, 'alice');
  const t = insertTask({ userId, summary: 'pack for the trip', category: 'errand' });
  addTaskStep(userId, t.id, 'passport');
  addTaskStep(userId, t.id, 'charger');
  const ctx = fakeCtx({ data: `a:step:${t.id}:1` });
  await handleMenuTap(ctx, ctx.callbackQuery.data);
  assert.equal(ctx.calls.answer.length, 1);
  assert.match(ctx.calls.answer[0].text, /Step 1/);                      // toast
  assert.equal(ctx.calls.editText.length, 1);                            // edited in place
  assert.ok(ctx.calls.editText[0].other.reply_markup.inline_keyboard);   // refreshed step keyboard
  assert.equal(parseSteps(getTask(userId, t.id))[0].done, true);
});
