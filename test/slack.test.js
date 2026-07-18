// Slack adapter: migrations, block assembly, auth (fail-closed), and platform-namespaced vouches. No live
// Slack connection needed — buildSlackMessage is pure, and handleIncomingSlack is unit-testable like the
// Telegram handler. (slack.js imports @slack/bolt only lazily inside startSlack, so importing it here is safe.)
// NOTE: real Slack user ids are uppercase-alphanumeric (e.g. U01ABC23DE) — the allowlist/mention paths only
// treat a token as an id when it matches /^[UW][A-Z0-9]{6,}$/, so the fixtures below use that shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-slack-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate, db } = await import('../server/db.js');
const { buildSlackMessage, onSlackAction, noteChannelTs } = await import('../server/channels/slack.js');
const { CLOSE_BTN } = await import('../server/menu.js');
const { handleIncomingSlack, isAuthorizedSlack } = await import('../server/channels/slack-handler.js');
const { setSlackConfig } = await import('../server/settings.js');
const {
  isVouched, isVouchedSlack, addVouch, revokeVouchCascade, getOrCreateSlackUser, listTasks,
  insertTask, getTask,
} = await import('../server/repo.js');

migrate();

const resetSlack = () => setSlackConfig({ ownerSlackId: null, allowedSlack: '', enabled: true });

// ── migrations: the schema actually supports Slack ──
test('migrations: users.slack_id exists and is uniquely indexed', () => {
  const at = Date.now();
  db.prepare('INSERT INTO users (slack_id, display_name, created_at, last_seen_at) VALUES (?,?,?,?)').run('UMIG0001', 'mig', at, at);
  assert.throws(() => db.prepare('INSERT INTO users (slack_id, display_name, created_at, last_seen_at) VALUES (?,?,?,?)').run('UMIG0001', 'dup', at, at), /UNIQUE|constraint/i);
});

test("migrations: messages.channel now accepts 'slack' (and still rejects bogus)", () => {
  const at = Date.now();
  assert.doesNotThrow(() => db.prepare('INSERT INTO messages (user_id, channel, text, received_at) VALUES (1,?,?,?)').run('slack', 'hi', at));
  assert.throws(() => db.prepare('INSERT INTO messages (user_id, channel, text, received_at) VALUES (1,?,?,?)').run('bogus', 'hi', at), /CHECK|constraint/i);
});

test('migrations: vouches are namespaced — same string coexists across platforms', () => {
  addVouch({ platform: 'telegram', username: 'alice', voucherUserId: 1 });
  addVouch({ platform: 'slack', username: 'alice', voucherUserId: 1 }); // same string, different namespace
  assert.equal(isVouched('alice'), true);            // telegram (default)
  assert.equal(isVouched('alice', 'slack'), true);   // slack — independent row, no collision
});

// ── block assembly (pure) ──
test('a plain reply → one mrkdwn section + a stripped notification fallback', () => {
  const { blocks, text } = buildSlackMessage({ reply: 'all done', html: false });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'section');
  assert.equal(blocks[0].text.text, 'all done');
  assert.equal(text, 'all done');
});

test('an html reply converts to mrkdwn; the notification text is plain', () => {
  const { blocks, text } = buildSlackMessage({ reply: '<b>Filed</b> <i>errand</i>', html: true });
  assert.equal(blocks[0].text.text, '*Filed* _errand_');
  assert.equal(text, 'Filed errand');
});

test('button rows become actions blocks, wrapping at 5; value carries the menu token', () => {
  const row = Array.from({ length: 7 }, (_, k) => ({ text: `b${k}`, data: `a:done:${k}` }));
  const { blocks } = buildSlackMessage({ reply: 'pick', buttons: [row] });
  const actions = blocks.filter((b) => b.type === 'actions');
  assert.equal(actions.length, 2);               // 7 buttons → 5 + 2
  assert.equal(actions[0].elements.length, 5);
  assert.equal(actions[1].elements.length, 2);
  const btn = actions[0].elements[0];
  assert.match(btn.action_id, /^fanad_action_/);
  assert.equal(btn.value, 'a:done:0');
  assert.equal(btn.type, 'button');
});

test('legacy options render as buttons whose value is the option string', () => {
  const { blocks } = buildSlackMessage({ reply: 'pick', options: ['yes', 'no', 'smaller'] });
  const actions = blocks.filter((b) => b.type === 'actions');
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0].elements.map((e) => e.value), ['yes', 'no', 'smaller']);
});

test('output shows the "$" command sigil in body and button labels, but values keep "/"', () => {
  const { blocks, text } = buildSlackMessage({ reply: '1. Buy milk · ✓ /done_1', html: false, options: ['/whatdo', '/tasks'] });
  assert.equal(blocks[0].text.text, '1. Buy milk · ✓ $done_1'); // body uses $
  assert.match(text, /\$done_1/);                               // notification fallback too
  const els = blocks.filter((b) => b.type === 'actions')[0].elements;
  assert.deepEqual(els.map((e) => e.text.text), ['$whatdo', '$tasks']); // labels show $
  assert.deepEqual(els.map((e) => e.value), ['/whatdo', '/tasks']);     // values keep / (tap is server-side)
});

