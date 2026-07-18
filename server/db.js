// Native built-in SQLite (DatabaseSync) — NOT better-sqlite3, no C++ addon.
// node:sqlite ships unflagged in Node 24+ (and behind --experimental-sqlite in 22.5–23).
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { config } from './config.js';

export const db = new DatabaseSync(join(config.dataDir, 'fanad.db'));

// One shared synchronous connection for the whole process. Tuned for a local pilot.
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

// Run `fn` inside one transaction: COMMIT on return, ROLLBACK on throw. For the multi-statement writes
// that must land together (repo.js). Plain BEGIN doesn't nest — a caller already inside a transaction
// (migrate, deleteAllUserData, …) must not call this.
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Ordered migrations. Each entry advances PRAGMA user_version by one. Timestamps are epoch-ms
// integers everywhere (decision #11). Exported for migrations.test.js, which replays
// the chain step-by-step against a scratch DB — never call these outside migrate().
export const MIGRATIONS = [
  // v0 -> v1: core prototype schema (users, messages, state_snapshots, tasks).
  (d) => {
    d.exec(`
      CREATE TABLE users (
        id           INTEGER PRIMARY KEY,
        email        TEXT,
        created_at   INTEGER NOT NULL,
        last_seen_at INTEGER
      );

      CREATE TABLE messages (
        id           INTEGER PRIMARY KEY,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        channel      TEXT NOT NULL DEFAULT 'web' CHECK (channel IN ('web','telegram')),
        text         TEXT NOT NULL,
        raw_json     TEXT,
        received_at  INTEGER NOT NULL,
        processed_at INTEGER
      );
      CREATE INDEX idx_messages_user ON messages(user_id, received_at);

      CREATE TABLE state_snapshots (
        id            INTEGER PRIMARY KEY,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message_id    INTEGER REFERENCES messages(id),
        captured_at   INTEGER NOT NULL,
        time_of_day   TEXT,
        mood_emojis   TEXT,          -- emoji sequence parsed from the message (§3 / generic mood)
        location_text TEXT,
        weather_json  TEXT
      );
      CREATE INDEX idx_snapshots_user ON state_snapshots(user_id, captured_at);

      CREATE TABLE tasks (
        id                INTEGER PRIMARY KEY,
        user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        summary           TEXT NOT NULL,
        category          TEXT NOT NULL DEFAULT 'other',
        effort_level      TEXT NOT NULL DEFAULT 'medium' CHECK (effort_level IN ('trivial','low','medium','high')),
        status            TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','in_progress','done','snoozed','archived')),
        source_message_id INTEGER REFERENCES messages(id),
        created_at        INTEGER NOT NULL,
        started_at        INTEGER,
        completed_at      INTEGER
      );
      CREATE INDEX idx_tasks_user_status ON tasks(user_id, status);
    `);
    // Seed the single local user for the prototype (real multi-user auth arrives in Phase 8).
    d.prepare('INSERT INTO users (id, email, created_at) VALUES (1, NULL, ?)').run(Date.now());
  },

  // v1 -> v2: rewards, redemptions, and embeddings (the §4 RAG suggestion engine).
  (d) => {
    d.exec(`
      CREATE TABLE rewards (
        id           INTEGER PRIMARY KEY,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label        TEXT NOT NULL,
        effort_level TEXT NOT NULL DEFAULT 'low' CHECK (effort_level IN ('trivial','low','medium','high')),
        enabled      INTEGER NOT NULL DEFAULT 1,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX idx_rewards_user ON rewards(user_id, enabled);

      CREATE TABLE reward_redemptions (
        id            INTEGER PRIMARY KEY,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reward_id     INTEGER REFERENCES rewards(id),
        task_id       INTEGER REFERENCES tasks(id),
        is_own_reward INTEGER NOT NULL DEFAULT 0,
        redeemed_at   INTEGER NOT NULL
      );
      CREATE INDEX idx_redemptions_user ON reward_redemptions(user_id, redeemed_at);

      CREATE TABLE embeddings (
        id         INTEGER PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        owner_type TEXT NOT NULL,                 -- 'task' | 'reward'
        owner_id   INTEGER NOT NULL,
        vector     BLOB NOT NULL,
        dim        INTEGER NOT NULL,
        model      TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE (user_id, owner_type, owner_id)
      );
    `);
  },

  // v2 -> v3: app-level settings (LM Studio config, etc.) editable from the UI — no .env required.
  (d) => {
    d.exec(`
      CREATE TABLE app_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT,
        updated_at INTEGER
      );
    `);
  },

  // v3 -> v4: notes — a "self-voicemail" inbox. Capture now; review / promote-to-task later (§15).
  (d) => {
    d.exec(`
      CREATE TABLE notes (
        id                INTEGER PRIMARY KEY,
        user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        text              TEXT NOT NULL,
        title             TEXT,
        tags_json         TEXT,
        status            TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewed','archived')),
        reviewed_at       INTEGER,
        promoted_task_id  INTEGER REFERENCES tasks(id),
        source_message_id INTEGER REFERENCES messages(id),
        snapshot_id       INTEGER REFERENCES state_snapshots(id),
        created_at        INTEGER NOT NULL
      );
      CREATE INDEX idx_notes_user_status ON notes(user_id, status, created_at);
    `);
  },

  // v4 -> v5: user-defined metrics + their datapoints (incl. the diet preset). §13.
  (d) => {
    d.exec(`
      CREATE TABLE metrics (
        id          INTEGER PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        unit        TEXT,
        aggregation TEXT NOT NULL DEFAULT 'sum' CHECK (aggregation IN ('sum','avg','last','max','min')),
        target      REAL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL,
        UNIQUE (user_id, name)
      );

      CREATE TABLE metric_values (
        id          INTEGER PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        metric_id   INTEGER NOT NULL REFERENCES metrics(id) ON DELETE CASCADE,
        value       REAL NOT NULL,
        note        TEXT,
        entry_label TEXT,           -- groups one log that fans out to several metrics (a food's macros)
        recorded_at INTEGER NOT NULL
      );
      CREATE INDEX idx_metric_values ON metric_values(user_id, metric_id, recorded_at);
    `);
  },

  // v5 -> v6: task hygiene / refusal grooming (§11) + point metrics (§13). Timestamps are epoch-ms
  // INTEGER (decision #11), deviating from §11's literal TEXT ISO8601 to match the rest of the schema.
  (d) => {
    d.exec(`
      ALTER TABLE tasks ADD COLUMN refusal_count     INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN last_suggested_at INTEGER;   -- epoch-ms, NULL = never surfaced
      ALTER TABLE tasks ADD COLUMN snoozed_until      INTEGER;  -- epoch-ms, NULL = not snoozed
      ALTER TABLE tasks ADD COLUMN last_groomed_at    INTEGER;  -- epoch-ms, drives grooming cooldown

      -- A point/gauge metric (e.g. blood pressure) records a reading we don't sum; tally shows the last.
      ALTER TABLE metrics ADD COLUMN measurement_type TEXT NOT NULL DEFAULT 'tallied'
        CHECK (measurement_type IN ('tallied','point'));

      -- Every surfaced suggestion + its outcome — the ledger that makes /whatdo stop repeating (§11).
      CREATE TABLE suggestion_events (
        id          INTEGER PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        task_id     INTEGER NOT NULL REFERENCES tasks(id),
        surfaced_at INTEGER NOT NULL,
        channel     TEXT NOT NULL,
        source      TEXT NOT NULL,                 -- 'chat' | 'smaller' | 'wakeup' | ...
        outcome     TEXT,                          -- NULL until resolved: 'accepted'|'refused'|'snoozed'|'done'
        resolved_at INTEGER,
        ctx_hour    INTEGER,
        ctx_dow     INTEGER,
        ctx_mood    TEXT,
        ctx_energy  TEXT,
        ctx_snapshot_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_sugg_user_task     ON suggestion_events(user_id, task_id);
      CREATE INDEX idx_sugg_user_outcome  ON suggestion_events(user_id, outcome);
      CREATE INDEX idx_sugg_user_surfaced ON suggestion_events(user_id, surfaced_at);
    `);
  },

  // v6 -> v7: scheduled wake-up check-ins (§10) + a small queue the web polls to show them.
  (d) => {
    d.exec(`
      CREATE TABLE schedules (
        id            INTEGER PRIMARY KEY,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        minute_of_day INTEGER NOT NULL,            -- 0..1439, local time
        enabled       INTEGER NOT NULL DEFAULT 1,
        last_fired_day INTEGER,                     -- epoch-day, dedupes one fire per day
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX idx_schedules_user ON schedules(user_id, enabled);

      CREATE TABLE wakeups (
        id         INTEGER PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        text       TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        seen_at    INTEGER                          -- NULL until the web has shown it
      );
      CREATE INDEX idx_wakeups_unseen ON wakeups(user_id, seen_at);
    `);
  },

  // v7 -> v8: stamp each task with WHEN (and in what weather) it was created, so a task added by day
  // is preferred by day, near its usual hour, in similar weather (§3/§11).
  (d) => {
    d.exec(`
      ALTER TABLE tasks ADD COLUMN created_hour    INTEGER;  -- 0..23, local hour at creation
      ALTER TABLE tasks ADD COLUMN created_tod      TEXT;     -- time-of-day label at creation
      ALTER TABLE tasks ADD COLUMN created_weather  TEXT;     -- weather label at creation (nullable)
    `);
  },

  // v8 -> v9: the learning ledger — every meaningful task outcome with its context + how it felt.
  // Feeds a per-(category × context) affinity so Fanad learns what you actually do, when, and likes.
  (d) => {
    d.exec(`
      CREATE TABLE task_outcomes (
        id          INTEGER PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        task_id     INTEGER,                       -- nullable: the task may later be deleted
        category    TEXT NOT NULL,
        outcome     TEXT NOT NULL,                 -- 'done' | 'refused' | 'snoozed' | 'dropped'
        sentiment   TEXT,                          -- 'highfive' | 'relief' | 'neutral' (done only)
        ctx_phase   TEXT,                          -- 'day' | 'evening' | 'night'
        ctx_hour    INTEGER, ctx_dow INTEGER,
        ctx_weather TEXT, ctx_mood TEXT, ctx_energy TEXT,
        at          INTEGER NOT NULL
      );
      CREATE INDEX idx_outcomes_user_cat ON task_outcomes(user_id, category, ctx_phase);
    `);
  },

  // v9 -> v10: real per-user separation (root = the local/PC user; each Telegram account is its own
  // user) + a per-user behavior dossier Fanad grows over time. All data is already user_id-scoped.
  (d) => {
    d.exec(`
      ALTER TABLE users ADD COLUMN telegram_id  INTEGER;
      ALTER TABLE users ADD COLUMN display_name TEXT;
      CREATE UNIQUE INDEX idx_users_telegram ON users(telegram_id) WHERE telegram_id IS NOT NULL;

      CREATE TABLE user_profile (
        user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        data_json  TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL
      );
    `);
    d.prepare("UPDATE users SET display_name='root' WHERE id=1").run();
  },

  // v10 -> v11: deadlines (§ advanced /task). Add due_at/due_kind/expired_at and a new terminal status
  // 'expired' — a non-judgy "this passed its time" state, distinct from done/archived. SQLite can't ALTER
  // a CHECK constraint, so the tasks table is rebuilt (FK enforcement is toggled off around migrate()).
  (d) => {
    d.exec(`
      CREATE TABLE tasks_new (
        id                INTEGER PRIMARY KEY,
        user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        summary           TEXT NOT NULL,
        category          TEXT NOT NULL DEFAULT 'other',
        effort_level      TEXT NOT NULL DEFAULT 'medium' CHECK (effort_level IN ('trivial','low','medium','high')),
        status            TEXT NOT NULL DEFAULT 'available'
                            CHECK (status IN ('available','in_progress','done','snoozed','archived','expired')),
        source_message_id INTEGER REFERENCES messages(id),
        created_at        INTEGER NOT NULL,
        started_at        INTEGER,
        completed_at      INTEGER,
        refusal_count     INTEGER NOT NULL DEFAULT 0,
        last_suggested_at INTEGER,
        snoozed_until     INTEGER,
        last_groomed_at   INTEGER,
        created_hour      INTEGER,
        created_tod       TEXT,
        created_weather   TEXT,
        due_at            INTEGER,   -- epoch-ms deadline (NULL = no deadline)
        due_kind          TEXT,      -- how it was expressed: 'today' | 'by' | NULL (drives phrasing)
        expired_at        INTEGER    -- epoch-ms when retired as expired (NULL = still live)
      );
      INSERT INTO tasks_new
        (id, user_id, summary, category, effort_level, status, source_message_id, created_at, started_at,
         completed_at, refusal_count, last_suggested_at, snoozed_until, last_groomed_at, created_hour,
         created_tod, created_weather)
        SELECT id, user_id, summary, category, effort_level, status, source_message_id, created_at, started_at,
               completed_at, refusal_count, last_suggested_at, snoozed_until, last_groomed_at, created_hour,
               created_tod, created_weather
          FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;
      CREATE INDEX idx_tasks_user_status ON tasks(user_id, status);
      CREATE INDEX idx_tasks_due ON tasks(user_id, due_at) WHERE due_at IS NOT NULL;
    `);
  },

  // v11 -> v12: persist the BOT side of the conversation too. Until now `messages` held only inbound
  // user turns (insertMessage was called once per incoming message); assistant replies lived only in the
  // HTTP response. Storing them lets the web UI replay a faithful two-sided transcript on scroll-back.
  // Existing rows are all user turns → default 'user'. The (user_id, id) index backs the keyset
  // "messages before <id>" page query (id is the monotonic rowid; received_at isn't unique).
  (d) => {
    d.exec(`
      ALTER TABLE messages ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','bot'));
      CREATE INDEX idx_messages_user_id ON messages(user_id, id);
    `);
  },

  // v12 -> v13: per-user images, each attached to a task OR a note (a captioned photo files a task; a bare
  // photo is parked in the notes inbox — see ingest.js). The BYTES live on disk under
  // config.dataDir/images/<userId>/<uuid>.<ext> (plaintext, same volume as fanad.db) — this row is metadata
  // only, so SELECT * on tasks/notes never drags image bytes through the suggestion/inbox hot paths. Both
  // owner FKs are nullable (an image may arrive before its owner) and cascade when that owner is deleted.
  (d) => {
    d.exec(`
      CREATE TABLE images (
        id         INTEGER PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        task_id    INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
        note_id    INTEGER REFERENCES notes(id) ON DELETE CASCADE,
        uuid       TEXT NOT NULL,
        mime       TEXT NOT NULL,
        byte_size  INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (user_id, uuid)
      );
      CREATE INDEX idx_images_user_task ON images(user_id, task_id) WHERE task_id IS NOT NULL;
      CREATE INDEX idx_images_user_note ON images(user_id, note_id) WHERE note_id IS NOT NULL;
    `);
  },

  // v13 -> v14: richer task capture (chat.js /task + ingest). The decision flips from "store only the
  // user's exact words" to "trap MORE, not less" — the local LLM is slow/expensive and we don't yet know
  // what we'll need, so we keep three layers of text: original_text (verbatim input, untouched),
  // summary (the short list label, LLM-trimmed to the actionable core), llm_summary (a fuller one-paragraph
  // read for when the task is opened/started later). Plus manual priority (3=high·2=med·1=low; NULL=unset)
  // and a one-time per-task reminder: remind_at (epoch-ms; the scheduler fires it once) / reminded_at
  // (stamped when fired, so it never re-fires). All plain ADD COLUMN (no CHECK change) → no table rebuild.
  (d) => {
    d.exec(`
      ALTER TABLE tasks ADD COLUMN original_text TEXT;     -- verbatim user input (NULL for pre-v14 rows)
      ALTER TABLE tasks ADD COLUMN llm_summary   TEXT;     -- fuller one-paragraph LLM read
      ALTER TABLE tasks ADD COLUMN priority      INTEGER;  -- 3=high · 2=medium · 1=low · NULL=unset
      ALTER TABLE tasks ADD COLUMN remind_at      INTEGER;  -- epoch-ms one-time reminder (NULL = none)
      ALTER TABLE tasks ADD COLUMN reminded_at    INTEGER;  -- epoch-ms the reminder fired (NULL = pending)
      CREATE INDEX idx_tasks_remind ON tasks(remind_at) WHERE remind_at IS NOT NULL;
    `);
  },

  // v14 -> v15: anti-overwhelm auto-sleep. A task that's been sitting untouched (available, never started,
  // no live deadline, not high-priority) for too long quietly goes to "sleep": it drops out of every
  // listing until the user revives it — distinct from snoozed (timed) / archived (dropped) / expired
  // (deadline passed). Implemented as a timestamp, not a new status, so no CHECK-constraint table rebuild:
  // the row stays 'available' but slept_at marks it dormant, and openTasks() filters it out.
  (d) => {
    d.exec(`
      ALTER TABLE tasks ADD COLUMN slept_at INTEGER;  -- epoch-ms it auto-slept (NULL = awake)
      CREATE INDEX idx_tasks_slept ON tasks(user_id, slept_at);
    `);
  },

  // v15 -> v16: per-task STEPS — an ordered, hand-written checklist under a task (the "step"/"done N"
  // flow). A JSON array of { text, done, completed_at } on the task itself: steps load with their parent,
  // order by array position (= add order), are tiny, and are never queried across tasks — so a column
  // avoids a join and keeps tenancy automatic. NULL/empty = no steps. Plain ADD COLUMN → no table rebuild.
  (d) => {
    d.exec(`
      ALTER TABLE tasks ADD COLUMN steps_json TEXT;  -- JSON [{text,done,completed_at}] (NULL = no steps)
    `);
  },

  // v16 -> v17: TASK TEMPLATES — a saved blueprint of a task (its shape + step checklist) you re-create on
  // demand, by name. Fanad has no recurring tasks on purpose; a template is the calm alternative — you pull
  // a fresh, undated copy when YOU choose. Steps ride along reset (unchecked) as JSON; deadlines, reminders,
  // and priority are deliberately NOT stored (those are the pressure templates exist to avoid). It's its own
  // table, not a tasks flag: a template isn't on any list and is keyed by a user-chosen, case-insensitive
  // name (so re-saving "Groceries" overwrites "groceries").
  (d) => {
    d.exec(`
      CREATE TABLE task_templates (
        id            INTEGER PRIMARY KEY,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name          TEXT NOT NULL COLLATE NOCASE,  -- user-facing handle; matched/uniqued case-insensitively
        summary       TEXT NOT NULL,
        category      TEXT NOT NULL DEFAULT 'other',
        effort_level  TEXT NOT NULL DEFAULT 'medium',
        original_text TEXT,
        llm_summary   TEXT,
        steps_json    TEXT,                           -- JSON [{text,done:false,completed_at:null}] (NULL = none)
        created_at    INTEGER NOT NULL,
        UNIQUE(user_id, name)
      );
      CREATE INDEX idx_templates_user ON task_templates(user_id);
    `);
  },

  // v17 -> v18: images go "Telegram-only". We no longer download/persist photo BYTES — Telegram already
  // hosts the file indefinitely, so we keep just its reusable `file_id` and re-send by reference
  // (Bot API sendPhoto accepts a file_id string — no getFile, no re-upload, no disk). Drops uuid/mime/
  // byte_size (and the old UNIQUE(user_id,uuid)). Old rows only ever held on-disk bytes + a uuid, never a
  // file_id, so they can't be recalled under the new model — the table is rebuilt EMPTY. Any orphaned bytes
  // under config.dataDir/images/ are now dead and can be deleted by hand. The task_id/note_id association
  // (both nullable, cascading) is unchanged.
  (d) => {
    d.exec(`
      DROP TABLE IF EXISTS images;
      CREATE TABLE images (
        id         INTEGER PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        task_id    INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
        note_id    INTEGER REFERENCES notes(id) ON DELETE CASCADE,
        file_id    TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_images_user_task ON images(user_id, task_id) WHERE task_id IS NOT NULL;
      CREATE INDEX idx_images_user_note ON images(user_id, note_id) WHERE note_id IS NOT NULL;
    `);
  },

  // v18 -> v19: VOUCHES — access by personal endorsement. Any already-authorized user can run
  // "vouch @username" to whitelist someone, and we keep a record of WHO vouched WHOM so the access list can
  // grow socially yet stay accountable ("in case we have a problem"). Keyed by the vouched @username — the
  // same handle the Telegram allowlist matches on — one ACTIVE row each. Revoke is a soft-delete (revoked_at
  // stamped, row kept) so the provenance survives. The voucher is pinned by BOTH a stable numeric id and a
  // username snapshot; the snapshot is the parent→child edge the admin UI's cascade-revoke walks. This is
  // GLOBAL access control (like app_settings), NOT per-user data — deliberately NO `user_id` column, so a
  // /requestdeletion erase never sweeps it and it stays off the USER_TABLES list.
  (d) => {
    d.exec(`
      CREATE TABLE vouches (
        id                  INTEGER PRIMARY KEY,
        username            TEXT NOT NULL,                 -- vouched-in @username, lowercased, no '@' (the whitelist key)
        voucher_user_id     INTEGER REFERENCES users(id), -- who vouched (always a real user — they had to be authorized first)
        voucher_username    TEXT,                          -- snapshot of the voucher's @username (the cascade-revoke parent edge)
        voucher_telegram_id INTEGER,                       -- voucher's numeric id (stable even if they change @username)
        created_at          INTEGER NOT NULL,
        revoked_at          INTEGER,                       -- NULL = active; set on revoke (the row is KEPT for the record)
        revoked_by_user_id  INTEGER REFERENCES users(id),  -- who revoked it (NULL until revoked)
        UNIQUE (username)
      );
      CREATE INDEX idx_vouches_voucher ON vouches(voucher_username) WHERE revoked_at IS NULL;
    `);
  },

  // v19 -> v20: LISTS — a nestable outliner, separate from tasks and notes. One self-referential tree per
  // user: a row is a "list item" whose children are its sub-items, and any item can itself hold sub-items to
  // unlimited depth (a grocery list → "produce" → "apples"…). `parent_id IS NULL` marks a top-level list;
  // ON DELETE CASCADE on the self-FK means deleting an item drops its whole subtree in one go. `position`
  // orders siblings (ascending, gaps allowed — listings renumber 1..N for display); created_at breaks ties.
  // Distinct from a task's `steps_json` checklist (flat, lives on the task) — lists are their own first-class
  // tree the user navigates into and out of. Registered in repo's USER_TABLES so /requestdeletion sweeps it.
  (d) => {
    d.exec(`
      CREATE TABLE list_items (
        id         INTEGER PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        parent_id  INTEGER REFERENCES list_items(id) ON DELETE CASCADE,  -- NULL = a top-level list
        title      TEXT NOT NULL,
        position   INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_list_items_user_parent ON list_items(user_id, parent_id, position, id);
    `);
  },

  // v20 -> v21: SLACK identity. Mirrors v9->v10's `telegram_id`: each Slack account is its own user (its
  // own tasks/history/dossier), keyed by Slack's immutable workspace id (Uxxxx/Wxxxx — TEXT, not numeric).
  // Partial unique index so the many rows without a Slack id (root, Telegram-only users) don't collide on NULL.
  (d) => {
    d.exec(`
      ALTER TABLE users ADD COLUMN slack_id TEXT;
      CREATE UNIQUE INDEX idx_users_slack ON users(slack_id) WHERE slack_id IS NOT NULL;
    `);
  },

  // v21 -> v22: let `messages.channel` carry 'slack' too. The v0 CHECK is ('web','telegram'); SQLite can't
  // ALTER a CHECK, so rebuild the table (same copy/swap idiom as the v10->v11 tasks rebuild; FK enforcement
  // is already OFF around migrate(), so DROP won't cascade and the preserved ids keep state_snapshots/tasks/
  // notes back-links valid). Carries the v12 `role` column + its CHECK and recreates both message indexes.
  (d) => {
    d.exec(`
      CREATE TABLE messages_new (
        id           INTEGER PRIMARY KEY,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        channel      TEXT NOT NULL DEFAULT 'web' CHECK (channel IN ('web','telegram','slack')),
        text         TEXT NOT NULL,
        raw_json     TEXT,
        received_at  INTEGER NOT NULL,
        processed_at INTEGER,
        role         TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','bot'))
      );
      INSERT INTO messages_new (id, user_id, channel, text, raw_json, received_at, processed_at, role)
        SELECT id, user_id, channel, text, raw_json, received_at, processed_at, role FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_new RENAME TO messages;
      CREATE INDEX idx_messages_user ON messages(user_id, received_at);
      CREATE INDEX idx_messages_user_id ON messages(user_id, id);
    `);
  },

  // v22 -> v23: namespace VOUCHES by platform. The v19 table is UNIQUE on a single lowercased handle shared
  // across channels — but a Slack "alice" and a Telegram "alice" are different humans, so a shared key would
  // let a Telegram vouch silently authorize a Slack stranger (a real privilege-escalation bug). Add a
  // `platform` column and re-unique on (platform, username); for Slack the "username" is the immutable Uxxxx
  // id (see repo.js). Rebuild (SQLite can't change a UNIQUE in place); existing rows backfill to 'telegram'.
  (d) => {
    d.exec(`
      CREATE TABLE vouches_new (
        id                  INTEGER PRIMARY KEY,
        platform            TEXT NOT NULL DEFAULT 'telegram',  -- 'telegram' | 'slack' (the namespace for username)
        username            TEXT NOT NULL,                     -- vouched-in key: a @handle (Telegram) or a Uxxxx id (Slack)
        voucher_user_id     INTEGER REFERENCES users(id),
        voucher_username    TEXT,                              -- snapshot of the voucher's handle (cascade-revoke parent edge)
        voucher_telegram_id INTEGER,                           -- voucher's numeric id (stable even if they change @username)
        created_at          INTEGER NOT NULL,
        revoked_at          INTEGER,                           -- NULL = active; set on revoke (row KEPT for the record)
        revoked_by_user_id  INTEGER REFERENCES users(id),
        UNIQUE (platform, username)
      );
      INSERT INTO vouches_new
        (id, platform, username, voucher_user_id, voucher_username, voucher_telegram_id, created_at, revoked_at, revoked_by_user_id)
        SELECT id, 'telegram', username, voucher_user_id, voucher_username, voucher_telegram_id, created_at, revoked_at, revoked_by_user_id
          FROM vouches;
      DROP TABLE vouches;
      ALTER TABLE vouches_new RENAME TO vouches;
      CREATE INDEX idx_vouches_voucher ON vouches(voucher_username) WHERE revoked_at IS NULL;
    `);
  },

  // v23 -> v24: NOTEBOOKS — a personal, isolated "second space" a user can switch into (its own tasks, notes,
  // lists — everything), like a fresh account. A notebook is just another `users` row OWNED by a parent
  // (parent_user_id) and named per parent (notebook_name). It deliberately carries NO channel identity
  // (telegram_id/slack_id/email stay NULL), so NO inbound Telegram/Slack message and NO web login can ever
  // resolve to it — the only way in is the parent switching to it, which the server gates on ownership (see
  // repo.effectiveUserId / createNotebook). Every per-user table is already user_id-scoped, so a notebook's
  // rows are isolated by the exact same mechanism as any other user's — no new tenancy code, just a new id.
  // The partial UNIQUE index keeps names distinct per parent (case-insensitively) without the many identity
  // rows (parent_user_id NULL) colliding. ON DELETE CASCADE ties a notebook's lifetime to its parent row.
  (d) => {
    d.exec(`
      ALTER TABLE users ADD COLUMN parent_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
      ALTER TABLE users ADD COLUMN notebook_name  TEXT;
      CREATE UNIQUE INDEX idx_users_notebook ON users(parent_user_id, notebook_name COLLATE NOCASE)
        WHERE parent_user_id IS NOT NULL;
    `);
  },

  // v24 -> v25: WEB LOGIN (auth §9 — the index.js TODO). The optional "simple" auth mode: username +
  // scrypt password + MANDATORY TOTP 2FA. Credentials live on the users row: `username` is the web login
  // handle (unique case-insensitively via the partial index, same idiom as idx_users_slack, so the many
  // rows without one — telegram/slack users, notebooks — never collide on NULL); `password_hash` is a
  // self-describing scrypt string ('scrypt:N:r:p:saltB64:hashB64'); `totp_secret` is the VERIFIED base32
  // TOTP secret, KEK-encrypted at rest (crypto.js — an unverified enrollment is parked in app_settings
  // under totp_pending:<id> and only promoted here once a code proves the authenticator works, so a
  // working 2FA is never destroyed by an abandoned re-enroll). web_sessions stores only the SHA-256 of
  // each 30-day session token (a DB leak can't replay cookies); state 'pending_totp' is the bridge between
  // register/login-with-password and finishing 2FA enrollment. In USER_TABLES for /requestdeletion.
  (d) => {
    d.exec(`
      ALTER TABLE users ADD COLUMN username         TEXT;
      ALTER TABLE users ADD COLUMN password_hash    TEXT;
      ALTER TABLE users ADD COLUMN totp_secret      TEXT;
      ALTER TABLE users ADD COLUMN totp_verified_at INTEGER;
      CREATE UNIQUE INDEX idx_users_username ON users(username COLLATE NOCASE) WHERE username IS NOT NULL;

      CREATE TABLE web_sessions (
        id           INTEGER PRIMARY KEY,
        token_hash   TEXT NOT NULL UNIQUE,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        state        TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','pending_totp')),
        created_at   INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        ip           TEXT
      );
      CREATE INDEX idx_web_sessions_user ON web_sessions(user_id);
    `);
  },

  // v25 -> v26: TIMERS — the opt-in Timer module (chat.js): a one-shot "ding me in N minutes" kitchen-style
  // countdown, deliberately NOT a task (nothing lands on your list, nothing to groom — it just rings once).
  // The scheduler's minute tick fires any due row exactly once (fired_at stamped first, like task reminders);
  // cancel is a soft stamp so "what happened when" stays reconstructable. duration_ms is kept alongside
  // fire_at so the ding can say what length you asked for ("⏰ 20 min is up"). In USER_TABLES for
  // /requestdeletion.
  (d) => {
    d.exec(`
      CREATE TABLE timers (
        id          INTEGER PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label       TEXT,                 -- what it's for ("pasta"), NULL = unlabeled
        duration_ms INTEGER NOT NULL,     -- the requested length (for phrasing the ding)
        fire_at     INTEGER NOT NULL,     -- epoch-ms it should ring
        fired_at    INTEGER,              -- epoch-ms the ding went out (NULL = pending; never re-fires)
        canceled_at INTEGER,              -- epoch-ms it was canceled (NULL = live)
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_timers_due ON timers(fire_at) WHERE fired_at IS NULL AND canceled_at IS NULL;
      CREATE INDEX idx_timers_user ON timers(user_id, fire_at);
    `);
  },

  // v26 -> v27: JOURNALS — the opt-in trend-journal module, the app's heaviest AI feature. A journal is a
  // named per-user stream of daily checklist entries based on a task_template SNAPSHOT (steps are copied at
  // set-time — templates have no FKs and are overwritable by name, so a live reference would silently rewrite
  // a journal mid-month). dossier_json is the journal's own rolling "dossier" (signal counts, watch-list,
  // lastTrendAt): the compact handoff state the trend prompt reads and updates, so trend analysis stays
  // constant-size no matter how old the journal gets. Summaries are HIERARCHICAL rows: day rows are built
  // from the raw entry, week/month rows only from stored day rows — raw old entries are never re-read, and
  // "row exists" is the idempotency marker shared by the lazy path and the nightly sweep. Entries hold only
  // raw data (checklist state + note). All three are in USER_TABLES for /requestdeletion.
  (d) => {
    d.exec(`
      CREATE TABLE journals (
        id             INTEGER PRIMARY KEY,
        user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name           TEXT NOT NULL COLLATE NOCASE, -- user-facing handle, unique per user (like templates)
        template_name  TEXT,                         -- provenance only; the snapshot below is authoritative
        checklist_json TEXT,                         -- JSON [{text}] — the per-day checklist blueprint
        dossier_json   TEXT,                         -- rolling trend state {signals,watch,lastTrendAt}, JSON
        last_used_at   INTEGER,                      -- default-journal resolution ("the one you last touched")
        created_at     INTEGER NOT NULL,
        UNIQUE(user_id, name)
      );
      CREATE TABLE journal_entries (
        id             INTEGER PRIMARY KEY,
        user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        journal_id     INTEGER NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
        entry_date     TEXT NOT NULL,                -- local YYYY-MM-DD (server-local, app-wide convention)
        checklist_json TEXT,                         -- JSON [{text,done,completed_at}] copied RESET from journal
        note           TEXT,                         -- optional free-text daily note (appended-to on repeat)
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        UNIQUE(journal_id, entry_date)
      );
      CREATE INDEX idx_journal_entries_user ON journal_entries(user_id, journal_id, entry_date);
      CREATE TABLE journal_summaries (
        id           INTEGER PRIMARY KEY,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        journal_id   INTEGER NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
        period       TEXT NOT NULL CHECK (period IN ('day','week','month')),
        period_key   TEXT NOT NULL,                  -- day: YYYY-MM-DD · week: YYYY-Www (Mon-start) · month: YYYY-MM
        summary      TEXT NOT NULL,                  -- the prose the user sees
        stats_json   TEXT,                           -- {checked,total,signals:[{label,kind}],days,gaps} — rollup currency
        created_at   INTEGER NOT NULL,
        UNIQUE(journal_id, period, period_key)
      );
      CREATE INDEX idx_journal_summaries_user ON journal_summaries(user_id, journal_id, period, period_key);
    `);
  },

  // v27 -> v28: DIET — the opt-in Diet module's canonical food library. A food is ONE density number
  // (cal_per_unit) in ONE unit_type — the "chicken breast = 45 cal/oz" card the user would otherwise keep
  // on paper; source records whether the user typed it or confirmed an LLM guess. A recipe derives its
  // density from ingredient SNAPSHOTS (recipe_items copies cal_per_unit at add time — editing a food later
  // must not silently rewrite last month's chili; food_id is provenance only) divided by cooked_weight_oz,
  // the finished dish's weight (NULL = draft still being built — drafts live in the DB so the 30-min dialog
  // TTL can't lose one). Eaten portions still land in metric_values on the calories metric; these tables
  // are only the lookup layer. All three in USER_TABLES for /requestdeletion.
  (d) => {
    d.exec(`
      CREATE TABLE foods (
        id           INTEGER PRIMARY KEY,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name         TEXT NOT NULL COLLATE NOCASE,  -- user-facing handle, unique per user (like journals)
        cal_per_unit REAL NOT NULL,                 -- calories per ounce / gram / piece (per unit_type)
        unit_type    TEXT NOT NULL DEFAULT 'ounce' CHECK (unit_type IN ('ounce','gram','piece')),
        source       TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','llm')),
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        UNIQUE(user_id, name)
      );
      CREATE TABLE recipes (
        id               INTEGER PRIMARY KEY,
        user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name             TEXT NOT NULL COLLATE NOCASE,
        cooked_weight_oz REAL,                      -- the finished dish's weight; NULL = draft
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        UNIQUE(user_id, name)
      );
      CREATE TABLE recipe_items (
        id           INTEGER PRIMARY KEY,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        recipe_id    INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
        food_id      INTEGER REFERENCES foods(id) ON DELETE SET NULL,  -- provenance; the snapshot rules
        name         TEXT NOT NULL,
        cal_per_unit REAL NOT NULL,                 -- snapshot at add time
        unit_type    TEXT NOT NULL DEFAULT 'ounce' CHECK (unit_type IN ('ounce','gram','piece')),
        quantity     REAL NOT NULL,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX idx_recipe_items ON recipe_items(user_id, recipe_id);
    `);
  },

  // v28 -> v29: DIET — serving foods + meals. unit_type gains 'serving': a food priced per TYPICAL
  // SERVING, taught by a stated calorie count with no amount ("eat skyr 140cal") or by "save meal";
  // it counts like 'piece'. foods also gains description (what's in a MEAL; NULL = a plain food — a
  // meal IS a serving food with a description, not its own table). SQLite can't ALTER a CHECK
  // constraint, so both tables carrying it are rebuilt (recipe_items too — serving foods can become
  // recipe ingredients, and the snapshot insert must pass the widened CHECK); FK enforcement is
  // toggled off around migrate() for exactly this pattern.
  (d) => {
    d.exec(`
      CREATE TABLE foods_new (
        id           INTEGER PRIMARY KEY,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name         TEXT NOT NULL COLLATE NOCASE,  -- user-facing handle, unique per user (like journals)
        cal_per_unit REAL NOT NULL,                 -- calories per ounce / gram / piece / serving (per unit_type)
        unit_type    TEXT NOT NULL DEFAULT 'ounce' CHECK (unit_type IN ('ounce','gram','piece','serving')),
        source       TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','llm')),
        description  TEXT,                          -- what's in a MEAL (NULL = a plain food)
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        UNIQUE(user_id, name)
      );
      INSERT INTO foods_new (id, user_id, name, cal_per_unit, unit_type, source, created_at, updated_at)
        SELECT id, user_id, name, cal_per_unit, unit_type, source, created_at, updated_at FROM foods;
      DROP TABLE foods;
      ALTER TABLE foods_new RENAME TO foods;

      CREATE TABLE recipe_items_new (
        id           INTEGER PRIMARY KEY,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        recipe_id    INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
        food_id      INTEGER REFERENCES foods(id) ON DELETE SET NULL,  -- provenance; the snapshot rules
        name         TEXT NOT NULL,
        cal_per_unit REAL NOT NULL,                 -- snapshot at add time
        unit_type    TEXT NOT NULL DEFAULT 'ounce' CHECK (unit_type IN ('ounce','gram','piece','serving')),
        quantity     REAL NOT NULL,
        created_at   INTEGER NOT NULL
      );
      INSERT INTO recipe_items_new SELECT * FROM recipe_items;
      DROP TABLE recipe_items;
      ALTER TABLE recipe_items_new RENAME TO recipe_items;
      CREATE INDEX idx_recipe_items ON recipe_items(user_id, recipe_id);
    `);
  },
  // v29 -> v30: the retired macro fan-out wrote carbs/fat/protein rows with an entry_label
  // but no note (only calories got note=label); normalize history so those rows show their food.
  (d) => {
    d.exec(`
      UPDATE metric_values SET note = entry_label
        WHERE entry_label IS NOT NULL AND (note IS NULL OR note = '')
    `);
  },

  // v30 -> v31: public-demo hardening. (1) PIN Telegram vouches to a numeric id: the v19/v23 vouch key is
  // the MUTABLE lowercased @username, so a vouched user who renames silently loses access — and worse, a
  // squatter who later claims the lapsed handle would inherit the vouch. On the vouchee's first authorized
  // contact we stamp their immutable telegram id here; from then on the id (not the handle) is what admits
  // them, and the same handle under a DIFFERENT id is refused (see repo.isVouchedTelegram). The handle stays
  // the row's key — it's the UNIQUE constraint and the cascade-revoke parent edge. Slack needs none of this
  // (its vouch key is already the immutable Uxxxx id). (2) LLM_USAGE — per-user, per-local-day call counter
  // backing the daily LLM budget (llmBudget.js), the cost control for running strangers on a paid cloud key.
  // User-scoped (unlike vouches): registered in repo's USER_TABLES so /requestdeletion sweeps it.
  (d) => {
    d.exec(`
      ALTER TABLE vouches ADD COLUMN vouched_telegram_id INTEGER;  -- vouchee's numeric id; NULL until first contact
      ALTER TABLE vouches ADD COLUMN pinned_at INTEGER;            -- when the pin happened (audit)
      CREATE TABLE llm_usage (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day     TEXT NOT NULL,             -- local YYYY-MM-DD (resets at the server's midnight)
        calls   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, day)
      );
    `);
  },

  // v31 -> v32: NOTEBOOK RETIRE/RECOVER. A retired notebook is HIDDEN (out of listings, switch, and the
  // proactive sweeps — its reminders/schedules/timers stay quiet), never deleted: `retired_at` is a soft
  // stamp on the sub-user row, cleared on recover. The v23 unique name index shrinks to LIVE notebooks
  // only, so a retired "work" frees its name for a fresh "work" — the collision moves to recover time,
  // where repo.recoverNotebook resolves it by picking a free suffixed name ("work 2"). Retired sub-users
  // keep parent_user_id, so /requestdeletion's cascade and the retention export still cover them.
  (d) => {
    d.exec(`
      ALTER TABLE users ADD COLUMN retired_at INTEGER;
      DROP INDEX idx_users_notebook;
      CREATE UNIQUE INDEX idx_users_notebook ON users(parent_user_id, notebook_name COLLATE NOCASE)
        WHERE parent_user_id IS NOT NULL AND retired_at IS NULL;
    `);
  },

  // v32 -> v33: BATCHES — the opt-in process-batch module (fermentation, brewing, baking, soap…). A batch
  // is one RUN of a process: the directions come from a task_template SNAPSHOT (copied RESET at open, the
  // journal rule — templates are overwritable by name with no FKs, so a live reference would rewrite a
  // three-week brew mid-ferment; template_name is provenance only). There is no parent "processes" table:
  // the template IS the definition, and the process list derives from DISTINCT name over batches. batch_no
  // is the user-facing per-(user,name) sequence ("batch #3"); several runs of one process may be open at
  // once (two crocks is real life). The log is a TABLE, not an appended text column — a batch spans weeks,
  // so per-line timestamps must be real data, and append stays a pure INSERT. Both in USER_TABLES for
  // /requestdeletion. Deliberately NO reminders and NO recurrence (the templates stance, v17).
  (d) => {
    d.exec(`
      CREATE TABLE batches (
        id             INTEGER PRIMARY KEY,
        user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name           TEXT NOT NULL COLLATE NOCASE, -- process name (= template name at open), NOCASE like templates
        batch_no       INTEGER NOT NULL,             -- per-(user,name) sequence, 1-based, user-facing
        template_name  TEXT,                         -- provenance only; checklist_json is authoritative
        checklist_json TEXT,                         -- JSON [{text,done,completed_at}] snapshot, RESET at open
        status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
        outcome        TEXT,                         -- free-text result note, set at close
        opened_at      INTEGER NOT NULL,
        closed_at      INTEGER,
        UNIQUE(user_id, name, batch_no)
      );
      CREATE INDEX idx_batches_user ON batches(user_id, name, status);
      CREATE TABLE batch_log (
        id         INTEGER PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        batch_id   INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
        text       TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_batch_log_user ON batch_log(user_id, batch_id, created_at);
    `);
  },

  // v33 -> v34: BATCH RECIPE VERSIONS — tweaking. A batch is now a working copy you edit as it runs
  // (add/remove/replace steps); "batch save" graduates the tweaked steps into a NEW auto-numbered template
  // version ("sourdough #2", "#3"…) and "batch new <base>" snapshots the LATEST version. batch_rejects lets
  // a bad version be pulled out of that lineage — "batch new" then falls back to the last good one — without
  // deleting it (reversible via unreject, the retire/recover stance). Kept as a batches-owned table rather
  // than a column on the shared task_templates: rejection is a batch-lineage concept, and other template
  // consumers (materialize, journal) must not inherit it. template_name is the exact version's name (NOCASE,
  // like the template). In USER_TABLES for /requestdeletion.
  (d) => {
    d.exec(`
      CREATE TABLE batch_rejects (
        id            INTEGER PRIMARY KEY,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        template_name TEXT NOT NULL COLLATE NOCASE, -- the rejected version's template name ("sourdough #2")
        rejected_at   INTEGER NOT NULL,
        UNIQUE(user_id, template_name)
      );
      CREATE INDEX idx_batch_rejects_user ON batch_rejects(user_id);
    `);
  },

  // v34 -> v35: DIET "eat whatever" days. A per-day marker for a logical day (dayStartOf epoch, 02:00
  // rollover — the same bucket charts/report/log already use) the user declares OFF THE RECORD: a cheat
  // day, a fast, a travel day. The calorie graph tints those days and the report's average leaves them
  // out, so one deliberate blowout (or a skipped day) never masquerades as a tracked result. One row per
  // marked day (UNIQUE(user,day_start) — marking is idempotent, clearing deletes the row). `kind` is a
  // TEXT so future off-record flavors ('fast', 'sick') can share the table. Calories still log normally
  // into metric_values; this table only re-colors and re-scopes them. In USER_TABLES for /requestdeletion.
  (d) => {
    d.exec(`
      CREATE TABLE diet_days (
        id         INTEGER PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day_start  INTEGER NOT NULL,                    -- epoch-ms of the logical day (dayStartOf)
        kind       TEXT NOT NULL DEFAULT 'whatever',
        created_at INTEGER NOT NULL,
        UNIQUE(user_id, day_start)
      );
      CREATE INDEX idx_diet_days_user ON diet_days(user_id, day_start);
    `);
  },

  // v35 -> v36: CLI CLAIM TOKENS — the `fanad <server> <token>` terminal client's credential.
  // Long-lived connector tokens, modeled on web_sessions: the client holds the raw token (`fnd1_…`), the DB
  // only its SHA-256, so a DB leak can't replay live credentials. Unlike sessions they're operator-managed:
  // labeled, listed, and revoked (revoked_at, soft — the row stays visible in the admin list) rather than
  // swept on resolve. expires_at NULL = non-expiring (the operator opted out of expiry at mint time).
  // In USER_TABLES for /requestdeletion, same as web_sessions.
  (d) => {
    d.exec(`
      CREATE TABLE cli_tokens (
        id           INTEGER PRIMARY KEY,
        token_hash   TEXT NOT NULL UNIQUE,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label        TEXT,
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER,
        expires_at   INTEGER,
        revoked_at   INTEGER
      );
      CREATE INDEX idx_cli_tokens_user ON cli_tokens(user_id);
    `);
  },

  // v36 -> v37: RETIRE REWARDS. The §4 reward feature (saved rewards + post-completion suggestion) is
  // removed — nobody used it. Drop its two tables and its rows in the shared embeddings table (which
  // stays: it also holds task/note vectors). The v2 migration above still creates them for fresh DBs;
  // this drop runs right after, so both paths converge on the same schema.
  (d) => {
    d.exec(`
      DROP TABLE IF EXISTS reward_redemptions;
      DROP TABLE IF EXISTS rewards;
      DELETE FROM embeddings WHERE owner_type = 'reward';
    `);
  },

  // v37 -> v38: UNDO STACK. A per-user LIFO of the bot's recent undoable actions (a capture, a done, a
  // logged portion…), each row carrying the `kind` + `payload_json` needed to invert it AND the exact
  // `message` to print when it does. "undo" pops the top; rows are pushed at the chat-layer chokepoints
  // (server/undo.js). Deliberately NOT an audit log: rows are consumed on pop, capped per user, and
  // pruned by age (an undo hours later is a surprise, not a favor). In USER_TABLES for /requestdeletion.
  (d) => {
    d.exec(`
      CREATE TABLE undo_stack (
        id           INTEGER PRIMARY KEY,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind         TEXT NOT NULL,      -- 'task_capture' | 'note_capture' | 'task_status' | 'metric_log' | 'timer_set' | 'list_add'
        payload_json TEXT NOT NULL,      -- what apply() needs to invert the action (ids, prior statuses…)
        message      TEXT NOT NULL,      -- the reply printed when this entry is undone
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX idx_undo_stack_user ON undo_stack(user_id, id);
    `);
  },

  // v38 -> v39: TOKEN SCOPES. Claim tokens grow a scope: 'full' (the CLI/TUI
  // client, unchanged default) or 'read' — a token that can only GET/HEAD, minted for dashboards and the
  // Home Assistant companion so "the token in my HA config can't write to my scratchpad". Enforced at
  // apiAuthGate (auth.js); existing rows backfill to 'full', preserving every outstanding credential.
  (d) => {
    d.exec("ALTER TABLE cli_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'full'");
  },

  // v39 -> v40: LINK PREVIEWS. A task captured with a pasted URL stores the page's fetched preview here —
  // JSON {url, finalUrl, title, description, site, fetchedAt, status} (NULL = no link in the task). Written
  // once at capture (services/linkpreview.js) and by the one-shot startup backfill (linkBackfill.js); a
  // failed fetch is stored too (status 'error'|'blocked'|'timeout') so the URL survives and the backfill
  // never re-hammers a dead site. Renders as the clickable task title.
  (d) => {
    d.exec('ALTER TABLE tasks ADD COLUMN link_json TEXT');
  },
];

export function migrate() {
  const row = db.prepare('PRAGMA user_version').get();
  let v = Number(row.user_version) || 0;
  // A DB from a NEWER Fanad (e.g. a backup restored onto an older install) may hold tables/columns this
  // code has never heard of; there are no down-migrations, so running against it risks silent corruption.
  if (v > MIGRATIONS.length) {
    throw new Error(
      `Database schema is v${v} but this Fanad only knows v${MIGRATIONS.length} — the database was created `
      + 'by a newer version (did you restore a backup from a newer server?). Update Fanad and start again.',
    );
  }
  if (v >= MIGRATIONS.length) return v;
  // Some migrations rebuild a table (CREATE new → copy → DROP old → RENAME). With FK enforcement on,
  // DROP TABLE would cascade/violate child rows, so disable it around the run. PRAGMA foreign_keys is a
  // no-op inside a transaction, hence it's set here (outside) and restored in finally.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (; v < MIGRATIONS.length; v++) {
      db.exec('BEGIN');
      try {
        MIGRATIONS[v](db);
        db.exec(`PRAGMA user_version = ${v + 1}`);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  return v;
}
