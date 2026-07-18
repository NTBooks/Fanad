// The Metrics module (opt-in): command shapes for track / measure / tally / chart. The engine stays in
// server/metrics.js (definitions, tallies) and server/charts.js (rendering); this module is only its chat
// surface. The old "eat" flow moved to the Diet module (features/diet.js) — it still logs into the
// calories metric, so tally/chart cover it. Genuine command shapes are gated by isOn('metrics'); prose
// never reaches here.
import { defineMetric, logMetric, measureMetric, tallyText } from '../metrics.js';
import { renderMetricChart } from '../charts.js';
import { registerFeature } from './registry.js';

function renderChart(userId, name, range) {
  const r = renderMetricChart(userId, name, range || '30d');
  if (!r) return `I'm not tracking “${name}” yet. Try: track ${name} <number>`;
  return { text: `📈 ${name} · ${r.label}${r.points ? '' : ' (no data yet)'}`, image: r.image };
}

// Each run() re-checks the gate itself: an off module answers with the turn-on offer, never silence.
const gated = (fn) => (ctx, hit) => (ctx.isOn('metrics') ? fn(ctx, hit) : ctx.offerOn('metrics'));

registerFeature({
  name: 'metrics',
  commands: [
    { match: ({ lower }) => lower === '/metrics' || lower === 'metrics',
      run: gated(({ userId }) => tallyText(userId)) },
    { match: ({ lower }) => lower === '/tally' || lower === 'tally' || lower.startsWith('/tally ') || lower.startsWith('tally '),
      run: gated(({ userId, t }) => tallyText(userId, t.replace(/^\/?tally\s*/i, '').trim() || null)) },
    { match: ({ t }) => /^\/?metric\s+add\s+([a-z0-9_]+)(?:\s+([a-z%]+))?(?:\s+(sum|avg|last|max|min))?/i.exec(t),
      run: gated(({ userId }, m) => defineMetric(userId, m[1], m[2] || null, m[3] || 'sum')) },
    { match: ({ t }) => /^\/?measure\s+([a-z0-9_]+)\s+(-?\d+(?:\.\d+)?)\s*(.*)$/i.exec(t),
      run: gated(({ userId }, m) => measureMetric(userId, m[1], Number(m[2]), m[3].trim() || null)) },
    { match: ({ t }) => /^\/?track\s+([a-z0-9_]+)\s+(-?\d+(?:\.\d+)?)\s*(.*)$/i.exec(t),
      run: gated(({ userId }, m) => logMetric(userId, m[1], Number(m[2]), m[3].trim() || null)) },
    { match: ({ t }) => /^\/?chart\s+([a-z0-9_]+)(?:\s+(\S+))?/i.exec(t),
      run: gated(({ userId }, m) => renderChart(userId, m[1], m[2])) },
    // ("undo" left this module: it's app-wide now — matched in route() ahead of the dialog check, backed
    // by the undo stack in server/undo.js. track/measure still push their rows onto it above the engine.)
  ],
});
