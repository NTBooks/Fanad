// Speed Dial: owner-curated Home Assistant command pads for other Telegram accounts. Covers the owner
// authoring grammar (set/label/clear/limit/board), the username→account reconciliation on first contact
// (rename-proof pin, like vouches), the runtime pad lookup, firing a slot (converse() stubbed — no network),
// the "limited account" lockdown (reaches NOTHING but its 0-9 pad), and the "a pad-holder never gets raw ha"
// guard. All offline: HA is only "configured" for the fire tests, with global.fetch stubbed to a canned reply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-sd-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate, db } = await import('../server/db.js');
migrate();
const settings = await import('../server/settings.js');
const { handleMessage, handleAction, isFeatureOnFor } = await import('../server/chat.js');
const { clearDialogState } = await import('../server/dialog.js');
const repo = await import('../server/repo.js');
const sd = await import('../server/speeddial.js');

const owner = repo.defaultUserId(); // root (id 1) is always the owner
const say = (userId, text) => { clearDialogState(userId); return handleMessage({ userId, text, channel: 'telegram' }); };
const reply = async (userId, text) => (await say(userId, text)).reply;
const taskCount = (userId) => Number(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE user_id=?').get(userId).n);

// Stub HA so a fire returns a canned Assist reply — no network. Returns a restore fn.
function stubHouse(speech = 'Turned off the light') {
  settings.setHomeAssistantConfig({ baseUrl: 'http://127.0.0.1:8123', token: 'tok' });
  const real = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ response: { speech: { plain: { speech } } } }), text: async () => '' });
  return () => { global.fetch = real; };
}

// ── owner authoring ──────────────────────────────────────────────────────────────────────────────────────

test('owner sets a slot with a label, and it authorizes + creates the account', async () => {
  await sd.ownerCommand(owner, 'sd @alice 1 = Kitchen | turn off the kitchen lights');
  const slots = repo.listSpeedDialSlots('alice');
  assert.equal(slots.length, 1);
  assert.deepEqual(slots[0], { slot: 1, label: 'Kitchen', command: 'turn off the kitchen lights' });
  assert.ok(repo.getSpeedDialAccount('alice'), 'account row created');
  assert.ok(repo.isVouched('alice'), 'programming a pad authorizes the handle to reach the bot');
});

test('slot without a pipe stores no label; = parsing keeps the command verbatim', async () => {
  await sd.ownerCommand(owner, 'sd @alice 2 = lock the front door');
  const s2 = repo.listSpeedDialSlots('alice').find((s) => s.slot === 2);
  assert.equal(s2.label, '');
  assert.equal(s2.command, 'lock the front door');
});

test('limit on/off flips the lockdown flag', async () => {
  await sd.ownerCommand(owner, 'sd @alice limit on');
  assert.equal(repo.getSpeedDialAccount('alice').speed_dial_only, 1);
  await sd.ownerCommand(owner, 'sd @alice limit off');
  assert.equal(repo.getSpeedDialAccount('alice').speed_dial_only, 0);
});

test('clear one slot vs the whole pad', async () => {
  await sd.ownerCommand(owner, 'sd @alice 1 clear');
  assert.equal(repo.listSpeedDialSlots('alice').find((s) => s.slot === 1), undefined);
  assert.equal(repo.listSpeedDialSlots('alice').length, 1, 'slot 2 survives');
  await sd.ownerCommand(owner, 'sd @alice clear');
  assert.equal(repo.listSpeedDialSlots('alice').length, 0);
  assert.ok(repo.getSpeedDialAccount('alice'), 'clearing the pad keeps the account (and its access)');
});

test('the board lists configured pads', async () => {
  const r = await sd.ownerCommand(owner, 'sd');
  assert.match(r.text, /@alice/);
});

test('a non-owner cannot author a pad (it files as a task instead)', async () => {
  const mallory = repo.getOrCreateTelegramUser(50050, 'mallory');
  await reply(mallory, 'sd @victim 1 = unlock the door');
  assert.equal(repo.getSpeedDialAccount('victim'), null, 'no pad created by a non-owner');
});

