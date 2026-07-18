// The single canonical event every channel normalizes into before calling ingest().
// Channel adapters (web, Telegram) build one of these; downstream code is channel-agnostic.
export function makeIngestEvent({
  channel,            // 'web' | 'telegram'
  userId,             // authenticated user id (server-supplied; never from the LLM)
  text,               // raw message text (emojis preserved for mood capture)
  receivedAt = Date.now(),
  location = null,    // { lat, lon, label } if shared, else null
  raw = null,         // original channel payload for the audit trail
}) {
  return { channel, userId, text, receivedAt, location, raw };
}
