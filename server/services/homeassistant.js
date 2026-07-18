// Home Assistant REST client (the Home Assistant module's outbound half). Fanad is the brain, HA is the
// house annunciator: when a timer/reminder fires the scheduler calls annunciate() here, which fans out to
// the owner-configured outputs (Voice PE announce · script hook · notify push) over HA's REST API with the
// stored long-lived token. Also: `ha <command>` Assist passthrough (converse), a manual per-task calendar
// push, and connection checks for `ha status` / the Settings Test button.
//
// Import rules: settings.js (config) + calendar.js (pure taskEventTime) ONLY — never chat.js (the feature
// registry's no-cycle rule; the per-user opt-in gate lives in the CALLERS, e.g. scheduler.ringHouse).
// Fire-path calls must never throw or block message delivery: annunciate() catches everything and logs
// once per distinct error (the weather.js refreshWeather pattern). User-invoked paths (converse,
// pushTaskToCalendar, checkConnection) throw so the chat reply can say what went wrong.
import { getHomeAssistantConfig } from '../settings.js';
import { taskEventTime } from '../calendar.js';

const TIMEOUT = { service: 5000, status: 5000, converse: 15000 }; // Assist agents may be LLM-backed → longer

async function haFetch(cfg, path, { method = 'GET', body, timeout = TIMEOUT.service } = {}) {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const snippet = (await res.text().catch(() => '')).slice(0, 120);
    const e = new Error(`HA ${method} ${path} → HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`);
    e.status = res.status;
    throw e;
  }
  return res.json().catch(() => null); // some service calls return an empty body
}

// POST /api/services/<domain>/<service> — the one HA endpoint that does things. entity_id rides in data.
export function callService(cfg, domain, service, data, { timeout } = {}) {
  return haFetch(cfg, `/api/services/${domain}/${service}`, { method: 'POST', body: data, timeout });
}

// Liveness + identity for `ha status` / the Settings Test button. Throws on unreachable/bad token.
export async function checkConnection(cfg = getHomeAssistantConfig()) {
  requireConfigured(cfg);
  await haFetch(cfg, '/api/', { timeout: TIMEOUT.status }); // {"message":"API running."} — auth check
  const c = await haFetch(cfg, '/api/config', { timeout: TIMEOUT.status });
  return { ok: true, version: c?.version || '?', locationName: c?.location_name || '', timeZone: c?.time_zone || '' };
}

// `ha <command>` Assist passthrough: pipe free text to HA's conversation agent, return what it said.
export async function converse(text, cfg = getHomeAssistantConfig()) {
  requireConfigured(cfg);
  const body = { text, language: 'en', ...(cfg.agentId ? { agent_id: cfg.agentId } : {}) };
  const r = await haFetch(cfg, '/api/conversation/process', { method: 'POST', body, timeout: TIMEOUT.converse });
  return r?.response?.speech?.plain?.speech || '(no response)';
}

// Settings-panel discovery: list the pickable targets (satellites, calendars, scripts, notify services)
// so the owner chooses from what actually exists instead of typing entity ids. Owner-invoked; throws.
export async function discoverTargets(cfg = getHomeAssistantConfig()) {
  requireConfigured(cfg);
  const states = await haFetch(cfg, '/api/states', { timeout: TIMEOUT.status * 2 });
  const ids = (Array.isArray(states) ? states : []).map((s) => s.entity_id).filter(Boolean).sort();
  const services = await haFetch(cfg, '/api/services', { timeout: TIMEOUT.status * 2 });
  const notifyDomain = (Array.isArray(services) ? services : []).find((d) => d.domain === 'notify');
  return {
    satellites: ids.filter((e) => e.startsWith('assist_satellite.')),
    calendars: ids.filter((e) => e.startsWith('calendar.')),
    scripts: ids.filter((e) => e.startsWith('script.')),
    notifyServices: notifyDomain ? Object.keys(notifyDomain.services || {}).sort() : [],
  };
}

function requireConfigured(cfg) {
  if (!cfg.baseUrl || !cfg.token) throw new Error('Home Assistant is not configured — set the URL and token in Settings.');
}

// ── Pure payload builders (exported for unit tests) ─────────────────────────────────────────────────────

// TTS-safe fire text: no emoji/markdown — this string is SPOKEN by the satellites and shown in pushes.
export function speakable(kind, title) {
  const t = String(title || '').trim();
  if (kind === 'timer') return t ? `Timer done: ${t}.` : 'Timer done.';
  if (kind === 'reminder') return t ? `Reminder: ${t}.` : 'Reminder.';
  return 'This is a test from Fanad.';
}

