// Web login (auth §9 — the index.js TODO): passwords, TOTP 2FA, sessions, and the request gates. This is
// the ONE module that knows how credentials are hashed, how 2FA is proven, and what a session cookie means.
// The mode switch itself (none|simple) lives in settings.js (getAuthConfig); the row storage in repo.js.
//
// Design notes:
//  · Passwords: node:crypto scrypt (built-in — no native-build deps), per-user 16-byte salt, constant-time
//    compare. The stored string is self-describing ('scrypt:N:r:p:saltB64:hashB64') so params can evolve.
//  · TOTP: otplib (RFC 6238), ±1 step window. The secret is KEK-encrypted at rest (crypto.js). An
//    UNVERIFIED enrollment is parked in app_settings under totp_pending:<id> and only promoted onto the
//    users row once a live code matches — so a working 2FA is never destroyed by an abandoned re-enroll,
//    and a password alone can never swap in a fresh authenticator on a verified account.
//  · Sessions: hand-rolled, DB-backed (web_sessions). The cookie carries a random 32-byte token; the DB
//    stores only its SHA-256, so a DB leak can't replay live cookies. 30-day sliding expiry, renewed at
//    most hourly (the web polls every 5s — don't write per tick). state 'pending_totp' bridges
//    register/login-with-password → finish-2FA; the API gate only honors 'active'.
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { generateSecret, generateURI, verify as verifyOtp } from 'otplib';
import QRCode from 'qrcode';
import { db } from './db.js';
import { config } from './config.js';
import { encryptSecret, decryptSecret } from './crypto.js';
import { getAuthConfig, setAuthConfig, getSetting, setSetting, getGuardConfig } from './settings.js';
import { ROOT_USER_ID, getAuthRow, setUserTotpVerified, userExists, isNotebook } from './repo.js';

const scryptAsync = promisify(scrypt);

// ── Passwords (scrypt) ──
const SCRYPT_N = 32768; // 2^15 — interactive-login cost (~30–80ms); N·r·128 = 32MB, so raise maxmem with it
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 32;
const MAXMEM = 128 * 1024 * 1024;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(String(password), salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAXMEM });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('base64')}:${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [tag, N, r, p, saltB64, hashB64] = String(stored || '').split(':');
    if (tag !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expect = Buffer.from(hashB64, 'base64');
    if (!salt.length || !expect.length) return false;
    const got = await scryptAsync(String(password), salt, expect.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: MAXMEM });
    return timingSafeEqual(got, expect);
  } catch {
    return false; // malformed stored value / bad params — never throw into a login path
  }
}

// A real hash to verify against when the USERNAME doesn't exist, so "unknown user" and "wrong password"
// burn the same scrypt time — no timing oracle on which usernames are taken. Built lazily once.
let dummyHashP = null;
export function dummyPasswordHash() {
  if (!dummyHashP) dummyHashP = hashPassword(randomBytes(16).toString('hex'));
  return dummyHashP;
}

// ── TOTP (otplib v13 functional API; secret KEK-encrypted at rest) ──
const TOTP_TOLERANCE_S = 30; // ± seconds of clock drift accepted (one step each way — standard 2FA)

const totpPendingKey = (userId) => `totp_pending:${userId}`;
const normCode = (code) => String(code || '').replace(/[\s-]+/g, '');

// A live 6-digit code against a base32 secret. otplib's verify uses constant-time compare; any throw
// (guardrails on a malformed token) reads as a plain mismatch — never an exception in a login path.
async function codeMatches(secret, code) {
  const token = normCode(code);
  if (!secret || !/^\d{6}$/.test(token)) return false;
  try { return (await verifyOtp({ secret, token, epochTolerance: TOTP_TOLERANCE_S })).valid === true; }
  catch { return false; }
}

// Start (or restart) an enrollment: mint a fresh secret, park it PENDING, hand back the otpauth URI + a
// QR data-URL for the client to render. Nothing on the users row changes until a code proves the scan.
export async function beginTotpEnrollment(userId, label) {
  const secret = generateSecret();
  setSetting(totpPendingKey(userId), encryptSecret(secret));
  const otpauthUri = generateURI({ issuer: 'Fanad', label: String(label || 'user'), secret });
  const qrDataUrl = await QRCode.toDataURL(otpauthUri, { margin: 1, width: 240 });
  return { otpauthUri, qrDataUrl };
}

