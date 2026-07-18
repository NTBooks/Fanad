// The Timer module (opt-in): a one-shot "ding me in N minutes" — NOT a task, nothing lands on any list;
// the scheduler rings once (fireDueTimers) and the row retires. Everything the module owns lives here:
// the command shapes, the listing/cancel replies, and the "✕ Cancel timer" button (m:tmr). The ring
// itself stays in scheduler.js (it's a cross-feature delivery concern), and duration parsing stays in
// services/llm/duration.js (heuristic + LLM fallback, shared shape with deadline.js).
import { insertTimer, getTimer, activeTimers, cancelTimer } from '../repo.js';
import { recordUndo } from '../undo.js';
import { extractDuration, durationLabel } from '../services/llm/duration.js';
import { whenLabel } from '../services/llm/deadline.js';
import { clearDialogState } from '../dialog.js';
import { registerFeature } from './registry.js';

const TIMER_MIN_MS = 60000;               // the scheduler ticks once a minute — shorter can't ring on time
const TIMER_MAX_MS = 7 * 86400000;        // past a week it's a dated task/reminder, not a countdown

const timerTag = (row) => (row.label ? ` — ${row.label}` : '');

function timerListReply(userId) {
  const rows = activeTimers(userId);
  if (!rows.length) return 'No timers running. Set one with “timer 10 minutes” (add a label if you like: “timer 12 min pasta”).';
  const now = Date.now();
  const lines = rows.map((r, i) => `${i + 1}. ⏰ ${durationLabel(Math.max(0, r.fire_at - now))} left${timerTag(r)} · rings ${whenLabel(r.fire_at)}`);
  return {
    text: `⏰ Running timers:\n${lines.join('\n')}\n(“timer off 1” cancels one)`,
    buttons: rows.map((r, i) => [{ text: `✕ Cancel ${i + 1}${timerTag(r)}`, data: `m:tmr:${r.id}` }]),
  };
}

async function timerCommand(userId, rest) {
  const r = (rest || '').trim().replace(/^[,:;–—-]\s*/, '');
  if (!r || /^(list|show|status)$/i.test(r)) return timerListReply(userId);
  let mm;
  if ((mm = /^(?:off|cancel|stop|clear|delete|remove)\s*#?(\d*)$/i.exec(r))) {
    const rows = activeTimers(userId);
    if (!rows.length) return 'No timers running.';
    // A bare "timer off" with exactly one running cancels it; with several, show the list to pick from.
    const n = mm[1] ? Number(mm[1]) : (rows.length === 1 ? 1 : null);
    if (n == null) return timerListReply(userId);
    const row = rows[n - 1];
    if (!row) return `There’s no timer ${n} — “timer” shows what’s running.`;
    cancelTimer(userId, row.id);
    return `✕ Canceled the ${durationLabel(row.duration_ms)} timer${timerTag(row)}.`;
  }
  const parsed = await extractDuration(r);
  if (!parsed) return 'How long? Try “timer 10 minutes” or “timer 1h 30m” — add a label if you like: “timer 12 min pasta”.';
  if (parsed.ms < TIMER_MIN_MS) return '⏱ I check the clock once a minute, so one minute is my shortest timer — “timer 1 minute”?';
  if (parsed.ms > TIMER_MAX_MS) return 'That’s a long one — past a week, give a task a date instead (“…on friday 3pm”) and I’ll nudge you then. See “guide reminders”.';
  const label = parsed.clean || null;
  const timer = insertTimer(userId, { label, durationMs: parsed.ms, fireAt: Date.now() + parsed.ms });
  recordUndo(userId, 'timer_set', { timerId: timer.id }, `↩ Canceled the ${durationLabel(parsed.ms)} timer${timerTag(timer)}.`);
  return {
    text: `⏰ Timer set — ${durationLabel(parsed.ms)}${timerTag(timer)} · rings ${whenLabel(timer.fire_at)}. (“timer” shows it · “timer off” cancels)`,
    buttons: [[{ text: '✕ Cancel timer', data: `m:tmr:${timer.id}` }]],
  };
}

registerFeature({
  name: 'timer',
  commands: [{
    // "/timer 10 minutes" · bare "timer" lists · "timer off 1" cancels. The slash form is explicit and
    // offers to turn the module on when it's off (mirroring /notebook); the bare forms — "timer …",
    // "set a timer for …" — only engage when the module is ON, so a task like "buy a timer for the oven
    // light" still files normally for anyone who hasn't opted in. When OFF, the capture path's module
    // nudge (detectModuleHint) offers the one-tap turn-on instead.
    match: ({ lower, isOn }) => {
      const slash = /^\/timers?(?:\s|$)/i.test(lower);
      const bare = /^(?:timers?|(?:set|start)\s+(?:a\s+|the\s+)?timers?)(?:\s|$)/i.test(lower);
      return slash || (bare && isOn('timer'));
    },
    run: ({ userId, t, isOn, offerOn }) => {
      if (!isOn('timer')) return offerOn('timer'); // only reachable via the explicit slash form
      clearDialogState(userId);
      return timerCommand(userId, t.replace(/^\/?(?:(?:set|start)\s+(?:a\s+|the\s+)?)?timers?\b/i, ''));
    },
  }],
  menuActions: {
    // "✕ Cancel timer" — the value is the TIMER row id (not a task id). Ownership-checked via getTimer's
    // user_id scope; a stale tap (already rang / already canceled / someone else's id) gets a gentle "gone".
    tmr: (userId, d) => {
      const id = Number(d.value);
      const row = Number.isInteger(id) && id > 0 ? getTimer(userId, id) : null;
      if (!row || row.fired_at || row.canceled_at) return { text: 'That timer’s already gone.', buttons: null, toast: 'Already gone' };
      cancelTimer(userId, row.id);
      return { text: `✕ Canceled the ${durationLabel(row.duration_ms)} timer${row.label ? ` — ${row.label}` : ''}.`, buttons: null, toast: 'Timer canceled ✕' };
    },
  },
});
