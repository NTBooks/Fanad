// Notes self-voicemail inbox: capture, recall, review/promote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-notes-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { ingest } = await import('../server/ingest.js');
const { recallNotes } = await import('../server/rag/index.js');
const { listNotes, reviewNote, getNote, listTasks, defaultUserId } = await import('../server/repo.js');

migrate();
// Modules are per-user opt-in (default OFF); these behaviour tests run as the root user with all on.
(await import('../server/settings.js')).setUserFeatures(1, { notes: true, lists: true, metrics: true, vouch: true });

test('"note ..." files a note, not a task', async () => {
  const r = await ingest({ text: 'note the garage door code is 1234' });
  assert.equal(r.kind, 'note');
  assert.equal(r.note.status, 'new');
  assert.match(r.note.text, /garage door code/);
  assert.equal(listTasks(defaultUserId()).length, 0); // nothing on the task board
});

test('plain text still files a task', async () => {
  const r = await ingest({ text: 'email the client about the invoice' });
  assert.equal(r.kind, 'task');
});

test('the inbox lists new notes', () => {
  assert.ok(listNotes(defaultUserId(), { status: 'new' }).length >= 1);
});

test('recall finds a note by keyword/meaning (returns real notes only)', async () => {
  const hits = await recallNotes(defaultUserId(), 'garage door code');
  assert.ok(hits.length >= 1);
  assert.match(hits[0].text, /garage/);
});

test('reviewing a note marks it reviewed and can link a promoted task', () => {
  const note = listNotes(defaultUserId(), { status: 'new' })[0];
  const task = listTasks(defaultUserId())[0]; // a real task to link (FK-valid)
  const reviewed = reviewNote(defaultUserId(), note.id, { promotedTaskId: task.id });
  assert.equal(reviewed.status, 'reviewed');
  assert.equal(reviewed.promoted_task_id, task.id);
  assert.ok(reviewed.reviewed_at);
  // it leaves the inbox
  assert.ok(!listNotes(defaultUserId(), { status: 'new' }).some((n) => n.id === note.id));
});

test("another user can't read this user's note", () => {
  const note = listNotes(defaultUserId(), {})[0] || null;
  if (note) assert.equal(getNote(999, note.id), null);
});
