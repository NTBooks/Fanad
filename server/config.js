// Config = non-secret data/config.json merged with .env (secrets + overrides).
// Secrets ONLY come from the environment; they are never written to data/config.json.
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolvePersistDir, resolveDataDir } from './dataDirPath.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env.NODE_ENV || 'development';

// Where DB + KEK live — resolution logic in dataDirPath.js (shared with the pre-boot setup wizard and the
// restore-backup CLI, which must resolve these paths without importing this module's side effects).
const persistDir = resolvePersistDir();
const persistMounted = existsSync(persistDir);
const explicitDataDir = process.env.DATA_DIR;
const dataDir = resolveDataDir();

// Fail fast in production if the persistent volume wasn't mapped — better than silently writing the DB +
// KEK to ephemeral storage and losing them on the next redeploy. DATA_DIR is the explicit escape hatch.
if (!explicitDataDir && env === 'production' && !persistMounted) {
  throw new Error(
    `PERSIST_DATA directory "${persistDir}" does not exist. Map a persistent volume to it (e.g. in Coolify) `
    + 'so the database and encryption key survive redeploys, or set DATA_DIR explicitly.',
  );
}
if (!explicitDataDir && !persistMounted && process.env.PERSIST_DATA) {
  console.warn(`[config] PERSIST_DATA "${persistDir}" not found; using local data dir "${dataDir}".`);
}
mkdirSync(dataDir, { recursive: true }); // first boot on a freshly-mounted volume has an empty dir

const cfgPath = join(dataDir, 'config.json');
const fileCfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
// SETUP_MODE unlocks the settings backup/restore tools (move config between servers). Force-disabled in
// production so a live deployment never exposes a full settings dump (which contains secrets).
const setupMode = ['1', 'true', 'yes', 'on'].includes(String(process.env.SETUP_MODE).toLowerCase()) && env !== 'production';
// BACKUP_MODE unlocks the whole-instance backup export (move this install to another server / keep a full
// backup). Unlike SETUP_MODE it is NOT force-disabled in production — migrating off a live box is the whole
// point — so it's a deliberate restart-required opt-in: the export hands out the entire database and
// (via a checkbox) the encryption key to whoever passes requireOwner. Default OFF.
const backupMode = ['1', 'true', 'yes', 'on'].includes(String(process.env.BACKUP_MODE).toLowerCase());

