// The chart data/render split (server/charts.js): getMetricChartData feeds the web's client-side
// interactive charts; renderMetricChart must keep returning the same PNG payload for Telegram photos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-chartdata-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { getMetricChartData, renderMetricChart } = await import('../server/charts.js');
const { logMetric, measureMetric } = await import('../server/metrics.js');
const { defaultUserId, getMetric, setMetricTarget, setDietDay } = await import('../server/repo.js');
const { dayStartOf } = await import('../shared/timeframe.js');

migrate();
const uid = defaultUserId();

// Seed: a tallied sum metric with a target, and a point metric with two readings.
logMetric(uid, 'water', 2);
logMetric(uid, 'water', 3);
setMetricTarget(uid, getMetric(uid, 'water').id, 8);
measureMetric(uid, 'weight', 182);
measureMetric(uid, 'weight', 181);

test('a tallied metric charts as one aggregated bar per day, target riding along', () => {
  const d = getMetricChartData(uid, 'water', '7d');
  assert.equal(d.series.type, 'bar');
  assert.equal(d.series.x.length, d.series.y.length, 'labels align with values');
  assert.ok(d.series.y.includes(5), "today's bar sums both logs");
  assert.equal(d.metric.target, 8);
  assert.equal(d.metric.measurement_type, 'tallied');
  assert.equal(d.points, 2);
  assert.equal(d.range, '7d');
  assert.ok(d.label, 'timeframe label comes from the server');
});

test('a point metric charts raw readings as a line', () => {
  const d = getMetricChartData(uid, 'weight', '30d');
  assert.equal(d.series.type, 'line');
  assert.deepEqual(d.series.y, [182, 181]);
  assert.equal(d.metric.target, null);
  assert.equal(d.points, 2);
});

test('an unknown metric returns null (the API turns this into a 404)', () => {
  assert.equal(getMetricChartData(uid, 'nope', '30d'), null);
});

test('renderMetricChart still returns the PNG payload (the Telegram photo contract)', () => {
  const r = renderMetricChart(uid, 'water', '7d');
  assert.ok(r.image.startsWith('data:image/png;base64,'), 'PNG data-uri intact after the data/render split');
  assert.equal(r.points, 2);
  assert.ok(r.label);
  assert.equal(renderMetricChart(uid, 'nope'), null);
});

test('the calories chart flags "eat whatever" days (and only the calories metric carries flags)', () => {
  logMetric(uid, 'calories', 500);
  setDietDay(uid, dayStartOf(Date.now()), 'whatever');
  const d = getMetricChartData(uid, 'calories', '7d');
  assert.equal(d.series.type, 'bar');
  assert.equal(d.series.flags.length, d.series.y.length, 'one flag per day');
  assert.equal(d.series.flags.at(-1), true, "today's bar is flagged");
  assert.ok(d.series.flags.slice(0, -1).every((f) => f === false), 'earlier days are not flagged');
  // Every other metric passes no flag set at all — the field stays undefined.
  assert.equal(getMetricChartData(uid, 'water', '7d').series.flags, undefined);
  // The PNG path still renders with the amber bar + band.
  assert.ok(renderMetricChart(uid, 'calories', '7d').image.startsWith('data:image/png;base64,'));
});
