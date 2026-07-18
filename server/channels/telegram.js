// Telegram channel adapter (grammY long-polling — no public URL/webhook). Token from DB settings
// (set in the UI; created via @BotFather). Start/stop are serialized to avoid orphan pollers.
import { Bot, InputFile } from 'grammy';
import { getTelegramConfig } from '../settings.js';
import { handleIncoming, handleReaction, isAuthorized } from './telegram-handler.js';
import { handleAction, refreshedTaskList } from '../chat.js';
import { isStructured, decodeToken, CLOSE_BTN } from '../menu.js';
import { decideReaction, REACT_DONE, REACT_NOTE, REACT_THINK, REACT_ERROR } from '../../shared/reaction.js';
import { getOrCreateTelegramUser, defaultUserId, insertImage } from '../repo.js';
import { setBotIdentity } from '../botStatus.js';

const PRIVATE_TOAST = 'Private bot 🔒';
const TG_MAX = 4000;    // Telegram's hard limit is 4096; stay under it.
const TG_CAPTION = 1024; // a photo caption is capped far lower than a message body.

// Two-step REACTION ack on the user's own message, in place of a "📝 Noted." text round-trip: 👀 "thinking"
// the instant the message lands, then a swap to the decision reaction once the reply is ready — 🫡 for a
// normal answer, ✍ for a filed note, the mood emoji for a mood set (the reaction is then the whole ack, no
// text). The REACT_* constants and the kind→emoji decision live in shared/reaction.js (the web reuses them).
// The swap is the delicate part: two setMessageReaction calls racing on the same message can arrive out of
// order and leave 👀 stuck, which is what broke this before. So the swap AWAITS the 👀 set (ordering is then
// guaranteed) and holds the eyes for at least REACT_MIN_MS — both so the followup lands cleanly and so the
// two-step is actually visible on a fast reply. Telegram only accepts its fixed reaction set, so
// ⏳ / ✅ / 📝 / ✨ are NOT valid reactions; ✍ is the bare U+270D (no VS16) the API expects.
const REACT_MIN_MS = 600;            // keep 👀 up at least this long before swapping (visible + race-proof)

// Resolve after `ms` without keeping the process alive on its own (matches the LLM-timeout timers).
const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

// The fixed set of emoji Telegram accepts as message reactions (Bot API ReactionTypeEmoji). A mood ack reacts
// with the user's own mood emoji when it's one of these, so the reaction reflects the mood — otherwise it falls
// back to the generic 🫡. extractEmojis already strips variation selectors, so these bare forms match.
const ALLOWED_REACTIONS = new Set([
  '❤', '👍', '👎', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊',
  '🤡', '🥱', '🥴', '😍', '🐳', '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕',
  '😈', '😴', '😭', '🤓', '👻', '👀', '🎃', '🙈', '😇', '😨', '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪',
  '🗿', '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷', '😡',
]);
// Pick a reaction for a mood: the first of the user's mood emoji that Telegram allows, else the generic ack.
// Delegates to the shared decision, constrained to Telegram's allowed set (the web passes no `pick`, so it
// surfaces the literal mood emoji instead).
const moodReaction = (moodEmoji) => decideReaction({ kind: 'mood', moodEmoji }, (c) => ALLOWED_REACTIONS.has(c));
// Same allowed-set constraint for a kind:'ack' (a contentless 🌱/👍 reply that becomes a reaction): 👍 is a
// native Telegram reaction, 🌱 isn't → it falls back to the generic 🫡.
const ackReaction = (ackEmoji) => decideReaction({ kind: 'ack', ackEmoji }, (c) => ALLOWED_REACTIONS.has(c));

// One turn's reaction primitives. Fires 👀 "thinking" the instant the message lands, and exposes the SAFE
// 👀→decision swap: it awaits the 👀 SET first (two setMessageReaction calls racing on one message can arrive
// out of order and re-stick 👀 — the bug this guards) and holds REACT_MIN_MS so the two-step reads as two
// steps even on an instant reply. `react`/`swap` resolve true/false (never reject) so a caller can branch on
// whether the reaction actually landed. `canReact` is false for tapped bubbles/groups (no message to react
// to) → both are inert. Exported for tests.
export function createReactor(ctx, { chatId, userMsgId, canReact }) {
  const react = (emoji) => (canReact
    ? ctx.api.setMessageReaction(chatId, userMsgId, emoji ? [{ type: 'emoji', emoji }] : [])
      .then(() => true, (err) => { console.error('Telegram reaction failed:', err.message); return false; })
    : Promise.resolve(false));
  const thinkingAt = canReact ? Date.now() : 0;
  const thinking = react(REACT_THINK); // 👀 fired immediately, before the brain runs
  const swap = (emoji) => {
    if (!canReact) return Promise.resolve(false);
    return thinking.then(async () => {
      const held = Date.now() - thinkingAt;
      if (held < REACT_MIN_MS) await sleep(REACT_MIN_MS - held);
      return react(emoji);
    });
  };
  return { react, swap };
}