export const config = {
  root,
  dataDir,
  persistDir,
  persistMounted,
  port: Number(process.env.PORT) || 8787,
  env,
  setupMode,
  backupMode,
  // Host/admin convenience: when on, the web UI may act as ANY user (an impersonation dropdown). Default
  // OFF. SECURITY: the web layer has no auth — with this ON, any client reaching the server can act as any
  // user via one request header. Keep OFF on any networked/multi-user deployment. Deliberately NOT
  // force-disabled in production (unlike SETUP_MODE) so a single-operator host deploy can use it.
  userImpersonation: !!process.env.USER_IMPERSONATION
    && !['', '0', 'false', 'off', 'no'].includes(String(process.env.USER_IMPERSONATION).toLowerCase()),
  sessionSecret: process.env.SESSION_SECRET || '',
  // Public base URL of this deployment (e.g. https://fanad.example.com) — only the DEFAULT for the
  // "Site URL" setting while the DB holds no value (telegram-pattern precedence; see settings.js
  // getSiteConfig). Blank = unset. Powers the /web sign-in link; nothing else reads it.
  siteUrl: String(process.env.SITE_URL || '').trim().replace(/\/+$/, ''),
  // Default web theme for browsers that have never picked one — a per-DEPLOYMENT skin (the public demo
  // sets 'bokeh', the 🌊 Ocean theme, for the first-impression wow). A user's explicit pick in
  // Settings → Appearance is stored per browser and always wins. Anything unrecognized = 'auto'.
  webDefaultTheme: ['light', 'dark', 'bokeh'].includes(String(process.env.WEB_DEFAULT_THEME || '').trim().toLowerCase())
    ? String(process.env.WEB_DEFAULT_THEME).trim().toLowerCase() : 'auto',
  // ── Web login (auth §9). AUTH_MODE is only the DEFAULT mode while the DB holds no choice yet
  // ('none'|'simple'); the Settings dropdown writes the DB value, which wins thereafter (same precedence as
  // the telegram config). AUTH_RESET is the break-glass: at boot it forces the stored mode back to 'none'
  // (credentials + 2FA are PRESERVED) — the lockout recovery path for a lost authenticator or lost KEK. ──
  auth: {
    modeDefault: process.env.AUTH_MODE === 'simple' ? 'simple' : 'none',
    reset: !!process.env.AUTH_RESET
      && !['', '0', 'false', 'off', 'no'].includes(String(process.env.AUTH_RESET).toLowerCase()),
  },
  // Behind a reverse proxy (Coolify/Traefik), req.ip is the proxy container unless Express trusts the
  // X-Forwarded-For chain — which breaks the IP allowlist and the login rate-limit keying. Set TRUST_PROXY=1
  // (or a hop count) on proxied deploys. Accepts a number of hops or a truthy flag (→ 1 hop).
  trustProxy: /^\d+$/.test(String(process.env.TRUST_PROXY || ''))
    ? Number(process.env.TRUST_PROXY)
    : (!!process.env.TRUST_PROXY && !['', '0', 'false', 'off', 'no'].includes(String(process.env.TRUST_PROXY).toLowerCase()) ? 1 : false),
  // Dev aid: when DEBUG_LOG is set, tee server logs into a buffer the web debug panel can read. See debugLog.js.
  debugLog: !!process.env.DEBUG_LOG && !['', '0', 'false', 'off', 'no'].includes(process.env.DEBUG_LOG.toLowerCase()),
  // ── Public-demo guardrails (all env-only; hard caps don't need runtime mutability — the runtime
  // switches live in the `guard` settings blob, settings.js). Zero/absent = the permissive default, so a
  // private single-operator box behaves exactly as before. Owner/root is ALWAYS exempt from these caps. ──
  limits: {
    // Per-user LLM calls (chat + embed) per local day. 0 = unlimited. Enforced at the llm/index.js
    // chokepoint via llmBudget.js; identity arrives through the AsyncLocalStorage seam (llm/context.js).
    userDailyLlmCalls: Number(process.env.LLM_USER_DAILY_CALL_CAP) || 0,
    // Global in-flight provider calls; excess FIFO-queues (llm/limiter.js). 0 = unlimited.
    llmMaxConcurrency: Number(process.env.LLM_MAX_CONCURRENCY) || 0,
    // Waiting calls beyond the concurrency cap; overflow throws LLM_BUSY (a friendly "busy" reply).
    llmQueueMax: Number(process.env.LLM_QUEUE_MAX) || 25,
    // Vouch abuse controls (chat.js vouchCommand). 0 = unlimited / rule off.
    vouchCapPerUser: Number(process.env.VOUCH_CAP_PER_USER) || 0,   // non-owner max active vouches given
    vouchMaxDepth: Number(process.env.VOUCH_MAX_DEPTH) || 0,        // owner=0; a depth-N user may vouch only if N < max
    maxVouchedUsers: Number(process.env.MAX_VOUCHED_USERS) || 0,    // global active-vouch seat cap (per platform)
    // Reclaim a /demo self-signup's seat if they never send a first message within this many hours (the
    // scheduler soft-revokes the unclaimed vouch so the seat frees up). Only ever touches the demo cohort,
    // so it's harmless on a private box. 0 = off. Default 2h.
    demoSeatReclaimHours: process.env.DEMO_SEAT_RECLAIM_HOURS != null ? Number(process.env.DEMO_SEAT_RECLAIM_HOURS) : 2,
    // Max seats one IP may CLAIM via the public /demo form (24h rolling, in-memory) — stops a single actor
    // from hoarding the guest list with junk handles while leaving room for an honest typo-retry. 0 = off.
    // Also caps per-IP browser (web) demo signups (routes/auth.js) — the two share this owner-tunable number.
    demoSignupsPerIp: process.env.DEMO_SIGNUPS_PER_IP != null ? Number(process.env.DEMO_SIGNUPS_PER_IP) : 3,
    // Global cap on self-registered browser DEMO accounts (the web analogue of maxVouchedUsers, which only
    // counts Telegram vouches). Backstops the per-IP limit so no address-hopping actor can fill the box with
    // TOTP-free accounts. Counts non-root credentialed rows with no platform identity (repo countWebAccounts).
    // 0 = off. Only consulted while demo mode is on. On a private box (registration opened, demo off) it's inert.
    maxWebDemoAccounts: Number(process.env.MAX_WEB_DEMO_ACCOUNTS) || 0,
    // Stored inbound text cap (truncate, don't reject). 0 = uncapped. Telegram itself caps at 4096.
    maxInboundChars: Number(process.env.MAX_INBOUND_CHARS) || 0,
  },
  llm: {
    // Cloud (non-local) providers are OFF by default — they send your notes off the box. Flip
    // LLM_ALLOW_CLOUD on to expose them in Settings and allow selecting them. UI visibility + write-path.
    cloudEnabled: !!process.env.LLM_ALLOW_CLOUD
      && !['', '0', 'false', 'off', 'no'].includes(process.env.LLM_ALLOW_CLOUD.toLowerCase()),
    // Provider selection. Chat and embeddings can differ. Default: local LM Studio.
    provider: process.env.LLM_PROVIDER || fileCfg.llm?.provider || 'lmstudio',         // chat: lmstudio|ollama|openai|gemini|anthropic
    embedProvider: process.env.EMBED_PROVIDER || fileCfg.llm?.embedProvider || 'lmstudio', // embeddings: lmstudio|ollama|openai|gemini (NOT anthropic)
    // Local server (LM Studio or Ollama — both OpenAI-compatible). Blank base URL → a provider-aware
    // default is filled in getLlmConfig (LM Studio :1234, Ollama :11434).
    baseUrl: process.env.LMSTUDIO_BASE_URL || process.env.OLLAMA_BASE_URL || fileCfg.llm?.baseUrl || '',
    chatModel: process.env.LMSTUDIO_CHAT_MODEL || fileCfg.llm?.chatModel || '',
    embedModel: process.env.LMSTUDIO_EMBED_MODEL || fileCfg.llm?.embedModel || '',
    apiKey: process.env.LMSTUDIO_API_KEY || fileCfg.llm?.apiKey || 'lm-studio',
    // Optional cloud providers (BYO key; keys come from env only — they are secrets)
    openai: {
      apiKey: process.env.OPENAI_API_KEY || '',
      chatModel: process.env.OPENAI_CHAT_MODEL || fileCfg.llm?.openai?.chatModel || 'gpt-4o-mini',
      embedModel: process.env.OPENAI_EMBED_MODEL || fileCfg.llm?.openai?.embedModel || 'text-embedding-3-small',
    },
    gemini: {
      apiKey: process.env.GEMINI_API_KEY || '',
      // gemini-2.0-flash was retired by Google (now 404s "no longer available"). Default to a current model.
      // 2.5-flash is a "thinking" model — the provider (gemini.js) turns thinking off for our short JSON calls.
      chatModel: process.env.GEMINI_CHAT_MODEL || fileCfg.llm?.gemini?.chatModel || 'gemini-2.5-flash',
      embedModel: process.env.GEMINI_EMBED_MODEL || fileCfg.llm?.gemini?.embedModel || 'text-embedding-004',
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      chatModel: process.env.ANTHROPIC_CHAT_MODEL || fileCfg.llm?.anthropic?.chatModel || 'claude-sonnet-4-6',
    },
  },
  weather: {
    provider: process.env.WEATHER_PROVIDER || fileCfg.weather?.provider || 'open-meteo',
    zip: fileCfg.weather?.zip || '',
    apiKey: process.env.OPENWEATHER_API_KEY || '',
  },
  // ── Link previews: pasting a URL as a task fetches the page's og:title/description ONCE at capture and
  // stores it on the task (services/linkpreview.js — SSRF-guarded). LINK_PREVIEW=off kills the fetch
  // entirely (capture behaves as if the URL were plain text); the knobs below bound one fetch. ──
  linkPreview: {
    enabled: !['0', 'false', 'off', 'no'].includes(String(process.env.LINK_PREVIEW ?? '').toLowerCase() || 'on'),
    timeoutMs: Number(process.env.LINK_PREVIEW_TIMEOUT_MS) || 4000,
    maxBytes: Number(process.env.LINK_PREVIEW_MAX_BYTES) || 65536,
  },
  telegram: { botToken: process.env.TELEGRAM_BOT_TOKEN || '' },
  // Slack (optional second channel). Secrets from env only (encrypted at rest when set in the UI instead).
  // botToken: the bot user OAuth token (xoxb-). appToken: an app-level token (xapp-) with connections:write,
  // required ONLY for Socket Mode (no public URL — the default, mirroring Telegram long-polling). signingSecret:
  // used ONLY by the HTTP/Events mode (a Coolify-style public-URL deploy); harmless to leave blank otherwise.
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN || '',
    appToken: process.env.SLACK_APP_TOKEN || '',
    signingSecret: process.env.SLACK_SIGNING_SECRET || '',
  },
};
