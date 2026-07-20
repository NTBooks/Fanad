// Fanad server: one Express app serving the REST API + the built web frontend.
import express from 'express';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { config } from './config.js';
import { kekPresent, kekSource } from './crypto.js';
import { enableDebugLog } from './debugLog.js';
import { migrate } from './db.js';
import { migrateSecretsAtRest } from './settings.js';
import { initTimezone } from './timezone.js';
import { loadCustomCategories } from './categories.js';
import { llmStatus } from './services/llm/index.js';
import { startScheduler } from './scheduler.js';
import { startTelegram } from './channels/telegram.js';
import { startSlack } from './channels/slack.js';
import { backfillLinkPreviews } from './linkBackfill.js';
import apiRouter from './routes/api.js';
import authRouter, { webLinkPageHandler, webLinkLoginHandler } from './routes/auth.js';
import { demoPageHandler, demoRequestHandler } from './routes/demo.js';
import { remotePageHandler, remoteFireHandler } from './routes/remote.js';
import { sessionMiddleware, cliTokenMiddleware, apiAuthGate, authModeIsSimple, applyAuthResetIfRequested } from './auth.js';
import { ipGate } from './ipGate.js';

// Capture logs first so startup + scheduler + Telegram output is visible in the web debug panel.
if (config.debugLog) enableDebugLog();

// USER_IMPERSONATION is an intentional single-operator convenience with real teeth: the web layer has no
// auth, so while it's on ANY client that can reach this server can read and write EVERY account's data by
// setting one request header. Make that impossible to miss on every boot.
if (config.userImpersonation) {
  console.warn([
    '',
    '!'.repeat(78),
    '!!  USER_IMPERSONATION IS ON',
    '!!  The web API has NO auth: any client that can reach this server can act',
    '!!  as ANY user — read and write — by setting the X-Fanad-User header.',
    '!!  This flag is for a single-operator host only. On anything networked or',
    '!!  multi-user, unset USER_IMPERSONATION and restart.',
    '!'.repeat(78),
    '',
  ].join('\n'));
}

migrate();
migrateSecretsAtRest(); // re-key bootstrap-encrypted secrets once an env KEK arrives; retire the key file
initTimezone(); // run in the user's timezone (adopted from the weather location; env TZ overrides) BEFORE any date math
applyAuthResetIfRequested(); // AUTH_RESET break-glass: force web login OFF (credentials preserved)
loadCustomCategories(); // re-register any categories the user minted via "/lock <new-name>" so they persist

// Web login ON makes the impersonation header inert (the session IS the identity) — say so at boot rather
// than leave the operator wondering why the switcher vanished.
if (config.userImpersonation && authModeIsSimple()) {
  console.warn('[auth] USER_IMPERSONATION is set but web login (auth mode "simple") is on — impersonation is inert while login is enabled.');
}

const app = express();
// Behind a reverse proxy (Coolify/Traefik) req.ip is the proxy unless the X-Forwarded-For chain is
// trusted — which the IP allowlist and login rate-limit key on. TRUST_PROXY=1 (or a hop count) enables it.
if (config.trustProxy) app.set('trust proxy', config.trustProxy);
app.use(ipGate); // optional IP allowlist — gates API *and* static; loopback + /api/health always pass
// 32kb (down from Express's 100kb default): nothing legitimate approaches it — the longest real bodies are
// a chat message or a settings blob — and it bounds what a hostile client can make the JSON parser chew.
app.use(express.json({ limit: '32kb' }));

app.get('/api/health', async (_req, res) => {
  // Liveness + the deploy-verification booleans (volume mounted / secrets encrypted / LLM up) — and nothing
  // more. This endpoint is unauthenticated and doc'd as the platform healthcheck path, so it must not
  // describe the deployment: filesystem paths, the KEK source, NODE_ENV, the impersonation flag, and LLM
  // provider/error strings (which can carry internal hostnames) are reconnaissance handed to any client
  // that can reach the box. The operator gets that detail from the startup log below instead.
  // llmStatus is guarded: Express 4 doesn't catch async-handler rejections, so an uncaught throw here would
  // be an unhandled rejection (fatal on modern Node) with the request left hanging.
  let llm;
  try { const s = await llmStatus(); llm = { reachable: !!s.reachable, ok: !!s.ok }; }
  catch (err) { console.error('health: llmStatus failed:', err.message); llm = { reachable: false, ok: false }; }
  res.json({ ok: true, encryptsSecrets: kekPresent(), persist: { mounted: config.persistMounted }, llm });
});

