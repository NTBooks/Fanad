// Per-user feature modules: Notes / Lists / Metrics / Vouch are each OFF by default and turned on per
// account ("optin lists"). Tasks are core (always on). Vouch is auto-on for the owner. Turning a module on
// reveals its commands, help, guide, and chips; opt-out HIDES (never deletes); and one user's choice never
// leaks to another.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-features-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage, handleAction, isFeatureOnFor } = await import('../server/chat.js');
const { clearDialogState } = await import('../server/dialog.js');
const { defaultUserId, getOrCreateTelegramUser, listNotes } = await import('../server/repo.js');
const { getUserFeatures, setUserFeatures } = await import('../server/settings.js');
const { stripTags } = await import('../shared/richtext.js');

migrate();
const uid = defaultUserId();
const say = async (text) => { clearDialogState(uid); return (await handleMessage({ text })).reply; };
const allOn = () => setUserFeatures(uid, { notes: true, lists: true, metrics: true, vouch: true });
const allOff = () => setUserFeatures(uid, { notes: false, lists: false, metrics: false, vouch: false });

// Reconstruct the full /help reference the way a user reaches it: open the hub, expand every section.
async function helpText() {
  const hub = await handleMessage({ text: '/commands' });
  const tokens = (hub.buttons || []).flat().map((b) => b.data).filter((d) => /^m:cmd:/.test(d));
  let H = hub.reply;
  for (const tk of tokens) { clearDialogState(uid); H += `\n${(await handleAction(uid, tk)).text}`; }
  return stripTags(H);
}

test('defaults: every optional module is OFF for a fresh user (but the owner gets Vouch auto-on)', () => {
  allOff();
  assert.deepEqual(getUserFeatures(uid), { notes: false, lists: false, metrics: false, diet: false, vouch: false, notebook: false, timer: false, journal: false, batches: false, homeassistant: false, medication: false });
  // root IS the deployment owner → vouch is effectively on for them despite the stored flag…
  assert.equal(isFeatureOnFor(uid, 'vouch'), true);
  // …but a non-owner with the same blank blob has vouch off.
  const other = getOrCreateTelegramUser(778001, 'stranger');
  assert.equal(isFeatureOnFor(other, 'vouch'), false);
});

test('with a module off, its commands are gently declined with an offer to turn it on', async () => {
  allOff();
  assert.match(await say('/notes'), /Notes are off/i);
  assert.match(await say('note the spare key is under the pot'), /Notes are off/i);
  assert.match(await say('/recall spare key'), /Notes are off/i);
  assert.match(await say('/promote 1'), /Notes are off/i);
  assert.match(await say('/lists'), /Lists are off/i);
  assert.match(await say('track sleep 7'), /Metrics are off/i);
  // the gated guide topics are declined too
  assert.match(await say('guide notes'), /Notes are off/i);
  assert.match(await say('guide lists'), /Lists are off/i);
});

test('the off-offer carries a one-tap turn-on button (m:optin:<module>)', async () => {
  allOff();
  const r = await handleMessage({ text: '/lists' });
  const datas = (r.buttons || []).flat().map((b) => b.data);
  assert.ok(datas.includes('m:optin:lists'), 'offer has a Turn-on-Lists button');
});

test('with everything opted in, the commands and help are present', async () => {
  allOn();
  assert.match(await say('/notes'), /inbox|waiting/i);
  assert.match(await say('/lists'), /📑/);
  const H = await helpText();
  for (const t of ['/notes', '/recall', '/sub', '/vouch']) assert.ok(H.includes(t), `${t} in help`);
});

test('off modules drop out of help and the one-tap menu', async () => {
  allOff();
  const H = await helpText();
  assert.ok(!H.includes('/recall'), 'recall gone from help when Notes off');
  assert.ok(!H.includes('/sub'), 'lists section gone from help when Lists off');
  const menu = await handleMessage({ text: '/menu' });
  assert.ok(!(menu.options || []).includes('/notes'), '/notes chip gone');
  assert.ok(!(menu.options || []).includes('/lists'), '/lists chip gone');
});

test('Tasks are core — a statement still files a TASK even with every module off', async () => {
  allOff();
  const r = await say('email the dentist about the appointment');
  assert.doesNotMatch(r, /off/i);
  assert.match(r, /Filed|✓/i);
});

test('optin / optout round-trips, and opt-out HIDES without deleting the data', async () => {
  allOn();
  await say('note the spare key is under the pot'); // a real note exists now
  assert.equal(listNotes(uid).length, 1);
  assert.match(await say('optout notes'), /hidden|kept/i);
  assert.match(await say('/notes'), /Notes are off/i);   // surface gone…
  assert.equal(listNotes(uid).length, 1, 'but the note data is preserved');
  assert.match(await say('optin notes'), /Notes on/i);
  assert.match(await say('/notes'), /inbox|spare key/i);  // …and comes right back
});

test('the optin/optout confirmation carries a ✕ dismiss (tidy-chat: it need not linger once read)', async () => {
  allOn();
  clearDialogState(uid);
  const off = await handleMessage({ text: 'optout notes' });
  assert.ok((off.buttons || []).flat().some((b) => b.data === 'm:hide:x'), 'optout confirmation has a ✕');
  clearDialogState(uid);
  const on = await handleMessage({ text: 'optin notes' });
  assert.ok((on.buttons || []).flat().some((b) => b.data === 'm:hide:x'), 'optin confirmation has a ✕');
  // The tapped-toggle path returns the same shape (the channel edits the tapped message in place).
  const tapped = await handleAction(uid, 'm:optout:lists');
  assert.ok((tapped.buttons || []).flat().some((b) => b.data === 'm:hide:x'), 'tapped toggle confirmation has a ✕');
});

test('the "modules" screen lists each module with a toggle, and tapping it flips the state', async () => {
  allOff();
  const r = await handleMessage({ text: 'modules' });
  const datas = (r.buttons || []).flat().map((b) => b.data);
  assert.ok(datas.includes('m:optin:lists'), 'Lists shows an optin toggle while off');
  await handleAction(uid, 'm:optin:lists');
  assert.equal(getUserFeatures(uid).lists, true, 'tapping the toggle turned Lists on');
});

test('a module is per-user — one account opting in never turns it on for another', async () => {
  allOff();
  const a = getOrCreateTelegramUser(779001, 'ann');
  const b = getOrCreateTelegramUser(779002, 'ben');
  setUserFeatures(a, { lists: true });
  assert.equal(isFeatureOnFor(a, 'lists'), true);
  assert.equal(isFeatureOnFor(b, 'lists'), false, "ben's Lists is untouched");
  assert.match((await handleMessage({ userId: b, text: '/lists' })).reply, /Lists are off/i);
});
