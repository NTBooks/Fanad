// A read-mostly, user-scoped data browser behind the web "Your data" tab — transparency on exactly
// what Fanad has stored about you. Whitelisted tables only: app_settings is deliberately absent (it
// holds the LLM API key + Telegram token). Every identifier here comes from this registry, never from
// the request, so only values are ever parameterized. Web-only; Telegram never surfaces this (§ admin).
import { db } from './db.js';
import { deleteImagesForTask, deleteImagesForNote } from './repo.js';

const num = (v) => (typeof v === 'bigint' ? Number(v) : v);

// Each view: the table, the high-level columns to show, which (text) columns may be edited in place,
// whether rows may be deleted, and the column that scopes rows to the current user (default user_id).
const VIEWS = [
  { key: 'tasks', label: 'Tasks', table: 'tasks',
    columns: ['id', 'summary', 'category', 'effort_level', 'status', 'due_at', 'created_at', 'completed_at', 'expired_at'],
    editable: ['summary'], order: 'created_at DESC' },
  { key: 'notes', label: 'Notes', table: 'notes',
    columns: ['id', 'text', 'title', 'status', 'created_at'],
    editable: ['text', 'title'], order: 'created_at DESC' },
  { key: 'messages', label: 'Messages', table: 'messages',
    columns: ['id', 'channel', 'text', 'received_at', 'processed_at'], order: 'received_at DESC' },
  { key: 'snapshots', label: 'State snapshots', table: 'state_snapshots',
    columns: ['id', 'captured_at', 'time_of_day', 'mood_emojis', 'location_text'], order: 'captured_at DESC' },
  { key: 'outcomes', label: 'Task outcomes', table: 'task_outcomes',
    columns: ['id', 'task_id', 'category', 'outcome', 'sentiment', 'ctx_phase', 'ctx_mood', 'at'], order: 'at DESC' },
  { key: 'suggestions', label: 'Suggestion events', table: 'suggestion_events',
    columns: ['id', 'task_id', 'source', 'outcome', 'surfaced_at', 'resolved_at'], order: 'surfaced_at DESC' },
  { key: 'metrics', label: 'Metrics', table: 'metrics',
    columns: ['id', 'name', 'unit', 'aggregation', 'measurement_type', 'target', 'enabled', 'created_at'], order: 'created_at' },
  { key: 'metric_values', label: 'Metric values', table: 'metric_values',
    columns: ['id', 'metric_id', 'value', 'note', 'entry_label', 'recorded_at'], order: 'recorded_at DESC' },
  { key: 'schedules', label: 'Wake-up schedules', table: 'schedules',
    columns: ['id', 'minute_of_day', 'enabled', 'last_fired_day', 'created_at'], order: 'minute_of_day' },
  { key: 'wakeups', label: 'Wake-ups', table: 'wakeups',
    columns: ['id', 'text', 'created_at', 'seen_at'], order: 'created_at DESC' },
  { key: 'embeddings', label: 'Embeddings', table: 'embeddings',
    columns: ['id', 'owner_type', 'owner_id', 'dim', 'model', 'created_at'], order: 'created_at DESC' },
  { key: 'images', label: 'Images', table: 'images',
    columns: ['id', 'task_id', 'note_id', 'file_id', 'created_at'], order: 'created_at DESC' },
  // Single-row, derived views — readable for transparency, but not yours to edit/delete here.
  { key: 'profile', label: 'Dossier', table: 'user_profile', scopeCol: 'user_id',
    columns: ['user_id', 'data_json', 'updated_at'], order: 'user_id', deletable: false },
  { key: 'account', label: 'Account', table: 'users', scopeCol: 'id',
    columns: ['id', 'display_name', 'email', 'telegram_id', 'created_at', 'last_seen_at'], order: 'id', deletable: false },
];

const BY_KEY = new Map(VIEWS.map((v) => [v.key, v]));

function view(key) {
  const v = BY_KEY.get(key);
  if (!v) throw new Error(`unknown data view: ${key}`);
  return v;
}
const scopeOf = (v) => v.scopeCol || 'user_id';
const pkOf = (v) => v.pk || 'id';
const canDelete = (v) => v.deletable !== false;

// node:sqlite can hand back BigInt for large integers; coerce so the row JSON-serializes cleanly.
const clean = (row) => Object.fromEntries(Object.entries(row).map(([k, val]) => [k, num(val)]));

const countRows = (userId, v) =>
  num(db.prepare(`SELECT COUNT(*) AS n FROM ${v.table} WHERE ${scopeOf(v)} = ?`).get(userId)?.n ?? 0);

// High-level index: every view, how many rows the user has, and what you can do with each.
export function entities(userId) {
  return VIEWS.map((v) => ({
    key: v.key, label: v.label, count: countRows(userId, v), editable: v.editable || [], deletable: canDelete(v),
  }));
}

// One page of rows for a view, plus its column list and total count (for paging).
export function rows(userId, key, { limit = 50, offset = 0 } = {}) {
  const v = view(key);
  const lim = Math.max(1, Math.min(Number(limit) || 50, 200));
  const off = Math.max(0, Number(offset) || 0);
  const list = db.prepare(
    `SELECT ${v.columns.join(', ')} FROM ${v.table} WHERE ${scopeOf(v)} = ? ORDER BY ${v.order} LIMIT ? OFFSET ?`,
  ).all(userId, lim, off);
  return {
    key: v.key, label: v.label, columns: v.columns, editable: v.editable || [], deletable: canDelete(v),
    total: countRows(userId, v), limit: lim, offset: off, rows: list.map(clean),
  };
}

export function removeRow(userId, key, id) {
  const v = view(key);
  if (!canDelete(v)) throw new Error(`${v.label} can’t be deleted here.`);
  // Image rows are just Telegram file_id references (no on-disk bytes). Deleting a task/note takes its
  // images with it via FK cascade; clear them explicitly too so the row count is right immediately.
  if (key === 'tasks') deleteImagesForTask(userId, id);
  if (key === 'notes') deleteImagesForNote(userId, id);
  try {
    const info = db.prepare(`DELETE FROM ${v.table} WHERE ${pkOf(v)} = ? AND ${scopeOf(v)} = ?`).run(id, userId);
    return num(info.changes) > 0;
  } catch (err) {
    // FK on => deleting a row other rows still point to is refused by SQLite; say so plainly.
    if (/FOREIGN KEY/i.test(err.message)) throw new Error('Other records point to this row — can’t delete it directly.');
    throw err;
  }
}

// Update only the columns this view marks editable; anything else in the patch is ignored.
export function editRow(userId, key, id, patch) {
  const v = view(key);
  const allowed = v.editable || [];
  const keys = Object.keys(patch || {}).filter((k) => allowed.includes(k));
  if (!keys.length) throw new Error('Nothing editable in this view.');
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const params = [...keys.map((k) => (patch[k] == null ? null : String(patch[k]))), id, userId];
  const info = db.prepare(`UPDATE ${v.table} SET ${sets} WHERE ${pkOf(v)} = ? AND ${scopeOf(v)} = ?`).run(...params);
  if (num(info.changes) === 0) throw new Error('Row not found.');
  return clean(db.prepare(`SELECT ${v.columns.join(', ')} FROM ${v.table} WHERE ${pkOf(v)} = ? AND ${scopeOf(v)} = ?`).get(id, userId));
}
