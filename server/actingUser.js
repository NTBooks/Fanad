// The ONE place a WEB request's acting user is chosen. By default that's root (defaultUserId). When the
// host operator turns on USER_IMPERSONATION (config.userImpersonation), the web client may name another
// existing user via the X-Fanad-User header and act fully as them. Anything invalid — flag off, missing
// header, non-numeric, or an id with no user row — falls back to root, so a bad header can never escalate
// or break a request. Downstream is already user_id-scoped (repo.js / dataBrowser.js), so DB isolation
// holds automatically once a valid id is chosen here.
//
// A CLI claim token (req.cliAuth, stamped by cliTokenMiddleware from the Authorization header) is the
// strongest identity and wins in BOTH modes: the token NAMES its user — resolveCliToken already vetted
// revocation/expiry and that the id is a live identity row — so the impersonation header is ignored
// whenever a token is present (a token must never act as anyone but its own user).
//
// When web login is ON (auth mode 'simple'), the SESSION is the identity and the header protocol is
// ignored — honoring it would let any client bypass login with one header. And the polarity of "invalid"
// FLIPS: under mode none an invalid header falls back to root (a bad header must never break a request);
// under login, an absent/invalid session resolves to NOBODY (null → 401 upstream) — falling back to root
// there would make every expired cookie a privilege escalation.
import { config } from './config.js';
import { defaultUserId, userExists, isNotebook } from './repo.js';
import { authModeIsSimple, effectiveSessionState } from './auth.js';

const warnedHeaders = new Set(); // one warning per distinct bad value — the web polls every 5s, don't spam
export function resolveActingUserId(rawHeaderValue, webSession = null, cliAuth = null) {
  if (cliAuth?.userId) return cliAuth.userId;
  // A TOTP-less demo session is honored only while demo mode is on (effectiveSessionState); once it's off,
  // that session downgrades to 'needs_totp' → resolves to NOBODY here (null → 401 upstream) until 2FA is set.
  if (authModeIsSimple()) return effectiveSessionState(webSession) === 'active' ? webSession.userId : null;
  if (!config.userImpersonation) return defaultUserId();
  if (rawHeaderValue == null || rawHeaderValue === '') return defaultUserId(); // header omitted = root, the normal case
  const id = Number(rawHeaderValue);
  // A notebook is a sub-user, not an account — it must never be a direct acting target (only its owner reaches
  // it, via the current-notebook pointer). So a header naming a notebook id falls back to root, same as garbage.
  if (Number.isInteger(id) && id > 0 && userExists(id) && !isNotebook(id)) return id;
  // The fallback is deliberate (a bad header must never break a request), but silently acting as root would
  // put reads AND writes in root's data with no trace — warn so a stale switcher value is discoverable.
  if (!warnedHeaders.has(String(rawHeaderValue))) {
    warnedHeaders.add(String(rawHeaderValue));
    console.warn(`impersonation: X-Fanad-User "${rawHeaderValue}" is not an actable user — acting as root instead.`);
  }
  return defaultUserId();
}
