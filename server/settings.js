// App settings persisted in the DB and editable from the UI — so non-technical users never touch a .env.
// The LLM config (provider, base URL, models, key) is stored here; .env only supplies optional defaults.
import { db } from './db.js';
import { config } from './config.js';
import { encryptSecret, decryptSecret, rekeySecret, needsRekey, finishRekey } from './crypto.js';

function readRaw(key) {
  const r = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return r ? r.value : null;
}
function writeRaw(key, value) {
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?,?,?)').run(key, value, Date.now());
}

export function getSetting(key, fallback = null) {
  const v = readRaw(key);
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch { return v; }
}
export function setSetting(key, value) {
  writeRaw(key, JSON.stringify(value));
  if (key === 'llm') llmCache = null;
  if (key === 'telegram') tgCache = null;
  if (key === 'slack') slackCache = null;
  if (key === 'metrics') metricsCache = null;
  if (key === 'retention') retentionCache = null;
  if (key === 'features') featuresCache = null;
  if (key === 'ai_log') aiLogCache = null;
  if (key === 'auth') authCache = null;
  if (key === 'site') siteCache = null;
  if (key === 'guard') guardCache = null;
  if (key === 'system_modules') sysModulesCache = null;
  if (key === 'homeassistant') haCache = null;
}

// ── LLM config: DB overrides over .env/config.json defaults (config.llm) ──
let llmCache = null;
let tgCache = null;
let slackCache = null;
let metricsCache = null;
let retentionCache = null;
let featuresCache = null;
let aiLogCache = null;
let authCache = null;
let siteCache = null;
let guardCache = null;
let sysModulesCache = null;
let haCache = null;

// DB-stored API keys are encrypted at rest (crypto.js); decrypt them on read. A DB value that can't be
// decrypted comes back null → we fall back to the env default, same as if no key were stored.
function decKey(stored, fallback) { return (stored != null ? decryptSecret(stored) : null) || fallback; }

// Default base URL for the two local, OpenAI-compatible servers (used when none is configured).
const LOCAL_DEFAULT_URL = { lmstudio: 'http://127.0.0.1:1234/v1', ollama: 'http://127.0.0.1:11434/v1' };

export function getLlmConfig() {
  if (llmCache) return llmCache;
  const base = config.llm;
  const o = getSetting('llm', {}) || {};
  const provider = o.provider || base.provider;
  const withKey = (b, dbProv) => ({ ...b, ...(dbProv || {}), apiKey: decKey(dbProv?.apiKey, b.apiKey) });
  llmCache = {
    provider,
    embedProvider: o.embedProvider || base.embedProvider,
    baseUrl: o.baseUrl || base.baseUrl || LOCAL_DEFAULT_URL[provider] || LOCAL_DEFAULT_URL.lmstudio,
    chatModel: o.chatModel ?? base.chatModel,
    embedModel: o.embedModel ?? base.embedModel,
    apiKey: decKey(o.apiKey, base.apiKey),
    openai: withKey(base.openai, o.openai),
    gemini: withKey(base.gemini, o.gemini),
    anthropic: withKey(base.anthropic, o.anthropic),
  };
  return llmCache;
}

export function setLlmConfig(partial = {}) {
  const cur = getSetting('llm', {}) || {};
  const next = { ...cur, ...partial };
  // Encrypt any incoming key before it touches the DB (the top-level lmstudio key and per-provider keys).
  if (typeof partial.apiKey === 'string') next.apiKey = encryptSecret(partial.apiKey);
  for (const p of ['openai', 'gemini', 'anthropic']) {
    if (partial[p]) {
      next[p] = { ...(cur[p] || {}), ...partial[p] };
      if (typeof partial[p].apiKey === 'string') next[p].apiKey = encryptSecret(partial[p].apiKey);
    }
  }
  setSetting('llm', next); // clears the cache
  return getLlmConfig();
}

// ── Telegram config (token set in the UI; created via @BotFather) ──
export function getTelegramConfig() {
  if (tgCache) return tgCache;
  const o = getSetting('telegram', {}) || {};
  const botToken = decKey(o.botToken, config.telegram.botToken) || ''; // stored encrypted; decrypt to use
  tgCache = {
    botToken,
    enabled: o.enabled != null ? !!o.enabled : !!botToken,
    allowedUsername: o.allowedUsername || '',
    ownerId: o.ownerId ?? null, // numeric Telegram id of the first chatter (trust-on-first-use)
  };
  return tgCache;
}

