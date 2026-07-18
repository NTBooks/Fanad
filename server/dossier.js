// The per-user behavior dossier — a durable, human-readable profile Fanad grows from the outcome
// ledger + mood snapshots. It's how Fanad "learns you": what you finish, when, and how you feel.
// Stored as JSON per user; rebuilt on completions and viewable via /me.
import {
  outcomeTotals, doneByCategory, donePhaseByCategory, taskStatusCounts, topReactionMood,
  getUserProfile, saveUserProfile,
} from './repo.js';

export function rebuildDossier(userId, now = Date.now()) {
  const totals = Object.fromEntries(outcomeTotals(userId).map((r) => [r.outcome, r.n]));
  const counts = Object.fromEntries(taskStatusCounts(userId).map((r) => [r.status, r.n]));

  const bestPhase = {};
  for (const r of donePhaseByCategory(userId)) {
    if (!bestPhase[r.category] || r.n > bestPhase[r.category].n) bestPhase[r.category] = { phase: r.ctx_phase, n: r.n };
  }
  const topCategories = doneByCategory(userId).slice(0, 3)
    .map((r) => ({ category: r.category, done: r.n, bestPhase: bestPhase[r.category]?.phase || null }));

  const created = ['available', 'in_progress', 'done', 'snoozed', 'archived'].reduce((s, k) => s + (counts[k] || 0), 0);
  const totalDone = totals.done || 0;

  const dossier = {
    totalDone,
    completionRate: created ? Number((totalDone / created).toFixed(2)) : 0,
    topCategories,
    refused: totals.refused || 0,
    snoozed: totals.snoozed || 0,
    dropped: totals.dropped || 0,
    moodBaseline: topReactionMood(userId),
    updatedAt: now,
  };
  saveUserProfile(userId, dossier);
  return dossier;
}

// Read the cached dossier, rebuilding if it's missing.
export function dossier(userId) {
  return getUserProfile(userId) || rebuildDossier(userId);
}
