// The Home Assistant module: the house as an output surface. Covers the pure payload builders (announce /
// script / notify / calendar.create_event shapes), the encrypted-at-rest token (same recipe as Telegram),
// the ships-dark default, the scheduler's ring-the-house hook (fire-and-forget — a dead HA can NEVER block
// or break timer/reminder delivery), the m:hacal button token, and the ha command surface — all offline
// (any real HTTP in these tests points at an unroutable local port and is expected to fail fast).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-ha-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate, db } = await import('../server/db.js');
migrate();
const settings = await import('../server/settings.js');
const { handleMessage, handleAction } = await import('../server/chat.js');
const { clearDialogState } = await import('../server/dialog.js');
const { decodeToken } = await import('../server/menu.js');
const { defaultUserId, getOrCreateTelegramUser, insertTimer } = await import('../server/repo.js');
const { fireDueTimers, fireDueReminders } = await import('../server/scheduler.js');
const ha = await import('../server/services/homeassistant.js');

const uid = defaultUserId();
const say = async (text) => { clearDialogState(uid); return handleMessage({ text }); };
const reply = async (text) => (await say(text)).reply;
const rawSetting = (key) => db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value || '';
const clearTimers = () => db.prepare('DELETE FROM timers').run();

// ── ships dark (asserted FIRST, on the untouched fresh DB) ──

test('homeassistant ships dark: default OFF system-wide, other modules default ON', () => {
  const sys = settings.getSystemModules();
  assert.equal(sys.homeassistant, false, 'a fresh deploy has the module dark until the owner releases it');
  assert.equal(sys.timer, true, 'existing modules still default on');
  assert.equal(settings.isSystemModuleOn('homeassistant'), false);
});

// ── the settings blob: encrypted token, normalization ──

test('the HA token is encrypted at rest and decrypted on read; base URL and notify services normalize', () => {
  settings.setHomeAssistantConfig({
    baseUrl: ' http://127.0.0.1:8123/ ',
    token: 'll-token-xyz',
    notify: { enabled: true, services: ['notify.mobile_app_a', ' mobile_app_b '] },
  });
  const raw = rawSetting('homeassistant');
  assert.ok(!raw.includes('ll-token-xyz'), 'plaintext token must not be in the DB');
  assert.match(raw, /enc:(v1|t1):/, 'DB value holds ciphertext');
  const cfg = settings.getHomeAssistantConfig();
  assert.equal(cfg.token, 'll-token-xyz', 'decrypted for use');
  assert.equal(cfg.baseUrl, 'http://127.0.0.1:8123', 'trimmed, trailing slash stripped');
  assert.deepEqual(cfg.notify.services, ['mobile_app_a', 'mobile_app_b'], 'notify. prefix normalized off');
});

test('re-saving other fields keeps the stored token (blank/absent token = keep)', () => {
  settings.setHomeAssistantConfig({ enabled: true, token: '' }); // blank is "keep", never "clear"
  assert.equal(settings.getHomeAssistantConfig().token, 'll-token-xyz');
  assert.equal(settings.getHomeAssistantConfig().enabled, true);
});

// ── pure payload builders ──

test('speakable is TTS-safe: no emoji, kind-shaped', () => {
  assert.equal(ha.speakable('timer', 'pasta'), 'Timer done: pasta.');
  assert.equal(ha.speakable('timer', null), 'Timer done.');
  assert.equal(ha.speakable('reminder', 'call mom'), 'Reminder: call mom.');
  assert.match(ha.speakable('test', null), /test/i);
  for (const s of [ha.speakable('timer', 'x'), ha.speakable('reminder', 'y')]) {
    assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(s), `no emoji in spoken text: ${s}`);
  }
});

test('announceCall targets assist_satellite.announce; preannounce is omitted unless explicitly set', () => {
  const [d1, s1, data1] = ha.announceCall(['assist_satellite.kitchen'], 'Timer done.');
  assert.equal(`${d1}.${s1}`, 'assist_satellite.announce');
  assert.deepEqual(data1, { entity_id: ['assist_satellite.kitchen'], message: 'Timer done.' });
  assert.ok(!('preannounce' in data1), 'unset → key omitted entirely');
  const [, , data2] = ha.announceCall(['assist_satellite.kitchen'], 'x', false);
  assert.equal(data2.preannounce, false);
});

test('scriptCall uses script.turn_on (non-blocking) with kind+title variables', () => {
  const [domain, service, data] = ha.scriptCall('script.fanad_alarm', 'timer', 'pasta');
  assert.equal(`${domain}.${service}`, 'script.turn_on');
  assert.deepEqual(data, { entity_id: 'script.fanad_alarm', variables: { kind: 'timer', title: 'pasta' } });
});

test('notifyCall posts to notify.<service> with a kind-shaped title', () => {
  const [domain, service, data] = ha.notifyCall('mobile_app_a', 'reminder', 'Reminder: call mom.');
  assert.equal(domain, 'notify');
  assert.equal(service, 'mobile_app_a');
  assert.deepEqual(data, { title: 'Fanad reminder', message: 'Reminder: call mom.' });
});

