// GET /api/ha/summary's payload builder: ONE versioned, read-only aggregate that
// Home Assistant dashboards read — the REST-sensor YAML recipes and the companion integration both consume
// exactly this contract, nothing else. Counts and timestamps by default; the ONLY content (task/timer/batch
// titles) rides behind an explicit `titles` opt-in, because entity states flow into HA's recorder, logbook,
// and whatever voice assistant the user wired up. Module blocks mirror the per-user opt-ins (chat.js
// makeIsOn): a block is null when that module is off for the identity — no entity spam from unused modules.
// Bump `version` on ANY shape change; the drift test (test/haSummary.test.js) pins the current shape.
import {
  listTasks, activeTimers, pendingReminders, latestMood,
  listJournals, getJournalEntry, listMetrics, getMetric, metricValuesSince,
  countListChildren, countAllListItems, latestOpenBatch, getDietDay,
} from './repo.js';
import { isFeatureOnFor } from './chat.js';
import { localDateKey } from './journal.js';
import { DAY_ROLLOVER_HOUR, dayStartOf } from '../shared/timeframe.js';

export const HA_SUMMARY_VERSION = 1;

const DAY_MS = 86400000;
const iso = (ms) => (ms == null ? null : new Date(Number(ms)).toISOString());

// identityId drives the module gates (a module is on for the ACCOUNT), dataId the numbers (the account's
// current notebook space) — the same uid/dataUid split every /api route uses.
export function buildHaSummary(identityId, dataId, { titles = false, now = Date.now() } = {}) {
  const dayStart = dayStartOf(now);
  const isOn = (name) => isFeatureOnFor(identityId, name);

  // ── tasks (core, always present). "live" = still owed AND visible: available / in_progress / snoozed,
  // minus auto-slept rows (status stays 'available', slept_at is the marker — the app's open list hides
  // them, so the dashboard count must match what the user sees, not the raw table).
  const tasks = listTasks(dataId); // excludes archived
  const slept = tasks.filter((t) => t.slept_at != null && t.status === 'available');
  const live = tasks.filter((t) => t.slept_at == null
    && (t.status === 'available' || t.status === 'in_progress' || t.status === 'snoozed'));
  const dued = live.filter((t) => t.due_at != null);
  const started = tasks.filter((t) => t.status === 'in_progress').sort((a, b) => (b.started_at || 0) - (a.started_at || 0))[0] || null;
  const nextDue = dued.filter((t) => t.due_at > now).sort((a, b) => a.due_at - b.due_at)[0] || null;
  const nextReminder = pendingReminders(dataId, now)[0] || null;
  const taskBlock = {
    open: live.length,
    slept: slept.length,
    snoozed: live.filter((t) => t.status === 'snoozed').length,
    // A task due earlier today is in BOTH buckets — overdue is "past due now", due_today is "due during
    // today's logical day". Documented on the sensors; do not "fix" the overlap.
    due_today: dued.filter((t) => t.due_at >= dayStart && t.due_at < dayStart + DAY_MS).length,
    overdue: dued.filter((t) => t.due_at <= now).length,
    cleared_today: tasks.filter((t) => t.status === 'done' && (t.completed_at || 0) >= dayStart).length,
    captured_today: tasks.filter((t) => t.created_at >= dayStart).length,
    next_deadline: iso(nextDue?.due_at),
    next_reminder: iso(nextReminder?.remind_at),
    active: started
      ? { state: 'active', started_at: iso(started.started_at), ...(titles ? { title: started.summary } : {}) }
      : { state: 'idle' },
  };

  // ── module blocks (null = off for this account; the integration creates no entities for a null block)
  const modules = {};

  if (isOn('timer')) {
    const timers = activeTimers(dataId);
    modules.timer = {
      count: timers.length,
      next_fire: iso(timers[0]?.fire_at), // activeTimers orders by fire_at
      ...(titles && timers[0]?.label ? { label: timers[0].label } : {}),
    };
  } else modules.timer = null;

  if (isOn('diet')) {
    const cal = getMetric(dataId, 'calories');
    const todayVals = cal ? metricValuesSince(dataId, cal.id, dayStart) : [];
    const w = getMetric(dataId, 'weight');
    const weights = w ? metricValuesSince(dataId, w.id, 0) : [];
    const lastW = weights.reduce((best, v) => (best == null || v.recorded_at >= best.recorded_at ? v : best), null);
    modules.diet = {
      calories_today: Math.round(todayVals.reduce((s, v) => s + v.value, 0)),
      target: cal?.target ?? null,
      whatever_day: !!getDietDay(dataId, dayStart),
      weight_last: lastW ? lastW.value : null,
      weight_unit: w?.unit || null,
      weight_at: iso(lastW?.recorded_at),
    };
  } else modules.diet = null;

  if (isOn('journal')) {
    const journals = listJournals(dataId);
    const todayKey = localDateKey(now);
    modules.journal = {
      journals: journals.length,
      entries_today: journals.filter((j) => getJournalEntry(dataId, j.id, todayKey)).length,
    };
  } else modules.journal = null;

  if (isOn('metrics')) {
    // Names ARE the point of user-defined metrics — a "metric #3" sensor is useless — so they're included
    // regardless of `titles` (they name a series, they don't carry an entry's content). Say so in the docs.
    modules.metrics = listMetrics(dataId).map((m) => {
      const today = metricValuesSince(dataId, m.id, dayStart);
      return {
        id: m.id, name: m.name, unit: m.unit || null, aggregation: m.aggregation, target: m.target ?? null,
        today: Math.round(today.reduce((s, v) => s + v.value, 0) * 100) / 100,
        count_today: today.length,
      };
    });
  } else modules.metrics = null;

  if (isOn('lists')) {
    modules.lists = { lists: countListChildren(dataId, null), items: countAllListItems(dataId) };
  } else modules.lists = null;

  if (isOn('batches')) {
    const b = latestOpenBatch(dataId);
    modules.batches = b
      ? { active: true, batch_no: b.batch_no, ...(titles ? { name: b.name } : {}) }
      : { active: false, batch_no: null };
  } else modules.batches = null;

  return {
    version: HA_SUMMARY_VERSION,
    generated_at: iso(now),
    // The 02:00 logical-day boundary is server-owned — HA "today" sensors reset HERE, not at midnight.
    day: { start: dayStart, key: localDateKey(now), rollover_hour: DAY_ROLLOVER_HOUR },
    mood: latestMood(dataId, dayStart),
    tasks: taskBlock,
    modules,
  };
}
