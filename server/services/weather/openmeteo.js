// Open-Meteo weather — NO API key required (default provider).
// A place name → lat/lon via the geocoding API, then current weather. Caching lives in ../weather.js.
const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';

// Resolve a free-text location ("Dublin", "Austin, TX", a postal code) to coordinates. `timezone` is
// the spot's IANA zone (Open-Meteo includes it per hit) — the server adopts it as the app timezone.
export async function geocode(query) {
  const r = await fetch(`${GEO}?name=${encodeURIComponent(query)}&count=1&language=en&format=json`);
  if (!r.ok) throw new Error(`geocode HTTP ${r.status}`);
  const hit = (await r.json()).results?.[0];
  if (!hit) return null;
  return {
    lat: hit.latitude, lon: hit.longitude,
    name: [hit.name, hit.admin1, hit.country_code].filter(Boolean).join(', '),
    timezone: hit.timezone || null,
  };
}

// Current conditions at a coordinate. Returns { tempC, code (WMO), isDay } or null.
export async function getCurrent(lat, lon) {
  const r = await fetch(`${FORECAST}?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,is_day`);
  if (!r.ok) throw new Error(`weather HTTP ${r.status}`);
  const c = (await r.json()).current;
  if (!c) return null;
  return { tempC: Math.round(c.temperature_2m), code: c.weather_code, isDay: c.is_day === 1 };
}
