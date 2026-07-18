// Notebooks — a per-person opt-in module that gives you separate, ISOLATED spaces (each with its own tasks,
// notes, lists — everything), implemented as a sub-user owned by the parent account. Verifies: the opt-in
// gate; create / switch / list / rename / "notebook main"; data isolation between spaces and between users;
// the "opt-in preferences are shared" rule; the access guardrails (a notebook is never an account / an
// impersonation target); the self-healing pointer; and that a full account erase cascades into notebooks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-notebooks-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';
process.env.USER_IMPERSONATION = '1'; // so resolveActingUserId honors ids — needed to prove it rejects a notebook

const { migrate, db } = await import('../server/db.js');
const { handleMessage } = await import('../server/chat.js');
const { clearDialogState } = await import('../server/dialog.js');
const {
  defaultUserId, getOrCreateTelegramUser, listTasks, listNotes, userExists,
  listUsers, isNotebook, getNotebookByName, listNotebooks, effectiveUserId,
  createNotebook, insertTask, allDueReminders,
  retireNotebook, recoverNotebook, listRetiredNotebooks, getRetiredNotebookByName,
} = await import('../server/repo.js');
const { setUserFeatures, getCurrentNotebookId, setCurrentNotebookId } = await import('../server/settings.js');
const { resolveActingUserId } = await import('../server/actingUser.js');

migrate();
const root = defaultUserId();

// Talk to the brain as a given identity, clearing any open question first (dialog is per-space, keyed by the
// EFFECTIVE user — so clear on the effective id, whichever space that identity is currently in).
const say = async (text, userId = root) => {
  clearDialogState(effectiveUserId(userId));
  return (await handleMessage({ userId, text })).reply;
};
const optinNotebook = (userId = root) => setUserFeatures(userId, { notebook: true });

test('the module is OFF by default: a bare "notebook …" still files a task, only the slash form offers it', async () => {
  setUserFeatures(root, { notebook: false });
  // Bare form must NOT be hijacked while off — a real task starting with "notebook" files normally.
  const filed = await say('notebook and pens for the kids');
  assert.doesNotMatch(filed, /Notebooks are off/i);
  assert.ok(listTasks(root).some((t) => /notebook and pens/i.test(t.original_text || t.summary)), 'the task was filed');
  // The explicit slash form is the discovery path → the gentle off-offer with a one-tap turn-on.
  const off = await handleMessage({ userId: root, text: '/notebook' });
  assert.match(off.reply, /Notebooks are off/i);
  assert.ok((off.buttons || []).flat().some((b) => b.data === 'm:optin:notebook'), 'off-offer has a turn-on button');
});

test('create + switch: "notebook work" makes a fresh space and puts you in it; data is isolated from main', async () => {
  optinNotebook(root);
  setCurrentNotebookId(root, null); // start in main
  await say('paint the fence'); // a MAIN task
  const mainCount = listTasks(root).length;
  assert.ok(mainCount > 0);

  const made = await say('notebook work');
  assert.match(made, /new notebook/i);
  const nb = getNotebookByName(root, 'work');
  assert.ok(nb && nb.parent_user_id === root, 'the notebook is a sub-user owned by root');
  assert.equal(getCurrentNotebookId(root), nb.id, 'root is now pointed at the notebook');

  await say('draft the slide deck'); // filed while INSIDE the notebook
  assert.ok(listTasks(nb.id).some((t) => /slide deck/i.test(t.summary)), 'the task landed in the notebook');
  assert.ok(!listTasks(nb.id).some((t) => /fence/i.test(t.summary)), 'the notebook does NOT see the main task');
  assert.equal(listTasks(root).length, mainCount, 'the main space is unchanged (its task did not move)');
  assert.ok(!listTasks(root).some((t) => /slide deck/i.test(t.summary)), 'main does NOT see the notebook task');
});

test('"notebook main" returns to the default space, where your original tasks are waiting', async () => {
  optinNotebook(root);
  const back = await say('notebook main');
  assert.match(back, /main/i);
  assert.equal(getCurrentNotebookId(root), null, 'the pointer is cleared');
  assert.ok(listTasks(root).some((t) => /fence/i.test(t.summary)), 'the main task is here again');
  assert.ok(!listTasks(root).some((t) => /slide deck/i.test(t.summary)), 'the notebook task is not in main');
});