export function totpEnrollmentPending(userId) {
  return getSetting(totpPendingKey(userId), null) != null;
}

// Prove the pending enrollment with a live code → promote the secret onto the users row (verified) and
// clear the parking spot. False when there's no pending secret, it can't decrypt, or the code is wrong.
export async function verifyTotpEnrollment(userId, code) {
  const enc = getSetting(totpPendingKey(userId), null);
  const secret = enc ? decryptSecret(enc) : null;
  if (!(await codeMatches(secret, code))) return false;
  setUserTotpVerified(userId, encryptSecret(secret));
  setSetting(totpPendingKey(userId), null);
  return true;
}

// Check a login code against the user's VERIFIED secret. A null decrypt (lost KEK) reads as a wrong code —
// recovery is the AUTH_RESET break-glass, the same blast radius as every other encrypted secret.
export async function checkTotp(userId, code) {
  const row = getAuthRow(userId);
  const secret = row?.totp_secret ? decryptSecret(row.totp_secret) : null;
  return codeMatches(secret, code);
}

// ── Sessions (DB-backed; the cookie holds the raw token, the DB only its hash) ──
const SESSION_TTL_MS = 30 * 86400000;  // 30 days, sliding
const RENEW_AFTER_MS = 3600000;        // bump the window at most hourly (web polls every 5s)
const COOKIE_NAME = 'fanad_session';

const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');

export function createSession(userId, { ip = null, state = 'active' } = {}) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare(
    'INSERT INTO web_sessions (token_hash, user_id, state, created_at, last_seen_at, expires_at, ip) VALUES (?,?,?,?,?,?,?)',
  ).run(hashToken(token), userId, state, now, now, now + SESSION_TTL_MS, ip);
  return token;
}

export function resolveSession(token) {
  if (!token) return null;
  const h = hashToken(token);
  const row = db.prepare('SELECT user_id, state, last_seen_at, expires_at FROM web_sessions WHERE token_hash = ?').get(h);
  if (!row) return null;
  const now = Date.now();
  if (Number(row.expires_at) <= now) {
    db.prepare('DELETE FROM web_sessions WHERE token_hash = ?').run(h);
    return null;
  }
  if (now - Number(row.last_seen_at) > RENEW_AFTER_MS) {
    db.prepare('UPDATE web_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?').run(now, now + SESSION_TTL_MS, h);
  }
  return { userId: Number(row.user_id), state: row.state, tokenHash: h };
}

export function activateSession(tokenHash) {
  db.prepare("UPDATE web_sessions SET state = 'active' WHERE token_hash = ?").run(tokenHash);
}
export function destroySession(token) {
  if (token) db.prepare('DELETE FROM web_sessions WHERE token_hash = ?').run(hashToken(token));
}
// On a password change: every OTHER session dies (a stolen cookie doesn't survive a password rotation).
export function destroyOtherSessions(userId, keepTokenHash = null) {
  if (keepTokenHash) db.prepare('DELETE FROM web_sessions WHERE user_id = ? AND token_hash <> ?').run(userId, keepTokenHash);
  else db.prepare('DELETE FROM web_sessions WHERE user_id = ?').run(userId);
}

// ── Web-link sign-in tokens (the /web chat command) ──
// A one-time bridge from a PROVEN chat identity (the sender of an authorized Telegram/Slack DM) to a web
// session: the bot mints a short-lived token, the user clicks {siteUrl}/web/<token> (an interstitial
// page — the button's POST is what redeems, so link-preview prefetch can't spend the token), and the
// exchange (routes/auth.js webLinkLoginHandler) sets an ordinary session cookie for that user — no password/TOTP;
// control of the chat account IS the proof, scoped strictly to that account's own data. Held in MEMORY
// only (single-use, 10-minute life): nothing to leak from the DB, nothing to sweep on a schedule; a
// restart between mint and click just means running /web again. Only the token's SHA-256 is kept even
// here, matching the session-store rule. Root is refused a token at mint time (chat.js) — the operator's
// mandatory 2FA must not be bypassable from a chat surface.
export const WEB_LINK_TTL_MS = 10 * 60000;
const webLinkTokens = new Map(); // sha256(token) → { userId, expiresAt }

