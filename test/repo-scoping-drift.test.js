// Tenancy in repo.js is a convention — every query scopes by user_id — with nothing at runtime to
// enforce it. This drift test IS the enforcement: it reads repo.js's source, pulls every db.prepare()
// statement that touches a USER_TABLES table, and fails if one doesn't mention user_id, unless it's on
// the exemption list below with a reason. Adding unscoped SQL should be a conscious, reviewed act.
// (Same idea as the USER_TABLES completeness guard in repo.test.js, one layer up.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-scope-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { USER_TABLES } = await import('../server/repo.js');

// Known-legit unscoped statements. Match is on whitespace-normalized SQL substring. Every entry needs a
// WHY — "it was easier" is not one.
const EXEMPT = [
  // Scheduler stamps: the row id comes straight out of an allDue* sweep (which joins users for delivery
  // routing), inside the same tick — there is no user in scope to re-check against.
  { sql: 'UPDATE tasks SET reminded_at=? WHERE id=?', why: 'fireDueReminders stamps rows its own all-user sweep returned' },
  { sql: 'UPDATE timers SET fired_at = ? WHERE id = ?', why: 'fireDueTimers stamps rows its own all-user sweep returned' },
  // Dynamic WHERE built in JS, but conds[0] is hard-coded to 'user_id = ?' in all three builders
  // (listMessagesBefore/After, clearMessages) — the scope is there, just invisible to this text scan.
  { sql: "WHERE ${conds.join(' AND ')} ORDER BY id DESC", why: 'listMessagesBefore: conds[0] is user_id = ?' },
  { sql: "WHERE ${conds.join(' AND ')} ORDER BY id ASC", why: 'listMessagesAfter: conds[0] is user_id = ?' },
  { sql: 'DELETE FROM messages WHERE ${where}', why: 'clearMessages: where starts with user_id = ?' },
  // Stamps the row ingest.js inserted seconds earlier in the same pipeline; the id is insertMessage's
  // own return value, never user input.
  { sql: 'UPDATE messages SET processed_at = ? WHERE id = ?', why: 'markMessageProcessed: pipeline-owned id' },
  // Documented as global ON PURPOSE: categories are shared definitions, so retiring one must move every
  // user's rows off the dead key (see the reassignTaskCategory comment).
  { sql: 'UPDATE tasks SET category = ? WHERE category = ?', why: 'reassignTaskCategory: category retire is cross-user by design' },
  // The one-shot startup link-preview backfill (linkBackfill.js) sweeps EVERY user's URL-bearing tasks;
  // each row it returns carries user_id, which the caller passes straight to the scoped setTaskLink — the
  // same all-user-sweep-then-scoped-write shape as the scheduler stamps above.
  { sql: 'SELECT * FROM tasks WHERE link_json IS NULL', why: 'listTasksNeedingLinkBackfill: startup sweep; writes go through scoped setTaskLink' },
];

const src = readFileSync(new URL('../server/repo.js', import.meta.url), 'utf8');
const norm = (s) => s.replace(/\s+/g, ' ').trim();

// Every SQL literal handed to db.prepare(...) — plain strings and template literals alike. A `${...}`
// interpolation (the USER_TABLES loops) survives as text; its table name simply won't parse below.
function preparedStatements(source) {
  const out = [];
  const re = /db\.prepare\(\s*(['"`])([\s\S]*?)\1/g;
  for (let m; (m = re.exec(source)); ) out.push(norm(m[2]));
  return out;
}

function tablesTouched(sql) {
  const names = new Set();
  const re = /\b(?:FROM|JOIN|UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  for (let m; (m = re.exec(sql)); ) names.add(m[1].toLowerCase());
  return names;
}

test('every repo.js statement touching a user table mentions user_id (or is consciously exempted)', () => {
  const stmts = preparedStatements(src);
  assert.ok(stmts.length > 50, `suspiciously few statements parsed (${stmts.length}) — did the extraction regex rot?`);
  const violations = stmts.filter((sql) => {
    if (/\buser_id\b/i.test(sql)) return false;
    const touched = tablesTouched(sql);
    if (![...touched].some((t) => USER_TABLES.includes(t))) return false;
    return !EXEMPT.some((e) => sql.includes(norm(e.sql)));
  });
  assert.deepEqual(violations, [],
    'unscoped SQL on a user table — add `WHERE user_id = ?` or, if genuinely cross-user, an EXEMPT entry with a reason');
});

test('the exemption list is live: every entry still matches a statement in repo.js', () => {
  // A stale exemption is camouflage — it looks like a guarded hole but guards nothing.
  const stmts = preparedStatements(src);
  for (const e of EXEMPT) {
    assert.ok(stmts.some((sql) => sql.includes(norm(e.sql))), `stale EXEMPT entry (statement gone from repo.js): ${e.sql}`);
  }
});
