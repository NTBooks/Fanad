// Phase-1/3 REST API. All user-scoped via repo.js.
import { Router } from 'express';
import { ingest, composeTaskFields } from '../ingest.js';
import { suggestTask, embedTask, recallNotes } from '../rag/index.js';
import { llmStatus } from '../services/llm/index.js';
import { getLlmConfig, setLlmConfig, getTelegramConfig, setTelegramConfig, getSlackConfig, setSlackConfig, getMetricsConfig, setMetricsConfig, getRetentionConfig, setRetentionConfig, getFeaturesConfig, setFeaturesConfig, getUserFeatures, setUserFeatures, OPTIN_FEATURES, getAiLogConfig, setAiLogConfig, getCurrentNotebookId, setCurrentNotebookId, clearCurrentNotebookId, getAuthConfig, setAuthConfig, getSiteConfig, setSiteConfig, getGuardConfig, setGuardConfig, getSystemModules, setSystemModules, isSystemModuleOn, getHomeAssistantConfig, setHomeAssistantConfig } from '../settings.js';
import { requireOwner, authModeIsSimple, rootCredentialsReady, createSession, setSessionCookie, mintCliToken, listCliTokens, revokeCliToken, CLI_TOKEN_DEFAULT_TTL_DAYS } from '../auth.js';
import { runAsLlmUser } from '../services/llm/context.js';
import { usageTodayAll } from '../llmBudget.js';
import { getBotIdentity } from '../botStatus.js';
import { parseAllowlist, ipAllowedBy, isLoopback, normalizeIp } from '../ipGate.js';
import { startTelegram } from '../channels/telegram.js';
import { startSlack } from '../channels/slack.js';
import { summarize } from '../summary.js';
import { handleMessage, applyReaction, isFeatureOnFor } from '../chat.js';
import { getWeatherConfig, setWeatherConfig, refreshWeather, currentWeather, weatherProblem } from '../weather.js';
import { checkConnection as haCheckConnection, testOutputs as haTestOutputs, discoverTargets as haDiscoverTargets, haProblem } from '../services/homeassistant.js';
import { getAppTimezone } from '../timezone.js';
import {
  defaultUserId, listUsers, listTasks, setTaskStatus, getTask, insertTask,
  updateTaskSummary, setTaskCategory, setTaskPriority, setTaskSchedule, setTaskReminder, setSnoozed,
  addTaskStep, setStepsDone, removeTaskStep,
  sweepSnoozed, expireDueTasks, sleepStaleTasks, wakeTasks,
  saveTemplate, materializeTemplate, listTemplates, deleteTemplate,
  listNotes, getNote, insertNote, updateNote, reviewNote, archiveNote, deleteNote,
  getListItem, listChildren, insertListItem, renameListItem, deleteListItem, listItemPath,
  listMetrics, getMetric, getOrCreateMetric, insertMetricValue, metricValuesSince, metricValuesBetween,
  updateMetricValue, deleteMetricValue,
  listFoods, upsertFood, updateFood, deleteFood,
  listRecipes, getRecipeById, createRecipe, setRecipeCookedWeight, deleteRecipe,
  addRecipeItem, listRecipeItems, clearRecipeItems,
  listUnseenWakeups, markWakeupsSeen, listMessagesBefore, listMessagesAfter, clearMessages, getImageForNote, setImageTask,
  listVouches, revokeVouchCascade, effectiveUserId, isOwner,
  listNotebooks, getNotebook, getNotebookByName, createNotebook,
  listJournals, createJournal, getJournal, deleteJournal, setJournalTemplate, getTemplate,
  getJournalEntry, listEntriesBetween, listJournalSummaries,
  getBatchById, listBatchNames, listBatches, listBatchLog, deleteBatchesByName,
  setDietDay, clearDietDay, getDietDay, listDietDays,
  getMedTemplate, deleteMed, deleteMedTemplate, setMedTemplateReminder,
  activeTimers, listSchedules, pendingReminders, latestMood,
} from '../repo.js';
import {
  newEntry, toggleEntryItems, noteToday, ensureDaySummary, ensureWeekSummary, ensureMonthSummary,
  trendReport, localDateKey, parseChecklist, backfillBudget,
} from '../journal.js';
import {
  openBatch, toggleBatchItems, checkAllBatchItems, logLine as batchLogLine, closeBatch,
  addBatchStep, editBatchStep, removeBatchStep, saveBatchAsVersion, batchVersions, rejectVersion, unrejectVersion,
} from '../batches.js';
import { findFood, findRecipe, recipeAsFood, portionOf, logFood, recipeSummary, ensureCaloriesMetric, recordWeight, setCalorieTarget } from '../diet.js';
import { todayData as medToday, catalogData as medCatalog, templatesData as medTemplatesData, webSetTaken as medSetTaken, webAddMed, webSaveTemplate, medAll, MED_DISCLAIMER } from '../medication.js';
import { accountsData, savePadData, addAccountData, removePadData, testSlotData, padSummary, mintShareLink, revokeShareData } from '../speeddial.js';
import { UNIT_TYPES, COUNT_UNIT_TYPES, toFoodUnits } from '../../shared/diet.js';
import { DAY_ROLLOVER_HOUR, dayStartOf } from '../../shared/timeframe.js';
import { resolveActingUserId } from '../actingUser.js';
import { renderMetricChart, getMetricChartData } from '../charts.js';
import { icsForTask } from '../calendar.js';
import * as dataBrowser from '../dataBrowser.js';
import { timeOfDay } from '../../shared/state.js';
import { CLOUD_PROVIDER_IDS } from '../../shared/providers.js';
import { getClientConfig, getConfigVersion, markConfigDirty } from '../clientConfig.js';
import { buildHaSummary } from '../haSummary.js';
import { subscribeUserEvents } from '../events.js';
import { config } from '../config.js';
import { getDebugLog } from '../debugLog.js';
import { getAiLog, clearAiLog, isAiLogOn } from '../aiLog.js';
import { db } from '../db.js';
import { kekSource } from '../crypto.js';
import { resolveKekFile } from '../dataDirPath.js';
import { buildInstancePackage } from '../instancePackage.js';
import { stampFor } from '../retention.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The running app's own version, stamped into instance backups so the restoring side can warn when a
// package comes from a newer Fanad than the one reading it.
const APP_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(config.root, 'package.json'), 'utf8')).version || null; } catch { return null; }
})();

const router = Router();

// Stamp every request with the user it acts as. Root by default; another existing user only when the
// host has turned on USER_IMPERSONATION and the client names them via X-Fanad-User (see actingUser.js).
// When web login is on, the SESSION decides instead (the header is ignored) and no session means nobody —
// the 401 here is belt-and-braces behind index.js's apiAuthGate, never a path a logged-in client hits.
// This is the single seam where the web's acting user is chosen — every handler reads req.userId via uid(req).
router.use((req, res, next) => {
  req.userId = resolveActingUserId(req.get('X-Fanad-User'), req.webSession, req.cliAuth);
  if (req.userId == null) return res.status(401).json({ error: 'auth required' });
  // Demo kill switch: while paused, the whole API is closed to everyone but the owner (root, or the
  // platform account that claimed the bot, reached via a /web-link session). /api/auth is mounted
  // separately (index.js) so login itself keeps working — the owner can still get in to unpause.
  if (getGuardConfig().demoPaused && !isOwner(req.userId)) {
    return res.status(503).json({ error: 'The demo is paused — back soon.', code: 'DEMO_PAUSED' });
  }
  // The rest of the request runs as this identity for LLM budgeting (AsyncLocalStorage propagates through
  // every async handler) — so /chat, /guess, journal trends, task capture all charge the acting user's cap.
  runAsLlmUser(req.userId, () => next());
});
const uid = (req) => req.userId;
// The user whose DATA a request reads/writes: the acting account's CURRENT notebook (its own tasks/notes/
// lists/transcript), or that account itself when in the main space. So the web's tasks/notes/data/chat views
// follow whatever notebook the operator switched into via chat — same effective-user seam the brain uses.
// `uid` (the identity) still drives the module gate, the impersonation picker, vouches, and settings. When no
// notebook is active (the default), dataUid === uid, so nothing changes.
const dataUid = (req) => effectiveUserId(uid(req));

// Optional ?notebook=<id|main> override for READ endpoints only (the HA dashboard's notebook picker). The id
// must be a notebook OWNED by the acting account — anything unknown/foreign falls back to the current
// effective user, so a token can only ever read its own account's spaces. "main"/"0" = the account's main
// space. Reads only: writes keep using dataUid (the real current notebook the operator switched into).
const dataUidForRead = (req) => {
  const nb = req.query?.notebook;
  if (nb == null || nb === '') return dataUid(req);
  const account = uid(req);
  if (nb === 'main' || nb === '0') return account;
  const id = Number(nb);
  if (Number.isInteger(id) && id > 0 && listNotebooks(account).some((n) => n.id === id)) return id;
  return dataUid(req);
};

// A positive-integer route/query param, or null. Garbage in ":id" must not reach the SQL binding layer as
// NaN (an opaque driver error at best, an uncaught 500 on routes without a try/catch) — reject it here.
const idParam = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

// Budget/capacity throws from the LLM chokepoint (llmBudget.js / llm/limiter.js) → a 429 with a code the
// client can phrase, instead of the route's generic 500/502. Returns true when it handled the response.
// (/chat and /action never see these — handleMessage already converts them into friendly bot replies.)
const llmLimited = (err, res) => {
  if (err?.code === 'LLM_BUDGET') { res.status(429).json({ error: 'You’ve hit today’s AI limit — it resets at midnight.', code: err.code }); return true; }
  if (err?.code === 'LLM_BUSY') { res.status(429).json({ error: 'The assistant is at capacity right now — give it a minute and try again.', code: err.code }); return true; }
  return false;
};

// Gate a route behind a PER-USER opt-in module (notes / lists / metrics), the same check the chat surface
// uses — defense-in-depth behind the web hiding the icon. Tasks/templates are core (always on) so they skip
// this. Mirrors the /notebooks routes: 403 when the acting user hasn't turned the module on. The gate reads
// the IDENTITY (uid), not dataUid — a module is on for the account, whatever notebook it's currently in.
const requireFeature = (name) => (req, res, next) =>
  (isFeatureOnFor(uid(req), name) ? next() : res.status(403).json({ error: `The ${name} module is off for you.` }));

// Map a stored message row to the client shape (shared by history + the live poll). The status chip rides
// in raw_json. (Captured photos are a Telegram-only feature now — they aren't persisted or shown on web.)
// `reaction` is Fanad's stamp on the USER's message (chat.js stores it on the row) — emitted for 'me' rows
// only, so it can never collide with the user's own tap-reaction on bot bubbles (same client field name).
function toClientMessage(r) {
  let status = null; let html = false; let reaction = null; let listing = false; let listKind = null; let logged = false;
  if (r.raw_json) {
    try {
      const j = JSON.parse(r.raw_json);
      status = j?.status || null; html = !!j?.html; reaction = j?.reaction || null;
      listing = !!j?.listing; listKind = j?.listKind || null; logged = !!j?.logged;
    } catch { /* ignore */ }
  }
  const role = r.role === 'bot' ? 'bot' : 'me';
  // `listing`/`listKind` let the client keep just ONE live task list (supersede on a new /tasks) and swap a
  // refreshed list into the right bubble — same as a live turn. `logged` gates the ambient status chip, so a
  // reloaded task-capture keeps its mood · time · weather header (matches the live send response). Bot rows only.
  return { id: r.id, role, text: r.text, at: r.received_at, status, html, reaction: role === 'me' ? reaction : null, listing: role === 'bot' && listing, listKind: role === 'bot' ? listKind : null, logged: role === 'bot' && logged };
}
// Which channel(s) the web transcript covers for the acting user: root → its own 'web' turns; an
// impersonated user → all channels (a Telegram account has only 'telegram' turns). null = all channels.
const webChannelFor = (req) => (uid(req) === defaultUserId() ? 'web' : null);

// ── debug log: dev aid; serves captured server logs to the web panel, but only when DEBUG_LOG is set.
// Owner-gated (requireOwner is a no-op while login is off): it tees EVERY user's server-side text. ──
router.get('/debug/logs', requireOwner, (req, res) => {
  if (!config.debugLog) return res.json({ enabled: false, logs: [], seq: 0 });
  const since = Number(req.query.since) || 0;
  res.json({ enabled: true, ...getDebugLog(since) });
});

