// Speed Dial engine — the logic + text/JSON formatting behind owner-curated Home Assistant command pads.
// A pad is a person's numbers 0-9, each mapped to a free-text HA command the OWNER authored; the person sends
// a bare digit (or taps a button) and it fires ONLY that predefined command through the SAME converse() the
// `ha <command>` module uses, against the owner's single HA connection (services/homeassistant.js). The guest
// only ever sends a digit, so guest input never reaches HA/LLM as free text — that's the core safety property.
//
// This file NEVER touches SQL directly (calls repo helpers) and NEVER invokes an LLM to synthesize anything —
// converse() runs an owner-authored, stored string. It is shared by the registry feature (non-limited
// pad-holders, features/speeddial.js) AND the limited-account lockdown gate (chat.js). Owner authoring
// (add/set/limit/test/board) mirrors the web panel so the two surfaces stay at parity.
import { randomBytes, createHash } from 'node:crypto';
import {
  getSpeedDialPad, listSpeedDialSlots, listSpeedDialAccounts, getSpeedDialAccount,
  upsertSpeedDialAccount, setSpeedDialSlot, setSpeedDialToggleState, clearSpeedDialSlot, clearSpeedDialPad,
  deleteSpeedDialAccount, addVouch, getUser, normUsername, listVouches,
  createSpeedDialShare, resolveSpeedDialShareHash, listSpeedDialShares, revokeSpeedDialShare,
} from './repo.js';
import { getHomeAssistantConfig, getTelegramConfig, getSiteConfig, getAuthConfig } from './settings.js';
import { getBotIdentity } from './botStatus.js';
import { converse } from './services/homeassistant.js';
import { sanitizeForLlm } from './services/llm/sanitize.js';

const configured = (cfg) => !!(cfg.baseUrl && cfg.token);
const KEYCAP = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
const CLOSE_BTN = { text: '✕', data: 'm:hide:x' };

// A slot's display name: its label, else a short lead of the command.
function slotName(s) {
  if (s.label) return s.label;
  const c = String(s.command || '').trim();
  return c.length > 28 ? `${c.slice(0, 27)}…` : c;
}

// The pad as tappable rows (m:sd:<n>), 3 per row, filled slots only.
function padButtons(slots) {
  const rows = [];
  for (let i = 0; i < slots.length; i += 3) {
    rows.push(slots.slice(i, i + 3).map((s) => ({ text: `${KEYCAP[s.slot]} ${slotName(s)}`, data: `m:sd:${s.slot}` })));
  }
  return rows.length ? rows : null;
}

const houseNotConnected = 'The house isn’t connected yet — ask the owner to set up Home Assistant.';

// ── The guest surface (also used by the lockdown gate) ──────────────────────────────────────────────────

// Show a person their own pad (labels + tappable numbers). `pad` optional (re-fetched by userId if omitted).
export function padView(userId, pad = getSpeedDialPad(userId)) {
  if (!pad || !pad.slots.length) {
    return { text: '⚡ Your speed dial is empty — ask the owner to set up your numbers.', buttons: null };
  }
  const lines = pad.slots.map((s) => `${KEYCAP[s.slot]} ${slotName(s)}`);
  return { text: `⚡ Speed dial — tap a number, or send it (send 0 anytime to bring this back):\n${lines.join('\n')}`, buttons: padButtons(pad.slots) };
}

// The one-time first-contact greeting: route() stamps welcomed_at and returns this on a pad-holder's very
// first message, so they discover their numbers (a limited account sees the pad every message anyway).
export function welcomePad(userId) {
  const pad = getSpeedDialPad(userId);
  if (!pad || !pad.slots.length) return padView(userId, pad);
  const lines = pad.slots.map((s) => `${KEYCAP[s.slot]} ${slotName(s)}`);
  return {
    text: `👋 You’re connected to the house. Here’s your speed dial — tap a number, or just send it (send 0 anytime to bring this back):\n${lines.join('\n')}`,
    buttons: padButtons(pad.slots),
  };
}

// Fire slot `n` for a messaging person. Empty slot → their pad; house down → a gentle note; otherwise run the
// owner-authored command through HA Assist and echo what the house said. Never throws (converse is caught).
export async function fireSlot(userId, n) {
  const pad = getSpeedDialPad(userId);
  if (!pad) return { text: houseNotConnected, buttons: null };
  const slot = pad.slots.find((s) => s.slot === n);
  if (!slot) return { text: `You don’t have a #${n} set.`, buttons: padButtons(pad.slots) };
  const r = await runSlot(pad.username, slot);
  if (!r.ok) return { text: r.text, buttons: padButtons(pad.slots) };
  return { text: `🏠 ${KEYCAP[n]} ${slotName(slot)} → ${r.speech}`, buttons: padButtons(pad.slots) };
}

