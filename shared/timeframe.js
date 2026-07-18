// Resolve a plain-language timeframe into a [start, end) epoch-ms range. Local time, week starts Monday.
// Kept tiny and dependency-free for the prototype.
const DAY = 86400000;

// The logical day flips at 02:00 local, not midnight — a 1am snack or journal line belongs to the
// evening's day. App-wide convention: every day bucket/key derives from dayStartOf (charts, the diet
// log windows, journal's localDateKey, the "today" tally here). "Local" is the SERVER's clock — on a
// container host set the TZ env var to the user's timezone or days flip at the wrong wall-clock hour.
export const DAY_ROLLOVER_HOUR = 2;
const ROLLOVER_MS = DAY_ROLLOVER_HOUR * 3600000;
// Start (epoch ms, = 02:00 local) of the logical day containing ts.
export function dayStartOf(ts) {
  const x = new Date(ts - ROLLOVER_MS); // shift so 00:00–02:00 lands on yesterday's calendar date
  x.setHours(0, 0, 0, 0);
  return x.getTime() + ROLLOVER_MS;
}

export function resolveTimeframe(input = 'this_week') {
  const now = Date.now();
  const today0 = dayStartOf(now);
  const mondayOffset = (new Date(today0).getDay() + 6) % 7; // 0 = Monday
  const thisMonday = today0 - mondayOffset * DAY;

  const key = String(input).toLowerCase().trim().replace(/\s+/g, '_');

  // Chart-style ranges: "7d" / "30d" / "90d" → N days back; "ytd" → since Jan 1 (§13.7).
  const nd = /^(\d+)d$/.exec(key);
  if (nd) { const n = Number(nd[1]); return { start: now - n * DAY, end: now, label: `the past ${n} days` }; }
  if (key === 'ytd') { const y = new Date(today0); y.setMonth(0, 1); return { start: y.getTime(), end: now, label: 'year to date' }; }

  switch (key) {
    case 'today': return { start: today0, end: now, label: 'today' };
    case 'yesterday': return { start: today0 - DAY, end: today0, label: 'yesterday' };
    case 'this_week': return { start: thisMonday, end: now, label: 'this week' };
    case 'last_week': return { start: thisMonday - 7 * DAY, end: thisMonday, label: 'last week' };
    case 'this_month': { const m = new Date(today0); m.setDate(1); return { start: m.getTime(), end: now, label: 'this month' }; }
    case 'past_week':
    case 'last_7_days': return { start: now - 7 * DAY, end: now, label: 'the past 7 days' };
    default: return { start: thisMonday, end: now, label: 'this week' };
  }
}
