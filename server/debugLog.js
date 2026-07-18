// Optional in-memory log capture for the web debug panel. OFF unless DEBUG_LOG is set (config.debugLog).
// When on, console.log/warn/error are tee'd into a small ring buffer that GET /api/debug/logs serves to
// the client — so you can watch server errors (e.g. the Telegram [tg] lines) without the terminal.
// Dev-only aid: it exposes raw server logs to any client, so never enable it in production.
const MAX = 300; // ring-buffer size; oldest lines drop off
const buffer = [];
let seq = 0;
let installed = false;

function stringify(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || a.message;
  try { return JSON.stringify(a); } catch { return String(a); }
}

function record(level, args) {
  buffer.push({ seq: ++seq, t: Date.now(), level, msg: args.map(stringify).join(' ') });
  if (buffer.length > MAX) buffer.shift();
}

// Wrap console so logging is still printed to the terminal AND captured. Idempotent.
export function enableDebugLog() {
  if (installed) return;
  installed = true;
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => { try { record(level, args); } catch { /* never let capture break logging */ } orig(...args); };
  }
}

// Return lines newer than `since` (a seq), plus the latest seq so the client can poll incrementally.
export function getDebugLog(since = 0) {
  return { logs: buffer.filter((e) => e.seq > since), seq };
}
