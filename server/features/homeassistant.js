// The Home Assistant module (opt-in, ships dark): the house as an output surface. Three jobs live here —
// the `ha <command>` Assist passthrough (free text → HA's conversation agent, its answer comes back),
// `ha` / `ha test` status + output checks, and the manual "push this dated task onto the HOUSE calendar"
// (`ha cal N` + the m:hacal button beside /cal N's .ics export). The fire-path side (timers/reminders
// ringing the satellites/script/notify outputs) lives in scheduler.js → services/homeassistant.js;
// the owner-only connection settings (URL + encrypted token + output targets) live in settings.js and
// are edited in web Settings — secrets never travel through chat.
import { getTask, isOwner, hasSpeedDial } from '../repo.js';
import { padView } from '../speeddial.js';
import { resolveListing, clearDialogState } from '../dialog.js';
import { taskEventTime } from '../calendar.js';
import { getHomeAssistantConfig } from '../settings.js';
import { checkConnection, converse, testOutputs, pushTaskToCalendar, haProblem } from '../services/homeassistant.js';
import { sanitizeForLlm } from '../services/llm/sanitize.js';
import { registerFeature } from './registry.js';

const configured = (cfg) => !!(cfg.baseUrl && cfg.token);

// The "not set up yet" reply — what it says depends on who's asking (only the owner can fix it).
const notConfigured = (userId) => (isOwner(userId)
  ? 'Home Assistant isn’t connected yet — set the URL and a long-lived access token in Settings → Home Assistant (create the token in HA under your profile → Security).'
  : 'Home Assistant isn’t connected yet — ask the owner to set it up in Settings.');

async function statusReply(userId) {
  const cfg = getHomeAssistantConfig();
  if (!configured(cfg)) return notConfigured(userId);
  const lines = ['🏠 Home Assistant'];
  try {
    const c = await checkConnection(cfg);
    lines.push(`✓ Connected — HA ${c.version}${c.locationName ? ` · ${c.locationName}` : ''}`);
  } catch (err) {
    lines.push(`✗ Unreachable: ${err.message}`);
  }
  if (isOwner(userId)) {
    const outs = [];
    if (cfg.announce.enabled && cfg.announce.entities.length) outs.push(`announce (${cfg.announce.entities.length})`);
    if (cfg.script.enabled && cfg.script.entity) outs.push(`script ${cfg.script.entity.replace(/^script\./, '')}`);
    if (cfg.notify.enabled && cfg.notify.services.length) outs.push(`notify (${cfg.notify.services.join(', ')})`);
    lines.push(outs.length ? `Ring outputs: ${outs.join(' · ')}` : 'Ring outputs: none enabled — timers/reminders won’t ring the house yet.');
    lines.push(cfg.calendar.entity ? `Calendar: ${cfg.calendar.entity}` : 'Calendar: not set (no “to HA calendar” pushes).');
    if (!cfg.enabled) lines.push('⚠ The connection is saved but DISABLED in Settings — nothing rings until it’s enabled.');
  }
  const prob = haProblem();
  if (prob) lines.push(`⚠ Last ring failed: ${prob}`);
  lines.push('(“ha test” rings the outputs · “ha <command>” talks to HA)');
  return lines.join('\n');
}

async function testReply(userId) {
  const cfg = getHomeAssistantConfig();
  if (!configured(cfg)) return notConfigured(userId);
  if (!cfg.enabled) return 'Home Assistant is disabled in Settings — enable it there first, then “ha test”.';
  const r = await testOutputs();
  if (r.skipped || (!r.ok && !r.failed.length)) {
    return 'No outputs are enabled — pick an announce satellite, a script, or a notify service in Settings → Home Assistant first.';
  }
  if (r.ok) return '🏠 ✓ Rang the house — every enabled output fired.';
  return `🏠 Some outputs failed:\n${r.failed.map((f) => `✗ ${f.output}: ${f.error}`).join('\n')}`;
}