test('structured buttons take precedence over options (mirrors Telegram)', () => {
  const { blocks } = buildSlackMessage({ reply: 'x', buttons: [[{ text: 'Done', data: 'a:done:1' }]], options: ['yes'] });
  const values = blocks.filter((b) => b.type === 'actions').flatMap((a) => a.elements.map((e) => e.value));
  assert.deepEqual(values, ['a:done:1']);
});

test('a scheduler push (wake-up/reminder/ding) carries the ✕ dismiss block — parity with Telegram', () => {
  // sendSlack builds its DM exactly this way; the ✕'s m:hide:x tap routes to handleAction, whose
  // hide:true deletes the message (same affordance sendTelegram attaches to every push).
  const { blocks } = buildSlackMessage({ reply: '🔔 Reminder: “water the plants” — it\'s time.', buttons: [[CLOSE_BTN]] });
  const values = blocks.filter((b) => b.type === 'actions').flatMap((a) => a.elements.map((e) => e.value));
  assert.deepEqual(values, ['m:hide:x']);
});

test('a long body chunks into ≤3000-char sections and is capped at 50 blocks with a truncation marker', () => {
  const huge = 'x'.repeat(3000 * 60); // one very long line → hard-split into 60 chunks, over the 50-block cap
  const { blocks } = buildSlackMessage({ reply: huge, html: false });
  assert.ok(blocks.length <= 50);
  assert.ok(blocks.every((bl) => bl.type !== 'section' || bl.text.text.length <= 3000));
  assert.match(blocks[blocks.length - 1].text.text, /truncated/);
});

// ── auth (fail-closed), DM-only, owner-claim, allowlist, vouch ──
test('first DM-er claims the bot; a different stranger is then turned away (silently)', async () => {
  resetSlack();
  const r = await handleIncomingSlack({ text: 'water the plants', slackUserId: 'UOWNER01' });
  assert.match(r.reply, /Filed/);
  assert.equal((await handleIncomingSlack({ text: 'let me in', slackUserId: 'USTRGER1' })).reply, null);
});

test('non-DM channel types are ignored silently', async () => {
  resetSlack();
  assert.equal((await handleIncomingSlack({ text: 'hi', slackUserId: 'UXXXX001', channelType: 'channel' })).reply, null);
});

test('allowlist accepts a Slack id OR an @handle; everyone else is dropped', async () => {
  setSlackConfig({ ownerSlackId: null, allowedSlack: 'UALLOW01, @handly', enabled: true });
  assert.match((await handleIncomingSlack({ text: 'clean the garage', slackUserId: 'UALLOW01' })).reply, /Filed/);
  assert.match((await handleIncomingSlack({ text: 'mop the floor', slackUserId: 'UOTHER01', slackUsername: 'handly' })).reply, /Filed/);
  assert.equal((await handleIncomingSlack({ text: 'nope', slackUserId: 'UNOBODY1', slackUsername: 'rando' })).reply, null);
});

test('a vouched-in Slack id gets in; isAuthorizedSlack agrees', async () => {
  setSlackConfig({ ownerSlackId: 'UHOST001', allowedSlack: 'UHOST001', enabled: true });
  assert.equal(isAuthorizedSlack({ slackUserId: 'UGUEST01' }), false);
  addVouch({ platform: 'slack', username: 'UGUEST01', voucherUserId: 1 });
  assert.equal(isVouchedSlack('UGUEST01'), true);
  assert.equal(isAuthorizedSlack({ slackUserId: 'UGUEST01' }), true);
  assert.match((await handleIncomingSlack({ text: 'walk the dog', slackUserId: 'UGUEST01' })).reply, /Filed/);
});

test('"vouch <@Uxxx>" records a Slack-namespaced vouch (not a Telegram one)', async () => {
  setSlackConfig({ ownerSlackId: 'UHOST001', allowedSlack: 'UHOST001', enabled: true });
  const r = await handleIncomingSlack({ text: 'vouch <@UNEWBIE1>', slackUserId: 'UHOST001' });
  assert.match(r.reply, /Vouched/);
  assert.equal(isVouchedSlack('UNEWBIE1'), true);
  assert.equal(isVouched('UNEWBIE1'), false); // NOT in the Telegram namespace
});

test('revoke is platform-scoped — revoking a Telegram handle leaves an identically-named Slack vouch', () => {
  addVouch({ platform: 'telegram', username: 'bob', voucherUserId: 1 });
  addVouch({ platform: 'slack', username: 'bob', voucherUserId: 1 });
  revokeVouchCascade('bob', { byUserId: 1, platform: 'telegram' });
  assert.equal(isVouched('bob'), false);          // telegram revoked
  assert.equal(isVouched('bob', 'slack'), true);  // slack untouched
});

