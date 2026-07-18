// services/manual.js — the manual parsed for the model. site/manual.html is authored in this repo, so these
// run against the real file: the parse must yield clean plain-text sections, and relevantExcerpt must pick
// the sections a question is actually about while honoring its char budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manualSections, relevantExcerpt } from '../server/services/manual.js';

test('the manual parses into many titled plain-text sections', () => {
  const secs = manualSections();
  assert.ok(Array.isArray(secs) && secs.length > 30, `only ${secs?.length} sections`);
  for (const s of secs) {
    assert.ok(s.title && s.text, `empty section: ${JSON.stringify(s).slice(0, 80)}`);
    assert.ok(!/<\/?(?:div|p|span|table|tr|td|h[1-6])\b/i.test(s.text), `HTML leaked into "${s.title}"`);
  }
});

test('entities are decoded (the book\'s own "guide <topic>" reads as typed)', () => {
  const help = manualSections().find((s) => /where to get help/i.test(s.title));
  assert.ok(help, 'no "Where to get help" section');
  assert.match(help.text, /guide <topic>/);
  assert.ok(!/&(?:amp|lt|gt|nbsp|rarr|mdash);/.test(help.text));
});

test('a reminder question ranks the deadlines/reminders section first', () => {
  const ex = relevantExcerpt('how do I set a reminder for a task?');
  assert.match(ex.split('\n\n')[0], /^## .*reminders/i);
});

test('the excerpt respects its char budget', () => {
  assert.ok(relevantExcerpt('task', 3000).length <= 3000);
  assert.ok(relevantExcerpt('how do tasks, notes, lists, journals and reminders work?').length <= 16000);
});

test('a question matching nothing still returns leading sections (the prompt refuses, not the code)', () => {
  const ex = relevantExcerpt('zzqx vvwy kkjj');
  assert.ok(ex.startsWith('## '), 'fallback excerpt missing');
  assert.match(ex, /## Quickstart/);
});
