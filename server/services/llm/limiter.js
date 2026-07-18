// Global LLM concurrency gate (config.limits.llmMaxConcurrency, env LLM_MAX_CONCURRENCY). A public demo
// puts many users behind ONE provider (a paid cloud key or a single local model) — without a cap, a burst
// (N wakeups firing the same minute, a journal backfill) fans out as N simultaneous provider calls. Excess
// calls FIFO-queue; a queue past config.limits.llmQueueMax throws LLM_BUSY, which surfaces as a friendly
// "busy, try again" instead of a stack of slow timeouts. Cap 0/absent = unlimited (private-box default).
// In-process state only — fine for the single-process deployment this app is.
import { config } from '../../config.js';

let inFlight = 0;
const waiting = [];

export function acquire() {
  const max = config.limits.llmMaxConcurrency;
  if (!max) return Promise.resolve();
  if (inFlight < max) { inFlight += 1; return Promise.resolve(); }
  if (waiting.length >= config.limits.llmQueueMax) {
    const err = new Error('LLM is at capacity (too many calls in flight + queued).');
    err.code = 'LLM_BUSY';
    throw err;
  }
  return new Promise((resolve) => { waiting.push(resolve); });
}

// Hand the freed slot to the oldest waiter (inFlight unchanged), else shrink. Call in `finally` — but ONLY
// after a successful acquire(); an LLM_BUSY throw never held a slot.
export function release() {
  if (!config.limits.llmMaxConcurrency) return;
  const next = waiting.shift();
  if (next) next();
  else inFlight = Math.max(0, inFlight - 1);
}

// Test visibility.
export function limiterStats() {
  return { inFlight, queued: waiting.length };
}