export function setTelegramConfig(partial = {}) {
  const cur = getSetting('telegram', {}) || {};
  const next = { ...cur, ...partial };
  if (typeof partial.botToken === 'string') next.botToken = encryptSecret(partial.botToken); // encrypt at rest
  setSetting('telegram', next); // clears the cache
  return getTelegramConfig();
}

// ── Slack config (optional second channel; mirrors the Telegram pair). botToken (xoxb-) + appToken (xapp-)
// for Socket Mode are the usual setup; signingSecret is only for the HTTP/Events mode (a public-URL deploy).
// All three secrets are stored ENCRYPTED at rest (decrypted on read; env value is the fallback). ──
export function getSlackConfig() {
  if (slackCache) return slackCache;
  const o = getSetting('slack', {}) || {};
  const botToken = decKey(o.botToken, config.slack.botToken) || '';
  const appToken = decKey(o.appToken, config.slack.appToken) || '';
  const signingSecret = decKey(o.signingSecret, config.slack.signingSecret) || '';
  slackCache = {
    botToken,
    appToken,
    signingSecret,
    mode: o.mode === 'http' ? 'http' : 'socket', // 'socket' (default, no public URL) | 'http' (Events API)
    // On unless explicitly disabled; needs a bot token AND (an app token for socket, or a signing secret for http).
    enabled: o.enabled != null ? !!o.enabled : !!(botToken && (appToken || signingSecret)),
    allowedSlack: o.allowedSlack || '', // comma/space-separated Slack user ids (Uxxxx) and/or @handles
    ownerSlackId: o.ownerSlackId ?? null, // the first DM-er's Uxxxx (trust-on-first-use claim)
  };
  return slackCache;
}

export function setSlackConfig(partial = {}) {
  const cur = getSetting('slack', {}) || {};
  const next = { ...cur, ...partial };
  for (const k of ['botToken', 'appToken', 'signingSecret']) {
    if (typeof partial[k] === 'string') next[k] = encryptSecret(partial[k]); // encrypt each secret at rest
  }
  setSetting('slack', next); // clears the cache
  return getSlackConfig();
}

// ── Home Assistant config (the Home Assistant module's owner-only connection + output targets). The
// long-lived access token is created in HA (profile → security) and pasted in Settings → it is stored
// ENCRYPTED at rest exactly like the Telegram/Slack/LLM secrets (decrypted on read; no env fallback —
// this is a per-house pairing, not a deploy default). Everything else is plain: base URL, the optional
// Assist agent id for `ha <command>` passthrough, and the three fire-path outputs (Voice PE announce,
// script hook, notify push) plus the manual-push calendar entity (configured entity IS its enable). ──
const cleanBaseUrl = (v) => String(v ?? '').trim().replace(/\/+$/, '');
export function getHomeAssistantConfig() {
  if (haCache) return haCache;
  const o = getSetting('homeassistant', {}) || {};
  let baseUrl = cleanBaseUrl(o.baseUrl);
  let token = decKey(o.token, null) || '';
  // Home Assistant add-on auto-pairing: running as an HA App, the Supervisor injects
  // SUPERVISOR_TOKEN and proxies HA core at http://supervisor/core — so the house is reachable
  // with no long-lived token to paste. A URL/token set in Settings always wins over this.
  if (!baseUrl && !token && process.env.SUPERVISOR_TOKEN) {
    baseUrl = 'http://supervisor/core';
    token = process.env.SUPERVISOR_TOKEN;
  }
  haCache = {
    enabled: o.enabled === true, // default off
    baseUrl,
    token,
    agentId: o.agentId || '', // blank = HA's default Assist agent
    announce: {
      enabled: o.announce?.enabled === true,
      entities: Array.isArray(o.announce?.entities) ? o.announce.entities : [],
      preannounce: typeof o.announce?.preannounce === 'boolean' ? o.announce.preannounce : null,
    },
    script: { enabled: o.script?.enabled === true, entity: o.script?.entity || '' },
    notify: {
      enabled: o.notify?.enabled === true,
      services: Array.isArray(o.notify?.services) ? o.notify.services : [], // stored WITHOUT 'notify.' prefix
    },
    calendar: { entity: o.calendar?.entity || '' },
  };
  return haCache;
}

