// Slack adapter logic — auth (fail-closed) then hand off to the shared chat brain. Unit-testable without a
// live Slack connection (mirrors telegram-handler.js). The transport (Bolt/Socket Mode) lives in slack.js.
import { handleMessage, formatStatusText, applyReaction, isFeatureOnFor } from '../chat.js';
import {
  defaultUserId, getOrCreateSlackUser, isVouchedSlack, addVouch, getActiveVouch, listVouchesBy, getUser,
  isOwner, vouchDepthOf, countActiveVouches,
} from '../repo.js';
import { getSlackConfig, setSlackConfig, getGuardConfig } from '../settings.js';
import { config } from '../config.js';
import { notifyOwner } from '../notifyOwner.js';
import { dollarToSlash } from '../../shared/slack-format.js';

// A Slack workspace user id is immutable and shaped like U01ABC23DE (W… on enterprise grid). We accept either
// the raw id or an @handle in the allowlist; vouches are always keyed on the id (handles are mutable).
const SLACK_ID_RE = /^[UW][A-Z0-9]{6,}$/i;
// Vouch is a per-user module (off by default, auto-on for the owner). A non-owner turns it on for themselves
// with "optin vouch" (routed through the brain like any other command), then can vouch others.
const VOUCH_OFF = 'Vouching is off for you — say “optin vouch” to turn it on, then you can add people.';

// Fail-closed access control, mirroring telegram-handler.authorize(). Three additive ways in: (1) the manual
// allowlist (cfg.allowedSlack — Slack ids and/or @handles, comma/space separated); (2) a VOUCH keyed on the
// immutable Slack id (isVouchedSlack); (3) the owner, who CLAIMS the bot on first DM (trust-on-first-use) and
// is always allowed by id so a vouch-grown list can never lock them out. Anyone else is turned away.
function authorize({ cfg, slackUserId, slackUsername }) {
  const id = String(slackUserId || '').trim();
  const handle = String(slackUsername || '').toLowerCase().replace(/^@/, '');
  const isOwner = cfg.ownerSlackId != null && id && id === cfg.ownerSlackId;
  // Demo kill switch (mirrors telegram-handler): while paused, only the owner gets through — silently.
  if (!isOwner && getGuardConfig().demoPaused) return false;
  if (cfg.allowedSlack) {
    const allowed = cfg.allowedSlack.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    for (const a of allowed) {
      if (SLACK_ID_RE.test(a)) { if (id && a === id) return true; }       // a Slack id entry
      else if (handle && a.toLowerCase().replace(/^@/, '') === handle) return true; // an @handle entry
    }
    return isOwner || isVouchedSlack(id);
  }
  if (cfg.ownerSlackId == null) {
    if (id) setSlackConfig({ ownerSlackId: id }); // claim
    return true;
  }
  // Single-owner box: the owner plus anyone they (or other authorized users) vouched in.
  return isOwner || isVouchedSlack(id);
}

// Authorization check exposed for the adapter's button-tap path, so a stranger's tap is rejected the same way
// a typed message is. Triggers the same trust-on-first-use claim as a typed message would.
export function isAuthorizedSlack({ slackUserId = null, slackUsername = null } = {}) {
  return authorize({ cfg: getSlackConfig(), slackUserId, slackUsername });
}

// Pull a Slack user id out of a "vouch …" argument: a real @mention arrives in message text as <@U01ABC23DE>
// (optionally <@U…|display>); we also accept a bare pasted id. Returns the uppercased id or null.
function parseVouchTarget(rest) {
  const m = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/i.exec(rest || '');
  if (m) return m[1].toUpperCase();
  const bare = String(rest || '').trim();
  return SLACK_ID_RE.test(bare) ? bare.toUpperCase() : null;
}