// ── reconciliation (pre-stage by @username → link on first contact) ─────────────────────────────────────

test('a pre-staged pad links on first contact and survives a rename via the pinned id', async () => {
  // Owner programs @bob before bob ever messages.
  await sd.ownerCommand(owner, 'sd @bob 3 = start the coffee');
  assert.equal(repo.getSpeedDialAccount('bob').telegram_id, null, 'unpinned until first contact');

  // bob shows up (getOrCreateTelegramUser + the handler's link stamp).
  const bob = repo.getOrCreateTelegramUser(60060, 'bob');
  repo.linkSpeedDialAccount('bob', 60060);
  assert.equal(Number(repo.getSpeedDialAccount('bob').telegram_id), 60060, 'pinned on first contact');
  assert.ok(repo.hasSpeedDial(bob), 'the pad now resolves for bob by id/handle');

  // bob renames his @handle: the pad still resolves by the pinned numeric id.
  db.prepare('UPDATE users SET username=? WHERE id=?').run('bobby', bob);
  const acct = repo.resolveSpeedDialAccount({ telegramId: 60060, username: 'bobby' });
  assert.equal(acct?.username, 'bob', 'pinned id keeps the pad through a rename');
});

// ── firing ───────────────────────────────────────────────────────────────────────────────────────────────

test('fireSlot runs the stored command through HA and echoes what the house said', async () => {
  const bob = repo.getOrCreateTelegramUser(60060, 'bob');
  const restore = stubHouse('Coffee started');
  try {
    const r = await sd.fireSlot(bob, 3);
    assert.match(r.text, /Coffee started/);
    assert.ok(Array.isArray(r.buttons), 'the pad rides along so they can dial again');
  } finally { restore(); }
});

