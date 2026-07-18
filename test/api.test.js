// routes/api.js over real HTTP — the seams unit tests skip: the express wiring itself (JSON body, route
// params, status codes), the idParam guard (garbage ids must 400/404, never a 500 from a NaN SQL binding),
// secret redaction, the SETUP_MODE / cloud-provider / notebook gates, and the acting-user seam (the
// X-Fanad-User header must be inert while impersonation is off).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-api-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const express = (await import('express')).default;
const { migrate } = await import('../server/db.js');
migrate();
const apiRouter = (await import('../server/routes/api.js')).default;
const {
  defaultUserId, insertTask, insertNote, insertWakeup, getTask, getNote,
  getOrCreateTelegramUser, listMessagesBefore,
} = await import('../server/repo.js');

const uid = defaultUserId();
(await import('../server/settings.js')).setUserFeatures(uid, { notes: true, lists: true, metrics: true, vouch: true });

// The same mount shape index.js uses (json body → router). No ipGate/auth middleware: auth mode is 'none'
// here, where sessionMiddleware contributes nothing and apiAuthGate passes everything through.
const app = express();
app.use(express.json());
app.use('/api', apiRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
after(() => { server.closeAllConnections?.(); server.close(); });

const GET = (p, headers = {}) => fetch(base + p, { headers });
const POST = (p, body, headers = {}) =>
  fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) });

test('POST /chat: empty text is a 400; a real message gets a reply and lands on the task list', async () => {
  assert.equal((await POST('/chat', { text: '   ' })).status, 400);
  const r = await POST('/chat', { text: 'water the monstera' });
  assert.equal(r.status, 200);
  assert.match((await r.json()).reply, /\S/);
  const tasks = (await (await GET('/tasks')).json()).tasks;
  assert.ok(tasks.some((t) => /monstera/.test(t.summary)), 'the filed task is visible via GET /tasks');
});

test('garbage :id params 404 cleanly — they must never reach the SQL layer as NaN (a 500)', async () => {
  for (const bad of ['abc', '12abc', '0', '-3', '1.5']) {
    assert.equal((await POST(`/tasks/${bad}/status`, { status: 'done' })).status, 404, `status route, id "${bad}"`);
    assert.equal((await GET(`/tasks/${bad}/event.ics`)).status, 404, `ics route, id "${bad}"`);
  }
  assert.equal((await GET('/chat/history?before=abc')).status, 400, 'a non-id keyset cursor is rejected');
});

test('POST /tasks/:id/status: bad status 400s, a foreign id 404s, a real one round-trips', async () => {
  const task = insertTask({ userId: uid, summary: 'status roundtrip' });
  assert.equal((await POST(`/tasks/${task.id}/status`, { status: 'exploded' })).status, 400);
  assert.equal((await POST('/tasks/999999/status', { status: 'done' })).status, 404);
  const r = await POST(`/tasks/${task.id}/status`, { status: 'done' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).task.status, 'done');
  assert.equal(getTask(uid, task.id).status, 'done', 'persisted, not just echoed');
});

test('POST /tasks/:id/status in_progress pauses the previously started task (single-active)', async () => {
  const a = insertTask({ userId: uid, summary: 'web start alpha' });
  const b = insertTask({ userId: uid, summary: 'web start beta' });
  assert.equal((await POST(`/tasks/${a.id}/status`, { status: 'in_progress' })).status, 200);
  assert.equal((await POST(`/tasks/${b.id}/status`, { status: 'in_progress' })).status, 200);
  const pausedA = getTask(uid, a.id);
  assert.equal(pausedA.status, 'available');
  assert.equal(pausedA.started_at, null);
  assert.equal(getTask(uid, b.id).status, 'in_progress');
});