// The lockdown-gate entry for a limited account: "0" (or anything unrecognized) shows the pad; a bare 1-9 or
// "dial N" fires. "0" is the reserved "show my pad" key (an old phone's operator/menu); "dial 0" is the one
// way left to fire slot 0.
export function speedDialGate(userId, text) {
  const t = String(text || '').trim();
  let m;
  if (/^0$/.test(t)) return padView(userId);
  if ((m = /^\/?dial\s*#?([0-9])$/i.exec(t)) || (m = /^([1-9])$/.exec(t))) return fireSlot(userId, Number(m[1]));
  return padView(userId); // no tasks, no chat — only the pad
}

async function runHouseCommand(command) {
  const cfg = getHomeAssistantConfig();
  if (!configured(cfg)) return { ok: false, text: houseNotConnected };
  try {
    const speech = await converse(sanitizeForLlm(command), cfg);
    return { ok: true, speech };
  } catch (err) {
    return { ok: false, text: `Couldn’t reach the house: ${err.message}` };
  }
}

// A slot is a "toggle" when it carries a second (OFF) command; the number then alternates on↔off.
const isToggle = (s) => !!(s && String(s.commandOff || '').trim());

// Fire one slot, honoring a toggle. A plain slot always runs its `command`. A toggle runs whichever command
// the remembered position calls for (currently-off → run ON; currently-on → run OFF) and, on success, flips
// the server-tracked position so the next press does the other one. `username` is the pad owner's @handle,
// needed to persist the flip. The position is only ever a GUESS of the last command we sent — we can't read
// the device back from HA — so it drives WHICH command fires but is never surfaced as an on/off state.
async function runSlot(username, s) {
  const toggle = isToggle(s);
  const turningOn = toggle ? !s.toggleOn : true;      // a plain slot is always an "on" (single) press
  const command = turningOn ? s.command : s.commandOff;
  const said = await runHouseCommand(command);
  if (!said.ok) return { ok: false, text: said.text };
  if (toggle) setSpeedDialToggleState(username, s.slot, turningOn);
  return { ok: true, speech: said.speech };
}

// The per-slot shape sent to a browser pad surface: { slot, name } only — never the raw command, and NO on/off
// state (it would be a server guess we can't verify against HA, so a wrong badge is worse than none).
const padSlotView = (s) => ({ slot: s.slot, name: slotName(s) });

// ── Owner authoring (chat commands; the web panel calls the same repo helpers via the routes) ────────────

// Create/ensure an account row AND authorize the handle to reach the bot (idempotent vouch by the owner).
// Programming a pad grants house access, so it also grants bot access — otherwise the fail-closed Telegram
// gate would drop the person before they could ever dial.
function ensureAccount(ownerUserId, username, { speedDialOnly } = {}) {
  const u = normUsername(username);
  if (!u) return null;
  const existed = !!getSpeedDialAccount(u);
  const acct = upsertSpeedDialAccount({ username: u, speedDialOnly: speedDialOnly === undefined ? (getSpeedDialAccount(u)?.speed_dial_only === 1) : speedDialOnly });
  if (!existed) authorizeHandle(ownerUserId, u);
  return acct;
}
function authorizeHandle(ownerUserId, username) {
  const owner = getUser(ownerUserId) || {};
  addVouch({ username, voucherUserId: ownerUserId, voucherUsername: owner.username || null, voucherTelegramId: owner.telegram_id ?? null });
}

const okReply = (text) => ({ text, buttons: [[CLOSE_BTN]] });

// The owner board: every configured pad, its lock state + slots.
function board() {
  const accts = listSpeedDialAccounts();
  if (!accts.length) return okReply('No speed-dial pads yet. Add one: “sd @username 1 = turn off the kitchen lights”.');
  const lines = accts.map((a) => {
    const tag = a.speedDialOnly ? ' 🔒 limited' : '';
    const filled = a.slots.map((s) => s.slot).join(',') || '—';
    return `@${a.username}${tag} · slots: ${filled}`;
  });
  return okReply(`⚡ Speed-dial pads:\n${lines.join('\n')}\n\nEdit: “sd @user” · set: “sd @user 3 = …” · lock: “sd @user limit on”.`);
}

// Show one account's pad to the owner.
function showAccount(username) {
  const u = normUsername(username);
  const acct = getSpeedDialAccount(u);
  if (!acct) return okReply(`No pad for @${u} yet — set one: “sd @${u} 1 = turn off the kitchen lights”.`);
  const slots = listSpeedDialSlots(u);
  const lines = slots.length
    ? slots.map((s) => `${KEYCAP[s.slot]} ${s.label ? `${s.label} — ` : ''}${s.command}`).join('\n')
    : '(no numbers set)';
  const lock = acct.speed_dial_only === 1 ? '🔒 limited to speed dial' : 'full account + pad';
  return okReply(`⚡ @${u} — ${lock}\n${lines}\n\nSet: “sd @${u} 3 = Label | command” · clear: “sd @${u} 3 clear” · test: “sd @${u} test 3”.`);
}

// Parse + run an owner "sd …" / "speeddial …" command. Returns a reply, or null if it isn't a speed-dial
// command shape (so the feature's matcher can fall through — though the matcher already anchors on sd/speeddial).
export async function ownerCommand(ownerUserId, text) {
  const t = String(text || '').trim();
  // bare "sd" / "speeddial" → the board.
  if (/^\/?(sd|speeddial)$/i.test(t)) return board();
  // Everything else needs a @handle as the first argument.
  const m = /^\/?(?:sd|speeddial)\s+@?([A-Za-z0-9_]{1,64})\s*(.*)$/i.exec(t);
  if (!m) return okReply('Speed dial: “sd @username 3 = turn off the kitchen lights”. Bare “sd” lists your pads.');
  const username = normUsername(m[1]);
  const rest = (m[2] || '').trim();

  if (!rest) return showAccount(username);
  // sd @user add
  if (/^add$/i.test(rest)) { ensureAccount(ownerUserId, username); return okReply(`✓ @${username} added — they can reach the bot. Set numbers: “sd @${username} 1 = …”.`); }
  // sd @user remove | delete  → drop the whole pad (keeps the vouch/allowlist access).
  if (/^(remove|delete)$/i.test(rest)) { deleteSpeedDialAccount(username); return okReply(`✓ Removed @${username}'s pad. (Their bot access is unchanged — revoke that in Access.)`); }
  // sd @user clear  → clear all slots, keep the account.
  if (/^clear$/i.test(rest)) { clearSpeedDialPad(username); return okReply(`✓ Cleared @${username}'s numbers.`); }
  // sd @user limit on|off
  let lm;
  if ((lm = /^limit\s+(on|off)$/i.exec(rest))) {
    const on = /on/i.test(lm[1]);
    ensureAccount(ownerUserId, username, { speedDialOnly: on });
    return okReply(on
      ? `🔒 @${username} is now limited to speed dial — no tasks or chat, only their 0-9 numbers.`
      : `🔓 @${username} is no longer limited — a full account that still has the pad.`);
  }
  // sd @user test N  → fire the slot against the house (owner verification).
  let tm;
  if ((tm = /^test\s+#?([0-9])$/i.exec(rest))) {
    const n = Number(tm[1]);
    const slot = listSpeedDialSlots(username).find((s) => s.slot === n);
    if (!slot) return okReply(`@${username} has no #${n} to test.`);
    const r = await runHouseCommand(slot.command);
    return okReply(r.ok ? `🏠 tested @${username} #${n} → ${r.speech}` : r.text);
  }
  // sd @user N clear
  let cm;
  if ((cm = /^([0-9])\s+clear$/i.exec(rest))) { clearSpeedDialSlot(username, Number(cm[1])); return okReply(`✓ Cleared @${username} #${cm[1]}.`); }
  // sd @user N = [label |] command
  let sm;
  if ((sm = /^([0-9])\s*=\s*([\s\S]+)$/.exec(rest))) {
    const n = Number(sm[1]);
    let label = '';
    let command = sm[2].trim();
    const pipe = command.indexOf('|');
    if (pipe >= 0) { label = command.slice(0, pipe).trim(); command = command.slice(pipe + 1).trim(); }
    if (!command) return okReply('Give a command after “=”: “sd @user 3 = turn off the kitchen lights”.');
    ensureAccount(ownerUserId, username);
    setSpeedDialSlot({ username, slot: n, label, command });
    return okReply(`✓ @${username} ${KEYCAP[n]} ${label ? `${label} — ` : ''}${command}`);
  }
  return okReply(`Didn’t catch that. Try “sd @${username} 3 = turn off the kitchen lights”, “sd @${username} limit on”, or “sd @${username}” to view.`);
}

// ── Web-payload helpers (the /accounts routes return JSON, never the chat text) ──────────────────────────

// A compact pad for the web left-hint bar (rides /api/sidebar): filled slots as { slot, name }, or null when
// the person has no usable pad. The web sends "dial <n>" on tap — the SAME gesture a chat digit triggers,
// firing via the feature for a full account or the lockdown gate for a limited one. Keyed by the identity.
export function padSummary(userId) {
  const pad = getSpeedDialPad(userId);
  if (!pad || !pad.slots.length) return null;
  return { slots: pad.slots.map(padSlotView) };
}

// The expandable-account-list feed: one row per allowed Telegram handle (allowlist ∪ active vouches ∪ pads),
// each with its speed-dial config. Merged so the owner sees everyone in one place.
export function accountsData() {
  const rows = new Map(); // username → row
  const row = (u) => {
    if (!rows.has(u)) rows.set(u, { username: u, sources: [], voucher: null, speedDialOnly: false, linked: false, slots: [], shares: [] });
    return rows.get(u);
  };
  // (1) the raw allowlist CSV
  for (const raw of String(getTelegramConfig().allowedUsername || '').split(/[,\s]+/)) {
    const u = normUsername(raw);
    if (u) row(u).sources.push('allowlist');
  }
  // (2) active Telegram vouches (with who vouched them)
  for (const v of listVouches()) {
    if (v.revoked_at != null || (v.platform && v.platform !== 'telegram')) continue;
    const r = row(normUsername(v.username));
    r.sources.push('vouch');
    r.voucher = v.voucher_username || 'owner';
    if (v.vouched_telegram_id != null) r.linked = true;
  }
  // (3) speed-dial accounts (the pad config + lock flag + any active remote-control links)
  for (const a of listSpeedDialAccounts()) {
    const r = row(a.username);
    r.speedDialOnly = a.speedDialOnly;
    r.slots = a.slots;
    r.shares = listSpeedDialShares(a.username);
    if (a.telegramId != null) r.linked = true;
    if (!r.sources.length) r.sources.push('speeddial');
  }
  const bot = getBotIdentity();
  return {
    accounts: [...rows.values()].sort((a, b) => a.username.localeCompare(b.username)),
    houseConnected: configured(getHomeAssistantConfig()),
    loginOn: getAuthConfig().mode === 'simple', // gates the "Generate link" affordance in the panel
    // The connected Telegram bot's @username, so the printable sheet can tell a guest exactly whom to add and
    // message (that first message onboards them). Null when Telegram is down or the box is Slack-only.
    botUsername: bot?.platform === 'telegram' && bot.username ? bot.username : null,
  };
}

// Save an account's lock flag + slots from the web panel (replace-all for the 0-9 set).
export function savePadData(ownerUserId, username, { speedDialOnly = false, slots = [] } = {}) {
  const u = normUsername(username);
  if (!u) return { ok: false, error: 'bad username' };
  ensureAccount(ownerUserId, u, { speedDialOnly });
  clearSpeedDialPad(u);
  for (const s of Array.isArray(slots) ? slots : []) {
    const n = Number(s.slot);
    const command = String(s.command || '').trim();
    if (Number.isInteger(n) && n >= 0 && n <= 9 && command) {
      setSpeedDialSlot({ username: u, slot: n, label: String(s.label || '').trim(), command, commandOff: String(s.commandOff || '').trim() });
    }
  }
  return { ok: true };
}

export function addAccountData(ownerUserId, username) {
  const u = normUsername(username);
  if (!u) return { ok: false, error: 'bad username' };
  ensureAccount(ownerUserId, u);
  return { ok: true, username: u };
}

export function removePadData(username) {
  deleteSpeedDialAccount(username);
  return { ok: true };
}

// Owner "Test" button on a slot: fire a command against the house right now and report what happened. `command`
// (optional) is the text currently typed in the panel — tested verbatim so the owner can try a row (ON or OFF)
// BEFORE saving it; with no command it falls back to the slot's saved ON command. Never flips a toggle's state.
export async function testSlotData(username, slot, command) {
  const typed = String(command || '').trim();
  const cmd = typed || listSpeedDialSlots(username).find((x) => x.slot === Number(slot))?.command;
  if (!cmd) return { ok: false, error: `no #${slot}` };
  const r = await runHouseCommand(cmd);
  return r.ok ? { ok: true, speech: r.speech } : { ok: false, error: r.text };
}

// ── Shareable "remote control" links (the no-login guest surface; see repo.js + db.js v44) ───────────────
// Speed dial is really for the GUESTS of whoever runs Fanad — the host texts a guest a link and the guest
// taps a few house buttons, no Telegram account and no login required. A link is scoped to ONE pad and only
// fires its owner-authored slots, so a leaked link is bounded (predefined commands, an expiry, revocable) and
// still can't send free text to HA. The raw token lives only in the URL; the DB keeps only its sha256.
const SHARE_PREFIX = 'fsd1_';                 // recognizable/greppable like the CLI's fnd1_ (leak triage)
export const SHARE_TTL_DAYS = [1, 7, 30];      // the only expiries offered (no non-expiring link by design)
export const DEFAULT_SHARE_TTL_DAYS = 7;
const sha256 = (t) => createHash('sha256').update(String(t)).digest('hex');

// Mint a link for an EXISTING pad. Clamps ttlDays to the offered set (default 7d). Returns the raw token +
// full URL ONCE (never recoverable after — hash-only storage); `url` is null until the owner sets a Site URL,
// in which case the panel falls back to the browser origin. The caller (route) is owner-gated.
export function mintShareLink(username, { ttlDays = DEFAULT_SHARE_TTL_DAYS, label = '' } = {}) {
  // A share link lives on the Fanad origin, and its whole promise is "only these buttons, nothing else". That
  // only holds if everything ELSE on the origin requires auth: with web login off, the app + /api are open to
  // anyone who can reach the box, so the link wouldn't actually be limited. Refuse to mint until login is on.
  if (getAuthConfig().mode !== 'simple') {
    return { ok: false, needsLogin: true, error: 'Turn on web login (Settings → Security) before sharing a link — without it, anyone who can reach this address can use the whole app, not just these buttons.' };
  }
  const u = normUsername(username);
  if (!u) return { ok: false, error: 'bad username' };
  if (!getSpeedDialAccount(u)) return { ok: false, error: `No pad for @${u} yet — set a number first.` };
  const days = SHARE_TTL_DAYS.includes(Number(ttlDays)) ? Number(ttlDays) : DEFAULT_SHARE_TTL_DAYS;
  const now = Date.now();
  const expiresAt = now + days * 86400000;
  const token = SHARE_PREFIX + randomBytes(32).toString('base64url');
  const id = createSpeedDialShare({ username: u, tokenHash: sha256(token), label: String(label || '').trim().slice(0, 80) || null, expiresAt, at: now });
  if (!id) return { ok: false, error: 'could not create link' };
  const site = getSiteConfig().url;
  const path = `/r/${token}`;
  return { ok: true, id, token, path, url: site ? `${site}${path}` : null, expiresAt, ttlDays: days };
}

// A raw token from the URL → the pad it controls ({ id, username, expiresAt }) or null (bad prefix, unknown,
// revoked, or expired). The prefix check short-circuits the hash for anything that clearly isn't ours.
export function resolveShare(token) {
  const t = String(token || '');
  if (!t.startsWith(SHARE_PREFIX)) return null;
  return resolveSpeedDialShareHash(sha256(t));
}

// Fire slot `n` of a pad addressed BY USERNAME (the remote page has no messaging userId — this is the twin of
// fireSlot, which keys by userId). Runs the owner-authored command through the same converse() a digit uses.
export async function fireShareSlot(username, n) {
  const u = normUsername(username);
  const slot = listSpeedDialSlots(u).find((s) => s.slot === Number(n));
  if (!slot) return { ok: false, text: `There’s no #${n} on this pad.` };
  const r = await runSlot(u, slot);
  if (!r.ok) return { ok: false, text: r.text };
  return { ok: true, speech: r.speech, name: slotName(slot), slot: slot.slot };
}

// The remote page's pad payload: filled slots (each { slot, name }) + whether the house is reachable.
// Deliberately carries NO @handle, NO raw command, and NO on/off state — a guest sees only the numbers and
// their labels, never the command, whose pad it is, or a state we can't actually read back from HA.
export function shareRemoteData(username) {
  const u = normUsername(username);
  return {
    slots: listSpeedDialSlots(u).map(padSlotView),
    houseConnected: configured(getHomeAssistantConfig()),
  };
}

// Owner "revoke this link" — scoped to the pad so a stray id can't kill another pad's link.
export function revokeShareData(username, id) {
  return { ok: revokeSpeedDialShare(id, username) };
}