// assist_satellite.announce — send ONLY message unless preannounce was explicitly set (older HA rejects
// unknown fields on some domains, so the key is omitted entirely when unset).
export function announceCall(entities, message, preannounce = null) {
  const data = { entity_id: entities, message };
  if (typeof preannounce === 'boolean') data.preannounce = preannounce;
  return ['assist_satellite', 'announce', data];
}

// script.turn_on (NOT the direct /api/services/script/<name> form — that BLOCKS until the script body
// finishes, so a siren-with-delay script would eat our timeout; turn_on returns immediately).
export function scriptCall(entity, kind, title) {
  return ['script', 'turn_on', { entity_id: entity, variables: { kind, title: title || '' } }];
}

// notify.<service> — service stored without the notify. prefix (settings normalizes it off).
export function notifyCall(service, kind, message) {
  return ['notify', service, { title: kind === 'timer' ? 'Fanad timer' : kind === 'reminder' ? 'Fanad reminder' : 'Fanad', message }];
}

// calendar.create_event on the configured (Local Calendar) entity. Mirrors the .ics semantics in
// calendar.js: timed → a 30-min block; all-day → start_date + EXCLUSIVE end_date (next local day).
// Times are LOCAL wall-clock with no offset — HA interprets them in its own timezone, which is the
// house's; if the Fanad host and HA disagree on timezone the event shifts (fine for a same-house deploy).
const DEFAULT_EVENT_MS = 30 * 60000;
const DAY_MS = 86400000;
const pad = (n) => String(n).padStart(2, '0');
const localIso = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const localDate = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

export function calendarEventCall(calendarEntity, task) {
  const ev = taskEventTime(task);
  if (!ev) return null;
  const desc = task.original_text && task.original_text !== task.summary ? task.original_text : '';
  const data = { entity_id: calendarEntity, summary: task.summary, ...(desc ? { description: desc } : {}) };
  if (ev.allDay) {
    data.start_date = localDate(ev.at);
    data.end_date = localDate(ev.at + DAY_MS); // exclusive, per HA's create_event contract
  } else {
    data.start_date_time = localIso(ev.at);
    data.end_date_time = localIso(ev.at + DEFAULT_EVENT_MS);
  }
  return ['calendar', 'create_event', data];
}

// ── The annunciator (the scheduler's fire-path entry) ───────────────────────────────────────────────────

let lastFailure = null; // log once per distinct error, clear on success — weather.js:59-63 pattern
export function haProblem() { return lastFailure; }

// Fan out one fired event to every ENABLED output. Never throws; each output is caught individually.
// Returns { ok, failed: [{output, error}] } so `ha test` (and tests) can report per-output results.
export async function annunciate(kind, title, cfg = getHomeAssistantConfig()) {
  if (!cfg.enabled || !cfg.baseUrl || !cfg.token) return { ok: false, failed: [], skipped: true };
  const message = speakable(kind, title);
  const jobs = [];
  if (cfg.announce.enabled && cfg.announce.entities.length) {
    jobs.push(['announce', announceCall(cfg.announce.entities, message, cfg.announce.preannounce)]);
  }
  if (cfg.script.enabled && cfg.script.entity) {
    jobs.push(['script', scriptCall(cfg.script.entity, kind, title)]);
  }
  if (cfg.notify.enabled) {
    for (const s of cfg.notify.services) jobs.push([`notify.${s}`, notifyCall(s, kind, message)]);
  }
  const results = await Promise.allSettled(jobs.map(([, [d, s, data]]) => callService(cfg, d, s, data)));
  const failed = [];
  results.forEach((r, i) => { if (r.status === 'rejected') failed.push({ output: jobs[i][0], error: r.reason?.message || 'unknown' }); });
  if (failed.length) {
    const msg = failed.map((f) => `${f.output}: ${f.error}`).join(' · ');
    if (msg !== lastFailure) { lastFailure = msg; console.error('HA annunciate failed:', msg); }
  } else if (jobs.length) {
    lastFailure = null;
  }
  return { ok: failed.length === 0 && jobs.length > 0, failed };
}

// `ha test`: ring every enabled output NOW and report per-output ✓/✗ (awaited — user-invoked).
export function testOutputs() { return annunciate('test', null); }

// Manual "to HA calendar" push. THROWS on failure (user-invoked; the reply must say why — a 400/404 here
// usually means the Local Calendar integration isn't installed or the entity id is wrong).
export async function pushTaskToCalendar(task, cfg = getHomeAssistantConfig()) {
  requireConfigured(cfg);
  if (!cfg.calendar.entity) throw new Error('No HA calendar entity configured — set one in Settings.');
  const call = calendarEventCall(cfg.calendar.entity, task);
  if (!call) throw new Error('That task has no date.');
  await callService(cfg, call[0], call[1], call[2]);
  return true;
}
