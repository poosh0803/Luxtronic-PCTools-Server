'use strict';

// Small in-memory cache of test_run_id -> { session_id, component }, so the telemetry WS handler
// doesn't have to hit Postgres for every single sample (expected rate ~1/sec/sensor per
// CONTRACT.md section 5, but a session can have several sensors and, in "together" mode, two
// concurrent test_runs). Populated on test-run creation and lazily on first telemetry message for
// a test_run_id the process doesn't know about yet (e.g. after a server restart mid-run). Entries
// are removed on test-run completion/auto-close since telemetry shouldn't arrive after that.

const pool = require('../../db/pool');

const cache = new Map(); // test_run_id -> { sessionId, component }

function set(testRunId, sessionId, component) {
  cache.set(testRunId, { sessionId, component });
}

function remove(testRunId) {
  cache.delete(testRunId);
}

async function get(testRunId) {
  const cached = cache.get(testRunId);
  if (cached) return cached;

  const { rows } = await pool.query('SELECT session_id, component FROM test_runs WHERE id = $1', [
    testRunId,
  ]);
  if (rows.length === 0) return null;
  const entry = { sessionId: rows[0].session_id, component: rows[0].component };
  cache.set(testRunId, entry);
  return entry;
}

module.exports = { set, remove, get };
