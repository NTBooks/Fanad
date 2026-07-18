// The "meant to log food?" hint: the mirror of the module nudge for when Diet is already ON. A captured
// statement that clearly reads like a food-diary paragraph still files an ordinary task, but gets a one-line
// teach of the `eat` command appended. Zero-token (pure regex), once a day, and PRECISION-FIRST — it must stay
// silent on ordinary food-mentioning tasks ("cook dinner for mom", "buy milk", "I had a rough day").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-eathint-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage } = await import('../server/chat.js');
const { setUserFeatures, setSetting } = await import('../server/settings.js');

migrate();
const uid = 1;
const HINT_RE = /Meant to log food/i;
// Reset the once-a-day gate so a test can observe the first-time hint deterministically.
const resetHint = () => setSetting(`daily_gate:eat_hint:${uid}`, 0);
const say = (text) => handleMessage({ text });

test('a food-diary paragraph (Diet ON) still files a task AND teaches the eat command', async () => {
  setUserFeatures(uid, { diet: true });
  resetHint();
  const r = await say('Today I ate yogurt for breakfast, then I had chicken and rice for dinner.');
  assert.match(r.reply, /Filed|✓/i, 'the statement is still captured as a task');
  assert.match(r.reply, HINT_RE, 'and the eat-command hint is appended');
});

test('a direct calorie ask (Diet ON) gets the hint', async () => {
  setUserFeatures(uid, { diet: true });
  resetHint();
  const r = await say('still trying to work out how many calories I ate today honestly');
  assert.match(r.reply, HINT_RE);
});

test('the hint is throttled to once a day', async () => {
  setUserFeatures(uid, { diet: true });
  resetHint();
  await say('I had a big lunch and a snack this afternoon.');
  const r = await say('I ate a huge dinner with dessert.');
  assert.doesNotMatch(r.reply, HINT_RE, 'a second food-log the same day is not nagged again');
});

test('no hint when Diet is off', async () => {
  setUserFeatures(uid, { diet: false });
  resetHint();
  const r = await say('Today I ate yogurt for breakfast and I had chicken for dinner.');
  assert.doesNotMatch(r.reply, HINT_RE);
});

test('ordinary food-mentioning tasks never trip the hint (precision)', async () => {
  setUserFeatures(uid, { diet: true });
  // None start with "eat"/"ate" (those are diet commands, not captures) and none should nag:
  const safe = [
    'cook dinner for mom',
    'buy milk and eggs',
    'the weight of the decision is heavy',
    'order meal prep containers',
    'I had a rough day and need to rest', // "I had" alone, no food word → must not fire
  ];
  for (const t of safe) {
    resetHint();
    const r = await say(t);
    assert.doesNotMatch(r.reply, HINT_RE, `should not nag on: ${t}`);
  }
});
