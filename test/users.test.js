// Per-user separation: root = the local/web user; each Telegram account is its own user with its own
// tasks, history, and dossier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-users-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleIncoming, handleReaction } = await import('../server/channels/telegram-handler.js');
const { handleMessage } = await import('../server/chat.js');
const { setTelegramConfig } = await import('../server/settings.js');
const { listTasks, getOrCreateTelegramUser, outcomeStats, defaultUserId } = await import('../server/repo.js');

migrate();

test('two allow-listed Telegram accounts keep separate task lists, both separate from root', async () => {
  setTelegramConfig({ allowedUsername: 'alice bob', ownerId: null });
  await handleIncoming({ text: 'alice apples', fromId: 1001, username: 'alice' });
  await handleIncoming({ text: 'bob bananas', fromId: 1002, username: 'bob' });
  await handleMessage({ text: 'root radishes' }); // web → root

  const a = getOrCreateTelegramUser(1001);
  const b = getOrCreateTelegramUser(1002);
  assert.notEqual(a, b);
  assert.notEqual(a, defaultUserId());

  assert.ok(listTasks(a).some((t) => /apples/.test(t.summary)));
  assert.ok(listTasks(b).some((t) => /bananas/.test(t.summary)));
  assert.ok(!listTasks(a).some((t) => /bananas/.test(t.summary)), 'alice cannot see bob’s tasks');
  assert.ok(listTasks(defaultUserId()).some((t) => /radishes/.test(t.summary)));
  assert.ok(!listTasks(defaultUserId()).some((t) => /apples|bananas/.test(t.summary)));
});

test('a stranger is still turned away (silently — no reply)', async () => {
  assert.equal((await handleIncoming({ text: 'let me in', fromId: 9, username: 'stranger' })).reply, null);
});

test('a Telegram reaction with a ref attributes to that task’s category for that user', () => {
  setTelegramConfig({ allowedUsername: 'carol', ownerId: null });
  handleReaction({ emoji: '🔥', fromId: 2001, username: 'carol', ref: { kind: 'suggestion', taskId: 5, category: 'health' } });
  const carol = getOrCreateTelegramUser(2001);
  assert.ok(outcomeStats(carol, 'health', null).some((r) => r.outcome === 'reaction' && r.sentiment === 'positive'));
});