test('an empty slot returns a gentle note, not an error', async () => {
  const bob = repo.getOrCreateTelegramUser(60060, 'bob');
  const restore = stubHouse();
  try {
    const r = await sd.fireSlot(bob, 7);
    assert.match(r.text, /don.t have a #7/i);
  } finally { restore(); }
});

test('firing with HA not connected returns the "ask the owner" message, not a crash', async () => {
  settings.setHomeAssistantConfig({ baseUrl: '', token: '' }); // disconnect
  const bob = repo.getOrCreateTelegramUser(60060, 'bob');
  const r = await sd.fireSlot(bob, 3);
  assert.match(r.text, /isn.t connected/i);
});

// ── limited-account lockdown ────────────────────────────────────────────────────────────────────────────

test('a LIMITED account reaches nothing but its pad — a stray message files no task', async () => {
  await sd.ownerCommand(owner, 'sd @carol 1 = turn off everything');
  await sd.ownerCommand(owner, 'sd @carol limit on');
  const carol = repo.getOrCreateTelegramUser(70070, 'carol');
  repo.linkSpeedDialAccount('carol', 70070);
  assert.ok(repo.isSpeedDialOnly(carol));

  const before = taskCount(carol);
  const r = await reply(carol, 'remind me to call the dentist tomorrow');
  assert.match(r, /speed dial/i, 'a non-dial message just shows the pad');
  assert.equal(taskCount(carol), before, 'nothing was filed as a task');
});

test('a LIMITED account CAN fire its numbers', async () => {
  const carol = repo.getOrCreateTelegramUser(70070, 'carol');
  const restore = stubHouse('All off');
  try {
    const r = await reply(carol, '1');
    assert.match(r, /All off/);
  } finally { restore(); }
});

test('a LIMITED account tapping a non-pad button just gets its pad back', async () => {
  const carol = repo.getOrCreateTelegramUser(70070, 'carol');
  const r = await handleAction(carol, 'm:hub:', { channel: 'telegram' });
  assert.match(r.text, /speed dial/i);
});

test('a LIMITED account tapping m:sd fires that slot', async () => {
  const carol = repo.getOrCreateTelegramUser(70070, 'carol');
  const restore = stubHouse('All off');
  try {
    const r = await handleAction(carol, 'm:sd:1', { channel: 'telegram' });
    assert.match(r.text, /All off/);
  } finally { restore(); }
});

// ── "0" is the reserved "show my pad" key + the one-time first-contact welcome ───────────────────────────

test('first contact rides the pad ALONGSIDE a full-account pad-holder’s first reply, once', async () => {
  await sd.ownerCommand(owner, 'sd @erin 1 = turn off everything'); // full account + pad (not limited)
  const erin = repo.getOrCreateTelegramUser(90090, 'erin');
  repo.linkSpeedDialAccount('erin', 90090);
  assert.ok(repo.hasSpeedDial(erin) && !repo.speedDialWelcomed(erin));

  const before = taskCount(erin);
  const first = await reply(erin, 'buy milk on the way home'); // first message → filed AND the pad shown
  assert.match(first, /speed dial/i, 'the pad rides alongside the first reply');
  assert.equal(taskCount(erin), before + 1, 'the first message is still processed (task filed), not swallowed');
  assert.ok(repo.speedDialWelcomed(erin), 'the welcome is stamped so it only rides once');

  const second = await reply(erin, 'buy bread on the way home'); // normal from here on — no pad
  assert.doesNotMatch(second, /speed dial/i, 'the pad rides only on the first contact');
  assert.equal(taskCount(erin), before + 2, 'normal flow continues');
});

test('sending a bare 0 shows the pad instead of firing slot 0; "dial 0" still fires it', async () => {
  await sd.ownerCommand(owner, 'sd @zoe 0 = arm the alarm');
  await sd.ownerCommand(owner, 'sd @zoe 1 = turn off the lights'); // full account + pad
  const zoe = repo.getOrCreateTelegramUser(91091, 'zoe');
  repo.linkSpeedDialAccount('zoe', 91091);
  await reply(zoe, 'hello'); // consume the welcome

  const restore = stubHouse('Alarm armed');
  try {
    const bare = await reply(zoe, '0');
    assert.match(bare, /speed dial/i, 'bare 0 shows the pad');
    assert.doesNotMatch(bare, /Alarm armed/, 'bare 0 did NOT fire slot 0');
    const dialed = await reply(zoe, 'dial 0');
    assert.match(dialed, /Alarm armed/, '"dial 0" still fires slot 0');
  } finally { restore(); }
});

test('a LIMITED account sending 0 gets its pad back (never fires slot 0)', async () => {
  await sd.ownerCommand(owner, 'sd @quinn 0 = arm the alarm');
  await sd.ownerCommand(owner, 'sd @quinn limit on');
  const quinn = repo.getOrCreateTelegramUser(92092, 'quinn');
  repo.linkSpeedDialAccount('quinn', 92092);
  // A limited account has no separate welcome (it sees the pad on every message via the lockdown gate).

  const restore = stubHouse('Alarm armed');
  try {
    const r = await reply(quinn, '0');
    assert.match(r, /speed dial/i, 'a limited account sending 0 sees the pad');
    assert.doesNotMatch(r, /Alarm armed/, 'a bare 0 does not fire slot 0, even when limited');
  } finally { restore(); }
});

// ── "a pad-holder never gets raw ha" ────────────────────────────────────────────────────────────────────

test('a non-limited pad-holder is redirected from raw "ha <command>" to their pad', async () => {
  await sd.ownerCommand(owner, 'sd @dave 1 = turn off the lights'); // dave: pad, NOT limited
  const dave = repo.getOrCreateTelegramUser(80080, 'dave');
  repo.linkSpeedDialAccount('dave', 80080);
  assert.ok(repo.hasSpeedDial(dave) && !repo.isSpeedDialOnly(dave));
  await reply(dave, 'hi'); // consume the one-time first-contact welcome so the /ha path below is exercised

  // Only reachable once HA is released system-wide (while it ships dark, the module is invisible to non-owners
  // — a stronger form of "no raw ha"). With it on, the slash form reaches the module's run(), where the guard
  // bounces a pad-holder to their pad instead of the Assist passthrough.
  settings.setSystemModules({ homeassistant: true });
  const r = await reply(dave, '/ha turn on the whole house');
  assert.match(r, /speed dial/i, 'raw ha is denied — the curated pad is their whole house access');
  settings.setSystemModules({ homeassistant: false });
});

test('a pad-holder cannot opt into Home Assistant (the pad is the whole grant)', async () => {
  settings.setSystemModules({ homeassistant: true });
  const dave = repo.getOrCreateTelegramUser(80080, 'dave');
  await reply(dave, 'optin ha');
  assert.ok(!settings.getUserFeatures(dave).homeassistant, 'the opt-in was blocked');
  settings.setSystemModules({ homeassistant: false });
});

test('a non-limited pad-holder still has a normal account (a statement files a task)', async () => {
  const dave = repo.getOrCreateTelegramUser(80080, 'dave');
  const before = taskCount(dave);
  await reply(dave, 'buy milk on the way home');
  assert.equal(taskCount(dave), before + 1, 'full-account use is unaffected by having a pad');
});

test('a non-limited pad-holder fires a bare digit via the normal command path (files no task)', async () => {
  const dave = repo.getOrCreateTelegramUser(80080, 'dave');
  const before = taskCount(dave);
  const restore = stubHouse('Lights off');
  try {
    const r = await reply(dave, '1'); // dave slot 1 was set above
    assert.match(r, /Lights off/);
    assert.equal(taskCount(dave), before, 'the digit fired the pad, it was not filed as a task');
  } finally { restore(); }
});

// ── web-payload merge feed ──────────────────────────────────────────────────────────────────────────────

test('accountsData merges pad accounts and reports house-connected state', () => {
  const d = sd.accountsData();
  const alice = d.accounts.find((a) => a.username === 'alice');
  assert.ok(alice, 'a configured account appears in the list');
  assert.equal(typeof d.houseConnected, 'boolean');
});

// ── web left-hint-bar pad summary (rides /api/sidebar) ──────────────────────────────────────────────────

test('padSummary returns the filled slots for a pad-holder, null for everyone else', () => {
  const dave = repo.getOrCreateTelegramUser(80080, 'dave'); // pad, slot 1 = "turn off the lights"
  const s = sd.padSummary(dave);
  assert.ok(s && Array.isArray(s.slots) && s.slots.length >= 1, 'a pad-holder gets slots');
  assert.deepEqual(s.slots.find((x) => x.slot === 1), { slot: 1, name: 'turn off the lights' });

  const nobody = repo.getOrCreateTelegramUser(99099, 'nopad');
  assert.equal(sd.padSummary(nobody), null, 'no pad → null (no card in the hint bar)');
});

// ── a locked-down account never gets vouch (can't grow the whitelist past its own lockdown) ──────────────

test('a LIMITED account is denied vouch even if the flag is on; a full-account pad-holder keeps it', () => {
  const carol = repo.getOrCreateTelegramUser(70070, 'carol'); // limit ON
  const dave = repo.getOrCreateTelegramUser(80080, 'dave');   // pad, limit OFF
  assert.ok(repo.isSpeedDialOnly(carol) && !repo.isSpeedDialOnly(dave));

  settings.setUserFeatures(carol, { vouch: true });
  settings.setUserFeatures(dave, { vouch: true });
  assert.equal(isFeatureOnFor(carol, 'vouch'), false, 'a locked-down account can never vouch');
  assert.equal(isFeatureOnFor(dave, 'vouch'), true, 'a non-limited pad-holder is a full account — vouch stands');
  assert.equal(isFeatureOnFor(owner, 'vouch'), true, 'the owner always vouches');
});
