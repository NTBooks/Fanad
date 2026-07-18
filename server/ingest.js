// The single shared ingestion entry point every channel calls.
// Flow: persist raw message → capture state → if it's a "note", file a note; otherwise classify → task.
import { defaultUserId, insertMessage, insertSnapshot, insertTask, insertNote, markMessageProcessed, setImageTask, setImageNote, setSnapshotMood } from './repo.js';
import { classify } from './services/llm/classify.js';
import { extractDeadline, parseOnWhen, parseRemindAt } from './services/llm/deadline.js';
import { embedTask, embedNote } from './rag/index.js';
import { timeOfDay, extractMood } from '../shared/state.js';
import { parsePriority } from '../shared/priority.js';
import { getTaskLock } from './dialog.js';
import { currentWeather } from './weather.js';
import { config } from './config.js';
import { recordUndo } from './undo.js';
import { extractUrl, fetchLinkPreview } from './services/linkpreview.js';

// "note buy milk", "note: call mom", "/note ..." → a note (self-voicemail inbox, §15).
const NOTE_RE = /^\/?note[\s:]+([\s\S]+)/i;

// In the list a row gives the title its own line; past ~this many characters it wraps to several lines and
// the model's short label (≤8 words) reads better than the user's full sentence. At or under it, the user's
// own words ARE the title.
const TITLE_MAX_LEN = 60;

// Pick the list title. Default to the user's OWN words (already de-cued of the deterministic priority /
// scheduling scaffolding — see parseTaskMeta), NOT the model's paraphrase: the LLM summary reads well but can
// quietly rewrite intent ("finish eddie video" → "send video to eddie"). Only when the user's text is too
// long to read at a glance do we defer to the model's short label — and never blank the title if the model
// returned nothing. Pure + exported so the rule is unit-tested without the LLM. The verbatim original_text is
// kept untouched regardless.
export function chooseTaskTitle(userText, llmSummary) {
  const own = String(userText || '').trim();
  const short = String(llmSummary || '').trim();
  return (own.length > TITLE_MAX_LEN && short) ? short : own;
}

// Persist the raw message + a state snapshot (time, mood from emoji OR mood words). Called for EVERY
// inbound message by the router so mood/energy stay fresh even for messages that aren't filed as a task.
// Returns the ids so a captured task can reuse them instead of double-logging.
export function recordSnapshot({ channel = 'web', userId = defaultUserId(), text, receivedAt = Date.now(), raw = null } = {}) {
  // Storage cap (config.limits.maxInboundChars, 0 = off): truncate, don't reject — "trap more, not less"
  // still holds for anything a human types (Telegram itself stops at 4096); this only bounds a hostile
  // web/API client pasting megabytes into the transcript. The marker makes the cut visible on scroll-back.
  const cap = config.limits.maxInboundChars;
  if (cap && typeof text === 'string' && text.length > cap) text = `${text.slice(0, cap)}… [truncated]`;
  const w = currentWeather();
  const messageId = insertMessage({ userId, channel, text, raw, receivedAt });
  const snapshotId = insertSnapshot({
    userId, messageId, capturedAt: receivedAt, timeOfDay: timeOfDay(receivedAt), moodEmojis: extractMood(text) || null,
    weather: w ? { label: w.weather, tempC: w.temp } : null,
  });
  return { messageId, snapshotId };
}

// Pull the DETERMINISTIC metadata out of a task body — a manual priority ("high priority", "p1") and an
// "on <when>" schedule — returning the text to classify (those cues removed) plus the structured fields.
// No LLM, no I/O → pure + exported for tests. The deadline ("by …") stays in the text; the classifier/LLM
// drops it from the short summary on its own.
export function parseTaskMeta(rawText, now = Date.now()) {
  let text = String(rawText || '');
  let priority = null; let dueAt = null; let dueKind = null; let remindAt = null;
  const pr = parsePriority(text);
  if (pr) { priority = pr.level; text = pr.clean; }
  const on = parseOnWhen(text, now);
  if (on) { dueAt = on.dueAt; dueKind = 'by'; remindAt = on.remindAt; text = on.clean; } // "on <when>" = deadline + reminder
  else {
    // "remind me … at <time>" / "remind me in <n> min" — a PURE reminder (remind_at only, no deadline, so it
    // never auto-expires). Runs after parseOnWhen so an "on <date> <time>" schedule still wins; only the
    // dateless clock/relative form lands here. A trailing "by <date>" deadline can still ride along via
    // extractDeadline (dueAt stays null below, so composeTaskFields still consults it on the cleaned text).
    const rem = parseRemindAt(text, now);
    if (rem) { remindAt = rem.remindAt; text = rem.clean; }
  }
  return { text, priority, dueAt, dueKind, remindAt };
}

