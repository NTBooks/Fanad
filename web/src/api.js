// Impersonation (host-only, gated server-side by USER_IMPERSONATION): which user the web acts as. Persisted
// in localStorage and sent as X-Fanad-User on every request. Empty = root (the header is omitted). The
// server validates and ignores it entirely when the flag is off, so a stale value can never escalate.
const AS_USER_KEY = 'fanad-as-user';
export const getAsUser = () => { try { return localStorage.getItem(AS_USER_KEY) || ''; } catch { return ''; } };
export const setAsUser = (id) => {
  try { if (id) localStorage.setItem(AS_USER_KEY, String(id)); else localStorage.removeItem(AS_USER_KEY); } catch { /* ignore */ }
};

// Tiny fetch wrapper. The web app talks to one chat endpoint + the settings endpoints. That's it.
// Session auth rides an HttpOnly cookie (same-origin, so fetch sends it automatically). A 401 means the
// session ended (logout elsewhere, expiry, login just turned on) — broadcast it so App can flip to the
// login screen instead of every poller retrying into a wall. The error carries status + body so callers
// can read structured fields (e.g. the IP-allowlist save's needsForce).
// Base path the app is served under. Home Assistant ingress serves the UI from a prefix
// (…/hassio_ingress/<token>/) and the browser must send that prefix on API calls (ingress
// strips it again before Fanad sees it). At the normal site root this is '' — a no-op. Safe
// because the web UI has no client-side routing, so the load-time path is a stable base.
// Assets are handled separately by Vite's `base: './'`.
const API_BASE = window.location.pathname.replace(/\/+$/, '');
export const apiUrl = (u) => API_BASE + u;

async function req(url, opts = {}) {
  const as = getAsUser();
  const headers = { ...(opts.headers || {}), ...(as ? { 'X-Fanad-User': as } : {}) };
  const r = await fetch(apiUrl(url), { ...opts, headers });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    if (r.status === 401) window.dispatchEvent(new Event('fanad:unauthorized'));
    const err = new Error(body.error || `HTTP ${r.status}`);
    err.status = r.status;
    err.body = body;
    throw err;
  }
  return r.json();
}
const post = (url, data) =>
  req(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) });
const send = (url, method, data) =>
  req(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) });

export const sendChat = (text) => post('/api/chat', { text });
// A clicked interactive button (structured token, e.g. "a:prio:42:3"). Same response shape as sendChat —
// the bot turn (with its refreshed buttons) is appended like any other reply.
export const sendAction = (data) => post('/api/action', { data });
export const react = (emoji, ref) => post('/api/react', { emoji, ref });
// One page of older chat history for backward scroll. `before` = the oldest message id already loaded
// (omit for the most recent page). Returns { messages: oldest→newest, hasMore }.
export const getHistory = (before = null, limit = 30) =>
  req(`/api/chat/history?limit=${limit}${before != null ? `&before=${before}` : ''}`);
// Truncate stored chat history. scope: 'all' wipes it, '30d' keeps the last 30 days.
export const clearHistory = (scope) => post('/api/chat/history/clear', { scope });
// Forward poll: messages newer than `after` (the newest id the client holds). Backs live updates so
// asynchronously-arriving turns (e.g. Telegram, while impersonating) appear without a refresh.
export const getNewMessages = (after = 0) => req(`/api/chat/new?after=${after}`);

// Server-owned client config (taxonomy, effort levels, tappable commands, onboarding copy, providers) +
// its version. The web loads this instead of hardcoding any of it. See server/clientConfig.js.
export const getConfig = () => req('/api/config');
// Heartbeat: { llm, configVersion, bot }. Drives the connection pill, tells the client when its cached
// config is stale (version changed) so it can refetch getConfig(), and names the connected chat bot.
export const heartbeat = () => req('/api/heartbeat');

