// /api/auth — the ONLY API surface reachable WITHOUT a session while login is on (mounted before
// apiAuthGate in index.js). Everything a logged-out client needs lives here: status, login, register,
// TOTP enrollment, logout — plus the root account editor (which the Security panel also uses while the
// mode is still 'none', under today's the-web-IS-root trust model).
import { Router } from 'express';
import {
  authModeIsSimple, rootCredentialsReady, demoModeOn, effectiveSessionState,
  hashPassword, verifyPassword, dummyPasswordHash,
  beginTotpEnrollment, verifyTotpEnrollment, totpEnrollmentPending, checkTotp,
  createSession, activateSession, destroySession, destroyOtherSessions,
  setSessionCookie, clearSessionCookie,
  loginBackoffMs, noteLoginFailure, clearLoginFailures,
  consumeWebLinkToken, peekWebLinkToken,
} from '../auth.js';
import { getAuthConfig, getGuardConfig } from '../settings.js';
import { config } from '../config.js';
import { ROOT_USER_ID, getAuthRow, getUserByUsername, createWebUser, countWebAccounts, setUserCredentials } from '../repo.js';
import { normalizeIp } from '../ipGate.js';
import { notifyOwner } from '../notifyOwner.js';
import { createSignupThrottle } from '../signupThrottle.js';

const router = Router();

export const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/i;

// Per-IP abuse controls for the BROWSER demo-register door (its own maps, mirroring routes/demo.js's Telegram
// form): a request-rate throttle (5 / 10 min) and a seat cap (24h rolling; the live limit is guard.demoSignupsPerIp).
// Only consulted while demo mode is on — a private box that merely opened registration is unthrottled as before.
const webRegThrottle = createSignupThrottle({ windowMs: 10 * 60 * 1000, max: 5 });
const webRegSeats = createSignupThrottle({ windowMs: 24 * 60 * 60 * 1000 });

// The root account's setup state — what the Security panel renders. Never carries a hash or secret.
function accountBlock() {
  const r = getAuthRow(ROOT_USER_ID);
  return {
    username: r?.username || '',
    passwordSet: !!r?.password_hash,
    totp: r?.totp_verified_at ? 'verified' : (totpEnrollmentPending(ROOT_USER_ID) ? 'pending' : 'none'),
    totpVerifiedAt: r?.totp_verified_at || null,
  };
}

// ── status: who am I, what does this deployment require? The web boots on this single call. ──
router.get('/status', (req, res) => {
  const cfg = getAuthConfig();
  const simple = cfg.mode === 'simple';
  const s = req.webSession;
  // effectiveSessionState downgrades a TOTP-less demo session to 'needs_totp' once demo mode is off — so the
  // gate's view of "authenticated" and the boot view agree (a downgraded session must land on the login gate).
  const eff = simple ? effectiveSessionState(s) : null;
  const authenticated = !simple || eff === 'active';
  const userId = simple ? (authenticated ? s.userId : null) : ROOT_USER_ID;
  const isOwner = authenticated && userId === ROOT_USER_ID;
  const out = {
    mode: cfg.mode,
    authenticated,
    pendingTotp: simple && s?.state === 'pending_totp',
    // A TOTP-less demo account whose session was downgraded because demo mode is now off → the SPA drops it
    // straight onto 2FA enrollment (Login.jsx). Distinct from pendingTotp (an unfinished registration).
    needsTotp: simple && eff === 'needs_totp',
    // Demo mode on → the register view drops the "2FA required" copy (browser signup is TOTP-free right now).
    demoMode: simple && demoModeOn(),
    userId,
    isOwner,
    allowRegistration: simple && cfg.allowRegistration,
    clientIp: normalizeIp(req.ip), // lets the UI warn before an allowlist save that would lock you out
  };
  if (authenticated && userId != null) out.username = getAuthRow(userId)?.username || null;
  if (isOwner) out.account = accountBlock(); // the Security panel's state (incl. pre-enrollment, mode none)
  res.json(out);
});

