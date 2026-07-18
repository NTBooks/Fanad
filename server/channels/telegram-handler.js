// Telegram adapter logic — auth (fail-closed) then hand off to the shared chat brain. Unit-testable
// without a live bot.
import { handleMessage, formatStatusText, applyReaction } from '../chat.js';
import { defaultUserId, getOrCreateTelegramUser, isVouchedTelegram, pinVouchTelegramId } from '../repo.js';
import { getTelegramConfig, setTelegramConfig, getGuardConfig } from '../settings.js';

// Fail-closed access control. Three additive ways in: (1) the manual @username allowlist (cfg.allowedUsername,
// comma/space separated); (2) a VOUCH — a username an already-authorized user endorsed via "vouch @username"
// (isVouchedTelegram: pinned to the sender's numeric id on first contact, so a rename keeps them in and a
// handle squatter stays out — migrations v18/v31); (3) the owner, who CLAIMS the bot on first contact
// (trust-on-first-use) and is always allowed by numeric id so a vouch-grown allowlist can never lock them
// out. Anyone else is turned away.
function authorize({ cfg, fromId, username }) {
  const sender = (username || '').toLowerCase().replace(/^@/, '');
  const isOwner = cfg.ownerId != null && fromId != null && fromId === cfg.ownerId;
  // Demo kill switch: while paused, only the owner gets through — everyone else takes the same silent-drop
  // path as a stranger (an unclaimed box can't be paused, so trust-on-first-use is unaffected).
  if (!isOwner && getGuardConfig().demoPaused) return false;
  if (cfg.allowedUsername) {
    // One or more usernames (comma/space separated) — each allowed account is its own user. The owner and
    // vouched-in users get in too, so an allowlist box can still grow socially.
    const allowed = cfg.allowedUsername.toLowerCase().split(/[,\s]+/).map((u) => u.replace(/^@/, '')).filter(Boolean);
    if (sender && allowed.includes(sender)) return true;
    return isOwner || isVouchedTelegram({ username: sender, telegramId: fromId });
  }
  if (cfg.ownerId == null) {
    if (fromId != null) setTelegramConfig({ ownerId: fromId }); // claim
    return true;
  }
  // Single-owner box: the owner plus anyone they (or other authorized users) vouched in.
  return isOwner || isVouchedTelegram({ username: sender, telegramId: fromId });
}

// Authorization check exposed for the adapter's media handlers, so a stranger's photo is rejected BEFORE
// we ever download/store its bytes. Mirrors the gate handleIncoming applies. Triggers the same
// trust-on-first-use claim as a typed message would.
export function isAuthorized({ fromId = null, username = null } = {}) {
  return authorize({ cfg: getTelegramConfig(), fromId, username });
}

export async function handleIncoming({ text, chatId = null, fromId = null, username = null, chatType = 'private', imageId = null }) {
  const t = (text || '').trim();
  if (!t && imageId == null) return { reply: null }; // nothing to say AND nothing attached
  if (chatType && chatType !== 'private') return { reply: null }; // ignore groups/channels silently

  const cfg = getTelegramConfig();
  // Silent drop for unauthorized senders: reply with NOTHING. A bot can't stop Telegram from delivering
  // cold DMs (anyone can message it by @handle), and the phishing/sexbot spam this bot gets is exactly that.
  // Answering — even "this is a private bot" — confirms a live, responsive endpoint and invites MORE, plus
  // burns an API send per spammer. So strangers get pure silence (no task filed, no LLM, no reply). Do NOT
  // "helpfully" restore a rejection message here — that reintroduces the spam-confirmation loop. A legit
  // newcomer is meant to be vouched in FIRST (then their first message just works).
  if (!authorize({ cfg, fromId, username })) return { reply: null };
  // Remember who to push scheduled wake-up nudges to. The trust-on-first-use claim in authorize() only
  // runs when there's no @username allowlist; with an allowlist we'd otherwise never learn a chat id.
  if (cfg.ownerId == null && fromId != null) setTelegramConfig({ ownerId: fromId });
  // First authorized contact from a vouched-in handle: pin their immutable numeric id onto the vouch row,
  // so a later @username rename keeps them in and a squatter claiming the lapsed handle stays out. A no-op
  // for everyone else (only an active, still-unpinned row matching THEIR handle is stamped).
  if (fromId != null && username) pinVouchTelegramId(username, fromId);

  // Each Telegram account is its own user; a message with no id (tests) falls back to root.
  const userId = fromId != null ? getOrCreateTelegramUser(fromId, username || null) : defaultUserId();
  const { reply, status, image, photo, options, buttons, ref, document, listing, refreshList, logged, html, kind, moodEmoji, ackEmoji } = await handleMessage({ userId, text: t, channel: 'telegram', imageId });
  if (!reply) return { reply: null, image: image || null, photo: photo || null, document: document || null, userId, refreshList: refreshList || false, kind: kind || null, moodEmoji: moodEmoji || null, ackEmoji: ackEmoji || null };
  // The ambient status header rides only on a task-capture confirmation — the context the task was logged in.
  // Every other reply (lists, cards, guides, suggestions…) skips it so the thread isn't noisy. It's PLAIN
  // text ("[ mood · time ]") and is safe to prepend even before an HTML body — its chars aren't HTML-special.
  const head = logged ? formatStatusText(status) : '';
  // The adapter (telegram.js) turns `options`/`buttons` into an inline keyboard, so no text bracket here.
  // `listing` flags a task/notes/sleeping list so the adapter can drop the previous one (anti-clutter);
  // `refreshList`/`userId` let it quietly re-render a hanging list when this turn changed a task. `html` opts
  // this reply into Telegram parse_mode:HTML (the body is already escaped by the builders — never re-escape).
  return { reply: head ? `${head}\n${reply}` : reply, image, photo: photo || null, options, buttons: buttons || null, ref, document: document || null, listing: listing || false, userId, refreshList: refreshList || false, html: html || false, kind: kind || null, moodEmoji: moodEmoji || null, ackEmoji: ackEmoji || null };
}

// An emoji reaction on one of the bot's messages (authorized only). `ref` (when the adapter remembered
// which task that message was about) attributes it to that task; otherwise it's just a mood beat.
export function handleReaction({ emoji, fromId = null, username = null, ref = null }) {
  if (!emoji || fromId == null) return;
  if (!authorize({ cfg: getTelegramConfig(), fromId, username })) return;
  applyReaction(getOrCreateTelegramUser(fromId, username || null), emoji, ref);
}
