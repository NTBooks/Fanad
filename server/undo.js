// The app-wide "undo" — pop the last undoable thing the bot did and take it back. The undo_stack table
// (db.js v38) holds one row per undoable action, pushed at the chat-layer chokepoints via recordUndo():
// a capture files a task → the row knows to hard-delete it; a "done" flips status → the row knows the
// prior status + the outcome-ledger id to retract. Each row also stores the exact `message` to print on
// success, composed at PUSH time (when the summary/label is at hand), so applying is dumb and uniform.
//
// Kinds and their inversions:
//   task_capture  {taskId, noteId?}                → deleteTaskCascade (+ unpromoteNote for /promote)
//   note_capture  {noteId}                         → deleteNote
//   task_status   {items:[{taskId,prev,to,until?,outcomeId?}]} → restore prev status, retract outcomes
//   metric_log    {ids:[…]}                        → delete those metric_values rows (eat/track/weight)
//   timer_set     {timerId}                        → cancelTimer
//   list_add      {itemId}                         → deleteListItem (subtree cascade)
//
// Staleness: the world may have moved since the push (the row was deleted in the web GUI, the timer
// rang, a kanban drag re-flipped the status). A stale entry is skipped and the NEXT one tried — "undo"
// undoes the most recent thing that can still be taken back — until the stack runs dry, which earns the
// "can't undo" message. Deliberately NOT covered (each has a first-class inverse already): steps
// (unstep), note deletes (gone is gone), revives, journal/batch edits.
import {
  pushUndo, popUndo, getTask, setTaskStatus, setSnoozed, deleteTaskCascade, unpromoteNote,
  deleteNote, deleteTaskOutcome, getMetricValuesByIds, deleteMetricValuesByIds,
  getTimer, cancelTimer, getListItem, deleteListItem,
} from './repo.js';
import { rebuildDossier } from './dossier.js';

// Kept phrasing: tests (and habit) match /Nothing recent to undo/.
export const CANT_UNDO = 'Nothing recent to undo — nothing I’ve done lately can be taken back with “undo”.';

// Record an undoable action. Never throws — a failed bookkeeping write must not break the action itself.
export function recordUndo(userId, kind, payload, message) {
  try { pushUndo(userId, { kind, payload, message }); } catch (err) { console.error('recordUndo failed:', err.message); }
}

function applyTaskStatus(userId, entry) {
  const items = entry.payload.items || [];
  let applied = 0; let outcomesRemoved = 0;
  for (const it of items) {
    const task = getTask(userId, it.taskId);
    // Only revert a task still in the state THIS entry put it in — if something else moved it since
    // (a web drag, a scheduler sweep), flipping it back would undo the wrong thing.
    if (!task || task.status !== it.to) continue;
    if (it.prev === 'snoozed' && it.until) setSnoozed(userId, it.taskId, it.until);
    else setTaskStatus(userId, it.taskId, it.prev);
    if (it.outcomeId && deleteTaskOutcome(userId, it.outcomeId)) outcomesRemoved += 1;
    applied += 1;
  }
  if (!applied) return null;
  if (outcomesRemoved) rebuildDossier(userId); // the retracted done/drop/snooze must leave the learning signal too
  return { reply: entry.message, tasksChanged: true };
}

function applyMetricLog(userId, entry) {
  const rows = getMetricValuesByIds(userId, entry.payload.ids || []);
  if (!rows.length) return null; // already deleted (web per-row delete) → stale
  deleteMetricValuesByIds(userId, rows.map((r) => r.id));
  // Prefer the LIVE entry_label over the stored message: the diet log's inline edit renames labels in
  // place, and the undo confirmation should name what the log said at undo time, not at push time.
  const labels = [...new Set(rows.map((r) => r.entry_label).filter(Boolean))];
  return { reply: labels.length ? `↩ Undid “${labels.join('”, “')}”.` : entry.message, tasksChanged: false };
}

function apply(userId, entry) {
  const p = entry.payload;
  switch (entry.kind) {
    case 'task_capture': {
      const task = getTask(userId, p.taskId);
      if (!task || task.status === 'done') return null; // finished since (web GUI) → deleting it would destroy real history
      if (p.noteId) unpromoteNote(userId, p.noteId);    // a promote-undo puts the note back in the inbox
      deleteTaskCascade(userId, p.taskId);
      return { reply: entry.message, tasksChanged: true };
    }
    case 'note_capture':
      return deleteNote(userId, p.noteId) ? { reply: entry.message, tasksChanged: false } : null;
    case 'task_status':
      return applyTaskStatus(userId, entry);
    case 'metric_log':
      return applyMetricLog(userId, entry);
    case 'timer_set': {
      const row = getTimer(userId, p.timerId);
      if (!row || row.fired_at || row.canceled_at) return null; // rang or already canceled → nothing to take back
      cancelTimer(userId, p.timerId);
      return { reply: entry.message, tasksChanged: false };
    }
    case 'list_add':
      return getListItem(userId, p.itemId) && deleteListItem(userId, p.itemId)
        ? { reply: entry.message, tasksChanged: false } : null;
    default:
      return null; // unknown kind (older/newer build) → skip, try the next entry
  }
}

// The "undo" command: pop until something still applies. Returns { reply, tasksChanged } — the caller
// (chat.js) marks the task list dirty when tasksChanged so a hanging list refreshes in place.
export function undoCommand(userId) {
  for (let i = 0; i < 25; i++) { // bounded: the stack cap is 20, so this always terminates
    const entry = popUndo(userId);
    if (!entry) break;
    const res = apply(userId, entry);
    if (res) return res;
  }
  return { reply: CANT_UNDO, tasksChanged: false };
}