test('a Slack capture is scoped to its OWN user (separate from root and other Slack users)', async () => {
  resetSlack();
  await handleIncomingSlack({ text: 'buy milk', slackUserId: 'USOLO001' });
  const uid = getOrCreateSlackUser('USOLO001');
  assert.ok(listTasks(uid).some((t) => /milk/.test(t.summary)));
});

test('a "$command" typed on Slack is accepted (restored to "/command" for the brain)', async () => {
  resetSlack();
  await handleIncomingSlack({ text: 'wash the car', slackUserId: 'UDOLLAR1' }); // claim + seed a task
  const viaDollar = await handleIncomingSlack({ text: '$tasks', slackUserId: 'UDOLLAR1' });
  assert.match(viaDollar.reply, /car|No open/i);          // "$tasks" routed like the tasks command…
  assert.doesNotMatch(viaDollar.reply, /don.t know/i);    // …not bounced as an unknown command
});

// ── the tapped-button handler (onSlackAction is module-level so a fake Bolt payload can drive it) ──
function fakeSlackClient() {
  const calls = { post: [], update: [], ephemeral: [], deleted: [] };
  let nextTs = 9000;
  return {
    calls,
    users: { info: async () => ({ user: { name: 'btnuser', profile: { display_name: 'Button User' } } }) },
    chat: {
      postMessage: async (o) => { calls.post.push(o); return { ts: `${nextTs++}.000100` }; },
      update: async (o) => { calls.update.push(o); return {}; },
      postEphemeral: async (o) => { calls.ephemeral.push(o); return {}; },
      delete: async (o) => { calls.deleted.push(o); return {}; },
    },
    files: { uploadV2: async () => ({}) },
  };
}
const tapPayload = (client, { data, ts, channel = 'CBTN0001', blocks = [] }) => ({
  ack: async () => {},
  body: { channel: { id: channel }, user: { id: 'UBTN0001' }, message: { ts, text: 'old card body', blocks } },
  action: { value: data },
  client,
});

test('a structured start tap on the LATEST message edits the card in place — with its body intact', async () => {
  setSlackConfig({ ownerSlackId: 'UBTN0001', allowedSlack: 'UBTN0001', enabled: true });
  const uid = getOrCreateSlackUser('UBTN0001');
  const t = insertTask({ userId: uid, summary: 'slack latest card', category: 'other' });
  const client = fakeSlackClient();
  noteChannelTs('CLATEST1', '100.000500');
  await onSlackAction(tapPayload(client, { data: `a:start:${t.id}`, ts: '100.000500', channel: 'CLATEST1' }));
  assert.equal(client.calls.post.length, 0, 'no fresh message');
  assert.equal(client.calls.update.length, 1, 'edited in place');
  const body = client.calls.update[0].blocks.filter((b) => b.type === 'section').map((b) => b.text.text).join('\n');
  assert.match(body, /Started/, 'the updated card keeps its text (reply/text mapping)');
  assert.equal(getTask(uid, t.id).status, 'in_progress');
});

test('a structured start tap on an OLDER message posts a fresh Started card and strips the old actions', async () => {
  setSlackConfig({ ownerSlackId: 'UBTN0001', allowedSlack: 'UBTN0001', enabled: true });
  const uid = getOrCreateSlackUser('UBTN0001');
  const t = insertTask({ userId: uid, summary: 'slack buried card', category: 'other' });
  const client = fakeSlackClient();
  noteChannelTs('CSTALE01', '200.000900');                 // the DM has moved on past the tapped card
  const oldBlocks = [
    { type: 'section', text: { type: 'mrkdwn', text: 'old card body' } },
    { type: 'actions', elements: [] },
  ];
  await onSlackAction(tapPayload(client, { data: `a:start:${t.id}`, ts: '200.000100', channel: 'CSTALE01', blocks: oldBlocks }));
  assert.equal(client.calls.post.length, 1, 'fresh Started card posted');
  assert.match(client.calls.post[0].text, /Started/);
  assert.equal(client.calls.update.length, 1, 'old card updated once');
  assert.ok(client.calls.update[0].blocks.every((b) => b.type !== 'actions'), 'old card lost its buttons');
  assert.match(client.calls.update[0].blocks[0].text.text, /old card body/, 'old card text stays as history');
  assert.equal(getTask(uid, t.id).status, 'in_progress');
});

test('a non-start tap on an older message still edits in place (scope is start only)', async () => {
  setSlackConfig({ ownerSlackId: 'UBTN0001', allowedSlack: 'UBTN0001', enabled: true });
  const uid = getOrCreateSlackUser('UBTN0001');
  const t = insertTask({ userId: uid, summary: 'slack prio card', category: 'other' });
  const client = fakeSlackClient();
  noteChannelTs('CPRIO001', '300.000900');
  await onSlackAction(tapPayload(client, { data: `a:prio:${t.id}:3`, ts: '300.000100', channel: 'CPRIO001' }));
  assert.equal(client.calls.post.length, 0);
  assert.equal(client.calls.update.length, 1);
  assert.equal(getTask(uid, t.id).priority, 3);
});