export function createWebLinkToken(userId) {
  const now = Date.now();
  for (const [h, t] of webLinkTokens) if (t.expiresAt <= now) webLinkTokens.delete(h); // opportunistic sweep
  const token = randomBytes(32).toString('base64url');
  webLinkTokens.set(hashToken(token), { userId: Number(userId), expiresAt: now + WEB_LINK_TTL_MS });
  return token;
}

// Would this token redeem right now? A read-only check for the interstitial GET (routes/auth.js): chat
// apps prefetch links to render previews, so the GET must be repeatable — only the button's POST consumes.
// Same acceptance rules as consumeWebLinkToken below, minus the delete.
export function peekWebLinkToken(token) {
  if (!token) return false;
  const t = webLinkTokens.get(hashToken(String(token)));
  return !!t && t.expiresAt > Date.now() && userExists(t.userId) && !isNotebook(t.userId);
}

// Redeem a clicked link EXACTLY once → the userId to mint a session for, or null (unknown, expired,
// already used, or an account that's gone). Deleted on first sight even when expired, so a spent token
// never lingers; a notebook id can never come back (sessions are only for identity rows — defense in depth,
// the mint side never hands one in).
export function consumeWebLinkToken(token) {
  if (!token) return null;
  const h = hashToken(String(token));
  const t = webLinkTokens.get(h);
  if (t) webLinkTokens.delete(h);
  if (!t || t.expiresAt <= Date.now()) return null;
  if (!userExists(t.userId) || isNotebook(t.userId)) return null;
  return t.userId;
}

// ── CLI claim tokens (the `fanad <server> <token>` terminal client; migration v36) ──
// A long-lived, revocable connector credential — the CLI's whole login flow is "paste the token".
// Same storage rule as sessions (raw token never stored, only its SHA-256) but operator-managed:
// minted by `fanad token` on the server host or the owner's Security panel, labeled, listed, and
// soft-revoked (the row stays for the admin list). The `fnd1_` prefix makes a leaked token
// recognizable/greppable (the ghp_ trick) and leaves room to version the format.
const CLI_TOKEN_PREFIX = 'fnd1_';
export const CLI_TOKEN_DEFAULT_TTL_DAYS = 90;

// Mint for an identity row only — never a notebook (data-space, not an account) or an unknown id; the
// same acceptance rule the session mints enforce. ttlDays 0/null = non-expiring, a deliberate opt-out.
// scope 'read' mints a GET/HEAD-only token (dashboards / the Home Assistant companion);
// 'full' is the terminal client's unchanged default.
export function mintCliToken(userId, { label = null, ttlDays = CLI_TOKEN_DEFAULT_TTL_DAYS, scope = 'full' } = {}) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0 || !userExists(id)) throw new Error(`No such user: ${userId}`);
  if (isNotebook(id)) throw new Error('A notebook cannot hold a CLI token — mint for its owner account.');
  if (scope !== 'full' && scope !== 'read') throw new Error("Token scope must be 'full' or 'read'.");
  const days = Number(ttlDays);
  const now = Date.now();
  const expiresAt = Number.isFinite(days) && days > 0 ? now + days * 86400000 : null;
  const token = CLI_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO cli_tokens (token_hash, user_id, label, created_at, expires_at, scope) VALUES (?,?,?,?,?,?)')
    .run(hashToken(token), id, label ? String(label).slice(0, 80) : null, now, expiresAt, scope);
  return token;
}

// Bearer → { userId, tokenHash, scope } | null. Rejects missing/revoked/expired rows AND tokens whose user
// is gone or a notebook (mirrors sessionMiddleware — defense in depth; mint never hands one in). Expired and
// revoked rows are KEPT (unlike expired sessions) so the admin list can show what happened to them.
// last_used_at is bumped at most hourly — the CLI heartbeats like the web, don't write per poll.
export function resolveCliToken(token) {
  if (!token || !String(token).startsWith(CLI_TOKEN_PREFIX)) return null;
  const h = hashToken(String(token));
  const row = db.prepare('SELECT user_id, last_used_at, expires_at, revoked_at, scope FROM cli_tokens WHERE token_hash = ?').get(h);
  if (!row || row.revoked_at != null) return null;
  const now = Date.now();
  if (row.expires_at != null && Number(row.expires_at) <= now) return null;
  const uid = Number(row.user_id);
  if (!userExists(uid) || isNotebook(uid)) return null;
  if (row.last_used_at == null || now - Number(row.last_used_at) > RENEW_AFTER_MS) {
    db.prepare('UPDATE cli_tokens SET last_used_at = ? WHERE token_hash = ?').run(now, h);
  }
  // Anything but the exact 'read' marker acts as full — the pre-scope rows backfilled to 'full' anyway.
  return { userId: uid, tokenHash: h, scope: row.scope === 'read' ? 'read' : 'full' };
}

