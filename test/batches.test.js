// The opt-in Batches module (process-batch tracking): template SNAPSHOT checklists per run, per-name
// batch numbering, the dated log table, close-with-outcome, history, confirm-gated delete, and per-user
// isolation. No AI anywhere — the module is deliberately dumb record-keeping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-batches-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate, db } = await import('../server/db.js');
const { handleMessage, handleAction } = await import('../server/chat.js');
const { clearDialogState } = await import('../server/dialog.js');
const {
  defaultUserId, getOrCreateTelegramUser, listTasks, insertTask, addTaskStep, saveTemplate, getTemplate,
  getBatchById, listBatches, listBatchNames, latestOpenBatch, listBatchLog,
} = await import('../server/repo.js');
const {
  openBatch, toggleBatchItems, addBatchStep, editBatchStep, removeBatchStep, closeBatch,
  saveBatchAsVersion, latestFamilyTemplate, batchVersions, nextVersionName, rejectVersion, unrejectVersion,
} = await import('../server/batches.js');
const { setUserFeatures } = await import('../server/settings.js');
const { parseChecklist } = await import('../server/journal.js');

const stepsOf = (userId, batchId) => parseChecklist(getBatchById(userId, batchId).checklist_json);

migrate();
const uid = defaultUserId();
const say = async (text) => { clearDialogState(uid); return handleMessage({ text }); };
const reply = async (text) => (await say(text)).reply;
const batchesOn = (on = true) => setUserFeatures(uid, { batches: on });

// A template to snapshot from: a task with steps, saved by name (the same path a user takes).
function makeTemplate(name, steps) {
  const task = insertTask({ userId: uid, summary: `blueprint for ${name}` });
  for (const s of steps) addTaskStep(uid, task.id, s);
  return saveTemplate(uid, task.id, name);
}

// ── module gate ──

test('with Batches off, /batches offers the one-tap turn-on', async () => {
  batchesOn(false);
  const r = await say('/batches');
  assert.match(r.reply, /Batches are off/i);
  const datas = (r.buttons || []).flat().map((b) => b.data);
  assert.ok(datas.includes('m:optin:batches'), 'offer has a Turn-on-Batches button');
});

test('with Batches off, a task mentioning a batch still files as a task', async () => {
  batchesOn(false);
  const before = listTasks(uid).length;
  await say('pick up a batch of screws from the hardware store');
  assert.equal(listTasks(uid).length, before + 1);
});

// ── open: template snapshot, reset, numbering ──

test('batch new without a template points at /templates; a stepless template is refused', async () => {
  batchesOn();
  assert.match(await reply('batch new sourdough'), /No template called “sourdough”/);
  const t = insertTask({ userId: uid, summary: 'no steps here' });
  saveTemplate(uid, t.id, 'flat');
  assert.match(await reply('batch new flat'), /no steps to follow/);
});