// Run the decision reaction OFF the reply's critical path. grammY handles updates strictly one at a time
// (bot.js handleUpdates awaits each in turn), so awaiting a reaction — which can stall up to the client
// timeout — would freeze the whole bot for every user; the reply is the product, the reaction a grace note.
// So the swap runs in the BACKGROUND. When the reaction IS the whole reply (`isReply`: a mood/ack/bare-note
// turn), a text `fallback` is sent — also in the background — only if the swap never lands, so a saved
// mood/note is never acked by silence. Returns the background promise so tests can await settlement;
// respond() deliberately ignores it. Exported for tests.
export function ackInBackground(swap, decision, { isReply = false, fallback = null } = {}) {
  return Promise.resolve(swap(decision))
    .then((acked) => { if (isReply && !acked && fallback) return fallback(); })
    .catch((err) => console.error('Telegram ack fallback failed:', err.message));
}

// Decode a `data:<mime>;base64,…` URI (what the brain returns in `image` for charts) into a grammY InputFile
// of bytes. Captured photos are NOT data URIs — they ride as a Telegram file_id (sent directly, see below).
function dataUriToInputFile(uri) {
  const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(uri);
  const b64 = m ? m[2] : uri;
  const ext = m && /png/.test(m[1]) ? 'png' : m && /webp/.test(m[1]) ? 'webp' : m && /gif/.test(m[1]) ? 'gif' : 'jpg';
  return new InputFile(Buffer.from(b64, 'base64'), `photo.${ext}`);
}

// Quick-reply options → an INLINE keyboard: tappable "bubbles" attached under the message (a reply
// keyboard, by contrast, sits down by the input and is easy to miss — esp. on Desktop). Tapping fires a
// callback_query carrying `callback_data`, which we route exactly like a typed message. callback_data is
// capped at 64 bytes by Telegram; our labels are short commands/answers, well under it. A short prompt
// (yes/no/smaller) stays one-per-row — the established look; a longer set (the "c" menu) packs 3-per-row.
export function inlineKeyboard(options) {
  if (!options || !options.length) return null;
  const perRow = options.length > 4 ? 3 : 1;
  const rows = [];
  for (let i = 0; i < options.length; i += perRow) {
    rows.push(options.slice(i, i + perRow).map((o) => ({ text: o, callback_data: o })));
  }
  return { inline_keyboard: rows };
}

// A structured button tree (rows of { text, data } from server/menu.js) → Telegram inline keyboard. Unlike
// inlineKeyboard(), the layout is already decided by the builder, so we keep the rows as-is and only map
// `data` → `callback_data`. Kept separate so inlineKeyboard()'s test-frozen output never changes.
export function inlineButtons(buttons) {
  if (!buttons || !buttons.length) return null;
  return { inline_keyboard: buttons.map((row) => row.map((btn) => ({ text: btn.text, callback_data: btn.data }))) };
}

let bot = null;
let chain = Promise.resolve();

// Recent bot message_id → the task ref it was about, so a reaction can be attributed to that task.
const botMsgRefs = new Map();
function rememberBotMessage(messageId, ref) {
  botMsgRefs.set(messageId, ref);
  if (botMsgRefs.size > 500) botMsgRefs.delete(botMsgRefs.keys().next().value);
}

// At most one live task/notes/sleeping list per chat: when a new list is sent, delete the previous one so
// stacked, stale lists don't clutter the thread. Best-effort — a bot can only delete its own messages, and
// only for ~48h, so failures are swallowed (same as the placeholder deletes). In-memory, like botMsgRefs:
// on restart the tracker is empty (a pre-restart list just won't be auto-removed).
const lastListByChat = new Map();
export function supersedeList(ctx, chatId, messageId) {
  if (chatId == null || messageId == null) return;
  const prev = lastListByChat.get(chatId);
  if (prev != null && prev !== messageId) ctx.api.deleteMessage(chatId, prev).catch(() => {});
  lastListByChat.set(chatId, messageId);
  if (lastListByChat.size > 500) lastListByChat.delete(lastListByChat.keys().next().value);
}