// Build every field a task row needs from a raw body: deterministic metadata + the LLM classification
// (category, effort, a trimmed summary, a fuller detail paragraph, an inferred mood) + any active lock.
// Precedence: an explicit category arg > a lock > the LLM guess. "trap more, not less" — original_text
// keeps the verbatim input untouched. Shared by ingest() and the /task + note-promote paths.
export async function composeTaskFields({ body, userId = defaultUserId(), now = Date.now(), categoryOverride = null }) {
  const meta = parseTaskMeta(body, now);
  // A pasted URL gets its page preview fetched ONCE, here, before classify — so the model reads the page's
  // title/description, not just the opaque link. Sequenced (not parallel) because the fetched text feeds the
  // classify input; a failed/blocked/slow fetch (status != 'ok') degrades to plain-text behavior. The page
  // block goes AFTER the user's words so sanitizeForLlm's truncation can only ever cut page metadata.
  const found = config.linkPreview.enabled ? extractUrl(meta.text) : null;
  const preview = found ? await fetchLinkPreview(found.url, config.linkPreview) : null;
  const classifyText = preview?.title
    ? `${meta.text}\n[Linked page: ${preview.title}${preview.description ? ` — ${preview.description.slice(0, 300)}` : ''}]`
    : meta.text;
  const [classification, byDue] = await Promise.all([
    classify(classifyText),
    meta.dueAt == null ? extractDeadline(meta.text, now) : Promise.resolve(null), // "on" already set the timing
  ]);
  const lock = getTaskLock(userId);
  return {
    // Bare-URL paste: the page's title IS the task title (the raw link says nothing at a glance); same
    // >60-chars rule as always via chooseTaskTitle. Text+URL keeps the user's own words, as ever.
    summary: (found?.isBare && preview?.title)
      ? chooseTaskTitle(preview.title, classification.summary)
      : chooseTaskTitle(meta.text || body, classification.summary),
    originalText: String(body || ''),
    llmSummary: classification.detail || null,
    category: categoryOverride || lock?.category || classification.category,
    effortLevel: lock?.effort || classification.effort_level,
    priority: meta.priority,
    dueAt: meta.dueAt ?? byDue?.dueAt ?? null,
    dueKind: meta.dueAt != null ? meta.dueKind : (byDue?.kind ?? null),
    remindAt: meta.remindAt,
    mood: classification.mood,
    linkJson: preview ? JSON.stringify(preview) : null,
    classification,
  };
}

export async function ingest({
  channel = 'web', userId = defaultUserId(), text, receivedAt = Date.now(), raw = null,
  messageId = null, snapshotId = null, imageId = null, allowNotes = true,
} = {}) {
  const body = (text || '').trim();
  // An image with no caption is still a real capture (the photo IS the content), so it bypasses the
  // empty-text guard — but it carries no intent to ACT, so it's parked in the notes inbox (below), not the
  // task list.
  const hasImage = imageId != null;
  if (!body && !hasImage) throw new Error('Empty message');

  // Reuse the router's already-recorded message/snapshot when given; otherwise record now (direct callers).
  if (messageId == null) ({ messageId, snapshotId } = recordSnapshot({ channel, userId, text: body, receivedAt, raw }));

  // A "note …" prefix OR a bare (captionless) photo → the self-voicemail inbox, to review/promote later.
  // A captioned photo still files as a task (the caption is the statement). The attached image rides along.
  // allowNotes is false when the Notes module isn't on for this user (opted out, or disabled system-wide): a
  // "note …" prefix then files as an ordinary TASK instead — the module is invisible, so it can't capture. A
  // bare photo still lands in the inbox regardless (photos always park there); only the text branch is gated.
  const noteMatch = (body && allowNotes) ? NOTE_RE.exec(body) : null;
  if (noteMatch || (!body && hasImage)) {
    const noteText = noteMatch ? noteMatch[1].trim() : '📷 Photo';
    const note = insertNote({ userId, text: noteText, sourceMessageId: messageId, snapshotId });
    await embedNote(note);
    if (hasImage) setImageNote(userId, imageId, note.id);
    recordUndo(userId, 'note_capture', { noteId: note.id },
      `↩ Undid that note — “${noteText.length > 60 ? `${noteText.slice(0, 60)}…` : noteText}” is gone.`);
    markMessageProcessed(messageId);
    return { kind: 'note', note };
  }

  // Compose the task: keep the verbatim text, but ALSO trap a trimmed summary, a fuller LLM paragraph,
  // an inferred mood, a manual priority, and any "on <when>"/"by <when>" timing. (See composeTaskFields.)
  const f = await composeTaskFields({ body, userId, now: receivedAt });
  const nowWx = currentWeather();
  const task = insertTask({
    userId,
    summary: f.summary,
    category: f.category,
    effortLevel: f.effortLevel,
    sourceMessageId: messageId,
    createdWeather: nowWx ? nowWx.weather : null,
    dueAt: f.dueAt,
    dueKind: f.dueKind,
    originalText: f.originalText,
    llmSummary: f.llmSummary,
    priority: f.priority,
    remindAt: f.remindAt,
    linkJson: f.linkJson,
  });
  // Fuzzy mood fallback: the snapshot already caught any emoji/mood-WORD; if it didn't but the model read
  // a feeling from the text ("running on fumes"), backfill it so energy/status reflect it too.
  if (f.mood && !extractMood(body)) setSnapshotMood(userId, snapshotId, f.mood);
  await embedTask(task);
  if (hasImage) setImageTask(userId, imageId, task.id); // associate the stored image with its new task
  recordUndo(userId, 'task_capture', { taskId: task.id }, `↩ Undid that — “${task.summary}” is off your list.`);
  markMessageProcessed(messageId);
  return { kind: 'task', task, classification: f.classification };
}
