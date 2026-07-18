// The migration chain is the one code path every self-hosted deployment runs unattended — a bad step
// ships a broken DB to people we can't reach. Two guards: (1) a fresh walk lands on the exact version,
// clean and idempotent; (2) rows seeded at v1 SURVIVE the whole chain — the table-rebuild migrations
// (CREATE new → INSERT/SELECT copy → DROP → RENAME, e.g. tasks v11, messages v21) are where a botched
// column list would silently drop or mangle user data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(join(tmpdir(), 'fanad-migrations-'));
process.env.DATA_DIR = dir;
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate, db, MIGRATIONS } = await import('../server/db.js');

test('a fresh walk reaches the tip, passes integrity/FK checks, and re-running is a no-op', () => {
  const v = migrate();
  assert.equal(v, MIGRATIONS.length);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(migrate(), MIGRATIONS.length); // idempotent: nothing to do, nothing thrown
});

test('rows written under the v1 schema survive every later migration, including table rebuilds', () => {
  // A scratch DB, NOT the module connection: we drive MIGRATIONS by hand to seed between steps.
  const raw = new DatabaseSync(join(dir, 'walk.db'));
  raw.exec('PRAGMA foreign_keys = OFF'); // mirrors migrate(): rebuilds DROP/RENAME under FK off
  raw.exec('BEGIN');
  MIGRATIONS[0](raw);
  raw.exec('PRAGMA user_version = 1');
  raw.exec('COMMIT');

  // Realistic v1-shaped rows with distinctive values (user id=1 is seeded by the migration itself).
  raw.prepare("INSERT INTO messages (user_id, channel, text, received_at) VALUES (1, 'web', 'hello from v1', 111)").run();
  raw.prepare("INSERT INTO tasks (user_id, summary, category, effort_level, status, created_at) VALUES (1, 'file the taxes', 'other', 'low', 'available', 222)").run();
  raw.prepare("INSERT INTO state_snapshots (user_id, captured_at, mood_emojis) VALUES (1, 333, '🙂')").run();

  for (let v = 1; v < MIGRATIONS.length; v++) {
    raw.exec('BEGIN');
    MIGRATIONS[v](raw);
    raw.exec(`PRAGMA user_version = ${v + 1}`);
    raw.exec('COMMIT');
    // Check after EVERY step so a failure names the culprit migration, not just "the walk broke".
    assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), [],
      `foreign_key_check found dangling references after migration v${v} -> v${v + 1}`);
  }
  raw.exec('PRAGMA foreign_keys = ON');

  assert.equal(raw.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  const msg = raw.prepare('SELECT * FROM messages WHERE user_id = 1').all();
  assert.equal(msg.length, 1);
  assert.equal(msg[0].text, 'hello from v1');
  assert.equal(msg[0].received_at, 111);
  const task = raw.prepare('SELECT * FROM tasks WHERE user_id = 1').all();
  assert.equal(task.length, 1);
  assert.equal(task[0].summary, 'file the taxes');
  assert.equal(task[0].created_at, 222);
  // Status labels may be renamed by a rebuild; what matters is the row kept A status the tip schema allows.
  assert.ok(task[0].status, 'task status was lost in a rebuild');
  const snap = raw.prepare('SELECT * FROM state_snapshots WHERE user_id = 1').all();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].mood_emojis, '🙂');
  raw.close();
});

test('v29 -> v30 backfills note from entry_label — the retired macro fan-out left those rows noteless', () => {
  const raw = new DatabaseSync(join(dir, 'backfill.db'));
  raw.exec('PRAGMA foreign_keys = OFF');
  const apply = (from, to) => {
    for (let v = from; v < to; v++) {
      raw.exec('BEGIN');
      MIGRATIONS[v](raw);
      raw.exec(`PRAGMA user_version = ${v + 1}`);
      raw.exec('COMMIT');
    }
  };
  apply(0, 29); // stop just short of the backfill, then seed rows the old fan-out would have written
  const mid = raw.prepare(
    "INSERT INTO metrics (user_id, name, aggregation, created_at) VALUES (1, 'protein', 'sum', 1)",
  ).run().lastInsertRowid;
  const ins = raw.prepare(
    'INSERT INTO metric_values (user_id, metric_id, value, note, entry_label, recorded_at) VALUES (1, ?, ?, ?, ?, 1)',
  );
  const noteless = ins.run(mid, 12, null, 'greek salad').lastInsertRowid;
  const blank = ins.run(mid, 30, '', 'olives').lastInsertRowid;
  const kept = ins.run(mid, 9, 'already noted', 'olives').lastInsertRowid;
  const bare = ins.run(mid, 5, null, null).lastInsertRowid;
  apply(29, MIGRATIONS.length);

  const note = (id) => raw.prepare('SELECT note FROM metric_values WHERE id = ?').get(id).note;
  assert.equal(note(noteless), 'greek salad', 'NULL note takes the label');
  assert.equal(note(blank), 'olives', 'empty note takes the label');
  assert.equal(note(kept), 'already noted', 'an existing note is never overwritten');
  assert.equal(note(bare), null, 'no label, nothing to backfill');
  raw.close();
});
