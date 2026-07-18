// USER_IMPERSONATION off (the default): the X-Fanad-User header is ignored entirely — the web always
// acts as root, so a stale localStorage value can never escalate. Separate file because the flag is read
// once at config import; node --test runs each file in its own process. PLAN §9.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-imp-off-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';
delete process.env.USER_IMPERSONATION; // flag off

const { migrate } = await import('../server/db.js');
const { defaultUserId, getOrCreateTelegramUser } = await import('../server/repo.js');
const { resolveActingUserId } = await import('../server/actingUser.js');

migrate();

test('header is ignored when the flag is off — always root', () => {
  const other = getOrCreateTelegramUser(8888, 'eve');
  assert.notEqual(other, defaultUserId());
  assert.equal(resolveActingUserId(String(other)), defaultUserId());
  assert.equal(resolveActingUserId(other), defaultUserId());
});
