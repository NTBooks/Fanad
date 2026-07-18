// In-process scheduler: weather refresh + the optional "wake-up" check-ins.
// A one-minute tick (local time, so it's DST-correct by construction) fires any due schedule once a day,
// queues a gentle, data-grounded nudge for the web, and pushes it to Telegram if the bot is running.
import { defaultUserId, allDueSchedules, markScheduleFired, insertWakeupMirroredToOwner, expireDueTasks, getImageForTask, allDueReminders, markRemindedAndQueue, sleepStaleTasks, allDueTimers, markTimerFiredAndQueue, reclaimStaleDemoSeats } from './repo.js';
import { durationLabel } from './services/llm/duration.js';
import { suggestTask } from './rag/index.js';
import { runAsLlmUser } from './services/llm/context.js';
import { runJournalSweep } from './journal.js';
import { refreshWeather } from './weather.js';
import { notifyOwner } from './notifyOwner.js';
import { config } from './config.js';
import { sendTelegram } from './channels/telegram.js';
import { sendSlack } from './channels/slack.js';
import { annunciate } from './services/homeassistant.js';
import { isFeatureOnFor } from './chat.js';

const DAY = 86400000;
const localDay = (ts = Date.now()) => Math.floor((ts - new Date(ts).getTimezoneOffset() * 60000) / DAY);

// Deliver a nudge to whichever channel the owner is on: a Telegram account → its 1:1 chat (with the photo
// file_id, if any); a Slack account → its DM (no photo — Slack has no re-send-by-reference). A web/root owner
// has neither id and is reached via the web wake-up queue ONLY (never pushed to the bot's claimed owner — see
// the cross-user isolation invariant in repo.js). The one sanctioned exception lives on the INSERT side, not
// here: the deployment OWNER's platform account also mirrors its nudge into root's web queue
// (insertWakeupMirroredToOwner) so the web UI sees the owner's dings. Vouched non-owners never mirror.
// Senders are injectable so a test can observe delivery.
function pushToOwner(row, text, photo, { sendTg, sendSl }) {
  // A false result (bot not running) or a rejection means a bot-only user gets this nudge in the web queue
  // ONLY — which they may never open. There's no retry (reminded_at/fired are already stamped), so at
  // minimum the miss must be visible in the log.
  const report = (channel) => (ok) => { if (ok === false) console.error(`${channel} push skipped (bot not running or send failed) — nudge is in the web queue only`); };
  if (row.telegram_id != null) Promise.resolve(sendTg(text, row.telegram_id, photo)).then(report('telegram'), (err) => console.error('telegram push failed:', err.message));
  else if (row.slack_id != null) Promise.resolve(sendSl(text, row.slack_id)).then(report('slack'), (err) => console.error('slack push failed:', err.message));
}

// Ring the house (the Home Assistant module) for one fired timer/reminder — strictly AFTER the mark +
// queue + pushToOwner chain, and strictly fire-and-forget: HA being down/slow can never delay or break
// Telegram/Slack/web delivery. Double-caught (the gate itself and the async call); annunciate() logs once
// per distinct failure internally. annunciateFn is injectable so tests can observe/poison it.
function ringHouse(userId, kind, title, annunciateFn = annunciate) {
  try {
    if (!isFeatureOnFor(userId, 'homeassistant')) return;
    Promise.resolve(annunciateFn(kind, title)).catch((err) => console.error('HA annunciate failed:', err.message));
  } catch (err) { console.error('HA gate failed:', err.message); }
}

// Build + deliver the nudges for every schedule due at `now`. Exported for tests; `send` is the Telegram
// push, injectable so a test can observe WHO each nudge is delivered to (the cross-user isolation guarantee).
export async function fireDueWakeups(now = Date.now(), { send = sendTelegram, sendSlackFn = sendSlack } = {}) {
  const d = new Date(now);
  const minute = d.getHours() * 60 + d.getMinutes();
  const day = localDay(now);
  const fired = [];
  for (const s of allDueSchedules(minute, day)) {
    // Each schedule is isolated: allDueSchedules matches this exact minute, so a throw that aborted the
    // loop wouldn't just skip the rest this tick — it would silently lose their whole day.
    try {
      const userId = s.user_id; // the schedule's OWNER (root for web; a per-account id for Telegram)
      markScheduleFired(userId, s.id, day); // mark first so a slow suggestion can't double-fire
      let text;
      let photo = null;
      try {
        // Run as the schedule's owner so the suggestion's LLM call charges THEIR daily budget (llm/context.js).
        const out = await runAsLlmUser(userId, () => suggestTask({ userId, state: { source: 'wakeup' } }));
        if (out.recommendation) {
          text = `💡 A gentle nudge: how about “${out.recommendation.summary}”? (reply /whatdo when you're ready)`;
          // Recall the photo filed with that task (if any) so the nudge carries its file_id. Best-effort: a
          // missing image must never block the text nudge.
          try { const img = getImageForTask(userId, out.recommendation.taskId); if (img) photo = img.file_id; } catch { /* fall back to text */ }
        } else {
          text = '💭 Checking in — nothing on your plate right now. Add something whenever you like.';
        }
      } catch (err) {
        console.error('wakeup suggestion failed (sending the plain check-in):', err.message);
        text = '💭 Checking in. I had trouble reading your tasks just now — try /whatdo when you have a sec.';
      }
      insertWakeupMirroredToOwner(userId, text);
      // Push to the owner's OWN channel (Telegram 1:1 chat or Slack DM). A web/root schedule has neither id, so
      // it's delivered via the web wake-up queue ONLY — never fall back to the bot's claimed owner, or one
      // user's private nudge would land in another user's chat. See repo.js isolation invariant; its one
      // exception is the mirror above (the deployment OWNER's nudge also lands in root's web queue).
      pushToOwner(s, text, photo, { sendTg: send, sendSl: sendSlackFn });
      fired.push(text);
    } catch (err) {
      console.error(`wakeup schedule ${s.id} failed (continuing with the rest):`, err.message);
    }
  }
  return fired;
}

