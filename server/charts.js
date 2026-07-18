// Render a metric's recent history to a PNG data-URI — works inline in web (<img>) and via Telegram
// sendPhoto. Pipeline (PLAN §13.6): ECharts SSR → SVG string → resvg → PNG buffer.
import { createRequire } from 'node:module';
import * as echarts from 'echarts';
import { Resvg } from '@resvg/resvg-js';
import { getMetric, metricValuesSince, listDietDays } from './repo.js';
import { resolveTimeframe, dayStartOf } from '../shared/timeframe.js';

// Bundled fonts: resvg rasterizes the SVG's <text> with whatever fonts the HOST has, and a slim Linux
// container has NONE — every title and axis label silently disappears and Telegram gets a bare line on
// gridlines. Ship DejaVu Sans (freely redistributable) and route the generic sans-serif family to it, so
// the chart renders identically on a Windows dev box and a font-less deploy. System fonts are skipped
// when the bundle resolves — deterministic output beats whatever the host happens to have installed.
const requireFile = createRequire(import.meta.url);
let FONT_FILES = [];
try {
  FONT_FILES = [
    requireFile.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf'),
    requireFile.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf'), // the title is bold
  ];
} catch { /* dep missing (partial install) — fall back to system fonts rather than render nothing */ }
const FONT_OPTIONS = {
  loadSystemFonts: FONT_FILES.length === 0,
  fontFiles: FONT_FILES,
  defaultFontFamily: 'DejaVu Sans',
  sansSerifFamily: 'DejaVu Sans',
};

const WIDTH = 720;
const HEIGHT = 360;
const DAY = 86400000;
const round = (n) => Math.round(n * 10) / 10;
const startOfDay = dayStartOf; // day buckets follow the app-wide 02:00 rollover

function aggOf(aggregation, nums) {
  switch (aggregation) {
    case 'avg': return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'last': return nums[nums.length - 1];
    case 'max': return Math.max(...nums);
    case 'min': return Math.min(...nums);
    default: return nums.reduce((a, b) => a + b, 0);
  }
}

// Point metrics → raw readings as a line; tallied metrics → one aggregated bar per day. `flagged` is a
// Set of day-start epochs the diet module marked "eat whatever" (empty/undefined for every other metric),
// surfaced as a per-day `flags` array so renderers can tint those days.
function buildSeries(metric, values, tf, flagged) {
  if (metric.measurement_type === 'point') {
    return {
      type: 'line',
      x: values.map((v) => new Date(v.recorded_at).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })),
      y: values.map((v) => round(v.value)),
      // [epoch-ms, value] pairs for a REAL time axis (the web chart): readings a week apart sit a week
      // apart, not one category-slot apart. x/y stay for the PNG path and any older consumers.
      points: values.map((v) => [v.recorded_at, round(v.value)]),
    };
  }
  const byDay = new Map();
  for (const v of values) {
    const k = startOfDay(v.recorded_at);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(v.value);
  }
  const days = [];
  for (let t = startOfDay(tf.start); t < tf.end; t += DAY) days.push(t);
  return {
    type: 'bar',
    x: days.map((t) => new Date(t).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })),
    y: days.map((t) => (byDay.has(t) ? round(aggOf(metric.aggregation, byDay.get(t))) : 0)),
    flags: flagged ? days.map((t) => flagged.has(t)) : undefined,
  };
}

// The data half of a chart — everything the web client needs to draw it interactively (the server stays
// the source of truth for labels/target/units; the client adds only presentation).
// Returns { metric:{name,unit,target,aggregation,measurement_type}, series:{type,x,y}, label, points, range }
// or null if the metric doesn't exist.
export function getMetricChartData(userId, name, range = '30d') {
  const metric = getMetric(userId, name);
  if (!metric) return null;
  const tf = resolveTimeframe(range);
  const values = metricValuesSince(userId, metric.id, tf.start).filter((v) => v.recorded_at < tf.end);
  // Only the diet 'calories' metric carries "eat whatever" day markers; every other metric passes none.
  const flagged = name === 'calories'
    ? new Set(listDietDays(userId, startOfDay(tf.start)).map((d) => d.day_start))
    : null;
  const series = buildSeries(metric, values, tf, flagged);
  return {
    metric: {
      name: metric.name,
      unit: metric.unit ?? null,
      target: metric.target ?? null,
      aggregation: metric.aggregation ?? null,
      measurement_type: metric.measurement_type,
    },
    series,
    label: tf.label,
    points: values.length,
    range,
  };
}

// The render half — same data, drawn to a PNG data-URI for Telegram sendPhoto and <img> fallbacks.
// Returns { image: data-uri, label, points, metric } or null if the metric doesn't exist.
export function renderMetricChart(userId, name, range = '30d') {
  const d = getMetricChartData(userId, name, range);
  if (!d) return null;
  const { metric, series: s, label } = d;

  // "eat whatever" days: an amber bar plus a translucent band over the day column, so the day reads as
  // off-record even when nothing was logged (a zero-height bar would otherwise be invisible).
  const WHATEVER = '#d9a441';
  const barData = s.flags
    ? s.y.map((v, i) => (s.flags[i] ? { value: v, itemStyle: { color: WHATEVER } } : v))
    : s.y;
  const whateverBand = s.flags
    ? { silent: true, itemStyle: { color: 'rgba(217,164,65,0.18)' }, data: s.x.filter((_, i) => s.flags[i]).map((x) => [{ xAxis: x }, { xAxis: x }]) }
    : null;

  const option = {
    backgroundColor: '#ffffff',
    title: { text: `${metric.name}${metric.unit ? ` (${metric.unit})` : ''} · ${label}`, left: 'center', textStyle: { fontSize: 16 } },
    // containLabel reserves exactly enough room for the actual axis labels, so a wide y-value (4-digit
    // calories) can't clip within the fixed 720px canvas; the small fixed margins are just the outer gap.
    grid: { left: 12, right: 24, top: 56, bottom: 12, containLabel: true },
    xAxis: { type: 'category', data: s.x, axisLabel: { fontSize: 11 } },
    // scale:true fits the axis to the data instead of forcing zero — a weight hovering at 182 should fill
    // the frame, not sit as a flat line atop 180 pixels of nothing. Bars keep the zero base (a tally's
    // day-to-day HEIGHT comparison is the whole point; cropping the base would lie about ratios).
    yAxis: { type: 'value', scale: s.type === 'line', axisLabel: { fontSize: 11 } },
    series: [{
      type: s.type, data: barData, smooth: s.type === 'line',
      itemStyle: { color: '#2f7da3' }, lineStyle: { color: '#2f7da3', width: 2 },
      ...(metric.target != null
        ? { markLine: { silent: true, symbol: 'none', data: [{ yAxis: metric.target }], lineStyle: { color: '#f3956a', type: 'dashed' } } }
        : {}),
      ...(whateverBand ? { markArea: whateverBand } : {}),
    }],
  };

  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: WIDTH, height: HEIGHT });
  chart.setOption(option);
  const svg = chart.renderToSVGString();
  chart.dispose();
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH }, font: FONT_OPTIONS }).render().asPng();
  return { image: `data:image/png;base64,${png.toString('base64')}`, label, points: d.points, metric };
}