export function listCliTokens() {
  return db.prepare('SELECT id, user_id, label, created_at, last_used_at, expires_at, revoked_at, scope FROM cli_tokens ORDER BY id').all();
}
export function revokeCliToken(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return false;
  return db.prepare('UPDATE cli_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), n).changes > 0;
}

// Stamp req.cliAuth ({ userId, tokenHash } | null) from the Authorization header. Never rejects — the
// gates decide (same contract as sessionMiddleware). Nothing else inbound uses Authorization, so a
// non-Bearer or unknown value is simply ignored. The whole surface is an owner OPT-IN (default off):
// while cliEnabled is off, even a valid token is not honored — flipping the switch off is an instant
// kill for every outstanding token without revoking any of them.
export function cliTokenMiddleware(req, _res, next) {
  req.cliAuth = null;
  if (!getAuthConfig().cliEnabled) return next();
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers?.authorization || ''));
  if (m) req.cliAuth = resolveCliToken(m[1]);
  next();
}

// ── Cookie helpers (no cookie-parser dep — one cookie, parsed by hand) ──
export function readSessionToken(req) {
  const raw = req.headers?.cookie;
  if (!raw) return null;
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === COOKIE_NAME) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}
export function setSessionCookie(req, res, token) {
  // req.secure needs trust-proxy to see through Coolify; the header check is a harmless belt-and-braces
  // (a client faking it only marks its OWN cookie Secure).
  const secure = req.secure || req.headers?.['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`);
}
export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Stamp req.webSession ({ userId, state, tokenHash } | null) for everything downstream. Never rejects —
// the gates decide. A deleted account's cookie resolves to nothing; a notebook id is never addressable
// (defense in depth — sessions are only ever minted for identity rows).
export function sessionMiddleware(req, _res, next) {
  req.webSession = null;
  req.webSessionToken = null;
  const token = readSessionToken(req);
  if (token) {
    const s = resolveSession(token);
    if (s && userExists(s.userId) && !isNotebook(s.userId)) {
      req.webSession = s;
      req.webSessionToken = token;
    }
  }
  next();
}

// ── Mode + request gates ──
export function authModeIsSimple() {
  return getAuthConfig().mode === 'simple';
}

// The durable "this box runs TOTP-free demo accounts" signal — the demoSignupOpen guard alone. TRUE ⇒ a web
// account may be created and used with NO authenticator (register/login skip the 2FA enrollment step). FALSE
// (the owner ran "demo signup off") ⇒ every TOTP-less non-root account must enroll before continuing. Note
// this is demoSignupOpen ONLY, deliberately NOT `&& !demoPaused`: a transient pause is "back soon" (non-owners
// already get a 503), and must never force-march live demo users into permanent 2FA or lock them out.
export function demoModeOn() {
  return getGuardConfig().demoSignupOpen === true;
}

// The state the request GATES should treat a session as (NOT what sessionMiddleware stamps — that stays the
// raw DB row so the TOTP-enrollment handlers can still see 'active'). A TOTP-less WEB-LOGIN (username/password)
// account's ACTIVE session is honored as 'active' only while demoModeOn(); once demo mode is off it is
// DOWNGRADED to 'needs_totp' WITHOUT touching the DB row — flip demo back on and it's 'active' again, and no
// data is ever destroyed. Non-active states (pending_totp) pass through unchanged. Never downgraded: root; any
// account with a verified authenticator; and a CHAT account bridged to the web via /web (no username — its
// proof is control of the Telegram/Slack account, not a web password, so the demo 2FA rule doesn't apply).
export function effectiveSessionState(webSession) {
  if (!webSession) return null;
  if (webSession.state !== 'active') return webSession.state;
  if (webSession.userId === ROOT_USER_ID) return 'active';
  if (demoModeOn()) return 'active';
  const row = getAuthRow(webSession.userId);
  if (!row?.username) return 'active'; // a /web-bridged chat account — not a web-credential login
  return row.totp_verified_at ? 'active' : 'needs_totp';
}

// Can 'simple' be turned on without locking the operator out? Root needs a username, a password, AND a
// VERIFIED authenticator (2FA is mandatory at login, so an unverified TOTP = guaranteed lockout).
export function rootCredentialsReady() {
  const r = getAuthRow(ROOT_USER_ID);
  return !!(r && r.username && r.password_hash && r.totp_verified_at);
}

// 401 anything on /api without an ACTIVE session while login is on. /api/auth/* and /api/health are
// mounted BEFORE this gate (see index.js) — they're the only API surface a logged-out client needs.
// A valid CLI claim token (req.cliAuth, stamped by cliTokenMiddleware) satisfies the gate too — the
// token IS the CLI's login; resolveCliToken has already vetted revocation/expiry/identity.
// A read-scoped token is GET/HEAD-only in EITHER auth mode: presenting it on a write is a hard 403, never
// a silent fall-through to some other identity — the client chose a read-only credential, honor the choice.
export function apiAuthGate(req, res, next) {
  if (req.cliAuth?.scope === 'read' && req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(403).json({ error: 'This token is read-only.' });
  }
  if (req.cliAuth) return next();
  if (!authModeIsSimple()) return next();
  if (effectiveSessionState(req.webSession) === 'active') return next();
  return res.status(401).json({ error: 'auth required' });
}

// Owner gate for global settings/diagnostics routes. Mode none → no-op (today's single-operator trust
// model, byte-for-byte). Mode simple → strictly the ROOT account (id 1), not isOwner(): a Telegram/Slack
// owner claim must not unlock the web settings surface.
export function requireOwner(req, res, next) {
  if (!authModeIsSimple()) return next();
  if (req.webSession?.state === 'active' && req.webSession.userId === ROOT_USER_ID) return next();
  return res.status(403).json({ error: 'Only the root user can change settings.' });
}

// ── Login rate limiting (in-memory, per username|ip) ──
// Exponential backoff on failures: 2^n seconds, capped at 15 minutes. Success clears the key. The map is
// pruned when it grows past 1000 keys so an enumeration attack can't balloon memory.
const loginFails = new Map(); // key → { count, until }

export function loginBackoffMs(key, now = Date.now()) {
  const f = loginFails.get(key);
  return f ? Math.max(0, f.until - now) : 0;
}
export function noteLoginFailure(key, now = Date.now()) {
  if (loginFails.size > 1000) {
    for (const [k, f] of loginFails) if (f.until <= now) loginFails.delete(k);
  }
  const f = loginFails.get(key) || { count: 0, until: 0 };
  f.count += 1;
  f.until = now + Math.min(2 ** f.count, 900) * 1000;
  loginFails.set(key, f);
}
export function clearLoginFailures(key) {
  loginFails.delete(key);
}

// ── AUTH_RESET break-glass (called once at boot, after migrate()) ──
// Forces the stored mode back to 'none' so a locked-out operator (lost phone, lost KEK) can get back into
// the web UI. Credentials and the verified TOTP are PRESERVED — re-enabling 'simple' from Settings is one
// dropdown away once they're back in. Loud on purpose: while the flag stays set, login can't be re-enabled.
export function applyAuthResetIfRequested() {
  if (!config.auth.reset) return;
  const was = getAuthConfig().mode;
  if (was !== 'none') setAuthConfig({ mode: 'none' });
  console.warn([
    '',
    '!'.repeat(78),
    '!!  AUTH_RESET IS SET — WEB LOGIN FORCED OFF',
    `!!  Stored auth mode ${was === 'none' ? 'was already' : `'${was}' has been reset to`} 'none'. Credentials and 2FA are preserved.`,
    '!!  The web UI is now open to anyone who can reach this server. Log in to',
    '!!  Settings → Security, re-enable login, then UNSET AUTH_RESET and restart.',
    '!'.repeat(78),
    '',
  ].join('\n'));
}
