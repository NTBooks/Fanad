// The /api/stream event bus: per-user filtering, the null-user broadcast, multi-id subscription (identity
// + notebook), unsubscribe hygiene, and the repo chokepoints actually emitting. Pure in-process — the SSE
// route on top of it is a thin res.write adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-events-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { emitUserEvent, subscribeUserEvents } = await import('../server/events.js');
const { migrate } = await import('../server/db.js');
const { defaultUserId, insertMessage, insertWakeup } = await import('../server/repo.js');
migrate();

test('a subscriber sees its own user events and null-user broadcasts, not a neighbor’s', () => {
  const got = [];
  const unsub = subscribeUserEvents(7, (type) => got.push(type));
  emitUserEvent(7, 'chat');
  emitUserEvent(8, 'chat');      // neighbor — filtered out
  emitUserEvent(null, 'config'); // broadcast — everyone
  unsub();
  emitUserEvent(7, 'wakeup');    // after unsubscribe — nothing
  assert.deepEqual(got, ['chat', 'config']);
});

test('a multi-id subscription (identity + notebook) hears both', () => {
  const got = [];
  const unsub = subscribeUserEvents([3, 42], (type) => got.push(type));
  emitUserEvent(3, 'chat');
  emitUserEvent(42, 'wakeup');
  emitUserEvent(5, 'chat');
  unsub();
  assert.deepEqual(got, ['chat', 'wakeup']);
});

test('insertMessage and insertWakeup poke the bus for their user', () => {
  const root = defaultUserId();
  const got = [];
  const unsub = subscribeUserEvents(root, (type) => got.push(type));
  insertMessage({ userId: root, channel: 'web', text: 'poke me', role: 'user' });
  insertWakeup(root, 'psst');
  unsub();
  assert.deepEqual(got, ['chat', 'wakeup']);
});
