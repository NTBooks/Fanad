// Per-user daily LLM budget (config.limits.userDailyLlmCalls, env LLM_USER_DAILY_CALL_CAP) — the cost
// control for running vouched-in strangers on a paid cloud key. Every chat()/embed() call charges one unit
// against the calling identity's local-day counter (llm_usage, migration v31); over the cap the call throws
// LLM_BUDGET before any provider work, and the channels turn that into a friendly "you've hit today's
// limit" reply (chat.js) or a 429 (routes/api.js). The owner and root are ALWAYS exempt — the demo host
// must never be locked out of their own box. Cap 0/absent = unlimited (private-box default).
// Identity arrives via the AsyncLocalStorage seam (services/llm/context.js). A null identity means an
// UNTHREADED call path: exempt it (never break a feature over accounting) but warn once per label so the
// gap is discoverable in logs and can be wrapped.
import { db } from './db.js';
import { config } from './config.js';
import { isOwner, ROOT_USER_ID } from './repo.js';

// The budget day is the server's local calendar day ("resets at midnight") — deliberately simpler than the
// diet/journal 02:00 rollover (shared/timeframe.js): this is a cost meter, not a life log.
export function localDayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const warnedLabels = new Set();

// Charge one LLM call to `userId` (or throw LLM_BUDGET when today's cap is spent). Counted on ATTEMPT,
// before the provider call, so retries and failures consume budget too — an erroring loop can't spend for
// free. Synchronous (node:sqlite) — same throw-at-the-factory contract as guardCloud (llm/index.js).
export function takeBudget(userId, label = '') {
  const cap = config.limits.userDailyLlmCalls;
  if (!cap) return;
  if (userId == null) {
    const key = label || '(unlabeled)';
    if (!warnedLabels.has(key)) {
      warnedLabels.add(key);
      console.warn(`[llmBudget] LLM call '${key}' has no user context (runAsLlmUser) — exempt from the daily cap.`);
    }
    return;
  }
  if (Number(userId) === ROOT_USER_ID || isOwner(userId)) return;
  const row = db.prepare(
    `INSERT INTO llm_usage (user_id, day, calls) VALUES (?,?,1)
     ON CONFLICT(user_id, day) DO UPDATE SET calls = calls + 1
     RETURNING calls`,
  ).get(userId, localDayKey());
  if (Number(row.calls) > cap) {
    const err = new Error(`Daily LLM budget spent (${cap} calls).`);
    err.code = 'LLM_BUDGET';
    throw err;
  }
}

// Today's spend for one user — backs the owner's usage view.
export function usageToday(userId) {
  const r = db.prepare('SELECT calls FROM llm_usage WHERE user_id=? AND day=?').get(userId, localDayKey());
  return r ? Number(r.calls) : 0;
}

// All users' spend today, heaviest first — the owner-only GET /api/llm-usage listing.
export function usageTodayAll() {
  return db.prepare(
    `SELECT u.id AS user_id, u.display_name, l.calls FROM llm_usage l
     JOIN users u ON u.id = l.user_id WHERE l.day = ? ORDER BY l.calls DESC`,
  ).all(localDayKey()).map((r) => ({ user_id: Number(r.user_id), display_name: r.display_name, calls: Number(r.calls) }));
}