// Highest message_id seen per chat (user messages + our own sends). Telegram ids are monotonic within a
// private chat, so "tapped id < max seen" ⇔ the tapped card is NOT the latest message — used to send a
// fresh ▶ Started card instead of editing one buried up in history. In-memory like botMsgRefs: empty on
// restart, which just falls back to today's edit-in-place. Exported for tests.
const latestMsgByChat = new Map();
export function noteChatMessage(chatId, messageId) {
  if (chatId == null || messageId == null) return;
  if (messageId > (latestMsgByChat.get(chatId) ?? 0)) latestMsgByChat.set(chatId, messageId);
  if (latestMsgByChat.size > 500) latestMsgByChat.delete(latestMsgByChat.keys().next().value);
}

// Tapped actions that change a task's place in the open list, so the hanging list needs a quiet refresh.
const MUTATING_VERBS = new Set(['done', 'start', 'unstart', 'drop', 'snz', 'prio', 'cat', 'sch', 'rem', 'step']);

// Quietly re-render the list this chat is already showing, in place, after a task changed — so it never goes
// stale behind a "▶ Started"/"✓ Done" card. Best-effort: edits the tracked list message (a bot can only edit
// its own, ~48h), swallows "message not modified" and gone-message errors. The refreshed view also re-syncs
// the stored numbering, so /done_N keeps pointing at the right row. No tracked list (or nothing safe to
// render — e.g. the counts-overview) → no-op.
export async function refreshHangingList(ctx, chatId, userId) {
  const id = chatId != null ? lastListByChat.get(chatId) : null;
  if (id == null || userId == null) return;
  let view;
  try { view = refreshedTaskList(userId); } catch (err) { console.error('Telegram list refresh render failed:', err.message); return; }
  if (!view) return;
  const text = (typeof view === 'string' ? view : view.text) || '';
  const buttons = typeof view === 'string' ? null : (view.buttons || null);
  const sendOpts = (typeof view === 'object' && view.html)
    ? { parse_mode: 'HTML', link_preview_options: { is_disabled: true } } // an HTML task list; no preview card (see sendOpts below)
    : {};
  const reply_markup = buttons ? inlineButtons(buttons) : { inline_keyboard: [] }; // clear stale page buttons
  await ctx.api.editMessageText(chatId, id, String(text).slice(0, TG_MAX), { reply_markup, ...sendOpts }).catch((err) => {
    const msg = err?.description || err?.message || '';
    // "not modified" (same content) and gone-message (>48h / user-deleted) are the expected, documented
    // swallows here — anything else (e.g. an HTML parse 400) is a real bug and must be visible.
    if (!/message is not modified|message to edit not found|MESSAGE_ID_INVALID/i.test(msg)) console.error('Telegram list refresh failed:', msg);
  });
}

// Best-effort in-place edit: swallow Telegram's "message is not modified" 400 (fires when the user taps the
// already-set value or re-opens an open submenu — same idiom as syncBotProfile's "is the same"); log any
// other failure. Returns the API result or null.
async function safeEdit(fn) {
  try { return await fn(); }
  catch (err) {
    const msg = err?.description || err?.message || '';
    if (!/message is not modified/i.test(msg)) console.error('Telegram menu edit failed:', msg);
    return null;
  }
}