// ── login: single-step { username, password, totp } — no partial-auth state to leak through. Errors are
// a generic "wrong" (no username oracle; a miss burns the same scrypt time as a hit — dummyPasswordHash).
// One exception: the right PASSWORD on an account that never finished 2FA (abandoned registration) opens
// a pending_totp session and a fresh QR so the legitimate owner can complete enrollment — at that point
// the password is the account's entire security, exactly as it was mid-registration. ──
router.post('/login', async (req, res) => {
  try {
    if (!authModeIsSimple()) return res.status(400).json({ error: 'Login is not enabled on this server.' });
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const ip = normalizeIp(req.ip);
    const key = `${username.toLowerCase()}|${ip}`;
    const waitMs = loginBackoffMs(key);
    if (waitMs > 0) {
      const s = Math.ceil(waitMs / 1000);
      return res.status(429).json({ error: `Too many attempts — try again in ${s}s.`, retryAfter: s });
    }
    const row = username ? getUserByUsername(username) : null;
    const passOk = row?.password_hash
      ? await verifyPassword(password, row.password_hash)
      : (await verifyPassword(password, await dummyPasswordHash()), false);
    if (!passOk) {
      noteLoginFailure(key);
      return res.status(400).json({ error: 'Wrong username, password, or code.' });
    }
    if (!row.totp_verified_at) {
      clearLoginFailures(key);
      // Demo mode: a TOTP-less demo account logs back in with just its password — no 2FA. (Root is never
      // TOTP-less under mode simple, so the id guard is belt-and-braces.)
      if (demoModeOn() && row.id !== ROOT_USER_ID) {
        const token = createSession(row.id, { ip, state: 'active' });
        setSessionCookie(req, res, token);
        return res.json({ ok: true });
      }
      // Demo off (or root): password proven, 2FA never completed → resume enrollment (fresh secret; the old
      // QR may be lost). This is also how a demo account is force-marched into 2FA once demo mode is off.
      const token = createSession(row.id, { ip, state: 'pending_totp' });
      setSessionCookie(req, res, token);
      const enroll = await beginTotpEnrollment(row.id, row.username);
      return res.json({ ok: false, pendingTotp: true, ...enroll });
    }
    if (!(await checkTotp(row.id, req.body?.totp))) {
      noteLoginFailure(key);
      return res.status(400).json({ error: 'Wrong username, password, or code.' });
    }
    clearLoginFailures(key);
    const token = createSession(row.id, { ip });
    setSessionCookie(req, res, token);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/logout', (req, res) => {
  destroySession(req.webSessionToken);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ── register: a fresh tenant account (like a new Telegram contact), only while the owner has the toggle on.
// Two outcomes by demo mode: (1) demo OFF → the account is UNUSABLE until 2FA is proven (a pending_totp
// session + QR, activated by /totp/verify); a squatted-but-never-verified name can be resumed by whoever
// holds the password (see /login). (2) demo ON → per-IP abuse controls, then a TOTP-free ACTIVE session so a
// visitor drops straight in; effectiveSessionState downgrades it to needs_totp if demo mode is later off. ──
router.post('/register', async (req, res) => {
  try {
    const cfg = getAuthConfig();
    if (cfg.mode !== 'simple' || !cfg.allowRegistration) {
      return res.status(403).json({ error: 'Registration is not open on this server.' });
    }
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Username must be 3–32 characters: letters, digits, . _ -' });
    }
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const demo = demoModeOn();
    const ip = normalizeIp(req.ip);
    if (demo) {
      // On a public-demo box this route is an UNAUTHENTICATED door to the guest list, so it earns the same
      // per-IP abuse controls the Telegram /demo form has (register had none — it assumed a private box).
      // All checks run BEFORE we create any row, so a throttled/capped attempt leaves no orphan account.
      const g = getGuardConfig();
      if (g.demoPaused) return res.status(503).json({ error: 'The demo is paused — back soon.', code: 'DEMO_PAUSED' });
      if (webRegThrottle.over(ip)) {
        return res.status(429).json({ error: 'Too many requests from your address — try again in a few minutes.' });
      }
      webRegThrottle.record(ip);
      if (g.demoSignupsPerIp && webRegSeats.count(ip) >= g.demoSignupsPerIp) {
        return res.status(429).json({ error: "You've created a few accounts from here already — try again later." });
      }
      const { maxWebDemoAccounts } = config.limits;
      if (maxWebDemoAccounts && countWebAccounts() >= maxWebDemoAccounts) {
        return res.status(403).json({ error: 'The demo is full right now — try again another day.' });
      }
    }

    if (getUserByUsername(username)) return res.status(409).json({ error: 'That username is taken.' });
    const passwordHash = await hashPassword(password);
    let userId;
    try {
      userId = createWebUser({ username, passwordHash });
    } catch {
      return res.status(409).json({ error: 'That username is taken.' }); // unique-index race
    }

    if (demo) {
      // Frictionless: no authenticator. Open an ACTIVE session immediately — the account is usable now and
      // stays usable while demo mode is on. Turn demo mode off later and effectiveSessionState downgrades it
      // to needs_totp until the user enrolls (see the login / status / totp branches). The `active` flag lets
      // the client tell this apart from the pending_totp response below and drop straight into the app.
      const token = createSession(userId, { ip, state: 'active' });
      setSessionCookie(req, res, token);
      webRegSeats.record(ip);
      notifyOwner(`🎟️ Web demo signup: ${username}`);
      return res.json({ ok: true, active: true });
    }

    // Private box (registration deliberately opened, demo mode off): mandatory 2FA. The account is UNUSABLE
    // until /totp/verify — open a pending_totp session + QR, exactly as before.
    const enroll = await beginTotpEnrollment(userId, username);
    const token = createSession(userId, { ip, state: 'pending_totp' });
    setSessionCookie(req, res, token);
    res.json({ ok: true, pendingTotp: true, ...enroll });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── TOTP enrollment. Three legitimate callers:
//  · mode none → acts on ROOT with no session (the web IS root while login is off — same trust as every
//    settings write today); this is how the owner enrolls BEFORE flipping the mode on.
//  · a pending_totp session → re-issue a QR for its OWN unfinished enrollment.
//  · mode simple + an ACTIVE root session → re-enroll (rotate authenticator), current password required.
//    The verified secret stays live until the NEW one is proven (see auth.js). ──
router.post('/totp/setup', async (req, res) => {
  try {
    const s = req.webSession;
    if (!authModeIsSimple()) {
      const row = getAuthRow(ROOT_USER_ID);
      return res.json(await beginTotpEnrollment(ROOT_USER_ID, row?.username || 'root'));
    }
    if (s?.state === 'pending_totp') {
      const row = getAuthRow(s.userId);
      return res.json(await beginTotpEnrollment(s.userId, row?.username || 'user'));
    }
    if (s?.state === 'active' && s.userId === ROOT_USER_ID) {
      const row = getAuthRow(ROOT_USER_ID);
      if (!(await verifyPassword(String(req.body?.currentPassword || ''), row?.password_hash))) {
        return res.status(403).json({ error: 'Enter your current password to re-enroll 2FA.' });
      }
      return res.json(await beginTotpEnrollment(ROOT_USER_ID, row?.username || 'root'));
    }
    // A TOTP-less non-root web (demo) account enrolling from its live session — either voluntarily while demo
    // mode is on, or forced once it's off (effectiveSessionState downgraded it to needs_totp). No current
    // password required: there's no verified 2FA yet to protect from silent rotation (the !totp_verified_at
    // guard is what keeps an already-verified account off this branch).
    if (s?.state === 'active' && s.userId !== ROOT_USER_ID && !getAuthRow(s.userId)?.totp_verified_at) {
      const row = getAuthRow(s.userId);
      return res.json(await beginTotpEnrollment(s.userId, row?.username || 'user'));
    }
    return res.status(403).json({ error: 'Not allowed.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/totp/verify', async (req, res) => {
  try {
    const code = req.body?.code;
    const s = req.webSession;
    if (!authModeIsSimple()) {
      if (!(await verifyTotpEnrollment(ROOT_USER_ID, code))) {
        return res.status(400).json({ error: 'That code didn’t match — try the current one.' });
      }
      return res.json({ ok: true, account: accountBlock() });
    }
    if (s?.state === 'pending_totp') {
      if (!(await verifyTotpEnrollment(s.userId, code))) {
        return res.status(400).json({ error: 'That code didn’t match — try the current one.' });
      }
      activateSession(s.tokenHash); // enrollment proven → the account is live and this session is real
      return res.json({ ok: true });
    }
    if (s?.state === 'active' && s.userId === ROOT_USER_ID) {
      if (!(await verifyTotpEnrollment(ROOT_USER_ID, code))) {
        return res.status(400).json({ error: 'That code didn’t match — try the current one.' });
      }
      return res.json({ ok: true, account: accountBlock() });
    }
    // A TOTP-less non-root web (demo) account finishing enrollment from its live session (see /totp/setup).
    // The session row is already 'active'; verifyTotpEnrollment stamps totp_verified_at, so
    // effectiveSessionState returns 'active' on the next request regardless of demo mode — no activateSession.
    if (s?.state === 'active' && s.userId !== ROOT_USER_ID && !getAuthRow(s.userId)?.totp_verified_at) {
      if (!(await verifyTotpEnrollment(s.userId, code))) {
        return res.status(400).json({ error: 'That code didn’t match — try the current one.' });
      }
      return res.json({ ok: true });
    }
    return res.status(403).json({ error: 'Not allowed.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── The ROOT login account (username / password). Mode none: no session or current password needed —
// the same trust as every other settings write while login is off (this is the setup path). Mode simple:
// active root session + current password, and a password change kills every other session. ──
router.post('/account', async (req, res) => {
  try {
    const simple = authModeIsSimple();
    const s = req.webSession;
    if (simple && !(s?.state === 'active' && s.userId === ROOT_USER_ID)) {
      return res.status(403).json({ error: 'Only the root user can change the login account.' });
    }
    const row = getAuthRow(ROOT_USER_ID);
    if (simple && !(await verifyPassword(String(req.body?.currentPassword || ''), row?.password_hash))) {
      return res.status(403).json({ error: 'Current password is wrong.' });
    }
    const patch = {};
    if (req.body?.username != null && String(req.body.username).trim() !== '') {
      const username = String(req.body.username).trim();
      if (!USERNAME_RE.test(username)) {
        return res.status(400).json({ error: 'Username must be 3–32 characters: letters, digits, . _ -' });
      }
      const clash = getUserByUsername(username);
      if (clash && clash.id !== ROOT_USER_ID) return res.status(409).json({ error: 'That username is taken.' });
      patch.username = username;
    }
    if (typeof req.body?.newPassword === 'string' && req.body.newPassword !== '') {
      if (req.body.newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      patch.passwordHash = await hashPassword(req.body.newPassword);
    }
    if (!('username' in patch) && !('passwordHash' in patch)) {
      return res.status(400).json({ error: 'Nothing to change.' });
    }
    setUserCredentials(ROOT_USER_ID, patch);
    if (patch.passwordHash && simple) destroyOtherSessions(ROOT_USER_ID, s.tokenHash);
    res.json({ ok: true, account: accountBlock() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── /web/:token — the /web chat command's click target. Mounted at TOP level in index.js (not
// under /api) so the link the bot sends reads {siteUrl}/web/…, before static + the SPA catch-all.
// Two steps on the same URL: GET shows an interstitial, and only a POST (auto-fired by its script, or
// the button as fallback) redeems the token. Chat apps (Telegram, Slack) prefetch links to render
// previews — that GET used to spend the one-time token before the user ever tapped it; preview bots
// never POST (and never run JS). The failure page is deliberately plain text: there's no session and
// nothing more useful to say than "get a fresh link".
const WEB_LINK_SPENT = 'This sign-in link has expired or was already used. Send /web to the bot again for a fresh one.';

// GET: read-only — never consumes, so previews and re-opens are harmless. The form has no action
// attribute (it posts back to this same URL), so the token never appears in the page body.
// The script POSTs via fetch and enters the app with location.replace so this page doesn't stay in
// back-history (Back from the app would land on a spent-token 410). It auto-proceeds on load: preview
// crawlers (Telegram, Slack) only GET and never execute JS, so running the exchange from script keeps
// the anti-prefetch property while sparing the user a tap. The visibility gate is a second fence — a
// prefetcher that DOES run JS (headless link scanners) typically never makes the page visible, so the
// token survives until a human is actually looking. The button stays as the no-JS / fetch-failure
// fallback (plain form POST + 302: old history behavior, but still signs in).
export function webLinkPageHandler(req, res) {
  if (!peekWebLinkToken(req.params.token)) {
    return res.status(410).type('text/plain').send(WEB_LINK_SPENT);
  }
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in to Fanad</title>
<style>
  body { font-family: system-ui, sans-serif; display: flex; min-height: 100vh; margin: 0; align-items: center; justify-content: center; background: #f5f4f0; color: #222; }
  main { text-align: center; padding: 2rem; max-width: 26rem; }
  button { font-size: 1.1rem; padding: 0.75rem 2rem; border: 0; border-radius: 0.5rem; background: #2f6f4f; color: #fff; cursor: pointer; }
  button:hover { background: #285e43; }
  p { color: #555; }
</style>
</head>
<body>
<main>
  <h1>Open Fanad</h1>
  <p>This one-time link signs you in as your chat account. Tap the button to continue.</p>
  <form method="post"><button type="submit">Open Fanad, signed in</button></form>
</main>
<script>
const note = document.querySelector('p');
const btn = document.querySelector('button');
let started = false;
async function go() {
  if (started) return;
  started = true;
  btn.disabled = true;
  note.textContent = 'Signing you in…';
  try {
    const res = await fetch(location.href, { method: 'post', redirect: 'manual' });
    if (res.status === 410) {
      document.querySelector('main').textContent = await res.text();
      return;
    }
    location.replace('/');
  } catch { // network hiccup — let the user tap to retry
    started = false;
    btn.disabled = false;
    note.textContent = 'That didn’t go through. Tap the button to try again.';
  }
}
document.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); go(); });
if (document.visibilityState === 'visible') go();
else document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') go(); });
</script>
</body>
</html>`);
}

// POST: exchange the one-time token for an ordinary ACTIVE session cookie and land on the app, signed in
// as the chat user who asked for it (auth.js has the trust argument). No mode check here: if login was
// turned off between mint and click, the cookie is simply inert — same as every other session.
export function webLinkLoginHandler(req, res) {
  const userId = consumeWebLinkToken(req.params.token);
  if (userId == null) {
    return res.status(410).type('text/plain').send(WEB_LINK_SPENT);
  }
  const token = createSession(userId, { ip: normalizeIp(req.ip) });
  setSessionCookie(req, res, token);
  res.redirect('/');
}

export default router;