export const getLlmSettings = () => req('/api/settings/llm');
export const saveLlmSettings = (data) => post('/api/settings/llm', data);
export const llmStatusCheck = () => req('/api/llm/status');
export const getTelegramSettings = () => req('/api/settings/telegram');
export const saveTelegramSettings = (data) => post('/api/settings/telegram', data);
export const getSlackSettings = () => req('/api/settings/slack');
export const saveSlackSettings = (data) => post('/api/settings/slack', data);
// Home Assistant (owner only): connection + ring outputs. The token is never echoed back — hasToken only.
export const getHomeAssistantSettings = () => req('/api/settings/homeassistant');
export const saveHomeAssistantSettings = (data) => post('/api/settings/homeassistant', data);
export const testHomeAssistant = () => post('/api/settings/homeassistant/test', {});
export const discoverHomeAssistant = () => req('/api/settings/homeassistant/discover');
// Access list: who's been vouched in (active + revoked, for the provenance tree) and cascade-revoke. Vouches
// are namespaced by platform (telegram | slack), so revoke carries the row's platform (defaults telegram).
export const getVouches = () => req('/api/vouches');
export const revokeVouch = (username, platform = 'telegram') => post('/api/vouches/revoke', { username, platform });
// Speed Dial (owner only): the expandable account list — every allowed Telegram handle with its 0-9 Home
// Assistant pad + the "limit to speed dial" flag. Create/authorize an account, save a pad, remove a pad, or
// test-fire one slot against the house.
export const getAccounts = () => req('/api/accounts');
export const addAccount = (username) => post('/api/accounts', { username });
export const savePad = (username, data) => send(`/api/accounts/${encodeURIComponent(username)}`, 'PUT', data);
export const removePad = (username) => send(`/api/accounts/${encodeURIComponent(username)}/pad`, 'DELETE');
export const testSlot = (username, slot, command = '') => post(`/api/accounts/${encodeURIComponent(username)}/test/${slot}`, { command });
// Shareable "remote control" link for a pad: mint returns the raw URL/token ONCE (hash-only storage) plus the
// refreshed accounts; revoke kills one active link by id. The host texts the link to a guest for no-login access.
export const mintShareLink = (username, data) => post(`/api/accounts/${encodeURIComponent(username)}/share`, data);
export const revokeShareLink = (username, id) => send(`/api/accounts/${encodeURIComponent(username)}/share/${id}`, 'DELETE');
export const getMetricsSettings = () => req('/api/settings/metrics');
export const saveMetricsSettings = (data) => post('/api/settings/metrics', data);
// Per-user module toggles (notes / lists / metrics / vouch / notebook — all default OFF). Booleans.
export const getFeatureSettings = () => req('/api/settings/features');
export const saveFeatureSettings = (data) => post('/api/settings/features', data);
// System-wide module availability (OWNER only): enable/disable a module for the WHOLE deployment. Booleans,
// keyed by module. A disabled module is hidden for every non-owner. (The web also reads the current map from
// /api/config's `systemModules` to filter the per-user list — this pair edits it.)
export const getSystemModules = () => req('/api/settings/system-modules');
export const saveSystemModules = (data) => post('/api/settings/system-modules', data);

// Notebooks: the acting account's isolated spaces. { enabled, currentId, notebooks:[{id,name}] }. Switch takes
// a notebook id (or null / 'main' for the default space); create takes a name (and switches into it). After
// either, the app reloads so every view reflects the chosen space.
export const getNotebooks = () => req('/api/notebooks');
export const switchNotebook = (id) => post('/api/notebooks/switch', { id });
export const createNotebook = (name) => post('/api/notebooks', { name });
export const getRetentionSettings = () => req('/api/settings/retention');
export const saveRetentionSettings = (data) => post('/api/settings/retention', data);
export const getWeatherSettings = () => req('/api/settings/weather');
export const saveWeatherSettings = (data) => post('/api/settings/weather', data);
export const getWakeups = () => req('/api/wakeups');
// The wide-screen gutter panel's read-only bundle: { startedTask, upcoming, mood, day }. Pure display —
// polling it never drains wakeups or triggers sweeps.
export const getSidebar = () => req('/api/sidebar');

// Impersonation picker (host-only). Returns { enabled, users, currentUserId, rootUserId }.
export const getUsers = () => req('/api/users');

// Setup mode (feature-flagged): backup / restore all settings.
export const getSetup = () => req('/api/setup');
export const backupSettings = () => req('/api/settings/backup');
export const restoreSettings = (data) => send('/api/settings/restore', 'POST', data);

