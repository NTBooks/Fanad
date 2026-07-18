// Metrics, chat-first: toggle gating, define/track/tally, the `measure` point command, and chart image
// payloads. §13. The eat/diet flow moved to its own module — see diet.test.js; here we only pin that
// eat now belongs to the Diet toggle, not this one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-metrics-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage } = await import('../server/chat.js');
const { setUserFeatures } = await import('../server/settings.js');

migrate();
const say = (text) => handleMessage({ text });

test('metric commands are blocked until the module is opted in', async () => {
  setUserFeatures(1, { metrics: false });
  assert.match((await say('track sleep 7')).reply, /Metrics are off/i);
});

test('prose starting with "track" is NOT mistaken for a command (no number → a task)', async () => {
  // metrics still off here — a real command would be blocked, but prose isn't a command at all.
  assert.match((await say('track down the missing invoice')).reply, /Filed/);
});

test('enabling metrics turns the commands on', async () => {
  setUserFeatures(1, { metrics: true });
});

test('metric add → track → tally (last aggregation)', async () => {
  assert.match((await say('metric add weight kg last')).reply, /Tracking weight/);
  assert.match((await say('track weight 182')).reply, /Logged weight: 182/);
  await say('track weight 181');
  assert.match((await say('/tally weight')).reply, /weight: 181/);
});

test('track auto-creates a sum metric and totals it', async () => {
  await say('track water 2');
  assert.match((await say('track water 3')).reply, /water: 5/);
});

test('metrics lists today\'s tallies', async () => {
  assert.match((await say('metrics')).reply, /Today/);
});

test('measure → a point metric shows its last reading in the tally', async () => {
  assert.match((await say('measure bp 120')).reply, /Measured/i);
  const tally = await say('tally');
  assert.match(tally.reply, /bp/i);
  assert.match(tally.reply, /last reading/i);
});

test('a metric with nothing today is hidden from the full tally, but shown when named', async () => {
  // Fresh metric, no values logged today ⇒ today aggregate is 0.
  await say('metric add pushups last');
  const full = await say('tally');
  assert.doesNotMatch(full.reply, /pushups/i, 'zero metric is omitted from the full tally');
  assert.match(full.reply, /water/i, 'logged metrics still appear');
  // Naming it explicitly always shows it, even at 0.
  assert.match((await say('/tally pushups')).reply, /pushups: 0/);
});

test('eat belongs to the Diet module now — metrics being on does not unlock it', async () => {
  assert.match((await say('eat 4 oz toast')).reply, /Diet is off/i);
});

test('undo takes back tracked entries too (app-wide stack), then reports nothing to undo when drained', async () => {
  await say('track water 5');
  assert.match((await say('undo')).reply, /Undid water: 5/i);
  // Drain whatever the earlier tests stacked up; the stack is capped, so this terminates fast.
  let last = '';
  for (let i = 0; i < 25; i++) {
    last = (await say('undo')).reply;
    if (/Nothing recent to undo/i.test(last)) break;
  }
  assert.match(last, /Nothing recent to undo/i);
});

test('/chart returns a PNG data-URI image payload', async () => {
  await say('track water 2');
  const r = await say('/chart water 7d');
  assert.ok(r.image && r.image.startsWith('data:image/png;base64,'), 'chart reply carries a PNG data-uri');
});
