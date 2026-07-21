// Speed Dial: owner-curated Home Assistant command pads for other Telegram accounts. Covers the owner
// authoring grammar (set/label/clear/limit/board), the username→account reconciliation on first contact
// (rename-proof pin, like vouches), the runtime pad lookup, firing a slot (converse() stubbed — no network),
// the "limited account" lockdown (reaches NOTHING but its 0-9 pad), and the "a pad-holder never gets raw ha"
// guard. All offline: HA is only "configured" for the fire tests, with global.fetch stubbed to a canned reply.
import { test, describe, before, after } from 'node:test';
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
const remote = await import('../server/routes/remote.js');

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

// Like stubHouse, but records the command text HA received (converse posts { text } as the JSON body), so a
// toggle test can assert WHICH of a slot's two commands fired. `last()` is the most recent command string.
function stubHouseCapturing(speech = 'ok') {
  settings.setHomeAssistantConfig({ baseUrl: 'http://127.0.0.1:8123', token: 'tok' });
  const real = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => {
    let text = '';
    try { text = JSON.parse(opts?.body || '{}').text || ''; } catch { /* not a converse call */ }
    seen.push(text);
    return { ok: true, json: async () => ({ response: { speech: { plain: { speech } } } }), text: async () => '' };
  };
  return { seen, last: () => seen[seen.length - 1] || '', restore: () => { global.fetch = real; } };
}

// Minimal Express res double for exercising the public remote-control route handlers directly.
function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  res.send = (s) => { res.body = s; return res; };
  res.type = () => res;
  res.set = (k, v) => { res.headers[k] = v; return res; };
  return res;
}

// ── owner authoring ──────────────────────────────────────────────────────────────────────────────────────