test('calendarEventCall: a timed task → a local 30-min block; date-only → all-day with EXCLUSIVE end', () => {
  // "on <when> <time>" stores remind_at === due_at → timed (calendar.js semantics).
  const at = new Date(2026, 6, 24, 15, 0, 0).getTime(); // July 24 2026, 3pm local
  const timed = ha.calendarEventCall('calendar.house', { summary: 'dentist', remind_at: at, due_at: at });
  assert.equal(timed[0], 'calendar'); assert.equal(timed[1], 'create_event');
  assert.equal(timed[2].entity_id, 'calendar.house');
  assert.equal(timed[2].start_date_time, '2026-07-24 15:00:00');
  assert.equal(timed[2].end_date_time, '2026-07-24 15:30:00');
  // Dateless "on <when>": remind 09:00 + differing end-of-day due → ALL-DAY, end_date = next day (exclusive).
  const nine = new Date(2026, 6, 24, 9, 0, 0).getTime();
  const eod = new Date(2026, 6, 24, 23, 59, 59, 999).getTime();
  const allDay = ha.calendarEventCall('calendar.house', { summary: 'bins', remind_at: nine, due_at: eod });
  assert.equal(allDay[2].start_date, '2026-07-24');
  assert.equal(allDay[2].end_date, '2026-07-25', 'HA end_date is exclusive — the next local day');
  assert.ok(!('start_date_time' in allDay[2]));
  // Undated → null (nothing to put on a calendar).
  assert.equal(ha.calendarEventCall('calendar.house', { summary: 'someday' }), null);
});

test('the original capture rides along as the event description only when it adds something', () => {
  const at = Date.now() + 86400000;
  const t = { summary: 'dentist', original_text: 'dentist on friday 3pm', remind_at: at, due_at: at };
  assert.equal(ha.calendarEventCall('calendar.house', t)[2].description, 'dentist on friday 3pm');
  const same = { summary: 'dentist', original_text: 'dentist', remind_at: at, due_at: at };
  assert.ok(!('description' in ha.calendarEventCall('calendar.house', same)[2]), 'identical text adds nothing');
});

// ── annunciate: the fire-path fan-out (never throws; failures are per-output) ──

// An unroutable local port: connections fail fast, no real HA needed.
const DEAD_CFG = {
  enabled: true, baseUrl: 'http://127.0.0.1:1', token: 'x', agentId: '',
  announce: { enabled: true, entities: ['assist_satellite.kitchen'], preannounce: null },
  script: { enabled: false, entity: '' },
  notify: { enabled: false, services: [] },
  calendar: { entity: '' },
};

test('annunciate is a silent no-op when the module is disabled or unconfigured', async () => {
  const r = await ha.annunciate('timer', 'pasta', { ...DEAD_CFG, enabled: false });
  assert.deepEqual(r, { ok: false, failed: [], skipped: true });
  const r2 = await ha.annunciate('timer', 'pasta', { ...DEAD_CFG, token: '' });
  assert.equal(r2.skipped, true);
});

test('annunciate never throws on an unreachable HA — it reports the failed output instead', async () => {
  const r = await ha.annunciate('timer', 'pasta', DEAD_CFG);
  assert.equal(r.ok, false);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].output, 'announce');
  assert.equal(ha.haProblem() != null, true, 'the failure is visible to /ha status');
});

// ── the scheduler hook: ring-the-house is strictly fire-and-forget ──

test('a due timer for an opted-in OWNER rings the house with (kind, label)', async () => {
  clearTimers();
  settings.setUserFeatures(uid, { timer: true, homeassistant: true }); // owner: dark is fine (preview)
  insertTimer(uid, { label: 'pasta', durationMs: 60000, fireAt: Date.now() - 1000 });
  const rings = [];
  const fired = await fireDueTimers(Date.now(), { send: async () => true, sendSlackFn: async () => true, annunciateFn: async (kind, title) => rings.push([kind, title]) });
  assert.equal(fired.length, 1);
  assert.deepEqual(rings, [['timer', 'pasta']]);
});

test('a non-owner (module dark, not released) never rings the house — even opted in', async () => {
  clearTimers();
  settings.setTelegramConfig({ ownerId: null, allowedUsername: '' });
  const bob = getOrCreateTelegramUser(9001, 'bob');
  settings.setUserFeatures(bob, { timer: true, homeassistant: true });
  insertTimer(bob, { label: 'tea', durationMs: 60000, fireAt: Date.now() - 1000 });
  const rings = [];
  const fired = await fireDueTimers(Date.now(), { send: async () => true, sendSlackFn: async () => true, annunciateFn: async (...a) => rings.push(a) });
  assert.equal(fired.length, 1, "bob's timer still rings HIM (chat delivery untouched)");
  assert.equal(rings.length, 0, 'but the dark module never reaches the house');
});