test('batch new snapshots the steps RESET; later template edits never touch the open batch', async () => {
  batchesOn();
  makeTemplate('sourdough', ['feed starter', 'mix + autolyse', 'bake at 450']);
  const r = await reply('batch new sourdough');
  assert.match(r, /Batch #1 of “sourdough” is open/);
  assert.match(r, /1\. ☐ feed starter/);
  const b = latestOpenBatch(uid, 'sourdough');
  assert.deepEqual(parseChecklist(b.checklist_json).map((s) => s.text), ['feed starter', 'mix + autolyse', 'bake at 450']);
  assert.ok(parseChecklist(b.checklist_json).every((s) => !s.done), 'snapshot arrives unchecked');
  // Overwrite the template — the running batch's snapshot must not move.
  makeTemplate('sourdough', ['completely different']);
  assert.equal(parseChecklist(getTemplate(uid, 'sourdough').steps_json).length, 1);
  assert.equal(parseChecklist(getBatchById(uid, b.id).checklist_json).length, 3, 'batch kept its snapshot');
});

test('batch_no increments per name — two open runs of one process is fine, other names start at #1', async () => {
  batchesOn();
  assert.match(await reply('batch new sourdough'), /Batch #2 of “sourdough”/);
  assert.equal(listBatches(uid, 'sourdough').length, 2);
  assert.equal(listBatchNames(uid).find((n) => n.name === 'sourdough').open, 2, 'both runs open at once');
  makeTemplate('kombucha', ['boil tea', 'add scoby']);
  assert.match(await reply('batch new kombucha'), /Batch #1 of “kombucha”/);
});

// ── the card, check/uncheck, buttons ──

test('bare "batch" shows the latest open run; "batch check 1 2" ticks; out-of-range is called out', async () => {
  batchesOn();
  assert.match(await reply('batch kombucha'), /kombucha — batch #1/);
  const r = await say('batch check 1 2');
  assert.match(r.reply, /1\. ☑ boil tea/);
  assert.match(r.reply, /2\. ☑ add scoby/);
  assert.match((await say('batch uncheck 2')).reply, /2\. ☐ add scoby/);
  assert.match((await say('batch check 9')).reply, /no step 9/);
});

test('the ☐ button (m:bch) toggles too; ✅ All done checks everything; a forged id gets a gentle "gone"', async () => {
  batchesOn();
  const b = latestOpenBatch(uid, 'kombucha');
  const r = await handleAction(uid, `m:bch:${b.id}.2`);
  assert.match(r.text, /2\. ☑ add scoby/);
  const all = await handleAction(uid, `m:bca:${b.id}`);
  assert.match(all.text, /Steps 2\/2/);
  const forged = await handleAction(uid, 'm:bch:99999.1');
  assert.match(forged.text, /batch is gone/);
});

// ── the dated log ──

test('"batch log …" appends dated lines in order (typed and via the 📓 button dialog)', async () => {
  batchesOn();
  const b = latestOpenBatch(uid, 'kombucha');
  await say('batch log smells lively');
  const armed = await handleAction(uid, `m:blg:${b.id}`);
  assert.match(armed.text, /next message lands in the “kombucha” #1 log/);
  await handleMessage({ text: 'tastes tart already' }); // the dialog answer — NOT cleared first
  const log = listBatchLog(uid, b.id);
  assert.deepEqual(log.map((l) => l.text), ['smells lively', 'tastes tart already']);
  assert.ok(log.every((l) => l.created_at > 0), 'every line is dated');
});

// ── close: outcome inline, via dialog, via skip ──

test('"batch done <outcome>" closes the run and files the outcome', async () => {
  batchesOn();
  const b = latestOpenBatch(uid, 'kombucha');
  const r = await reply('batch done tangy, best yet');
  assert.match(r, /Closed “kombucha” #1/);
  const closed = getBatchById(uid, b.id);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.outcome, 'tangy, best yet');
  assert.ok(closed.closed_at > 0);
  assert.equal(latestOpenBatch(uid, 'kombucha'), null, 'no open kombucha runs left');
});

test('bare "batch done" asks for the outcome; "skip" closes without one', async () => {
  batchesOn();
  // Close sourdough #2 first (the latest open), leaving #1 open — resolve picks the remaining one.
  await say('batch done');
  await handleMessage({ text: 'skip' });
  const runs = listBatches(uid, 'sourdough');
  const two = runs.find((b) => b.batch_no === 2);
  assert.equal(two.status, 'closed');
  assert.equal(two.outcome, null, '"skip" files no outcome');
  assert.equal(runs.find((b) => b.batch_no === 1).status, 'open', 'the older run is untouched');
});

// ── history ──

test('"batch history <name>" lists runs newest first with dates, steps, and outcomes', async () => {
  batchesOn();
  const r = await reply('batch history sourdough');
  assert.match(r, /sourdough — 2 runs/);
  const lines = r.split('\n');
  assert.ok(lines[1].startsWith('#2'), 'newest first');
  assert.match(r, /#1 · opened .+ · 0\/3 steps · still open/);
  assert.match(await reply('batch history kombucha'), /🏁 tangy, best yet/);
});

// ── delete: confirm-gated, cascades to the log ──

test('batch delete asks first; "delete" erases runs + logs; a bare "yes" does NOT', async () => {
  batchesOn();
  const b = listBatches(uid, 'kombucha')[0];
  assert.ok(listBatchLog(uid, b.id).length > 0, 'kombucha has log lines to cascade');
  await handleMessage({ text: 'batch delete kombucha' });
  await handleMessage({ text: 'yes' }); // NOT a valid confirm for deletion — escapes to capture
  assert.equal(listBatches(uid, 'kombucha').length, 1, 'a bare "yes" never deletes');
  await handleMessage({ text: 'batch delete kombucha' });
  const r = await handleMessage({ text: 'delete' });
  assert.match(r.reply, /Deleted “kombucha”/);
  assert.equal(listBatches(uid, 'kombucha').length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM batch_log WHERE batch_id = ?').get(b.id).n, 0, 'log cascaded');
});

// ── isolation: another user sees none of it ──

test('batches are per-user: a second account starts empty and cannot touch the first\'s runs', async () => {
  batchesOn();
  const other = getOrCreateTelegramUser('777002', 'other');
  setUserFeatures(other, { batches: true });
  assert.equal(listBatchNames(other).length, 0);
  const mine = latestOpenBatch(uid, 'sourdough');
  assert.equal(getBatchById(other, mine.id), null, 'scoped getter blanks a foreign id');
  const foreign = await handleAction(other, `m:bch:${mine.id}.1`);
  assert.match(foreign.text, /batch is gone/, 'foreign tap is ownership-blocked');
});

// ── v2: step tweaking on an open run ──

test('add / edit / rm tweak an open batch; edit preserves done; rm re-compacts + reports missing', () => {
  batchesOn();
  makeTemplate('rye', ['mill grain', 'soak', 'bake']);
  const { batch } = openBatch(uid, 'rye');
  assert.equal(addBatchStep(uid, batch.id, 'cool on rack').items.length, 4, 'add appends');
  toggleBatchItems(uid, batch.id, [1, 2], true); // tick steps 1 & 2
  const ed = editBatchStep(uid, batch.id, 2, 'soak overnight');
  assert.equal(ed.items[1].text, 'soak overnight', 'text replaced');
  assert.equal(ed.items[1].done, true, 'edit preserves the done state');
  const rm = removeBatchStep(uid, batch.id, [1]);
  assert.deepEqual(rm.removed, [1]);
  assert.deepEqual(rm.items.map((s) => s.text), ['soak overnight', 'bake', 'cool on rack'], 'survivors re-compact');
  assert.deepEqual(removeBatchStep(uid, batch.id, [9]).missing, [9], 'out-of-range reported');
});

test('step edits are refused on a CLOSED run (history is immutable)', () => {
  batchesOn();
  makeTemplate('porter', ['mash', 'boil']);
  const { batch } = openBatch(uid, 'porter');
  closeBatch(uid, batch.id, 'thin');
  assert.match(addBatchStep(uid, batch.id, 'x').error, /closed/i);
  assert.match(editBatchStep(uid, batch.id, 1, 'y').error, /closed/i);
  assert.match(removeBatchStep(uid, batch.id, [1]).error, /closed/i);
  assert.deepEqual(stepsOf(uid, batch.id).map((s) => s.text), ['mash', 'boil'], 'checklist untouched');
});

// ── v2: save graduates tweaks into auto-numbered versions ──

test('batch save mints #2 then #3 (original untouched); batch new picks the latest, reset', () => {
  batchesOn();
  makeTemplate('cider', ['press apples', 'ferment']);
  const a = openBatch(uid, 'cider').batch;
  addBatchStep(uid, a.id, 'rack off');
  const s2 = saveBatchAsVersion(uid, a.id);
  assert.equal(s2.versionName, 'cider #2');
  assert.deepEqual(parseChecklist(getTemplate(uid, 'cider #2').steps_json).map((x) => x.text), ['press apples', 'ferment', 'rack off']);
  assert.ok(parseChecklist(getTemplate(uid, 'cider #2').steps_json).every((x) => !x.done), 'saved steps are reset');
  addBatchStep(uid, a.id, 'bottle');
  assert.equal(saveBatchAsVersion(uid, a.id).versionName, 'cider #3', 'each save mints the next number');
  assert.equal(parseChecklist(getTemplate(uid, 'cider').steps_json).length, 2, 'the original is never overwritten');
  // A fresh run now starts from the latest version, with base as the family name.
  const nb = openBatch(uid, 'cider');
  assert.equal(nb.batch.template_name, 'cider #3', 'opened from the latest version');
  assert.equal(nb.batch.name, 'cider', 'run grouped under the family/base name');
  assert.equal(stepsOf(uid, nb.batch.id).length, 4, 'the latest version has 4 steps');
});

test('save is refused when a run has no steps', () => {
  batchesOn();
  const b = openBatch(uid, 'cider').batch; // latest cider has 4 steps
  [4, 3, 2, 1].forEach(() => removeBatchStep(uid, b.id, [1])); // strip them all
  assert.equal(stepsOf(uid, b.id).length, 0);
  assert.match(saveBatchAsVersion(uid, b.id).error, /no steps/i);
});

test('explicit "batch new base #n" opens that exact version; a missing #n errors with the latest', () => {
  batchesOn();
  assert.equal(openBatch(uid, 'cider #2').batch.template_name, 'cider #2', 'explicit #2');
  assert.equal(openBatch(uid, 'cider #1').batch.template_name, 'cider', '#1 is the original base');
  assert.match(openBatch(uid, 'cider #9').error, /latest .* is .*cider #3/i, 'missing version names the latest');
});

// ── v2: reject / unreject a version out of the lineage ──

test('reject drops a version from the lineage; batch new reverts; unreject restores; numbering still counts it', () => {
  batchesOn();
  // cider family: #1 (2 steps), #2, #3 (latest). Reject #3 → new runs use #2.
  assert.equal(latestFamilyTemplate(uid, 'cider').name, 'cider #3');
  const rj = rejectVersion(uid, 'cider', 3);
  assert.equal(rj.latest, 'cider #2');
  assert.equal(openBatch(uid, 'cider').batch.template_name, 'cider #2', 'bare base skips the rejected version');
  assert.equal(openBatch(uid, 'cider #3').batch.template_name, 'cider #3', 'explicit request still opens a rejected version');
  assert.equal(nextVersionName(uid, 'cider'), 'cider #4', 'next-version numbering still counts the rejected #3');
  unrejectVersion(uid, 'cider', 3);
  assert.equal(latestFamilyTemplate(uid, 'cider').name, 'cider #3', 'unreject restores it as latest');
});

test('rejecting the only active version warns and leaves batch new with nothing', () => {
  batchesOn();
  makeTemplate('mead', ['boil the must']);
  const rj = rejectVersion(uid, 'mead', 1);
  assert.equal(rj.emptied, true, 'flagged as leaving zero active versions');
  assert.match(openBatch(uid, 'mead').error, /no template/i, 'nothing to start from');
  unrejectVersion(uid, 'mead', 1);
  assert.ok(openBatch(uid, 'mead').batch, 'restored → opens again');
});

test('a manually-named "<base> #2" template just joins the family; next save is #3', () => {
  batchesOn();
  makeTemplate('ale', ['a']);
  makeTemplate('ale #2', ['b', 'c']);
  const vs = batchVersions(uid, 'ale');
  assert.deepEqual(vs.map((v) => v.n), [1, 2]);
  assert.equal(vs.find((v) => v.n === 1).original, true);
  assert.equal(nextVersionName(uid, 'ale'), 'ale #3');
});

// ── v2: chat wiring for the version commands + card buttons ──

test('chat: batch versions lists the lineage; batch reject/unreject via commands', async () => {
  batchesOn();
  assert.match(await reply('batch versions cider'), /recipe versions[\s\S]*#1[\s\S]*← latest/i);
  assert.match(await reply('batch reject cider #2'), /Rejected “cider #2”/);
  assert.match(await reply('batch unreject cider #2'), /Restored “cider #2”/);
});

test('chat: the ➕ Add step (m:bas) and 💾 Save (m:bsv) buttons work; save reply names the version', async () => {
  batchesOn();
  makeTemplate('lager', ['pitch yeast']);
  const b = openBatch(uid, 'lager').batch;
  const armed = await handleAction(uid, `m:bas:${b.id}`);
  assert.match(armed.text, /next message becomes a new step/i);
  await handleMessage({ text: 'lager the beer 4 weeks' }); // dialog answer
  assert.deepEqual(stepsOf(uid, b.id).map((s) => s.text), ['pitch yeast', 'lager the beer 4 weeks']);
  const saved = await handleAction(uid, `m:bsv:${b.id}`);
  assert.match(saved.toast, /Saved lager #2/);
  assert.ok(getTemplate(uid, 'lager #2'), 'the version template was minted');
});

test('batch_rejects is per-user (another account\'s rejections never touch yours)', () => {
  batchesOn();
  const other = getOrCreateTelegramUser('777003', 'other3');
  setUserFeatures(other, { batches: true });
  rejectVersion(uid, 'cider', 2); // reject in uid's lineage
  assert.equal(batchVersions(other, 'cider').length, 0, 'other user has no cider family at all');
  unrejectVersion(uid, 'cider', 2); // clean up so later assertions are unaffected
});