test('owner sets a slot with a label, and it authorizes + creates the account', async () => {
  await sd.ownerCommand(owner, 'sd @alice 1 = Kitchen | turn off the kitchen lights');
  const slots = repo.listSpeedDialSlots('alice');
  assert.equal(slots.length, 1);
  assert.deepEqual(slots[0], { slot: 1, label: 'Kitchen', command: 'turn off the kitchen lights', commandOff: '', toggleOn: false });
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

// ── on/off toggle slots (ON + OFF command; server-tracked position; one number, both ways) ───────────────
describe('on/off toggle slots', () => {
  // king #1 is a toggle (ON = "turn on king boo", OFF = "turn off king boo"); #2 is a plain one-shot.
  before(() => {
    sd.savePadData(owner, 'king', { slots: [
      { slot: 1, label: 'King Boo', command: 'turn on king boo', commandOff: 'turn off king boo' },
      { slot: 2, label: 'Door', command: 'lock the door' },
    ] });
    repo.getOrCreateTelegramUser(40040, 'king');
    repo.linkSpeedDialAccount('king', 40040);
  });

  test('savePadData persists the OFF command; a plain slot has none, and a toggle starts off', () => {
    const slots = repo.listSpeedDialSlots('king');
    const one = slots.find((s) => s.slot === 1);
    const two = slots.find((s) => s.slot === 2);
    assert.equal(one.commandOff, 'turn off king boo', 'the toggle keeps its second command');
    assert.equal(one.toggleOn, false, 'a freshly saved toggle starts off');
    assert.equal(two.commandOff, '', 'a one-shot slot has no OFF command');
  });

  test('fireSlot alternates the toggle command and flips the server-tracked position', async () => {
    const king = repo.getOrCreateTelegramUser(40040, 'king');
    const h = stubHouseCapturing('done');
    try {
      const on = await sd.fireSlot(king, 1);
      assert.match(h.last(), /turn on king boo/, 'first press runs the ON command');
      assert.doesNotMatch(on.text, /\(on\)|\(off\)/, 'the reply reports the house speech, NOT a guessed on/off state');
      assert.equal(repo.listSpeedDialSlots('king').find((s) => s.slot === 1).toggleOn, true, 'position flipped to on');

      await sd.fireSlot(king, 1);
      assert.match(h.last(), /turn off king boo/, 'the next press runs the OFF command');
      assert.equal(repo.listSpeedDialSlots('king').find((s) => s.slot === 1).toggleOn, false, 'position flipped back to off');
    } finally { h.restore(); }
  });

  test('a plain (one-shot) slot fires the same command every time and never flips', async () => {
    const king = repo.getOrCreateTelegramUser(40040, 'king');
    const h = stubHouseCapturing('done');
    try {
      await sd.fireSlot(king, 2);
      await sd.fireSlot(king, 2);
      assert.match(h.last(), /lock the door/, 'a one-shot always runs its single command');
      assert.equal(repo.listSpeedDialSlots('king').find((s) => s.slot === 2).toggleOn, false, 'nothing to flip');
    } finally { h.restore(); }
  });

  test('fireShareSlot alternates the toggle command too, and reports NO on/off state back', async () => {
    const h = stubHouseCapturing('done');
    try {
      const on = await sd.fireShareSlot('king', 1);
      assert.match(h.last(), /turn on king boo/, 'first press runs the ON command');
      assert.ok(on.ok && !('on' in on) && !('toggle' in on), 'no server-guessed state is sent to the remote page');
      await sd.fireShareSlot('king', 1);
      assert.match(h.last(), /turn off king boo/, 'the next press runs the OFF command');
      assert.equal(repo.listSpeedDialSlots('king').find((s) => s.slot === 1).toggleOn, false, 'position flipped back');
    } finally { h.restore(); }
  });

  test('shareRemoteData sends only { slot, name } — no command, and no guessed on/off state', () => {
    const rd = sd.shareRemoteData('king');
    assert.deepEqual(rd.slots.find((s) => s.slot === 1), { slot: 1, name: 'King Boo' }, 'a toggle is a bare { slot, name } too');
    assert.deepEqual(rd.slots.find((s) => s.slot === 2), { slot: 2, name: 'Door' });
    assert.doesNotMatch(JSON.stringify(rd), /turn (on|off) king boo/, 'the raw commands never reach the browser');
  });

  test('the owner Test button fires the command TYPED in the panel, saved or not', async () => {
    const h = stubHouseCapturing('ok');
    try {
      // Typed-but-unsaved fires verbatim — the fix for "#N failed: no #N" when testing before saving.
      const typed = await sd.testSlotData('king', 7, 'flash the lights');
      assert.ok(typed.ok && /flash the lights/.test(h.last()), 'a typed command is tested even with slot 7 empty');
      // No command → falls back to the saved slot's ON command.
      const fallback = await sd.testSlotData('king', 1);
      assert.ok(fallback.ok && /turn on king boo/.test(h.last()), 'empty command tests the saved ON command');
      // Nothing typed and nothing saved is the only real "no #N".
      const none = await sd.testSlotData('king', 7);
      assert.equal(none.ok, false);
      assert.match(none.error, /no #7/);
    } finally { h.restore(); }
  });
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

test('accountsData surfaces the connected Telegram bot @username for the printable sheet', async () => {
  const { setBotIdentity } = await import('../server/botStatus.js');
  assert.equal(sd.accountsData().botUsername, null, 'null when no bot is connected');
  setBotIdentity({ platform: 'telegram', username: 'MyHouseBot' });
  assert.equal(sd.accountsData().botUsername, 'MyHouseBot', 'the Telegram bot name is exposed to the panel');
  setBotIdentity({ platform: 'slack', username: 'slackbot' });
  assert.equal(sd.accountsData().botUsername, null, 'a Slack-only box exposes no Telegram bot name');
  setBotIdentity(null);
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

// ── shareable "remote control" links (the no-login guest surface) ────────────────────────────────────────
// A share link may only be minted on a box where everything ELSE on the origin requires auth, so these run
// with web login ON (the before hook). dave (id 80080) has slot 1 = "turn off the lights" from above.
describe('remote-control share links', () => {
  before(() => settings.setAuthConfig({ mode: 'simple' }));
  after(() => settings.setAuthConfig({ mode: 'none' }));

  test('minting is refused while web login is off — the link would not actually be limited', () => {
    settings.setAuthConfig({ mode: 'none' }); // login off: the whole origin is open, so no share link
    const r = sd.mintShareLink('dave', {});
    assert.ok(!r.ok && r.needsLogin, 'no link is minted without login');
    assert.equal(sd.accountsData().loginOn, false, 'the panel is told login is off (Generate is disabled)');
    settings.setAuthConfig({ mode: 'simple' });
    assert.equal(sd.accountsData().loginOn, true, 'and told when it is on');
  });

  // A link minted under login must FAIL CLOSED if the operator later drops the box back to open (mode 'none',
  // where /api is unauthenticated and impersonation, if set, is live). Checked at request time, not just mint.
  test('a live link stops working the moment web login is turned off', async () => {
    const m = sd.mintShareLink('dave', {}); // minted while login is on (the suite default)
    settings.setAuthConfig({ mode: 'none' });
    try {
      const page = fakeRes();
      remote.remotePageHandler({ params: { token: m.token } }, page);
      assert.doesNotMatch(page.body, /turn off the lights/, 'no buttons are served while the box is open');
      assert.match(page.body, /unavailable/i, 'the guest sees an unavailable notice, not the pad');
      const fire = fakeRes();
      await remote.remoteFireHandler({ params: { token: m.token }, body: { slot: 1 } }, fire);
      assert.equal(fire.statusCode, 403, 'firing is refused while login is off');
    } finally {
      settings.setAuthConfig({ mode: 'simple' });
    }
  });

  test('mintShareLink mints an fsd1_ token that resolves back to its pad', () => {
    const m = sd.mintShareLink('dave', { ttlDays: 7 });
    assert.ok(m.ok && m.token.startsWith('fsd1_'), 'a prefixed token comes back');
    assert.ok(m.path.startsWith('/r/fsd1_'), 'the path is the textable /r/<token>');
    const share = sd.resolveShare(m.token);
    assert.equal(share?.username, 'dave', 'the token resolves to its pad');
    assert.ok(share.expiresAt > Date.now(), 'it carries a future expiry');
  });

  test('mintShareLink clamps ttl to the offered set (default 7) and refuses an unknown pad', () => {
    assert.equal(sd.mintShareLink('dave', { ttlDays: 999 }).ttlDays, 7, 'a bad ttl falls back to the default');
    assert.equal(sd.mintShareLink('dave', { ttlDays: 1 }).ttlDays, 1, 'an offered ttl is honored');
    assert.equal(sd.mintShareLink('ghostpad', {}).ok, false, 'no pad → no link');
  });

  test('resolveShare rejects a bad prefix, an unknown, a revoked, and an expired token', () => {
    assert.equal(sd.resolveShare('nope'), null, 'wrong prefix');
    assert.equal(sd.resolveShare('fsd1_deadbeef'), null, 'unknown token');
    const revoked = sd.mintShareLink('dave', {});
    sd.revokeShareData('dave', revoked.id);
    assert.equal(sd.resolveShare(revoked.token), null, 'revoked token is dead');
    const aged = sd.mintShareLink('dave', {});
    db.prepare('UPDATE speed_dial_shares SET expires_at=? WHERE id=?').run(Date.now() - 1000, aged.id);
    assert.equal(sd.resolveShare(aged.token), null, 'expired token is dead');
  });

  test('shareRemoteData exposes only slot+name — never the @handle of whose pad it is', () => {
    const rd = sd.shareRemoteData('dave');
    assert.ok(rd.slots.find((s) => s.slot === 1 && s.name === 'turn off the lights'));
    assert.equal(typeof rd.houseConnected, 'boolean');
    assert.ok(!('username' in rd), 'the payload never carries the pad-holder handle');
  });

  test('fireShareSlot runs the stored command by username; a missing slot is a gentle no', async () => {
    const restore = stubHouse('Lights off');
    try {
      const r = await sd.fireShareSlot('dave', 1);
      assert.ok(r.ok && /Lights off/.test(r.speech), 'the owner-authored command fires');
      const miss = await sd.fireShareSlot('dave', 5);
      assert.equal(miss.ok, false, 'a slot the pad does not have returns ok:false, no throw');
    } finally { restore(); }
  });

  test('accountsData folds the active share links into the pad row', () => {
    const m = sd.mintShareLink('dave', { ttlDays: 30, label: 'dog sitter' });
    const dave = sd.accountsData().accounts.find((a) => a.username === 'dave');
    const link = dave.shares.find((s) => s.id === m.id);
    assert.ok(link && link.label === 'dog sitter' && link.expiresAt > Date.now(), 'the link shows up for the owner panel');
  });

  test('the public POST /r/:token/fire runs a predefined slot for a no-login guest', async () => {
    const m = sd.mintShareLink('dave', {});
    const restore = stubHouse('All off');
    try {
      const res = fakeRes();
      await remote.remoteFireHandler({ params: { token: m.token }, body: { slot: 1 } }, res);
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.ok && /All off/.test(res.body.speech), 'the house ran the command');
    } finally { restore(); }
  });

  test('the public fire route rejects a revoked link and an out-of-range slot', async () => {
    const m = sd.mintShareLink('dave', {});
    const bad = fakeRes();
    await remote.remoteFireHandler({ params: { token: m.token }, body: { slot: 42 } }, bad);
    assert.equal(bad.statusCode, 400, 'only 0-9 is a button');
    sd.revokeShareData('dave', m.id);
    const dead = fakeRes();
    await remote.remoteFireHandler({ params: { token: m.token }, body: { slot: 1 } }, dead);
    assert.equal(dead.statusCode, 403, 'a revoked link fires nothing');
  });

  test('the public GET /r/:token renders the buttons but never the pad-holder handle; a dead token shows an expired page', () => {
    const m = sd.mintShareLink('dave', {});
    const restore = stubHouse();
    try {
      const page = fakeRes();
      remote.remotePageHandler({ params: { token: m.token } }, page);
      assert.match(page.body, /turn off the lights/, 'the slot label renders');
      assert.doesNotMatch(page.body, /dave/, 'the guest never sees whose pad it is');
      assert.equal(page.headers['X-Robots-Tag'], 'noindex, nofollow', 'a share link is not indexable');
      assert.match(page.body, /class="fill"/, 'each button carries the press-fill element');
      assert.doesNotMatch(page.body, /class="state/, 'no on/off state pill is rendered (we can\'t read the device)');
    } finally { restore(); }
    const gone = fakeRes();
    remote.remotePageHandler({ params: { token: 'fsd1_nope' } }, gone);
    assert.match(gone.body, /isn.t active/i, 'a bad token gets a friendly expired page');
  });

  test('removing a pad cascades: its share links die with it', () => {
    sd.addAccountData(owner, 'grace');
    db.prepare("INSERT INTO speed_dials (username, slot, label, command, created_at, updated_at) VALUES ('grace',1,NULL,'open the garage',?,?)")
      .run(Date.now(), Date.now());
    const m = sd.mintShareLink('grace', {});
    assert.ok(sd.resolveShare(m.token), 'link is live while the pad exists');
    repo.deleteSpeedDialAccount('grace');
    assert.equal(sd.resolveShare(m.token), null, 'removing the pad kills the link');
    assert.deepEqual(repo.listSpeedDialShares('grace'), [], 'no share rows survive the pad');
  });

  // THE core scoping guarantee: a share link can ONLY drive its pad's fire route — it is not an API credential,
  // so it reaches nothing else on the box (tasks, notes, settings, another pad). Locked in as a regression.
  test('a share token unlocks ONLY the /r pad routes — never the /api surface', async () => {
    const auth = await import('../server/auth.js');
    const m = sd.mintShareLink('dave', {});

    assert.ok(sd.resolveShare(m.token), 'the share token drives its own remote page');
    // A share token is a DIFFERENT species from the CLI/API bearer (fnd1_): resolveCliToken refuses it outright.
    assert.equal(auth.resolveCliToken(m.token), null, 'a share token is not an API bearer token');

    // With the CLI surface on and login on (this suite), presenting it as Authorization: Bearer stamps NO
    // identity, so apiAuthGate 401s it — it can reach nothing under /api.
    settings.setAuthConfig({ cliEnabled: true });
    try {
      const req = { method: 'GET', headers: { authorization: `Bearer ${m.token}` }, webSession: null };
      auth.cliTokenMiddleware(req, {}, () => {});
      assert.equal(req.cliAuth, null, 'the share token grants no API identity');
      const res = fakeRes();
      let passed = false;
      auth.apiAuthGate(req, res, () => { passed = true; });
      assert.equal(passed, false, 'no fall-through to the API');
      assert.equal(res.statusCode, 401, 'the API is closed to a share token');
    } finally {
      settings.setAuthConfig({ cliEnabled: false });
    }
  });
});
