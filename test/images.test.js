// Image references (server/repo.js). Images are now "Telegram-only": the row stores a reusable Telegram
// file_id (no on-disk bytes), which the app hands back to sendPhoto to re-send the picture. Covers
// insert/recall, task/note association + the note→task hand-off (promote), the listing-marker query,
// per-user scoping, and row deletion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-img-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const {
  defaultUserId, getOrCreateTelegramUser, insertTask, insertNote,
  insertImage, getImage, setImageTask, setImageNote,
  getImageForTask, getImageForNote, taskIdsWithImages, deleteImagesForTask, deleteImagesForNote,
} = await import('../server/repo.js');

migrate();

test('insert keeps the Telegram file_id verbatim and recalls it by id', () => {
  const uid = defaultUserId();
  const row = insertImage({ userId: uid, fileId: 'AgACAgID-file-1' });
  assert.equal(row.file_id, 'AgACAgID-file-1');
  assert.equal(row.task_id, null);          // unattached until a caption files a task
  assert.equal(row.note_id, null);
  assert.equal(getImage(uid, row.id).file_id, 'AgACAgID-file-1');
});

test('a captioned photo attaches to its task; the recall + listing-marker hooks see it', () => {
  const uid = defaultUserId();
  const task = insertTask({ userId: uid, summary: 'frame the trail photo' });
  const img = insertImage({ userId: uid, fileId: 'tg-trail' });
  setImageTask(uid, img.id, task.id);
  assert.equal(getImageForTask(uid, task.id).file_id, 'tg-trail'); // suggestion/recall path
  assert.ok(taskIdsWithImages(uid).has(task.id));                  // the "📷" listing marker
});

test('a bare photo attaches to a note, then follows it to a task on promote', () => {
  const uid = defaultUserId();
  const note = insertNote({ userId: uid, text: '📷 Photo' });
  const img = insertImage({ userId: uid, fileId: 'tg-bare' });
  setImageNote(uid, img.id, note.id);
  assert.equal(getImageForNote(uid, note.id).file_id, 'tg-bare');

  // Promote: the same row is re-pointed at the new task (carrying the file_id over).
  const task = insertTask({ userId: uid, summary: 'hang the photo' });
  setImageTask(uid, img.id, task.id);
  assert.equal(getImageForTask(uid, task.id).file_id, 'tg-bare');
});

test('a task with no photo recalls nothing (no stale image leaks in)', () => {
  const uid = defaultUserId();
  const task = insertTask({ userId: uid, summary: 'sweep the porch' });
  assert.equal(getImageForTask(uid, task.id), null);
  assert.equal(taskIdsWithImages(uid).has(task.id), false);
});

test('images are user-scoped: one user can never read another user’s row', () => {
  const owner = getOrCreateTelegramUser(4242, 'owner');
  const other = getOrCreateTelegramUser(8888, 'other');
  const img = insertImage({ userId: owner, fileId: 'tg-private' });
  assert.equal(getImage(owner, img.id).file_id, 'tg-private');
  assert.equal(getImage(other, img.id), null); // the same id under a different user → no cross-read
});

test('deleting a task/note clears its image rows (no on-disk bytes to unlink)', () => {
  const uid = defaultUserId();
  const task = insertTask({ userId: uid, summary: 'task with a pic' });
  const note = insertNote({ userId: uid, text: 'note with a pic' });
  setImageTask(uid, insertImage({ userId: uid, fileId: 'tg-del-1' }).id, task.id);
  setImageNote(uid, insertImage({ userId: uid, fileId: 'tg-del-2' }).id, note.id);
  assert.equal(deleteImagesForTask(uid, task.id), 1);
  assert.equal(deleteImagesForNote(uid, note.id), 1);
  assert.equal(getImageForTask(uid, task.id), null);
  assert.equal(getImageForNote(uid, note.id), null);
});
