// /requestdeletion — the confirm-gated full account erase, plus the optional retention export.
// Verifies: it never deletes on the first hit, only an explicit confirm word erases, the erase actually
// wipes every table (but keeps the identity row), the confirmation reply is NOT persisted, and retention
// (when on) leaves a zip in the user's folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-deletion-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate, db } = await import('../server/db.js');
const { handleMessage } = await import('../server/chat.js');
const { clearDialogState } = await import('../server/dialog.js');
const { listTasks, listNotes, userExists, defaultUserId, USER_TABLES } = await import('../server/repo.js');
const { createSession } = await import('../server/auth.js');
const { setRetentionConfig } = await import('../server/settings.js');
const { userDir } = await import('../server/retention.js');

migrate();
// Modules are per-user opt-in (default OFF); this test fills every table, so opt the root user into all.
(await import('../server/settings.js')).setUserFeatures(1, { notes: true, lists: true, metrics: true, vouch: true });
const uid = defaultUserId();
const countMessages = () => Number(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE user_id=?').get(uid).n);

// Re-seed a known bit of data so each test starts from "there's something to delete".
async function seed() {
  clearDialogState(uid);
  await handleMessage({ text: 'clean the garage this weekend' });
  await handleMessage({ text: 'note the spare key is under the pot' });
}

test('/requestdeletion warns and arms a confirm — it does NOT delete on the first hit', async () => {
  await seed();
  const before = listTasks(uid).length;
  assert.ok(before > 0, 'precondition: a task exists');
  const r = await handleMessage({ text: '/requestdeletion' });
  assert.match(r.reply, /erase|delete/i);
  assert.match(r.reply, /confirm|cannot be undone/i);
  assert.equal(r.mode, 'confirm');
  assert.ok(r.options.includes('DELETE'));
  assert.equal(listTasks(uid).length, before, 'nothing deleted yet');
});

test('a recognized "cancel" leaves everything intact', async () => {
  await seed();
  const before = listTasks(uid).length;
  await handleMessage({ text: '/requestdeletion' });
  const r = await handleMessage({ text: 'cancel' });
  assert.match(r.reply, /nothing was deleted|safe/i);
  assert.equal(listTasks(uid).length, before);
});

test('an ambiguous reply escapes the confirm without deleting (safe default)', async () => {
  await seed();
  const before = listTasks(uid).length;
  await handleMessage({ text: '/requestdeletion' });
  // Not a confirm/cancel word → it escapes the dialog and is handled normally; the data survives.
  const r = await handleMessage({ text: 'water the front garden tomorrow' });
  assert.doesNotMatch(r.reply, /everything I.d learned are erased/i);
  assert.ok(listTasks(uid).length >= before, 'the existing tasks are untouched');
});

test('confirming with "DELETE" erases every table, keeps the identity row, and is not persisted', async () => {
  await seed();
  createSession(uid, { ip: '127.0.0.1' }); // a live web session must be swept too (USER_TABLES covers it)
  assert.ok(listTasks(uid).length > 0 && listNotes(uid).length > 0);
  await handleMessage({ text: '/requestdeletion' });
  const r = await handleMessage({ text: 'DELETE' });

  assert.match(r.reply, /erased/i);
  assert.match(r.reply, /Telegram|clear this conversation/i, 'reminds the user to clear their own chat history');

  // Every user-scoped table is empty…
  for (const t of USER_TABLES) {
    const n = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id=?`).get(uid).n);
    assert.equal(n, 0, `${t} should be empty after deletion`);
  }
  // …including messages: the confirmation reply was ephemeral, so nothing was written back.
  assert.equal(countMessages(), 0, 'the deletion reply must not be saved');
  // The account identity row survives, so the next message resolves to the same (now-empty) user.
  assert.ok(userExists(uid), 'the users row is kept');
});

test('with retention on, a zip export is written to the user folder before the wipe', async () => {
  setRetentionConfig({ enabled: true });
  try {
    await seed();
    await handleMessage({ text: '/requestdeletion' });
    const r = await handleMessage({ text: 'delete everything' });
    assert.match(r.reply, /retention is on/i);
    const files = readdirSync(userDir(uid));
    assert.ok(files.some((f) => /^deletion-export-.*\.zip$/.test(f)), `expected a zip export, saw: ${files.join(', ')}`);
    assert.equal(listTasks(uid).length, 0, 'data is still erased after archiving');
  } finally {
    setRetentionConfig({ enabled: false });
  }
});
