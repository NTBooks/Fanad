// Weather config (§3). No network here — we only verify config get/set and the null-until-set behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-weather-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { getWeatherConfig, setWeatherConfig, currentWeather } = await import('../server/weather.js');
const { getAppTimezone, adoptTimezone } = await import('../server/timezone.js');

migrate();

test('no location set → empty config and a null current reading (no fetch)', () => {
  assert.equal(getWeatherConfig().location, '');
  assert.equal(currentWeather(), null);
});

test('setting a location is persisted (we do NOT call currentWeather here → no network)', () => {
  assert.equal(setWeatherConfig({ location: 'Dublin' }).location, 'Dublin');
  assert.equal(getWeatherConfig().location, 'Dublin');
});

test('temperature unit defaults to Fahrenheit and a switch to Celsius persists', () => {
  assert.equal(getWeatherConfig().unit, 'F');
  assert.equal(setWeatherConfig({ unit: 'C' }).unit, 'C');
  assert.equal(getWeatherConfig().unit, 'C');
});

// ── App timezone (adopted from the geocoded weather location; see server/timezone.js) ──

test('no location resolved yet → no app timezone', () => {
  assert.equal(getAppTimezone(), null);
});

test('adopting the system’s own zone persists it (a same-zone apply is a no-op)', () => {
  const sys = Intl.DateTimeFormat().resolvedOptions().timeZone;
  adoptTimezone(sys);
  assert.equal(getAppTimezone(), sys);
});

test('garbage and empty zones are ignored, never persisted', () => {
  const before = getAppTimezone();
  adoptTimezone('Not/AZone');
  adoptTimezone('');
  adoptTimezone(null);
  assert.equal(getAppTimezone(), before);
});

// LAST in this file on purpose: on Linux/macOS this flips THIS test process's tz (files run isolated).
test('a different zone from a new location is persisted (the setting, not the platform, is asserted)', () => {
  adoptTimezone('Pacific/Auckland');
  assert.equal(getAppTimezone(), 'Pacific/Auckland');
});
