// Emoji → mood → energy → suggestion sizing, and the fix that a mood persists across later plain
// messages instead of being wiped by them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-mood-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage } = await import('../server/chat.js');
const { clearDialogState } = await import('../server/dialog.js');
const { latestMood, defaultUserId } = await import('../server/repo.js');

migrate();
const uid = defaultUserId();
const say = (text) => { clearDialogState(uid); return handleMessage({ text }); };

test('an emoji sets a mood that persists across later plain messages', async () => {
  await say('😴');
  await say('hello there'); // no emoji — must NOT wipe the mood
  assert.match(latestMood(uid, 0) || '', /😴/);
});

test('a bright mood lifts energy and overrides time-of-day (→ high-energy suggestion)', async () => {
  await say('tidy the desk'); // a task to suggest
  await say('🥳');            // a high-energy emoji can ONLY come from mood (night would say low)
  assert.match((await say('/whatdo')).reply, /high energy/i);
});

test('a hungry emoji is read as low energy, not high', async () => {
  await say('🤤');
  const r = await say('/whatdo');
  assert.match(r.reply, /low energy/i);
  assert.doesNotMatch(r.reply, /high energy/i);
});

test('the status line carries your last expressed mood', async () => {
  await say('🥳');
  const r = await say('a quick errand'); // no emoji; status should still show 🥳
  assert.match(r.status.mood || '', /🥳/);
});

test('a mood word sets the matching emoji mood', async () => {
  await say('feeling salty about that meeting');
  assert.match(latestMood(uid, 0) || '', /😤/);
});

test('“overwhelmed” said in words reads as low energy', async () => {
  await say('honestly so overwhelmed right now');
  const r = await say('/whatdo');
  assert.match(r.reply, /low energy/i);
});

test('a bright mood word lifts energy to high', async () => {
  await say('clear the inbox'); // a task to suggest
  await say('feeling pumped');  // 💪 → high (can only come from mood)
  assert.match((await say('/whatdo')).reply, /high energy/i);
});

test('“mood overwhelmed” works as an explicit mood command', async () => {
  const r = await say('mood overwhelmed');
  assert.match(r.reply, /mood set/i);
  assert.match(latestMood(uid, 0) || '', /😵/);
});

test('a sent emoji is a reaction-only ack: kind:"mood" + moodEmoji (Telegram drops the "Mood set:" text)', async () => {
  const r = await say('😎');
  assert.equal(r.kind, 'mood', 'tagged so the adapter reacts instead of replying');
  assert.match(r.moodEmoji || '', /😎/, 'the reaction emoji is the one the user sent');
  // The text still rides in the envelope (web shows it; Telegram suppresses it) so nothing is lost.
  assert.match(r.reply, /Mood set/i);
});

test('a mood INFERRED from words still sends the text (no kind:"mood"), so you see which emoji was chosen', async () => {
  const r = await say('mood so tired right now');
  assert.equal(r.kind ?? null, null, 'no reaction-only ack — the chosen emoji must be shown');
  assert.match(r.reply, /Mood set: .*😴/);
});

test('the "/mood 😴" command form is also a reaction-only ack', async () => {
  const r = await say('/mood 😴');
  assert.equal(r.kind, 'mood');
  assert.match(r.moodEmoji || '', /😴/);
});

// ── kind:'ack' — a contentless emoji reply becomes a reaction on the user's message, never a jumbo bubble ──

test('a stray "ok" is a reaction-only ack: kind:"ack" + 👍, and the turn is never persisted', async () => {
  const r = await say('ok');
  assert.equal(r.kind, 'ack', 'tagged so every surface reacts instead of replying');
  assert.equal(r.ackEmoji, '👍');
  assert.equal(r.reaction, '👍', 'the web stamps the literal emoji on the user’s own message');
  assert.equal(r.reply, '👍', 'the text remains only as the no-reaction fallback');
  assert.equal(r.messageId, undefined, 'not stored — scroll-back must not replay a bubble no surface showed');
});

test('the done-feedback shrug acks with a 🌱 reaction, with worded fallback text (no jumbo emoji)', async () => {
  await say('feed the sourdough starter');
  // The suggestion → done → feedback chain rides on dialog state, so no clearDialogState between turns
  // (this file's say() clears it — use handleMessage directly).
  await handleMessage({ text: '/whatdo' });
  await handleMessage({ text: 'did it' });          // completes → arms done_feedback
  const r = await handleMessage({ text: 'OK' });    // answer the feedback prompt
  assert.equal(r.kind, 'ack');
  assert.equal(r.ackEmoji, '🌱');
  assert.match(r.reply, /\w+.*🌱/, 'fallback text carries a word so Telegram never renders it huge');
});

test('decideReaction: an ack is literal by default; a constrained pick (Telegram) falls back to 🫡', async () => {
  const { decideReaction, REACT_DONE } = await import('../shared/reaction.js');
  assert.equal(decideReaction({ kind: 'ack', ackEmoji: '🌱' }), '🌱');                       // web: literal
  const tgPick = (c) => c === '👍';                                                          // 🌱 not allowed
  assert.equal(decideReaction({ kind: 'ack', ackEmoji: '🌱' }, tgPick), REACT_DONE);
  assert.equal(decideReaction({ kind: 'ack', ackEmoji: '👍' }, tgPick), '👍');
});
