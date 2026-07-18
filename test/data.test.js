// The web-only "Your data" browser: whitelisted, user-scoped read/edit/delete over Fanad's tables.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-data-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage } = await import('../server/chat.js');
const { clearDialogState } = await import('../server/dialog.js');
const { defaultUserId } = await import('../server/repo.js');
const data = await import('../server/dataBrowser.js');

migrate();
const uid = defaultUserId();
// Modules are per-user opt-in (default OFF); these behaviour tests run as the root user with all on.
(await import('../server/settings.js')).setUserFeatures(uid, { notes: true, lists: true, metrics: true, vouch: true });
const say = (text) => { clearDialogState(uid); return handleMessage({ text }); };

test('entities() lists user-owned views with counts and never exposes app_settings', async () => {
  await say('water the plants');
  const ents = data.entities(uid);
  const keys = ents.map((e) => e.key);
  assert.ok(keys.includes('tasks'));
  assert.ok(keys.includes('messages'));
  assert.ok(!keys.includes('app_settings')); // secrets (API key / bot token) stay hidden
  const tasks = ents.find((e) => e.key === 'tasks');
  assert.ok(tasks.count >= 1);
  assert.equal(tasks.deletable, true);
  assert.deepEqual(tasks.editable, ['summary']);
});

test('rows() returns columns, a capped page, a total, and JSON-safe values', () => {
  const page = data.rows(uid, 'tasks', { limit: 10, offset: 0 });
  assert.ok(page.columns.includes('summary'));
  assert.ok(page.rows.length >= 1);
  assert.equal(typeof page.total, 'number');
  assert.doesNotThrow(() => JSON.stringify(page)); // no BigInt leaks
});

test('the limit is clamped to a sane maximum', () => {
  assert.equal(data.rows(uid, 'tasks', { limit: 9999 }).limit, 200);
});

test('editRow() updates only whitelisted columns', () => {
  const id = data.rows(uid, 'tasks').rows[0].id;
  const updated = data.editRow(uid, 'tasks', id, { summary: 'renamed task', status: 'archived' });
  assert.equal(updated.summary, 'renamed task');
  assert.notEqual(updated.status, 'archived'); // status isn't editable → ignored
  assert.throws(() => data.editRow(uid, 'tasks', id, { status: 'done' }), /Nothing editable/);
});

test('removeRow() deletes a row; protected views refuse', async () => {
  await say('note throwaway');
  const note = data.rows(uid, 'notes').rows[0];
  assert.equal(data.removeRow(uid, 'notes', note.id), true);
  assert.equal(data.rows(uid, 'notes').rows.find((r) => r.id === note.id), undefined);
  assert.throws(() => data.removeRow(uid, 'account', uid), /deleted/i);
});

test('unknown / hidden views are rejected', () => {
  assert.throws(() => data.rows(uid, 'app_settings'), /unknown data view/);
  assert.throws(() => data.rows(uid, 'nope'), /unknown data view/);
});