export function setHomeAssistantConfig(partial = {}) {
  const cur = getSetting('homeassistant', {}) || {};
  const next = { ...cur };
  if (typeof partial.enabled === 'boolean') next.enabled = partial.enabled;
  if (typeof partial.baseUrl === 'string') next.baseUrl = cleanBaseUrl(partial.baseUrl);
  if (typeof partial.token === 'string' && partial.token.trim()) next.token = encryptSecret(partial.token.trim());
  if (typeof partial.agentId === 'string') next.agentId = partial.agentId.trim();
  if (partial.announce) {
    next.announce = { ...(cur.announce || {}) };
    if (typeof partial.announce.enabled === 'boolean') next.announce.enabled = partial.announce.enabled;
    if (Array.isArray(partial.announce.entities)) {
      next.announce.entities = partial.announce.entities.map((e) => String(e).trim()).filter(Boolean);
    }
    if (typeof partial.announce.preannounce === 'boolean' || partial.announce.preannounce === null) {
      next.announce.preannounce = partial.announce.preannounce;
    }
  }
  if (partial.script) {
    next.script = { ...(cur.script || {}) };
    if (typeof partial.script.enabled === 'boolean') next.script.enabled = partial.script.enabled;
    if (typeof partial.script.entity === 'string') next.script.entity = partial.script.entity.trim();
  }
  if (partial.notify) {
    next.notify = { ...(cur.notify || {}) };
    if (typeof partial.notify.enabled === 'boolean') next.notify.enabled = partial.notify.enabled;
    if (Array.isArray(partial.notify.services)) {
      next.notify.services = partial.notify.services
        .map((s) => String(s).trim().replace(/^notify\./, '')).filter(Boolean); // normalize the prefix off
    }
  }
  if (partial.calendar && typeof partial.calendar.entity === 'string') {
    next.calendar = { entity: partial.calendar.entity.trim() };
  }
  setSetting('homeassistant', next); // clears the cache
  return getHomeAssistantConfig();
}

// ── Metrics & diet module: OFF until the user turns it on in Settings (§13 is optional). ──
export function getMetricsConfig() {
  if (metricsCache) return metricsCache;
  const o = getSetting('metrics', {}) || {};
  metricsCache = { enabled: o.enabled === true }; // default false
  return metricsCache;
}

export function setMetricsConfig(partial = {}) {
  const cur = getSetting('metrics', {}) || {};
  setSetting('metrics', { ...cur, ...partial }); // clears the cache
  return getMetricsConfig();
}

// ── Feature toggles: which optional surfaces are on, so an admin can cut clutter. Tasks are the core engine
// and ALWAYS on (not stored here). Metrics keeps its own config above (off by default). These three default
// ON; turning one off hides its commands, help, guide topic, and menu chips everywhere — the single source of
// truth is chat.js's isFeatureOn(), which reads this (and getMetricsConfig). ──
export function getFeaturesConfig() {
  if (featuresCache) return featuresCache;
  const o = getSetting('features', {}) || {};
  featuresCache = {
    notes: o.notes !== false, // default ON
    lists: o.lists !== false, // default ON
    vouch: o.vouch !== false, // default ON (turn off to lock the access list)
  };
  return featuresCache;
}

export function setFeaturesConfig(partial = {}) {
  const cur = getSetting('features', {}) || {};
  const next = { ...cur };
  for (const k of ['notes', 'lists', 'vouch']) if (typeof partial[k] === 'boolean') next[k] = partial[k];
  setSetting('features', next); // clears the cache
  return getFeaturesConfig();
}

// ── Per-user feature opt-in (the live gate). Each optional module — notes · lists · metrics · vouch — is
// OFF by default and turned on per account, so a new user sees only Tasks and opts into the rest ("optin
// lists"). The single source of truth the brain reads is chat.js's makeIsOn()/isFeatureOnFor(), which layer
// the owner-auto-on rule for vouch on top of this. Stored as one blob per user under the namespaced key
// `features:<userId>` in the otherwise-global app_settings (same convention as dialog_state:<userId>), so it
// rides the existing per-user cleanup on /requestdeletion (repo.userSettingKeys). The legacy global
// get/setFeaturesConfig + get/setMetricsConfig above are kept only for the SETUP_MODE settings backup — they
// no longer gate anything. ──
export const OPTIN_FEATURES = ['notes', 'lists', 'metrics', 'diet', 'vouch', 'notebook', 'timer', 'journal', 'batches', 'homeassistant'];
const userFeaturesKey = (userId) => `features:${userId}`;
export function getUserFeatures(userId) {
  const o = getSetting(userFeaturesKey(userId), {}) || {};
  const out = {};
  for (const k of OPTIN_FEATURES) out[k] = o[k] === true; // absent / anything-but-true ⇒ off
  return out;
}
export function setUserFeatures(userId, partial = {}) {
  const cur = getSetting(userFeaturesKey(userId), {}) || {};
  const next = { ...cur };
  for (const k of OPTIN_FEATURES) if (typeof partial[k] === 'boolean') next[k] = partial[k];
  setSetting(userFeaturesKey(userId), next);
  return getUserFeatures(userId);
}

