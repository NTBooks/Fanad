// The app's timezone, adopted from the admin's weather location: Open-Meteo's geocoder names the IANA
// zone for the spot, we persist it, and every boot re-applies it (no network needed) — so a Coolify/
// Docker box whose clock is UTC still flips days at the USER's 02:00 (shared/timeframe.js) and fires
// wake-ups at the user's wall-clock hour. Precedence: an explicit TZ env var is the operator's override
// and is never fought — the setting applies only when TZ arrived unset. Node honors a runtime
// process.env.TZ change on Linux/macOS (every deployed container); Windows Node ignores it, but a
// Windows install is a personal machine already in the user's timezone — we log when it can't apply.
import { getSetting, setSetting } from './settings.js';

const KEY = 'app:timezone';
let envPinned = false; // TZ came from the environment at boot — deliberate ops choice

export const getAppTimezone = () => getSetting(KEY, null);

const validTz = (tz) => { try { Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };

// Is the process ACTUALLY keeping wall-clock time in tz? Checked functionally (same instant formatted
// both ways) because process.env.TZ is a silent no-op on Windows — never assume the assignment took.
function effective(tz) {
  const now = new Date();
  const inTz = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  return inTz === `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function apply(tz) {
  if (effective(tz)) return true; // already keeping this zone's time (same zone, or an equal-offset twin)
  process.env.TZ = tz;
  if (effective(tz)) { console.log(`timezone: running as ${tz} (from the weather location)`); return true; }
  console.error(`timezone: can't apply ${tz} on this platform (TZ is ignored) — day boundaries follow the system clock`);
  return false;
}

// Boot: re-apply the persisted zone before anything computes dates. Called after migrate().
export function initTimezone() {
  if (process.env.TZ) { envPinned = true; return; }
  const tz = getAppTimezone();
  if (tz && validTz(tz)) apply(tz);
}

// Called whenever the geocoder resolves the weather location — persist the spot's zone and switch to it.
export function adoptTimezone(tz) {
  if (!tz || !validTz(tz)) return;
  if (getAppTimezone() !== tz) setSetting(KEY, tz);
  if (!envPinned) apply(tz);
}