// "vouch @someone" on Slack. The brain's vouchCommand is Telegram-handle-shaped and would store the wrong
// platform/key, so the adapter handles vouch itself — it has the resolved ids (voucher + target) and keys the
// vouch on the immutable Slack id (platform 'slack'). The voucher snapshot is the voucher's OWN id, so the
// admin cascade-revoke walks the Slack subtree. Same Vouch feature gate the brain reads. Returns reply text.
function slackVouch({ userId, voucherSlackId, rest }) {
  if (!isFeatureOnFor(userId, 'vouch')) return VOUCH_OFF;
  if (!rest || !rest.trim()) {
    const mine = listVouchesBy(userId);
    const how = 'Add someone with “vouch @name” (pick them from Slack’s @ menu) — they’ll be able to message me, and you’ll be on record as who let them in.';
    return mine.length ? `🤝 You’ve vouched in ${mine.length} so far.\n${how}` : `You haven’t vouched anyone in yet.\n${how}`;
  }
  const target = parseVouchTarget(rest);
  if (!target) return 'That doesn’t look like a Slack mention. Try “vouch @name” and pick them from the @ menu.';
  if (voucherSlackId && target === String(voucherSlackId).toUpperCase()) return 'You’re already in — no need to vouch for yourself. 🙂';
  const cfg = getSlackConfig();
  const seeds = (cfg.allowedSlack || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  if (seeds.includes(target)) return `<@${target}> is already on the access list. 👍`;
  if (isVouchedSlack(target)) {
    const cur = getActiveVouch(target, 'slack');
    const by = cur?.voucher_username ? ` (vouched in by <@${cur.voucher_username}>)` : '';
    return `<@${target}> is already vouched in${by}. 👍`;
  }
  // ── Demo guardrails, mirroring chat.js vouchCommand (config.limits; the OWNER is exempt). Depth walks the
  // voucher's own Slack-id vouch chain — a seed/owner (no vouch row) is depth 0. ──
  const owner = isOwner(userId);
  const { vouchCapPerUser, vouchMaxDepth, maxVouchedUsers } = config.limits;
  if (!owner) {
    if (getGuardConfig().vouchFrozen) return '🧊 Vouching is paused right now — the host has frozen new invites.';
    if (vouchCapPerUser && listVouchesBy(userId).length >= vouchCapPerUser) {
      return `You’ve used all ${vouchCapPerUser} of your invites — ask the host if you need another.`;
    }
    if (vouchMaxDepth && voucherSlackId && vouchDepthOf(voucherSlackId, 'slack') >= vouchMaxDepth) {
      return 'Invites from invited guests are off right now — ask the host to vouch them in directly.';
    }
    if (maxVouchedUsers && countActiveVouches('slack') >= maxVouchedUsers) {
      return 'The guest list is full — ask the host to free up a seat.';
    }
  }
  const me = getUser(userId);
  addVouch({ platform: 'slack', username: target, voucherUserId: userId, voucherUsername: voucherSlackId || null, voucherTelegramId: me?.telegram_id ?? null });
  if (!owner) {
    const seatsUsed = countActiveVouches('slack');
    notifyOwner(`🤝 ${voucherSlackId ? `<@${voucherSlackId}>` : `user ${userId}`} vouched in <@${target}> on Slack — ${seatsUsed}${maxVouchedUsers ? `/${maxVouchedUsers}` : ''} seats used.`);
  }
  return `✅ Vouched. <@${target}> can message me now — they’ll get in next time they write. You’re on record as who let them in.`;
}

// The inbound text path. DMs only (Slack channel type 'im'), authorize fail-closed (silent drop), map the
// Slack account to its own user, then run the shared brain. Returns the FULL handleMessage result (so the
// adapter can build blocks/buttons/files) with the status header prepended to a capture confirmation and the
// resolved `userId` attached. Silent drop = { reply: null } (nothing filed, no LLM, no reply) — see the
// anti-spam note. Do NOT "helpfully" restore a rejection reply: it confirms a live endpoint and invites spam.
export async function handleIncomingSlack({ text, slackUserId = null, slackUsername = null, channelType = 'im' }) {
  // Restore the "/" sigil from Slack's "$command" before the brain (and the vouch matcher) parse the line.
  const t = dollarToSlash((text || '').trim());
  if (!t) return { reply: null };
  if (channelType && channelType !== 'im') return { reply: null }; // ignore channels/groups silently (DMs only)

  const cfg = getSlackConfig();
  if (!authorize({ cfg, slackUserId, slackUsername })) return { reply: null };
  // Learn the owner's id (for scheduled wake-up DMs) even when an allowlist is set — the claim in authorize()
  // only runs when there's no allowlist.
  if (cfg.ownerSlackId == null && slackUserId) setSlackConfig({ ownerSlackId: slackUserId });

  const userId = slackUserId ? getOrCreateSlackUser(slackUserId, slackUsername || null) : defaultUserId();

  // "vouch …" is handled here, not by the brain (Slack mentions + id-keyed, platform-namespaced vouches).
  // The \b matches the brain's regex so "vouchsafe the milk" still files as a task rather than vouching.
  const vouchMatch = /^\/?vouch\b\s*([\s\S]*)$/i.exec(t);
  if (vouchMatch) return { reply: slackVouch({ userId, voucherSlackId: slackUserId, rest: vouchMatch[1] }), userId };

  const out = await handleMessage({ userId, text: t, channel: 'slack' });
  if (!out.reply) return { ...out, userId, reply: null };
  // The ambient status header rides only on a task-capture confirmation (logged) — every other reply skips it.
  // Plain text ("[ mood · time ]"), safe to prepend before an HTML/mrkdwn body (its chars aren't special).
  const head = out.logged ? formatStatusText(out.status) : '';
  return { ...out, userId, reply: head ? `${head}\n${out.reply}` : out.reply };
}

// An emoji reaction on one of the bot's messages (authorized only). `emoji` is already mapped back to unicode
// by the adapter; `ref` (when the adapter remembered which task the message was about) attributes it to that
// task, otherwise it's just a mood beat. Mirrors telegram-handler.handleReaction.
export function handleReactionSlack({ emoji, slackUserId = null, slackUsername = null, ref = null }) {
  if (!emoji || !slackUserId) return;
  if (!authorize({ cfg: getSlackConfig(), slackUserId, slackUsername })) return;
  applyReaction(getOrCreateSlackUser(slackUserId, slackUsername || null), emoji, ref);
}
