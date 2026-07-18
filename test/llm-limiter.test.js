// The global LLM concurrency gate (services/llm/limiter.js): at most LLM_MAX_CONCURRENCY provider calls
// in flight, FIFO queue up to LLM_QUEUE_MAX beyond that, LLM_BUSY on overflow. Pure in-process semantics —
// no DB, no provider needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LLM_MAX_CONCURRENCY = '2';
process.env.LLM_QUEUE_MAX = '2';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-limiter-')); // config.js creates it at import

const { acquire, release, limiterStats } = await import('../server/services/llm/limiter.js');

test('slots fill, excess queues FIFO, overflow throws LLM_BUSY, release drains in order', async () => {
  await acquire(); // slot 1
  await acquire(); // slot 2
  assert.deepEqual(limiterStats(), { inFlight: 2, queued: 0 });

  const order = [];
  const third = acquire().then(() => order.push('third'));
  const fourth = acquire().then(() => order.push('fourth'));
  assert.deepEqual(limiterStats(), { inFlight: 2, queued: 2 });

  // Queue is full: the fifth caller is refused SYNCHRONOUSLY (it never held a slot, so no release owed).
  assert.throws(acquire, (err) => err.code === 'LLM_BUSY');

  release(); // slot passes to `third` (inFlight unchanged — the slot transferred, not shrank)
  await third;
  assert.deepEqual(order, ['third']);
  assert.deepEqual(limiterStats(), { inFlight: 2, queued: 1 });

  release();
  await fourth;
  assert.deepEqual(order, ['third', 'fourth'], 'strict FIFO drain');

  release(); release();
  assert.deepEqual(limiterStats(), { inFlight: 0, queued: 0 });
});

test('a freed slot is reusable after the queue drains', async () => {
  await acquire();
  release();
  assert.deepEqual(limiterStats(), { inFlight: 0, queued: 0 });
});
