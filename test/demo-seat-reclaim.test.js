// No-show reclaim (repo.reclaimStaleDemoSeats + scheduler wiring): a /demo self-signup reserves a seat by
// vouch, but if the person never sends a first message within the window that seat is holding capacity
// (MAX_VOUCHED_USERS) for nothing. The scheduler soft-revokes such unclaimed demo vouches so the seat frees
// up. Only the demo cohort is touched, and only rows that were never pinned (never messaged). Exercises the
// repo function directly with controlled timestamps — no live scheduler needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-reclaim-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const {
  addVouch, isVouched, countActiveVouches, listVouches, pinVouchTelegramId,
  getOrCreateDemoServiceUserId, DEMO_VOUCHER_NAME, reclaimStaleDemoSeats,
} = await import('../server/repo.js');

migrate();

const HOUR = 3600000;
const NOW = 1_700_000_000_000; // fixed clock so "older than" is deterministic
const TWO_H = 2 * HOUR;
// A demo self-signup exactly as routes/demo.js mints it: vouched in BY the demo service account.
const demoSignup = (username, agoHours) => addVouch({
  username, platform: 'telegram',
  voucherUserId: getOrCreateDemoServiceUserId(), voucherUsername: DEMO_VOUCHER_NAME,
  at: NOW - agoHours * HOUR,
});

test('no demo cohort yet: the sweep is a harmless no-op', () => {
  // Before /demo is ever used there is no service account, so nothing can be a demo signup.
  assert.deepEqual(reclaimStaleDemoSeats({ olderThanMs: TWO_H, now: NOW }), []);
});

test('a no-show older than the window is reclaimed; the seat frees and the row is soft-revoked by @demo', () => {
  demoSignup('noshow', 3); // signed up 3h ago, never messaged
  assert.ok(isVouched('noshow'));
  const before = countActiveVouches('telegram');

  const reclaimed = reclaimStaleDemoSeats({ olderThanMs: TWO_H, now: NOW });
  assert.deepEqual(reclaimed, ['noshow']);
  assert.equal(isVouched('noshow'), false, 'seat is no longer active');
  assert.equal(countActiveVouches('telegram'), before - 1, 'the seat is freed');

  // Soft-revoke, not delete: the row survives with revoked_at + revoked_by = the demo account (audit trail).
  const demoId = getOrCreateDemoServiceUserId();
  const row = listVouches().find((v) => v.username === 'noshow');
  assert.ok(row && row.revoked_at, 'row kept, revoked_at stamped');
  assert.equal(Number(row.revoked_by_user_id), demoId, 'revoked by the demo service account');
});

test('a signup INSIDE the window is left alone (they still have time to show up)', () => {
  demoSignup('fresh', 1); // only 1h old
  assert.deepEqual(reclaimStaleDemoSeats({ olderThanMs: TWO_H, now: NOW }), []);
  assert.ok(isVouched('fresh'), 'a recent signup keeps its seat');
});

test('a demo user who DID message (pinned) is never reclaimed, however old', () => {
  demoSignup('active', 5); // signed up 5h ago...
  pinVouchTelegramId('active', 987654, NOW - 4 * HOUR); // ...and messaged 4h ago (id pinned)
  assert.deepEqual(reclaimStaleDemoSeats({ olderThanMs: TWO_H, now: NOW }), []);
  assert.ok(isVouched('active'), 'a claimed seat is safe forever');
});

test('an owner\'s direct vouch is NOT part of the demo cohort and is never swept', () => {
  addVouch({ username: 'personal', platform: 'telegram', voucherUserId: 1, voucherUsername: 'owner', at: NOW - 10 * HOUR });
  assert.deepEqual(reclaimStaleDemoSeats({ olderThanMs: TWO_H, now: NOW }), []);
  assert.ok(isVouched('personal'), 'only /demo self-signups are reclaimed');
});

test('a reclaimed no-show can re-sign up and gets a fresh seat (UPSERT reactivation)', () => {
  demoSignup('boomerang', 3);
  assert.deepEqual(reclaimStaleDemoSeats({ olderThanMs: TWO_H, now: NOW }), ['boomerang']);
  assert.equal(isVouched('boomerang'), false);
  // Re-signup now (a brand new attempt) reactivates the row — they're back in with a fresh window.
  demoSignup('boomerang', 0);
  assert.ok(isVouched('boomerang'), 're-signup restores the seat');
  assert.deepEqual(reclaimStaleDemoSeats({ olderThanMs: TWO_H, now: NOW }), [], 'the fresh seat is not immediately reclaimed');
});

test('olderThanMs falsy disables the sweep entirely', () => {
  demoSignup('offswitch', 99);
  assert.deepEqual(reclaimStaleDemoSeats({ olderThanMs: 0, now: NOW }), [], 'window 0 = off');
  assert.ok(isVouched('offswitch'));
});
