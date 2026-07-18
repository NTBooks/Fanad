// User-scoped data access. Every function takes a userId (required) — the one place tenancy lives,
// so a query can't forget `WHERE user_id = ?`. The prototype is single-user (id=1).
import { db, tx } from './db.js';
import { emitUserEvent } from './events.js';
import { toBlob, fromBlob } from './rag/vector.js';
import { timeOfDay } from '../shared/state.js';
import { CATEGORIES } from '../shared/categories.js';
import { getTelegramConfig, getSlackConfig, OPTIN_FEATURES, getCurrentNotebookId, clearCurrentNotebookId, getSetting, setSetting } from './settings.js';

export const DEFAULT_USER_ID = 1;       // "root" — the local/PC user (web chat)
export const ROOT_USER_ID = 1;
export const defaultUserId = () => DEFAULT_USER_ID;

// ── 'counts' poke: tell /api/stream subscribers a user's /api/ha/summary numbers
// changed, so an HA dashboard updates sub-second instead of on its poll. Debounced per tick — a cascade of
// mutations in one request (a sweep, a cascade delete) collapses to ONE poke per user. Fire-and-forget:
// missing a poke costs a poll interval, so mutators call this unconditionally, never transactionally. ──
const pendingCountPokes = new Set();
function pokeCounts(userId) {
  const id = Number(userId);
  if (!Number.isFinite(id) || id <= 0) return;
  if (pendingCountPokes.size === 0) {
    setImmediate(() => {
      const ids = [...pendingCountPokes];
      pendingCountPokes.clear();
      for (const u of ids) emitUserEvent(u, 'counts');
    });
  }
  pendingCountPokes.add(id);
}

// All real accounts (root + each Telegram/Slack contact). Backs the host-only impersonation picker; never
// exposed without the USER_IMPERSONATION flag (see routes/api.js). No secrets here — just identity columns.
// Notebooks (sub-users, parent_user_id set) are EXCLUDED: they aren't accounts, only private spaces reachable
// through their owner — so they must never appear as an impersonation target. (resolveActingUserId also
// rejects a notebook id, so a crafted header can't select one.)
export function listUsers() {
  return db.prepare(
    'SELECT id, display_name, email, telegram_id, slack_id, created_at, last_seen_at FROM users WHERE parent_user_id IS NULL ORDER BY id',
  ).all().map((u) => ({
    ...u, id: num(u.id), telegram_id: u.telegram_id == null ? null : num(u.telegram_id),
    created_at: num(u.created_at), last_seen_at: u.last_seen_at == null ? null : num(u.last_seen_at),
  }));
}

// Does a user row exist? Used to validate an impersonation target before acting as it.
export function userExists(id) {
  return !!db.prepare('SELECT 1 FROM users WHERE id=?').get(id);
}

// Resolve a user's identity row from their id. Used to attribute a vouch to the authorized user making it:
// their @username is `display_name` and `telegram_id` is the stable numeric handle. Null for an unknown id.
export function getUser(id) {
  const u = db.prepare('SELECT id, display_name, email, telegram_id, slack_id, created_at, last_seen_at FROM users WHERE id=?').get(id);
  if (!u) return null;
  return { ...u, id: num(u.id), telegram_id: u.telegram_id == null ? null : num(u.telegram_id) };
}

// Is this user the deployment OWNER? True for root (the local/web operator) and for whichever platform
// account CLAIMED the bot (telegram ownerId / slack ownerSlackId, trust-on-first-use). The vouch module
// reads this to auto-enable itself for the owner, so headless onboarding stays zero-step — the owner can
// add the first user the moment they claim the box, without remoting in to flip a setting.
export function isOwner(userId) {
  if (Number(userId) === ROOT_USER_ID) return true;
  const u = getUser(userId);
  if (!u) return false;
  const tgOwner = getTelegramConfig().ownerId;
  if (tgOwner != null && u.telegram_id != null && Number(u.telegram_id) === Number(tgOwner)) return true;
  const slackOwner = getSlackConfig().ownerSlackId;
  if (slackOwner != null && u.slack_id != null && String(u.slack_id) === String(slackOwner)) return true;
  return false;
}

// Resolve a Telegram account to its OWN user row (created on first contact). Keeps each person's
// tasks, history, and dossier separate from root and from each other.
export function getOrCreateTelegramUser(telegramId, displayName = null) {
  const row = db.prepare('SELECT id, display_name FROM users WHERE telegram_id=?').get(telegramId);
  if (row) {
    if (displayName && displayName !== row.display_name) {
      db.prepare('UPDATE users SET display_name=?, last_seen_at=? WHERE id=?').run(displayName, Date.now(), row.id);
    }
    return row.id;
  }
  const info = db.prepare('INSERT INTO users (telegram_id, display_name, created_at, last_seen_at) VALUES (?,?,?,?)')
    .run(telegramId, displayName, Date.now(), Date.now());
  return num(info.lastInsertRowid);
}

// Resolve a Slack account to its OWN user row (created on first contact), exactly like the Telegram path.
// Keyed by Slack's immutable workspace id (Uxxxx/Wxxxx — TEXT, never numeric, so NO num() coercion). Each
// Slack person is their own user (own tasks/history/dossier), separate from root and from Telegram users.
export function getOrCreateSlackUser(slackId, displayName = null) {
  const row = db.prepare('SELECT id, display_name FROM users WHERE slack_id=?').get(slackId);
  if (row) {
    if (displayName && displayName !== row.display_name) {
      db.prepare('UPDATE users SET display_name=?, last_seen_at=? WHERE id=?').run(displayName, Date.now(), row.id);
    }
    return num(row.id);
  }
  const info = db.prepare('INSERT INTO users (slack_id, display_name, created_at, last_seen_at) VALUES (?,?,?,?)')
    .run(slackId, displayName, Date.now(), Date.now());
  return num(info.lastInsertRowid);
}

// ─────────────────────────── Web login accounts (auth §9; migration v24) ───────────────────────────
// Credentials live on the users row: `username` (the web login handle, unique NOCASE), `password_hash`
// (self-describing scrypt string), `totp_secret` (VERIFIED TOTP secret, KEK-encrypted), `totp_verified_at`.
// All the crypto/verification logic lives in auth.js — these are just the row accessors. Notebooks are
// excluded everywhere (parent_user_id IS NULL): a sub-user must never be a login target.
const AUTH_COLS = 'id, username, password_hash, totp_secret, totp_verified_at';
const authRow = (r) => (r ? {
  id: num(r.id), username: r.username || null, password_hash: r.password_hash || null,
  totp_secret: r.totp_secret || null, totp_verified_at: r.totp_verified_at == null ? null : num(r.totp_verified_at),
} : null);