// ── AI activity log: operator diagnostic. The toggle lives in Settings (DB-backed + live), so unlike the
// dev-only /debug/logs this works without a restart. Reports enabled:false (and no data) while it's off. ──
router.get('/ai-log', requireOwner, (req, res) => {
  if (!isAiLogOn()) return res.json({ enabled: false, logs: [], seq: 0 });
  const since = Number(req.query.since) || 0;
  res.json({ enabled: true, ...getAiLog(since) });
});
router.post('/ai-log/clear', requireOwner, (_req, res) => res.json(clearAiLog()));
router.get('/settings/ai-log', requireOwner, (_req, res) => res.json(getAiLogConfig()));
router.post('/settings/ai-log', requireOwner, (req, res) => {
  try {
    const patch = {};
    if (typeof req.body?.enabled === 'boolean') patch.enabled = req.body.enabled;
    res.json(setAiLogConfig(patch));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── users: host-only impersonation picker. Off → report disabled with an empty list so the web hides the
// dropdown and stays root. On → list every account plus the user resolved for THIS request, so the client
// can reflect (and the operator can change) the active selection. No secrets are returned. ──
router.get('/users', (req, res) => {
  // Impersonation is inert while web login is on — the session is the identity (see actingUser.js).
  if (!config.userImpersonation || authModeIsSimple()) return res.json({ enabled: false, users: [], currentUserId: uid(req) });
  res.json({ enabled: true, currentUserId: uid(req), rootUserId: defaultUserId(), users: listUsers() });
});

// ── chat: the single text-in / text-out endpoint the web UI uses (mirrors Telegram) ──
router.post('/chat', async (req, res) => {
  try {
    const text = (req.body?.text ?? '').toString();
    if (!text.trim()) return res.status(400).json({ error: 'Empty message' });
    res.json(await handleMessage({ userId: uid(req), text, channel: 'web' }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── action: a clicked interactive button (a structured token from server/menu.js) → the SAME dispatcher
// Telegram uses, returning the refreshed { reply, buttons } as a fresh turn (web appends; Telegram edits
// in place — same brain output). ──
router.post('/action', async (req, res) => {
  try {
    const data = (req.body?.data ?? '').toString();
    if (!data.trim()) return res.status(400).json({ error: 'data required' });
    const out = await handleMessage({ userId: uid(req), action: data, channel: 'web' });
    delete out.reaction; // a tapped button has no user message to react to (mirrors Telegram skipping it)
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── chat history: paginated, oldest-first pages backing the web UI's infinite scroll-back. `before` is
// a keyset cursor (the oldest message id the client already has); omit it for the most recent page. ──
router.get('/chat/history', (req, res) => {
  try {
    const before = req.query.before ? idParam(req.query.before) : null;
    if (req.query.before && before == null) return res.status(400).json({ error: 'before must be a message id' });
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 30, 100));
    const rows = listMessagesBefore(dataUid(req), { channel: webChannelFor(req), beforeId: before, limit });
    // Repo returns newest-first; emit oldest-first so the client can prepend a contiguous block.
    const messages = rows.reverse().map(toClientMessage);
    res.json({ messages, hasMore: rows.length === limit });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── chat (live): messages NEWER than `after` (the newest id the client holds). The web polls this so turns
// that arrive asynchronously — e.g. from Telegram while impersonating that user — appear without a manual
// refresh. Same user/channel scoping as history; oldest-first so the client appends them in order. ──
router.get('/chat/new', (req, res) => {
  try {
    const after = Number(req.query.after) || 0;
    const rows = listMessagesAfter(dataUid(req), { channel: webChannelFor(req), afterId: after, limit: 100 });
    res.json({ messages: rows.map(toClientMessage) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── live events: the SSE "poke" channel. Events carry only a TYPE ('chat' / 'wakeup' /
// 'config') — the client then calls the existing endpoints, which preserves drain-on-read semantics for
// wakeups and reuses all existing serialization; polling is a trivially identical fallback. Subscribed
// for the acting identity AND its current notebook (a hint channel: over-poking is harmless). Sits
// behind apiAuthGate + ipGate automatically (it's under /api); the CLI reads it via fetch, which —
// unlike browser EventSource — can send the Authorization header. ──
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // proxies (Coolify/Traefik/nginx) must not buffer an event stream
  });
  res.write(': connected\n\n');
  const unsub = subscribeUserEvents([uid(req), dataUid(req)], (type) => res.write(`data: ${type}\n\n`));
  const ping = setInterval(() => res.write(': ping\n\n'), 25000); // keep proxies/idle sockets alive
  req.on('close', () => { clearInterval(ping); unsub(); });
});

// ── chat history: truncate the stored conversation. scope 'all' wipes it; '30d' keeps the last 30 days.
// Tasks/notes/snapshots are kept (their message back-links are nulled). Same user/channel scope as the
// transcript, so impersonating an account clears that account's log, not root's. ──
router.post('/chat/history/clear', (req, res) => {
  try {
    const scope = (req.body?.scope ?? '').toString();
    let olderThanMs = null;
    if (scope === '30d') olderThanMs = Date.now() - 30 * 86400000;
    else if (scope !== 'all') return res.status(400).json({ error: 'scope must be "all" or "30d"' });
    res.json({ ok: true, removed: clearMessages(dataUid(req), { olderThanMs, channel: webChannelFor(req) }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── react: an emoji left on one of Fanad's replies → a learning signal ──
router.post('/react', (req, res) => {
  try {
    const emoji = (req.body?.emoji ?? '').toString();
    if (!emoji) return res.status(400).json({ error: 'emoji required' });
    if (emoji.length > 16) return res.status(400).json({ error: 'that is not an emoji' }); // 16 UTF-16 units covers ZWJ sequences
    // The client echoes back the ref a bot turn carried. Rebuild it from the typed fields applyReaction
    // actually reads instead of passing the raw body object into the outcome ledger.
    const r = req.body?.ref;
    const ref = r && typeof r === 'object' && Number.isInteger(r.taskId) && typeof r.category === 'string'
      ? { taskId: r.taskId, category: r.category.slice(0, 64) } : null;
    res.json({ sentiment: applyReaction(uid(req), emoji, ref) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── capture ──
router.post('/ingest', async (req, res) => {
  try {
    const text = (req.body?.text ?? '').toString();
    if (!text.trim()) return res.status(400).json({ error: 'Empty message' });
    res.json(await ingest({ channel: 'web', userId: dataUid(req), text }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── tasks (core: always on). The web Kanban reads /tasks and buckets client-side into Not Started /
// Started / Done Today. We run the same pre-retrieval sweeps the chat listing does first (un-snooze elapsed,
// expire past-deadline, auto-sleep the stale) so the board reflects reality, then return every non-archived
// task — slept ones included (client filters them into the "Slept" drawer by slept_at). ──
router.get('/tasks', (req, res) => {
  const u = dataUidForRead(req);
  sweepSnoozed(u); expireDueTasks(u); sleepStaleTasks(u);
  res.json({ tasks: listTasks(u) });
});

// Create a task the same way the note-promote route does: LLM-composed fields → insert → embed, so a task
// added from the board behaves exactly like one captured in chat (category/effort/deadline all inferred).
router.post('/tasks', async (req, res) => {
  try {
    const u = dataUid(req);
    const text = (req.body?.text ?? '').toString().trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    const f = await composeTaskFields({ body: text, userId: u });
    const task = insertTask({
      userId: u, summary: f.summary, category: f.category, effortLevel: f.effortLevel,
      dueAt: f.dueAt, dueKind: f.dueKind, originalText: f.originalText, llmSummary: f.llmSummary,
      priority: f.priority, remindAt: f.remindAt, linkJson: f.linkJson,
    });
    await embedTask(task);
    res.json({ task });
  } catch (err) {
    if (llmLimited(err, res)) return;
    res.status(500).json({ error: err.message });
  }
});

router.post('/tasks/:id/status', (req, res) => {
  try {
    const id = idParam(req.params.id);
    const u = dataUid(req);
    // "snoozed" via this route means a manual snooze (a chosen duration); default 1 day if none supplied, so
    // the row gets a snoozed_until (setTaskStatus alone wouldn't) and sweepSnoozed can later revive it.
    if (req.body?.status === 'snoozed') {
      const until = Number(req.body?.until) || (Date.now() + 86400000);
      const task = id == null ? null : setSnoozed(u, id, until);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      return res.json({ task });
    }
    const task = id == null ? null : setTaskStatus(u, id, req.body?.status);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json({ task });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Post-hoc edits (the card editor): summary / category / priority / schedule (deadline + optional reminder) /
// reminder-only. Each maps to the repo setter the interactive menus already use, so web edits behave like
// chat edits. Only the fields present in the body are touched. Returns the updated task.
router.patch('/tasks/:id', (req, res) => {
  try {
    const id = idParam(req.params.id);
    const u = dataUid(req);
    if (id == null || !getTask(u, id)) return res.status(404).json({ error: 'Task not found' });
    const b = req.body || {};
    let task = getTask(u, id);
    if (typeof b.summary === 'string' && b.summary.trim()) task = updateTaskSummary(u, id, b.summary.trim());
    if (typeof b.category === 'string') task = setTaskCategory(u, id, b.category);
    if ('priority' in b) task = setTaskPriority(u, id, b.priority);
    // A full schedule replace (deadline ± reminder) vs. a reminder-only tweak — mirror the two repo setters.
    if ('dueAt' in b || 'dueKind' in b) {
      task = setTaskSchedule(u, id, { dueAt: b.dueAt ?? null, dueKind: b.dueKind ?? null, remindAt: b.remindAt ?? null });
    } else if ('remindAt' in b) {
      task = setTaskReminder(u, id, b.remindAt ?? null);
    }
    res.json({ task });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── task steps (an ordered checklist on the task). Add one, toggle done/undone by 1-based index, remove one.
router.post('/tasks/:id/steps', (req, res) => {
  try {
    const id = idParam(req.params.id);
    const text = (req.body?.text ?? '').toString().trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    const out = id == null ? null : addTaskStep(dataUid(req), id, text);
    if (!out) return res.status(404).json({ error: 'Task not found' });
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/tasks/:id/steps/:i', (req, res) => {
  try {
    const id = idParam(req.params.id);
    const i = idParam(req.params.i); // 1-based step index
    const out = id == null || i == null ? null : setStepsDone(dataUid(req), id, [i], req.body?.done !== false);
    if (!out) return res.status(404).json({ error: 'Task not found' });
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/tasks/:id/steps/:i', (req, res) => {
  try {
    const id = idParam(req.params.id);
    const i = idParam(req.params.i);
    const out = id == null || i == null ? null : removeTaskStep(dataUid(req), id, [i]);
    if (!out) return res.status(404).json({ error: 'Task not found' });
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Save a task as a reusable template (the calm alternative to recurrence). Body { name }.
router.post('/tasks/:id/template', (req, res) => {
  try {
    const id = idParam(req.params.id);
    const name = (req.body?.name ?? '').toString().trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    const out = id == null ? null : saveTemplate(dataUid(req), id, name);
    if (!out) return res.status(404).json({ error: 'Task not found' });
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Wake auto-slept tasks back onto the board. Body { ids: [taskId,…] }.
router.post('/tasks/wake', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  res.json({ woke: wakeTasks(dataUid(req), ids) });
});

// ── "add to calendar": serve a dated task's .ics (the web 📅 link points here). User-scoped, so one user
// can never fetch another's event. The user makes it recur in their own calendar — Fanad has no recurrence. ──
router.get('/tasks/:id/event.ics', (req, res) => {
  const id = idParam(req.params.id); // no try/catch on this route — a NaN binding would 500, not 404
  const task = id == null ? null : getTask(dataUid(req), id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  const ev = icsForTask(task);
  if (!ev) return res.status(404).json({ error: 'This task has no date.' });
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${ev.filename}"`);
  res.send(ev.ics);
});

// ── data browser: the web-only "Your data" tab — browse / edit / delete your own records ──
router.get('/data', (req, res) => res.json({ entities: dataBrowser.entities(dataUid(req)) }));

router.get('/data/:entity', (req, res) => {
  try {
    res.json(dataBrowser.rows(dataUid(req), req.params.entity, { limit: req.query.limit, offset: req.query.offset }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/data/:entity/:id', (req, res) => {
  try {
    const id = idParam(req.params.id);
    if (id == null) return res.status(404).json({ error: 'Not found' });
    res.json({ row: dataBrowser.editRow(dataUid(req), req.params.entity, id, req.body || {}) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/data/:entity/:id', (req, res) => {
  try {
    const id = idParam(req.params.id);
    if (id == null || !dataBrowser.removeRow(dataUid(req), req.params.entity, id)) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── setup mode: backup / restore ALL settings to move between servers (SETUP_MODE; off in production) ──
router.get('/setup', (_req, res) => res.json({ setupMode: config.setupMode }));

router.get('/settings/backup', requireOwner, (_req, res) => {
  if (!config.setupMode) return res.status(404).json({ error: 'Backup is off (set SETUP_MODE).' });
  const llm = getLlmConfig();
  const tg = getTelegramConfig();
  const slack = getSlackConfig();
  // Decrypted on the way out so the file is portable to a box with a different key; restore re-encrypts it.
  // The file therefore contains secrets — the UI warns to keep it safe (and SETUP_MODE is off in prod).
  res.json({
    kind: 'fanad-settings-backup', version: 1, exportedAt: Date.now(),
    settings: {
      llm: {
        provider: llm.provider, embedProvider: llm.embedProvider, baseUrl: llm.baseUrl,
        chatModel: llm.chatModel, embedModel: llm.embedModel, apiKey: llm.apiKey,
        openai: llm.openai, gemini: llm.gemini, anthropic: llm.anthropic,
      },
      telegram: { botToken: tg.botToken, enabled: tg.enabled, allowedUsername: tg.allowedUsername },
      slack: {
        botToken: slack.botToken, appToken: slack.appToken, signingSecret: slack.signingSecret,
        mode: slack.mode, enabled: slack.enabled, allowedSlack: slack.allowedSlack,
      },
      metrics: getMetricsConfig(),
      retention: getRetentionConfig(),
      features: getFeaturesConfig(),
      weather: getWeatherConfig(),
    },
  });
});

// NOTE: the `auth` settings key (mode / registration / IP allowlist) deliberately does NOT ride backup or
// restore — restoring mode 'simple' onto a box whose root has no credentials would be a guaranteed lockout
// (password hashes + TOTP secrets live on the users rows, which a settings backup never carries). The
// `site` key (Site URL) stays out for the same deployment-specific reason: it names the OLD server's address.
router.post('/settings/restore', requireOwner, (req, res) => {
  if (!config.setupMode) return res.status(404).json({ error: 'Restore is off (set SETUP_MODE).' });
  const s = req.body?.settings;
  if (req.body?.kind !== 'fanad-settings-backup' || !s || typeof s !== 'object') {
    return res.status(400).json({ error: 'Not a Fanad settings backup file.' });
  }
  const restored = [];
  // Setters re-encrypt secrets with THIS box's key and bust the in-memory caches.
  if (s.llm && typeof s.llm === 'object') { setLlmConfig(s.llm); restored.push('llm'); }
  if (s.telegram && typeof s.telegram === 'object') { setTelegramConfig(s.telegram); restored.push('telegram'); }
  if (s.slack && typeof s.slack === 'object') { setSlackConfig(s.slack); restored.push('slack'); }
  if (s.metrics && typeof s.metrics === 'object') { setMetricsConfig(s.metrics); restored.push('metrics'); }
  if (s.retention && typeof s.retention === 'object') { setRetentionConfig(s.retention); restored.push('retention'); }
  if (s.features && typeof s.features === 'object') { setFeaturesConfig(s.features); restored.push('features'); }
  if (s.weather && typeof s.weather === 'object') { setWeatherConfig(s.weather); restored.push('weather'); }
  res.json({ ok: true, restored });
});

// ── instance backup: the WHOLE installation (DB + config.json + images + retention zips) as one zip, for
// migrating between servers / a full backup. Gated by BACKUP_MODE (env, restart to change, works in prod —
// unlike SETUP_MODE) on top of requireOwner: the artifact is the crown jewels, so the capability is off
// unless the operator deliberately turned it on. Restore deliberately has NO live endpoint — a backup is
// restored on a box where the server isn't running (the setup wizard's drag-and-drop, or restore-backup.js).
router.get('/instance/status', requireOwner, (_req, res) => {
  res.json({
    backupMode: config.backupMode,
    kekSource: kekSource(),                    // 'env' | 'temp' | 'none' — drives the KEK checkbox vs hint
    kekFileExists: existsSync(resolveKekFile(config.dataDir)),
  });
});

router.get('/instance/export', requireOwner, (req, res) => {
  if (!config.backupMode) return res.status(404).json({ error: 'Backups are off (set BACKUP_MODE=1 and restart).' });
  try {
    // Fully synchronous on purpose: the WAL checkpoint and the file reads happen in one tick, so no other
    // request can write in between — that's the consistency argument. Blocks the event loop for the
    // duration; acceptable for a single-operator box exporting occasionally.
    const now = Date.now();
    const { zip } = buildInstancePackage({
      db, dataDir: config.dataDir, kekFile: resolveKekFile(config.dataDir), kekSource: kekSource(),
      appVersion: APP_VERSION, includeKek: req.query.kek === '1', now,
    });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="fanad-backup-${stampFor(now)}.zip"`);
    res.send(zip);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── summaries: what did I do? (§5) ──
router.get('/summary', (req, res) => res.json(summarize(dataUid(req), req.query.range || 'this_week')));

// ── data-grounded suggestions (§4) ──
router.post('/suggest/task', async (req, res) => {
  try {
    const state = { ...(req.body?.state || {}) };
    if (!state.timeOfDay) state.timeOfDay = timeOfDay();
    res.json(await suggestTask({ userId: dataUid(req), state }));
  } catch (err) {
    if (llmLimited(err, res)) return;
    res.status(500).json({ error: err.message });
  }
});

// ── notes: self-voicemail inbox (§15) ──
router.get('/notes', (req, res) => res.json({ notes: listNotes(dataUidForRead(req), { status: req.query.status || null }) }));

router.get('/recall', async (req, res) => {
  try { res.json({ notes: await recallNotes(dataUid(req), (req.query.q || '').toString()) }); }
  catch (err) { if (llmLimited(err, res)) return; res.status(500).json({ error: err.message }); }
});

// Review a note: promote it into a task, keep it, or archive it.
router.post('/notes/:id/review', async (req, res) => {
  try {
    const id = idParam(req.params.id);
    const u = dataUid(req);
    const note = id == null ? null : getNote(u, id);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    const action = req.body?.action;
    if (action === 'archive') return res.json({ note: archiveNote(u, id) });
    if (action === 'keep') return res.json({ note: reviewNote(u, id) });
    if (action === 'promote') {
      const f = await composeTaskFields({ body: note.text, userId: u });
      const task = insertTask({
        userId: u, summary: f.summary, category: f.category, effortLevel: f.effortLevel,
        dueAt: f.dueAt, dueKind: f.dueKind, originalText: f.originalText, llmSummary: f.llmSummary,
        priority: f.priority, remindAt: f.remindAt, linkJson: f.linkJson,
      });
      await embedTask(task);
      const img = getImageForNote(u, id); // carry a photo attached to the note over to the new task
      if (img) setImageTask(u, img.id, task.id);
      return res.json({ note: reviewNote(u, id, { promotedTaskId: task.id }), task });
    }
    return res.status(400).json({ error: 'unknown action' });
  } catch (err) {
    if (llmLimited(err, res)) return;
    res.status(400).json({ error: err.message });
  }
});

// Create a note (the web Notes view's "new note" composer). Gated like the module's other web mutations.
router.post('/notes', requireFeature('notes'), (req, res) => {
  try {
    const text = (req.body?.text ?? '').toString().trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() || null : null;
    res.json({ note: insertNote({ userId: dataUid(req), text, title }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Edit a note's text/title in place.
router.patch('/notes/:id', requireFeature('notes'), (req, res) => {
  try {
    const id = idParam(req.params.id);
    const b = req.body || {};
    const patch = {};
    if (typeof b.text === 'string') patch.text = b.text;
    if ('title' in b) patch.title = b.title;
    const note = id == null ? null : updateNote(dataUid(req), id, patch);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    res.json({ note });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/notes/:id', requireFeature('notes'), (req, res) => {
  const id = idParam(req.params.id);
  if (id == null || !deleteNote(dataUid(req), id)) return res.status(404).json({ error: 'Note not found' });
  res.json({ ok: true });
});

// ── lists: a nestable outliner (opt-in module). The web Lists view renders the whole tree; these routes are
// the CRUD behind it. `parentId` null = a top-level list. Delete cascades to the subtree (repo/db FK). ──
router.get('/lists/tree', requireFeature('lists'), (req, res) => {
  const u = dataUid(req);
  // Depth-first assembly from listChildren (each row already carries child_count). Bounded by a visited set
  // so a corrupt parent cycle can't spin forever; the tree is the user's own data, always small.
  const build = (parentId, seen) => listChildren(u, parentId).map((row) => {
    if (seen.has(row.id)) return { id: row.id, title: row.title, children: [] };
    seen.add(row.id);
    return { id: row.id, title: row.title, child_count: row.child_count, children: build(row.id, seen) };
  });
  res.json({ tree: build(null, new Set()) });
});

router.get('/lists', requireFeature('lists'), (req, res) => {
  const parentId = req.query.parentId ? idParam(req.query.parentId) : null;
  res.json({ items: listChildren(dataUid(req), parentId), path: parentId ? listItemPath(dataUid(req), parentId) : [] });
});

router.post('/lists', requireFeature('lists'), (req, res) => {
  try {
    const u = dataUid(req);
    const title = (req.body?.title ?? '').toString().trim();
    if (!title) return res.status(400).json({ error: 'title required' });
    const parentId = req.body?.parentId != null ? idParam(req.body.parentId) : null;
    // A child under a named parent must be a real, owned parent — reject a forged/foreign id rather than
    // silently orphaning the row at top level.
    if (req.body?.parentId != null && (parentId == null || !getListItem(u, parentId))) {
      return res.status(404).json({ error: 'Parent not found' });
    }
    res.json({ item: insertListItem({ userId: u, parentId, title }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/lists/:id', requireFeature('lists'), (req, res) => {
  const id = idParam(req.params.id);
  const title = (req.body?.title ?? '').toString().trim();
  if (!title) return res.status(400).json({ error: 'title required' });
  const item = id == null ? null : renameListItem(dataUid(req), id, title);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  res.json({ item });
});

router.delete('/lists/:id', requireFeature('lists'), (req, res) => {
  const id = idParam(req.params.id);
  if (id == null || !deleteListItem(dataUid(req), id)) return res.status(404).json({ error: 'Item not found' });
  res.json({ ok: true });
});

// ── metrics: user-defined trackers (opt-in module). List them, read a metric's values over a range (for the
// table), log a value, and render its graph (reusing the exact server chart the chat's /chart draws). ──
router.get('/metrics', requireFeature('metrics'), (req, res) => res.json({ metrics: listMetrics(dataUid(req)) }));

router.post('/metrics', requireFeature('metrics'), (req, res) => {
  try {
    const u = dataUid(req);
    const name = (req.body?.name ?? '').toString().trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    const b = req.body || {};
    const metric = getOrCreateMetric(u, name, {
      unit: typeof b.unit === 'string' && b.unit.trim() ? b.unit.trim() : null,
      aggregation: ['sum', 'avg', 'last', 'max', 'min'].includes(b.aggregation) ? b.aggregation : 'sum',
      target: b.target != null && b.target !== '' ? Number(b.target) : null,
      measurementType: b.measurementType === 'point' ? 'point' : 'tallied',
    });
    res.json({ metric });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/metrics/:name/values', requireFeature('metrics'), (req, res) => {
  const u = dataUid(req);
  const m = getMetric(u, req.params.name);
  if (!m) return res.status(404).json({ error: 'Metric not found' });
  const since = req.query.since != null ? Number(req.query.since) || 0 : 0;
  res.json({ metric: m, values: metricValuesSince(u, m.id, since) });
});

router.post('/metrics/:name/values', requireFeature('metrics'), (req, res) => {
  try {
    const u = dataUid(req);
    const m = getMetric(u, req.params.name);
    if (!m) return res.status(404).json({ error: 'Metric not found' });
    const value = Number(req.body?.value);
    if (!Number.isFinite(value)) return res.status(400).json({ error: 'value must be a number' });
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() || null : null;
    const id = insertMetricValue({ userId: u, metricId: m.id, value, note });
    res.json({ ok: true, id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Edit a single logged value in place (the web table's ✏️). Only value/note — the timestamp stays as logged.
router.patch('/metrics/:name/values/:id', requireFeature('metrics'), (req, res) => {
  try {
    const u = dataUid(req);
    const m = getMetric(u, req.params.name);
    if (!m) return res.status(404).json({ error: 'Metric not found' });
    const id = idParam(req.params.id);
    const patch = {};
    if (req.body?.value !== undefined) {
      const value = Number(req.body.value);
      if (!Number.isFinite(value)) return res.status(400).json({ error: 'value must be a number' });
      patch.value = value;
    }
    if ('note' in (req.body || {})) patch.note = typeof req.body.note === 'string' ? req.body.note.trim() || null : null;
    const row = id == null ? null : updateMetricValue(u, m.id, id, patch);
    if (!row) return res.status(404).json({ error: 'Value not found' });
    res.json({ value: row });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete one row by id — precise surgery on any row; chat's `undo` only pops the most recent action.
router.delete('/metrics/:name/values/:id', requireFeature('metrics'), (req, res) => {
  const u = dataUid(req);
  const m = getMetric(u, req.params.name);
  if (!m) return res.status(404).json({ error: 'Metric not found' });
  const id = idParam(req.params.id);
  if (id == null || !deleteMetricValue(u, m.id, id)) return res.status(404).json({ error: 'Value not found' });
  res.json({ ok: true });
});

// The metric's graph, as the same PNG data-URI the chat shows (echarts→SVG→PNG via charts.js). The web
// renders it as an <img>, so no client charting library is needed.
router.get('/metrics/:name/chart', requireFeature('metrics'), (req, res) => {
  const chart = renderMetricChart(dataUid(req), req.params.name, (req.query.range || '30d').toString());
  if (!chart) return res.status(404).json({ error: 'Metric not found' });
  res.json({ image: chart.image, label: chart.label, points: chart.points });
});

// The same chart as raw series data — the web draws it client-side (interactive, theme-aware). The
// server stays the source of truth for labels/target/units; an empty series is a valid answer.
router.get('/metrics/:name/chart-data', requireFeature('metrics'), (req, res) => {
  const d = getMetricChartData(dataUid(req), req.params.name, (req.query.range || '30d').toString());
  if (!d) return res.status(404).json({ error: 'Metric not found' });
  res.json(d);
});

// ── diet: the canonical-foods calorie tracker (its OWN opt-in module — separate from metrics, though
// portions land on the calories metric). Food library CRUD, recipes (snapshot ÷ cooked weight), GUI
// logging (no LLM here — unknown foods are taught in chat or added explicitly), the daily log, and the
// report (calorie days + weight series). ──
router.get('/foods', requireFeature('diet'), (req, res) => res.json({ foods: listFoods(dataUid(req)) }));

const foodBody = (b = {}) => ({
  name: (b.name ?? '').toString().trim(),
  calPerUnit: Number(b.calPerUnit),
  unitType: UNIT_TYPES.includes(b.unitType) ? b.unitType : 'ounce',
});

router.post('/foods', requireFeature('diet'), (req, res) => {
  const f = foodBody(req.body);
  if (!f.name) return res.status(400).json({ error: 'name required' });
  if (!(f.calPerUnit > 0)) return res.status(400).json({ error: 'calPerUnit must be a positive number' });
  res.json({ food: upsertFood(dataUid(req), { ...f, source: 'user' }) });
});

router.patch('/foods/:id', requireFeature('diet'), (req, res) => {
  const id = idParam(req.params.id);
  const b = req.body || {};
  const patch = {};
  if (b.name != null) { patch.name = b.name.toString().trim(); if (!patch.name) return res.status(400).json({ error: 'name required' }); }
  if (b.calPerUnit != null) { patch.calPerUnit = Number(b.calPerUnit); if (!(patch.calPerUnit > 0)) return res.status(400).json({ error: 'calPerUnit must be a positive number' }); }
  if (b.unitType != null) { if (!UNIT_TYPES.includes(b.unitType)) return res.status(400).json({ error: 'bad unitType' }); patch.unitType = b.unitType; }
  const food = id == null ? null : updateFood(dataUid(req), id, patch);
  if (!food) return res.status(404).json({ error: 'Food not found' });
  res.json({ food });
});

router.delete('/foods/:id', requireFeature('diet'), (req, res) => {
  const id = idParam(req.params.id);
  if (id == null || !deleteFood(dataUid(req), id)) return res.status(404).json({ error: 'Food not found' });
  res.json({ ok: true });
});

const recipeShape = (u, r) => {
  const { items, totalCalories, calPerOz } = recipeSummary(u, r);
  return { recipe: r, items, totalCalories, calPerOz, itemCount: items.length };
};

router.get('/recipes', requireFeature('diet'), (req, res) => {
  const u = dataUid(req);
  res.json({
    recipes: listRecipes(u).map((r) => {
      const { totalCalories, calPerOz, itemCount } = recipeShape(u, r);
      return { ...r, totalCalories, calPerOz, itemCount };
    }),
  });
});

router.get('/recipes/:id', requireFeature('diet'), (req, res) => {
  const id = idParam(req.params.id);
  const r = id == null ? null : getRecipeById(dataUid(req), id);
  if (!r) return res.status(404).json({ error: 'Recipe not found' });
  res.json(recipeShape(dataUid(req), r));
});

// Full (re)definition by name: replace the item set and cooked weight in one save (the web builder's
// submit). Items naming a library food snapshot ITS density (quantity converts into the food's units);
// custom items must carry their own calPerUnit/unitType.
router.post('/recipes', requireFeature('diet'), (req, res) => {
  const u = dataUid(req);
  const name = (req.body?.name ?? '').toString().trim();
  const cookedWeightOz = Number(req.body?.cookedWeightOz);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!(cookedWeightOz > 0)) return res.status(400).json({ error: 'cookedWeightOz must be a positive number' });
  if (!items.length) return res.status(400).json({ error: 'at least one item required' });
  const resolved = [];
  for (const it of items) {
    const itName = (it?.name ?? '').toString().trim();
    const qty = Number(it?.quantity);
    if (!itName || !(qty > 0)) return res.status(400).json({ error: `each item needs a name and a positive quantity` });
    const food = findFood(u, itName);
    if (food) {
      const inUnits = toFoodUnits(food, qty, it.unit || null);
      if (inUnits == null) return res.status(400).json({ error: `${food.name} is a per-${food.unit_type} food — quantity can't be reconciled` });
      resolved.push({ foodId: food.id, name: food.name, calPerUnit: food.cal_per_unit, unitType: food.unit_type, quantity: inUnits });
    } else {
      const calPerUnit = Number(it?.calPerUnit);
      if (!(calPerUnit > 0)) return res.status(400).json({ error: `"${itName}" isn't in your foods — give it a calPerUnit, or add it first` });
      resolved.push({ foodId: null, name: itName, calPerUnit, unitType: UNIT_TYPES.includes(it.unitType) ? it.unitType : 'ounce', quantity: qty });
    }
  }
  const existing = findRecipe(u, name);
  const r = existing || createRecipe(u, name);
  if (existing) clearRecipeItems(u, r.id);
  for (const it of resolved) addRecipeItem(u, r.id, it);
  setRecipeCookedWeight(u, r.id, cookedWeightOz);
  res.json(recipeShape(u, getRecipeById(u, r.id)));
});

router.delete('/recipes/:id', requireFeature('diet'), (req, res) => {
  const id = idParam(req.params.id);
  if (id == null || !deleteRecipe(dataUid(req), id)) return res.status(404).json({ error: 'Recipe not found' });
  res.json({ ok: true });
});

// Log a portion from the GUI — the same lookup as chat's eat, but never the LLM: an unknown name is a
// 400 (teach it in chat, or add it to the library first).
router.post('/diet/log', requireFeature('diet'), (req, res) => {
  const u = dataUid(req);
  const name = (req.body?.name ?? '').toString().trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const qty = req.body?.quantity != null && req.body.quantity !== '' ? Number(req.body.quantity) : null;
  if (qty != null && !(qty > 0)) return res.status(400).json({ error: 'quantity must be a positive number' });
  const unit = ['oz', 'g', 'lb', 'piece'].includes(req.body?.unit) ? req.body.unit : null;
  const food = findFood(u, name) || (() => { const r = findRecipe(u, name); return r && recipeAsFood(u, r); })();
  if (!food) return res.status(400).json({ error: `"${name}" isn't in your foods or recipes` });
  if (!COUNT_UNIT_TYPES.includes(food.unit_type) && qty == null) return res.status(400).json({ error: 'quantity required for a weighed food' });
  const portion = portionOf(food, qty, unit);
  if (!portion) return res.status(400).json({ error: `${food.name} is a per-${food.unit_type} food — quantity can't be reconciled` });
  logFood(u, portion.label, portion.calories);
  res.json({ ok: true, calories: portion.calories, entryLabel: portion.label });
});

// A day key's start: 02:00 local, the app-wide rollover (shared/timeframe.js) — a 1am snack belongs
// to the evening's day, so "2026-07-09" runs 07-09 02:00 → 07-10 02:00.
const localDayStart = (dateStr) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), DAY_ROLLOVER_HOUR).getTime();
};

const dietEntry = (v) => ({ id: v.id, label: v.entry_label || v.note || '(entry)', calories: v.value, recordedAt: v.recorded_at });

// One day's eaten portions (label + calories), local-midnight bounded. Defaults to today.
router.get('/diet/log', requireFeature('diet'), (req, res) => {
  const u = dataUid(req);
  const start = req.query.date ? localDayStart(req.query.date.toString()) : localDayStart(localDateKey());
  if (start == null) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  const cal = getMetric(u, 'calories');
  const values = cal ? metricValuesBetween(u, cal.id, start, start + 86400000) : [];
  const entries = values.map(dietEntry);
  res.json({
    date: localDateKey(start), entries, total: Math.round(entries.reduce((s, e) => s + e.calories, 0)),
    whatever: getDietDay(u, dayStartOf(start)) != null, // an "eat whatever" day: off the record, tinted on the graph
  });
});

// Edit one logged portion (the daily log's inline edit). Label updates note + entry_label together,
// the same pairing logFood writes; chat "undo" tracks the ROW (undo_stack ids) and re-reads the live
// entry_label at pop time, so its confirmation names the edited label.
router.patch('/diet/log/:id', requireFeature('diet'), (req, res) => {
  const u = dataUid(req);
  const cal = getMetric(u, 'calories');
  const id = idParam(req.params.id);
  const patch = {};
  if (req.body?.calories !== undefined) {
    const v = Number(req.body.calories);
    if (!Number.isFinite(v) || !(v > 0)) return res.status(400).json({ error: 'calories must be a positive number' });
    patch.value = v;
  }
  if (req.body?.label !== undefined) {
    const s = (req.body.label ?? '').toString().trim();
    if (!s) return res.status(400).json({ error: 'label required' });
    patch.note = s;
    patch.entryLabel = s;
  }
  const row = cal && id != null ? updateMetricValue(u, cal.id, id, patch) : null;
  if (!row) return res.status(404).json({ error: 'Entry not found' });
  res.json({ entry: dietEntry(row) });
});

// Delete one logged portion by id (scoped to the user's calories metric — forged ids 404).
router.delete('/diet/log/:id', requireFeature('diet'), (req, res) => {
  const u = dataUid(req);
  const cal = getMetric(u, 'calories');
  const id = idParam(req.params.id);
  if (!cal || id == null || !deleteMetricValue(u, cal.id, id)) return res.status(404).json({ error: 'Entry not found' });
  res.json({ ok: true });
});

// The report: daily calorie totals for the last N days (today last) + the weight series, one read.
router.get('/diet/report', requireFeature('diet'), (req, res) => {
  const u = dataUidForRead(req);
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const todayStart = localDayStart(localDateKey());
  const start = todayStart - (days - 1) * 86400000;
  const cal = ensureCaloriesMetric(u);
  const byDay = {};
  for (const v of metricValuesSince(u, cal.id, start)) {
    const k = localDateKey(v.recorded_at);
    byDay[k] = (byDay[k] || 0) + v.value;
  }
  // "eat whatever" days are off the record: tinted on the graph and left out of the average below.
  const whateverDays = new Set(listDietDays(u, dayStartOf(start)).map((dd) => dd.day_start));
  const out = [];
  for (let i = 0; i < days; i++) {
    const k = localDateKey(start + i * 86400000);
    out.push({ date: k, total: Math.round(byDay[k] || 0), whatever: whateverDays.has(dayStartOf(start + i * 86400000)) });
  }
  // Average over "finished" days only — days with something logged that the user didn't wave off. An
  // eat-whatever day, or a day with nothing logged at all, isn't a tracked result and would skew it.
  const counted = out.filter((dd) => !dd.whatever && dd.total > 0);
  const average = counted.length ? Math.round(counted.reduce((s, dd) => s + dd.total, 0) / counted.length) : null;
  const w = getMetric(u, 'weight');
  const weight = w
    ? metricValuesSince(u, w.id, 0).map((v) => ({ date: localDateKey(v.recorded_at), value: v.value }))
    : [];
  res.json({
    target: cal.target, todayTotal: out[out.length - 1].total, days: out, weight, weightUnit: w?.unit || 'lbs',
    average, averageDays: counted.length,
    // The server is the source of truth for what day it is (02:00 rollover, server-local clock). The web
    // must navigate/bound by THIS, never the browser's date — and can compare tz offsets to warn when the
    // deployment's clock is in a different timezone than the user (fix: set the TZ env var).
    today: localDateKey(),
    tz: { offsetMinutes: new Date().getTimezoneOffset(), name: Intl.DateTimeFormat().resolvedOptions().timeZone },
  });
});

// The report's daily-target edit — same setter as the chat's "target 1800".
router.post('/diet/target', requireFeature('diet'), (req, res) => {
  const value = Number(req.body?.value);
  if (!Number.isInteger(value) || !(value > 0)) return res.status(400).json({ error: 'value must be a positive whole number' });
  setCalorieTarget(dataUid(req), value);
  res.json({ ok: true, target: value });
});

// Toggle an "eat whatever" day (chat's "eat whatever"). `date` (YYYY-MM-DD) defaults to today; `on`
// marks it, off clears it. The day is stored as its logical-day start (02:00 rollover), matching the
// report/chart buckets. Idempotent either way.
router.post('/diet/whatever', requireFeature('diet'), (req, res) => {
  const u = dataUid(req);
  const start = req.body?.date ? localDayStart(req.body.date.toString()) : localDayStart(localDateKey());
  if (start == null) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  const day = dayStartOf(start);
  const on = req.body?.on !== false; // default true
  if (on) setDietDay(u, day, 'whatever'); else clearDietDay(u, day);
  res.json({ ok: true, date: localDateKey(start), whatever: on });
});

// A weight entry's date: an epoch-ms number, or a YYYY-MM-DD day (logged mid-day — day start + 12h —
// so it sorts naturally inside that day on the time axis). Null/undefined → "now" (the caller's default).
const weightAt = (raw) => {
  if (raw == null || raw === '') return undefined;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  const day = localDayStart(String(raw));
  return day == null ? null : day + 12 * 3600000;
};

// The report's weight quick-entry — same point metric the chat's "weight 182" writes. An optional
// `at` (epoch ms or YYYY-MM-DD) backdates the entry, so missed days can be filled in.
router.post('/diet/weight', requireFeature('diet'), (req, res) => {
  const value = Number(req.body?.value);
  if (!(value > 0)) return res.status(400).json({ error: 'value must be a positive number' });
  const at = weightAt(req.body?.at);
  if (at === null) return res.status(400).json({ error: 'at must be epoch ms or YYYY-MM-DD' });
  recordWeight(dataUid(req), value, at ?? Date.now());
  res.json({ ok: true });
});

// `date` is the server's day key for the entry — the web shows/edits THAT, never its own Date math
// (browser and server timezones or the 02:00 rollover would disagree).
const weightEntry = (v) => ({ id: v.id, value: v.value, recordedAt: v.recorded_at, date: localDateKey(v.recorded_at) });

// The full weight log (weight entries are sparse — a few per week — so no pagination), oldest first.
router.get('/diet/weight-log', requireFeature('diet'), (req, res) => {
  const u = dataUid(req);
  const w = getMetric(u, 'weight');
  res.json({ entries: w ? metricValuesSince(u, w.id, 0).map(weightEntry) : [], unit: w?.unit || 'lbs' });
});

// Edit one weight entry — value and/or date (the chart is a time axis, so re-dating matters).
router.patch('/diet/weight/:id', requireFeature('diet'), (req, res) => {
  const u = dataUid(req);
  const w = getMetric(u, 'weight');
  const id = idParam(req.params.id);
  const patch = {};
  if (req.body?.value !== undefined) {
    const v = Number(req.body.value);
    if (!Number.isFinite(v) || !(v > 0)) return res.status(400).json({ error: 'value must be a positive number' });
    patch.value = v;
  }
  if (req.body?.at !== undefined) {
    const at = weightAt(req.body.at);
    if (at == null) return res.status(400).json({ error: 'at must be epoch ms or YYYY-MM-DD' });
    patch.recordedAt = at;
  }
  const row = w && id != null ? updateMetricValue(u, w.id, id, patch) : null;
  if (!row) return res.status(404).json({ error: 'Entry not found' });
  res.json({ entry: weightEntry(row) });
});

// Delete one weight entry by id (scoped to the user's weight metric — forged ids 404).
router.delete('/diet/weight/:id', requireFeature('diet'), (req, res) => {
  const u = dataUid(req);
  const w = getMetric(u, 'weight');
  const id = idParam(req.params.id);
  if (!w || id == null || !deleteMetricValue(u, w.id, id)) return res.status(404).json({ error: 'Entry not found' });
  res.json({ ok: true });
});

// The report's graphs under the DIET gate (a diet-only user has no /metrics/... access) — same PNG the
// chat's /chart draws.
router.get('/diet/chart/:name', requireFeature('diet'), (req, res) => {
  if (!['calories', 'weight'].includes(req.params.name)) return res.status(404).json({ error: 'Unknown chart' });
  const chart = renderMetricChart(dataUid(req), req.params.name, (req.query.range || '30d').toString());
  if (!chart) return res.status(404).json({ error: 'No data yet' });
  res.json({ image: chart.image, label: chart.label, points: chart.points });
});

// The same report graphs as raw series data for the web's client-side charts (still diet-gated).
router.get('/diet/chart-data/:name', requireFeature('diet'), (req, res) => {
  if (!['calories', 'weight'].includes(req.params.name)) return res.status(404).json({ error: 'Unknown chart' });
  const d = getMetricChartData(dataUid(req), req.params.name, (req.query.range || '30d').toString());
  if (!d) return res.status(404).json({ error: 'No data yet' });
  res.json(d);
});

// ── medication: the opt-in adherence logger (its OWN module, kind='med' metrics stay out of /metrics). Every
// route is requireFeature('medication') — belt-and-braces behind the web hiding the icon. Logging never calls
// an LLM. "med chart" reuses the metric chart-data path with the med's own metric name. ──
router.get('/med/today', requireFeature('medication'), (req, res) => res.json(medToday(dataUid(req))));
router.get('/meds', requireFeature('medication'), (req, res) => res.json({ meds: medCatalog(dataUid(req)), disclaimer: MED_DISCLAIMER }));
router.post('/meds', requireFeature('medication'), (req, res) => {
  const name = (req.body?.name ?? '').toString().trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const dose = req.body?.dose != null ? req.body.dose.toString().trim() : null;
  webAddMed(dataUid(req), name, dose || null);
  res.json({ ok: true });
});
router.delete('/meds/:name', requireFeature('medication'), (req, res) => {
  if (!deleteMed(dataUid(req), (req.params.name || '').toString())) return res.status(404).json({ error: 'Med not found' });
  res.json({ ok: true }); // the adherence metric (history/chart) is kept
});
// Tick / untick one med for today. { name, taken } — taken=false removes today's dose(s) for that med.
router.post('/med/log', requireFeature('medication'), (req, res) => {
  const name = (req.body?.name ?? '').toString().trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  medSetTaken(dataUid(req), name, req.body?.taken !== false);
  res.json(medToday(dataUid(req)));
});
// "log all remaining scheduled meds" — the web button behind the today view.
router.post('/med/all', requireFeature('medication'), (req, res) => {
  medAll(dataUid(req));
  res.json(medToday(dataUid(req)));
});
router.get('/med/templates', requireFeature('medication'), (req, res) => res.json({ templates: medTemplatesData(dataUid(req)) }));
router.post('/med/templates', requireFeature('medication'), (req, res) => {
  const name = (req.body?.name ?? '').toString().trim();
  const meds = Array.isArray(req.body?.meds) ? req.body.meds : [];
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!meds.length) return res.status(400).json({ error: 'meds required' });
  webSaveTemplate(dataUid(req), name, meds);
  res.json({ ok: true });
});
router.delete('/med/templates/:name', requireFeature('medication'), (req, res) => {
  if (!deleteMedTemplate(dataUid(req), (req.params.name || '').toString())) return res.status(404).json({ error: 'Template not found' });
  res.json({ ok: true });
});
// Set (minute 0..1439) or clear (null) a template's daily reminder. The web owns the time picker.
router.post('/med/template/:name/remind', requireFeature('medication'), (req, res) => {
  const tpl = getMedTemplate(dataUid(req), (req.params.name || '').toString());
  if (!tpl) return res.status(404).json({ error: 'Template not found' });
  const raw = req.body?.minute;
  const off = raw == null || raw === '' || req.body?.enabled === false;
  const minute = off ? null : Number(raw);
  if (!off && !(Number.isInteger(minute) && minute >= 0 && minute <= 1439)) return res.status(400).json({ error: 'minute must be 0..1439 or null' });
  setMedTemplateReminder(dataUid(req), tpl.id, minute, !off);
  res.json({ ok: true });
});
// Per-med adherence chart data (reuses the metric chart pipeline; the med metric shares the med's name).
router.get('/med/chart-data/:name', requireFeature('medication'), (req, res) => {
  const d = getMetricChartData(dataUid(req), (req.params.name || '').toString(), (req.query.range || '30d').toString());
  if (!d) return res.status(404).json({ error: 'No doses logged yet' });
  res.json(d);
});

// ── templates: saved task blueprints (core — always on, task-adjacent). List / materialize into a fresh
// task / delete. (Create-from-task is POST /tasks/:id/template above.) ──
router.get('/templates', (req, res) => res.json({ templates: listTemplates(dataUid(req)) }));

router.post('/templates/:name/materialize', async (req, res) => {
  try {
    const u = dataUid(req);
    const task = materializeTemplate(u, req.params.name);
    if (!task) return res.status(404).json({ error: 'Template not found' });
    await embedTask(task); // so the fresh copy ranks in suggestions, same as materialize does in chat
    res.json({ task });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/templates/:name', (req, res) => {
  if (!deleteTemplate(dataUid(req), req.params.name)) return res.status(404).json({ error: 'Template not found' });
  res.json({ ok: true });
});

// ── journals: the opt-in trend-journal module. Thin wrappers over server/journal.js (the same engine the
// chat surface uses) behind requireFeature('journal') — the web hides the icon, this is the belt-and-braces.
// The :name param is the user-facing journal handle (NOCASE, like templates). ──
const journalByName = (req, res) => {
  const j = getJournal(dataUid(req), req.params.name);
  if (!j) res.status(404).json({ error: 'Journal not found' });
  return j;
};
const journalShape = (u, j) => ({
  ...j,
  checklist: parseChecklist(j.checklist_json),
  dossier: j.dossier_json ? JSON.parse(j.dossier_json) : null,
  todayEntry: getJournalEntry(u, j.id, localDateKey())?.id ?? null,
});

router.get('/journals', requireFeature('journal'), (req, res) => {
  const u = dataUid(req);
  res.json({ journals: listJournals(u).map((j) => journalShape(u, j)), today: localDateKey() });
});

router.post('/journals', requireFeature('journal'), (req, res) => {
  const u = dataUid(req);
  const name = (req.body?.name ?? '').toString().trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const j = createJournal(u, name);
  if (!j) return res.status(409).json({ error: `You already have a “${name}” journal.` });
  res.json({ journal: journalShape(u, j) });
});

router.post('/journals/:name/template', requireFeature('journal'), (req, res) => {
  const u = dataUid(req);
  const j = journalByName(req, res);
  if (!j) return;
  const tpl = getTemplate(u, (req.body?.template ?? '').toString());
  if (!tpl) return res.status(404).json({ error: 'Template not found' });
  const steps = parseChecklist(tpl.steps_json).map((s) => ({ text: s.text }));
  if (!steps.length) return res.status(400).json({ error: `“${tpl.name}” has no steps to copy.` });
  res.json({ journal: journalShape(u, setJournalTemplate(u, j.id, tpl.name, JSON.stringify(steps))) });
});

router.delete('/journals/:name', requireFeature('journal'), (req, res) => {
  if (!deleteJournal(dataUid(req), req.params.name)) return res.status(404).json({ error: 'Journal not found' });
  res.json({ ok: true });
});

const entryShape = (e) => e && ({ ...e, checklist: parseChecklist(e.checklist_json) });

router.get('/journals/:name/entries', requireFeature('journal'), (req, res) => {
  const u = dataUid(req);
  const j = journalByName(req, res);
  if (!j) return;
  const from = (req.query.from || '0000-01-01').toString();
  const to = (req.query.to || '9999-12-31').toString();
  res.json({ entries: listEntriesBetween(u, j.id, from, to).map(entryShape) });
});

// Open (create-or-return) TODAY's entry — the same idempotent newEntry the chat "entry" command uses.
router.post('/journals/:name/entry', requireFeature('journal'), (req, res) => {
  const u = dataUid(req);
  const j = journalByName(req, res);
  if (!j) return;
  const { entry, created } = newEntry(u, j);
  res.json({ entry: entryShape(entry), created });
});

router.post('/journals/:name/entry/check', requireFeature('journal'), (req, res) => {
  const u = dataUid(req);
  const j = journalByName(req, res);
  if (!j) return;
  const entry = getJournalEntry(u, j.id, localDateKey());
  if (!entry) return res.status(404).json({ error: 'No entry for today yet' });
  const positions = Array.isArray(req.body?.positions) ? req.body.positions.map(Number) : [];
  if (!positions.length) return res.status(400).json({ error: 'positions required' });
  const done = typeof req.body?.done === 'boolean' ? req.body.done : null; // null = flip
  const out = toggleEntryItems(u, entry.id, positions, done);
  res.json({ entry: entryShape(out.entry), changed: out.changed, missing: out.missing });
});

router.post('/journals/:name/entry/note', requireFeature('journal'), (req, res) => {
  const u = dataUid(req);
  const j = journalByName(req, res);
  if (!j) return;
  const text = (req.body?.text ?? '').toString().trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  res.json({ entry: entryShape(noteToday(u, j, text)) });
});

router.get('/journals/:name/summaries', requireFeature('journal'), (req, res) => {
  const u = dataUid(req);
  const j = journalByName(req, res);
  if (!j) return;
  const period = ['day', 'week', 'month'].includes(req.query.period) ? req.query.period : 'day';
  const from = (req.query.from || '0000').toString();
  const to = (req.query.to || '9999').toString();
  res.json({ summaries: listJournalSummaries(u, j.id, period, from, to) });
});

// Generate a summary on demand (the lazy path — an LLM call, so POST and possibly slow on a local model).
// period: today | yesterday | week | month. Open periods come back live:true and unstored.
router.post('/journals/:name/summary', requireFeature('journal'), async (req, res) => {
  const u = dataUid(req);
  const j = journalByName(req, res);
  if (!j) return;
  const period = (req.body?.period ?? 'today').toString();
  try {
    let s = null;
    // Rollups cap their day-summary backfill per request for non-owners (a month can otherwise fan out to
    // 31 LLM calls); the budget keys on the IDENTITY — a notebook shares its owner's allowance.
    const budget = backfillBudget(uid(req));
    if (period === 'today' || period === 'yesterday') {
      const key = period === 'today' ? localDateKey() : localDateKey(Date.now() - 86400000);
      s = await ensureDaySummary(u, j.id, key);
    } else if (period === 'week') s = await ensureWeekSummary(u, j.id, localDateKey(), Date.now(), budget);
    else if (period === 'month') s = await ensureMonthSummary(u, j.id, localDateKey(), Date.now(), budget);
    else return res.status(400).json({ error: 'period must be today | yesterday | week | month' });
    if (!s) return res.status(404).json({ error: `No entries for that ${period === 'yesterday' ? 'day' : period} yet.` });
    res.json({ summary: s });
  } catch (err) {
    if (llmLimited(err, res)) return;
    res.status(502).json({ error: `The model couldn’t be reached: ${err.message}` });
  }
});

router.post('/journals/:name/trends', requireFeature('journal'), async (req, res) => {
  const u = dataUid(req);
  const j = journalByName(req, res);
  if (!j) return;
  try {
    const out = await trendReport(u, j);
    res.json({ message: out.message, dossier: out.dossier, thin: !!out.thin });
  } catch (err) {
    if (llmLimited(err, res)) return;
    res.status(502).json({ error: `The model couldn’t be reached: ${err.message}` });
  }
});

// ── batches: the opt-in process-batch module. Thin wrappers over server/batches.js (the same engine the
// chat surface uses) behind requireFeature('batches') — the web hides the icon, this is the belt-and-braces.
// Runs are addressed by ROW id (scoped getters make a foreign id a 404); processes by :name (NOCASE). ──
const batchShape = (u, b) => b && ({ ...b, checklist: parseChecklist(b.checklist_json), log: listBatchLog(u, b.id) });
const batchById = (req, res) => {
  const b = getBatchById(dataUid(req), Number(req.params.id));
  if (!b) res.status(404).json({ error: 'Batch not found' });
  return b;
};

router.get('/batches', requireFeature('batches'), (req, res) => {
  res.json({ processes: listBatchNames(dataUid(req)) });
});

// Start a new run — directions snapshot from the same-named template, next batch_no.
router.post('/batches', requireFeature('batches'), (req, res) => {
  const u = dataUid(req);
  const name = (req.body?.name ?? '').toString().trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const out = openBatch(u, name);
  if (out.error) return res.status(400).json({ error: out.error });
  res.json({ batch: batchShape(u, out.batch) });
});

router.get('/batches/name/:name/runs', requireFeature('batches'), (req, res) => {
  const u = dataUid(req);
  res.json({ runs: listBatches(u, req.params.name).map((b) => batchShape(u, b)) });
});

router.delete('/batches/name/:name', requireFeature('batches'), (req, res) => {
  const n = deleteBatchesByName(dataUid(req), req.params.name);
  if (!n) return res.status(404).json({ error: 'No batches by that name' });
  res.json({ ok: true, deleted: n });
});

router.get('/batches/:id', requireFeature('batches'), (req, res) => {
  const b = batchById(req, res);
  if (!b) return;
  res.json({ batch: batchShape(dataUid(req), b) });
});

router.post('/batches/:id/check', requireFeature('batches'), (req, res) => {
  const u = dataUid(req);
  const b = batchById(req, res);
  if (!b) return;
  if (req.body?.all === true) return res.json({ batch: batchShape(u, checkAllBatchItems(u, b.id).batch) });
  const positions = Array.isArray(req.body?.positions) ? req.body.positions.map(Number) : [];
  if (!positions.length) return res.status(400).json({ error: 'positions required' });
  const done = typeof req.body?.done === 'boolean' ? req.body.done : null; // null = flip
  const out = toggleBatchItems(u, b.id, positions, done);
  res.json({ batch: batchShape(u, out.batch), changed: out.changed, missing: out.missing });
});

router.post('/batches/:id/log', requireFeature('batches'), (req, res) => {
  const u = dataUid(req);
  const b = batchById(req, res);
  if (!b) return;
  const text = (req.body?.text ?? '').toString().trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  batchLogLine(u, b.id, text);
  res.json({ batch: batchShape(u, getBatchById(u, b.id)) });
});

router.post('/batches/:id/close', requireFeature('batches'), (req, res) => {
  const u = dataUid(req);
  const b = batchById(req, res);
  if (!b) return;
  const outcome = (req.body?.outcome ?? '').toString().trim() || null;
  const out = closeBatch(u, b.id, outcome);
  res.json({ batch: batchShape(u, out.batch), already: !!out.already });
});

// Step tweaking on an OPEN run (engine {error} — e.g. closed run, empty text — surfaces as 400).
const stepResult = (u, res, out, id) => {
  if (!out) return res.status(404).json({ error: 'Batch not found' });
  if (out.error) return res.status(400).json({ error: out.error });
  return res.json({ batch: batchShape(u, getBatchById(u, id)), missing: out.missing || [] });
};
router.post('/batches/:id/steps', requireFeature('batches'), (req, res) => {
  const u = dataUid(req); const b = batchById(req, res); if (!b) return;
  const text = (req.body?.text ?? '').toString().trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  stepResult(u, res, addBatchStep(u, b.id, text), b.id);
});
router.patch('/batches/:id/steps/:i', requireFeature('batches'), (req, res) => {
  const u = dataUid(req); const b = batchById(req, res); if (!b) return;
  const text = (req.body?.text ?? '').toString().trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  stepResult(u, res, editBatchStep(u, b.id, Number(req.params.i), text), b.id);
});
router.delete('/batches/:id/steps/:i', requireFeature('batches'), (req, res) => {
  const u = dataUid(req); const b = batchById(req, res); if (!b) return;
  stepResult(u, res, removeBatchStep(u, b.id, [Number(req.params.i)]), b.id);
});
router.post('/batches/:id/save', requireFeature('batches'), (req, res) => {
  const u = dataUid(req); const b = batchById(req, res); if (!b) return;
  const out = saveBatchAsVersion(u, b.id);
  if (!out) return res.status(404).json({ error: 'Batch not found' });
  if (out.error) return res.status(400).json({ error: out.error });
  res.json({ batch: batchShape(u, getBatchById(u, b.id)), versionName: out.versionName, base: out.base });
});

// Recipe-version lineage (family) + reversible reject/unreject. Addressed by base name + version number.
router.get('/batches/name/:name/versions', requireFeature('batches'), (req, res) => {
  res.json({ versions: batchVersions(dataUid(req), req.params.name) });
});
router.post('/batches/name/:name/version/:n/reject', requireFeature('batches'), (req, res) => {
  const out = rejectVersion(dataUid(req), req.params.name, Number(req.params.n));
  if (out.error) return res.status(404).json({ error: out.error });
  res.json({ versions: batchVersions(dataUid(req), req.params.name), latest: out.latest, emptied: !!out.emptied });
});
router.post('/batches/name/:name/version/:n/unreject', requireFeature('batches'), (req, res) => {
  const out = unrejectVersion(dataUid(req), req.params.name, Number(req.params.n));
  if (out.error) return res.status(404).json({ error: out.error });
  res.json({ versions: batchVersions(dataUid(req), req.params.name), latest: out.latest });
});

// ── LM Studio / LLM setup (configured from the UI — no .env needed) ──
const CLOUD = new Set(CLOUD_PROVIDER_IDS); // non-local providers; gated by LLM_ALLOW_CLOUD (shared/providers.js)

// Redact: never send keys to the client. Surface the ACTIVE provider's model/key state (cloud keys and
// models live nested per-provider) plus whether cloud is enabled, so the UI knows what to show.
const redactLlm = (c) => {
  const pc = CLOUD.has(c.provider) ? (c[c.provider] || {}) : c;
  const embModel = CLOUD.has(c.embedProvider) ? (c[c.embedProvider]?.embedModel ?? '') : (c.embedModel ?? '');
  return {
    provider: c.provider, embedProvider: c.embedProvider, baseUrl: c.baseUrl,
    chatModel: pc.chatModel ?? '', embedModel: embModel,
    hasApiKey: CLOUD.has(c.provider) ? !!c[c.provider]?.apiKey : !!c.apiKey,
    cloudEnabled: config.llm.cloudEnabled,
  };
};

// Probe the configured provider and enumerate models (for the Settings dropdowns).
router.get('/llm/status', async (_req, res) => {
  try { res.json(await llmStatus()); }
  catch (err) { res.status(500).json({ reachable: false, ok: false, error: err.message }); }
});

// The single source of truth for client-side config the web must NOT hardcode (taxonomy, effort levels,
// tappable commands, onboarding copy, provider catalog). Carries a `version` the client diffs on its
// heartbeat. See server/clientConfig.js.
router.get('/config', (_req, res) => res.json(getClientConfig()));

// The web's heartbeat: model-connection status (for the pill) + the current config version (so the client
// refetches /config only when it's actually changed — e.g. after /lock or /remcat mutated the taxonomy)
// + the connected chat bot's identity (for the header's @botname pill; null while no bot is running)
// + the acting user's current notebook (identity-keyed, like /api/notebooks; null = main space) — so a
// switch made from ANOTHER surface (Telegram "notebook work") is visible to the web, which reloads on change.
router.get('/heartbeat', async (req, res) => {
  let llm;
  try { llm = await llmStatus(); } catch (err) { llm = { reachable: false, ok: false, error: err.message }; }
  res.json({ llm, configVersion: getConfigVersion(), bot: getBotIdentity(), notebook: getCurrentNotebookId(uid(req)) ?? null });
});

// One read-only bundle for the web's wide-screen gutter panel: the single in-progress task, the next few
// upcoming rings (timers + task reminders + daily check-ins), today's expressed mood, and the logical day
// (the 02:00 boundary is server-owned — the client must not compute it). Deliberately NO sweeps here:
// /api/tasks and chat keep doing the sweeping; a 30s-poll display can be that many seconds stale.
router.get('/sidebar', (req, res) => {
  const u = dataUid(req);
  const now = Date.now();
  const dayStart = dayStartOf(now);
  const t = listTasks(u).filter((x) => x.status === 'in_progress').sort((a, b) => (b.started_at || 0) - (a.started_at || 0))[0] || null;
  const upcoming = [
    ...activeTimers(u).map((r) => ({ type: 'timer', id: r.id, label: r.label, at: r.fire_at })),
    ...pendingReminders(u, now).map((r) => ({ type: 'reminder', taskId: r.id, summary: r.summary, at: r.remind_at })),
    ...listSchedules(u).filter((s) => s.enabled).map((s) => {
      // Next occurrence of a daily check-in: today at minute_of_day if still ahead, else tomorrow.
      const todayAt = new Date(now); todayAt.setHours(0, s.minute_of_day, 0, 0);
      const at = todayAt.getTime() > now ? todayAt.getTime() : todayAt.getTime() + 86400000;
      return { type: 'checkin', id: s.id, minuteOfDay: s.minute_of_day, at };
    }),
  ].sort((a, b) => a.at - b.at).slice(0, 6);
  res.json({
    startedTask: t && { id: t.id, summary: t.summary, category: t.category, startedAt: t.started_at },
    upcoming,
    mood: latestMood(u, dayStart),
    day: { start: dayStart, label: new Date(dayStart).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) },
    // The person's own speed-dial pad, if they have one, so the wide-screen legend can surface it (keyed to the
    // identity — the pad follows the account, not the current notebook). Null for everyone without a pad.
    speedDial: padSummary(uid(req)),
  });
});

// ── Home Assistant summary: the ONE versioned aggregate HA dashboards read —
// REST-sensor recipes and the companion integration both consume exactly this. Read-only, cheap (no LLM
// call — that's /api/health's job), counts/timestamps only unless ?titles=1 opts content in. Not gated on
// the homeassistant module: that flag governs the OUTBOUND bridge (ringing the house); this is an inbound
// read the same as /api/sidebar. Pair it with a read-scoped claim token (Security panel → Read-only). ──
router.get('/ha/summary', (req, res) => {
  const titles = req.query.titles === '1' || req.query.titles === 'true';
  // uid drives the module gates (per account); dataUidForRead is the space to count — the current notebook,
  // or a specific owned one when the HA dashboard's picker passes ?notebook=<id|main>.
  res.json(buildHaSummary(uid(req), dataUidForRead(req), { titles }));
});

router.get('/settings/llm', (_req, res) => res.json(redactLlm(getLlmConfig())));

router.post('/settings/llm', requireOwner, (req, res) => {
  try {
    const b = req.body || {};
    const provider = typeof b.provider === 'string' ? b.provider : getLlmConfig().provider;
    const embedProvider = typeof b.embedProvider === 'string' ? b.embedProvider : null;
    // The flag is the real boundary: the UI hides cloud options, but reject them here too.
    if (!config.llm.cloudEnabled && (CLOUD.has(provider) || CLOUD.has(embedProvider))) {
      return res.status(403).json({ error: 'Cloud LLM providers are disabled on this server.' });
    }
    const patch = {};
    for (const k of ['provider', 'embedProvider', 'baseUrl']) if (typeof b[k] === 'string') patch[k] = b[k];
    // Only overwrite the key when a non-empty one is supplied (saving without retyping keeps the old key).
    const key = typeof b.apiKey === 'string' && b.apiKey.trim() ? b.apiKey.trim() : null;
    // Provider-specific fields land where the provider actually READS them: nested for cloud, top-level
    // for local. (Embeddings can run on a different provider, so route the embed model by embedProvider.)
    if (CLOUD.has(provider)) {
      const nested = {};
      if (key) nested.apiKey = key;
      if (typeof b.chatModel === 'string') nested.chatModel = b.chatModel;
      if (embedProvider === provider && typeof b.embedModel === 'string') nested.embedModel = b.embedModel;
      if (Object.keys(nested).length) patch[provider] = nested;
    } else {
      if (key) patch.apiKey = key;
      if (typeof b.chatModel === 'string') patch.chatModel = b.chatModel;
    }
    if (!CLOUD.has(embedProvider) && typeof b.embedModel === 'string') patch.embedModel = b.embedModel;
    res.json(redactLlm(setLlmConfig(patch)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Telegram setup (token from the UI; bot created via @BotFather) ──
const redactTg = (c) => ({ enabled: c.enabled, hasToken: !!c.botToken, allowedUsername: c.allowedUsername });

// ── Metrics module — now a PER-USER opt-in (off by default). Reads/writes the acting user's blob; the web
// is the root operator, so this controls root's metrics module. Same {enabled} shape the UI expects. ──
router.get('/settings/metrics', (req, res) => res.json({ enabled: isFeatureOnFor(uid(req), 'metrics') }));
router.post('/settings/metrics', (req, res) => {
  try {
    const patch = {};
    if (typeof req.body?.enabled === 'boolean') patch.metrics = req.body.enabled;
    res.json({ enabled: setUserFeatures(uid(req), patch).metrics });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Feature modules (Notes / Lists / Metrics / Vouch) — PER-USER opt-in, all OFF by default. The web acts as
// the root operator, so this manages root's own modules (each account opts in via the bot's "optin <module>"
// too). Tasks are core (always on, no toggle); Vouch is auto-on for the owner regardless of this flag. ──
// The user's EFFECTIVE module state (so the owner's auto-on Vouch reads as on), not the raw stored flags —
// returned by both GET and POST so the web checkbox never flickers between the stored and effective value.
const WEB_MODULES = OPTIN_FEATURES; // one list — a module added to settings.js appears here automatically
const effectiveFeatures = (u) => Object.fromEntries(WEB_MODULES.map((k) => [k, isFeatureOnFor(u, k)]));
router.get('/settings/features', (req, res) => res.json(effectiveFeatures(uid(req))));
router.post('/settings/features', (req, res) => {
  try {
    const u = uid(req);
    const patch = {};
    for (const k of WEB_MODULES) if (typeof req.body?.[k] === 'boolean') patch[k] = req.body[k];
    // A non-owner can't opt INTO a module disabled system-wide (it's invisible to them) — drop those opt-ins so
    // a stale/hidden checkbox can't set a flag that would never take effect. The owner keeps preview access.
    const owner = isOwner(u);
    for (const k of Object.keys(patch)) if (patch[k] === true && !owner && !isSystemModuleOn(k)) delete patch[k];
    setUserFeatures(u, patch);
    // Turning Notebooks OFF drops you back to your main space (mirrors the chat "optout notebook"), so a hidden
    // switcher can never strand the acting user inside a notebook whose controls are gone.
    if (patch.notebook === false) clearCurrentNotebookId(u);
    res.json(effectiveFeatures(u));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Notebooks: the acting account's isolated spaces (each its own tasks/notes/lists). List / switch / create,
// all scoped to the IDENTITY (uid) — the current-notebook pointer and the set belong to the account, not to
// whichever space it's in (so this mirrors the chat "notebook …" commands). The web reloads after a switch, so
// every data view (which reads via dataUid → effectiveUserId) then reflects the chosen space. enabled:false
// when the module is off for the user → the client hides the switcher. ──
router.get('/notebooks', (req, res) => {
  const u = uid(req);
  if (!isFeatureOnFor(u, 'notebook')) return res.json({ enabled: false, currentId: null, notebooks: [] });
  res.json({
    enabled: true,
    currentId: getCurrentNotebookId(u),
    notebooks: listNotebooks(u).map((n) => ({ id: n.id, name: n.notebook_name })),
  });
});

router.post('/notebooks/switch', (req, res) => {
  try {
    const u = uid(req);
    if (!isFeatureOnFor(u, 'notebook')) return res.status(403).json({ error: 'Notebooks are off for you.' });
    const raw = req.body?.id;
    if (raw == null || raw === '' || raw === 'main') { clearCurrentNotebookId(u); return res.json({ ok: true, currentId: null }); }
    const nb = getNotebook(Number(raw));
    // Ownership-checked; a RETIRED notebook is hidden, so its id is not a valid switch target either.
    if (!nb || nb.parent_user_id !== u || nb.retired_at != null) return res.status(404).json({ error: 'No such notebook.' });
    setCurrentNotebookId(u, nb.id);
    res.json({ ok: true, currentId: nb.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/notebooks', (req, res) => {
  try {
    const u = uid(req);
    if (!isFeatureOnFor(u, 'notebook')) return res.status(403).json({ error: 'Notebooks are off for you.' });
    const name = (req.body?.name ?? '').toString();
    const existing = getNotebookByName(u, name); // naming an existing one just switches to it
    let nb = existing;
    if (!nb) {
      const r = createNotebook(u, name);
      if (r.error) return res.status(400).json({ error: r.error });
      nb = r.notebook;
    }
    setCurrentNotebookId(u, nb.id);
    res.json({ ok: true, currentId: nb.id, notebook: { id: nb.id, name: nb.notebook_name } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Data retention toggle (off by default). When on, /requestdeletion archives a zip of the user's data
// to their folder before erasing it (compliance/safety). Off = a deletion request keeps no copy. ──
router.get('/settings/retention', requireOwner, (_req, res) => res.json(getRetentionConfig()));
router.post('/settings/retention', requireOwner, (req, res) => {
  try {
    const patch = {};
    if (typeof req.body?.enabled === 'boolean') patch.enabled = req.body.enabled;
    res.json(setRetentionConfig(patch));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Weather: set a location (place name); conditions come from Open-Meteo, no key (§3). The location
// also names the app's timezone (day boundaries + wake-ups), adopted during the refresh (timezone.js). ──
router.get('/settings/weather', requireOwner, (_req, res) => res.json({ ...getWeatherConfig(), timezone: getAppTimezone() }));
router.post('/settings/weather', requireOwner, async (req, res) => {
  try {
    const patch = {};
    if (typeof req.body?.location === 'string') patch.location = req.body.location.trim();
    if (req.body?.unit === 'C' || req.body?.unit === 'F') patch.unit = req.body.unit;
    const cfg = setWeatherConfig(patch);
    await refreshWeather();            // resolve now so the user sees it immediately (adopts the timezone too)
    const cur = currentWeather();      // converted to the chosen unit
    // `problem` tells the UI a null `current` was a fetch failure, not an unknown place name.
    res.json({
      ...cfg,
      current: cur ? { label: cur.weather, temp: cur.temp, unit: cur.unit } : null,
      problem: weatherProblem(),
      timezone: getAppTimezone(),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Wake-up check-ins the web polls for; returns and marks unseen ones (§10) ──
router.get('/wakeups', (req, res) => {
  const u = dataUid(req);
  const ws = listUnseenWakeups(u);
  if (ws.length) markWakeupsSeen(u);
  res.json({ wakeups: ws.map((w) => ({ id: w.id, text: w.text, created_at: w.created_at })) });
});

router.get('/settings/telegram', requireOwner, (_req, res) => res.json(redactTg(getTelegramConfig())));

router.post('/settings/telegram', requireOwner, async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    if (typeof b.botToken === 'string' && b.botToken.trim()) patch.botToken = b.botToken.trim();
    if (typeof b.allowedUsername === 'string') patch.allowedUsername = b.allowedUsername.trim();
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
    const c = setTelegramConfig(patch);
    let started = false;
    let error = null;
    try { started = !!(await startTelegram()); } catch (e) { error = e.message; }
    res.json({ ...redactTg(c), started, error });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Slack setup (optional second channel; tokens from the UI, app created at api.slack.com). Never returns
// the secret values — only `has*` booleans — same as redactTg. Socket Mode is the default (no public URL). ──
const redactSlack = (c) => ({
  enabled: c.enabled, mode: c.mode, allowedSlack: c.allowedSlack,
  hasBotToken: !!c.botToken, hasAppToken: !!c.appToken, hasSigningSecret: !!c.signingSecret,
});
router.get('/settings/slack', requireOwner, (_req, res) => res.json(redactSlack(getSlackConfig())));

router.post('/settings/slack', requireOwner, async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    if (typeof b.botToken === 'string' && b.botToken.trim()) patch.botToken = b.botToken.trim();
    if (typeof b.appToken === 'string' && b.appToken.trim()) patch.appToken = b.appToken.trim();
    if (typeof b.signingSecret === 'string' && b.signingSecret.trim()) patch.signingSecret = b.signingSecret.trim();
    if (typeof b.allowedSlack === 'string') patch.allowedSlack = b.allowedSlack.trim();
    if (b.mode === 'socket' || b.mode === 'http') patch.mode = b.mode;
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
    const c = setSlackConfig(patch);
    let started = false;
    let error = null;
    try { started = !!(await startSlack()); } catch (e) { error = e.message; }
    res.json({ ...redactSlack(c), started, error });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Home Assistant setup (the Home Assistant module's owner-only connection + output targets). The
// long-lived token is stored ENCRYPTED at rest (settings.js) and never returned — only hasToken, same
// stance as redactTg/redactSlack. POST accepts partials; a blank token means "keep the stored one". ──
const redactHa = (c) => ({
  enabled: c.enabled, baseUrl: c.baseUrl, hasToken: !!c.token, agentId: c.agentId,
  announce: c.announce, script: c.script, notify: c.notify, calendar: c.calendar,
});
router.get('/settings/homeassistant', requireOwner, (_req, res) => res.json(redactHa(getHomeAssistantConfig())));

router.post('/settings/homeassistant', requireOwner, (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
    if (typeof b.baseUrl === 'string') patch.baseUrl = b.baseUrl;
    if (typeof b.token === 'string' && b.token.trim()) patch.token = b.token; // blank = keep stored
    if (typeof b.agentId === 'string') patch.agentId = b.agentId;
    for (const k of ['announce', 'script', 'notify', 'calendar']) if (b[k] && typeof b[k] === 'object') patch[k] = b[k];
    res.json(redactHa(setHomeAssistantConfig(patch)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// The panel's Test button: verify the URL+token, then ring every enabled output (per-output results).
router.post('/settings/homeassistant/test', requireOwner, async (_req, res) => {
  try {
    const connection = await haCheckConnection();
    const outputs = await haTestOutputs();
    res.json({ connection, outputs, problem: haProblem() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Discovery for the pickers: what satellites/calendars/scripts/notify services actually exist over there.
router.get('/settings/homeassistant/discover', requireOwner, async (_req, res) => {
  try {
    res.json(await haDiscoverTargets());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Web login (auth §9): the mode dropdown (none | simple), the open-registration toggle, and the IP
// allowlist — all owner-only. Turning 'simple' on is REFUSED until root has a username, a password, and a
// VERIFIED authenticator (2FA is mandatory at login, so anything less is a self-lockout). The allowlist is
// validated entry-by-entry before it goes live, and a list that would block the requester's own address
// needs force:true (the UI confirms) — loopback always passes regardless (ipGate.js). ──
router.get('/settings/auth', requireOwner, (_req, res) => {
  res.json({ ...getAuthConfig(), canEnableSimple: rootCredentialsReady() });
});

router.post('/settings/auth', requireOwner, (req, res) => {
  try {
    const b = req.body || {};
    const wasSimple = getAuthConfig().mode === 'simple';
    const patch = {};
    if (b.mode === 'none' || b.mode === 'simple') {
      if (b.mode === 'simple' && !rootCredentialsReady()) {
        return res.status(400).json({ error: 'Set a username, a password, and verify 2FA before turning on login.' });
      }
      patch.mode = b.mode;
    }
    if (typeof b.allowRegistration === 'boolean') patch.allowRegistration = b.allowRegistration;
    if (typeof b.cliEnabled === 'boolean') patch.cliEnabled = b.cliEnabled; // terminal-client opt-in
    if (Array.isArray(b.ipAllowlist)) {
      const entries = b.ipAllowlist.map((s) => String(s ?? '').trim()).filter(Boolean);
      const { errors } = parseAllowlist(entries);
      if (errors.length) return res.status(400).json({ error: `Not a valid IP or CIDR: ${errors[0]}` });
      const myIp = normalizeIp(req.ip);
      if (entries.length && !isLoopback(myIp) && !ipAllowedBy(myIp, entries) && b.force !== true) {
        return res.status(400).json({
          error: `That list would block the address you're connecting from (${myIp}).`,
          needsForce: true,
        });
      }
      patch.ipAllowlist = entries;
    }
    const next = setAuthConfig(patch);
    // Flipping login ON from a mode-none tab: this tab has no cookie yet (none existed under 'none'), so
    // mint the root session in THIS response — otherwise the operator's own click locks them out.
    if (!wasSimple && next.mode === 'simple'
        && !(req.webSession?.state === 'active' && req.webSession.userId === defaultUserId())) {
      const token = createSession(defaultUserId(), { ip: normalizeIp(req.ip) });
      setSessionCookie(req, res, token);
    }
    res.json({ ...next, canEnableSimple: rootCredentialsReady() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Site URL (an ADVANCED option, Security panel): the public base URL of this deployment — the address
// the /web chat command's sign-in links point at (settings.js getSiteConfig). Owner-only like every
// global setting. Blank = unset, which keeps /web off. Validated as an absolute http(s) URL; trailing
// slashes are normalized away in the setter so a minted link never doubles one. ──
router.get('/settings/site', requireOwner, (_req, res) => res.json(getSiteConfig()));

router.post('/settings/site', requireOwner, (req, res) => {
  try {
    const raw = String(req.body?.url ?? '').trim();
    if (raw) {
      let u = null;
      try { u = new URL(raw); } catch { /* not a URL at all */ }
      if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) {
        return res.status(400).json({ error: 'Site URL must be a full address starting with http:// or https://' });
      }
    }
    res.json(setSiteConfig({ url: raw }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── CLI claim tokens (Security panel): the `fanad <server> <token>` terminal client's credentials.
// Owner-only both ways — minting IS granting API access, so it sits with the other global switches.
// The list never carries token material (only label/timestamps/state); the raw token appears exactly
// once, in the mint response, same shown-once contract as the TOTP secret. `userId` lets the owner mint
// for another account (the web mirror of `fanad token --user`); default root. Revoke is soft
// (revoked_at) so the list still tells the story. ──
router.get('/settings/cli-tokens', requireOwner, (_req, res) => res.json({ tokens: listCliTokens() }));

router.post('/settings/cli-tokens', requireOwner, (req, res) => {
  try {
    // Minting while the surface is off would hand out credentials that silently don't work — refuse
    // with the pointer instead (list/revoke stay available so the inventory is manageable either way).
    if (!getAuthConfig().cliEnabled) {
      return res.status(409).json({ error: 'The terminal client is disabled — enable it first (the checkbox above).' });
    }
    const forUser = req.body?.userId != null && req.body.userId !== '' ? idParam(req.body.userId) : defaultUserId();
    if (!forUser) return res.status(400).json({ error: 'Invalid user id' });
    const ttlDays = req.body?.ttlDays != null && req.body.ttlDays !== '' ? Number(req.body.ttlDays) : CLI_TOKEN_DEFAULT_TTL_DAYS;
    if (!Number.isFinite(ttlDays) || ttlDays < 0) return res.status(400).json({ error: 'TTL must be a number of days (0 = never expires).' });
    const label = req.body?.label ? String(req.body.label).slice(0, 80) : null;
    // readOnly mints a GET/HEAD-only token — the credential for dashboards / the Home Assistant
    // companion: it can read /api/ha/summary but never write.
    const scope = req.body?.readOnly === true ? 'read' : 'full';
    const token = mintCliToken(forUser, { label, ttlDays, scope });
    res.json({ token, userId: forUser, label, ttlDays, scope });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/settings/cli-tokens/:id/revoke', requireOwner, (req, res) => {
  const id = idParam(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid token id' });
  res.json({ ok: revokeCliToken(id), tokens: listCliTokens() });
});

// ── Demo guard switches (Security panel): pause the demo (non-owner access off everywhere) / freeze
// vouching (no new invites) / open demo signups (the public /demo self-vouch page). Same runtime switches
// the owner's "demo" chat command flips — either surface works mid-incident, no redeploy. Owner-only like
// every global setting. ──
router.get('/settings/guard', requireOwner, (_req, res) => res.json(getGuardConfig()));

router.post('/settings/guard', requireOwner, (req, res) => {
  try {
    const partial = {};
    if (typeof req.body?.vouchFrozen === 'boolean') partial.vouchFrozen = req.body.vouchFrozen;
    if (typeof req.body?.demoPaused === 'boolean') partial.demoPaused = req.body.demoPaused;
    if (typeof req.body?.demoSignupOpen === 'boolean') partial.demoSignupOpen = req.body.demoSignupOpen;
    if (req.body?.demoSignupsPerIp != null) partial.demoSignupsPerIp = req.body.demoSignupsPerIp; // validated in setGuardConfig
    res.json(setGuardConfig(partial));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── System-wide module availability (Settings → Modules → "System modules"): the owner releases modules over
// time or gates them for the WHOLE deployment. A disabled module is off + invisible for every non-owner (the
// owner keeps preview access — enforced in chat's makeIsOn). Same global switches the owner's "system" chat
// command flips. markConfigDirty() bumps the web config version so every open browser refreshes its
// available-module list on the next heartbeat. Owner-only, like every global setting. ──
router.get('/settings/system-modules', requireOwner, (_req, res) => res.json(getSystemModules()));

router.post('/settings/system-modules', requireOwner, (req, res) => {
  try {
    const patch = {};
    for (const k of OPTIN_FEATURES) if (typeof req.body?.[k] === 'boolean') patch[k] = req.body[k];
    const next = setSystemModules(patch);
    markConfigDirty();
    res.json(next);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Vouches: the operator's access-list admin. The access whitelist grows when any authorized user runs
// "vouch @username" in chat; this is where the host reviews who let whom in and revokes when needed. Same
// trust model as the Telegram token / allowedUsername fields above — it's the local operator's own web UI. ──
router.get('/vouches', requireOwner, (_req, res) => res.json({ vouches: listVouches() }));

// Cascade-revoke a handle: soft-revokes it AND everyone in the subtree they vouched (the record is kept).
// Attributed to the acting user so the audit row shows who pulled access.
router.post('/vouches/revoke', requireOwner, (req, res) => {
  try {
    const username = (req.body?.username ?? '').toString();
    if (!username.trim()) return res.status(400).json({ error: 'username required' });
    // Vouches are namespaced by platform (telegram | slack); default telegram for back-compat with old clients.
    const platform = req.body?.platform === 'slack' ? 'slack' : 'telegram';
    const revoked = revokeVouchCascade(username, { byUserId: uid(req), platform });
    res.json({ ok: true, revoked });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Speed Dial: the owner's per-account Home Assistant command pads, managed from the Access tab's expandable
// account list. GET returns every allowed Telegram handle (allowlist ∪ vouches ∪ pads) merged with its pad
// config; the writes create/authorize an account, save its 0-9 slots + lockdown flag, or test-fire a slot
// against the house. Owner-only, like every access-admin route. All house calls reuse the one HA connection. ──
router.get('/accounts', requireOwner, (_req, res) => res.json(accountsData()));

router.post('/accounts', requireOwner, (req, res) => {
  const r = addAccountData(uid(req), (req.body?.username ?? '').toString());
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json(r);
});

router.put('/accounts/:username', requireOwner, (req, res) => {
  const r = savePadData(uid(req), req.params.username, {
    speedDialOnly: req.body?.speedDialOnly === true,
    slots: Array.isArray(req.body?.slots) ? req.body.slots : [],
  });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ...r, ...accountsData() });
});

router.delete('/accounts/:username/pad', requireOwner, (req, res) => {
  removePadData(req.params.username);
  res.json({ ok: true, ...accountsData() });
});

// Owner "Test" button: fire one slot against the house right now and report what HA said (or why it failed).
router.post('/accounts/:username/test/:slot', requireOwner, async (req, res) => {
  try {
    const r = await testSlotData(req.params.username, Number(req.params.slot));
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Mint a shareable "remote control" link for this pad — the host texts a guest {siteUrl}/r/<token> and they
// tap the pad's buttons with no login (routes/remote.js). The raw token + URL come back ONCE (hash-only
// storage), so the panel can show it for copying; the refreshed accountsData carries the active-link list.
router.post('/accounts/:username/share', requireOwner, (req, res) => {
  const r = mintShareLink(req.params.username, {
    ttlDays: Number(req.body?.ttlDays),
    label: (req.body?.label ?? '').toString(),
  });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ...r, ...accountsData() });
});

// Revoke one of this pad's remote-control links (kills it without deleting the audit row). Scoped to the
// username so a stray id can't turn off another pad's link.
router.delete('/accounts/:username/share/:id', requireOwner, (req, res) => {
  const r = revokeShareData(req.params.username, Number(req.params.id));
  if (!r.ok) return res.status(404).json({ error: 'No such active link.' });
  res.json({ ok: true, ...accountsData() });
});

// Today's per-user LLM spend, heaviest first — the demo host's cost dashboard beside the vouch admin.
// Empty when no LLM_USER_DAILY_CALL_CAP is set (nothing is counted then).
router.get('/llm-usage', requireOwner, (_req, res) => res.json({ cap: config.limits.userDailyLlmCalls, usage: usageTodayAll() }));

export default router;