test('opt-in preferences are SHARED across spaces (a notebook inherits your module choices)', async () => {
  optinNotebook(root);
  setUserFeatures(root, { lists: true }); // turn Lists on in the main/person scope
  setCurrentNotebookId(root, getNotebookByName(root, 'work').id); // hop into the notebook
  const inNotebook = await say('/lists');
  assert.doesNotMatch(inNotebook, /Lists are off/i, 'Lists is on inside the notebook too (shared preference)');
  setCurrentNotebookId(root, null);
  setUserFeatures(root, { lists: false });
});

test('list, reserved names, duplicates, and rename', async () => {
  optinNotebook(root);
  setCurrentNotebookId(root, null);
  const list = await say('notebook');
  assert.match(list, /work/, 'the listing shows the existing notebook');

  assert.match(await say('notebook main'), /already in your main space|main/i);
  assert.match(await say('notebook home'), /already in your main space|main/i); // "home" is a reserved go-back word

  // A reserved name can't be created.
  setCurrentNotebookId(root, null);
  assert.match(await say('notebook rename work default'), /reserved/i);
  // Rename to a fresh name works.
  assert.match(await say('notebook rename work errands'), /Renamed/i);
  assert.ok(getNotebookByName(root, 'errands'), 'renamed notebook exists');
  assert.ok(!getNotebookByName(root, 'work'), 'old name is gone');
  // Re-naming to a switch does not duplicate: "notebook errands" switches into the existing one.
  const sw = await say('notebook errands');
  assert.match(sw, /you’re in/i);
  assert.equal(listNotebooks(root).length, 1, 'still exactly one notebook (switch, not create)');
  setCurrentNotebookId(root, null);
});

test('rename handles MULTI-WORD notebook names on both sides', async () => {
  optinNotebook(root);
  setCurrentNotebookId(root, null);
  await say('notebook weekly review'); // a multi-word name
  assert.ok(getNotebookByName(root, 'weekly review'), 'created a multi-word notebook');
  assert.match(await say('notebook rename weekly review monthly report'), /Renamed/i);
  assert.ok(getNotebookByName(root, 'monthly report'), 'renamed to the multi-word new name');
  assert.ok(!getNotebookByName(root, 'weekly review'), 'the old multi-word name is gone');
  // Clean up so later count/lookup assertions are unaffected.
  await say('notebook rename monthly report scratch'); // keep it a single simple name
  setCurrentNotebookId(root, null);
});

test('GUARDRAIL: a notebook is never an account — hidden from listUsers and rejected as an impersonation target', () => {
  const nb = getNotebookByName(root, 'errands');
  assert.ok(isNotebook(nb.id), 'isNotebook is true for the sub-user');
  assert.ok(!listUsers().some((u) => u.id === nb.id), 'the notebook is NOT in the accounts list');
  // With impersonation ON, a header naming the notebook id must fall back to root (never act AS the notebook).
  assert.equal(resolveActingUserId(String(nb.id)), root, 'a notebook id cannot be impersonated');
  assert.equal(resolveActingUserId(nb.id), root);
});

test('GUARDRAIL: notebooks are per-owner — another user creates their OWN "work", never reaching the first user’s', async () => {
  const bob = getOrCreateTelegramUser(990100, 'bob');
  optinNotebook(bob);
  await say('notebook work', bob);
  const rootErrands = getNotebookByName(root, 'errands');
  const bobWork = getNotebookByName(bob, 'work');
  assert.ok(bobWork && bobWork.parent_user_id === bob, "bob's notebook is owned by bob");
  assert.notEqual(bobWork.id, rootErrands?.id, 'a different sub-user entirely');
  // root cannot name/reach bob's notebook, and bob cannot reach root's — lookups are parent-scoped.
  assert.equal(getNotebookByName(root, 'work'), null, "root has no 'work' (it was renamed to errands)");
  assert.equal(getNotebookByName(bob, 'errands'), null, "bob has no 'errands'");
  await say('notebook main', bob);
});

