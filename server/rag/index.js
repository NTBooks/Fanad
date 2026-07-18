// Data-grounded suggestion engine: retrieve → score → phrase.
// CLOSED-WORLD INVARIANT: retrieval decides what exists; the LLM only orders/phrases a closed
// candidate set and may never invent rows. An id allow-list backstop rejects any invented id.
import { embed, chat } from '../services/llm/index.js';
import { recordAiEvent } from '../aiLog.js';
import { getLlmConfig } from '../settings.js';
import { cosine } from './vector.js';
import { timeOfDay } from '../../shared/state.js';
import { currentWeather } from '../weather.js';
import {
  insertEmbedding, listAvailableTasksWithVectors, listNotesWithVectors,
  sweepSnoozed, expireDueTasks, recordSuggestion, refusalRateHere, outcomeStats,
} from '../repo.js';
import { dueLabel, isDueToday } from '../services/llm/deadline.js';
import { DECIDE_TASK_SYSTEM, REFINE_SYSTEM, DECOMPOSE_SYNTH, DECOMPOSE_CONSERVATIVE, decomposeSystem } from '../services/llm/prompts.js';

const EFFORT = { trivial: 0, low: 1, medium: 2, high: 3 };

// ── embedding write-path (called on ingest) ──
async function embedText(text) {
  // A missing vector is permanent for this row (nothing re-embeds it later short of a manual reindex —
  // see server/scripts/reindex-embeddings.js), so a silent failure here degrades RAG forever: log it.
  try { return await embed(text); }
  catch (err) { console.error('[rag] embed failed — row stored without a vector:', err.message); return null; }
}
// Stamp each row with the model that produced its vector (cloud providers nest the embed model under the
// provider key; locals keep it top-level). Mixing models silently corrupts cosine — recording it lets a
// reindex tell stale vectors apart. See server/scripts/reindex-embeddings.js.
export function embedModelId() {
  const c = getLlmConfig();
  const p = c.embedProvider;
  return ((p === 'openai' || p === 'gemini') ? c[p]?.embedModel : c.embedModel) || null;
}
export async function embedTask(task) {
  const vec = await embedText(task.summary);
  if (vec) insertEmbedding({ userId: task.user_id, ownerType: 'task', ownerId: task.id, vector: vec, model: embedModelId() });
  return vec;
}
export async function embedNote(note) {
  const vec = await embedText(note.text);
  if (vec) insertEmbedding({ userId: note.user_id, ownerType: 'note', ownerId: note.id, vector: vec, model: embedModelId() });
  return vec;
}

