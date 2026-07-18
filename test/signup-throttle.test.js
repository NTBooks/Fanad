// The shared per-IP signup throttle primitive (server/signupThrottle.js): a windowed counter with three
// operations — count (read, prunes this ip), over (at/over a fixed max; 0 = off), record (stamp a hit +
// prune the map). Both the Telegram /demo form and the browser demo register are built from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSignupThrottle } from '../server/signupThrottle.js';

test('count/record: a hit is counted, distinct IPs are independent', () => {
  const t = createSignupThrottle({ windowMs: 60_000, max: 3 });
  assert.equal(t.count('a'), 0);
  t.record('a');
  t.record('a');
  assert.equal(t.count('a'), 2);
  assert.equal(t.count('b'), 0, 'a different address is unaffected');
});

test('over: true only at/above the fixed max; a 0 max is always off; record does not gate', () => {
  const t = createSignupThrottle({ windowMs: 60_000, max: 2 });
  assert.equal(t.over('a'), false);
  t.record('a');
  assert.equal(t.over('a'), false, '1 < 2');
  t.record('a');
  assert.equal(t.over('a'), true, '2 >= 2');

  const off = createSignupThrottle({ windowMs: 60_000, max: 0 });
  for (let i = 0; i < 10; i++) off.record('a');
  assert.equal(off.over('a'), false, 'max 0 → never over');
  assert.equal(off.count('a'), 10, 'but it still counts (for a live-cap comparison)');
});

test('entries outside the window are dropped (count/over both re-evaluate)', async () => {
  const t = createSignupThrottle({ windowMs: 20, max: 1 });
  t.record('a');
  assert.equal(t.over('a'), true);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(t.count('a'), 0, 'the old hit aged out of the window');
  assert.equal(t.over('a'), false);
});