// Session resolve (never rejects) → CLI claim-token resolve (never rejects) → the open auth surface →
// the gated API. /api/auth/* is everything a logged-out client needs (status/login/register/TOTP);
// apiAuthGate 401s the rest while login is on — a valid Bearer claim token (req.cliAuth) passes it, so
// the `fanad <server> <token>` client needs no cookie in either auth mode.
app.use(sessionMiddleware);
app.use(cliTokenMiddleware);
app.use('/api/auth', authRouter);
app.use('/api', apiAuthGate, apiRouter);
// The /web chat command's click target. GET is a read-only interstitial (chat apps prefetch links for
// previews, which must not spend the one-time token); its button POSTs back to the same URL, which does the
// exchange: token → session cookie → redirect to /. Top-level (not /api) so the link the bot sends reads
// {siteUrl}/web/… — mounted before static + the SPA catch-all so it never falls through to index.html.
// Behind ipGate like the rest of the web surface.
app.get('/web/:token', webLinkPageHandler);
app.post('/web/:token', webLinkLoginHandler);
// The public demo signup page (routes/demo.js): a visitor enters their Telegram handle and is vouched in
// by the demo service account — only while the owner's `demoSignupOpen` guard switch is on. Top-level and
// mounted before static + the SPA catch-all for the same reasons as /web; open to logged-out visitors by
// construction (it isn't under the /api gate), and behind ipGate like everything else.
app.get('/demo', demoPageHandler);
app.post('/demo', demoRequestHandler);
// The speed-dial "remote control" share links (routes/remote.js): a host texts a guest {siteUrl}/r/<token>
// and the guest taps that one pad's Home Assistant buttons — no login, no Telegram. Top-level (short, textable
// URL) and mounted before static + the SPA catch-all so /r/* never falls through to index.html. The GET only
// renders; the POST fires one predefined slot. Open to logged-out visitors by construction (not under /api),
// behind ipGate like the rest — the token is the only credential, vetted per request by resolveShare.
app.get('/r/:token', remotePageHandler);
app.post('/r/:token/fire', remoteFireHandler);
// TODO (later phases): suggestions §4, metrics §13, notes §15, actions §16.

// The bundled guide (site/: brochure + manual) at /docs — linked from the web header. Mounted before the
// SPA catch-all so /docs/* never falls through to index.html.
const docsDir = join(config.root, 'site');
if (existsSync(docsDir)) app.use('/docs', express.static(docsDir));

// Shareable static preview pages (previews/: animated product demos, e.g. the "eat" command spot).
// Served at /previews, extensionless (/previews/eat -> previews/eat.html), open to logged-out visitors
// like /docs and behind ipGate; mounted before the SPA catch-all so /previews/* never hits index.html.
const previewsDir = join(config.root, 'previews');
if (existsSync(previewsDir)) app.use('/previews', express.static(previewsDir, { extensions: ['html'] }));

// Serve the built frontend (web/dist) in production; Vite dev server proxies /api in development.
const webDist = join(config.root, 'web', 'dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (_req, res) => res.sendFile(join(webDist, 'index.html')));
}

startScheduler();
startTelegram().catch((err) => console.error('Telegram disabled:', err.message));
startSlack().catch((err) => console.error('Slack disabled:', err.message));
// One-shot: fetch link previews for pre-v40 tasks that carry a URL (self-terminating; see linkBackfill.js).
backfillLinkPreviews().catch((err) => console.error('[linkBackfill] failed:', err.message));

app.listen(config.port, () => {
  console.log(`Fanad listening on http://localhost:${config.port} (${config.env})`);
  // The deployment detail /api/health used to serve (it's unauthenticated now) lives here, for the operator.
  // kekSource: 'env' = off-box KEK (real protection) · 'temp' = on-box bootstrap stopgap · 'none' = plaintext.
  // persist NOT mounted in production means data is on EPHEMERAL storage — map a volume to persistDir.
  console.log(`[startup] data dir: ${config.dataDir} · persist volume: ${config.persistMounted ? `mounted (${config.persistDir})` : 'NOT mounted'} · secrets at rest: ${kekPresent() ? `encrypted (KEK source: ${kekSource()})` : 'NOT encrypted'}`);
});
