// Cached current-weather for the status chip + state snapshots (§3). The location is set in Settings
// (a place name); geocoding + conditions come from Open-Meteo (no key). currentWeather() is SYNC — it
// returns the in-memory cache and kicks a background refresh when stale, so callers never block on fetch.
import { getSetting, setSetting } from './settings.js';
import { adoptTimezone } from './timezone.js';
import * as openmeteo from './services/weather/openmeteo.js';

const TTL = 15 * 60 * 1000; // refresh conditions at most ~every 15 min
let cache = null;           // { emoji, label, tempC, at }
let geo = null;             // resolved { lat, lon, name } for the configured location
let refreshing = false;
let lastFailure = null;     // last refresh error message (null when healthy) — logged once per distinct error

export function getWeatherConfig() {
  const o = getSetting('weather', {}) || {};
  return { location: o.location || '', unit: o.unit === 'C' ? 'C' : 'F' }; // default Fahrenheit
}
export function setWeatherConfig(partial = {}) {
  const cur = getSetting('weather', {}) || {};
  setSetting('weather', { ...cur, ...partial });
  // Only a location change needs a re-resolve/re-fetch; a unit change is display-only.
  if (partial.location !== undefined && partial.location !== cur.location) { geo = null; cache = null; }
  return getWeatherConfig();
}

const toUnit = (tempC, unit) => (unit === 'C' ? tempC : Math.round((tempC * 9) / 5 + 32));

// WMO weather code → a short emoji + label.
function describe(code, isDay) {
  if (code === 0) return { emoji: isDay ? '☀️' : '🌙', label: 'clear' };
  if (code <= 2) return { emoji: isDay ? '🌤️' : '☁️', label: 'partly cloudy' };
  if (code === 3) return { emoji: '☁️', label: 'cloudy' };
  if (code <= 48) return { emoji: '🌫️', label: 'foggy' };
  if (code <= 57) return { emoji: '🌦️', label: 'drizzle' };
  if (code <= 67) return { emoji: '🌧️', label: 'rain' };
  if (code <= 77) return { emoji: '❄️', label: 'snow' };
  if (code <= 82) return { emoji: '🌧️', label: 'showers' };
  if (code <= 86) return { emoji: '🌨️', label: 'snow showers' };
  return { emoji: '⛈️', label: 'thunderstorm' };
}

export async function refreshWeather() {
  const { location } = getWeatherConfig();
  if (!location) { cache = null; return null; }
  if (refreshing) return cache;
  refreshing = true;
  try {
    if (!geo) {
      geo = await openmeteo.geocode(location);
      // The location names the user's timezone too — the server adopts it so day boundaries and
      // wake-ups run on THEIR wall clock, whatever zone the host box happens to be in (timezone.js).
      if (geo?.timezone) adoptTimezone(geo.timezone);
    }
    if (!geo) { cache = null; lastFailure = null; return null; } // resolved but unknown place — not a failure
    const cur = await openmeteo.getCurrent(geo.lat, geo.lon);
    if (cur) { const d = describe(cur.code, cur.isDay); cache = { emoji: d.emoji, label: d.label, tempC: cur.tempC, at: Date.now() }; }
    lastFailure = null;
    return cache;
  } catch (err) {
    // Serve stale on a transient failure, never throw into the request path — but a PERSISTENT failure
    // (DNS/TLS/Open-Meteo down) must not be zero-log-lines-forever: log once per distinct error.
    if (err?.message !== lastFailure) { lastFailure = err?.message || 'unknown'; console.error('Weather refresh failed (serving stale):', lastFailure); }
    return cache;
  } finally {
    refreshing = false;
  }
}

// Why the last refresh produced nothing (or null when healthy) — so the settings save path can tell a
// network failure apart from a place the geocoder simply doesn't know.
export function weatherProblem() { return lastFailure; }

// Synchronous accessor for the request path. Returns { weather, emoji, temp, unit } or null. temp is
// converted to the configured unit (default °F).
export function currentWeather() {
  if (!cache || Date.now() - cache.at >= TTL) refreshWeather().catch(() => {}); // background top-up
  if (!cache) return null;
  const unit = getWeatherConfig().unit;
  return { weather: cache.label, emoji: cache.emoji, temp: toUnit(cache.tempC, unit), unit };
}
