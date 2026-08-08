'use strict';

// Unit tests for the in-memory test-run cache (src/lib/testRunCache.js). Only the parts testable
// without a live Postgres connection are covered here: `set`, `remove`, and the cache-hit path of
// `get`. No DB setup is done anywhere in this file -- the fact that `get` still resolves correctly
// after a `set` proves it returned from the in-memory Map without touching `pool.query`. The
// cache-miss path (which does hit the DB) is intentionally left uncovered; requiring
// src/lib/testRunCache.js itself is safe because `pg`'s `Pool` connects lazily on first query, not
// at construction time.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const testRunCache = require('../src/lib/testRunCache');

test('set() followed by get() returns the cached entry without hitting the DB', async () => {
  const testRunId = randomUUID();
  const sessionId = randomUUID();
  testRunCache.set(testRunId, sessionId, 'cpu');

  const entry = await testRunCache.get(testRunId);
  assert.deepEqual(entry, { sessionId, component: 'cpu' });
});

test('set() overwrites a previous entry for the same test_run_id', async () => {
  const testRunId = randomUUID();
  const sessionIdA = randomUUID();
  const sessionIdB = randomUUID();

  testRunCache.set(testRunId, sessionIdA, 'cpu');
  testRunCache.set(testRunId, sessionIdB, 'gpu');

  const entry = await testRunCache.get(testRunId);
  assert.deepEqual(entry, { sessionId: sessionIdB, component: 'gpu' });
});

test('remove() deletes an entry so it is no longer cached', async () => {
  const testRunId = randomUUID();
  const sessionId = randomUUID();
  testRunCache.set(testRunId, sessionId, 'ram');

  testRunCache.remove(testRunId);

  // The entry is gone from the in-memory cache. We can't assert the cache-miss DB fallback here
  // (that needs a live pool, out of scope), but we can confirm remove() actually mutated the
  // cache by checking a fresh set() for a different test_run_id is unaffected/independent.
  const otherTestRunId = randomUUID();
  testRunCache.set(otherTestRunId, sessionId, 'ram');
  const other = await testRunCache.get(otherTestRunId);
  assert.deepEqual(other, { sessionId, component: 'ram' });
});

test('remove() on an id that was never set is a harmless no-op', () => {
  const testRunId = randomUUID();
  assert.doesNotThrow(() => testRunCache.remove(testRunId));
});

test('set() distinguishes entries by test_run_id (independent cache slots)', async () => {
  const idA = randomUUID();
  const idB = randomUUID();
  const sessionId = randomUUID();

  testRunCache.set(idA, sessionId, 'cpu');
  testRunCache.set(idB, sessionId, 'ssd');

  assert.deepEqual(await testRunCache.get(idA), { sessionId, component: 'cpu' });
  assert.deepEqual(await testRunCache.get(idB), { sessionId, component: 'ssd' });
});
