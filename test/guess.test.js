// "/guess" — ask the LLM to break the task you're working on into a step checklist, then hand off to the
// normal stepping flow. Drives handleMessage directly (a `say`-style helper that clears dialog state each
// turn would wipe the stepping session the command arms). The mock LLM returns a {steps:[...]} shape when it
// sees the decompose system prompt (see server/services/llm/mock.js), so this runs offline + deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-guess-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage, handleAction } = await import('../server/chat.js');
const { clearDialogState, getDialogState } = await import('../server/dialog.js');
const { insertTask, getTask, parseSteps, defaultUserId, getOrCreateTelegramUser } = await import('../server/repo.js');

migrate();
const uid = defaultUserId();
let clock = 1_700_000_000_000;     // monotonic createdAt so "most recent open" is deterministic
let tg = 90_000;
const mk = (over = {}) => insertTask({ userId: uid, summary: 'tidy the garage', category: 'household', createdAt: clock++, ...over });
const freshUser = () => getOrCreateTelegramUser(tg++, `u${tg}`);
const send = (text) => handleMessage({ userId: uid, text });
const steps = (id, u = uid) => parseSteps(getTask(u, id));
const start = (id, u = uid) => handleAction(u, `a:start:${id}`);

test('/guess breaks the started task into steps and arms stepping', async () => {
  clearDialogState(uid);
  const t = mk({ summary: 'clean the garage' });
  await start(t.id);
  assert.notEqual(getDialogState(uid)?.type, 'stepping');     // stepless start does not arm stepping
  const out = await send('/guess');
  assert.match(out.reply, /guess at the steps for .*clean the garage/i);
  assert.match(out.reply, /not from your notes/i);            // surfaced as an explicit guess, not grounded fact
  assert.ok(steps(t.id).length >= 2, 'steps were saved on the task itself');
  const data = (out.buttons || []).flat().map((b) => b.data); // same step toggles as the start flow
  assert.ok(data.includes(`a:step:${t.id}:1`));
  assert.ok(data.includes(`a:step:${t.id}:all`));
  assert.equal(getDialogState(uid)?.type, 'stepping');
});

test('after /guess, "done all" finishes the task through the normal stepping flow', async () => {
  clearDialogState(uid);
  const t = mk({ summary: 'wash the car' });
  await start(t.id);
  await send('/guess');
  const out = await send('done all');
  assert.match(out.reply, /steps done/i);
  assert.equal(getTask(uid, t.id).status, 'done');
  assert.equal(getDialogState(uid)?.type, 'done_feedback');   // normal completion flow armed
});

test('bare "guess" works too (the leading slash is optional)', async () => {
  clearDialogState(uid);
  const t = mk({ summary: 'sort the mail' });
  await start(t.id);
  const out = await send('guess');
  assert.match(out.reply, /guess at the steps for .*sort the mail/i);
  assert.equal(getDialogState(uid)?.type, 'stepping');
});

test('/guess names WHY when the model is unavailable (out of credits / rate-limited), not a vague "no guess"', async () => {
  const u = freshUser();
  clearDialogState(u);
  // The mock throws a 429 for this summary (see mock.js __llm_http_ hook) — the real-world "/guess says no
  // guess" turned out to be a depleted-credits 429, silently hidden behind the generic message.
  const t = insertTask({ userId: u, summary: 'plan __llm_http_429__ dinner', category: 'social', createdAt: clock++ });
  await start(t.id, u);
  const typed = await handleMessage({ userId: u, text: '/guess' });
  assert.match(typed.reply ?? typed.text, /out of credits|rate-limited/i, 'the reason is surfaced');
  assert.equal(steps(t.id, u).length, 0, 'no half-baked steps were saved');
  // The tapped "💡 Suggest steps" button shows the reason on the card too (not a bare task line + "No guess").
  const tapped = await handleAction(u, `a:guess:${t.id}`);
  assert.match(tapped.text, /out of credits|rate-limited/i);
});

test('/guess with nothing in progress guides the user instead of erroring', async () => {
  const u = freshUser();
  clearDialogState(u);
  insertTask({ userId: u, summary: 'idle task', category: 'other', createdAt: clock++ }); // available, never started
  const out = await handleMessage({ userId: u, text: '/guess' });
  assert.match(out.reply, /start a task first/i);
  assert.notEqual(getDialogState(u)?.type, 'stepping');
});

test('/guess is idempotent — re-running re-opens the same steps without duplicating', async () => {
  clearDialogState(uid);
  const t = mk({ summary: 'paint the shed' });
  await start(t.id);
  await send('/guess');
  const n = steps(t.id).length;
  clearDialogState(uid);                                       // user wanders off, then asks again
  const out = await send('/guess');
  assert.equal(steps(t.id).length, n, 'no duplicate steps appended');
  assert.match(out.reply, /already has \d+ steps/);
  assert.equal(getDialogState(uid)?.type, 'stepping');
});

test('starting a stepless task shows a "💡 Suggest steps" button; tapping it guesses the checklist', async () => {
  const u = freshUser();
  clearDialogState(u);
  const t = insertTask({ userId: u, summary: 'plan a birthday party', category: 'social', createdAt: clock++ });
  const started = await start(t.id, u);                        // stepless start → startedMenu with a:guess
  assert.equal(started.html, true, 'the started card keeps html:true so its bold title renders, not raw <b> tags');
  const data = (started.buttons || []).flat().map((b) => b.data);
  assert.ok(data.includes(`a:guess:${t.id}`), 'the suggest-steps button is on the started card');
  const out = await handleAction(u, `a:guess:${t.id}`);        // tap it
  assert.match(out.text, /guess at the steps for .*birthday party/i);
  assert.ok(steps(t.id, u).length >= 2);
  assert.equal(getDialogState(u)?.type, 'stepping');           // armed, ready to tick
});

