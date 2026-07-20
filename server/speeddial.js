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
import {
  getSpeedDialPad, listSpeedDialSlots, listSpeedDialAccounts, getSpeedDialAccount,
  upsertSpeedDialAccount, setSpeedDialSlot, clearSpeedDialSlot, clearSpeedDialPad,
  deleteSpeedDialAccount, addVouch, getUser, normUsername, listVouches,
} from './repo.js';
import { getHomeAssistantConfig, getTelegramConfig } from './settings.js';
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
  const said = await runHouseCommand(slot.command);
  if (!said.ok) return { text: said.text, buttons: padButtons(pad.slots) };
  return { text: `🏠 ${KEYCAP[n]} ${slotName(slot)} → ${said.speech}`, buttons: padButtons(pad.slots) };
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
  return { slots: pad.slots.map((s) => ({ slot: s.slot, name: slotName(s) })) };
}

// The expandable-account-list feed: one row per allowed Telegram handle (allowlist ∪ active vouches ∪ pads),
// each with its speed-dial config. Merged so the owner sees everyone in one place.
export function accountsData() {
  const rows = new Map(); // username → row
  const row = (u) => {
    if (!rows.has(u)) rows.set(u, { username: u, sources: [], voucher: null, speedDialOnly: false, linked: false, slots: [] });
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
  // (3) speed-dial accounts (the pad config + lock flag)
  for (const a of listSpeedDialAccounts()) {
    const r = row(a.username);
    r.speedDialOnly = a.speedDialOnly;
    r.slots = a.slots;
    if (a.telegramId != null) r.linked = true;
    if (!r.sources.length) r.sources.push('speeddial');
  }
  return { accounts: [...rows.values()].sort((a, b) => a.username.localeCompare(b.username)), houseConnected: configured(getHomeAssistantConfig()) };
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
      setSpeedDialSlot({ username: u, slot: n, label: String(s.label || '').trim(), command });
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

// Owner "Test" button on a slot: fire it against the house and report what happened.
export async function testSlotData(username, slot) {
  const s = listSpeedDialSlots(username).find((x) => x.slot === Number(slot));
  if (!s) return { ok: false, error: `no #${slot}` };
  const r = await runHouseCommand(s.command);
  return r.ok ? { ok: true, speech: r.speech } : { ok: false, error: r.text };
}