test('POST /tasks/:id/status: snooze → available clears the wake timer (the web unsnooze path)', async () => {
  const task = insertTask({ userId: uid, summary: 'web snooze roundtrip' });
  const snz = await (await POST(`/tasks/${task.id}/status`, { status: 'snoozed' })).json();
  assert.equal(snz.task.status, 'snoozed');
  assert.ok(getTask(uid, task.id).snoozed_until > Date.now(), 'a default wake timer was set');
  const tasks = (await (await GET('/tasks')).json()).tasks;
  assert.ok(tasks.some((t) => t.id === task.id && t.status === 'snoozed'),
    'the snoozed row still rides GET /tasks — the web snoozed drawer feeds off it');
  const back = await (await POST(`/tasks/${task.id}/status`, { status: 'available' })).json();
  assert.equal(back.task.status, 'available');
  assert.equal(getTask(uid, task.id).snoozed_until, null, 'no phantom wake timer left behind');
});

test('GET /tasks/:id/event.ics serves a calendar for a dated task; an undated one is a 404', async () => {
  const dated = insertTask({ userId: uid, summary: 'dentist', dueAt: Date.now() + 86400000 });
  const undated = insertTask({ userId: uid, summary: 'someday maybe' });
  const r = await GET(`/tasks/${dated.id}/event.ics`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/calendar/);
  assert.match(await r.text(), /BEGIN:VEVENT/);
  assert.equal((await GET(`/tasks/${undated.id}/event.ics`)).status, 404);
});

test('GET /settings/llm never leaks the key — only a hasApiKey boolean', async () => {
  const body = await (await GET('/settings/llm')).json();
  assert.ok(!('apiKey' in body), 'the raw key must not ride the wire');
  assert.equal(typeof body.hasApiKey, 'boolean');
  assert.equal(body.cloudEnabled, false, 'cloud stays off without LLM_ALLOW_CLOUD');
});

test('POST /settings/llm refuses a cloud provider while LLM_ALLOW_CLOUD is off (the hard boundary)', async () => {
  const r = await POST('/settings/llm', { provider: 'openai' });
  assert.equal(r.status, 403, 'the UI hides cloud options, but the server is the real gate');
  const after_ = await (await GET('/settings/llm')).json();
  assert.notEqual(after_.provider, 'openai', 'the setting did not change');
});

test('settings backup/restore are 404 while SETUP_MODE is off — a live box never dumps its secrets', async () => {
  assert.equal((await GET('/settings/backup')).status, 404);
  assert.equal((await POST('/settings/restore', { kind: 'fanad-settings-backup', settings: {} })).status, 404);
});

test('instance export is 404 while BACKUP_MODE is off — the whole-DB download is opt-in only', async () => {
  assert.equal((await GET('/instance/export')).status, 404);
  assert.equal((await GET('/instance/export?kek=1')).status, 404);
  const s = await (await GET('/instance/status')).json();
  assert.equal(s.backupMode, false, 'status still answers, so the UI can show the how-to-enable hint');
});

test('GET /users reports the impersonation picker as disabled (flag off) and acts as root', async () => {
  const body = await (await GET('/users')).json();
  assert.equal(body.enabled, false);
  assert.deepEqual(body.users, [], 'no account list without the flag');
  assert.equal(body.currentUserId, uid);
});

test('the X-Fanad-User header is inert while impersonation is off — writes land under root', async () => {
  const bob = getOrCreateTelegramUser(888001, 'bob');
  const r = await POST('/chat', { text: 'sneaky header message' }, { 'X-Fanad-User': String(bob) });
  assert.equal(r.status, 200);
  assert.equal(listMessagesBefore(bob, { channel: null }).length, 0, 'nothing was written under bob');
  assert.ok(listMessagesBefore(uid, { channel: 'web', limit: 100 }).some((m) => /sneaky header/.test(m.text)),
    'the turn was filed under root, the only actable user');
});

test('POST /react validates the emoji (length-capped) and returns a sentiment', async () => {
  assert.equal((await POST('/react', {})).status, 400, 'emoji required');
  assert.equal((await POST('/react', { emoji: 'not-an-emoji-way-too-long' })).status, 400);
  const r = await POST('/react', { emoji: '👍' });
  assert.equal(r.status, 200);
  assert.ok('sentiment' in await r.json());
});

