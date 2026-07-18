// The stored-inbound-text cap (MAX_INBOUND_CHARS → ingest.recordSnapshot): a hostile/oversized message is
// TRUNCATED with a visible marker, not rejected — the turn still processes and a task still files. Its own
// file (not ingest.test.js) because the cap is config frozen at import time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-cap-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';
process.env.MAX_INBOUND_CHARS = '100';

const { migrate } = await import('../server/db.js');
const { recordSnapshot } = await import('../server/ingest.js');
const { handleMessage } = await import('../server/chat.js');
const { defaultUserId, listMessagesBefore, listTasks } = await import('../server/repo.js');

migrate();
const uid = defaultUserId();

test('an over-cap message is stored truncated with a marker; a normal one is untouched', () => {
  recordSnapshot({ userId: uid, text: `${'x'.repeat(500)} end-of-flood` });
  recordSnapshot({ userId: uid, text: 'short and sweet' });
  const [short, flood] = listMessagesBefore(uid, { channel: 'web', limit: 2 }); // newest first
  assert.equal(short.text, 'short and sweet');
  assert.equal(flood.text, `${'x'.repeat(100)}… [truncated]`);
  assert.doesNotMatch(flood.text, /end-of-flood/);
});

test('an over-cap chat turn still processes end-to-end (a task files from the truncated text)', async () => {
  const out = await handleMessage({ userId: uid, text: `water the plants ${'y'.repeat(400)}`, channel: 'web' });
  assert.match(out.reply, /\S/);
  assert.ok(listTasks(uid).some((t) => /water the plants/.test(t.original_text || t.summary)), 'the task filed');
});