// Recall notes by meaning (embedding cosine) + keyword. Data-grounded — returns real notes only. §15.
export async function recallNotes(userId, query, limit = 8) {
  const notes = listNotesWithVectors(userId);
  if (!notes.length) return [];
  const q = (query || '').trim().toLowerCase();
  let qv = null;
  try { if (q) qv = await embed(query); }
  catch (err) { console.error('[rag] query embed failed — recall degrades to keyword-only:', err.message); }
  return notes
    .map((n) => {
      const sim = qv && n.vec ? cosine(qv, n.vec) : 0;
      const kw = q && n.text.toLowerCase().includes(q) ? 1 : 0;
      return { ...n, score: 0.7 * sim + 0.3 * kw };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ── scoring helpers (deterministic; exported pure signals reused by the task-list relevance tail) ──
export function effortFit(effort, energy) {
  if (!energy) return 0.5;
  const target = energy === 'low' ? 0 : energy === 'high' ? 3 : 1.5;
  return Math.max(0, 1 - Math.abs((EFFORT[effort] ?? 1.5) - target) / 3);
}
export function recency(createdAt) {
  return Math.max(0, 1 - (Date.now() - createdAt) / (30 * 86400000));
}
function contextText(state = {}) {
  const p = [];
  if (state.timeOfDay) p.push(`time ${state.timeOfDay}`);
  if (state.mood) p.push(`mood ${state.mood}`);
  if (state.energy) p.push(`${state.energy} energy`);
  if (state.query) p.push(state.query);
  return p.join('. ') || 'general';
}
function templateReason(t, state) {
  const e = state?.energy ? ` for ${state.energy} energy` : '';
  return `A good next step${e} — ${t.effort_level} effort.`;
}

// ── LLM decision — the actual recommender. The model READS a rich, deterministically-prefiltered shortlist
// and CHOOSES the single best next task with an honest reason, rather than just phrasing a pre-decided pick.
// Tuned for a capable model; it degrades to the deterministic fallback (templateReason + whyReason) when the
// model is weak/offline/returns junk. CLOSED-WORLD INVARIANT: the chosen id MUST be one of the candidates —
// an id allow-list backstop rejects any invention, so retrieval still bounds what can be suggested. ──
const DECIDE_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'decide',
    strict: true,
    schema: {
      type: 'object', additionalProperties: false, required: ['task_id', 'reason', 'message'],
      properties: { task_id: { type: 'integer' }, reason: { type: 'string' }, message: { type: 'string' } },
    },
  },
};
const PRIO_LABEL = { 3: 'high', 2: 'medium', 1: 'low' };
const truncate = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
// "3d" / "5h" / "just now" — how long ago a task was noted, so the model can weigh staleness.
function agoLabel(ms) {
  const d = Math.floor(ms / 86400000);
  if (d >= 1) return `${d}d`;
  const h = Math.floor(ms / 3600000);
  return h >= 1 ? `${h}h` : 'just now';
}
// One rich candidate line — everything the model needs to actually reason: effort, category, priority, a
// live deadline, age, how often it's been passed on, learned affinity, and the user's OWN words when they
// carry detail beyond the summary.
function candidateLine(c, now) {
  const bits = [`#${c.id}: "${c.summary}"`, `${c.effort_level} effort`, c.category];
  if (c.priority && PRIO_LABEL[c.priority]) bits.push(`${PRIO_LABEL[c.priority]} priority`);
  if (c.due_at && !c.expired_at && c.due_at > now) bits.push(`due ${dueLabel(c.due_at, now)}`);
  const ago = agoLabel(now - c.created_at);
  bits.push(ago === 'just now' ? 'noted just now' : `noted ${ago} ago`);
  if (c.refusal_count) bits.push(`passed ${c.refusal_count}×`);
  if ((c._affinity || 0) >= 0.12) bits.push('usually done around now');
  let line = bits.join(' · ');
  const own = String(c.llm_summary || c.original_text || '').trim();
  if (own && own.toLowerCase() !== String(c.summary).toLowerCase()) line += `\n    their note: "${truncate(own, 200)}"`;
  return line;
}
async function decideTask(candidates, state, now) {
  if (!candidates.length) return null;
  const list = candidates.map((c) => candidateLine(c, now)).join('\n');
  const declined = state.lastTaskId != null ? `\nThey just declined #${state.lastTaskId} — do not pick that one.` : '';
  try {
    const raw = await chat({
      messages: [
        { role: 'system', content: DECIDE_TASK_SYSTEM },
        { role: 'user', content: `State: ${contextText(state)}.${declined}\nTasks:\n${list}` },
      ],
      responseFormat: DECIDE_SCHEMA, temperature: 0.3, maxTokens: 400, purpose: 'suggest-decide',
    });
    const obj = JSON.parse(String(raw).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim());
    if (candidates.some((c) => c.id === obj.task_id) && typeof obj.message === 'string' && obj.message.trim()) {
      return {
        taskId: obj.task_id,
        message: obj.message.trim(),
        reason: (typeof obj.reason === 'string' && obj.reason.trim()) ? obj.reason.trim() : null,
      };
    }
  } catch {
    /* fall through to the deterministic fallback (templateReason + whyReason) */
  }
  return null;
}

// ── "what should I do?" — now with anti-repetition, context-refusal penalties, and variety (§11) ──
const B_REFUSE = 0.08;                       // per prior refusal
const B_CONTEXT = 0.25;                       // context_refusal_affinity (when enough samples)
const B_REPEAT = 0.4;                         // recently surfaced → don't re-press it
const MIN_N = 2;                              // min samples before trusting the context refusal rate
const REPEAT_WINDOW_MS = 6 * 60 * 60 * 1000;  // "recently" = last 6h

// A deadline pulls a task up while it's still live, more sharply as it nears (advanced /task). Strong
// enough to reliably outrank undated work, but still one signal among many (never an absolute override).
const B_DUE = 0.6;
const DUE_HORIZON_MS = 3 * 86400000; // urgency ramps from 0 (≥3 days out) to full (due now)
export function dueBoost(task, now) {
  if (!task.due_at || task.expired_at || task.due_at <= now) return 0;
  const urgency = Math.max(0, Math.min(1, 1 - (task.due_at - now) / DUE_HORIZON_MS));
  return B_DUE * (0.5 + 0.5 * urgency);
}

// Creation-context fit: a day task is quieter at night, louder near its usual hour / same weather (§3).
const PHASE_PENALTY = 0.22;
const HOUR_BONUS = 0.10;
const WX_BONUS = 0.06;
export function phaseOf(tod) {
  if (tod === 'night' || tod === 'early_morning') return 'night';
  if (tod === 'evening') return 'evening';
  return 'day'; // morning, afternoon
}
const hourDist = (a, b) => { const d = Math.abs(a - b) % 24; return Math.min(d, 24 - d); };

// Learned per-(category × day-part) affinity from real outcomes. Positive when you tend to DO this kind
// of thing now (more so when it felt good), negative when you refuse/snooze/drop it. Shrinks toward 0
// while data is thin, so it's a gentle nudge early and a stronger signal once there's history.
const B_AFFINITY = 0.2;
const OUTCOME_WEIGHT = {
  done_highfive: 1.5, done_relief: 0.5, done_neutral: 1.0, 'done_': 1.0,
  refused: -0.8, snoozed: -0.4, dropped: -1.0,
  reaction_positive: 0.6, reaction_negative: -0.6, // 👍🔥💯 vs 🙁🤮💩 on a suggestion
};
export function affinityFromStats(rows, shrink = 4) {
  let num = 0; let n = 0;
  for (const r of rows) {
    const key = (r.outcome === 'done' || r.outcome === 'reaction') ? `${r.outcome}_${r.sentiment || ''}` : r.outcome;
    const w = OUTCOME_WEIGHT[key] ?? (r.outcome === 'done' ? 1.0 : 0);
    num += w * r.n; n += r.n;
  }
  return n ? Math.max(-1, Math.min(1, num / (n + shrink))) : 0;
}

// A short, HONEST reason for a suggestion — only when the data backs it (learned affinity, then the
// time/weather it was created in). Returns a phrase or null; never fabricated. Exported for tests.
export function whyReason(task, now, affinity = 0) {
  if (task.due_at && !task.expired_at && now.ms && task.due_at > now.ms) return `due ${dueLabel(task.due_at, now.ms)}`;
  if (affinity >= 0.12) return 'you usually get these done around now';
  if (task.created_tod && phaseOf(task.created_tod) === now.phase
      && task.created_hour != null && hourDist(task.created_hour, now.hour) <= 2) return 'right around when you noted it';
  if (task.created_weather && now.weather && task.created_weather === now.weather) return `a good ${now.weather}-day one`;
  return null;
}

// Pure + exported for tests. now = { phase, hour, weather }.
export function contextScore(task, now) {
  let s = 0;
  if (task.created_tod && phaseOf(task.created_tod) !== now.phase) s -= PHASE_PENALTY;
  if (task.created_hour != null) s += HOUR_BONUS * Math.max(0, 1 - hourDist(task.created_hour, now.hour) / 6);
  if (task.created_weather && now.weather && task.created_weather === now.weather) s += WX_BONUS;
  return s;
}

export async function suggestTask({ userId, state = {}, exclude = [], filter = null }) {
  sweepSnoozed(userId);   // expired snoozes rejoin the pool before we retrieve (§11.2)
  expireDueTasks(userId); // …and anything past its deadline drops out of the pool (advanced /task)
  const excludeSet = new Set(exclude);
  const tasks = listAvailableTasksWithVectors(userId).filter((t) => !excludeSet.has(t.id));
  // "what's next today" — narrow the closed candidate set to tasks due by end of today, then rank as usual.
  const scoped = filter?.today ? tasks.filter((t) => isDueToday(t)) : tasks;
  if (!scoped.length) {
    return {
      recommendation: null, eventId: null, candidates: [],
      message: filter?.today
        ? "Nothing's due today — enjoy the breathing room. 🌱"
        : "Nothing on your plate right now — tell me something and I'll help you pick.",
    };
  }
  let ctx = null;
  try { ctx = await embed(contextText(state)); } catch { /* no embedding — rank without it */ }

  const now = Date.now();
  const hour = new Date(now).getHours();
  const nowCtx = { phase: phaseOf(timeOfDay(now)), hour, weather: currentWeather()?.weather || null, ms: now };
  const scored = scoped
    .map((t) => {
      const sim = ctx && t.vec ? cosine(ctx, t.vec) : 0;
      const ef = effortFit(t.effort_level, state.energy);
      const rc = recency(t.created_at);
      // This deterministic score now PREFILTERS a shortlist (the LLM decides over it below) rather than
      // deciding itself. So the once-dominant embedding term — which compared each task to a noisy
      // "time/mood/energy" string and made picks feel random — is demoted to a faint tiebreaker; effort-fit
      // and recency carry the shortlist, with deadline/affinity/refusal/anti-repeat layered on as before.
      let score = 0.45 * ef + 0.25 * rc + 0.1 * sim;
      score -= B_REFUSE * (t.refusal_count || 0);
      const rr = refusalRateHere(userId, t.id, { hour, energy: state.energy });
      if (rr.n >= MIN_N) score -= B_CONTEXT * rr.rate;
      if (t.last_suggested_at && now - t.last_suggested_at < REPEAT_WINDOW_MS) score -= B_REPEAT;
      score += contextScore(t, nowCtx); // day/night + hour + weather fit
      score += dueBoost(t, now);        // a live deadline lifts it, sharply as it nears
      const aff = affinityFromStats(outcomeStats(userId, t.category, nowCtx.phase)); // learned
      score += B_AFFINITY * aff;
      return { ...t, score, _affinity: aff };
    })
    .sort((a, b) => b.score - a.score);

  // Prefilter → shortlist. The LLM decides over up to 10 candidates (was 5) so it has real room to choose;
  // retrieval still bounds the closed world — it can only pick from these, never invent one.
  const top = scored.slice(0, 10);
  // Variety: never re-offer the immediately-previous pick when there's an alternative.
  let baseIdx = 0;
  if (state.lastTaskId != null && top[0]?.id === state.lastTaskId && top.length > 1) baseIdx = 1;
  const decision = await decideTask(top, state, now);
  const decided = decision && top.find((t) => t.id === decision.taskId && t.id !== state.lastTaskId);
  const chosen = decided || top[baseIdx];
  const message = decided ? decision.message : templateReason(chosen, state);
  // Prefer the model's own honest reason; otherwise the deterministic, data-backed phrase.
  const why = (decided && decision.reason) || whyReason(chosen, nowCtx, chosen._affinity || 0);

  // Ledger: stamp last_suggested_at + write the (unresolved) suggestion event (§11).
  const eventId = recordSuggestion(userId, {
    taskId: chosen.id, channel: state.channel || 'web', source: state.source || 'chat',
    ctx: { hour, dow: new Date(now).getDay(), energy: state.energy || null, mood: state.mood || null },
  });

  // AI activity log: the recommendation "thinking" — whether embeddings fired, whether the LLM actually
  // chose (decided) or we fell back to the deterministic shortlist top, and the full candidate scoreboard
  // (so clustered/near-identical prefilter scores still show plainly).
  recordAiEvent('suggest', {
    energy: state.energy || null,
    mood: state.mood || null,
    embeddingsFired: !!ctx,
    llmDecided: !!decided,
    chosen: { id: chosen.id, summary: chosen.summary, score: Number(chosen.score.toFixed(3)) },
    why: why || null,
    candidates: top.map((t) => ({
      id: t.id, summary: t.summary, score: Number(t.score.toFixed(3)), affinity: Number((t._affinity || 0).toFixed(3)),
    })),
  });

  return {
    recommendation: { taskId: chosen.id, summary: chosen.summary, category: chosen.category, effort_level: chosen.effort_level, message, why },
    eventId,
    candidates: top.filter((t) => t.id !== chosen.id).map((t) => ({ id: t.id, summary: t.summary, score: Number(t.score.toFixed(3)) })),
  };
}

// ── Grooming reshapers (§11.3) — closed-world: they only reword/break down the ONE given task.
//    The prompt text (incl. the shared COACH_VOICE preamble) lives in services/llm/prompts.js. ──
export async function llmRefine(task) {
  try {
    const raw = await chat({ messages: [{ role: 'system', content: REFINE_SYSTEM }, { role: 'user', content: task.summary }], temperature: 0.4, maxTokens: 60, purpose: 'refine' });
    const out = String(raw || '').replace(/^["'\s]+|["'\s]+$/g, '').trim();
    if (!out || out.length > 200 || /^[[{]/.test(out)) return null; // reject empty/huge/JSON (e.g. mock)
    return out;
  } catch { return null; }
}

const STEPS_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'steps', strict: true,
    schema: { type: 'object', additionalProperties: false, required: ['steps'], properties: { steps: { type: 'array', items: { type: 'string' } } } },
  },
};

// Break ONE task into a short step list. Two modes:
//   • default (grooming "break it down") — CONSERVATIVE: rephrase the user's own task into first steps, invent
//     nothing. This honors Fanad's "stays grounded in your own data" thesis.
//   • synthesize:true (the "/guess" command) — the ONE sanctioned exception: the model MAY draw on general
//     know-how to fill in concrete specifics it was never told. It's surfaced to the user as an explicit
//     guess (see chat.js guessSteps), disposable and fully editable, so the fabrication is honest, not silent.
// One decompose attempt. Returns { steps } (a clean array ≥2, else steps:null for unparseable/looped/too-few
// output) or { error } when the PROVIDER itself failed (HTTP/network — the error carries .status). Separating
// the two lets the caller surface "the model is out of credits / unreachable" instead of a blank "no guess".
async function decomposeOnce(task, { instruction, temperature, maxTokens, max }) {
  let raw;
  try {
    raw = await chat({ messages: [{ role: 'system', content: decomposeSystem(instruction) }, { role: 'user', content: task.summary }], responseFormat: STEPS_SCHEMA, temperature, maxTokens, purpose: 'decompose' });
  } catch (error) { return { error }; } // provider/network failure (429 quota, 401 bad key, 5xx, timeout…)
  try {
    const o = JSON.parse(String(raw).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim());
    const steps = Array.isArray(o?.steps) ? o.steps.map((s) => String(s).trim()).filter(Boolean).slice(0, max) : [];
    return { steps: steps.length >= 2 ? steps : null };
  } catch { return { steps: null }; } // empty / non-JSON / a local model that looped → no usable steps
}

// Break ONE task into steps. Returns a step array, or null when the model produced nothing usable. THROWS the
// provider error when the model itself was unavailable (quota/key/network), so /guess can say WHY rather than
// hide a billing problem behind "couldn't guess". The grooming path (synthesize:false) still gets null on any
// failure — it has its own graceful fallback and shouldn't surface raw provider errors.
export async function llmDecompose(task, { synthesize = false } = {}) {
  if (!synthesize) return (await decomposeOnce(task, { instruction: DECOMPOSE_CONSERVATIVE, temperature: 0.4, maxTokens: 200, max: 4 })).steps ?? null;
  // /guess: the synthesizing prompt first (richer, invents specifics).
  const a = await decomposeOnce(task, { instruction: DECOMPOSE_SYNTH, temperature: 0.6, maxTokens: 512, max: 6 });
  if (a.steps) return a.steps;
  if (a.error?.status) throw a.error; // a hard provider error won't fix itself on a retry → surface it now
  // No provider error, just unusable output (e.g. a local model looped). A calmer rephrase of the user's OWN
  // words often converges where the "invent specifics" prompt derailed — so /guess still yields a checklist.
  const b = await decomposeOnce(task, { instruction: DECOMPOSE_CONSERVATIVE, temperature: 0.4, maxTokens: 200, max: 4 });
  if (b.steps) return b.steps;
  if (b.error?.status) throw b.error;
  return null;
}