test('note review: archive and promote both work over the wire; unknown actions 400', async () => {
  const keep = insertNote({ userId: uid, text: 'remember the wifi password' });
  assert.equal((await POST(`/notes/${keep.id}/review`, { action: 'defenestrate' })).status, 400);
  const archived = await (await POST(`/notes/${keep.id}/review`, { action: 'archive' })).json();
  assert.equal(archived.note.status, 'archived');

  const promo = insertNote({ userId: uid, text: 'call the plumber about the leak' });
  const r = await POST(`/notes/${promo.id}/review`, { action: 'promote' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.task?.id, 'promotion mints a real task');
  assert.equal(getNote(uid, promo.id).promoted_task_id, body.task.id, 'the note records its promotion');
});

test('GET /wakeups returns unseen nudges once — the read marks them seen', async () => {
  insertWakeup(uid, 'psst — check-in');
  const first = await (await GET('/wakeups')).json();
  assert.ok(first.wakeups.some((w) => /psst/.test(w.text)));
  const second = await (await GET('/wakeups')).json();
  assert.equal(second.wakeups.length, 0, 'already delivered');
});

test('POST /chat/history/clear validates scope, then actually truncates the web transcript', async () => {
  assert.equal((await POST('/chat/history/clear', { scope: 'everything!!' })).status, 400);
  await POST('/chat', { text: 'a turn to be cleared' });
  const r = await (await POST('/chat/history/clear', { scope: 'all' })).json();
  assert.ok(r.removed >= 1, 'reports how many rows went');
  const history = await (await GET('/chat/history')).json();
  assert.deepEqual(history.messages, []);
});

test('GET /chat/history carries the stamped reaction on ME turns only', async () => {
  await POST('/chat', { text: 'sweep the porch' });
  const { messages } = await (await GET('/chat/history')).json();
  const me = messages.find((m) => m.role === 'me' && m.text === 'sweep the porch');
  assert.equal(me.reaction, '\u{1FAE1}', "Fanad's 🫡 stamp rides the history payload");
  assert.ok(messages.filter((m) => m.role === 'bot').every((m) => m.reaction == null), 'bot turns never carry it');
});

test('GET /chat/history keeps the status chip on a reloaded task-capture (logged + mood persist)', async () => {
  await POST('/chat', { text: '\u{1F973}' });              // express a mood (🥳)
  await POST('/chat', { text: 'call the vet tomorrow' });  // a capture: logged:true, status carries the mood
  const { messages } = await (await GET('/chat/history')).json();
  // The web gates the ambient status chip on `logged`; it must survive the round-trip through raw_json, or a
  // reloaded capture silently loses its mood · time · weather header even though the mood is right there.
  const capture = messages.find((m) => m.role === 'bot' && /Filed/.test(m.text) && /vet/.test(m.text));
  assert.ok(capture, 'the filed-task confirmation is in history');
  assert.equal(capture.logged, true, 'a reloaded capture keeps logged:true so the chip still renders');
  assert.match(capture.status?.mood || '', /\u{1F973}/u, 'and the mood rides along in the persisted status');
  // A non-capture bot reply (the mood ack) is not logged → no chip. Confirms the gate still discriminates.
  const moodRow = messages.find((m) => m.role === 'bot' && /Mood set/.test(m.text));
  if (moodRow) assert.notEqual(moodRow.logged, true, 'a non-capture reply stays unlogged → no chip');
});

test('GET /metrics/:name/chart-data returns the raw series; unknown metrics 404', async () => {
  await POST('/metrics', { name: 'pushups', aggregation: 'sum', measurementType: 'tallied', target: 50 });
  await POST('/metrics/pushups/values', { value: 20 });
  const d = await (await GET('/metrics/pushups/chart-data?range=7d')).json();
  assert.equal(d.series.type, 'bar');
  assert.equal(d.metric.target, 50);
  assert.ok(d.series.y.includes(20), "today's tally is in the series");
  assert.equal((await GET('/metrics/nope/chart-data')).status, 404);
});

test('notebook routes are gated while the module is off for the user', async () => {
  const listing = await (await GET('/notebooks')).json();
  assert.equal(listing.enabled, false, 'the client hides the switcher');
  assert.equal((await POST('/notebooks/switch', { id: 1 })).status, 403);
  assert.equal((await POST('/notebooks', { name: 'work' })).status, 403);
});

test('a RETIRED notebook is invisible to the web: out of the listing, and its id 404s as a switch target', async () => {
  const { setUserFeatures } = await import('../server/settings.js');
  const { createNotebook, retireNotebook } = await import('../server/repo.js');
  setUserFeatures(uid, { notebook: true });
  const nb = createNotebook(uid, 'shed').notebook;
  retireNotebook(uid, 'shed');
  const listing = await (await GET('/notebooks')).json();
  assert.ok(!listing.notebooks.some((n) => n.id === nb.id), 'the switcher never offers a retired space');
  assert.equal((await POST('/notebooks/switch', { id: nb.id })).status, 404, 'nor can its raw id be switched into');
  setUserFeatures(uid, { notebook: false });
});

test('GET /heartbeat carries the acting user’s current notebook — null in main, the id after a switch', async () => {
  const { setUserFeatures } = await import('../server/settings.js');
  const { createNotebook } = await import('../server/repo.js');
  const nbOf = async () => (await (await GET('/heartbeat')).json()).notebook;
  assert.equal(await nbOf(), null, 'main space');
  setUserFeatures(uid, { notebook: true });
  const nb = createNotebook(uid, 'hbspace').notebook;
  assert.equal((await POST('/notebooks/switch', { id: nb.id })).status, 200);
  assert.equal(await nbOf(), nb.id, 'a switch (from ANY surface — chat or web) is visible on the next beat');
  assert.equal((await POST('/notebooks/switch', { id: 'main' })).status, 200);
  assert.equal(await nbOf(), null, 'back to main');
  setUserFeatures(uid, { notebook: false });
});

test('the retention toggle round-trips through its settings route', async () => {
  const on = await (await POST('/settings/retention', { enabled: true })).json();
  assert.equal(on.enabled, true);
  const off = await (await POST('/settings/retention', { enabled: false })).json();
  assert.equal(off.enabled, false);
});

// ── the Diet module's routes (its own toggle — metrics being on above doesn't unlock these) ──
const PATCH = (p, body) => fetch(base + p, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const DEL = (p) => fetch(base + p, { method: 'DELETE' });

test('diet routes are gated behind the diet module, not metrics', async () => {
  assert.equal((await GET('/foods')).status, 403);
  assert.equal((await POST('/diet/log', { name: 'x' })).status, 403);
  assert.equal((await PATCH('/diet/log/1', { calories: 100 })).status, 403);
  assert.equal((await DEL('/diet/log/1')).status, 403);
  assert.equal((await GET('/diet/chart-data/weight')).status, 403, 'chart data rides the same gate');
});

test('food CRUD round-trips (diet on)', async () => {
  (await import('../server/settings.js')).setUserFeatures(uid, { diet: true });
  const created = await (await POST('/foods', { name: 'chicken breast', calPerUnit: 45 })).json();
  assert.equal(created.food.unit_type, 'ounce');
  assert.equal((await POST('/foods', { name: '', calPerUnit: 45 })).status, 400);
  assert.equal((await POST('/foods', { name: 'bad', calPerUnit: -2 })).status, 400);
  const patched = await (await PATCH(`/foods/${created.food.id}`, { calPerUnit: 46 })).json();
  assert.equal(patched.food.cal_per_unit, 46);
  assert.equal((await PATCH('/foods/999999', { calPerUnit: 1 })).status, 404);
  const listed = await (await GET('/foods')).json();
  assert.ok(listed.foods.some((f) => f.name === 'chicken breast'));
  await POST('/foods', { name: 'rice', calPerUnit: 1.3, unitType: 'gram' });
});

test('GET /diet/chart-data/:name validates the name and serves the weight series once logged', async () => {
  assert.equal((await GET('/diet/chart-data/protein')).status, 404, 'only calories|weight exist');
  await POST('/diet/weight', { value: 180 });
  const d = await (await GET('/diet/chart-data/weight')).json();
  assert.equal(d.series.type, 'line');
  assert.ok(d.series.y.includes(180));
  // A point metric also ships [epoch, value] pairs so the web draws a REAL time axis.
  assert.ok(Array.isArray(d.series.points));
  const pair = d.series.points.find((p) => p[1] === 180);
  assert.ok(pair, 'the reading appears as a [ts, value] pair');
  assert.ok(pair[0] > 1_500_000_000_000, 'first element is an epoch-ms timestamp');
});

test('weight log: backdated add, list, edit (value + date), delete', async () => {
  // Backdated add via YYYY-MM-DD lands mid-day inside that (02:00-anchored) day.
  assert.equal((await POST('/diet/weight', { value: 179, at: '2026-07-01' })).status, 200);
  assert.equal((await POST('/diet/weight', { value: 0, at: '2026-07-01' })).status, 400, 'value validated');
  assert.equal((await POST('/diet/weight', { value: 179, at: 'yesterday-ish' })).status, 400, 'date validated');
  let log = await (await GET('/diet/weight-log')).json();
  const entry = log.entries.find((e) => e.value === 179);
  assert.ok(entry, 'backdated entry listed');
  assert.equal(new Date(entry.recordedAt).getDate(), 1);
  assert.equal(new Date(entry.recordedAt).getHours(), 14, 'YYYY-MM-DD lands mid-day (02:00 day start + 12h)');
  assert.equal(entry.date, '2026-07-01', 'the server names the entry’s day — the web shows this, not its own Date math');
  assert.ok(log.entries.length >= 2, 'the earlier 180 reading is there too');
  const first = log.entries[0];
  assert.equal(first.value, 179, 'entries are ordered by recorded_at, so the backdated one is first');
  // Edit value + re-date.
  const patched = await (await PATCH(`/diet/weight/${entry.id}`, { value: 178.5, at: '2026-07-02' })).json();
  assert.equal(patched.entry.value, 178.5);
  assert.equal(new Date(patched.entry.recordedAt).getDate(), 2);
  assert.equal((await PATCH(`/diet/weight/${entry.id}`, { value: -1 })).status, 400);
  assert.equal((await PATCH('/diet/weight/999999', { value: 170 })).status, 404, 'forged id 404s');
  // Delete.
  assert.equal((await DEL(`/diet/weight/${entry.id}`)).status, 200);
  log = await (await GET('/diet/weight-log')).json();
  assert.ok(!log.entries.some((e) => e.id === entry.id));
  assert.equal((await DEL(`/diet/weight/${entry.id}`)).status, 404, 'double delete 404s');
});

test('weight-log routes ride the diet gate and never touch the calories metric', async () => {
  // A weight id can't be deleted through the diet/log (calories) routes — scoping check.
  const log = await (await GET('/diet/weight-log')).json();
  if (log.entries.length) {
    assert.equal((await DEL(`/diet/log/${log.entries[0].id}`)).status, 404, 'weight row unreachable via calories route');
  }
});

test('recipe save computes the snapshot math; unknown items need their own calPerUnit', async () => {
  const bad = await POST('/recipes', { name: 'chili', cookedWeightOz: 28, items: [{ name: 'unicorn', quantity: 4 }] });
  assert.equal(bad.status, 400);
  const r = await (await POST('/recipes', {
    name: 'chili',
    cookedWeightOz: 28,
    // 16 oz × 46 = 736 · 100 g × 1.3 = 130 · a custom item 10 oz × 10 = 100 → 966 ÷ 28 = 34.5
    items: [
      { name: 'chicken breast', quantity: 16 },
      { name: 'rice', quantity: 100, unit: 'g' },
      { name: 'canned tomatoes', quantity: 10, calPerUnit: 10 },
    ],
  })).json();
  assert.equal(r.totalCalories, 966);
  assert.equal(r.calPerOz, 34.5);
  const got = await (await GET(`/recipes/${r.recipe.id}`)).json();
  assert.equal(got.items.length, 3);
});

test('serving foods round-trip and log with no quantity (= 1 typical serving)', async () => {
  const created = await (await POST('/foods', { name: 'skyr', calPerUnit: 140, unitType: 'serving' })).json();
  assert.equal(created.food.unit_type, 'serving');
  assert.equal(created.food.description, null); // a plain serving food, not a meal
  const one = await (await POST('/diet/log', { name: 'skyr' })).json(); // no quantity → 1 serving
  assert.equal(one.calories, 140);
  assert.equal(one.entryLabel, 'skyr');
  const two = await (await POST('/diet/log', { name: 'skyr', quantity: 2 })).json();
  assert.equal(two.calories, 280);
  const day = await (await GET('/diet/log')).json();
  for (const label of ['skyr', '2 skyr']) {
    const e = day.entries.find((x) => x.label === label);
    assert.equal((await DEL(`/diet/log/${e.id}`)).status, 200, `cleanup delete of "${label}"`);
  }
});

test('GET /foods returns a meal’s description', async () => {
  await POST('/chat', { text: 'save meal breakfast 2 eggs, skyr 300cal' });
  const listed = await (await GET('/foods')).json();
  const meal = listed.foods.find((f) => f.name === 'breakfast');
  assert.equal(meal.unit_type, 'serving');
  assert.equal(meal.description, '2 eggs, skyr');
});

test('GUI logging: known food logs, unknown 400s (never the LLM), the daily log and per-row delete see it', async () => {
  assert.equal((await POST('/diet/log', { name: 'mystery goo', quantity: 4, unit: 'oz' })).status, 400);
  const logged = await (await POST('/diet/log', { name: 'chicken breast', quantity: 4, unit: 'oz' })).json();
  assert.equal(logged.calories, 184); // 4 × 46 (patched above)
  assert.equal(logged.entryLabel, '4 oz chicken breast');
  const day = await (await GET('/diet/log')).json();
  const entry = day.entries.find((e) => e.label === '4 oz chicken breast');
  assert.ok(entry);
  assert.ok(day.total >= 184);
  const undone = await (await DEL(`/diet/log/${entry.id}`)).json();
  assert.equal(undone.ok, true);
  const after = await (await GET('/diet/log')).json();
  assert.ok(!after.entries.some((e) => e.id === entry.id), 'only that row is gone');
});

test('the report carries the day series, target, weight series, and the server’s own today + tz', async () => {
  await POST('/diet/log', { name: 'chili', quantity: 8, unit: 'oz' }); // 8 × 34.5 = 276
  const rep = await (await GET('/diet/report?days=7')).json();
  assert.equal(rep.days.length, 7);
  assert.equal(rep.todayTotal, 276);
  assert.equal(rep.target, 2000);
  assert.ok(Array.isArray(rep.weight));
  // The web adopts the server's day (02:00 rollover on the server clock) instead of computing its own.
  assert.equal(rep.today, rep.days[rep.days.length - 1].date, 'today is the last day of the series');
  assert.equal(rep.tz.offsetMinutes, new Date().getTimezoneOffset());
  const day = await (await GET('/diet/log')).json(); // no ?date → the server picks its today
  assert.equal(day.date, rep.today, 'the default daily log is the same today the report names');
});

test('an "eat whatever" day is flagged in the report/log and drops out of the average', async () => {
  // Today has calories logged by earlier tests and isn't marked → it's the one counted day.
  const before = await (await GET('/diet/report?days=7')).json();
  assert.equal(before.days.at(-1).whatever, false);
  assert.equal(before.average, before.todayTotal, 'the only day with data sets the average');
  // Mark today off the record over the wire.
  const marked = await (await POST('/diet/whatever', { on: true })).json();
  assert.equal(marked.whatever, true);
  const after = await (await GET('/diet/report?days=7')).json();
  assert.equal(after.days.at(-1).whatever, true, 'the last day is now tinted');
  assert.equal(after.average, null, 'the marked day is excluded — no counted days left');
  assert.equal((await (await GET('/diet/log')).json()).whatever, true, 'the daily log echoes the flag');
  // Clearing it puts the day back on the books.
  await POST('/diet/whatever', { on: false });
  const restored = await (await GET('/diet/report?days=7')).json();
  assert.equal(restored.days.at(-1).whatever, false);
  assert.equal(restored.average, restored.todayTotal);
});

test('the daily target is settable over the wire and lands in the report', async () => {
  assert.equal((await POST('/diet/target', { value: -5 })).status, 400);
  assert.equal((await POST('/diet/target', { value: 1800 })).status, 200);
  const rep = await (await GET('/diet/report?days=1')).json();
  assert.equal(rep.target, 1800);
});

test('editing a log entry moves label + calories together, and chat undo tracks the NEW label', async () => {
  await POST('/diet/log', { name: 'skyr' }); // 140 cal
  const day = await (await GET('/diet/log')).json();
  const entry = day.entries.find((e) => e.label === 'skyr');
  const patched = await (await PATCH(`/diet/log/${entry.id}`, { label: 'corrected skyr', calories: 250 })).json();
  assert.equal(patched.entry.label, 'corrected skyr');
  assert.equal(patched.entry.calories, 250);
  const after = await (await GET('/diet/log')).json();
  const edited = after.entries.find((e) => e.id === entry.id);
  assert.equal(edited.label, 'corrected skyr');
  assert.equal(edited.calories, 250);
  assert.equal(after.total, day.total - 140 + 250, 'the day total re-tallies from the edited value');
  // entry_label moved with the edit, so chat's label-group undo removes it under the new name
  const r = await (await POST('/chat', { text: 'undo' })).json();
  assert.match(r.reply, /corrected skyr/);
  const final = await (await GET('/diet/log')).json();
  assert.ok(!final.entries.some((e) => e.id === entry.id), 'chat undo removed the edited entry');
});

test('diet log PATCH/DELETE validate input and are scoped to the calories metric', async () => {
  await POST('/diet/log', { name: 'skyr' });
  const day = await (await GET('/diet/log')).json();
  const entry = day.entries.find((e) => e.label === 'skyr');
  assert.equal((await PATCH(`/diet/log/${entry.id}`, { calories: -5 })).status, 400);
  assert.equal((await PATCH(`/diet/log/${entry.id}`, { calories: 'abc' })).status, 400);
  assert.equal((await PATCH(`/diet/log/${entry.id}`, { label: '   ' })).status, 400);
  for (const bad of ['abc', '0', '999999']) {
    assert.equal((await PATCH(`/diet/log/${bad}`, { calories: 100 })).status, 404, `patch id "${bad}"`);
    assert.equal((await DEL(`/diet/log/${bad}`)).status, 404, `delete id "${bad}"`);
  }
  // a row on a NON-calories metric is unreachable through the diet surface, even with a real id
  await POST('/metrics', { name: 'water' });
  const water = await (await POST('/metrics/water/values', { value: 12 })).json();
  assert.equal((await PATCH(`/diet/log/${water.id}`, { calories: 1 })).status, 404);
  assert.equal((await DEL(`/diet/log/${water.id}`)).status, 404);
  const vals = await (await GET('/metrics/water/values')).json();
  assert.equal(vals.values.length, 1, 'the water row survived the forged diet delete');
  assert.equal((await DEL(`/diet/log/${entry.id}`)).status, 200); // cleanup
});
