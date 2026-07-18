// Client-side interactive metric chart — draws the same series the server's PNG renderer uses
// (/api/.../chart-data), but live: animated draw-in, axis tooltips, and colors read from the CSS
// theme tokens so it re-skins itself on day/night/bokeh switches. Telegram keeps the PNG pipeline.
import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { LineChart, BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, TitleComponent, MarkLineComponent, MarkAreaComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, TitleComponent, MarkLineComponent, MarkAreaComponent, SVGRenderer]);

const cssToken = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Theme tokens are hex (#rgb/#rrggbb); anything else (rgba in the bokeh theme) passes through untouched.
function withAlpha(color, alpha) {
  if (!color.startsWith('#')) return color;
  const hex = color.length === 4 ? [...color.slice(1)].map((c) => c + c).join('') : color.slice(1);
  const n = parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Re-render when the root data-theme attribute flips (App owns it) — no prop drilling needed.
function useThemeAttr() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || 'day');
  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(document.documentElement.dataset.theme || 'day'));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

export default function MetricChart({ data, height = 260 }) {
  const boxRef = useRef(null);
  const chartRef = useRef(null);
  const theme = useThemeAttr();
  // Narrow containers (phones, the modules overlay on mobile) get a lighter, smaller chart — thinner
  // line, no shadow, smaller fonts, truncated title, shorter box. Driven by the container's own width,
  // not the viewport, so it also compacts inside a squeezed panel on desktop.
  const [compact, setCompact] = useState(false);
  const compactRef = useRef(false);
  const empty = !data || data.points === 0;

  useEffect(() => {
    if (empty || !boxRef.current) return undefined;
    const chart = echarts.init(boxRef.current, null, { renderer: 'svg' });
    chartRef.current = chart;
    const measure = () => {
      const w = boxRef.current?.clientWidth || 0;
      const next = w > 0 && w < 480;
      if (next !== compactRef.current) { compactRef.current = next; setCompact(next); }
    };
    measure();
    const ro = new ResizeObserver(() => { measure(); chart.resize(); });
    ro.observe(boxRef.current);
    return () => { ro.disconnect(); chart.dispose(); chartRef.current = null; };
  }, [empty]);

  useEffect(() => {
    const chart = chartRef.current;
    if (empty || !chart) return;
    const accent = cssToken('--teal') || '#2f7da3';
    const amber = cssToken('--amber') || '#f3956a';
    const soft = cssToken('--soft') || '#5a6b76';
    const line = cssToken('--line') || '#e1e8ec';
    const ink = cssToken('--ink') || '#22303a';
    const surface = cssToken('--surface') || '#ffffff';
    const { metric, series: s, label } = data;
    // Compact (mobile / narrow) scale-down: lighter line + no shadow + smaller marks/fonts.
    const titleSize = compact ? 11 : 13;
    const axisSize = compact ? 10 : 11;
    const lineW = compact ? 1.5 : 2.5;
    const symSize = compact ? 4 : 6;
    const lineShadow = compact ? {} : { shadowColor: withAlpha(accent, 0.4), shadowBlur: 8, shadowOffsetY: 4 };
    // Truncate a long metric name to the container width rather than letting it spill past the edges.
    const boxW = boxRef.current?.clientWidth || 300;
    // Point metrics ship [epoch, value] pairs → a REAL time axis, so sparse readings keep their true
    // spacing (a week's gap looks like a week). Tallied bars keep the dense per-day category axis.
    const timed = s.type === 'line' && Array.isArray(s.points) && s.points.length > 0;
    const fade = new echarts.graphic.LinearGradient(0, 0, 0, 1, [
      { offset: 0, color: withAlpha(accent, 0.35) },
      { offset: 1, color: withAlpha(accent, 0.02) },
    ]);
    // "eat whatever" days (diet calories only): tint the bar amber and drop a translucent band over the
    // day column, so it reads as off-record even on a zero-calorie day where the bar has no height.
    const barGrad = new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: accent }, { offset: 1, color: withAlpha(accent, 0.45) }]);
    const whateverGrad = new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: amber }, { offset: 1, color: withAlpha(amber, 0.45) }]);
    const barData = timed
      ? s.points
      : s.y.map((v, i) => (s.flags?.[i] ? { value: v, itemStyle: { color: whateverGrad, borderRadius: [4, 4, 0, 0] } } : v));
    const whateverBand = s.flags && s.type === 'bar'
      ? { silent: true, itemStyle: { color: withAlpha(amber, 0.16) }, data: s.x.filter((_, i) => s.flags[i]).map((x) => [{ xAxis: x }, { xAxis: x }]) }
      : null;
    chart.setOption({
      backgroundColor: 'transparent',
      title: {
        text: `${metric.name}${metric.unit ? ` (${metric.unit})` : ''} · ${label}`,
        left: 'center', textStyle: { fontSize: titleSize, fontWeight: 600, color: soft, overflow: 'truncate', ellipsis: '…', width: Math.max(120, boxW - 24) },
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: surface, borderColor: line,
        textStyle: { color: ink, fontSize: 12 },
        valueFormatter: (v) => `${v}${metric.unit ? ` ${metric.unit}` : ''}`,
      },
      // containLabel lets ECharts reserve exactly enough room for the actual axis labels at any width,
      // so a wide y-value (e.g. 4-digit calories) never clips off the left edge on a narrow screen.
      grid: { left: 8, right: 12, top: compact ? 34 : 42, bottom: 6, containLabel: true },
      xAxis: timed
        ? {
          type: 'time',
          axisLabel: { fontSize: axisSize, color: soft, hideOverlap: true, formatter: (ts) => new Date(ts).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }) },
          axisLine: { lineStyle: { color: line } },
          axisTick: { show: false },
          splitLine: { show: false },
        }
        : {
          type: 'category', data: s.x,
          axisLabel: { fontSize: axisSize, color: soft, hideOverlap: true },
          axisLine: { lineStyle: { color: line } },
          axisTick: { show: false },
        },
      yAxis: {
        type: 'value',
        scale: timed, // a weight line hugging 180 shouldn't be squashed onto a 0-based axis; bars keep 0
        axisLabel: { fontSize: axisSize, color: soft },
        splitLine: { lineStyle: { color: line, type: 'dashed' } },
      },
      series: [{
        type: s.type, data: barData, smooth: s.type === 'line',
        itemStyle: s.type === 'bar'
          ? { color: barGrad, borderRadius: [4, 4, 0, 0] }
          : { color: accent },
        lineStyle: { color: accent, width: lineW, ...lineShadow },
        ...(s.type === 'line' ? { areaStyle: { color: fade }, symbol: 'circle', symbolSize: symSize, showSymbol: s.y.length <= 40 } : {}),
        ...(metric.target != null
          ? {
            markLine: {
              silent: true, symbol: 'none',
              data: [{ yAxis: metric.target }],
              lineStyle: { color: amber, type: 'dashed', width: 1.5 },
              label: { color: amber, fontSize: 11, formatter: '🎯 {c}' },
            },
          }
          : {}),
        ...(whateverBand ? { markArea: whateverBand } : {}),
        animationDuration: 600, animationEasing: 'cubicOut',
      }],
    }, { notMerge: true });
  }, [data, theme, empty, compact]);

  if (empty) return <div className="metric-chart empty">No data in this range yet.</div>;
  return <div ref={boxRef} className="metric-chart live" style={{ width: '100%', height: compact ? 200 : height }} />;
}