// A tapped STRUCTURED button (a:* / m:*): run the menu dispatcher and edit the card IN PLACE (toast +
// refreshed keyboard — no "thinking…" placeholder, no new message). Bypasses handleIncoming, so it re-adds
// that path's gates: private-chat only + the same fail-closed authorization. A caption is used instead of
// text when the card is MEDIA — a photo (/whatdo, start-with-photo) OR a document (a dated task's .ics
// "add to calendar" card); editMessageText can't touch either, it would 400 and the tap would do nothing.
export async function handleMenuTap(ctx, data) {
  const fromId = ctx.callbackQuery?.from?.id;
  const username = ctx.callbackQuery?.from?.username;
  if ((ctx.chat?.type ?? 'private') !== 'private') { await ctx.answerCallbackQuery().catch(() => {}); return; }
  if (!isAuthorized({ fromId, username })) { await ctx.answerCallbackQuery({ text: PRIVATE_TOAST }).catch(() => {}); return; }
  const userId = fromId != null ? getOrCreateTelegramUser(fromId, username || null) : defaultUserId();

  let out;
  try { out = await handleAction(userId, data, { channel: 'telegram' }); }
  // Answer with an error toast, not silently — a bare answerCallbackQuery() just stops the spinner, leaving
  // a failed tap indistinguishable from success (the task was NOT changed).
  catch (err) { console.error('Telegram menu action error:', err.message); await ctx.answerCallbackQuery({ text: '☠️ Something went wrong — try again?' }).catch(() => {}); return; }

  // "✕ Hide" on a list → delete the message so the list is dismissed (not just stripped of buttons), and drop
  // it from the supersede tracker so we don't try to delete it again on the next list.
  if (out.hide) {
    await ctx.answerCallbackQuery({ text: 'Hidden' }).catch(() => {});
    const cid = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;
    const mid = ctx.callbackQuery?.message?.message_id;
    await ctx.deleteMessage().catch(() => {});
    if (cid != null && mid != null && lastListByChat.get(cid) === mid) lastListByChat.delete(cid);
    return;
  }

  await ctx.answerCallbackQuery(out.toast ? { text: out.toast } : undefined).catch(() => {});
  const reply_markup = out.buttons ? inlineButtons(out.buttons) : undefined;
  const text = out.text != null ? String(out.text).slice(0, TG_MAX) : '';
  const sendOpts = out.html // an HTML card/list (task rows, command sections); a LIST also mutes the URL preview card
    ? { parse_mode: 'HTML', ...(out.listing ? { link_preview_options: { is_disabled: true } } : {}) }
    : {};
  const msg = ctx.callbackQuery.message;
  if (!text && !reply_markup) { await safeEdit(() => ctx.editMessageReplyMarkup()); return; } // x / dismiss → drop the bubbles

  // ▶ Start tapped on a card that ISN'T the latest message in the chat: editing it in place would bury the
  // Started card (and its stepping workflow) up in history. Send it FRESH at the bottom instead, and only
  // strip the old card's buttons (its text stays — it's history now). This path also carries out.photo (the
  // start-with-photo card), which the edit path can't. Best-effort: an empty tracker (restart) or a failed
  // send falls through to the edit-in-place below, so the tap is never answered-but-invisible.
  const chatId = ctx.chat?.id ?? msg?.chat?.id;
  const stale = text && decodeToken(data)?.verb === 'start'
    && chatId != null && msg?.message_id != null
    && (latestMsgByChat.get(chatId) ?? 0) > msg.message_id;
  if (stale) {
    const markup = reply_markup ? { reply_markup } : {};
    const sent = out.photo
      ? await ctx.api.sendPhoto(chatId, out.photo, { caption: text.slice(0, TG_CAPTION), ...markup, ...sendOpts })
        .catch((err) => { console.error('Telegram fresh-start send failed:', err.message); return null; })
      : await ctx.api.sendMessage(chatId, text, { ...sendOpts, ...markup })
        .catch((err) => { console.error('Telegram fresh-start send failed:', err.message); return null; });
    if (sent) {
      noteChatMessage(chatId, sent.message_id);
      if (out.ref) rememberBotMessage(sent.message_id, out.ref);
      await safeEdit(() => ctx.editMessageReplyMarkup());   // the old card keeps its text, loses its stale buttons
      await refreshHangingList(ctx, chatId, userId);        // 'start' mutates → keep the hanging list current
      return;
    }
  }
  // A media message (photo or .ics document) carries a caption, never text — edit the caption so the card
  // swaps in place and keeps its attachment; only a true text message can take editMessageText.
  const isMedia = !!(msg?.photo || msg?.document || msg?.video || msg?.animation || msg?.audio || msg?.voice);
  if (isMedia) await safeEdit(() => ctx.editMessageCaption({ caption: text.slice(0, TG_CAPTION), reply_markup, ...sendOpts }));
  else await safeEdit(() => ctx.editMessageText(text, { ...sendOpts, ...(reply_markup ? { reply_markup } : {}) }));
  // Keep reaction attribution pointing at the task this card is now about (the message_id is unchanged).
  if (out.ref && msg?.message_id != null) rememberBotMessage(msg.message_id, out.ref);
  // A tapped action that changed a task (done/start/drop/snooze/priority/…) → quietly refresh the list the
  // chat is already showing (a separate message), so it doesn't go stale behind this edited card.
  if (MUTATING_VERBS.has(decodeToken(data)?.verb)) await refreshHangingList(ctx, ctx.chat?.id ?? msg?.chat?.id, userId);
}

