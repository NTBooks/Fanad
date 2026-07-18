// One-shot startup backfill (server/linkBackfill.js): pre-v40 tasks that carry a URL but no stored preview
// get one fetched now. Self-terminating: even a failed fetch writes a record, so a second run touches
// nothing. Temp DB + mock LLM + stubbed globalThis.fetch, like ingest.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-test-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { insertTask, getTask, defaultUserId } = await import('../server/repo.js');
const { backfillLinkPreviews } = await import('../server/linkBackfill.js');

migrate();

const realFetch = globalThis.fetch;
const htmlResponse = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

test('backfill fills URL-bearing tasks; a bare-URL title upgrades, a user-worded title stays', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const uid = defaultUserId();
  // A bare-URL task whose title IS the raw URL (pre-feature capture).
  const bare = insertTask({ userId: uid, summary: 'https://example.com/a', originalText: 'https://example.com/a' });
  // A task the user worded, that happens to contain a URL.
  const worded = insertTask({ userId: uid, summary: 'read the docs', originalText: 'read the docs https://example.com/b' });
  // A task with no URL — must be left completely alone.
  const plain = insertTask({ userId: uid, summary: 'buy milk', originalText: 'buy milk' });

  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    return htmlResponse(`<meta property="og:title" content="${url.includes('/a') ? 'Page A' : 'Page B'}">`);
  };

  const res = await backfillLinkPreviews({ delayMs: 0 });
  assert.equal(res.filled, 2);
  assert.equal(calls, 2, 'only the two URL-bearing tasks are fetched');

  const bareAfter = getTask(uid, bare.id);
  assert.equal(bareAfter.summary, 'Page A');            // bare-URL title upgraded to the page title
  assert.equal(JSON.parse(bareAfter.link_json).status, 'ok');

  const wordedAfter = getTask(uid, worded.id);
  assert.equal(wordedAfter.summary, 'read the docs');   // user's title untouched
  assert.equal(JSON.parse(wordedAfter.link_json).url, 'https://example.com/b');

  const plainAfter = getTask(uid, plain.id);
  assert.equal(plainAfter.link_json, null);             // no URL → never touched
});

test('a failed fetch is recorded so a second run does nothing', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const uid = defaultUserId();
  // example.net resolves (public IP), so the SSRF DNS guard passes and the stubbed fetch runs — then throws.
  insertTask({ userId: uid, summary: 'https://example.net/x', originalText: 'https://example.net/x' });

  let calls = 0;
  globalThis.fetch = async () => { calls++; const e = new Error('nope'); e.name = 'TimeoutError'; throw e; };

  const first = await backfillLinkPreviews({ delayMs: 0 });
  assert.equal(first.filled, 1);
  assert.equal(calls, 1);

  const second = await backfillLinkPreviews({ delayMs: 0 });
  assert.equal(second.filled, 0, 'the stored error record means nothing is left to backfill');
  assert.equal(calls, 1, 'the dead site is not re-hammered');
});
