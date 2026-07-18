// GET /api/sidebar — the read-only bundle behind the web's wide-screen gutter panel: the single
// in-progress task, the next upcoming rings (timers + reminders + daily check-ins, soonest first),
// today's expressed mood, and the server-owned logical day. Also proves the dataUid seam: switching
// into a notebook re-scopes every field.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-sidebar-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const express = (await import('express')).default;
const { migrate } = await import('../server/db.js');
migrate();
const apiRouter = (await import('../server/routes/api.js')).default;
const {
  defaultUserId, insertTask, setTaskStatus, setTaskReminder, insertTimer, insertSchedule,
} = await import('../server/repo.js');
const { recordSnapshot } = await import('../server/ingest.js');
const { dayStartOf } = await import('../shared/timeframe.js');

const uid = defaultUserId();
(await import('../server/settings.js')).setUserFeatures(uid, { timer: true, notebook: true });

const app = express();
app.use(express.json());
app.use('/api', apiRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
after(() => { server.closeAllConnections?.(); server.close(); });

const GET = (p) => fetch(base + p);
const POST = (p, body) =>
  fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

test('empty account: nulls and an empty upcoming list, but the day is always there', async () => {
  const r = await GET('/sidebar');
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.startedTask, null);
  assert.deepEqual(s.upcoming, []);
  assert.equal(s.mood, null);
  assert.equal(s.day.start, dayStartOf(Date.now()), 'the 02:00 logical-day boundary is server-computed');
  assert.match(s.day.label, /\w{3}, \w{3} \d/);
});

test('a seeded account: started task, soonest-first upcoming rings, and today’s mood', async () => {
  const now = Date.now();
  const t = insertTask({ userId: uid, summary: 'sand the shelf' });
  setTaskStatus(uid, t.id, 'in_progress');
  const reminded = insertTask({ userId: uid, summary: 'call the pharmacy' });
  setTaskReminder(uid, reminded.id, now + 3 * 3600000);
  insertTimer(uid, { label: 'pasta', durationMs: 600000, fireAt: now + 600000 });
  insertSchedule(uid, 510); // a daily 08:30 check-in — lands today or tomorrow, but always in the list
  recordSnapshot({ userId: uid, channel: 'web', text: '😴' });

  const s = await (await GET('/sidebar')).json();
  assert.equal(s.startedTask.summary, 'sand the shelf');
  assert.equal(s.startedTask.id, t.id);
  const types = s.upcoming.map((u) => u.type);
  assert.deepEqual([...types].sort(), ['checkin', 'reminder', 'timer']);
  assert.ok(s.upcoming.every((u, i) => i === 0 || s.upcoming[i - 1].at <= u.at), 'soonest first');
  assert.equal(s.upcoming.find((u) => u.type === 'timer').label, 'pasta');
  assert.equal(s.upcoming.find((u) => u.type === 'reminder').summary, 'call the pharmacy');
  assert.ok(s.upcoming.every((u) => u.at > now), 'nothing already-due rides the display list');
  assert.equal(s.mood, '😴');
});

test('a finished task leaves the card; done/archived reminders never show', async () => {
  const s0 = await (await GET('/sidebar')).json();
  setTaskStatus(uid, s0.startedTask.id, 'done');
  const doneReminder = s0.upcoming.find((u) => u.type === 'reminder');
  setTaskStatus(uid, doneReminder.taskId, 'done');
  const s = await (await GET('/sidebar')).json();
  assert.equal(s.startedTask, null);
  assert.ok(!s.upcoming.some((u) => u.type === 'reminder'), 'a done task’s reminder is gone');
});

test('the dataUid seam: switching into a notebook re-scopes the whole bundle', async () => {
  const t = insertTask({ userId: uid, summary: 'main-space work' });
  setTaskStatus(uid, t.id, 'in_progress');
  assert.equal((await (await GET('/sidebar')).json()).startedTask.summary, 'main-space work');

  assert.equal((await POST('/notebooks', { name: 'renovation' })).status, 200);
  const inNb = await (await GET('/sidebar')).json();
  assert.equal(inNb.startedTask, null, 'the notebook sub-user has no started task');
  assert.deepEqual(inNb.upcoming, []);

  assert.equal((await POST('/notebooks/switch', { id: 'main' })).status, 200);
  assert.equal((await (await GET('/sidebar')).json()).startedTask.summary, 'main-space work');
});