// Turn the "💭 thinking…" placeholder into the final message. Edits it in place for a plain answer;
// when the answer carries a keyboard (inline bubbles) — or if the edit fails — it REMOVES the placeholder
// and sends a fresh message, so the placeholder and the answer never both show, and the bubbles attach
// cleanly to the new message.
// Returns the message id the final answer ended up on (for reaction attribution). Exported for tests.
export async function finalizePlaceholder(ctx, chatId, placeholderId, text, reply_markup = null, sendOpts = {}) {
  if (placeholderId != null && !reply_markup) {
    try {
      await ctx.api.editMessageText(chatId, placeholderId, text, sendOpts);
      return placeholderId; // morphed in place
    } catch (err) {
      console.error('Telegram edit failed (deleting placeholder, sending fresh):', err.message);
    }
  }
  if (placeholderId != null) await ctx.api.deleteMessage(chatId, placeholderId).catch(() => {});
  // This send IS the answer — a swallowed failure here means the user got a success reaction and no reply,
  // with nothing logged (the sibling photo/document sends all console.error). Log it, and for the one
  // deterministic case — an HTML entity-parse 400 — resend once as plain text: unformatted beats absent.
  const send = (opts) => ctx.reply(text, { ...opts, ...(reply_markup ? { reply_markup } : {}) });
  let sent = null;
  try { sent = await send(sendOpts); }
  catch (err) {
    const msg = err?.description || err?.message || '';
    console.error('Telegram reply failed:', msg);
    if (sendOpts.parse_mode && /can't parse entities/i.test(msg)) {
      sent = await send({}).catch((err2) => { console.error('Telegram plain-text retry failed:', err2.message); return null; });
    }
  }
  return sent?.message_id ?? null;
}

// Serialize start/stop so two rapid calls can't leave two polling loops running (409 Conflict).
function enqueue(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {}); // keep the chain alive; swallow so one failure doesn't poison it
  return run;
}

async function rawStop() {
  if (!bot) return;
  const b = bot;
  bot = null;
  setBotIdentity(null); // the header pill must not keep advertising a bot that's gone
  try { await b.stop(); } catch { /* ignore */ }
}

// Bot profile copy (about / description) pushed to Telegram on startup so the @BotFather profile
// matches the app's branding. The bot's NAME is deliberately not synced: it stays whatever was assigned
// in @BotFather, so parallel deployments (e.g. the public demo) can be told apart. NOTE: the avatar
// (profile photo) can't be set via the Bot API either — set it once by hand in @BotFather
// (Edit Bot → Edit Botpic) using assets/fanad-logo-512.png (or fanad-logo-maroon-512.png for the demo).
const PROFILE = {
  // ≤120 chars — shown on the bot's profile page and in search/share cards.
  shortDescription:
    "A lighthouse keeper for tasks. Tell me anything you want to do — I'll sort it and hand it back the right size.",
  // ≤512 chars — shown in an empty chat, above the Start button.
  description: [
    'Fanad — a lighthouse keeper for tasks, a to-do tracker for scattered brains.',
    '',
    '① Make a statement, and I’ll add it to my list.',
    '② Ask a question, and I’ll see what I can do.',
    '③ Answer my question, and so shall it be.',
    '',
    'A “no” is never the end — I’ll find you something the right size, or nothing at all. Show me how you feel anytime with an emoji. ✨',
  ].join('\n'),
};

// Push about/description to Telegram. Idempotent: Telegram rejects an unchanged value with an
// "is the same" 400, which we swallow — so this is safe to run on every startup. Best-effort: a failure
// here never blocks polling. (The name and avatar are BotFather-managed; see the PROFILE note above.)
async function syncBotProfile(api) {
  const steps = [
    ['ShortDescription', () => api.setMyShortDescription(PROFILE.shortDescription)],
    ['Description', () => api.setMyDescription(PROFILE.description)],
  ];
  for (const [label, run] of steps) {
    try { await run(); }
    catch (err) {
      const msg = err?.description || err?.message || '';
      if (/is the same/i.test(msg)) continue; // unchanged — nothing to do
      console.error(`Telegram setMy${label} failed:`, msg);
    }
  }
}