test('NEVER-BLOCK invariant: a throwing/rejecting annunciator cannot break timer delivery', async () => {
  clearTimers();
  insertTimer(uid, { label: 'sanity', durationMs: 60000, fireAt: Date.now() - 1000 });
  const firedSync = await fireDueTimers(Date.now(), {
    send: async () => true, sendSlackFn: async () => true,
    annunciateFn: () => { throw new Error('HA exploded synchronously'); },
  });
  assert.equal(firedSync.length, 1, 'a sync throw is swallowed; the ding is delivered');
  clearTimers();
  insertTimer(uid, { label: 'sanity2', durationMs: 60000, fireAt: Date.now() - 1000 });
  const firedAsync = await fireDueTimers(Date.now(), {
    send: async () => true, sendSlackFn: async () => true,
    annunciateFn: async () => { throw new Error('HA exploded later'); },
  });
  assert.equal(firedAsync.length, 1, 'an async rejection is caught; the ding is delivered');
});

test('fireDueReminders carries the same hook (reminder kind)', async () => {
  // The reminder fire path is exercised end-to-end in scheduler.test.js; here just prove the injectable
  // annunciateFn option is accepted and the sweep still runs clean with it present.
  const fired = await fireDueReminders(Date.now(), { send: async () => true, sendSlackFn: async () => true, annunciateFn: async () => {} });
  assert.ok(Array.isArray(fired));
});

// ── the m:hacal button token (the decodeToken verb-whitelist gotcha) ──

test('m:hacal decodes as a VALUE-carrying token (never coerced to a task-id shape)', () => {
  assert.deepEqual(decodeToken('m:hacal:12'), { ns: 'm', verb: 'hacal', taskId: null, value: '12' });
});

test('a stale hacal tap (gone/foreign task id) gets a gentle answer', async () => {
  const r = await handleAction(uid, 'm:hacal:999999');
  assert.match(r.text, /gone/i);
});

// ── the chat surface (module on; HA unconfigured → clear guidance, no network) ──

// A weekday two days out is never today and always future — clock-independent (calendar-wiring.test.js).
const FUTURE_WEEKDAY = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][(new Date().getDay() + 2) % 7];

test('the /cal reply grows the 🏠 button only when the module is on AND a calendar entity is set', async () => {
  settings.setUserFeatures(uid, { homeassistant: true });
  settings.setHomeAssistantConfig({ calendar: { entity: '' } });
  await say(`dentist on ${FUTURE_WEEKDAY} 3pm`); // mock-LLM dated capture
  const list = await say('/tasks all');
  const m = String(list.reply).match(/📅 \/cal_(\d+)/);
  assert.ok(m, 'a dated row offers /cal_N');
  const noBtn = await say(`/cal ${m[1]}`);
  const datas = (noBtn.buttons || []).flat().map((b) => b.data);
  assert.ok(!datas.some((d) => d.startsWith('m:hacal:')), 'no calendar entity → no 🏠 button');
  settings.setHomeAssistantConfig({ calendar: { entity: 'calendar.house' } });
  const withBtn = await say(`/cal ${m[1]}`);
  const datas2 = (withBtn.buttons || []).flat().map((b) => b.data);
  assert.ok(datas2.some((d) => /^m:hacal:\d+$/.test(d)), 'entity set → the 🏠 push button appears');
});

test('ha status / ha test / passthrough all point at Settings while unconfigured (no network)', async () => {
  settings.setHomeAssistantConfig({ enabled: false, baseUrl: '' }); // wipe the URL → unconfigured
  // The stored token from earlier tests is kept (blank = keep), but no baseUrl means "not configured".
  assert.match(await reply('ha'), /isn.t connected|Settings/i);
  assert.match(await reply('ha test'), /isn.t connected|Settings/i);
  assert.match(await reply('ha turn off the kitchen light'), /isn.t connected|Settings/i);
});

test('with the module OFF, bare "ha …" text falls through and files as a task', async () => {
  settings.setUserFeatures(uid, { homeassistant: false });
  const r = await say('ha that was funny');
  assert.match(r.reply, /Filed|✓/i, 'no module, no interception — ordinary capture');
  settings.setUserFeatures(uid, { homeassistant: true });
});

test('/ha (slash form) with the module off offers the one-tap turn-on', async () => {
  settings.setUserFeatures(uid, { homeassistant: false });
  const r = await say('/ha');
  const datas = (r.buttons || []).flat().map((b) => b.data);
  assert.ok(datas.includes('m:optin:homeassistant'), 'the explicit slash form offers to turn it on');
  settings.setUserFeatures(uid, { homeassistant: true });
});

// ── secret sweep: migrateSecretsAtRest lifts the HA token too ──

test('migrateSecretsAtRest keeps the HA token decryptable (rekey sweep covers it)', () => {
  settings.migrateSecretsAtRest();
  assert.equal(settings.getHomeAssistantConfig().token, 'll-token-xyz', 'still readable after a sweep');
});
