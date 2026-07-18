// Refusal grooming (§11): refusing the same task enough times offers to reshape it, and choosing "keep"
// backs off without nagging again. One seeded task keeps /whatdo deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-groom-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage } = await import('../server/chat.js');
const { clearDialogState } = await import('../server/dialog.js');
const { listTasks, defaultUserId } = await import('../server/repo.js');

migrate();
const uid = defaultUserId();
const say = (text) => handleMessage({ text });

await say('investigate the cloudflare tunnel issue'); // the single available task

test('refusing the same task repeatedly offers to reshape it (grooming)', async () => {
  let r;
  for (let i = 0; i < 3; i++) {
    clearDialogState(uid);
    await say('/whatdo');
    r = await say('no');
  }
  assert.equal(r.mode, 'grooming');
  assert.match(r.reply, /reword|break it|steps|keep/i);
});

test('"keep" backs off and does NOT immediately re-nag (cooldown)', async () => {
  const kept = await say('keep'); // answers the grooming offer left armed above
  assert.match(kept.reply, /kept/i);

  clearDialogState(uid);
  await say('/whatdo');
  const r = await say('no'); // refused again, but grooming is on cooldown → plain coach line
  assert.equal(r.mode, 'suggestion');
  assert.match(r.reply, /smaller|done/i);
});

test('the refused task is still on the board (never silently dropped)', () => {
  assert.ok(listTasks(uid).some((t) => /cloudflare/i.test(t.summary)));
});