export function getUserByUsername(username) {
  const u = String(username || '').trim();
  if (!u) return null;
  return authRow(db.prepare(`SELECT ${AUTH_COLS} FROM users WHERE username = ? COLLATE NOCASE AND parent_user_id IS NULL`).get(u));
}
export function getAuthRow(id) {
  return authRow(db.prepare(`SELECT ${AUTH_COLS} FROM users WHERE id = ? AND parent_user_id IS NULL`).get(id));
}
// A self-registered web account: a fresh tenant row exactly like a Telegram/Slack user, keyed by username.
// display_name mirrors the username so the impersonation picker and vouch attribution can label it.
export function createWebUser({ username, passwordHash }) {
  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO users (username, password_hash, display_name, created_at, last_seen_at) VALUES (?,?,?,?,?)',
  ).run(username, passwordHash, username, now, now);
  return num(info.lastInsertRowid);
}
// Count self-registered browser DEMO accounts: real accounts (parent_user_id IS NULL) carrying web
// credentials (username) but NO platform identity (no telegram/slack/email) and not root. This is the
// population the maxWebDemoAccounts backstop bounds — the web analogue of countActiveVouches for Telegram.
export function countWebAccounts() {
  return num(db.prepare(
    `SELECT COUNT(*) AS n FROM users
       WHERE parent_user_id IS NULL AND username IS NOT NULL
         AND id != ? AND telegram_id IS NULL AND slack_id IS NULL AND email IS NULL`,
  ).get(ROOT_USER_ID).n);
}
export function setUserCredentials(id, { username = null, passwordHash = null } = {}) {
  const sets = [];
  const params = [];
  if (username != null) { sets.push('username = ?'); params.push(username); }
  if (passwordHash != null) { sets.push('password_hash = ?'); params.push(passwordHash); }
  if (!sets.length) return;
  params.push(id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ? AND parent_user_id IS NULL`).run(...params);
}
// Store a PROVEN secret + stamp verification in one write — called only after a live code matched, so a
// verified 2FA is never left half-replaced (the unverified enrollment waits in totp_pending:<id> until then).
export function setUserTotpVerified(id, encSecret, at = Date.now()) {
  db.prepare('UPDATE users SET totp_secret = ?, totp_verified_at = ? WHERE id = ? AND parent_user_id IS NULL').run(encSecret, at, id);
}

// ─────────────────────────── Notebooks (isolated per-user spaces; migration v23) ───────────────────────────
// A notebook is a sub-user ROW owned by a parent (parent_user_id) and named per parent (notebook_name). It has
// no channel identity (telegram_id/slack_id/email are NULL), so nothing but its owner can ever resolve to it —
// the isolation guarantee. All of a notebook's data lives under its own user_id, so every existing query keeps
// it separate for free. The parent switches into one via the current-notebook pointer (settings.js), validated
// by effectiveUserId below. Reserved names double as "go back to main" words, so a notebook can't take one.
export const RESERVED_NOTEBOOK_NAMES = new Set(['main', 'default', 'home', 'exit', 'out', 'none', 'list', 'ls', 'rename', 'retire', 'retired', 'recover', 'unretire']);
export function normNotebookName(name) { return String(name || '').trim(); }
const notebookRow = (r) => (r ? { id: num(r.id), parent_user_id: num(r.parent_user_id), notebook_name: r.notebook_name, created_at: num(r.created_at), retired_at: r.retired_at == null ? null : num(r.retired_at) } : null);
const NB_COLS = 'id, parent_user_id, notebook_name, created_at, retired_at';

// Is this user id a notebook (a sub-user), not a real account? Used to keep notebooks off the impersonation
// path (resolveActingUserId) and out of any "list of accounts".
export function isNotebook(id) {
  const r = db.prepare('SELECT parent_user_id FROM users WHERE id=?').get(id);
  return !!(r && r.parent_user_id != null);
}
// Retired notebooks stay resolvable by id (delivery routing, accountIdFor, ownership checks) but are
// invisible by NAME — the by-name/list surfaces below are what "hidden" means, and the retired_* pair is
// the only recovery door.
export function getNotebook(id) {
  return notebookRow(db.prepare(`SELECT ${NB_COLS} FROM users WHERE id=? AND parent_user_id IS NOT NULL`).get(id));
}
export function getNotebookByName(parentId, name) {
  const clean = normNotebookName(name);
  if (!clean) return null;
  return notebookRow(db.prepare(`SELECT ${NB_COLS} FROM users WHERE parent_user_id=? AND notebook_name=? COLLATE NOCASE AND retired_at IS NULL`).get(parentId, clean));
}
export function listNotebooks(parentId) {
  return db.prepare(`SELECT ${NB_COLS} FROM users WHERE parent_user_id=? AND retired_at IS NULL ORDER BY notebook_name COLLATE NOCASE`).all(parentId).map(notebookRow);
}
export function listRetiredNotebooks(parentId) {
  return db.prepare(`SELECT ${NB_COLS} FROM users WHERE parent_user_id=? AND retired_at IS NOT NULL ORDER BY retired_at DESC`).all(parentId).map(notebookRow);
}
// Several retired notebooks may share a name (the unique index only covers live ones) — resolve to the
// most recently retired, the one the user most plausibly means.
export function getRetiredNotebookByName(parentId, name) {
  const clean = normNotebookName(name);
  if (!clean) return null;
  return notebookRow(db.prepare(`SELECT ${NB_COLS} FROM users WHERE parent_user_id=? AND notebook_name=? COLLATE NOCASE AND retired_at IS NOT NULL ORDER BY retired_at DESC`).get(parentId, clean));
}
export function listChildNotebookIds(parentId) {
  return db.prepare('SELECT id FROM users WHERE parent_user_id=?').all(parentId).map((r) => num(r.id));
}
// Create a notebook (a sub-user) owned by parentId. Returns { notebook } or { error } (blank | reserved |
// toolong | exists) so the caller can phrase it. The row carries NO channel identity, so only the parent can
// ever reach it. display_name mirrors the name (handy in any debug listing; it's never an impersonation target).
export function createNotebook(parentId, name) {
  const clean = normNotebookName(name);
  if (!clean) return { error: 'blank' };
  if (RESERVED_NOTEBOOK_NAMES.has(clean.toLowerCase())) return { error: 'reserved' };
  if (clean.length > 40) return { error: 'toolong' };
  if (getNotebookByName(parentId, clean)) return { error: 'exists' };
  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO users (parent_user_id, notebook_name, display_name, created_at, last_seen_at) VALUES (?,?,?,?,?)',
  ).run(parentId, clean, clean, now, now);
  return { notebook: getNotebook(num(info.lastInsertRowid)) };
}
export function renameNotebook(parentId, oldName, newName) {
  const nb = getNotebookByName(parentId, oldName);
  if (!nb) return { error: 'notfound' };
  const clean = normNotebookName(newName);
  if (!clean) return { error: 'blank' };
  if (RESERVED_NOTEBOOK_NAMES.has(clean.toLowerCase())) return { error: 'reserved' };
  if (clean.length > 40) return { error: 'toolong' };
  const clash = getNotebookByName(parentId, clean);
  if (clash && clash.id !== nb.id) return { error: 'exists' };
  db.prepare('UPDATE users SET notebook_name=?, display_name=? WHERE id=? AND parent_user_id=?').run(clean, clean, nb.id, parentId);
  return { notebook: getNotebook(nb.id) };
}
// Retire = hide, never delete: the sub-user row and all its data stay put; the retired_at stamp just takes
// it out of every live surface (listings, by-name switch, the proactive allDue* sweeps). Retiring the space
// you're standing in drops you back to main — a hidden space must never be the one you're acting in.
export function retireNotebook(parentId, name) {
  const nb = getNotebookByName(parentId, name);
  if (!nb) return { error: 'notfound' };
  db.prepare('UPDATE users SET retired_at=? WHERE id=? AND parent_user_id=?').run(Date.now(), nb.id, parentId);
  if (getCurrentNotebookId(parentId) === nb.id) clearCurrentNotebookId(parentId);
  return { notebook: getNotebook(nb.id) };
}
// Recover clears the stamp. If a LIVE notebook took the name in the meantime (retiring frees it — see the
// v32 index), the recovered one comes back under the first free "name 2"/"name 3"… variant instead of
// clobbering or colliding; `renamedFrom` tells the caller so the reply can say what happened. The suffix
// trims the base to keep the result inside the 40-char name budget.
export function recoverNotebook(parentId, name) {
  const nb = getRetiredNotebookByName(parentId, name);
  if (!nb) return { error: 'notfound' };
  let newName = nb.notebook_name;
  let renamedFrom = null;
  if (getNotebookByName(parentId, newName)) {
    renamedFrom = newName;
    for (let i = 2; ; i++) {
      const suffix = ` ${i}`;
      const candidate = nb.notebook_name.slice(0, 40 - suffix.length).trimEnd() + suffix;
      if (!getNotebookByName(parentId, candidate)) { newName = candidate; break; }
    }
  }
  db.prepare('UPDATE users SET retired_at=NULL, notebook_name=?, display_name=? WHERE id=? AND parent_user_id=?')
    .run(newName, newName, nb.id, parentId);
  return { notebook: getNotebook(nb.id), renamedFrom };
}
// The ONE seam the notebook feature adds: resolve which user id a turn's DATA should read/write for a real
// account `identityId` — the current notebook's sub-user when one is active AND still owned by this identity,
// else the identity itself. Self-heals a stale/foreign pointer (deleted notebook, or a forged id that isn't
// this identity's) straight back to main, so a bad pointer can never leak into another user's data. Because a
// sub-user has no pointer of its own (the pointer is only ever read for a real identity), this never nests.
export function effectiveUserId(identityId) {
  const nbId = getCurrentNotebookId(identityId);
  if (nbId == null) return identityId;
  const nb = getNotebook(nbId);
  // A retired notebook heals like a deleted one: you can never be standing in a hidden space.
  if (!nb || nb.parent_user_id !== Number(identityId) || nb.retired_at != null) { clearCurrentNotebookId(identityId); return identityId; }
  return nbId;
}

// ─────────────────────────── Demo service account (the /demo page's voucher) ───────────────────────────
// The public /demo signup page vouches visitors in ON BEHALF OF a dedicated service account, not the owner
// — so the vouch tree shows "vouched in by @demo" and the whole demo cohort stays distinguishable from
// personal invites (cascade-revoking "demo" in the admin sweeps every demo signup at once). The row is an
// ordinary users row with NO platform identity and NO credentials: it can never log in, message, or be
// messaged — it exists only to be a voucher_user_id. Created lazily on first use; its id is remembered in
// app_settings (`demo_service_user_id`) so we never key on the mutable display_name.
export const DEMO_VOUCHER_NAME = 'demo';

export function getOrCreateDemoServiceUserId() {
  const stored = getSetting('demo_service_user_id', null);
  if (stored != null && userExists(stored)) return num(Number(stored));
  const now = Date.now();
  const info = db.prepare('INSERT INTO users (display_name, created_at, last_seen_at) VALUES (?,?,?)')
    .run(DEMO_VOUCHER_NAME, now, now);
  const id = num(info.lastInsertRowid);
  setSetting('demo_service_user_id', id);
  return id;
}

// ─────────────────────────── Vouches (access by personal endorsement; migration v18) ───────────────────────────
// The whitelist can grow socially: any already-authorized user runs "vouch @username" to let someone in, and
// we record who vouched whom so it stays accountable. Keyed by the vouched @username (the same handle the
// Telegram allowlist matches on). authorize() (telegram-handler.js) consults isVouched() on every message.
// This is GLOBAL access control, NOT per-user data — never add a `user_id` column / USER_TABLES entry.

// Normalize a handle to the stored form: trimmed, lowercased, leading '@'(s) stripped.
export function normUsername(u) { return String(u || '').trim().toLowerCase().replace(/^@+/, ''); }

// The stored vouch key for a (username, platform). Telegram handles are normalized (lowercased, '@' stripped);
// a Slack key is the immutable Uxxxx/Wxxxx id — case-SENSITIVE and never carries '@' — so it's only trimmed.
// Vouches are namespaced by platform (migration v21->v22), so a Telegram "alice" never authorizes a Slack one.
function vouchKey(username, platform = 'telegram') {
  return platform === 'slack' ? String(username || '').trim() : normUsername(username);
}

// Is this key currently vouched-in (an active, non-revoked vouch) on `platform`? Blank → false.
export function isVouched(username, platform = 'telegram') {
  const u = vouchKey(username, platform);
  if (!u) return false;
  return !!db.prepare('SELECT 1 FROM vouches WHERE platform=? AND username=? AND revoked_at IS NULL').get(platform, u);
}

// Convenience for the Slack adapter: a vouch keyed on the immutable Slack id.
export function isVouchedSlack(slackId) { return isVouched(slackId, 'slack'); }

// ── Telegram identity pinning (migration v31). The Telegram vouch key is the MUTABLE @username: a vouched
// user who renames would silently lose access, and a squatter who later claims the lapsed handle would
// inherit the vouch. So on the vouchee's FIRST authorized contact the handler stamps their immutable
// numeric id onto the row; from then on the ID is what admits them (rename-proof) and the same handle
// under a DIFFERENT id is refused (squatter-proof). The handle deliberately stays the row's key — it's the
// UNIQUE constraint and the cascade-revoke parent edge; a renamed user just shows under the handle they
// were invited as. Slack needs none of this (its key is already the immutable Uxxxx id). ──

// The authorize()-side vouch check: pinned id wins; an unpinned matching handle is a first contact (the
// caller pins it); a matching handle pinned to someone ELSE is refused — silently, like any stranger.
export function isVouchedTelegram({ username = null, telegramId = null } = {}) {
  if (telegramId != null
    && db.prepare("SELECT 1 FROM vouches WHERE platform='telegram' AND vouched_telegram_id=? AND revoked_at IS NULL").get(telegramId)) {
    return true;
  }
  const u = normUsername(username);
  if (!u) return false;
  const row = db.prepare("SELECT vouched_telegram_id FROM vouches WHERE platform='telegram' AND username=? AND revoked_at IS NULL").get(u);
  if (!row) return false;
  if (row.vouched_telegram_id == null) return true; // first contact — telegram-handler pins it
  return telegramId != null && Number(row.vouched_telegram_id) === Number(telegramId);
}

// Stamp the vouchee's numeric id onto their active, still-unpinned row (a no-op otherwise — a pin lasts
// until the vouch is revoked; a re-vouch resets it via addVouch's UPSERT so the NEW holder gets pinned).
export function pinVouchTelegramId(username, telegramId, at = Date.now()) {
  const u = normUsername(username);
  if (!u || telegramId == null) return false;
  return num(db.prepare(
    "UPDATE vouches SET vouched_telegram_id=?, pinned_at=? WHERE platform='telegram' AND username=? AND revoked_at IS NULL AND vouched_telegram_id IS NULL",
  ).run(telegramId, at, u).changes) > 0;
}

// How many vouch edges sit between a handle and the deployment owner: 0 = never vouched (the owner, a seed,
// or an unknown), 1 = vouched by such a user, 2 = vouched by a vouched user, … Walks the same
// voucher_username parent edge cascade-revoke uses; cycle-safe. Backs the VOUCH_MAX_DEPTH rule — a user AT
// the max depth may not vouch further (their invitee would exceed it).
export function vouchDepthOf(username, platform = 'telegram') {
  let depth = 0;
  const seen = new Set();
  let cur = vouchKey(username, platform);
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const row = getActiveVouch(cur, platform);
    if (!row) break;
    depth += 1;
    cur = row.voucher_username ? vouchKey(row.voucher_username, platform) : null;
  }
  return depth;
}

// Active vouches on a platform — the "seats used" count behind MAX_VOUCHED_USERS.
export function countActiveVouches(platform = 'telegram') {
  return num(db.prepare('SELECT COUNT(*) AS n FROM vouches WHERE platform=? AND revoked_at IS NULL').get(platform).n);
}

// The active vouch row for a key (or null) — lets a caller name who let someone in.
export function getActiveVouch(username, platform = 'telegram') {
  const u = vouchKey(username, platform);
  if (!u) return null;
  return db.prepare('SELECT * FROM vouches WHERE platform=? AND username=? AND revoked_at IS NULL').get(platform, u) || null;
}

// Record a vouch. The voucher is the authorized user running the command (resolved from their userId via
// getUser). UPSERT on the unique username: re-vouching a previously-revoked handle re-activates it under the
// NEW voucher. Returns { username, voucher_username, status: 'added' | 'reactivated' | 'already' } — or null
// for a blank handle. 'already' means it was active and untouched (idempotent).
export function addVouch({ username, platform = 'telegram', voucherUserId = null, voucherUsername = null, voucherTelegramId = null, at = Date.now() }) {
  const u = vouchKey(username, platform);
  if (!u) return null;
  // The voucher snapshot is the cascade-revoke parent edge: store it in the SAME key form as `username` on
  // this platform (a Telegram handle normalized; a Slack voucher's id trimmed) so childrenOf() matches.
  const vName = voucherUsername ? vouchKey(voucherUsername, platform) : null;
  const prior = db.prepare('SELECT revoked_at FROM vouches WHERE platform=? AND username=?').get(platform, u);
  if (prior && prior.revoked_at == null) return { username: u, platform, voucher_username: vName, status: 'already' };
  // Reactivation RESETS the identity pin (vouched_telegram_id, v31): the fresh vouch is for whoever holds
  // the handle NOW — if the old pin were kept, revoking a squatter and re-vouching the real person would
  // still admit the squatter's id and refuse the person the new vouch was meant for.
  db.prepare(
    `INSERT INTO vouches (platform, username, voucher_user_id, voucher_username, voucher_telegram_id, created_at, revoked_at, revoked_by_user_id)
     VALUES (?,?,?,?,?,?,NULL,NULL)
     ON CONFLICT(platform, username) DO UPDATE SET
       voucher_user_id=excluded.voucher_user_id, voucher_username=excluded.voucher_username,
       voucher_telegram_id=excluded.voucher_telegram_id, created_at=excluded.created_at,
       revoked_at=NULL, revoked_by_user_id=NULL, vouched_telegram_id=NULL, pinned_at=NULL`,
  ).run(platform, u, voucherUserId, vName, voucherTelegramId, at);
  return { username: u, platform, voucher_username: vName, status: prior ? 'reactivated' : 'added' };
}

// Every vouch (active + revoked), newest first — backs the admin UI's provenance tree. Ids → Number.
export function listVouches() {
  return db.prepare('SELECT * FROM vouches ORDER BY created_at DESC').all().map((v) => ({
    ...v, id: num(v.id),
    voucher_user_id: v.voucher_user_id == null ? null : num(v.voucher_user_id),
    voucher_telegram_id: v.voucher_telegram_id == null ? null : num(v.voucher_telegram_id),
    created_at: num(v.created_at), revoked_at: v.revoked_at == null ? null : num(v.revoked_at),
    revoked_by_user_id: v.revoked_by_user_id == null ? null : num(v.revoked_by_user_id),
  }));
}

// Active handles vouched in BY one user (their own endorsements) — the chat "vouches" listing.
export function listVouchesBy(voucherUserId) {
  return db.prepare('SELECT username FROM vouches WHERE voucher_user_id=? AND revoked_at IS NULL ORDER BY created_at DESC')
    .all(voucherUserId).map((r) => r.username);
}

// Cascade-revoke: soft-revoke `username` AND everyone in the subtree they vouched (their invitees, those
// invitees' invitees, …). Rows are KEPT (revoked_at + revoked_by stamped) so the record survives. The tree
// edge is the voucher_username snapshot (parent → child). Cycle-safe via `seen`. Children are collected
// while still active, so revoking a parent never hides its descendants. Returns the revoked handles in
// revoke order (the root first, then outward). One transaction — all-or-nothing.
export function revokeVouchCascade(username, { byUserId = null, at = Date.now(), platform = 'telegram' } = {}) {
  const root = vouchKey(username, platform);
  if (!root) return [];
  // Scope both the revoke and the tree walk to `platform` so a Telegram subtree can't sweep a Slack handle
  // that happens to share a string (and vice versa).
  const revokeOne = db.prepare('UPDATE vouches SET revoked_at=?, revoked_by_user_id=? WHERE platform=? AND username=? AND revoked_at IS NULL');
  const childrenOf = db.prepare('SELECT username FROM vouches WHERE platform=? AND voucher_username=? AND revoked_at IS NULL');
  const revoked = [];
  const seen = new Set();
  const queue = [root];
  db.exec('BEGIN');
  try {
    while (queue.length) {
      const cur = queue.shift();
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const c of childrenOf.all(platform, cur)) queue.push(vouchKey(c.username, platform)); // collect while still active
      if (num(revokeOne.run(at, byUserId, platform, cur).changes)) revoked.push(cur);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return revoked;
}

// Reclaim NO-SHOW demo seats: soft-revoke the /demo self-signups that reserved a seat but never sent a
// first message within `olderThanMs`. The tell is an UNPINNED vouch (vouched_telegram_id IS NULL — the
// telegram-handler pins the id on first authorized contact), so anyone who actually messaged is safe
// forever. Scoped to the demo cohort by voucher_user_id (the /demo service account): an owner's direct
// "vouch @someone" is never swept. A no-show never messaged ⇒ never vouched anyone, so there's no subtree
// to cascade — a flat batch revoke is correct. Rows are KEPT (revoked_at stamped, revoked_by = the demo
// account) so the admin tree still shows the churn, and a later re-signup reactivates via addVouch's UPSERT.
// Self-gates to a no-op on any box that never opened /demo (no service account ⇒ no demo vouches). Returns
// the reclaimed handles for the caller to log / surface. `olderThanMs` falsy ⇒ disabled (returns []).
export function reclaimStaleDemoSeats({ olderThanMs, now = Date.now() } = {}) {
  const demoId = getSetting('demo_service_user_id', null);
  if (demoId == null || !olderThanMs) return [];
  const id = Number(demoId);
  const cutoff = now - olderThanMs;
  const where = "platform='telegram' AND voucher_user_id=? AND revoked_at IS NULL AND vouched_telegram_id IS NULL AND created_at < ?";
  const rows = db.prepare(`SELECT username FROM vouches WHERE ${where}`).all(id, cutoff);
  if (!rows.length) return [];
  db.prepare(`UPDATE vouches SET revoked_at=?, revoked_by_user_id=? WHERE ${where}`).run(now, id, id, cutoff);
  return rows.map((r) => r.username);
}

// ── Per-user dossier (behavior profile) ──
export function getUserProfile(userId) {
  const r = db.prepare('SELECT data_json FROM user_profile WHERE user_id=?').get(userId);
  if (!r) return null;
  try { return JSON.parse(r.data_json); } catch { return null; }
}
export function saveUserProfile(userId, data) {
  db.prepare('INSERT OR REPLACE INTO user_profile (user_id, data_json, updated_at) VALUES (?,?,?)')
    .run(userId, JSON.stringify(data), Date.now());
}
export function outcomeTotals(userId) {
  return db.prepare('SELECT outcome, COUNT(*) AS n FROM task_outcomes WHERE user_id=? GROUP BY outcome').all(userId);
}
export function doneByCategory(userId) {
  return db.prepare("SELECT category, COUNT(*) AS n FROM task_outcomes WHERE user_id=? AND outcome='done' GROUP BY category ORDER BY n DESC").all(userId);
}
export function donePhaseByCategory(userId) {
  return db.prepare("SELECT category, ctx_phase, COUNT(*) AS n FROM task_outcomes WHERE user_id=? AND outcome='done' AND ctx_phase IS NOT NULL GROUP BY category, ctx_phase").all(userId);
}
export function taskStatusCounts(userId) {
  return db.prepare('SELECT status, COUNT(*) AS n FROM tasks WHERE user_id=? GROUP BY status').all(userId);
}
export function topReactionMood(userId) {
  const r = db.prepare("SELECT mood_emojis FROM state_snapshots WHERE user_id=? AND mood_emojis IS NOT NULL AND mood_emojis<>'' GROUP BY mood_emojis ORDER BY COUNT(*) DESC LIMIT 1").get(userId);
  return r?.mood_emojis || null;
}

const num = (v) => (typeof v === 'bigint' ? Number(v) : v);

// ── Full-account erase / export (the /requestdeletion command) ──
// Every per-user DATA table, all user_id-scoped. The deletion purge wipes each of these; the retention
// export reads each of these. Keep this list complete — a table added to db.js with a user_id column
// belongs here too (the deletion-completeness test guards against forgetting). The global `app_settings`
// store is intentionally NOT here: it holds shared config (LLM keys, telegram token, taxonomy) plus the
// few per-user keys handled separately below.
export const USER_TABLES = [
  'messages', 'state_snapshots', 'tasks', 'embeddings',
  'notes', 'metrics', 'metric_values', 'suggestion_events', 'schedules', 'wakeups',
  'task_outcomes', 'user_profile', 'images', 'task_templates', 'list_items', 'web_sessions', 'timers',
  'journals', 'journal_entries', 'journal_summaries', 'foods', 'recipes', 'recipe_items',
  'llm_usage', 'batches', 'batch_log', 'batch_rejects', 'diet_days', 'cli_tokens', 'undo_stack',
];

// The per-user keys parked in the otherwise-global app_settings store (dialog state, last listing, paging
// cursor, the category/effort lock). Wiped alongside the data tables so no trace of the session remains.
const userSettingKeys = (userId) => [
  `dialog_state:${userId}`, `last_listing:${userId}`, `last_page:${userId}`, `task_lock:${userId}`,
  `list_cursor:${userId}`, `features:${userId}`, `notebook:${userId}`, `totp_pending:${userId}`,
  ...OPTIN_FEATURES.map((m) => `daily_gate:module_nudge:${m}:${userId}`),
];

// Snapshot EVERYTHING we hold on a user (for the retention export): the identity row + every data table's
// rows, keyed by table name. Read-only; the filesystem/zip half lives in retention.js.
export function collectUserData(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) || null;
  const tables = {};
  for (const t of USER_TABLES) tables[t] = db.prepare(`SELECT * FROM ${t} WHERE user_id = ?`).all(userId);
  // A user's notebooks (sub-users) hold their own data under their own user_id — snapshot each so the export
  // is complete (they're erased alongside the parent on /requestdeletion; see deleteAllUserData).
  const notebooks = listChildNotebookIds(userId).map((cid) => {
    const nbTables = {};
    for (const t of USER_TABLES) nbTables[t] = db.prepare(`SELECT * FROM ${t} WHERE user_id = ?`).all(cid);
    return { notebook: getNotebook(cid), tables: nbTables };
  });
  return { user, tables, notebooks };
}

// Erase ALL of a user's data — irreversible. Wipes every USER_TABLE row + the per-user app_settings keys
// in one transaction, but KEEPS the users identity row so the account/session still resolves afterward
// (the next message just sees an empty slate). Returns the per-table counts removed. Callers MUST gate this
// behind an explicit confirmation (and may archive first via retention.js). The table names are a fixed
// internal allow-list — never user input — so the string interpolation is safe.
//
// FK enforcement is toggled OFF around the purge: cross-table references between the user's own rows (a
// note's promoted_task_id, a snapshot's message_id, …) aren't all ON DELETE CASCADE, so a fixed delete
// order would otherwise trip them mid-purge. Once every user row is gone there are no dangling refs, so
// this is safe — the same approach migrate() uses for table rebuilds. PRAGMA foreign_keys is a no-op
// inside a transaction, so it's set outside and restored in finally.
// The user's OWN notebooks (sub-users) are wiped and removed too — their data belongs to this user, so an
// erase that left them behind would orphan private data. The parent identity row is KEPT (per above); the
// notebook rows are DELETED (they're spaces, not accounts). counts aggregates parent + notebooks per table.
export function deleteAllUserData(userId) {
  const counts = {};
  const childIds = listChildNotebookIds(userId);
  const wipeRows = (uid) => {
    for (const t of USER_TABLES) {
      counts[t] = (counts[t] || 0) + num(db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(uid).changes);
    }
    for (const k of userSettingKeys(uid)) db.prepare('DELETE FROM app_settings WHERE key = ?').run(k);
  };
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    wipeRows(userId);
    for (const cid of childIds) {
      wipeRows(cid);
      db.prepare('DELETE FROM users WHERE id = ? AND parent_user_id = ?').run(cid, userId);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  return counts;
}

export function insertMessage({ userId, channel = 'web', text, role = 'user', raw = null, receivedAt = Date.now() }) {
  const info = db.prepare(
    'INSERT INTO messages (user_id, channel, text, role, raw_json, received_at) VALUES (?,?,?,?,?,?)',
  ).run(userId, channel, text, role, raw ? JSON.stringify(raw) : null, receivedAt);
  emitUserEvent(userId, 'chat'); // poke /api/stream subscribers — this insert is what /api/chat/new serves
  return num(info.lastInsertRowid);
}

// Merge Fanad's decided reaction (🫡 / ✍ / a mood emoji) into the USER message row's raw_json so
// scroll-back can replay it — Telegram persists reactions on its own servers; the web needs this.
export function setMessageReaction(userId, messageId, reaction) {
  const row = db.prepare('SELECT raw_json FROM messages WHERE id = ? AND user_id = ?').get(messageId, userId);
  if (!row) return false;
  let j = {};
  try { j = row.raw_json ? JSON.parse(row.raw_json) : {}; } catch { /* corrupt json — start fresh */ }
  j.reaction = reaction;
  db.prepare('UPDATE messages SET raw_json = ? WHERE id = ? AND user_id = ?')
    .run(JSON.stringify(j), messageId, userId);
  return true;
}

// One page of chat history for the web UI's backward scroll. Keyset on the monotonic id (received_at
// isn't unique — paging on it can skip/duplicate rows at ms ties). Returns NEWEST-first; the caller
// reverses to prepend a contiguous oldest→newest block. `channel` scopes the transcript (so root's web
// history never pulls in a user's Telegram turns — both share this table); pass `channel: null` to show
// ALL channels, which the web does when impersonating another user (a Telegram account has only
// 'telegram' turns, so a channel='web' filter would hide their whole conversation). `beforeId` null = the
// most recent page.
export function listMessagesBefore(userId, { channel = 'web', beforeId = null, limit = 30 } = {}) {
  const lim = Math.max(1, Math.min(Number(limit) || 30, 100));
  const conds = ['user_id = ?'];
  const params = [userId];
  if (channel != null) { conds.push('channel = ?'); params.push(channel); }
  if (beforeId != null) { conds.push('id < ?'); params.push(num(beforeId)); }
  const rows = db.prepare(
    `SELECT id, channel, text, role, raw_json, received_at FROM messages
      WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT ?`,
  ).all(...params, lim);
  return rows.map((r) => ({
    id: num(r.id), channel: r.channel, text: r.text, role: r.role,
    raw_json: r.raw_json, received_at: num(r.received_at),
  }));
}

// Messages NEWER than `afterId` — the forward cursor the live web UI polls so turns that arrive
// asynchronously (e.g. from Telegram while impersonating that user) appear without a refresh. Same channel
// scoping as listMessagesBefore (null = all channels). Returns OLDEST-first so the client appends in order.
export function listMessagesAfter(userId, { channel = 'web', afterId = 0, limit = 100 } = {}) {
  const lim = Math.max(1, Math.min(Number(limit) || 100, 200));
  const conds = ['user_id = ?', 'id > ?'];
  const params = [userId, num(afterId) || 0];
  if (channel != null) { conds.push('channel = ?'); params.push(channel); }
  const rows = db.prepare(
    `SELECT id, channel, text, role, raw_json, received_at FROM messages
      WHERE ${conds.join(' AND ')} ORDER BY id ASC LIMIT ?`,
  ).all(...params, lim);
  return rows.map((r) => ({
    id: num(r.id), channel: r.channel, text: r.text, role: r.role,
    raw_json: r.raw_json, received_at: num(r.received_at),
  }));
}

// Truncate a user's chat history. `olderThanMs` (epoch-ms) keeps newer turns and removes everything older;
// null removes ALL. `channel` scopes the purge (root → 'web'; null → every channel, used when an operator
// is impersonating another user). snapshots/tasks/notes reference messages(id) WITHOUT ON DELETE …, so
// those provenance back-links are nulled first — the snapshots/tasks/notes themselves are KEPT, only the
// chat log is removed. Atomic; returns the number of message rows deleted.
export function clearMessages(userId, { olderThanMs = null, channel = null } = {}) {
  const conds = ['user_id = ?'];
  const params = [userId];
  if (channel != null) { conds.push('channel = ?'); params.push(channel); }
  if (olderThanMs != null) { conds.push('received_at < ?'); params.push(num(olderThanMs)); }
  const where = conds.join(' AND ');
  const doomed = `SELECT id FROM messages WHERE ${where}`; // reused to null references before the delete
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE state_snapshots SET message_id=NULL WHERE user_id=? AND message_id IN (${doomed})`).run(userId, ...params);
    db.prepare(`UPDATE tasks SET source_message_id=NULL WHERE user_id=? AND source_message_id IN (${doomed})`).run(userId, ...params);
    db.prepare(`UPDATE notes SET source_message_id=NULL WHERE user_id=? AND source_message_id IN (${doomed})`).run(userId, ...params);
    const info = db.prepare(`DELETE FROM messages WHERE ${where}`).run(...params);
    db.exec('COMMIT');
    return num(info.changes);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function markMessageProcessed(messageId, at = Date.now()) {
  db.prepare('UPDATE messages SET processed_at = ? WHERE id = ?').run(at, messageId);
}

export function insertSnapshot({
  userId, messageId = null, capturedAt = Date.now(),
  timeOfDay = null, moodEmojis = null, locationText = null, weather = null,
}) {
  const info = db.prepare(
    `INSERT INTO state_snapshots (user_id, message_id, captured_at, time_of_day, mood_emojis, location_text, weather_json)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(userId, messageId, capturedAt, timeOfDay, moodEmojis, locationText, weather ? JSON.stringify(weather) : null);
  return num(info.lastInsertRowid);
}

export function insertTask({
  userId, summary, category = 'other', effortLevel = 'medium', sourceMessageId = null, createdAt = Date.now(),
  createdWeather = null, dueAt = null, dueKind = null,
  originalText = null, llmSummary = null, priority = null, remindAt = null, linkJson = null,
}) {
  const info = db.prepare(
    `INSERT INTO tasks (user_id, summary, category, effort_level, status, source_message_id, created_at, created_hour, created_tod, created_weather, due_at, due_kind, original_text, llm_summary, priority, remind_at, link_json)
     VALUES (?,?,?,?, 'available', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(userId, summary, category, effortLevel, sourceMessageId, createdAt,
        new Date(createdAt).getHours(), timeOfDay(createdAt), createdWeather, dueAt, dueKind,
        originalText, llmSummary, priority, remindAt, linkJson);
  pokeCounts(userId);
  return getTask(userId, num(info.lastInsertRowid));
}

// ── link-preview backfill (linkBackfill.js) ──
// Tasks from before v40 (or captured while LINK_PREVIEW was off) that carry a URL but no stored preview.
// link_json IS NULL is the whole "not done yet" bookkeeping: even a failed fetch writes a record, so the
// sweep is self-terminating. The LIKE is a cheap prefilter; the caller re-checks with the real URL regex.
export function listTasksNeedingLinkBackfill() {
  return db.prepare(
    `SELECT * FROM tasks WHERE link_json IS NULL AND status != 'archived'
       AND (original_text LIKE '%http://%' OR original_text LIKE '%https://%'
            OR summary LIKE '%http://%' OR summary LIKE '%https://%')
     ORDER BY id`,
  ).all();
}

export function setTaskLink(userId, id, linkJson, summary = null) {
  if (summary != null) {
    db.prepare('UPDATE tasks SET link_json = ?, summary = ? WHERE id = ? AND user_id = ?').run(linkJson, summary, id, userId);
  } else {
    db.prepare('UPDATE tasks SET link_json = ? WHERE id = ? AND user_id = ?').run(linkJson, id, userId);
  }
  pokeCounts(userId);
  return getTask(userId, id);
}

export function getTask(userId, id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, userId) || null;
}

export function listTasks(userId) {
  return db.prepare(
    "SELECT * FROM tasks WHERE user_id = ? AND status != 'archived' ORDER BY created_at DESC",
  ).all(userId);
}

// Move every task in one category to another — the data half of "/remcat". GLOBAL across users (a category
// is a shared definition, so retiring it must leave no row pointing at the dead key). Returns rows moved.
export function reassignTaskCategory(fromKey, toKey) {
  return num(db.prepare('UPDATE tasks SET category = ? WHERE category = ?').run(toKey, fromKey).changes);
}

const VALID_STATUS = new Set(['available', 'in_progress', 'done', 'snoozed', 'archived', 'expired']);

// ONE task in progress at a time: starting a task quietly returns any other in_progress sibling to
// 'available'. started_at is NULLed so a later restart stamps a FRESH time (setTaskStatus COALESCEs it) —
// otherwise the "most recently started" ordering (startedTask) would trust a stale timestamp. Returns the
// paused rows so chat can name them in the reply.
export function pauseOtherStarted(userId, keepTaskId) {
  const paused = db.prepare(
    "SELECT * FROM tasks WHERE user_id = ? AND status = 'in_progress' AND id != ?",
  ).all(userId, keepTaskId);
  if (paused.length) {
    db.prepare(
      "UPDATE tasks SET status = 'available', started_at = NULL WHERE user_id = ? AND status = 'in_progress' AND id != ?",
    ).run(userId, keepTaskId);
  }
  return paused;
}

export function setTaskStatus(userId, taskId, status, at = Date.now()) {
  if (!VALID_STATUS.has(status)) throw new Error(`invalid status: ${status}`);
  const sets = ['status = ?'];
  const params = [status];
  if (status === 'in_progress') { sets.push('started_at = COALESCE(started_at, ?)'); params.push(at); }
  if (status === 'done') { sets.push('completed_at = ?'); params.push(at); }
  // Back to 'available' means "not started, not snoozed" — clear both markers so a later restart stamps a
  // fresh started_at (it's COALESCEd above) and an unsnoozed task doesn't keep a phantom wake timer.
  if (status === 'available') sets.push('started_at = NULL', 'snoozed_until = NULL');
  params.push(taskId, userId);
  return tx(() => {
    // Ownership re-checked in the WHERE clause; 0 rows changed => not found / not yours.
    const info = db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...params);
    if (num(info.changes) === 0) return null;
    // Single-active invariant lives HERE (the one writer of 'in_progress') so every path — typed start,
    // button start, web POST, suggestion-affirm — enforces it without remembering to. After the ownership
    // check above, so a not-found/not-yours start can't pause siblings as a side effect.
    if (status === 'in_progress') pauseOtherStarted(userId, taskId);
    pokeCounts(userId);
    return getTask(userId, taskId);
  });
}

// ── Post-hoc task edits (priority / category / schedule) — the interactive menus relax "set once at
// capture". Each mirrors setTaskStatus: ownership re-checked in the WHERE clause, returns the updated task
// or null on 0 rows changed (not found / not yours). None touch `summary`, so no re-embedding is needed.
export function setTaskPriority(userId, taskId, priority) {
  const p = priority == null ? null : Number(priority);     // null = clear
  if (p != null && ![1, 2, 3].includes(p)) throw new Error(`invalid priority: ${priority}`);
  const info = db.prepare('UPDATE tasks SET priority = ? WHERE id = ? AND user_id = ?').run(p, taskId, userId);
  if (num(info.changes) === 0) return null;
  return getTask(userId, taskId);
}

export function setTaskCategory(userId, taskId, category) {
  if (!CATEGORIES.includes(category)) throw new Error(`invalid category: ${category}`);
  const info = db.prepare('UPDATE tasks SET category = ? WHERE id = ? AND user_id = ?').run(category, taskId, userId);
  if (num(info.changes) === 0) return null;
  return getTask(userId, taskId);
}

// Reschedule: set/clear the deadline (+ optional one-time reminder). Clears expired_at and reminded_at so a
// task past its OLD deadline (or one that already fired its reminder) renders + behaves as freshly dated —
// otherwise taskMarkers() keeps hiding the new ⏳ (see chat.js).
export function setTaskSchedule(userId, taskId, { dueAt = null, dueKind = null, remindAt = null } = {}) {
  const info = db.prepare(
    'UPDATE tasks SET due_at = ?, due_kind = ?, remind_at = ?, reminded_at = NULL, expired_at = NULL WHERE id = ? AND user_id = ?',
  ).run(dueAt, dueKind, remindAt, taskId, userId);
  if (num(info.changes) === 0) return null;
  pokeCounts(userId);
  return getTask(userId, taskId);
}

// Set/clear ONLY the one-time reminder, leaving any deadline (due_at/due_kind/expired_at) untouched — a
// reminder is independent of a deadline. Clears reminded_at so a freshly-set (or already-fired) reminder is
// eligible to fire again. Used by the "🔔 Remind" picker; setTaskSchedule replaces the WHOLE schedule.
export function setTaskReminder(userId, taskId, remindAt = null) {
  const info = db.prepare(
    'UPDATE tasks SET remind_at = ?, reminded_at = NULL WHERE id = ? AND user_id = ?',
  ).run(remindAt, taskId, userId);
  if (num(info.changes) === 0) return null;
  pokeCounts(userId);
  return getTask(userId, taskId);
}

// Hard-delete one task and everything that rode along with its capture (its vector, attached images, any
// outcome rows). The ONE caller is "undo" of a fresh capture — the task should vanish as if never filed,
// which archive can't do (an archived row still counts in exports/metrics). Mirrors deleteNote's shape.
export function deleteTaskCascade(userId, taskId) {
  if (!getTask(userId, taskId)) return false;
  return tx(() => {
    deleteImagesForTask(userId, taskId);
    db.prepare("DELETE FROM embeddings WHERE user_id=? AND owner_type='task' AND owner_id=?").run(userId, taskId);
    db.prepare('DELETE FROM task_outcomes WHERE user_id=? AND task_id=?').run(userId, taskId);
    // Non-cascading FKs point here (notes.promoted_task_id, suggestion_events.task_id) — clear them or the
    // row delete trips FK enforcement. A suggestion about a task that "never happened" carries no signal.
    db.prepare('UPDATE notes SET promoted_task_id=NULL WHERE user_id=? AND promoted_task_id=?').run(userId, taskId);
    db.prepare('DELETE FROM suggestion_events WHERE user_id=? AND task_id=?').run(userId, taskId);
    db.prepare('DELETE FROM tasks WHERE id=? AND user_id=?').run(taskId, userId);
    pokeCounts(userId);
    return true;
  });
}

// A task's stored link preview (migration v40), or null. Mirrors parseSteps: a safe JSON.parse over a
// column only ever written as JSON.stringify output; only a record with an actual URL counts as a link.
export function parseLink(task) {
  if (!task || task.link_json == null) return null;
  try {
    const l = JSON.parse(task.link_json);
    return (l && typeof l.url === 'string' && l.url) ? l : null;
  } catch { return null; }
}

// ── Task STEPS (an ordered checklist stored as JSON on the task itself; migration v16). Array order = the
// order they were added = the order they're shown. Like the edits above, ownership is re-checked in every
// WHERE and addTaskStep doesn't touch `summary`, so no re-embedding is needed. ──
export function parseSteps(task) {
  if (!task || task.steps_json == null) return [];
  try {
    const arr = JSON.parse(task.steps_json);
    return Array.isArray(arr) ? arr.map((s) => ({
      text: String(s.text ?? ''),
      done: !!s.done,
      completed_at: s.completed_at == null ? null : num(s.completed_at),
    })) : [];
  } catch (err) {
    // Shouldn't happen (steps_json is only ever JSON.stringify output), but a corrupt blob read as "no
    // steps" would let the next addTaskStep overwrite — and destroy — the user's checklist. Leave a trace.
    console.error(`corrupt steps_json on task ${task.id} — treating as no steps:`, err.message);
    return [];
  }
}

// Append a step. Returns { task, steps, index } (1-based index of the new step) or null if not found/yours.
export function addTaskStep(userId, taskId, text) {
  const task = getTask(userId, taskId);
  if (!task) return null;
  const steps = parseSteps(task);
  steps.push({ text: String(text || '').trim(), done: false, completed_at: null });
  db.prepare('UPDATE tasks SET steps_json = ? WHERE id = ? AND user_id = ?').run(JSON.stringify(steps), taskId, userId);
  return { task: getTask(userId, taskId), steps, index: steps.length };
}

// Mark steps done/undone. `which` = 'all' | 'next' (first open) | array of 1-based indices. Returns
// { task, steps, changed:[1-based toggled], allDone, total } or null if not found. Idempotent (re-setting a
// step to the state it's already in is a no-op and writes nothing).
export function setStepsDone(userId, taskId, which, done = true, at = Date.now()) {
  const task = getTask(userId, taskId);
  if (!task) return null;
  const steps = parseSteps(task);
  if (!steps.length) return { task, steps, changed: [], allDone: false, total: 0 };
  let targets;
  if (which === 'all') targets = steps.map((_, i) => i);
  else if (which === 'next') { const i = steps.findIndex((s) => !s.done); targets = i === -1 ? [] : [i]; }
  else targets = [...new Set((which || []).map((n) => Number(n) - 1))].filter((i) => i >= 0 && i < steps.length);
  const changed = [];
  for (const i of targets) {
    if (steps[i].done === done) continue;                 // already in the target state → no-op
    steps[i].done = done; steps[i].completed_at = done ? at : null; changed.push(i + 1);
  }
  if (changed.length) db.prepare('UPDATE tasks SET steps_json = ? WHERE id = ? AND user_id = ?').run(JSON.stringify(steps), taskId, userId);
  return { task: getTask(userId, taskId), steps, changed, allDone: steps.every((s) => s.done), total: steps.length };
}

// Remove steps by 1-based index (or 'all'). The surviving steps RE-COMPACT (positions shift down), so callers
// re-render the new numbering — same as a fresh listing. `removed` reports the ORIGINAL positions taken out.
// Emptying the list nulls steps_json so the task is genuinely stepless again (a later "start" won't arm
// stepping). Returns { task, steps, removed:[1-based], total } or null if not found/yours.
export function removeTaskStep(userId, taskId, which) {
  const task = getTask(userId, taskId);
  if (!task) return null;
  const steps = parseSteps(task);
  if (!steps.length) return { task, steps, removed: [], total: 0 };
  const targets = which === 'all'
    ? steps.map((_, i) => i)
    : [...new Set((which || []).map((n) => Number(n) - 1))].filter((i) => i >= 0 && i < steps.length);
  const drop = new Set(targets);
  const removed = targets.map((i) => i + 1).sort((a, b) => a - b);
  const kept = steps.filter((_, i) => !drop.has(i));
  if (removed.length) db.prepare('UPDATE tasks SET steps_json = ? WHERE id = ? AND user_id = ?').run(kept.length ? JSON.stringify(kept) : null, taskId, userId);
  return { task: getTask(userId, taskId), steps: kept, removed, total: kept.length };
}

// ── Task TEMPLATES (migration v17): a saved blueprint of a task — its shape + step checklist — re-created
// on demand by name. Fanad has no recurring tasks by design; a template is the calm alternative. User-scoped
// like everything here; `name` is the user-facing handle, matched case-insensitively (column is NOCASE).
// Stored steps are always RESET (unchecked); deadlines / reminders / priority are intentionally NOT kept. ──
export function getTemplate(userId, name) {
  return db.prepare('SELECT * FROM task_templates WHERE user_id = ? AND name = ?').get(userId, String(name || '').trim()) || null;
}
export function listTemplates(userId) {
  return db.prepare('SELECT * FROM task_templates WHERE user_id = ? ORDER BY created_at').all(userId);
}
export function deleteTemplate(userId, name) {
  return num(db.prepare('DELETE FROM task_templates WHERE user_id = ? AND name = ?').run(userId, String(name || '').trim()).changes) > 0;
}

// Save a task on the user's list as a reusable template, by name. Re-saving an existing name OVERWRITES it
// (UPSERT on the case-insensitive name). Steps are copied RESET (unchecked). Returns
// { template, overwrote, stepCount }, or null if the task isn't found / isn't theirs.
export function saveTemplate(userId, taskId, name) {
  const task = getTask(userId, taskId);
  const clean = String(name || '').trim();
  if (!task || !clean) return null;
  const steps = parseSteps(task).map((s) => ({ text: s.text, done: false, completed_at: null }));
  const stepsJson = steps.length ? JSON.stringify(steps) : null;
  const overwrote = !!getTemplate(userId, clean);
  db.prepare(
    `INSERT INTO task_templates (user_id, name, summary, category, effort_level, original_text, llm_summary, steps_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id, name) DO UPDATE SET
       summary = excluded.summary, category = excluded.category, effort_level = excluded.effort_level,
       original_text = excluded.original_text, llm_summary = excluded.llm_summary, steps_json = excluded.steps_json`,
  ).run(userId, clean, task.summary, task.category, task.effort_level, task.original_text, task.llm_summary, stepsJson, Date.now());
  return { template: getTemplate(userId, clean), overwrote, stepCount: steps.length };
}

// Materialize a template into a fresh, undated task (status 'available'). Copies summary/category/effort +
// the steps (reset) and NOTHING else — no deadline, reminder, or priority. Returns the new task, or null if
// there's no template by that name. The caller embeds it (embedTask) so the copy ranks in suggestions.
export function materializeTemplate(userId, name) {
  const tpl = getTemplate(userId, name);
  if (!tpl) return null;
  const task = insertTask({
    userId, summary: tpl.summary, category: tpl.category, effortLevel: tpl.effort_level,
    originalText: tpl.original_text, llmSummary: tpl.llm_summary,
  });
  for (const s of parseSteps({ steps_json: tpl.steps_json })) addTaskStep(userId, task.id, s.text);
  return getTask(userId, task.id);
}

// Mint a NEW template row from an explicit steps ARRAY (not a task) — the Batches "save this run as a
// version" path. A plain INSERT, never an upsert: callers pass a collision-free name (nextVersionName), so
// there is no existing row to update. Steps are stored RESET (unchecked). `meta` carries the non-null-ish
// columns copied from the source version's row; missing bits fall back to the same defaults the schema uses.
export function createTemplateFromSteps(userId, name, meta = {}, stepsArray = []) {
  const clean = String(name || '').trim();
  const steps = (stepsArray || []).map((s) => ({ text: s.text, done: false, completed_at: null }));
  const stepsJson = steps.length ? JSON.stringify(steps) : null;
  db.prepare(
    `INSERT INTO task_templates (user_id, name, summary, category, effort_level, original_text, llm_summary, steps_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(userId, clean, meta.summary ?? clean, meta.category ?? 'other', meta.effort_level ?? 'medium',
    meta.original_text ?? null, meta.llm_summary ?? null, stepsJson, Date.now());
  return getTemplate(userId, clean);
}

// ── JOURNALS (migration v26): the opt-in trend-journal module. A journal is a named stream of daily
// checklist entries; its checklist is a SNAPSHOT of a task_template's steps (templates are overwritable by
// name with no FKs — a live reference would silently rewrite a journal mid-month; re-running
// `journal template <name>` re-snapshots explicitly). dossier_json is the journal's rolling trend state.
// Everything user-scoped; `name` is the user-facing handle, matched case-insensitively (NOCASE column). ──
export function createJournal(userId, name, createdAt = Date.now()) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  if (getJournal(userId, clean)) return null; // taken (case-insensitive) — caller phrases the reply
  db.prepare('INSERT INTO journals (user_id, name, last_used_at, created_at) VALUES (?,?,?,?)')
    .run(userId, clean, createdAt, createdAt);
  return getJournal(userId, clean);
}
export function getJournal(userId, name) {
  return db.prepare('SELECT * FROM journals WHERE user_id = ? AND name = ?').get(userId, String(name || '').trim()) || null;
}
export function getJournalById(userId, id) {
  return db.prepare('SELECT * FROM journals WHERE id = ? AND user_id = ?').get(id, userId) || null;
}
export function listJournals(userId) {
  return db.prepare('SELECT * FROM journals WHERE user_id = ? ORDER BY created_at').all(userId);
}
export function deleteJournal(userId, name) {
  // FK cascades erase the journal's entries and summaries with it — callers gate this behind a confirm.
  return num(db.prepare('DELETE FROM journals WHERE user_id = ? AND name = ?').run(userId, String(name || '').trim()).changes) > 0;
}
export function touchJournal(userId, id, now = Date.now()) {
  db.prepare('UPDATE journals SET last_used_at = ? WHERE id = ? AND user_id = ?').run(now, id, userId);
}
export function setJournalTemplate(userId, id, templateName, checklistJson) {
  db.prepare('UPDATE journals SET template_name = ?, checklist_json = ? WHERE id = ? AND user_id = ?')
    .run(templateName, checklistJson, id, userId);
  return getJournalById(userId, id);
}
export function saveJournalDossier(userId, id, dossier) {
  db.prepare('UPDATE journals SET dossier_json = ? WHERE id = ? AND user_id = ?')
    .run(JSON.stringify(dossier || {}), id, userId);
}

// Entries: one row per (journal, local day). The checklist is the journal's blueprint copied RESET at
// creation; note is appended-to. Raw entries are only ever read to build the DAY summary (and to show
// today) — week/month rollups read stored day summaries instead.
export function getJournalEntry(userId, journalId, dateKey) {
  return db.prepare('SELECT * FROM journal_entries WHERE user_id = ? AND journal_id = ? AND entry_date = ?')
    .get(userId, journalId, dateKey) || null;
}
export function getJournalEntryById(userId, id) {
  return db.prepare('SELECT * FROM journal_entries WHERE id = ? AND user_id = ?').get(id, userId) || null;
}
export function insertJournalEntry({ userId, journalId, entryDate, checklistJson = null, note = null, createdAt = Date.now() }) {
  const info = db.prepare(
    'INSERT INTO journal_entries (user_id, journal_id, entry_date, checklist_json, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
  ).run(userId, journalId, entryDate, checklistJson, note, createdAt, createdAt);
  return getJournalEntryById(userId, num(info.lastInsertRowid));
}
export function updateEntryChecklist(userId, entryId, checklistJson, now = Date.now()) {
  db.prepare('UPDATE journal_entries SET checklist_json = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(checklistJson, now, entryId, userId);
  return getJournalEntryById(userId, entryId);
}
export function appendEntryNote(userId, entryId, text, now = Date.now()) {
  const row = getJournalEntryById(userId, entryId);
  if (!row) return null;
  const note = row.note ? `${row.note}\n${text}` : String(text);
  db.prepare('UPDATE journal_entries SET note = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(note, now, entryId, userId);
  return getJournalEntryById(userId, entryId);
}
export function listEntriesBetween(userId, journalId, fromKey, toKey) {
  return db.prepare(
    'SELECT * FROM journal_entries WHERE user_id = ? AND journal_id = ? AND entry_date BETWEEN ? AND ? ORDER BY entry_date',
  ).all(userId, journalId, fromKey, toKey);
}

// Summaries: the hierarchical rollup rows. "Row exists" is the idempotency marker for both the lazy path
// and the nightly sweep; UPSERT lets a closed-out period be regenerated deliberately without a delete.
export function getJournalSummary(userId, journalId, period, periodKey) {
  return db.prepare(
    'SELECT * FROM journal_summaries WHERE user_id = ? AND journal_id = ? AND period = ? AND period_key = ?',
  ).get(userId, journalId, period, periodKey) || null;
}
export function saveJournalSummary({ userId, journalId, period, periodKey, summary, stats = null, createdAt = Date.now() }) {
  db.prepare(
    `INSERT INTO journal_summaries (user_id, journal_id, period, period_key, summary, stats_json, created_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(journal_id, period, period_key) DO UPDATE SET
       summary = excluded.summary, stats_json = excluded.stats_json`,
  ).run(userId, journalId, period, periodKey, summary, stats ? JSON.stringify(stats) : null, createdAt);
  return getJournalSummary(userId, journalId, period, periodKey);
}
export function listJournalSummaries(userId, journalId, period, fromKey, toKey) {
  return db.prepare(
    'SELECT * FROM journal_summaries WHERE user_id = ? AND journal_id = ? AND period = ? AND period_key BETWEEN ? AND ? ORDER BY period_key',
  ).all(userId, journalId, period, fromKey, toKey);
}

// Closed-out days still missing their AI day summary — the nightly sweep's worklist. Cross-user by design
// (the scheduler sweeps every user's journals; per-row user_id scoping happens in the per-entry work).
export function entriesMissingDaySummary(beforeKey, limit = 10) {
  return db.prepare(
    `SELECT e.id, e.user_id, e.journal_id, e.entry_date FROM journal_entries e
     LEFT JOIN journal_summaries s ON s.journal_id = e.journal_id AND s.period = 'day' AND s.period_key = e.entry_date
     WHERE s.id IS NULL AND e.entry_date < ? ORDER BY e.entry_date LIMIT ?`,
  ).all(beforeKey, limit);
}

// ── BATCHES (migration v33): the opt-in process-batch module. A batch is one RUN of a process — its
// checklist is a task_template SNAPSHOT copied RESET at open (the journal rule: template_name is
// provenance only). No parent table: the process list derives from DISTINCT name. batch_no is the
// user-facing per-(user,name) sequence; the UNIQUE constraint backstops the MAX+1 allocation
// (better-sqlite3 is synchronous single-writer). Everything user-scoped; name is NOCASE like templates. ──
export function insertBatch({ userId, name, templateName = null, checklistJson = null, openedAt = Date.now() }) {
  const clean = String(name || '').trim();
  const no = db.prepare('SELECT COALESCE(MAX(batch_no), 0) + 1 AS n FROM batches WHERE user_id = ? AND name = ?')
    .get(userId, clean).n;
  const info = db.prepare(
    'INSERT INTO batches (user_id, name, batch_no, template_name, checklist_json, opened_at) VALUES (?,?,?,?,?,?)',
  ).run(userId, clean, no, templateName, checklistJson, openedAt);
  return getBatchById(userId, num(info.lastInsertRowid));
}
export function getBatchById(userId, id) {
  return db.prepare('SELECT * FROM batches WHERE id = ? AND user_id = ?').get(id, userId) || null;
}
// The process list: one row per distinct name with open/total counts, most recently opened first.
export function listBatchNames(userId) {
  return db.prepare(
    `SELECT name, COUNT(*) AS total, SUM(status = 'open') AS open, MAX(opened_at) AS last_opened_at
     FROM batches WHERE user_id = ? GROUP BY name ORDER BY last_opened_at DESC`,
  ).all(userId);
}
export function listBatches(userId, name) {
  return db.prepare('SELECT * FROM batches WHERE user_id = ? AND name = ? ORDER BY batch_no DESC')
    .all(userId, String(name || '').trim());
}
// The batch a bare command means: named → that process's latest open run; bare → the latest-opened open
// run across all processes. NULL when nothing's open.
export function latestOpenBatch(userId, name = null) {
  if (name != null) {
    return db.prepare(
      "SELECT * FROM batches WHERE user_id = ? AND name = ? AND status = 'open' ORDER BY opened_at DESC, batch_no DESC LIMIT 1",
    ).get(userId, String(name).trim()) || null;
  }
  return db.prepare(
    "SELECT * FROM batches WHERE user_id = ? AND status = 'open' ORDER BY opened_at DESC, batch_no DESC LIMIT 1",
  ).get(userId) || null;
}
export function countOpenBatches(userId) {
  return db.prepare("SELECT COUNT(*) AS n FROM batches WHERE user_id = ? AND status = 'open'").get(userId).n;
}
export function updateBatchChecklist(userId, id, checklistJson) {
  db.prepare('UPDATE batches SET checklist_json = ? WHERE id = ? AND user_id = ?').run(checklistJson, id, userId);
  return getBatchById(userId, id);
}
export function closeBatchRow(userId, id, outcome = null, now = Date.now()) {
  db.prepare("UPDATE batches SET status = 'closed', outcome = ?, closed_at = ? WHERE id = ? AND user_id = ? AND status = 'open'")
    .run(outcome, now, id, userId);
  return getBatchById(userId, id);
}
export function deleteBatchesByName(userId, name) {
  // FK cascade erases each batch's log lines with it — callers gate this behind a confirm.
  return num(db.prepare('DELETE FROM batches WHERE user_id = ? AND name = ?').run(userId, String(name || '').trim()).changes);
}
export function insertBatchLogLine(userId, batchId, text, createdAt = Date.now()) {
  const info = db.prepare('INSERT INTO batch_log (user_id, batch_id, text, created_at) VALUES (?,?,?,?)')
    .run(userId, batchId, String(text).trim(), createdAt);
  return db.prepare('SELECT * FROM batch_log WHERE id = ? AND user_id = ?').get(num(info.lastInsertRowid), userId);
}
// Newest-first when limited (the card's "last n lines"), oldest-first otherwise (the full read-back).
export function listBatchLog(userId, batchId, limit = null) {
  if (limit) {
    return db.prepare('SELECT * FROM batch_log WHERE user_id = ? AND batch_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(userId, batchId, limit).reverse();
  }
  return db.prepare('SELECT * FROM batch_log WHERE user_id = ? AND batch_id = ? ORDER BY created_at, id').all(userId, batchId);
}

// ── Batch recipe-version rejection (migration v34): mark a saved template VERSION as pulled from the batch
// lineage so latest-version resolution skips it. Soft + reversible (unreject just deletes the row); the
// template itself is untouched, so materialize/journal still see it. Keyed by the exact version name. ──
export function rejectTemplateVersion(userId, name, now = Date.now()) {
  db.prepare('INSERT OR IGNORE INTO batch_rejects (user_id, template_name, rejected_at) VALUES (?,?,?)')
    .run(userId, String(name || '').trim(), now);
}
export function unrejectTemplateVersion(userId, name) {
  return num(db.prepare('DELETE FROM batch_rejects WHERE user_id = ? AND template_name = ?')
    .run(userId, String(name || '').trim()).changes) > 0;
}
export function rejectedVersionNames(userId) {
  const rows = db.prepare('SELECT template_name FROM batch_rejects WHERE user_id = ?').all(userId);
  return new Set(rows.map((r) => r.template_name.toLowerCase())); // compare case-insensitively
}

// ─────────────────────────── Images (per-user; Telegram-only, by reference) ───────────────────────────
// We don't store photo bytes — Telegram hosts them. The row keeps only the reusable `file_id`, which we
// hand straight back to sendPhoto to re-send the image (no getFile, no re-upload, no disk). task_id is
// nullable and set once the caption has been filed as a task (setImageTask). Everything is user-scoped.
export function insertImage({ userId, taskId = null, fileId, createdAt = Date.now() }) {
  const info = db.prepare(
    'INSERT INTO images (user_id, task_id, file_id, created_at) VALUES (?,?,?,?)',
  ).run(userId, taskId, fileId, createdAt);
  return getImage(userId, num(info.lastInsertRowid));
}
export function getImage(userId, id) {
  return db.prepare('SELECT * FROM images WHERE id=? AND user_id=?').get(id, userId) || null;
}
export function setImageTask(userId, id, taskId) {
  db.prepare('UPDATE images SET task_id=? WHERE id=? AND user_id=?').run(taskId, id, userId);
}
export function setImageNote(userId, id, noteId) {
  db.prepare('UPDATE images SET note_id=? WHERE id=? AND user_id=?').run(noteId, id, userId);
}
// The image to present WITH a task (oldest first — the one captured alongside it).
export function getImageForTask(userId, taskId) {
  if (taskId == null) return null;
  return db.prepare('SELECT * FROM images WHERE user_id=? AND task_id=? ORDER BY created_at LIMIT 1').get(userId, taskId) || null;
}
// The set of THIS user's task ids that have at least one image attached — so a listing can mark the
// photo-bearing rows ("📷 /pic N") in one query instead of a per-row lookup.
export function taskIdsWithImages(userId) {
  if (userId == null) return new Set();
  const rows = db.prepare('SELECT DISTINCT task_id FROM images WHERE user_id=? AND task_id IS NOT NULL').all(userId);
  return new Set(rows.map((r) => r.task_id));
}
// The image attached to a note (a bare, captionless photo lands here — see ingest.js).
export function getImageForNote(userId, noteId) {
  if (noteId == null) return null;
  return db.prepare('SELECT * FROM images WHERE user_id=? AND note_id=? ORDER BY created_at LIMIT 1').get(userId, noteId) || null;
}
export function listImagesForTask(userId, taskId) {
  return db.prepare('SELECT * FROM images WHERE user_id=? AND task_id=? ORDER BY created_at').all(userId, taskId);
}
export function listImagesForNote(userId, noteId) {
  return db.prepare('SELECT * FROM images WHERE user_id=? AND note_id=? ORDER BY created_at').all(userId, noteId);
}
// Delete an owner's image rows. Bytes live on Telegram, not on disk, so there's nothing to unlink — this
// just drops the reference rows. (The FK cascade also removes them on a hard task/note delete; callers use
// this to clear them explicitly before/independently of that.) Returns the count.
export function deleteImagesForTask(userId, taskId) {
  const rows = listImagesForTask(userId, taskId);
  db.prepare('DELETE FROM images WHERE user_id=? AND task_id=?').run(userId, taskId);
  return rows.length;
}
export function deleteImagesForNote(userId, noteId) {
  const rows = listImagesForNote(userId, noteId);
  db.prepare('DELETE FROM images WHERE user_id=? AND note_id=?').run(userId, noteId);
  return rows.length;
}

// ─────────────────────────── Embeddings (RAG, §4) ───────────────────────────
export function insertEmbedding({ userId, ownerType, ownerId, vector, model = null, createdAt = Date.now() }) {
  db.prepare(
    `INSERT OR REPLACE INTO embeddings (user_id, owner_type, owner_id, vector, dim, model, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(userId, ownerType, ownerId, toBlob(vector), vector.length, model, createdAt);
}

// Available tasks with their summary vector attached (LEFT JOIN; vec is null if not yet embedded).
// Excludes auto-slept tasks (slept_at) — a slept task must not be suggested by /whatdo, same as it's
// hidden from every listing (openTasks). Sleeping leaves status='available', so this guard is explicit.
export function listAvailableTasksWithVectors(userId) {
  const rows = db.prepare(
    `SELECT t.*, e.vector AS vec_blob
       FROM tasks t
       LEFT JOIN embeddings e
         ON e.owner_type = 'task' AND e.owner_id = t.id AND e.user_id = t.user_id
      WHERE t.user_id = ? AND t.status = 'available' AND t.slept_at IS NULL
      ORDER BY t.created_at DESC`,
  ).all(userId);
  return rows.map(({ vec_blob, ...task }) => {
    task.vec = vec_blob ? fromBlob(vec_blob) : null;
    return task;
  });
}

// ─────────────────────────── Notes (self-voicemail inbox, §15) ───────────────────────────
export function insertNote({ userId, text, title = null, sourceMessageId = null, snapshotId = null, createdAt = Date.now() }) {
  const info = db.prepare(
    "INSERT INTO notes (user_id, text, title, status, source_message_id, snapshot_id, created_at) VALUES (?,?,?, 'new', ?,?,?)",
  ).run(userId, text, title, sourceMessageId, snapshotId, createdAt);
  return getNote(userId, num(info.lastInsertRowid));
}

export function getNote(userId, id) {
  return db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?').get(id, userId) || null;
}

export function listNotes(userId, { status = null } = {}) {
  if (status) {
    return db.prepare('SELECT * FROM notes WHERE user_id = ? AND status = ? ORDER BY created_at DESC').all(userId, status);
  }
  return db.prepare("SELECT * FROM notes WHERE user_id = ? AND status != 'archived' ORDER BY created_at DESC").all(userId);
}

export function reviewNote(userId, id, { promotedTaskId = null, at = Date.now() } = {}) {
  const info = db.prepare(
    "UPDATE notes SET status='reviewed', reviewed_at=?, promoted_task_id=? WHERE id=? AND user_id=?",
  ).run(at, promotedTaskId, id, userId);
  return num(info.changes) ? getNote(userId, id) : null;
}

// The inverse of a promote's reviewNote: the note returns to the inbox with no promoted-task pointer.
// Used by "undo" after /promote (the promoted task itself is removed via deleteTaskCascade).
export function unpromoteNote(userId, id) {
  const info = db.prepare(
    "UPDATE notes SET status='new', reviewed_at=NULL, promoted_task_id=NULL WHERE id=? AND user_id=?",
  ).run(id, userId);
  return num(info.changes) > 0;
}

export function archiveNote(userId, id) {
  const info = db.prepare("UPDATE notes SET status='archived' WHERE id=? AND user_id=?").run(id, userId);
  return num(info.changes) ? getNote(userId, id) : null;
}

// Edit a note's text/title in place (the web Notes view). Only the fields provided are touched; ownership is
// re-checked in the WHERE clause. The stored embedding is now stale, but recall re-embeds lazily, so we leave
// it — same leniency the data browser's inline edit already relies on. Returns the updated note or null.
export function updateNote(userId, id, { text = undefined, title = undefined } = {}) {
  const sets = [];
  const params = [];
  if (text !== undefined) { sets.push('text = ?'); params.push(String(text)); }
  if (title !== undefined) { sets.push('title = ?'); params.push(title == null ? null : String(title)); }
  if (!sets.length) return getNote(userId, id);
  params.push(id, userId);
  const info = db.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id=? AND user_id=?`).run(...params);
  return num(info.changes) ? getNote(userId, id) : null;
}

export function deleteNote(userId, id) {
  if (!getNote(userId, id)) return false;
  deleteImagesForNote(userId, id); // unlink any attached photo's bytes (FK cascade only removes the rows)
  db.prepare('DELETE FROM notes WHERE id=? AND user_id=?').run(id, userId);
  db.prepare("DELETE FROM embeddings WHERE user_id=? AND owner_type='note' AND owner_id=?").run(userId, id);
  return true;
}

export function listNotesWithVectors(userId) {
  const rows = db.prepare(
    `SELECT n.*, e.vector AS vec_blob
       FROM notes n
       LEFT JOIN embeddings e ON e.owner_type='note' AND e.owner_id=n.id AND e.user_id=n.user_id
      WHERE n.user_id=? AND n.status != 'archived'
      ORDER BY n.created_at DESC`,
  ).all(userId);
  return rows.map(({ vec_blob, ...note }) => { note.vec = vec_blob ? fromBlob(vec_blob) : null; return note; });
}

// ─────────────────────────── Lists (a nestable outliner, db.js v19) ───────────────────────────
// One self-referential tree per user: every row is a "list item"; its children are its sub-items, to
// unlimited depth. `parentId === null` is a top-level list. All reads/writes carry user_id (tenancy), and
// `parent_id IS ?` cleanly matches both the NULL (top-level) and a concrete-parent case in one statement.

export function getListItem(userId, id) {
  return db.prepare('SELECT * FROM list_items WHERE id=? AND user_id=?').get(id, userId) || null;
}

// Children of `parentId` (null = the top-level lists), in sibling order, each carrying a `child_count` so a
// listing can show "(3)" next to an item that itself holds sub-items — the cue that it's a list you can open.
export function listChildren(userId, parentId = null) {
  return db.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM list_items g WHERE g.parent_id = c.id) AS child_count
       FROM list_items c
      WHERE c.user_id = ? AND c.parent_id IS ?
      ORDER BY c.position, c.id`,
  ).all(userId, parentId);
}

export function countListChildren(userId, parentId = null) {
  return num(db.prepare('SELECT COUNT(*) AS n FROM list_items WHERE user_id=? AND parent_id IS ?').get(userId, parentId).n);
}

// Whole-tree item count (every node, all depths) — the /api/ha/summary lists gauge, one query.
export function countAllListItems(userId) {
  return num(db.prepare('SELECT COUNT(*) AS n FROM list_items WHERE user_id=?').get(userId).n);
}

// Append a new item under `parentId` (null = a new top-level list). Position is one past the current max so
// siblings keep insertion order. A given parentId must belong to the user; a forged/foreign parent yields no
// rows from the max-position probe and would orphan the row, so callers resolve the parent via the user first.
export function insertListItem({ userId, parentId = null, title, createdAt = Date.now() }) {
  const row = db.prepare('SELECT COALESCE(MAX(position), -1) AS mx FROM list_items WHERE user_id=? AND parent_id IS ?').get(userId, parentId);
  const position = num(row.mx) + 1;
  const info = db.prepare(
    'INSERT INTO list_items (user_id, parent_id, title, position, created_at) VALUES (?,?,?,?,?)',
  ).run(userId, parentId, title, position, createdAt);
  return getListItem(userId, num(info.lastInsertRowid));
}

export function renameListItem(userId, id, title) {
  const info = db.prepare('UPDATE list_items SET title=? WHERE id=? AND user_id=?').run(title, id, userId);
  return num(info.changes) ? getListItem(userId, id) : null;
}

// Delete an item AND its whole subtree (the self-FK's ON DELETE CASCADE removes descendants). Returns true
// only when a row was actually owned + removed. Run inside foreign_keys=ON (db.js sets it) so the cascade fires.
export function deleteListItem(userId, id) {
  if (!getListItem(userId, id)) return false;
  return num(db.prepare('DELETE FROM list_items WHERE id=? AND user_id=?').run(id, userId).changes) > 0;
}

// The chain of titles from the top-level list down to `nodeId` (inclusive) — the breadcrumb a list view shows.
// Bounded walk up the parent links (guards against any accidental cycle). Empty array for the top level (null).
export function listItemPath(userId, nodeId) {
  const out = [];
  let id = nodeId; let guard = 0;
  while (id != null && guard++ < 64) {
    const row = db.prepare('SELECT id, parent_id, title FROM list_items WHERE id=? AND user_id=?').get(id, userId);
    if (!row) break;
    out.unshift(row.title);
    id = row.parent_id;
  }
  return out;
}

// ─────────────────────────── Summaries (§5) ───────────────────────────
export function listCompletedTasksBetween(userId, start, end) {
  return db.prepare(
    "SELECT * FROM tasks WHERE user_id=? AND status='done' AND completed_at >= ? AND completed_at < ? ORDER BY completed_at DESC",
  ).all(userId, start, end);
}

export function latestSnapshot(userId) {
  return db.prepare('SELECT * FROM state_snapshots WHERE user_id=? ORDER BY captured_at DESC LIMIT 1').get(userId) || null;
}

// The most recently EXPRESSED mood (newest snapshot that actually carried an emoji), within `since`.
// This is what makes a mood persist across later plain messages instead of being wiped by them.
export function latestMood(userId, since = 0) {
  const r = db.prepare(
    `SELECT mood_emojis FROM state_snapshots
       WHERE user_id=? AND mood_emojis IS NOT NULL AND mood_emojis <> '' AND captured_at >= ?
       ORDER BY captured_at DESC LIMIT 1`,
  ).get(userId, since);
  return r?.mood_emojis ?? null;
}

// ─────────────────────────── Metrics (§13) ───────────────────────────
export function getMetric(userId, name) {
  return db.prepare('SELECT * FROM metrics WHERE user_id=? AND name=? COLLATE NOCASE').get(userId, name) || null;
}
export function getOrCreateMetric(
  userId, name, { unit = null, aggregation = 'sum', target = null, measurementType = 'tallied' } = {},
) {
  const existing = getMetric(userId, name);
  if (existing) return existing;
  const info = db.prepare(
    'INSERT INTO metrics (user_id, name, unit, aggregation, target, measurement_type, enabled, created_at) VALUES (?,?,?,?,?,?,1,?)',
  ).run(userId, name, unit, aggregation, target, measurementType, Date.now());
  return db.prepare('SELECT * FROM metrics WHERE id=? AND user_id=?').get(num(info.lastInsertRowid), userId);
}
export function listMetrics(userId) {
  return db.prepare('SELECT * FROM metrics WHERE user_id=? AND enabled=1 ORDER BY created_at').all(userId);
}
export function insertMetricValue({ userId, metricId, value, note = null, entryLabel = null, recordedAt = Date.now() }) {
  const info = db.prepare(
    'INSERT INTO metric_values (user_id, metric_id, value, note, entry_label, recorded_at) VALUES (?,?,?,?,?,?)',
  ).run(userId, metricId, value, note, entryLabel, recordedAt);
  pokeCounts(userId); // metrics + diet calories/weight all land here
  return num(info.lastInsertRowid);
}
export function setMetricTarget(userId, metricId, target) {
  db.prepare('UPDATE metrics SET target=? WHERE id=? AND user_id=?').run(target, metricId, userId);
}
export function metricValuesSince(userId, metricId, since) {
  return db.prepare(
    'SELECT * FROM metric_values WHERE user_id=? AND metric_id=? AND recorded_at>=? ORDER BY recorded_at',
  ).all(userId, metricId, since);
}
// Edit a single logged value (web metrics table / diet log / weight log). Scoped to owner + metric so a
// forged id is a no-op. `recordedAt` lets the weight log re-date an entry (its chart is a time axis).
export function updateMetricValue(userId, metricId, id, { value, note, entryLabel, recordedAt } = {}) {
  const r = db.prepare('SELECT * FROM metric_values WHERE id=? AND user_id=? AND metric_id=?').get(id, userId, metricId);
  if (!r) return null;
  db.prepare('UPDATE metric_values SET value=?, note=?, entry_label=?, recorded_at=? WHERE id=? AND user_id=?')
    .run(value ?? r.value, note === undefined ? r.note : note, entryLabel === undefined ? r.entry_label : entryLabel,
      recordedAt ?? r.recorded_at, id, userId);
  pokeCounts(userId);
  return db.prepare('SELECT * FROM metric_values WHERE id=? AND user_id=?').get(id, userId);
}
// Fetch/delete specific logged values by row id — the undo stack records the exact rows an "eat"/"track"
// wrote, so a later rename (the diet log's inline edit moves entry_label) can't strand the undo.
export function getMetricValuesByIds(userId, ids) {
  if (!ids?.length) return [];
  const marks = ids.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM metric_values WHERE user_id=? AND id IN (${marks})`).all(userId, ...ids);
}
export function deleteMetricValuesByIds(userId, ids) {
  if (!ids?.length) return 0;
  const n = num(db.prepare(`DELETE FROM metric_values WHERE user_id=? AND id IN (${ids.map(() => '?').join(',')})`).run(userId, ...ids).changes);
  if (n) pokeCounts(userId);
  return n;
}
export function deleteMetricValue(userId, metricId, id) {
  const hit = db.prepare('DELETE FROM metric_values WHERE id=? AND user_id=? AND metric_id=?').run(id, userId, metricId).changes > 0;
  if (hit) pokeCounts(userId);
  return hit;
}
// Bounded read for the diet report's per-day slices (metricValuesSince has no upper edge).
export function metricValuesBetween(userId, metricId, from, to) {
  return db.prepare(
    'SELECT * FROM metric_values WHERE user_id=? AND metric_id=? AND recorded_at>=? AND recorded_at<? ORDER BY recorded_at',
  ).all(userId, metricId, from, to);
}

// ─────────────────────────── Diet (§13.5) ───────────────────────────
// The canonical food library + recipes behind the Diet module. Names are unique per user (COLLATE NOCASE,
// like journals); plural/singular fallbacks are the caller's job so the SQL stays exact-match.
export function getFood(userId, name) {
  return db.prepare('SELECT * FROM foods WHERE user_id=? AND name=? COLLATE NOCASE').get(userId, name) || null;
}
export function getFoodById(userId, id) {
  return db.prepare('SELECT * FROM foods WHERE id=? AND user_id=?').get(id, userId) || null;
}
export function listFoods(userId) {
  return db.prepare('SELECT * FROM foods WHERE user_id=? ORDER BY name COLLATE NOCASE').all(userId);
}
// Insert-or-update by (user, name): re-confirming a guess or re-adding a food just refreshes its numbers.
// description (what's in a MEAL) uses COALESCE on conflict: a plain-food upsert (which never passes one)
// can't blank a meal's contents, while save-meal's re-save (which always does) replaces them.
export function upsertFood(userId, { name, calPerUnit, unitType = 'ounce', source = 'user', description = null }) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO foods (user_id, name, cal_per_unit, unit_type, source, description, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id, name) DO UPDATE SET cal_per_unit=excluded.cal_per_unit,
       unit_type=excluded.unit_type, source=excluded.source,
       description=COALESCE(excluded.description, foods.description), updated_at=excluded.updated_at`,
  ).run(userId, name, calPerUnit, unitType, source, description, now, now);
  return getFood(userId, name);
}
export function updateFood(userId, id, patch) {
  const cur = getFoodById(userId, id);
  if (!cur) return null;
  db.prepare('UPDATE foods SET name=?, cal_per_unit=?, unit_type=?, source=?, description=?, updated_at=? WHERE id=? AND user_id=?')
    .run(patch.name ?? cur.name, patch.calPerUnit ?? cur.cal_per_unit, patch.unitType ?? cur.unit_type,
      patch.source ?? 'user', patch.description ?? cur.description, Date.now(), id, userId);
  return getFoodById(userId, id);
}
export function deleteFood(userId, id) {
  return num(db.prepare('DELETE FROM foods WHERE id=? AND user_id=?').run(id, userId).changes);
}

export function getRecipe(userId, name) {
  return db.prepare('SELECT * FROM recipes WHERE user_id=? AND name=? COLLATE NOCASE').get(userId, name) || null;
}
export function getRecipeById(userId, id) {
  return db.prepare('SELECT * FROM recipes WHERE id=? AND user_id=?').get(id, userId) || null;
}
export function listRecipes(userId) {
  return db.prepare('SELECT * FROM recipes WHERE user_id=? ORDER BY name COLLATE NOCASE').all(userId);
}
export function createRecipe(userId, name) {
  const now = Date.now();
  const info = db.prepare('INSERT INTO recipes (user_id, name, created_at, updated_at) VALUES (?,?,?,?)')
    .run(userId, name, now, now);
  return getRecipeById(userId, num(info.lastInsertRowid));
}
export function setRecipeCookedWeight(userId, id, oz) {
  db.prepare('UPDATE recipes SET cooked_weight_oz=?, updated_at=? WHERE id=? AND user_id=?')
    .run(oz, Date.now(), id, userId);
  return getRecipeById(userId, id);
}
export function deleteRecipe(userId, id) {
  return num(db.prepare('DELETE FROM recipes WHERE id=? AND user_id=?').run(id, userId).changes);
}
export function addRecipeItem(userId, recipeId, { foodId = null, name, calPerUnit, unitType = 'ounce', quantity }) {
  const info = db.prepare(
    'INSERT INTO recipe_items (user_id, recipe_id, food_id, name, cal_per_unit, unit_type, quantity, created_at) VALUES (?,?,?,?,?,?,?,?)',
  ).run(userId, recipeId, foodId, name, calPerUnit, unitType, quantity, Date.now());
  return num(info.lastInsertRowid);
}
export function listRecipeItems(userId, recipeId) {
  return db.prepare('SELECT * FROM recipe_items WHERE user_id=? AND recipe_id=? ORDER BY id').all(userId, recipeId);
}
export function clearRecipeItems(userId, recipeId) {
  return num(db.prepare('DELETE FROM recipe_items WHERE user_id=? AND recipe_id=?').run(userId, recipeId).changes);
}

// ── "eat whatever" day markers: one row per logical day (day_start = dayStartOf epoch) the user declared
// off the record. Keyed by (user, day_start), so setting is idempotent and clearing just deletes the row.
export function setDietDay(userId, dayStart, kind = 'whatever') {
  db.prepare(
    `INSERT INTO diet_days (user_id, day_start, kind, created_at) VALUES (?,?,?,?)
     ON CONFLICT(user_id, day_start) DO UPDATE SET kind=excluded.kind`,
  ).run(userId, dayStart, kind, Date.now());
  pokeCounts(userId);
}
export function clearDietDay(userId, dayStart) {
  const n = num(db.prepare('DELETE FROM diet_days WHERE user_id=? AND day_start=?').run(userId, dayStart).changes);
  if (n) pokeCounts(userId);
  return n;
}
export function getDietDay(userId, dayStart) {
  return db.prepare('SELECT * FROM diet_days WHERE user_id=? AND day_start=?').get(userId, dayStart) || null;
}
export function listDietDays(userId, since = 0) {
  return db.prepare('SELECT * FROM diet_days WHERE user_id=? AND day_start>=? ORDER BY day_start').all(userId, since);
}

// ─────────────────────────── Task hygiene / refusal grooming (§11) ───────────────────────────
export function updateTaskSummary(userId, id, summary) {
  const info = db.prepare('UPDATE tasks SET summary=? WHERE id=? AND user_id=?').run(summary, id, userId);
  if (num(info.changes)) pokeCounts(userId); // matters when ?titles=1 exposes the active task's summary
  return num(info.changes) ? getTask(userId, id) : null;
}

// Log a surfaced suggestion AND stamp the task's last_suggested_at together so they never drift (§11) —
// one transaction, or a crash between the two would leave the event logged but the task looking
// never-suggested (and it would be re-surfaced).
export function recordSuggestion(userId, { taskId, channel = 'web', source = 'chat', ctx = {}, at = Date.now() }) {
  return tx(() => {
    const info = db.prepare(
      `INSERT INTO suggestion_events
         (user_id, task_id, surfaced_at, channel, source, ctx_hour, ctx_dow, ctx_mood, ctx_energy)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(userId, taskId, at, channel, source, ctx.hour ?? null, ctx.dow ?? null, ctx.mood ?? null, ctx.energy ?? null);
    db.prepare('UPDATE tasks SET last_suggested_at=? WHERE id=? AND user_id=?').run(at, taskId, userId);
    return num(info.lastInsertRowid);
  });
}

export function resolveSuggestion(userId, eventId, outcome, at = Date.now()) {
  db.prepare('UPDATE suggestion_events SET outcome=?, resolved_at=? WHERE id=? AND user_id=? AND outcome IS NULL')
    .run(outcome, at, eventId, userId);
}

export function incrementRefusal(userId, taskId) {
  db.prepare('UPDATE tasks SET refusal_count = refusal_count + 1 WHERE id=? AND user_id=?').run(taskId, userId);
  return getTask(userId, taskId);
}
export function resetRefusal(userId, taskId) {
  db.prepare('UPDATE tasks SET refusal_count = 0 WHERE id=? AND user_id=?').run(taskId, userId);
}
export function setSnoozed(userId, taskId, untilMs) {
  const info = db.prepare("UPDATE tasks SET status='snoozed', snoozed_until=? WHERE id=? AND user_id=?")
    .run(untilMs, taskId, userId);
  if (num(info.changes)) pokeCounts(userId);
  return num(info.changes) ? getTask(userId, taskId) : null;
}
export function setGroomed(userId, taskId, at = Date.now()) {
  db.prepare('UPDATE tasks SET last_groomed_at=? WHERE id=? AND user_id=?').run(at, taskId, userId);
}

export function listSnoozedTasks(userId) {
  return db.prepare(
    "SELECT * FROM tasks WHERE user_id=? AND status='snoozed' ORDER BY snoozed_until ASC",
  ).all(userId);
}
export function countSnoozedTasks(userId) {
  return num(db.prepare(
    "SELECT COUNT(*) c FROM tasks WHERE user_id=? AND status='snoozed'",
  ).get(userId).c);
}

// Pre-retrieval sweep: a snoozed task whose timer elapsed becomes available again (§11.2).
export function sweepSnoozed(userId, now = Date.now()) {
  const n = num(db.prepare(
    `UPDATE tasks SET status='available', snoozed_until=NULL
       WHERE user_id=? AND status='snoozed' AND snoozed_until IS NOT NULL AND snoozed_until <= ?`,
  ).run(userId, now).changes);
  if (n) pokeCounts(userId);
  return n;
}

// Retire any live task whose deadline has passed into the non-judgy terminal status 'expired'.
// Only touches still-actionable tasks (already done/archived/expired ones are left alone). Advanced /task.
export function expireDueTasks(userId, now = Date.now()) {
  const n = num(db.prepare(
    `UPDATE tasks SET status='expired', expired_at=?
       WHERE user_id=? AND due_at IS NOT NULL AND due_at <= ? AND expired_at IS NULL
         AND status IN ('available','in_progress','snoozed')`,
  ).run(now, userId, now).changes);
  if (n) pokeCounts(userId);
  return n;
}

// ─────────────────────────── Auto-sleep (anti-overwhelm) ───────────────────────────
// Put long-untouched, low-stakes tasks to "sleep" so the list stays scannable. Conservative on purpose —
// never sleeps something in progress, with a live deadline, or marked high priority. Stays status
// 'available' (slept_at is the marker), so it's a one-column UPDATE and openTasks() filters it out.
const SLEEP_AFTER_MS = 21 * 86400000; // ~3 weeks untouched
export function sleepStaleTasks(userId, now = Date.now(), afterMs = SLEEP_AFTER_MS) {
  const n = num(db.prepare(
    `UPDATE tasks SET slept_at=?
       WHERE user_id=? AND status='available' AND slept_at IS NULL AND started_at IS NULL
         AND created_at < ? AND (due_at IS NULL OR due_at < ?) AND (priority IS NULL OR priority <= 1)`,
  ).run(now, userId, now - afterMs, now).changes);
  if (n) pokeCounts(userId);
  return n;
}
export function listSleptTasks(userId) {
  return db.prepare(
    "SELECT * FROM tasks WHERE user_id=? AND slept_at IS NOT NULL AND status='available' ORDER BY slept_at DESC",
  ).all(userId);
}
export function countSleptTasks(userId) {
  return num(db.prepare(
    "SELECT COUNT(*) c FROM tasks WHERE user_id=? AND slept_at IS NOT NULL AND status='available'",
  ).get(userId).c);
}
// Revive slept tasks: clear slept_at and reset last_suggested_at so they can resurface in /whatdo.
export function wakeTasks(userId, ids = []) {
  if (!ids.length) return 0;
  const ph = ids.map(() => '?').join(',');
  const n = num(db.prepare(
    `UPDATE tasks SET slept_at=NULL, last_suggested_at=NULL
       WHERE user_id=? AND slept_at IS NOT NULL AND id IN (${ph})`,
  ).run(userId, ...ids).changes);
  if (n) pokeCounts(userId);
  return n;
}

// ─────────────────────────── Wake-up check-ins (§10) ───────────────────────────
export function insertSchedule(userId, minuteOfDay, createdAt = Date.now()) {
  const info = db.prepare(
    'INSERT INTO schedules (user_id, minute_of_day, enabled, created_at) VALUES (?,?,1,?)',
  ).run(userId, minuteOfDay, createdAt);
  return db.prepare('SELECT * FROM schedules WHERE id=? AND user_id=?').get(num(info.lastInsertRowid), userId);
}
export function listSchedules(userId) {
  return db.prepare('SELECT * FROM schedules WHERE user_id=? ORDER BY minute_of_day').all(userId);
}
export function deleteSchedule(userId, id) {
  return num(db.prepare('DELETE FROM schedules WHERE id=? AND user_id=?').run(id, userId).changes) > 0;
}
// Enabled schedules due at this local minute that haven't already fired today.
export function dueSchedules(userId, minuteOfDay, day) {
  return db.prepare(
    `SELECT * FROM schedules
      WHERE user_id=? AND enabled=1 AND minute_of_day=? AND (last_fired_day IS NULL OR last_fired_day <> ?)`,
  ).all(userId, minuteOfDay, day);
}
// Same, but across ALL users — the scheduler doesn't know who owns a schedule (web=root, Telegram=per
// account). The owner's telegram_id rides along so the nudge can be pushed to that 1:1 chat (chat id == id).
// A schedule made INSIDE a notebook belongs to a sub-user (no channel id of its own), so we COALESCE to the
// notebook's OWNER (parent_user_id) — the person is still reached on their own channel, and this is that
// notebook's genuine owner, not a fallback to some unrelated claimed owner (the cross-user isolation rule).
// A RETIRED notebook's schedules stay quiet (u.retired_at check — hidden means silent too); recovery makes
// them fire again. Same clause in allDueReminders / allDueTimers below.
export function allDueSchedules(minuteOfDay, day) {
  return db.prepare(
    `SELECT s.*, COALESCE(u.telegram_id, p.telegram_id) AS telegram_id, COALESCE(u.slack_id, p.slack_id) AS slack_id
       FROM schedules s JOIN users u ON u.id = s.user_id
       LEFT JOIN users p ON p.id = u.parent_user_id
      WHERE s.enabled=1 AND s.minute_of_day=? AND (s.last_fired_day IS NULL OR s.last_fired_day <> ?)
        AND u.retired_at IS NULL`,
  ).all(minuteOfDay, day);
}
export function markScheduleFired(userId, id, day) {
  db.prepare('UPDATE schedules SET last_fired_day=? WHERE id=? AND user_id=?').run(day, id, userId);
}

// Backfill a snapshot's mood when the LLM inferred a feeling the deterministic word-list missed (fuzzy
// fallback for "running on fumes" etc.). Only the capture path calls this, right after classify().
export function setSnapshotMood(userId, snapshotId, emojis) {
  if (!emojis || snapshotId == null) return;
  db.prepare('UPDATE state_snapshots SET mood_emojis=? WHERE id=? AND user_id=?').run(emojis, snapshotId, userId);
}

// One-time per-task reminders (the "on <when>" wake). Due = remind_at has passed, not yet fired, and the
// task is still live (a just-expired 'on'-task still nudges once — done/archived don't). telegram_id rides
// along so the scheduler can push to the owner's 1:1 chat, mirroring allDueSchedules.
export function allDueReminders(now = Date.now()) {
  return db.prepare(
    `SELECT t.*, COALESCE(u.telegram_id, p.telegram_id) AS telegram_id, COALESCE(u.slack_id, p.slack_id) AS slack_id
       FROM tasks t JOIN users u ON u.id = t.user_id
       LEFT JOIN users p ON p.id = u.parent_user_id
      WHERE t.remind_at IS NOT NULL AND t.reminded_at IS NULL AND t.remind_at <= ?
        AND t.status NOT IN ('done','archived') AND u.retired_at IS NULL`,
  ).all(now);
}
export function markReminded(taskId, at = Date.now()) {
  db.prepare('UPDATE tasks SET reminded_at=? WHERE id=?').run(at, taskId);
}
// Stamp a reminder fired AND queue its web nudge atomically. Once reminded_at is set the reminder never
// fires again, so the wakeup row is its only trace — a crash between the two would swallow it silently.
export function markRemindedAndQueue(taskId, userId, text, at = Date.now()) {
  tx(() => { markReminded(taskId, at); insertWakeupMirroredToOwner(userId, text, at); });
}
// Upcoming (not-yet-due) reminders for ONE user, soonest first — display only (the web sidebar), never
// delivery: allDueReminders above owns firing, and nothing here stamps reminded_at.
export function pendingReminders(userId, now = Date.now()) {
  return db.prepare(
    `SELECT id, summary, remind_at FROM tasks
      WHERE user_id=? AND remind_at IS NOT NULL AND reminded_at IS NULL AND remind_at > ?
        AND status NOT IN ('done','archived') ORDER BY remind_at`,
  ).all(userId, now);
}

// ── Timers (the opt-in Timer module, chat.js): a one-shot "ding me in N minutes". Not a task — nothing
// lands on any list; the scheduler just rings once (fireDueTimers) and the row retires. ──
export function insertTimer(userId, { label = null, durationMs, fireAt, createdAt = Date.now() }) {
  const info = db.prepare('INSERT INTO timers (user_id, label, duration_ms, fire_at, created_at) VALUES (?,?,?,?,?)')
    .run(userId, label, durationMs, fireAt, createdAt);
  pokeCounts(userId);
  return getTimer(userId, num(info.lastInsertRowid));
}
export function getTimer(userId, id) {
  return db.prepare('SELECT * FROM timers WHERE user_id = ? AND id = ?').get(userId, id) || null;
}
// The still-running timers, soonest first — the order the "timer" listing shows and "timer off N" counts by.
export function activeTimers(userId) {
  return db.prepare('SELECT * FROM timers WHERE user_id = ? AND fired_at IS NULL AND canceled_at IS NULL ORDER BY fire_at, id').all(userId);
}
// Soft-cancel (stamped, row kept). Only a still-pending timer cancels; returns whether one did.
export function cancelTimer(userId, id, at = Date.now()) {
  const hit = num(db.prepare('UPDATE timers SET canceled_at = ? WHERE user_id = ? AND id = ? AND fired_at IS NULL AND canceled_at IS NULL')
    .run(at, userId, id).changes) > 0;
  if (hit) pokeCounts(userId);
  return hit;
}
// Every due, un-fired timer across all users — same delivery join as allDueReminders: the owner's own
// channel ids, with a notebook sub-user falling back to its parent's (sub-users carry no channel identity).
export function allDueTimers(now = Date.now()) {
  return db.prepare(
    `SELECT tm.*, COALESCE(u.telegram_id, p.telegram_id) AS telegram_id, COALESCE(u.slack_id, p.slack_id) AS slack_id
       FROM timers tm JOIN users u ON u.id = tm.user_id
       LEFT JOIN users p ON p.id = u.parent_user_id
      WHERE tm.fired_at IS NULL AND tm.canceled_at IS NULL AND tm.fire_at <= ? AND u.retired_at IS NULL`,
  ).all(now);
}
export function markTimerFired(timerId, at = Date.now()) {
  db.prepare('UPDATE timers SET fired_at = ? WHERE id = ?').run(at, timerId);
}
// Same invariant as markRemindedAndQueue: a fired one-shot timer must at least be in the web queue.
export function markTimerFiredAndQueue(timerId, userId, text, at = Date.now()) {
  tx(() => { markTimerFired(timerId, at); insertWakeupMirroredToOwner(userId, text, at); });
  pokeCounts(userId); // the timer count/next-fire changed too, not just the wakeup queue
}

export function insertWakeup(userId, text, createdAt = Date.now()) {
  const info = db.prepare('INSERT INTO wakeups (user_id, text, created_at) VALUES (?,?,?)').run(userId, text, createdAt);
  // Poke /api/stream. The owner mirror (insertWakeupMirroredToOwner) funnels through here for BOTH its
  // rows, so root's copy pokes root's stream without any extra wiring.
  emitUserEvent(userId, 'wakeup');
  return num(info.lastInsertRowid);
}
// Which ACCOUNT answers for this user id: a notebook sub-user answers as its parent (notebooks don't
// nest), everyone else as themselves. isOwner() is an account-level fact, never a per-notebook one.
export function accountIdFor(userId) {
  const nb = getNotebook(userId);
  return nb ? nb.parent_user_id : Number(userId);
}
// Queue a proactive nudge under its owning user AND — the owner-mirror EXCEPTION to the cross-user
// isolation invariant — copy it into root's web queue when the owning account is the deployment owner's
// claimed Telegram/Slack account. The owner's two faces (web root and their platform account) are one
// person, so their timers/reminders/nudges must reach the web UI too. Non-owner (vouched) users NEVER
// mirror, and a root-owned event never double-inserts (acct === root). Known duplicate edge, accepted:
// a web session IMPERSONATING the owner's platform row drains that row's copy, and the root copy still
// shows once the session acts as root again — two transient bubbles for one event, harmless.
export function insertWakeupMirroredToOwner(userId, text, at = Date.now()) {
  insertWakeup(userId, text, at);
  const acct = accountIdFor(userId);
  if (acct !== ROOT_USER_ID && isOwner(acct)) insertWakeup(ROOT_USER_ID, text, at);
}
export function listUnseenWakeups(userId) {
  return db.prepare('SELECT * FROM wakeups WHERE user_id=? AND seen_at IS NULL ORDER BY created_at').all(userId);
}
export function markWakeupsSeen(userId, at = Date.now()) {
  db.prepare('UPDATE wakeups SET seen_at=? WHERE user_id=? AND seen_at IS NULL').run(at, userId);
}

// ─────────────────────────── Outcome ledger (learning, §11) ───────────────────────────
export function insertTaskOutcome({
  userId, taskId = null, category, outcome, sentiment = null,
  ctxPhase = null, ctxHour = null, ctxDow = null, ctxWeather = null, ctxMood = null, ctxEnergy = null, at = Date.now(),
}) {
  const info = db.prepare(
    `INSERT INTO task_outcomes (user_id, task_id, category, outcome, sentiment, ctx_phase, ctx_hour, ctx_dow, ctx_weather, ctx_mood, ctx_energy, at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(userId, taskId, category, outcome, sentiment, ctxPhase, ctxHour, ctxDow, ctxWeather, ctxMood, ctxEnergy, at);
  return num(info.lastInsertRowid);
}
export function updateOutcomeSentiment(userId, id, sentiment) {
  db.prepare('UPDATE task_outcomes SET sentiment=? WHERE id=? AND user_id=?').run(sentiment, id, userId);
}
// Remove one ledger row — "undo" takes the outcome a done/drop/snooze just recorded back OUT of the
// learning signal, so an accidental tap doesn't teach the recommender anything.
export function deleteTaskOutcome(userId, id) {
  return num(db.prepare('DELETE FROM task_outcomes WHERE id=? AND user_id=?').run(id, userId).changes) > 0;
}
// Counts of each outcome/sentiment for a category in this day-part (phase) — the raw learning signal.
export function outcomeStats(userId, category, ctxPhase = null) {
  return db.prepare(
    `SELECT outcome, sentiment, COUNT(*) AS n FROM task_outcomes
      WHERE user_id=? AND category=? AND (? IS NULL OR ctx_phase=?)
      GROUP BY outcome, sentiment`,
  ).all(userId, category, ctxPhase, ctxPhase);
}

// §11.4 context_refusal_affinity: how often THIS task was refused in a similar hour/energy bucket.
export function refusalRateHere(userId, taskId, { hour = null, energy = null } = {}) {
  const r = db.prepare(
    `SELECT SUM(CASE WHEN outcome='refused' THEN 1 ELSE 0 END) * 1.0 / NULLIF(COUNT(*),0) AS rate,
            COUNT(*) AS n
       FROM suggestion_events
      WHERE user_id=? AND task_id=? AND outcome IS NOT NULL
        AND (? IS NULL OR ctx_hour IS NULL OR ABS(ctx_hour - ?) <= 2)
        AND (? IS NULL OR ctx_energy IS NULL OR ctx_energy = ?)`,
  ).get(userId, taskId, hour, hour, energy, energy);
  return { rate: r?.rate ?? 0, n: num(r?.n ?? 0) };
}

// ─────────────────────────── Undo stack (db.js v38) ───────────────────────────
// A per-user LIFO of the bot's recent undoable actions. Each row carries the `kind` + parsed payload
// server/undo.js needs to invert it, and the exact `message` printed on a successful undo. Rows are
// consumed on pop; the stack is capped and age-pruned at push time so it only ever holds "recent".
const UNDO_STACK_CAP = 20;
const UNDO_TTL_MS = 24 * 3600000; // a day — past that, "undo" reverting it is a surprise, not a favor

export function pushUndo(userId, { kind, payload = {}, message, at = Date.now() }) {
  return tx(() => {
    db.prepare('INSERT INTO undo_stack (user_id, kind, payload_json, message, created_at) VALUES (?,?,?,?,?)')
      .run(userId, String(kind), JSON.stringify(payload), String(message), at);
    db.prepare('DELETE FROM undo_stack WHERE user_id=? AND created_at < ?').run(userId, at - UNDO_TTL_MS);
    db.prepare(
      'DELETE FROM undo_stack WHERE user_id=? AND id NOT IN (SELECT id FROM undo_stack WHERE user_id=? ORDER BY id DESC LIMIT ?)',
    ).run(userId, userId, UNDO_STACK_CAP);
  });
}

// Remove + return the newest still-fresh entry (payload parsed), or null when the stack is empty.
export function popUndo(userId, now = Date.now()) {
  return tx(() => {
    db.prepare('DELETE FROM undo_stack WHERE user_id=? AND created_at < ?').run(userId, now - UNDO_TTL_MS);
    const row = db.prepare('SELECT * FROM undo_stack WHERE user_id=? ORDER BY id DESC LIMIT 1').get(userId);
    if (!row) return null;
    db.prepare('DELETE FROM undo_stack WHERE id=? AND user_id=?').run(row.id, userId);
    let payload = {};
    try { payload = JSON.parse(row.payload_json) || {}; } catch { /* a corrupt row still pops cleanly */ }
    return { id: num(row.id), kind: row.kind, payload, message: row.message, createdAt: num(row.created_at) };
  });
}
