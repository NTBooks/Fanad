// Phase-1 pipeline tests against a temp DB with the deterministic mock LLM (no model needed).
// Run on Node 24: `npm test`. On Node 22.5–23 add the flag: `node --experimental-sqlite --test test/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the app at a throwaway DB and the mock LLM BEFORE importing app modules (config reads env at load).
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-test-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { ingest } = await import('../server/ingest.js');
const { listTasks, setTaskStatus, getTask, defaultUserId } = await import('../server/repo.js');

migrate();

test('ingest files a categorized, available task', async () => {
  const { task, classification } = await ingest({ text: 'clean the garage 🧹 real quick' });
  assert.equal(task.status, 'available');
  assert.equal(task.category, 'household');
  assert.equal(task.effort_level, 'trivial');
  assert.ok(task.summary.length > 0);
  assert.equal(classification.category, 'household');
});

test('empty messages are rejected (never stored as a blank task)', async () => {
  await assert.rejects(() => ingest({ text: '   ' }));
});

test('status transitions stamp started_at / completed_at', async () => {
  const { task } = await ingest({ text: 'email the client about the invoice' });
  assert.equal(task.category, 'work');

  const started = setTaskStatus(defaultUserId(), task.id, 'in_progress');
  assert.equal(started.status, 'in_progress');
  assert.ok(started.started_at);

  const done = setTaskStatus(defaultUserId(), task.id, 'done');
  assert.equal(done.status, 'done');
  assert.ok(done.completed_at);
});

test('tenancy: another user cannot transition this user\'s task', async () => {
  const { task } = await ingest({ text: 'water the plants' });
  const otherUser = 999;
  assert.equal(setTaskStatus(otherUser, task.id, 'done'), null);
  assert.equal(getTask(defaultUserId(), task.id).status, 'available'); // untouched
});

test('listTasks returns the filed tasks, newest first', () => {
  const tasks = listTasks(defaultUserId());
  assert.ok(tasks.length >= 3);
  for (let i = 1; i < tasks.length; i++) assert.ok(tasks[i - 1].created_at >= tasks[i].created_at);
});

// ── link previews: pasting a URL fetches the page, stores it, and (for a bare URL) titles the task with it ──
const realFetch = globalThis.fetch;
const htmlResponse = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

test('a bare-URL capture stores the link and titles the task with the page title', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => htmlResponse('<meta property="og:title" content="The Page Title"><meta property="og:description" content="A summary of the page.">');
  const { task } = await ingest({ text: 'https://example.com/article' });
  assert.equal(task.summary, 'The Page Title');           // page title became the task title
  assert.equal(task.original_text, 'https://example.com/article'); // verbatim preserved
  const link = JSON.parse(task.link_json);
  assert.equal(link.status, 'ok');
  assert.equal(link.url, 'https://example.com/article');
  assert.equal(link.title, 'The Page Title');
});

test('a text+URL capture keeps the user\'s words as the title but still stores the link', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => htmlResponse('<title>Docs</title>');
  const { task } = await ingest({ text: 'read the react docs https://react.dev/learn later' });
  assert.match(task.summary, /read the react docs/i);     // user's own words win
  const link = JSON.parse(task.link_json);
  assert.equal(link.url, 'https://react.dev/learn');
  assert.equal(link.status, 'ok');
});

test('a failed link fetch still files the task (status stored, title falls back)', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => { const e = new Error('boom'); e.name = 'TimeoutError'; throw e; };
  const { task } = await ingest({ text: 'https://example.com/down' });
  assert.ok(task.id);
  assert.equal(task.summary, 'https://example.com/down');  // no title → the URL remains the title
  const link = JSON.parse(task.link_json);
  assert.equal(link.status, 'timeout');
});

test('a task with no URL stores no link_json', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  let called = false;
  globalThis.fetch = async () => { called = true; return htmlResponse('<title>x</title>'); };
  const { task } = await ingest({ text: 'buy milk and eggs' });
  assert.equal(task.link_json, null);
  assert.equal(called, false, 'no fetch when there is no URL');
});
