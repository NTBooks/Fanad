// Metrics (§13), chat-first. Define arbitrary metrics, log datapoints, get a daily tally. The diet flow
// (eat / canonical foods / recipes) grew into its own module — see server/diet.js — but still logs into
// the 'calories' metric here, so tally/chart cover it unchanged ("undo" is app-wide now — server/undo.js).
import {
  getOrCreateMetric, getMetric, listMetrics, insertMetricValue, metricValuesSince,
} from './repo.js';
import { recordUndo } from './undo.js';
import { resolveTimeframe } from '../shared/timeframe.js';

const round = (n) => Math.round(n * 10) / 10;

function aggregate(values, agg) {
  if (!values.length) return 0;
  const nums = values.map((v) => v.value);
  switch (agg) {
    case 'avg': return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'last': return nums[nums.length - 1];
    case 'max': return Math.max(...nums);
    case 'min': return Math.min(...nums);
    default: return nums.reduce((a, b) => a + b, 0); // sum
  }
}

// skipZero (full-tally only): drop a metric with nothing to show — a tallied value that rounds to
// 0, or a point metric with no reading (or a last reading of 0). Callers that name a single metric
// leave it off, so an explicit `/tally steps` still prints `• steps: 0`.
function metricLine(userId, metric, { skipZero = false } = {}) {
  const unit = metric.unit ? ` ${metric.unit}` : '';
  // A point/gauge metric (e.g. blood pressure) isn't tallied — show its most recent reading.
  if (metric.measurement_type === 'point') {
    const vals = metricValuesSince(userId, metric.id, 0);
    const last = vals.length ? vals[vals.length - 1] : null;
    if (skipZero && (!last || round(last.value) === 0)) return null;
    return last ? `• ${metric.name}: ${round(last.value)}${unit} (last reading)` : `• ${metric.name}: — (no readings)`;
  }
  const { start } = resolveTimeframe('today');
  const today = aggregate(metricValuesSince(userId, metric.id, start), metric.aggregation);
  if (skipZero && round(today) === 0) return null;
  const target = metric.target != null ? ` / ${round(metric.target)}${unit}` : unit;
  return `• ${metric.name}: ${round(today)}${target}`;
}

export function tallyText(userId, name = null) {
  if (name) {
    const m = getMetric(userId, name);
    return m ? metricLine(userId, m) : `I'm not tracking “${name}” yet. Try: track ${name} <number>`;
  }
  const ms = listMetrics(userId);
  if (!ms.length) return 'No metrics yet. Try: track water 3   (or: metric add weight kg last)';
  const lines = ms.map((m) => metricLine(userId, m, { skipZero: true })).filter(Boolean);
  if (!lines.length) return 'Today: nothing logged yet.';
  return `Today:\n${lines.join('\n')}`;
}

export function defineMetric(userId, name, unit, aggregation) {
  const m = getOrCreateMetric(userId, name, { unit, aggregation });
  return `Tracking ${m.name}${m.unit ? ` (${m.unit})` : ''} as ${m.aggregation}. Log it with: track ${m.name} <number>`;
}

export function logMetric(userId, name, value, note) {
  const m = getOrCreateMetric(userId, name, { aggregation: 'sum' });
  const id = insertMetricValue({ userId, metricId: m.id, value, note });
  recordUndo(userId, 'metric_log', { ids: [id] }, `↩ Undid ${m.name}: ${value}${m.unit ? ` ${m.unit}` : ''}.`);
  return `Logged ${m.name}: ${value}${m.unit ? ` ${m.unit}` : ''}.\n${metricLine(userId, getMetric(userId, name))}`;
}

// A one-off reading we record but don't tally (e.g. "measure bp 120"). Stored as a 'point' metric so
// the tally shows the latest value instead of a daily sum (§13).
export function measureMetric(userId, name, value, note) {
  const m = getOrCreateMetric(userId, name, { aggregation: 'last', measurementType: 'point' });
  const id = insertMetricValue({ userId, metricId: m.id, value, note });
  recordUndo(userId, 'metric_log', { ids: [id] }, `↩ Undid the ${m.name} reading (${value}${m.unit ? ` ${m.unit}` : ''}).`);
  return `Measured ${m.name}: ${value}${m.unit ? ` ${m.unit}` : ''}.\n${metricLine(userId, getMetric(userId, name))}`;
}

// (The old label-group undoLast lived here; "undo" is app-wide now — see server/undo.js.)