async function doStart() {
  await rawStop();
  const cfg = getTelegramConfig();
  if (!cfg.enabled || !cfg.botToken) return null;

  // Bound EVERY Telegram API call. grammY's default is timeoutSeconds:500 (~8 min) — combined with the
  // strictly-sequential update loop (bot.js handleUpdates awaits each update in turn), a single stalled call
  // (a lost reaction/send response) would silently freeze the whole bot for every user, with nothing logged
  // (a hung promise never throws). 15s turns that into a bounded, logged failure. (Reactions are also taken
  // off the reply's critical path below — see createReactor/ackInBackground — so a slow one can't block at all.)
  const b = new Bot(cfg.botToken, { client: { timeoutSeconds: 15 } });

  // The one path both a typed message AND a tapped bubble go through: a typing indicator + a 👀 reaction on
  // the user's own message, run the shared brain on `text`, then swap the reaction to the decision emoji
  // (mood / ✍ / 🫡) and send the answer (with its own inline bubbles, if any). A tap routes its callback_data
  // here verbatim — identical to typing it (no message to react to, so it skips the reaction entirely).
  async function respond(ctx, text, { imageId = null, userMsgId = null } = {}) {
    const chatId = ctx.chat?.id;
    const isPrivate = (ctx.chat?.type ?? 'private') === 'private';
    noteChatMessage(chatId, userMsgId); // the user's message advances the chat's high-water mark
    const remember = (id, ref) => {
      noteChatMessage(chatId, id);      // every send advances it too (feeds the stale-start check)
      if (ref && id != null) rememberBotMessage(id, ref);
    };

    // Reactions only in 1:1 chats, and only when we know which message to react to (a typed line / sent photo,
    // not a tapped bubble) — canReact gates that. swapReaction() (from createReactor) does the safe 👀→decision
    // hand-off — see the REACT_* note above for why it waits on the 👀 SET first.
    const canReact = isPrivate && userMsgId != null;
    // Fire 👀 now and get back the SAFE 👀→decision swap (see createReactor). The swap is dispatched in the
    // background via ackInBackground below — never awaited on the reply path — so a slow/stalled reaction can
    // never freeze grammY's strictly-sequential update loop (which is what left 👀 stuck + everything hung).
    const { swap: swapReaction } = createReactor(ctx, { chatId, userMsgId, canReact });

    // The header "typing…" indicator (auto-expires after ~5s, so refresh it) is the in-thread working signal;
    // the answer arrives as a fresh message. Groups are ignored downstream, so don't post anything there.
    const showTyping = () => ctx.replyWithChatAction('typing').catch(() => {});
    let typing = null;
    const placeholderId = null; // no "💭 thinking…" bubble
    if (isPrivate) {
      showTyping();
      typing = setInterval(showTyping, 4000);
    }

    try {
      const { reply, image, photo, options, buttons, ref, document, listing, userId, refreshList, html, kind, moodEmoji, ackEmoji } = await handleIncoming({
        text,
        chatId,
        fromId: ctx.from?.id,
        username: ctx.from?.username,
        chatType: ctx.chat?.type,
        imageId,
      });
      // Swap 👀 to the result reaction: the mood emoji for a 'mood' set, the ack emoji for a contentless
      // 'ack' (🌱/👍 — sent as text it would render as a huge emoji), ✍ for a filed note, else 🫡. A 'mood',
      // an 'ack', and a BARE note carry nothing else worth showing — the reaction IS the whole reply, so the
      // "Mood set:" / "📝 Noted." / emoji text is dropped and we return. (An inferred-from-words mood has no
      // kind:'mood', so it still sends its text — that's how the user sees which emoji we picked.)
      const moodAck = kind === 'mood';
      const emojiAck = kind === 'ack';
      const bareNote = kind === 'note' && !buttons && !photo && !image && !document;
      const isReply = moodAck || emojiAck || bareNote;
      // Dispatch the 👀→decision swap in the BACKGROUND (never awaited) so a stalled reaction can't hold up
      // the reply or freeze the sequential loop. On the mood/ack/bare-note paths the reaction IS the whole
      // reply, so its text fallback (only if the reaction never lands — transient failure, or a tapped bubble
      // with no message to react to) rides on the same background promise, never blocking silence over a saved
      // mood/note. (An inferred-from-words mood has no kind:'mood', so it still sends its text normally below.)
      const decision = moodAck ? moodReaction(moodEmoji) : emojiAck ? ackReaction(ackEmoji) : kind === 'note' ? REACT_NOTE : REACT_DONE;
      ackInBackground(swapReaction, decision, { isReply, fallback: (isReply && reply) ? () => ctx.reply(String(reply).slice(0, TG_MAX)) : null });
      if (isReply) return;
      const out = reply ? String(reply).slice(0, TG_MAX) : null;
      // An HTML reply (already-escaped, built via shared/richtext.js) is sent with parse_mode:HTML; everything
      // else stays plain. Applied to every send/edit path below — the text is never re-escaped here.
      // A LISTING's rows may carry <a> titles (link-preview tasks); without this Telegram would grow a big
      // preview card for the first URL it sees, dwarfing the list. Single-task replies (the Started card)
      // keep the default — one preview there is informative, not noise.
      const sendOpts = html ? { parse_mode: 'HTML', ...(listing ? { link_preview_options: { is_disabled: true } } : {}) } : {};
      // A structured button tree (per-task menus, the hub) takes precedence over plain quick-reply options.
      const reply_markup = buttons ? inlineButtons(buttons) : inlineKeyboard(options);
      // The reply may carry a picture two ways: a captured photo by Telegram `file_id` (re-sent by reference,
      // no upload), or a generated chart as a `data:` URI (decoded to bytes). sendPhoto accepts either form.
      const pic = photo || (image ? dataUriToInputFile(image) : null);

      if (document) {
        // A .ics "add to calendar" file (from /cal_N or a dated capture): the placeholder can't morph into
        // a file, so drop it and send the document with the text as its caption. Tapping it opens the
        // user's native calendar (Apple/Google/Outlook), where they can make it recur if they want.
        if (placeholderId != null) await ctx.api.deleteMessage(chatId, placeholderId).catch(() => {});
        const sent = await ctx.replyWithDocument(new InputFile(Buffer.from(document.content), document.filename), { caption: out ? out.slice(0, TG_CAPTION) : undefined, reply_markup, ...sendOpts })
          .catch((err) => { console.error('Telegram sendDocument failed:', err.message); return null; });
        remember(sent?.message_id ?? null, ref);
      } else if (pic) {
        // A text "💭 thinking…" placeholder can't morph into a photo — drop it and send the photo fresh,
        // with the answer as its caption (caption cap is 1024, well below TG_MAX; any overflow is rare here).
        if (placeholderId != null) await ctx.api.deleteMessage(chatId, placeholderId).catch(() => {});
        const caption = out ? out.slice(0, TG_CAPTION) : undefined;
        const sent = await ctx.replyWithPhoto(pic, { caption, reply_markup, ...sendOpts })
          .catch((err) => { console.error('Telegram sendPhoto failed:', err.message); return null; });
        // If the answer was longer than a caption allows, send the remainder as a follow-up message.
        if (out && out.length > TG_CAPTION) await ctx.reply(out.slice(TG_CAPTION, TG_CAPTION + TG_MAX), sendOpts).catch(() => {});
        remember(sent?.message_id ?? null, ref);
      } else if (!out) {
        // Nothing to say (e.g. a blank message): drop the placeholder so it doesn't dangle.
        if (placeholderId != null) await ctx.api.deleteMessage(chatId, placeholderId).catch(() => {});
      } else {
        // Morph the "thinking…" bubble into the answer (or cleanly replace it) — never leave both.
        const finalId = await finalizePlaceholder(ctx, chatId, placeholderId, out, reply_markup, sendOpts);
        remember(finalId, ref);
        // A fresh task/notes/sleeping list supersedes the previous one — delete it so stale, stacked lists
        // don't clutter the thread. Paging edits in place (no new message), so it doesn't churn this.
        if (listing) supersedeList(ctx, chatId, finalId);
      }
      // This turn changed a task (e.g. a tapped /done_N link) but the reply itself isn't a new list — quietly
      // bring the list the chat is already showing up to date. (A new-list reply is handled by supersede above.)
      if (refreshList && !listing) await refreshHangingList(ctx, chatId, userId);
    } catch (err) {
      console.error('Telegram handler error:', err.message);
      // Swap 👀 → 🤬 to mark the failure on the user's own message. The skull ☠️ isn't in Telegram's reaction
      // set, so it can't be the reaction (that would fail and re-stick the 👀) — it leads the error text below.
      // Fire-and-forget like the success path: the error TEXT below is the real signal and must not wait on a
      // (possibly stalling) reaction call.
      ackInBackground(swapReaction, REACT_ERROR);
      await finalizePlaceholder(ctx, chatId, placeholderId, '☠️ Something went wrong filing that — try again in a moment?')
        .catch(() => {});
    } finally {
      if (typing) clearInterval(typing);
    }
  }

  b.on('message:text', (ctx) => respond(ctx, ctx.message.text, { userMsgId: ctx.message?.message_id ?? null }));

  // A sent photo → its caption becomes the task text, and we keep the photo's `file_id` (Telegram already
  // hosts the bytes; that handle is reusable to re-send it later — no download, no disk). Authorize BEFORE
  // recording so a stranger can't seed rows. Best-effort: if it fails, we still file the caption.
  b.on('message:photo', async (ctx) => {
    let imageId = null;
    if (isAuthorized({ fromId: ctx.from?.id, username: ctx.from?.username })
        && (ctx.chat?.type ?? 'private') === 'private') {
      try {
        const photos = ctx.message.photo || [];
        const largest = photos[photos.length - 1]; // sizes ascend → last is highest-resolution
        if (largest?.file_id) {
          const userId = ctx.from?.id != null
            ? getOrCreateTelegramUser(ctx.from.id, ctx.from.username || null)
            : defaultUserId();
          imageId = insertImage({ userId, fileId: largest.file_id }).id;
        }
      } catch (err) {
        console.error('Telegram photo intake failed:', err.message);
      }
    }
    await respond(ctx, ctx.message.caption || '', { imageId, userMsgId: ctx.message?.message_id ?? null });
  });

  // A tapped inline bubble. A STRUCTURED token (a:* / m:* — a per-task menu or the hub) is handled IN
  // PLACE by handleMenuTap (edit the card, toast, keep the keyboard live). A legacy plain answer
  // (yes/no/smaller, a command, a feedback chip) keeps the original behavior: stop the spinner, strip the
  // single-use bubbles, then route the callback_data through the brain exactly like a typed line.
  b.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (isStructured(data)) { await handleMenuTap(ctx, data); return; }
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.editMessageReplyMarkup().catch(() => {}); // remove the tapped bubbles (best-effort)
    await respond(ctx, data);
  });
  // Emoji reactions on the bot's own messages → mood/learning signal (best-effort; needs the update type).
  b.on('message_reaction', (ctx) => {
    try {
      const mr = ctx.messageReaction;
      const emoji = mr?.new_reaction?.find((x) => x.type === 'emoji')?.emoji;
      const ref = mr?.message_id != null ? botMsgRefs.get(mr.message_id) : null;
      handleReaction({ emoji, fromId: mr?.user?.id ?? ctx.from?.id, username: ctx.from?.username, ref });
    } catch (err) { console.error('Telegram reaction error:', err.message); }
  });
  b.catch((err) => console.error('Telegram bot error:', err?.error?.message || err.message));

  await b.init(); // validates the token (throws on a bad one — surfaced to the UI)
  if (b.botInfo?.username) setBotIdentity({ platform: 'telegram', username: b.botInfo.username }); // → web header via /api/heartbeat
  syncBotProfile(b.api); // best-effort, non-blocking: keep the bot's name/about/description on-brand
  b.start({ allowed_updates: ['message', 'message_reaction', 'callback_query'], onStart: (info) => console.log(`Telegram bot @${info.username} is live.`) })
    .catch((err) => { console.error('Telegram polling stopped:', err.message); if (bot === b) { bot = null; setBotIdentity(null); } });

  bot = b;
  return b;
}