// Instance backup (BACKUP_MODE-gated, owner only): the WHOLE installation as one zip. Status drives the
// Settings section (flag on? key file present?). Export can't ride req() — the response is a binary blob,
// not JSON — so it replicates req()'s error shape + impersonation header by hand. Restore has NO web
// endpoint on purpose: a backup is restored on a fresh install's setup wizard (or the restore CLI).
export const getInstanceStatus = () => req('/api/instance/status');
export async function exportBackup(includeKek = false) {
  const as = getAsUser();
  const r = await fetch(apiUrl(`/api/instance/export${includeKek ? '?kek=1' : ''}`), {
    headers: as ? { 'X-Fanad-User': as } : {},
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    if (r.status === 401) window.dispatchEvent(new Event('fanad:unauthorized'));
    const err = new Error(body.error || `HTTP ${r.status}`);
    err.status = r.status;
    err.body = body;
    throw err;
  }
  const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || 'fanad-backup.zip';
  return { blob: await r.blob(), name };
}

// Debug log panel (dev only; returns { enabled:false } unless the server has DEBUG_LOG set).
export const getDebugLog = (since = 0) => req(`/api/debug/logs?since=${since}`);

// AI activity log (operator diagnostic). Toggle is DB-backed + live; the viewer tails the ring buffer.
export const getAiLogSetting = () => req('/api/settings/ai-log');
export const saveAiLogSetting = (data) => post('/api/settings/ai-log', data);
export const getAiLog = (since = 0) => req(`/api/ai-log?since=${since}`);
export const clearAiLog = () => post('/api/ai-log/clear', {});

// Web login (auth mode 'simple'). Status is the boot call: { mode, authenticated, pendingTotp, userId,
// isOwner, allowRegistration, clientIp, username?, account? }. login/register may answer pendingTotp with
// a QR (finish 2FA enrollment); totpVerify completes it. saveAccount/getAuthSettings/saveAuthSettings are
// the root user's Security panel (owner-gated server-side once login is on).
export const getAuthStatus = () => req('/api/auth/status');
export const login = (data) => post('/api/auth/login', data);
export const logout = () => post('/api/auth/logout', {});
export const register = (data) => post('/api/auth/register', data);
export const totpSetup = (data) => post('/api/auth/totp/setup', data);
export const totpVerify = (code) => post('/api/auth/totp/verify', { code });
export const saveAccount = (data) => post('/api/auth/account', data);
export const getAuthSettings = () => req('/api/settings/auth');
export const saveAuthSettings = (data) => post('/api/settings/auth', data);
// Site URL (advanced, Security panel): the public base URL /web sign-in links point at. { url }.
export const getSiteSettings = () => req('/api/settings/site');
export const saveSiteSettings = (data) => post('/api/settings/site', data);
// Demo guard switches (Security panel): { demoPaused, vouchFrozen, demoSignupOpen, demoSignupsPerIp } — the owner's live switches + the per-IP /demo seat cap.
export const getGuardSettings = () => req('/api/settings/guard');
export const saveGuardSettings = (data) => post('/api/settings/guard', data);
// CLI claim tokens (Security panel): credentials for the `fanad <server> <token>` terminal client.
// Mint returns the raw token ONCE (only its hash is stored); the list never carries token material.
export const getCliTokens = () => req('/api/settings/cli-tokens');
export const mintCliToken = (data) => post('/api/settings/cli-tokens', data);
export const revokeCliToken = (id) => post(`/api/settings/cli-tokens/${id}/revoke`, {});

// ── Advanced module views (web-only GUI over the same data the chat commands manage). Each wrapper hits a
// REST route that reuses the server's existing repo/engine functions, so a web edit behaves like a chat one. ──

// Tasks (Kanban). getTasks returns every non-archived task (server sweeps snooze/expiry/sleep first); the
// board buckets them client-side. createTask runs the same LLM capture the chat does.
export const getTasks = () => req('/api/tasks');
export const createTask = (text) => post('/api/tasks', { text });
export const setTaskStatus = (id, status, extra = {}) => post(`/api/tasks/${id}/status`, { status, ...extra });
export const patchTask = (id, patch) => send(`/api/tasks/${id}`, 'PATCH', patch);
export const addTaskStep = (id, text) => post(`/api/tasks/${id}/steps`, { text });
export const setTaskStep = (id, i, done) => send(`/api/tasks/${id}/steps/${i}`, 'PATCH', { done });
export const removeTaskStep = (id, i) => send(`/api/tasks/${id}/steps/${i}`, 'DELETE');
export const saveTaskTemplate = (id, name) => post(`/api/tasks/${id}/template`, { name });
export const wakeTasks = (ids) => post('/api/tasks/wake', { ids });

// Notes (list + sidebar). getNotes/reviewNote already round-trip the inbox; these add create/edit/delete.
export const getNotes = (status = null) => req(`/api/notes${status ? `?status=${status}` : ''}`);
export const createNote = (text, title = null) => post('/api/notes', { text, title });
export const patchNote = (id, patch) => send(`/api/notes/${id}`, 'PATCH', patch);
export const deleteNote = (id) => send(`/api/notes/${id}`, 'DELETE');
export const reviewNote = (id, action) => post(`/api/notes/${id}/review`, { action });
export const recall = (q) => req(`/api/recall?q=${encodeURIComponent(q)}`);

// Lists (nested tree).
export const getListTree = () => req('/api/lists/tree');
export const createListItem = (title, parentId = null) => post('/api/lists', { title, parentId });
export const renameListItem = (id, title) => send(`/api/lists/${id}`, 'PATCH', { title });
export const deleteListItem = (id) => send(`/api/lists/${id}`, 'DELETE');

// Metrics (table + graph per metric).
export const getMetrics = () => req('/api/metrics');
export const createMetric = (data) => post('/api/metrics', data);
export const getMetricValues = (name, since = 0) => req(`/api/metrics/${encodeURIComponent(name)}/values?since=${since}`);
export const logMetricValue = (name, value, note = null) => post(`/api/metrics/${encodeURIComponent(name)}/values`, { value, note });
export const patchMetricValue = (name, id, patch) => send(`/api/metrics/${encodeURIComponent(name)}/values/${id}`, 'PATCH', patch);
export const deleteMetricValue = (name, id) => send(`/api/metrics/${encodeURIComponent(name)}/values/${id}`, 'DELETE');
export const getMetricChart = (name, range = '30d') => req(`/api/metrics/${encodeURIComponent(name)}/chart?range=${range}`);
export const getMetricChartData = (name, range = '30d') => req(`/api/metrics/${encodeURIComponent(name)}/chart-data?range=${range}`);

// Diet (canonical foods, recipes, the daily log + report). Its own opt-in module.
export const getFoods = () => req('/api/foods');
export const createFood = (data) => post('/api/foods', data);
export const updateFood = (id, patch) => send(`/api/foods/${id}`, 'PATCH', patch);
export const deleteFood = (id) => send(`/api/foods/${id}`, 'DELETE');
export const getRecipes = () => req('/api/recipes');
export const getRecipe = (id) => req(`/api/recipes/${id}`);
export const saveRecipe = (data) => post('/api/recipes', data);
export const deleteRecipe = (id) => send(`/api/recipes/${id}`, 'DELETE');
export const logDiet = (name, quantity, unit) => post('/api/diet/log', { name, quantity, unit });
export const patchDietLog = (id, patch) => send(`/api/diet/log/${id}`, 'PATCH', patch);
export const deleteDietLog = (id) => send(`/api/diet/log/${id}`, 'DELETE');
export const getDietLog = (date = null) => req(`/api/diet/log${date ? `?date=${date}` : ''}`);
export const getDietReport = (days = 30) => req(`/api/diet/report?days=${days}`);
export const getDietChart = (name, range = '30d') => req(`/api/diet/chart/${name}?range=${range}`);
export const getDietChartData = (name, range = '30d') => req(`/api/diet/chart-data/${name}?range=${range}`);
export const logDietWeight = (value, at = null) => post('/api/diet/weight', at ? { value, at } : { value });
export const getDietWeightLog = () => req('/api/diet/weight-log');
export const patchDietWeight = (id, patch) => send(`/api/diet/weight/${id}`, 'PATCH', patch);
export const deleteDietWeight = (id) => send(`/api/diet/weight/${id}`, 'DELETE');

// Medication (opt-in adherence logger). today = the ☑/☐ view; toggleMed ticks/unticks one med for today.
export const getMedToday = () => req('/api/med/today');
export const getMeds = () => req('/api/meds');
export const addMed = (name, dose) => post('/api/meds', { name, dose });
export const deleteMed = (name) => send(`/api/meds/${encodeURIComponent(name)}`, 'DELETE');
export const toggleMed = (name, taken) => post('/api/med/log', { name, taken });
export const logAllMeds = () => post('/api/med/all', {});
export const getMedTemplates = () => req('/api/med/templates');
export const saveMedTemplate = (name, meds) => post('/api/med/templates', { name, meds });
export const deleteMedTemplate = (name) => send(`/api/med/templates/${encodeURIComponent(name)}`, 'DELETE');
export const setMedReminder = (name, minute) => post(`/api/med/template/${encodeURIComponent(name)}/remind`, { minute });
export const getMedChartData = (name, range = '30d') => req(`/api/med/chart-data/${encodeURIComponent(name)}?range=${range}`);
export const setDietTarget = (value) => post('/api/diet/target', { value });
export const setDietWhatever = (on, date = null) => post('/api/diet/whatever', date ? { on, date } : { on });

// Templates (saved task blueprints).
export const getTemplates = () => req('/api/templates');
export const materializeTemplate = (name) => post(`/api/templates/${encodeURIComponent(name)}/materialize`, {});
export const deleteTemplate = (name) => send(`/api/templates/${encodeURIComponent(name)}`, 'DELETE');

// Journals (the opt-in trend journal: daily checklist entries + notes, AI summaries & trends).
const jpath = (name, rest = '') => `/api/journals/${encodeURIComponent(name)}${rest}`;
export const getJournals = () => req('/api/journals');
export const createJournal = (name) => post('/api/journals', { name });
export const deleteJournal = (name) => send(jpath(name), 'DELETE');
export const setJournalTemplate = (name, template) => post(jpath(name, '/template'), { template });
export const getJournalEntries = (name, from = null, to = null) =>
  req(jpath(name, `/entries?${from ? `from=${from}&` : ''}${to ? `to=${to}` : ''}`));
export const openJournalEntry = (name) => post(jpath(name, '/entry'), {});
export const checkJournalItems = (name, positions, done = null) => post(jpath(name, '/entry/check'), { positions, done });
export const addJournalNote = (name, text) => post(jpath(name, '/entry/note'), { text });
export const getJournalSummaries = (name, period = 'day', from = null, to = null) =>
  req(jpath(name, `/summaries?period=${period}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`));
export const makeJournalSummary = (name, period) => post(jpath(name, '/summary'), { period });
export const getJournalTrends = (name) => post(jpath(name, '/trends'), {});

// Batches (the opt-in process-batch module: template-snapshot checklist + dated log per run).
export const getBatchProcesses = () => req('/api/batches');
export const openNewBatch = (name) => post('/api/batches', { name });
export const getBatchRuns = (name) => req(`/api/batches/name/${encodeURIComponent(name)}/runs`);
export const deleteBatchProcess = (name) => send(`/api/batches/name/${encodeURIComponent(name)}`, 'DELETE');
export const getBatch = (id) => req(`/api/batches/${id}`);
export const checkBatchItems = (id, positions, done = null) => post(`/api/batches/${id}/check`, { positions, done });
export const addBatchLog = (id, text) => post(`/api/batches/${id}/log`, { text });
export const closeBatchRun = (id, outcome = '') => post(`/api/batches/${id}/close`, { outcome });
// Step tweaking on an open run + graduating the tweaks into a new template version.
export const addBatchStep = (id, text) => post(`/api/batches/${id}/steps`, { text });
export const editBatchStep = (id, i, text) => send(`/api/batches/${id}/steps/${i}`, 'PATCH', { text });
export const removeBatchStep = (id, i) => send(`/api/batches/${id}/steps/${i}`, 'DELETE');
export const saveBatchVersion = (id) => post(`/api/batches/${id}/save`, {});
// Recipe-version lineage + reversible reject/unreject (version number within the family).
export const getBatchVersions = (name) => req(`/api/batches/name/${encodeURIComponent(name)}/versions`);
export const rejectBatchVersion = (name, n) => post(`/api/batches/name/${encodeURIComponent(name)}/version/${n}/reject`, {});
export const unrejectBatchVersion = (name, n) => post(`/api/batches/name/${encodeURIComponent(name)}/version/${n}/unreject`, {});

// "Your data" tab — browse / edit / delete your own records.
export const getData = () => req('/api/data');
export const getDataRows = (entity, { limit = 50, offset = 0 } = {}) =>
  req(`/api/data/${entity}?limit=${limit}&offset=${offset}`);
export const updateDataRow = (entity, id, patch) => send(`/api/data/${entity}/${id}`, 'PATCH', patch);
export const deleteDataRow = (entity, id) => send(`/api/data/${entity}/${id}`, 'DELETE');
