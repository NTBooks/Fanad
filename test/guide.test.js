// Topic guides — "guide <topic>" returns a deep walkthrough; the registry resolves aliases + reversed
// phrasing, and a non-topic "<x> guide" still files as a task.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-guide-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage, handleAction } = await import('../server/chat.js');
const { stripTags } = await import('../shared/richtext.js');
const vis = async (text) => stripTags((await say(text)).reply); // a guide reply is rich text → assert visible text
const { clearDialogState, setDialogState } = await import('../server/dialog.js');
const { defaultUserId } = await import('../server/repo.js');

migrate();
const uid = defaultUserId();
const say = (text) => { clearDialogState(uid); return handleMessage({ userId: uid, text }); };
// Notes & Lists are per-user opt-in (default off); opt the root user in so their guide topics resolve here.
(await import('../server/settings.js')).setUserFeatures(uid, { notes: true, lists: true });

test('guide steps returns the Steps guide', async () => {
  assert.match((await say('guide steps')).reply, /Guide: Steps/);
});

test('aliases and reversed phrasing all resolve to the steps guide', async () => {
  assert.match((await say('guide subtasks')).reply, /Guide: Steps/);
  assert.match((await say('subtask guide')).reply, /Guide: Steps/);
  assert.match((await say('guide checklist')).reply, /Guide: Steps/);
});

test('bare guide / help pop the tappable topic hub (sections, not a wall)', async () => {
  for (const word of ['guide', 'help', '/guide', '/help']) {
    const r = await say(word);
    assert.match(r.reply, /guide/i, `${word} → a short guide intro`);
    const chips = r.buttons.flat();
    assert.ok(chips.some((b) => b.data === 'guide steps'), `${word} → a Steps topic chip`);
    assert.ok(chips.some((b) => b.data === 'rules') && chips.some((b) => b.data === 'howto'), `${word} → rules + getting-started`);
    assert.ok(chips.some((b) => b.data === '/menu'), `${word} → a link to the full command menu`);
  }
});

test('a resolved topic guide carries a "‹ All topics" footer back to the hub', async () => {
  const r = await say('guide steps');
  assert.match(r.reply, /Guide: Steps/);
  assert.ok(r.buttons.flat().some((b) => b.data === 'guide'), 'one tap back to the hub');
});

test('/commands pops the tappable section hub; a section expands to its commands', async () => {
  const hub = await say('/commands');
  assert.ok(hub.buttons.flat().some((b) => b.data === 'm:cmd:tasks'), 'a ▶ Tasks section button');
  const tasks = await handleAction(uid, 'm:cmd:tasks');   // expand it → the real command lines
  assert.match(tasks.text, /\/whatdo/);
});

// Regression: an OPEN question used to swallow a bare "guide"/"help" (one-word statement → default 'answer').
// They must escape and pop the hub instead — while a task-shaped "help me …" still answers/captures.
test('bare guide / help escape an open question and reach the hub', async () => {
  for (const word of ['guide', 'help']) {
    setDialogState(uid, { type: 'task_filter', prompt: 'narrow tasks', data: { options: ['work'] } });
    const r = await handleMessage({ userId: uid, text: word }); // NB: no clearDialogState — the dialog is live
    assert.ok(r.buttons?.flat().some((b) => b.data === 'guide steps'), `"${word}" mid-dialog should reach the hub`);
  }
  clearDialogState(uid);
});

test('guide <unknown topic> lists the available topics', async () => {
  assert.match((await say('guide flumox')).reply, /I have: steps/);
});

test('"travel guide" with no such topic files as a task (the guard holds)', async () => {
  assert.match((await say('travel guide')).reply, /Filed/);
});

test('the four new topic guides each resolve', async () => {
  assert.match(await vis('guide reminders'), /Reminders & dates/);
  assert.match(await vis('guide capturing'), /Capturing & categories/);
  assert.match(await vis('guide suggestions'), /Suggestions & a gentle/);
  assert.match(await vis('guide notes'), /Notes, recall/);
});

test('aliases + reversed phrasing reach the new guides', async () => {
  assert.match(await vis('guide deadlines'), /Reminders & dates/);   // alias → reminders
  assert.match(await vis('photo guide'), /Notes, recall/);           // reversed phrasing → notes
  assert.match(await vis('guide categories'), /Capturing & categories/);
  assert.match(await vis('guide whatdo'), /Suggestions & a gentle/);
});

test('the unknown-guide fallback lists every always-on topic', async () => {
  const r = (await say('guide flumox')).reply;
  for (const topic of ['steps', 'reminders', 'capturing', 'suggestions', 'notes']) {
    assert.match(r, new RegExp(topic));
  }
});

test('guide metrics is gated by the Metrics module (off → offer to turn it on; on → the guide)', async () => {
  const { setUserFeatures } = await import('../server/settings.js');

  setUserFeatures(uid, { metrics: false });
  assert.match((await say('guide metrics')).reply, /Metrics are off/i);          // gated off
  assert.doesNotMatch((await say('guide flumox')).reply, /metrics/);             // not advertised when off

  setUserFeatures(uid, { metrics: true });
  assert.match((await say('guide metrics')).reply, /Guide: Metrics/);            // resolves when on
  assert.match((await say('metrics guide')).reply, /Guide: Metrics/);           // reversed phrasing too
  assert.match((await say('guide flumox')).reply, /metrics/);                   // advertised when on

  setUserFeatures(uid, { metrics: false });                                      // restore
});