test('GUARDRAIL: a stale/foreign notebook pointer self-heals back to main', () => {
  const bobWork = getNotebookByName(getOrCreateTelegramUser(990100, 'bob'), 'work');
  // Point root at BOB's notebook (a forged pointer). effectiveUserId must refuse it (wrong parent) and reset.
  setCurrentNotebookId(root, bobWork.id);
  assert.equal(effectiveUserId(root), root, "root can't be pointed at another user's notebook");
  assert.equal(getCurrentNotebookId(root), null, 'the bad pointer was cleared');
  // A pointer at a non-existent id also heals.
  setCurrentNotebookId(root, 99999);
  assert.equal(effectiveUserId(root), root);
});

test('opting OUT of Notebooks returns you to main (never stranded) and keeps the data', async () => {
  optinNotebook(root);
  const nb = getNotebookByName(root, 'errands');
  setCurrentNotebookId(root, nb.id);
  await say('a task only in errands');
  assert.ok(listTasks(nb.id).length > 0);
  const off = await say('optout notebook');
  assert.match(off, /hidden|main space/i);
  assert.equal(getCurrentNotebookId(root), null, 'opting out drops you back to main');
  assert.ok(listTasks(nb.id).length > 0, 'the notebook data is preserved (opt-out never deletes)');
  optinNotebook(root); // re-enable for later tests
});

test('a reminder set INSIDE a notebook still reaches the owner’s channel (delivery COALESCEs to the parent)', () => {
  const carol = getOrCreateTelegramUser(990300, 'carol'); // has a telegram_id (a real channel)
  const nb = createNotebook(carol, 'trip').notebook;       // the sub-user has NONE
  insertTask({ userId: nb.id, summary: 'pack sunscreen', remindAt: Date.now() - 1000 }); // due now, in the notebook
  const due = allDueReminders();
  const row = due.find((t) => t.summary === 'pack sunscreen');
  assert.ok(row, 'the notebook reminder is due');
  assert.equal(Number(row.telegram_id), 990300, 'it carries the OWNER’s telegram id, so the scheduler can push it');
});

test('a full account erase (/requestdeletion) cascades into the user’s notebooks', async () => {
  const alice = getOrCreateTelegramUser(990200, 'alice');
  optinNotebook(alice);
  await say('notebook journal', alice);
  const nb = getNotebookByName(alice, 'journal');
  await say('secret entry', alice); // data inside the notebook
  assert.ok(listTasks(nb.id).length > 0, 'precondition: notebook has data');
  await say('notebook main', alice);
  await say('a plain task in main', alice);

  await handleMessage({ userId: alice, text: '/requestdeletion' });
  const done = await handleMessage({ userId: alice, text: 'DELETE' });
  assert.match(done.reply, /erased/i);

  assert.ok(userExists(alice), "alice's own account row survives (she can keep using the bot)");
  assert.equal(getNotebookByName(alice, 'journal'), null, 'the notebook sub-user row is gone');
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE user_id=?').get(nb.id).n), 0, 'the notebook’s tasks are wiped');
  assert.equal(listTasks(alice).length, 0, 'main-space tasks are wiped too');
  assert.equal(listNotebooks(alice).length, 0, 'no notebooks remain');
});

// ── Retire / recover: hide a notebook (data kept, name freed) and bring it back later. ──

test('retire hides a notebook (data kept); retiring the space you are in returns you to main', async () => {
  const dana = getOrCreateTelegramUser(990400, 'dana');
  optinNotebook(dana);
  await say('notebook alpha', dana); // creates AND switches in
  const nb = getNotebookByName(dana, 'alpha');
  await say('water the alpha plants', dana); // data inside it
  assert.ok(listTasks(nb.id).length > 0);

  const reply = await say('notebook retire alpha', dana);
  assert.match(reply, /Retired/i);
  assert.match(reply, /main space/i, 'retiring the current space says you went home');
  assert.equal(getCurrentNotebookId(dana), null, 'the pointer was cleared');
  assert.equal(getNotebookByName(dana, 'alpha'), null, 'hidden from by-name reach');
  assert.equal(listNotebooks(dana).length, 0, 'hidden from the live listing');
  assert.equal(listRetiredNotebooks(dana).length, 1, 'visible on the retired shelf');
  assert.ok(listTasks(nb.id).length > 0, 'the data is kept — retire never deletes');

  const home = await say('notebook', dana);
  assert.match(home, /1 retired/i, 'the notebooks home hints at the retired shelf');
});

