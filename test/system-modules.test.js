// System-wide module availability (the GLOBAL layer above the per-user opt-in). The owner can enable/disable
// a module for the WHOLE deployment: a disabled module is off for every non-owner regardless of their opt-in,
// its commands FALL THROUGH (invisible — as if uninstalled) instead of offering to turn it on, and it's hidden
// from the modules screen. The owner keeps access (preview a "dark" module before releasing it). Toggles ride
// the owner-only "system …" command / m:syson·m:sysoff tokens (and Settings → Modules on the web).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-sysmod-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
migrate();
const { handleMessage, handleAction, isFeatureOnFor } = await import('../server/chat.js');
const { getUserFeatures, setUserFeatures, getSystemModules, setSystemModules, isSystemModuleOn, setTelegramConfig } = await import('../server/settings.js');
const { getOrCreateTelegramUser } = await import('../server/repo.js');

setTelegramConfig({ ownerId: null, allowedUsername: '' }); // nobody has claimed the bot → bob is a plain non-owner
const OWNER = 1;                                            // root is always the owner
const bob = getOrCreateTelegramUser(1002, 'bob');          // a non-owner account
const datasOf = (r) => (r.buttons || []).flat().map((b) => b.data);
const reset = () => setSystemModules({ notes: true, lists: true, metrics: true, diet: true, vouch: true, notebook: true, timer: true, journal: true, batches: true, homeassistant: true, medication: true });

test('default: every module is available system-wide, so nothing changes', () => {
  reset();
  const sys = getSystemModules();
  for (const k of ['notes', 'lists', 'metrics', 'diet', 'vouch', 'notebook', 'timer', 'journal', 'batches']) {
    assert.equal(sys[k], true, `${k} defaults enabled`);
  }
  setUserFeatures(bob, { diet: true });
  assert.equal(isFeatureOnFor(bob, 'diet'), true, 'a non-owner who opted in has the module');
});

// (homeassistant ships DARK — its fresh-DB default-off is asserted in homeassistant.test.js, where the
// system_modules blob is still untouched; here reset() releases it like every other module.)

test('setSystemModules round-trips and isSystemModuleOn reflects it; tasks/manual are never gatable', () => {
  reset();
  setSystemModules({ journal: false });
  assert.equal(getSystemModules().journal, false);
  assert.equal(isSystemModuleOn('journal'), false);
  assert.equal(getSystemModules().notes, true, 'other modules untouched');
  assert.equal(isSystemModuleOn('tasks'), true, 'core is never gatable');
  assert.equal(isSystemModuleOn('manual'), true, 'help is never gatable');
  reset();
});

test('disabling a module system-wide turns it off for a non-owner even after they opt in — but not the owner', () => {
  reset();
  setUserFeatures(bob, { diet: true });      // bob opted in
  setUserFeatures(OWNER, { diet: true });    // owner opted in
  setSystemModules({ diet: false });
  assert.equal(isFeatureOnFor(bob, 'diet'), false, 'non-owner: system-disable overrides their opt-in');
  assert.equal(isFeatureOnFor(OWNER, 'diet'), true, 'owner keeps access (preview)');
  reset();
});

test("a disabled registry module's command falls through for a non-owner (no turn-on offer)", async () => {
  reset();
  setUserFeatures(bob, { diet: false });
  setSystemModules({ diet: false });
  const r = await handleMessage({ userId: bob, text: 'eat 4 oz chicken breast' });
  assert.ok(!datasOf(r).includes('m:optin:diet'), 'no turn-on offer — the module is invisible');
  assert.match(r.reply, /Filed|✓/i, 'the text is handled normally (filed as a task)');
  reset();
});

test('the same command, module ENABLED but the non-owner is opted out, offers to turn it on (unchanged behavior)', async () => {
  reset();
  setUserFeatures(bob, { diet: false });
  const r = await handleMessage({ userId: bob, text: 'ate 4 oz chicken breast' });
  assert.ok(datasOf(r).includes('m:optin:diet'), 'available-but-off still offers');
  reset();
});

test('the owner, with a module disabled system-wide and not opted in, still gets the turn-on offer (preview)', async () => {
  reset();
  setUserFeatures(OWNER, { diet: false });
  setSystemModules({ diet: false });
  const r = await handleMessage({ userId: OWNER, text: 'ate 4 oz chicken breast' });
  assert.ok(datasOf(r).includes('m:optin:diet'), 'owner can still reach and opt into a dark module');
  reset();
});

test("a disabled inline module's command falls through for a non-owner", async () => {
  reset();
  setUserFeatures(bob, { notes: false });
  setSystemModules({ notes: false });
  const r = await handleMessage({ userId: bob, text: 'note buy milk' });
  assert.ok(!datasOf(r).includes('m:optin:notes'), 'no turn-on offer for a system-disabled inline module');
  assert.match(r.reply, /Filed|✓/i, 'filed as an ordinary task instead');
  reset();
});

test('the modules screen hides a system-disabled module from a non-owner but not the owner', async () => {
  reset();
  setSystemModules({ batches: false });
  const asBob = await handleMessage({ userId: bob, text: 'modules' });
  const bobTokens = datasOf(asBob).join(' ');
  assert.ok(!/:batches\b/.test(bobTokens), 'non-owner never sees a disabled module');
  const asOwner = await handleMessage({ userId: OWNER, text: 'modules' });
  assert.ok(/:batches\b/.test(datasOf(asOwner).join(' ')), 'owner still sees it (to preview)');
  reset();
});

test('a non-owner cannot opt into a disabled module (a stale button is a no-op)', async () => {
  reset();
  setUserFeatures(bob, { journal: false });
  setSystemModules({ journal: false });
  await handleAction(bob, 'm:optin:journal');
  assert.equal(getUserFeatures(bob).journal, false, 'the opt-in is ignored — the flag never flips');
  reset();
});

test('the "system" board is owner-only; loose phrasing still files as a task', async () => {
  reset();
  const board = await handleMessage({ userId: OWNER, text: 'system' });
  assert.ok(datasOf(board).some((d) => /^m:sys(on|off):/.test(d)), 'the owner gets the toggle board');
  const guest = await handleMessage({ userId: bob, text: 'system' });
  assert.ok(!datasOf(guest).some((d) => /^m:sys(on|off):/.test(d)), 'a non-owner gets no board');
  assert.match((await handleMessage({ userId: OWNER, text: 'system is slow today' })).reply, /Filed|✓/i, 'loose phrasing files, even for the owner');
});

test('"system disable/enable <module>" flips global availability from chat', async () => {
  reset();
  await handleMessage({ userId: OWNER, text: 'system disable journal' });
  assert.equal(getSystemModules().journal, false, 'disabled from chat');
  await handleMessage({ userId: OWNER, text: 'system enable journal' });
  assert.equal(getSystemModules().journal, true, 're-enabled from chat');
  reset();
});

test('the owner tapping a system toggle flips it; a non-owner tapping one is a no-op', async () => {
  reset();
  await handleAction(OWNER, 'm:sysoff:timer');
  assert.equal(getSystemModules().timer, false, 'owner tap disables it system-wide');
  await handleAction(bob, 'm:syson:timer');
  assert.equal(getSystemModules().timer, false, 'a non-owner tap changes nothing');
  await handleAction(OWNER, 'm:syson:timer');
  assert.equal(getSystemModules().timer, true);
  reset();
});