// ── Current-notebook pointer (the "which space am I in?" switch, part of the Notebooks module). A user can
// create isolated notebooks (sub-users — see repo.js) and switch into one; this stores the id they're
// currently acting as, per IDENTITY account, under the namespaced key `notebook:<userId>` (same app_settings
// store as dialog_state / features). Absent / null = the default ("main") space. Kept here (a plain settings
// read, no repo import to stay acyclic); the OWNERSHIP check lives in repo.effectiveUserId. Wiped on
// /requestdeletion via repo.userSettingKeys.
const notebookPtrKey = (userId) => `notebook:${userId}`;
export function getCurrentNotebookId(userId) {
  const v = getSetting(notebookPtrKey(userId), null);
  const n = v == null ? null : Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
export function setCurrentNotebookId(userId, notebookId) {
  setSetting(notebookPtrKey(userId), notebookId == null ? null : Number(notebookId));
}
export function clearCurrentNotebookId(userId) { setSetting(notebookPtrKey(userId), null); }

// ── AI activity log: an optional operator diagnostic, OFF by default. When on, every LLM call (purpose,
// prompt, raw response incl. <think> reasoning, latency, ok/fallback) plus the /whatdo decision is captured
// to a small in-memory ring buffer the Settings "AI activity log" panel tails — so you can SEE what the
// model is doing and why a suggestion was picked. It records your task text, so it stays off until you turn
// it on. The ring buffer lives in server/aiLog.js; this is just the live on/off switch it reads. ──
export function getAiLogConfig() {
  if (aiLogCache) return aiLogCache;
  const o = getSetting('ai_log', {}) || {};
  aiLogCache = { enabled: o.enabled === true }; // default false
  return aiLogCache;
}

export function setAiLogConfig(partial = {}) {
  const cur = getSetting('ai_log', {}) || {};
  const next = { ...cur };
  if (typeof partial.enabled === 'boolean') next.enabled = partial.enabled;
  setSetting('ai_log', next); // clears the cache
  return getAiLogConfig();
}

// ── Data retention (the /requestdeletion safety copy): OFF by default. When ON, an account-erase first
// writes a full zip export of the user's data to their folder (retention.js) before wiping the DB — for an
// operator who must keep records. OFF means a deletion request truly deletes, with no retained copy
// (privacy-first, the app's default stance). Enabling it is a disclosure the privacy policy must carry
// (what's kept + for how long) — see the TODO in retention.js. ──
export function getRetentionConfig() {
  if (retentionCache) return retentionCache;
  const o = getSetting('retention', {}) || {};
  retentionCache = { enabled: o.enabled === true }; // default false
  return retentionCache;
}

export function setRetentionConfig(partial = {}) {
  const cur = getSetting('retention', {}) || {};
  setSetting('retention', { ...cur, ...partial }); // clears the cache
  return getRetentionConfig();
}

// ── Web login (auth §9): the auth-mode switch + its companions. `mode` decides whether the web UI requires
// a login at all ('none' = today's trust-the-network model; 'simple' = username + password + mandatory TOTP).
// The DB value wins once the operator picks in Settings; env AUTH_MODE is only the default before that
// (telegram-pattern precedence). allowRegistration lets strangers self-register (only meaningful under
// 'simple'); ipAllowlist is an independent web gate (see ipGate.js) that applies in EITHER mode.
// No secrets live here — passwords/TOTP are on the users rows (see auth.js). ──
const sanitizeAllowlist = (v) => (Array.isArray(v)
  ? v.map((s) => String(s ?? '').trim()).filter(Boolean)
  : []);

export function getAuthConfig() {
  if (authCache) return authCache;
  const o = getSetting('auth', {}) || {};
  authCache = {
    mode: o.mode === 'simple' ? 'simple' : (o.mode === 'none' ? 'none' : config.auth.modeDefault),
    allowRegistration: o.allowRegistration === true,
    ipAllowlist: sanitizeAllowlist(o.ipAllowlist),
    // Terminal client: owner OPT-IN, default OFF. While off, claim tokens are not honored
    // (cliTokenMiddleware ignores Bearer) and none can be minted from chat or the Settings panel — the
    // CLI surface simply doesn't exist until the admin turns it on.
    cliEnabled: o.cliEnabled === true,
  };
  return authCache;
}

export function setAuthConfig(partial = {}) {
  const cur = getSetting('auth', {}) || {};
  const next = { ...cur };
  if (partial.mode === 'none' || partial.mode === 'simple') next.mode = partial.mode;
  if (typeof partial.allowRegistration === 'boolean') next.allowRegistration = partial.allowRegistration;
  if (typeof partial.cliEnabled === 'boolean') next.cliEnabled = partial.cliEnabled;
  if (Array.isArray(partial.ipAllowlist)) next.ipAllowlist = sanitizeAllowlist(partial.ipAllowlist);
  setSetting('auth', next); // clears the cache
  return getAuthConfig();
}

// ── Site URL (an ADVANCED option in Settings → Security): the public base URL of this deployment,
// e.g. https://fanad.example.com. Blank = unset (the default). Its one job: the /web chat command
// mints a one-time browser sign-in link on this base, so a Telegram/Slack-only user can open the web UI
// signed in as themselves — with no URL there's no address to point at, and /web stays off. DB value
// wins; env SITE_URL is only the default before the operator saves one (telegram-pattern precedence).
// Not a secret — stored plain. Deployment-specific, so it deliberately does NOT ride the SETUP_MODE
// backup/restore (same reasoning as the `auth` key — see routes/api.js). ──
const cleanSiteUrl = (v) => String(v ?? '').trim().replace(/\/+$/, '');

export function getSiteConfig() {
  if (siteCache) return siteCache;
  const o = getSetting('site', {}) || {};
  siteCache = { url: cleanSiteUrl(o.url) || config.siteUrl };
  return siteCache;
}

export function setSiteConfig(partial = {}) {
  const cur = getSetting('site', {}) || {};
  const next = { ...cur };
  if (typeof partial.url === 'string') next.url = cleanSiteUrl(partial.url);
  setSetting('site', next); // clears the cache
  return getSiteConfig();
}

// ── Demo guard switches (the public-demo kill switches; all default OFF). Runtime-mutable — the owner
// flips them from chat ("demo pause") or Settings → Security, no redeploy. `demoPaused` shuts every
// NON-OWNER surface: Telegram/Slack authorize() denies (the existing silent-drop path), the web API 503s
// for non-root, and /web link-minting refuses. `vouchFrozen` only blocks NEW vouches (existing access is
// untouched). `demoSignupOpen` is the one switch that OPENS a door instead of closing one: it turns on
// the public /demo page, where a visitor enters their Telegram handle and is vouched in by the demo
// service account (routes/demo.js). Unlike config.limits (env-set hard caps), these must flip live. ──
export function getGuardConfig() {
  if (guardCache) return guardCache;
  const o = getSetting('guard', {}) || {};
  guardCache = {
    vouchFrozen: o.vouchFrozen === true,       // default false
    demoPaused: o.demoPaused === true,         // default false
    demoSignupOpen: o.demoSignupOpen === true, // default false (the /demo page is closed)
    // Unlike the switches above, this one is a NUMBER: the max seats one IP may claim via /demo (0 = off).
    // The env-set config.limits value is the default; a stored non-negative integer overrides it live.
    demoSignupsPerIp: Number.isInteger(o.demoSignupsPerIp) && o.demoSignupsPerIp >= 0
      ? o.demoSignupsPerIp : config.limits.demoSignupsPerIp,
  };
  return guardCache;
}

export function setGuardConfig(partial = {}) {
  const cur = getSetting('guard', {}) || {};
  const next = { ...cur };
  if (typeof partial.vouchFrozen === 'boolean') next.vouchFrozen = partial.vouchFrozen;
  if (typeof partial.demoPaused === 'boolean') next.demoPaused = partial.demoPaused;
  if (typeof partial.demoSignupOpen === 'boolean') next.demoSignupOpen = partial.demoSignupOpen;
  if (partial.demoSignupsPerIp != null) {
    const n = Number(partial.demoSignupsPerIp);
    if (!Number.isInteger(n) || n < 0) throw new Error('Signups per IP must be a whole number of 0 or more.');
    next.demoSignupsPerIp = n;
  }
  setSetting('guard', next); // clears the cache
  return getGuardConfig();
}

// ── System-wide module availability (the GLOBAL layer above the per-user opt-in). Lets the owner release
// modules over time or gate them for the whole deployment: a system-disabled module is off for every
// non-owner regardless of their opt-in (makeIsOn enforces this), and is invisible to them (its commands
// fall through, and it's hidden from the modules screen / help / nudges). The owner keeps access to
// disabled modules so they can preview/test before flipping one on for everyone. Stored as one global blob
// under `system_modules` in app_settings (same convention as the `guard` kill switches), keyed by the
// canonical OPTIN_FEATURES list. A module ABSENT from the blob defaults ON — so every existing module stays
// available on deploy; ship a NEW module dark by adding its key to SYSTEM_MODULES_DEFAULT_OFF and flip it on
// from Settings → Modules (or "system enable <mod>") when it's ready. markConfigDirty() is intentionally NOT
// called here (would cycle settings↔clientConfig) — the two write call-sites bump the web config version. ──
const SYSTEM_MODULES_DEFAULT_OFF = new Set(['homeassistant']); // keys here ship "dark" (off until released)
export function getSystemModules() {
  if (sysModulesCache) return sysModulesCache;
  const o = getSetting('system_modules', {}) || {};
  const out = {};
  for (const k of OPTIN_FEATURES) out[k] = k in o ? o[k] === true : !SYSTEM_MODULES_DEFAULT_OFF.has(k);
  sysModulesCache = out;
  return out;
}
// Tasks/Manual (and any non-opt-in name) are core and never gatable — always "on" here.
export function isSystemModuleOn(name) {
  if (!OPTIN_FEATURES.includes(name)) return true;
  return getSystemModules()[name] === true;
}
export function setSystemModules(partial = {}) {
  const cur = getSetting('system_modules', {}) || {};
  const next = { ...cur };
  for (const k of OPTIN_FEATURES) if (typeof partial[k] === 'boolean') next[k] = partial[k];
  setSetting('system_modules', next); // clears the cache
  return getSystemModules();
}

// ── Secret-at-rest migration (call once at boot, after migrate()) ──
// Re-encrypts every stored secret under the ACTIVE key: lifts bootstrap-key (enc:t1) values to the env
// KEK (enc:v1) once one arrives, and upgrades any legacy plaintext. When all enc:t1 values are migrated,
// the on-box bootstrap key file is retired. Runs at the raw-storage layer (no double-encrypt). See crypto.js.
export function migrateSecretsAtRest() {
  let failures = 0;
  const rk = (obj, key) => {
    if (!obj || obj[key] == null || obj[key] === '') return false;
    const r = rekeySecret(obj[key]);
    if (r.status === 'failed') { failures++; return false; }
    if (r.status === 'rekeyed') { obj[key] = r.value; return true; }
    return false;
  };
  const llm = getSetting('llm', null);
  if (llm) {
    let changed = rk(llm, 'apiKey');
    for (const p of ['openai', 'gemini', 'anthropic']) if (llm[p]) changed = rk(llm[p], 'apiKey') || changed;
    if (changed) setSetting('llm', llm);
  }
  const tg = getSetting('telegram', null);
  if (tg && rk(tg, 'botToken')) setSetting('telegram', tg);
  const slack = getSetting('slack', null);
  if (slack) {
    let changed = false;
    for (const k of ['botToken', 'appToken', 'signingSecret']) changed = rk(slack, k) || changed;
    if (changed) setSetting('slack', slack);
  }
  const ha = getSetting('homeassistant', null);
  if (ha && rk(ha, 'token')) setSetting('homeassistant', ha);
  // Verified TOTP secrets live on the users rows (auth §9), encrypted like every other secret — lift them
  // to the new key too. (Pending enrollments in totp_pending:* keys are transient and deliberately skipped:
  // a KEK swap mid-enrollment just means scanning a fresh QR.)
  for (const r of db.prepare('SELECT id, totp_secret FROM users WHERE totp_secret IS NOT NULL').all()) {
    const rr = rekeySecret(r.totp_secret);
    if (rr.status === 'failed') failures++;
    else if (rr.status === 'rekeyed') db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(rr.value, r.id);
  }

  if (needsRekey()) {
    if (failures === 0) finishRekey(); // everything is enc:v1 now → drop the bootstrap key
    else console.warn(`[settings] ${failures} secret(s) could not be re-keyed; keeping the bootstrap key file.`);
  }
}
