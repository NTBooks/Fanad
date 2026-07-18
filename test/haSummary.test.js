// /api/ha/summary over real HTTP — the Home Assistant dashboard contract: the
// versioned payload shape, count math on the 02:00 logical day, the counts-by-default/titles-opt-in privacy
// rule, per-user module gating (null blocks), the read-only claim-token scope (GET passes, writes 403),
// and the debounced 'counts' SSE poke. Mounted with the SAME middleware chain index.js uses
// (cliTokenMiddleware → apiAuthGate → router) so the Bearer path is the real one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-hasum-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const express = (await import('express')).default;
const { migrate, db } = await import('../server/db.js');
migrate();
const apiRouter = (await import('../server/routes/api.js')).default;
const { cliTokenMiddleware, apiAuthGate, mintCliToken } = await import('../server/auth.js');
const {
  defaultUserId, insertTask, setTaskStatus, setSnoozed, insertTimer, deleteTaskCascade,
} = await import('../server/repo.js');
const { setUserFeatures, setAuthConfig } = await import('../server/settings.js');
const { subscribeUserEvents } = await import('../server/events.js');
const { dayStartOf } = await import('../shared/timeframe.js');
const { ensureCaloriesMetric } = await import('../server/diet.js');
const { insertMetricValue } = await import('../server/repo.js');

const uid = defaultUserId();

const app = express();
app.use(express.json());
app.use(cliTokenMiddleware);
app.use('/api', apiAuthGate, apiRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
after(() => { server.closeAllConnections?.(); server.close(); });

const GET = (p, headers = {}) => fetch(base + p, { headers });
const POST = (p, body, headers = {}) =>
  fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) });

// Let the setImmediate-debounced counts poke flush (two hops so a poke scheduled inside a flush lands too).
const flushPokes = () => new Promise((r) => setImmediate(() => setImmediate(r)));

test('the payload contract: version, day block, task counts on the logical day, titles opt-in', async () => {
  const now = Date.now();
  const dayStart = dayStartOf(now);
  const dueToday = Math.min(now + 1000, dayStart + 86400000 - 1); // inside today's logical day, whatever the hour
  insertTask({ userId: uid, summary: 'due later today', dueAt: dueToday });
  insertTask({ userId: uid, summary: 'already overdue', dueAt: now - 3600000 });
  const started = insertTask({ userId: uid, summary: 'the one being worked' });
  setTaskStatus(uid, started.id, 'in_progress');
  const done = insertTask({ userId: uid, summary: 'finished this morning' });
  setTaskStatus(uid, done.id, 'done');
  const naps = insertTask({ userId: uid, summary: 'snoozed until tomorrow' });
  setSnoozed(uid, naps.id, now + 86400000);

  const r = await GET('/ha/summary');
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.version, 1);
  assert.equal(s.day.start, dayStart, 'the 02:00 logical day is server-owned');
  assert.ok(typeof s.day.key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.day.key));
  assert.equal(s.tasks.open, 4, 'available + in_progress + snoozed, not the done one');
  assert.equal(s.tasks.snoozed, 1);
  assert.equal(s.tasks.overdue, 1);
  assert.ok(s.tasks.due_today >= 1, 'the due-later-today task lands in due_today');
  assert.equal(s.tasks.cleared_today, 1);
  assert.equal(s.tasks.captured_today, 5);
  assert.equal(s.tasks.active.state, 'active');
  assert.equal(s.tasks.active.title, undefined, 'NO content without ?titles=1 — counts only');
  assert.ok(s.tasks.next_deadline, 'the future deadline is exposed as a timestamp');

  const t = await (await GET('/ha/summary?titles=1')).json();
  assert.equal(t.tasks.active.title, 'the one being worked', 'titles=1 opts the active task title in');
});

test('module blocks mirror per-user opt-ins: null while off, real blocks once on', async () => {
  let s = await (await GET('/ha/summary')).json();
  assert.equal(s.modules.timer, null, 'timer module off → null block, no entity spam');
  assert.equal(s.modules.diet, null);

  setUserFeatures(uid, { timer: true, diet: true });
  const fireAt = Date.now() + 5 * 60000;
  insertTimer(uid, { label: 'tea', durationMs: 5 * 60000, fireAt });
  const cal = ensureCaloriesMetric(uid);
  insertMetricValue({ userId: uid, metricId: cal.id, value: 320 });
  insertMetricValue({ userId: uid, metricId: cal.id, value: 180 });

  s = await (await GET('/ha/summary')).json();
  assert.equal(s.modules.timer.count, 1);
  assert.equal(s.modules.timer.next_fire, new Date(fireAt).toISOString());
  assert.equal(s.modules.timer.label, undefined, 'timer label is content — titles-gated');
  assert.equal(s.modules.diet.calories_today, 500);
  assert.equal(s.modules.diet.whatever_day, false);

  const t = await (await GET('/ha/summary?titles=1')).json();
  assert.equal(t.modules.timer.label, 'tea');
});

test('read-only claim token: GET /ha/summary works, ANY write is a hard 403, full scope still writes', async () => {
  setAuthConfig({ cliEnabled: true });
  const readTok = mintCliToken(uid, { label: 'ha-dashboard', scope: 'read' });
  const fullTok = mintCliToken(uid, { label: 'tui' });

  const auth = (tok) => ({ Authorization: `Bearer ${tok}` });
  assert.equal((await GET('/ha/summary', auth(readTok))).status, 200);
  assert.equal((await GET('/tasks', auth(readTok))).status, 200, 'read scope is all GETs, not one route');
  const denied = await POST('/chat', { text: 'sneaky write' }, auth(readTok));
  assert.equal(denied.status, 403, 'a read token presenting on a write is refused, never falls through');
  assert.match((await denied.json()).error, /read-only/i);
  assert.equal((await POST('/chat', { text: 'hello from the tui' }, auth(fullTok))).status, 200);

  // scope survives the round-trip into the admin list
  const listed = (await (await GET('/settings/cli-tokens')).json()).tokens;
  assert.equal(listed.find((t) => t.label === 'ha-dashboard').scope, 'read');
  assert.equal(listed.find((t) => t.label === 'tui').scope, 'full');
});

test("mutations emit ONE debounced 'counts' poke per user per tick", async () => {
  const seen = [];
  const unsub = subscribeUserEvents([uid], (type) => seen.push(type));
  try {
    const a = insertTask({ userId: uid, summary: 'poke me' });
    setTaskStatus(uid, a.id, 'done'); // second mutation, same tick
    await flushPokes();
    assert.equal(seen.filter((t) => t === 'counts').length, 1, 'debounced: two mutations, one poke');

    seen.length = 0;
    deleteTaskCascade(uid, a.id);
    await flushPokes();
    assert.equal(seen.filter((t) => t === 'counts').length, 1, 'deletes poke too');
  } finally {
    unsub();
  }
});

test('migration v39 backfilled existing rows: the scope column defaults to full', () => {
  const cols = db.prepare("SELECT name, dflt_value FROM pragma_table_info('cli_tokens') WHERE name='scope'").get();
  assert.ok(cols, 'cli_tokens.scope exists');
  assert.match(String(cols.dflt_value), /full/);
});