test('a retired name is FREED: a fresh notebook can take it (distinct sub-user)', async () => {
  const dana = getOrCreateTelegramUser(990400, 'dana');
  const retired = getRetiredNotebookByName(dana, 'alpha');
  assert.ok(retired, 'precondition: a retired "alpha" exists');
  const made = await say('notebook alpha', dana);
  assert.match(made, /new notebook/i, 'same name creates a NEW space, not a resurrection');
  const live = getNotebookByName(dana, 'alpha');
  assert.notEqual(live.id, retired.id, 'a different sub-user entirely');
  await say('notebook main', dana);
});

test('recover under a name COLLISION comes back suffixed ("alpha 2"), with the old data intact', async () => {
  const dana = getOrCreateTelegramUser(990400, 'dana');
  const retired = getRetiredNotebookByName(dana, 'alpha');
  const reply = await say('notebook recover alpha', dana);
  assert.match(reply, /Recovered as 📓 alpha 2/i);
  assert.match(reply, /fresh name/i, 'the reply explains the rename');
  const back = getNotebookByName(dana, 'alpha 2');
  assert.equal(back.id, retired.id, 'the recovered space is the ORIGINAL sub-user');
  assert.equal(back.retired_at, null);
  assert.ok(listTasks(back.id).some((t) => /alpha plants/i.test(t.summary || t.original_text)), 'its data came back with it');
  assert.equal(listRetiredNotebooks(dana).length, 0, 'the shelf is empty again');
});

test('recover without a collision restores the original name; "notebook retired" lists the shelf with recover chips', async () => {
  const dana = getOrCreateTelegramUser(990400, 'dana');
  assert.match(await say('notebook retire alpha 2', dana), /Retired/i);
  const shelf = await handleMessage({ userId: dana, text: 'notebook retired' });
  assert.match(shelf.reply, /alpha 2/);
  assert.ok((shelf.buttons || []).flat().some((b) => b.data === 'notebook recover alpha 2'), 'a tappable recover chip');
  const reply = await say('notebook recover alpha 2', dana);
  assert.match(reply, /Recovered 📓 alpha 2/i, 'no collision → the name is kept as-is');
});

test('recovering a name that is not on the shelf says so; bare "notebook recover" shows the shelf', async () => {
  const dana = getOrCreateTelegramUser(990400, 'dana');
  assert.match(await say('notebook recover nonesuch', dana), /don’t have a retired notebook/i);
  assert.match(await say('notebook recover', dana), /No retired notebooks|Retired notebooks/i);
  assert.match(await say('notebook retire nonesuch', dana), /don’t have a notebook/i);
});

test('GUARDRAIL: a pointer at a RETIRED notebook self-heals to main (a hidden space is never the acting space)', () => {
  const erin = getOrCreateTelegramUser(990500, 'erin');
  const nb = createNotebook(erin, 'attic').notebook;
  assert.ok(!retireNotebook(erin, 'attic').error);
  setCurrentNotebookId(erin, nb.id); // force the pointer past the retire-time clearing
  assert.equal(effectiveUserId(erin), erin, 'the retired space is refused');
  assert.equal(getCurrentNotebookId(erin), null, 'and the pointer was cleared');
});

test('a reminder inside a RETIRED notebook stays quiet, and fires again once recovered', () => {
  const erin = getOrCreateTelegramUser(990500, 'erin');
  const nb = createNotebook(erin, 'cellar').notebook;
  insertTask({ userId: nb.id, summary: 'bottle the cider', remindAt: Date.now() - 1000 });
  assert.ok(allDueReminders().some((t) => t.summary === 'bottle the cider'), 'precondition: due while live');
  retireNotebook(erin, 'cellar');
  assert.ok(!allDueReminders().some((t) => t.summary === 'bottle the cider'), 'silent while retired');
  const rec = recoverNotebook(erin, 'cellar');
  assert.equal(rec.renamedFrom, null);
  assert.ok(allDueReminders().some((t) => t.summary === 'bottle the cider'), 'due again after recovery');
});

test('the retire/recover subcommand words are reserved as notebook names', () => {
  const erin = getOrCreateTelegramUser(990500, 'erin');
  for (const w of ['retire', 'retired', 'recover', 'unretire']) {
    assert.equal(createNotebook(erin, w).error, 'reserved', `"${w}" cannot be a notebook name`);
  }
});