async function calReply(userId, n) {
  const cfg = getHomeAssistantConfig();
  if (!configured(cfg)) return notConfigured(userId);
  if (!cfg.calendar.entity) {
    return isOwner(userId)
      ? 'No HA calendar set — add the Local Calendar integration in HA, then pick its entity in Settings → Home Assistant.'
      : 'No HA calendar is set up — ask the owner to pick one in Settings.';
  }
  const { pairs, total } = resolveListing(userId, 'task', [n]);
  if (!pairs.length) return total ? `There’s no task ${n} on the current list.` : 'Nothing’s listed — run /tasks first, then “ha cal N”.';
  const task = getTask(userId, pairs[0].id);
  if (!task) return 'That task’s gone now.';
  return pushCal(userId, task, cfg);
}

async function pushCal(userId, task, cfg = getHomeAssistantConfig()) {
  if (!taskEventTime(task)) return `“${task.summary}” doesn’t have a date to add — set one with “… by friday” or “… on friday 3pm”.`;
  try {
    await pushTaskToCalendar(task, cfg);
    return { text: `🏠 Sent “${task.summary}” to the HA calendar.`, buttons: null, toast: 'On the house calendar ✓' };
  } catch (err) {
    const hint = err.status === 400 || err.status === 404
      ? ' (Is the Local Calendar integration installed in HA, and the entity id right? Settings → Home Assistant.)' : '';
    return `Couldn’t reach the HA calendar: ${err.message}${hint}`;
  }
}

async function passthrough(userId, text) {
  const cfg = getHomeAssistantConfig();
  if (!configured(cfg)) return notConfigured(userId);
  try {
    const said = await converse(sanitizeForLlm(text), cfg);
    return `🏠 ${said}`;
  } catch (err) {
    return `Couldn’t reach Home Assistant: ${err.message}`;
  }
}

registerFeature({
  name: 'homeassistant',
  commands: [{
    // "/ha …" is explicit and offers to turn the module on when off; bare "ha …" only engages when ON
    // (so "ha ha very funny" still files as a task for anyone who hasn't opted in). Reserved words match
    // first — bare "ha"/"ha status" → status, "ha test" → ring the outputs, "ha cal N" → calendar push —
    // and EVERYTHING else after "ha " is the Assist passthrough, piped verbatim to HA's conversation
    // agent ("ha turn off the kitchen light" → HA does it and its answer comes back).
    match: ({ lower, isOn }) => {
      const slash = /^\/ha(?:cal)?(?:[\s_]|$)/i.test(lower);
      const bare = /^ha(?:\s|$)/i.test(lower);
      return slash || (bare && isOn('homeassistant'));
    },
    run: ({ userId, identityId = userId, t, isOn, offerOn }) => {
      // A speed-dial pad-holder never gets raw `ha` — the curated 0-9 pad is the whole house access the owner
      // granted them. Redirect to their pad instead of the Assist passthrough (and never offer the opt-in).
      if (hasSpeedDial(identityId) && !isOwner(identityId)) {
        const pad = padView(identityId);
        return { text: 'You control the house with your speed dial — send a number, or tap below.', buttons: pad.buttons };
      }
      if (!isOn('homeassistant')) return offerOn('homeassistant'); // only reachable via the slash form
      clearDialogState(userId);
      let m;
      if ((m = /^\/?ha[\s_]*cal[\s_]*#?(\d+)\s*$/i.exec(t))) return calReply(userId, Number(m[1]));
      const rest = t.replace(/^\/?ha\b[\s:—-]*/i, '').trim();
      if (!rest || /^status$/i.test(rest)) return statusReply(userId);
      if (/^test$/i.test(rest)) return testReply(userId);
      if (/^cal\b\s*$/i.test(rest)) return 'Which one? Run /tasks, then “ha cal N” on a task that has a date.';
      return passthrough(userId, rest);
    },
  }],
  menuActions: {
    // "🏠 To HA calendar" beside /cal N's .ics export — the value is the TASK id (survives list
    // re-render), ownership-scoped via getTask. A stale/undated tap gets a gentle answer, not an error.
    hacal: (userId, d) => {
      const id = Number(d.value);
      const task = Number.isInteger(id) && id > 0 ? getTask(userId, id) : null;
      if (!task) return { text: 'That task’s gone now.', buttons: null, toast: 'Already gone' };
      return pushCal(userId, task);
    },
  },
});
