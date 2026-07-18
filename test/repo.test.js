// repo.js data-layer invariants around the full-account erase/export — the angles deletion.test.js (which
// drives the CHAT flow as root) can't see: multi-tenancy (erasing one user must not touch a neighbor),
// the notebook sweep, the per-user app_settings keys, and the USER_TABLES completeness guard the schema
// comment promises ("a table added to db.js with a user_id column belongs here too").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-repo-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate, db } = await import('../server/db.js');
const {
  defaultUserId, getOrCreateTelegramUser, userExists, getUser,
  insertTask, insertNote, insertMessage, insertWakeup, listTasks, listNotes,
  createNotebook, getNotebook, listNotebooks,
  deleteAllUserData, collectUserData, USER_TABLES,
} = await import('../server/repo.js');
const { setUserFeatures } = await import('../server/settings.js');

migrate();
const root = defaultUserId();

test('USER_TABLES is complete: every table with a user_id column is on the erase/export list', () => {
  // The deletion purge and the retention export both iterate USER_TABLES. A table added to db.js but
  // forgotten here would silently survive /requestdeletion AND be missing from the compliance zip — the
  // two failure modes this feature exists to prevent. Introspect the live schema so the list can't drift.
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all().map((r) => r.name);
  const withUserId = tables.filter((t) =>
    db.prepare('SELECT name FROM pragma_table_info(?)').all(t).some((c) => c.name === 'user_id'));
  // Exact set equality, both directions: a stale USER_TABLES entry (renamed/dropped table) would make
  // collectUserData throw mid-export, which is just as bad as a missing one.
  assert.deepEqual(withUserId.sort(), [...USER_TABLES].sort());
});

test('deleteAllUserData erases ONE tenant: the neighbor’s data and the identity row both survive', () => {
  const alice = getOrCreateTelegramUser(111001, 'alice');
  const bob = getOrCreateTelegramUser(111002, 'bob');
  insertTask({ userId: alice, summary: 'alice task one' });
  insertTask({ userId: alice, summary: 'alice task two' });
  insertNote({ userId: alice, text: 'alice note' });
  insertMessage({ userId: alice, channel: 'telegram', text: 'hi from alice' });
  insertWakeup(alice, 'psst alice');
  insertTask({ userId: bob, summary: 'bob task' });
  insertNote({ userId: bob, text: 'bob note' });

  const counts = deleteAllUserData(alice);

  // Alice: every table empty, but the account row is KEPT so her next message resolves to an empty slate.
  for (const t of USER_TABLES) {
    const n = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id=?`).get(alice).n);
    assert.equal(n, 0, `${t} should be empty for alice`);
  }
  assert.ok(userExists(alice), 'the identity row survives the wipe');
  assert.equal(counts.tasks, 2, 'per-table counts report what was removed');
  assert.equal(counts.notes, 1);

  // Bob: completely untouched. This is the tenancy line the whole repo layer exists to hold.
  assert.equal(listTasks(bob).length, 1);
  assert.equal(listNotes(bob).length, 1);
});

test('deleteAllUserData sweeps the user’s notebooks: their rows AND the sub-user rows themselves', () => {
  const carol = getOrCreateTelegramUser(111003, 'carol');
  const nb = createNotebook(carol, 'journal').notebook;
  insertTask({ userId: carol, summary: 'carol main task' });
  insertTask({ userId: nb.id, summary: 'journal task' });
  insertMessage({ userId: nb.id, channel: 'telegram', text: 'inside the journal' });

  const counts = deleteAllUserData(carol);

  // The notebook is a private SPACE, not an account: its data is wiped with the parent's, and unlike the
  // parent its users row is deleted too — leaving it behind would orphan a reachable-by-nobody sub-user.
  assert.equal(getNotebook(nb.id), null, 'the notebook row is gone');
  assert.equal(listNotebooks(carol).length, 0);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE user_id=?').get(nb.id).n), 0);
  assert.equal(counts.tasks, 2, 'counts aggregate parent + notebook rows');
  assert.ok(userExists(carol), 'the parent identity row is still kept');
});

test('deleteAllUserData clears the per-user app_settings keys, and only that user’s', () => {
  const dave = getOrCreateTelegramUser(111004, 'dave');
  // Features are one of the per-user keys parked in the otherwise-global app_settings store — a wipe that
  // missed them would leave a trace of the account (and its opt-ins) behind.
  setUserFeatures(dave, { notes: true });
  setUserFeatures(root, { notes: true });
  const keyCount = (uid) => Number(db.prepare("SELECT COUNT(*) AS n FROM app_settings WHERE key = ?").get(`features:${uid}`).n);
  assert.equal(keyCount(dave), 1, 'precondition: dave has a features blob');

  deleteAllUserData(dave);

  assert.equal(keyCount(dave), 0, 'dave’s per-user settings key is wiped');
  assert.equal(keyCount(root), 1, 'root’s settings are untouched');
});

test('collectUserData snapshots the identity row, every table, and each notebook’s tables', () => {
  const erin = getOrCreateTelegramUser(111005, 'erin');
  insertTask({ userId: erin, summary: 'erin task' });
  const nb = createNotebook(erin, 'side project').notebook;
  insertNote({ userId: nb.id, text: 'notebook-only note' });

  const data = collectUserData(erin);

  assert.equal(Number(data.user.id), erin, 'the identity row rides along');
  assert.deepEqual(Object.keys(data.tables).sort(), [...USER_TABLES].sort(), 'one entry per USER_TABLE');
  assert.ok(data.tables.tasks.some((r) => r.summary === 'erin task'));
  assert.equal(data.notebooks.length, 1);
  assert.equal(data.notebooks[0].notebook.notebook_name, 'side project');
  assert.ok(data.notebooks[0].tables.notes.some((r) => r.text === 'notebook-only note'),
    'the notebook’s own rows are captured under its snapshot');
  // Read-only: snapshotting must not disturb the data it reads.
  assert.equal(listTasks(erin).length, 1);
});
