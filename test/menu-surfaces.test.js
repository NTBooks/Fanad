// The four surfaces that emit interactive `buttons`: the capture confirmation (headline "edit just
// added"), the /whatdo card, /tasks listings, and the `c` hub. PLAN: interactive menus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-surf-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage } = await import('../server/chat.js');
const { clearDialogState } = await import('../server/dialog.js');
const { decodeToken } = await import('../server/menu.js');

migrate();
const say = (text) => { clearDialogState(1); return handleMessage({ text }); };
const flat = (buttons) => (buttons || []).flat();

test('capture confirmation carries an ⋯Edit → the new task\'s action menu', async () => {
  const r = await say('buy fresh bread');
  assert.match(r.reply, /Filed/);
  const edit = flat(r.buttons).find((b) => b.data.startsWith('m:act:'));
  assert.ok(edit, 'an m:act edit button is present');
  assert.equal(decodeToken(edit.data).verb, 'act');
});

test('/whatdo keeps yes/done/no/smaller options AND adds an ⋯Edit button', async () => {
  const r = await say('/whatdo');
  assert.equal(r.mode, 'suggestion');
  assert.ok(r.options.includes('no') && r.options.includes('smaller'));   // legacy path preserved
  const datas = flat(r.buttons).map((b) => b.data);
  assert.ok(datas.includes('yes') && datas.includes('done'));            // answers also rendered as buttons
  assert.ok(datas.some((d) => d.startsWith('m:act:')));                  // the edit affordance
});

test('/tasks listing puts tappable /start_N · /done_N links on each row (no number buttons)', async () => {
  await say('water the ferns');
  const r = await say('/tasks');
  assert.match(r.reply, /\d+\.\s/);
  assert.match(r.reply, /\/start_1/);                                  // per-task action links, right on the row
  assert.match(r.reply, /\/done_1/);
  assert.ok(!flat(r.buttons).some((b) => String(b.data).startsWith('m:act:')), 'the 1–10 number grid is gone');
});

test('the `c` hub keeps the flat options AND adds navigable group buttons', async () => {
  const r = await say('c');
  assert.ok(r.options.includes('/whatdo'));               // existing flat menu kept (tests depend on it)
  assert.ok(flat(r.buttons).every((b) => b.data.startsWith('m:hub:')));
});
