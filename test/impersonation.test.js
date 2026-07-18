// Host-only user impersonation (USER_IMPERSONATION on). The web acting-user resolver honors an
// X-Fanad-User header naming an existing user, and falls back to root for anything invalid. DB/file
// isolation itself is proved by test/users.test.js — here we only test which user gets chosen. PLAN §9.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-imp-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';
process.env.USER_IMPERSONATION = '1'; // must be set BEFORE config.js is imported (it reads the env once)

const { migrate } = await import('../server/db.js');
const { defaultUserId, getOrCreateTelegramUser, listUsers, insertMessage, listMessagesBefore } = await import('../server/repo.js');
const { resolveActingUserId } = await import('../server/actingUser.js');

migrate();

test('a valid X-Fanad-User id is honored (string or number)', () => {
  const other = getOrCreateTelegramUser(7777, 'mallory');
  assert.notEqual(other, defaultUserId());
  assert.equal(resolveActingUserId(String(other)), other);
  assert.equal(resolveActingUserId(other), other);
});

test('missing / bogus / non-existent ids fall back to root', () => {
  for (const bad of [undefined, '', 'abc', '0', '-3', '1.5', '999999']) {
    assert.equal(resolveActingUserId(bad), defaultUserId(), `expected root for ${JSON.stringify(bad)}`);
  }
});

test('impersonated history spans all channels — a Telegram user’s turns are visible', () => {
  const bob = getOrCreateTelegramUser(7777, 'mallory'); // same row as above
  insertMessage({ userId: bob, channel: 'telegram', text: 'note from telegram', role: 'user' });
  insertMessage({ userId: bob, channel: 'telegram', text: 'a reply', role: 'bot' });
  // The old web-only filter (the bug) hides a Telegram-only user's whole conversation:
  assert.equal(listMessagesBefore(bob, { channel: 'web' }).length, 0);
  // channel:null is what the web passes when impersonating — the Telegram turns show up:
  const all = listMessagesBefore(bob, { channel: null });
  assert.ok(all.some((m) => /note from telegram/.test(m.text)), 'inbound Telegram note visible');
  assert.ok(all.some((m) => m.role === 'bot'), 'bot reply visible');
});

test('listUsers exposes root (display_name "root") plus every Telegram account', () => {
  const users = listUsers();
  const root = users.find((u) => u.id === defaultUserId());
  assert.ok(root, 'root present');
  assert.equal(root.display_name, 'root');
  assert.ok(users.some((u) => u.telegram_id === 7777), 'the Telegram account is listed');
});