test('Suggest steps is reachable from the filed card AND from opening a stepless task — and is gone once it has steps', async () => {
  const u = freshUser();
  clearDialogState(u);
  // 1) Freshly filed → the confirmation card offers it (no need to start first).
  const filed = await handleMessage({ userId: u, text: 'repaint the shed' });
  const id = (filed.buttons || []).flat().map((b) => b.data).find((d) => /^a:guess:\d+$/.test(d))?.split(':')[2];
  assert.ok(id, 'filed card carries a:guess');
  // 2) Open that task from the list (m:act) while still stepless → still offered.
  const opened = await handleAction(u, `m:act:${id}`);
  assert.ok((opened.buttons || []).flat().some((b) => b.data === `a:guess:${id}`), 'open-from-list offers it too');
  // 3) Once it has steps, the guess row drops away (the menu isn't cluttered with a moot affordance).
  await handleAction(u, `a:guess:${id}`);                       // now it has steps
  clearDialogState(u);
  const reopened = await handleAction(u, `m:act:${id}`);
  assert.ok(!(reopened.buttons || []).flat().some((b) => b.data === `a:guess:${id}`), 'stepped task hides the guess row');
});

test('unstep N removes a step while stepping, and the rest renumber', async () => {
  const u = freshUser();
  clearDialogState(u);
  const t = insertTask({ userId: u, summary: 'three-step job', category: 'other', createdAt: clock++ });
  for (const x of ['alpha', 'bravo', 'charlie']) await handleMessage({ userId: u, text: `step ${x}` });
  await start(t.id, u);
  assert.equal(getDialogState(u)?.type, 'stepping');
  const out = await handleMessage({ userId: u, text: 'unstep 2' }); // drop "bravo"
  assert.match(out.reply, /Removed step 2/);
  assert.deepEqual(steps(t.id, u).map((s) => s.text), ['alpha', 'charlie']); // bravo gone, list compacted
  assert.equal(getDialogState(u)?.type, 'stepping');               // still focused
});

test('"remove step" (the explicit phrasing) also removes, but a new task is not swallowed', async () => {
  const u = freshUser();
  clearDialogState(u);
  const t = insertTask({ userId: u, summary: 'phrasing job', category: 'other', createdAt: clock++ });
  await handleMessage({ userId: u, text: 'step keep me' });
  await handleMessage({ userId: u, text: 'step delete me' });
  await start(t.id, u);
  await handleMessage({ userId: u, text: 'remove step 2' });
  assert.deepEqual(steps(t.id, u).map((s) => s.text), ['keep me']);
  // a bare "remove the trash" is a NEW task statement, never a step removal — it escapes stepping.
  await handleMessage({ userId: u, text: 'remove the trash' });
  assert.notEqual(getDialogState(u)?.type, 'stepping');
  assert.equal(steps(t.id, u).map((s) => s.text).join(','), 'keep me'); // untouched
});

test('unstep all clears the checklist and ends the stepping session', async () => {
  const u = freshUser();
  clearDialogState(u);
  const t = insertTask({ userId: u, summary: 'clear-me job', category: 'other', createdAt: clock++ });
  await handleMessage({ userId: u, text: 'step one' });
  await handleMessage({ userId: u, text: 'step two' });
  await start(t.id, u);
  const out = await handleMessage({ userId: u, text: 'unstep all' });
  assert.match(out.reply, /no steps now/i);
  assert.equal(steps(t.id, u).length, 0);
  assert.notEqual(getDialogState(u)?.type, 'stepping');           // nothing left to step through
  assert.equal(getTask(u, t.id).status, 'in_progress');           // task itself stays started
});

test('unstep works out of session too — targets the started task, renumbering the rest', async () => {
  const u = freshUser();
  clearDialogState(u);
  const t = insertTask({ userId: u, summary: 'out-of-session job', category: 'other', createdAt: clock++ });
  await handleMessage({ userId: u, text: 'step first' });
  await handleMessage({ userId: u, text: 'step second' });
  await start(t.id, u);
  await handleMessage({ userId: u, text: '/tasks' });             // leave the stepping session
  assert.notEqual(getDialogState(u)?.type, 'stepping');
  const out = await handleMessage({ userId: u, text: 'unstep 1' });
  assert.match(out.reply, /Removed step 1/);
  assert.deepEqual(steps(t.id, u).map((s) => s.text), ['second']);
});

test('/guess escapes an open stepping session and re-shows the steps without ticking any', async () => {
  // A task started WITH steps arms stepping; "/guess" is a slash command, so it must ESCAPE that session
  // (not be read as a "tick the next step" answer), then re-open the SAME task's checklist, untouched.
  const u = freshUser();
  clearDialogState(u);
  const t = insertTask({ userId: u, summary: 'bake bread', category: 'household', createdAt: clock++ });
  await handleMessage({ userId: u, text: 'step mix' });
  await handleMessage({ userId: u, text: 'step bake' });
  await start(t.id, u);                                        // arms stepping (2 steps)
  assert.equal(getDialogState(u)?.type, 'stepping');
  const out = await handleMessage({ userId: u, text: '/guess' });
  assert.match(out.reply, /already has 2 steps/);
  assert.equal(steps(t.id, u).filter((s) => s.done).length, 0, '/guess did not tick any step');
  assert.equal(getDialogState(u)?.type, 'stepping');
});
