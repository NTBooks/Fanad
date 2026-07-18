// The per-user dossier grows from completions and is viewable via /me.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-dossier-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage } = await import('../server/chat.js');
const { clearDialogState } = await import('../server/dialog.js');
const { defaultUserId } = await import('../server/repo.js');

migrate();
const uid = defaultUserId();
const say = (text) => { clearDialogState(uid); return handleMessage({ text }); };

test('/me is gentle before there is any history', async () => {
  assert.match((await say('/me')).reply, /getting to know|learned/i);
});

test('the dossier reflects what you finish', async () => {
  await say('email the client');
  await say('/done email the client');
  await say('clean the garage');
  await say('/done clean the garage');
  const me = await say('/me');
  assert.match(me.reply, /learned about you/i);
  assert.match(me.reply, /Finished 2/);
});