export function startTelegram() { return enqueue(doStart); }
export function stopTelegram() { return enqueue(rawStop); }

// Push a message to a specific chat (the schedule owner's 1:1 chat) or, when none is given, the claimed
// owner. No-op if the bot isn't running or there's no destination. Used by scheduled wake-ups. When a
// `photo` Telegram file_id is given, the nudge is sent as that photo with the text as its caption.
export async function sendTelegram(text, chatId = null, photo = null) {
  const cfg = getTelegramConfig();
  const target = chatId ?? cfg.ownerId;
  if (!bot || target == null) return false;
  // Pushed notifications (wake-up nudges, "on <when>" reminders) arrive unprompted, so each carries a one-tap
  // "✕" to clear it from the chat. The tap routes m:hide:x through handleMenuTap, which deletes the message —
  // the same generic-dismiss affordance the help/command panels use (anti-clutter, parity with the lists ✕).
  const reply_markup = inlineButtons([[CLOSE_BTN]]);
  try {
    const sent = photo
      ? await bot.api.sendPhoto(target, photo, { caption: String(text).slice(0, TG_CAPTION), reply_markup })
      : await bot.api.sendMessage(target, String(text).slice(0, TG_MAX), { reply_markup });
    noteChatMessage(target, sent?.message_id ?? null); // pushed nudges advance the high-water mark too
    return true;
  } catch (err) { console.error('Telegram send failed:', err.message); return false; }
}