// Fire the one-time per-task reminders ("on <when>") whose moment has arrived. Runs BEFORE the expire
// sweep so a reminder whose time equals its deadline still goes out. Each fires exactly once (reminded_at
// is stamped first). Same cross-user delivery rule as fireDueWakeups: a web/root task (no telegram_id)
// is delivered via the web wake-up queue ONLY, never pushed to the bot's claimed owner — and the OWNER's
// own platform reminder mirrors into root's web queue (inside markRemindedAndQueue).
export async function fireDueReminders(now = Date.now(), { send = sendTelegram, sendSlackFn = sendSlack, annunciateFn = annunciate } = {}) {
  const fired = [];
  for (const t of allDueReminders(now)) {
    try {
      const text = `🔔 Reminder: “${t.summary}” — it's time.`;
      let photo = null;
      try { const img = getImageForTask(t.user_id, t.id); if (img) photo = img.file_id; } catch { /* text only */ }
      // Stamp + queue in one transaction, before the (async, fallible) bot push: fired ⇒ at least in the
      // web queue, and a crash mid-send still can't double-fire.
      markRemindedAndQueue(t.id, t.user_id, text, now);
      pushToOwner(t, text, photo, { sendTg: send, sendSl: sendSlackFn });
      ringHouse(t.user_id, 'reminder', t.summary, annunciateFn);
      fired.push(text);
    } catch (err) {
      console.error(`reminder for task ${t.id} failed (continuing with the rest):`, err.message);
    }
  }
  return fired;
}

// Ring the one-shot TIMERS (the opt-in Timer module) whose moment has arrived. Same shape and delivery
// rule as fireDueReminders: fired_at is stamped FIRST (a crash mid-send can't double-ring), each row is
// isolated, a web/root timer (no channel ids) lands in the web wake-up queue ONLY, and the OWNER's own
// platform timer mirrors into root's web queue (inside markTimerFiredAndQueue). The minute tick
// means a ding can be up to ~59s late — chat.js floors timers at one minute for the same reason.
export async function fireDueTimers(now = Date.now(), { send = sendTelegram, sendSlackFn = sendSlack, annunciateFn = annunciate } = {}) {
  const fired = [];
  for (const tm of allDueTimers(now)) {
    try {
      const text = `⏰ Ding — ${durationLabel(tm.duration_ms)} is up${tm.label ? `: ${tm.label}` : ''}.`;
      markTimerFiredAndQueue(tm.id, tm.user_id, text, now); // atomic, same invariant as reminders
      pushToOwner(tm, text, null, { sendTg: send, sendSl: sendSlackFn });
      ringHouse(tm.user_id, 'timer', tm.label || durationLabel(tm.duration_ms), annunciateFn);
      fired.push(text);
    } catch (err) {
      console.error(`timer ${tm.id} failed (continuing with the rest):`, err.message);
    }
  }
  return fired;
}

let timer = null;
export function startScheduler() {
  refreshWeather().catch(() => {});
  let ticks = 0;
  timer = setInterval(() => {
    ticks += 1;
    if (ticks % 15 === 0) refreshWeather().catch(() => {}); // ~every 15 min
    fireDueReminders().catch((err) => console.error('reminder tick:', err.message)); // before the expire sweep
    fireDueTimers().catch((err) => console.error('timer tick:', err.message));
    try { expireDueTasks(defaultUserId()); } catch { /* backstop; also swept on every access */ }
    // Once a day, sleep long-untouched tasks so the list stays scannable (before nudges → slept tasks aren't suggested).
    // This is the feature's ONLY call site — if it starts throwing, auto-sleep is dead until someone notices: log it.
    if (ticks % (24 * 60) === 0) { try { sleepStaleTasks(defaultUserId()); } catch (err) { console.error('auto-sleep sweep failed:', err.message); } }
    // ~Every 10 min, reclaim no-show /demo seats: a self-signup that never sent a first message within the
    // window is holding a seat against MAX_VOUCHED_USERS for nothing. A 2h window doesn't need minute
    // precision, and it self-gates to a no-op unless the demo cohort exists. Only demo signups are touched.
    if (ticks % 10 === 0 && config.limits.demoSeatReclaimHours > 0) {
      try {
        const reclaimed = reclaimStaleDemoSeats({ olderThanMs: config.limits.demoSeatReclaimHours * 3600000 });
        if (reclaimed.length) {
          console.log(`reclaimed ${reclaimed.length} no-show demo seat(s): ${reclaimed.map((h) => `@${h}`).join(', ')}`);
          notifyOwner(`♻️ Freed ${reclaimed.length} no-show demo seat${reclaimed.length === 1 ? '' : 's'} (no first message in ${config.limits.demoSeatReclaimHours}h): ${reclaimed.map((h) => `@${h}`).join(', ')}.`);
        }
      } catch (err) { console.error('demo seat reclaim sweep failed:', err.message); }
    }
    // Journal nightly sweep: backfill AI day-summaries for closed days. Self-gated (once per local day,
    // after 01:00, re-entrancy flag) so calling it every tick is cheap; fire-and-forget so a slow local
    // LLM can't wedge the minute tick.
    runJournalSweep().catch((err) => console.error('journal sweep:', err.message));
    fireDueWakeups().catch((err) => console.error('wakeup tick:', err.message));
  }, 60 * 1000);
  timer.unref?.();
  return timer;
}
