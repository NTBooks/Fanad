// Once there's a little history, a suggestion explains itself ("you usually get these done around now").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-why-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage } = await import('../server/chat.js');
const { clearDialogState } = await import('../server/dialog.js');
const { stripTags } = await import('../shared/richtext.js');

migrate();
const say = (text) => { clearDialogState(1); return handleMessage({ text }); };

test('a suggestion gives a learned reason after you finish that kind of task', async () => {
  await say('email the client');        // work
  await say('/done email the client');  // → a completed "work" task (builds affinity now)
  await say('email the vendor');        // the only available task, also "work"
  const r = await say('/whatdo');
  assert.match(stripTags(r.reply), /How about “email the vendor”/); // the suggested title is bold now
  assert.match(r.reply, /usually get these done around now/);
});
