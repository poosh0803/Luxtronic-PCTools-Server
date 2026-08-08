'use strict';

// PC-client REST endpoints, CONTRACT.md section 4 "PC client (auth required)" table.
// Each route below applies requireApiKey() individually (rather than a blanket router.use()) --
// this router is mounted unpathed at the app root (see src/app.js) alongside the no-auth
// dashboard router, and an unpathed router.use() middleware would still run for every request
// that flows through this router even when none of its routes match, which would incorrectly
// gate dashboard requests too.

const express = require('express');
const pool = require('../../db/pool');
const { loadConfig } = require('../config');
const { requireApiKey } = require('../lib/auth');
const { checkConcurrency } = require('../lib/concurrency');
const { computeResult } = require('../lib/resultComputation');
const {
  isNonEmptyString,
  isValidComponent,
  isValidSessionType,
  isValidStopReason,
  isValidUuid,
} = require('../lib/validation');
const testRunCache = require('../lib/testRunCache');
const hub = require('../ws/hub');

const router = express.Router();

// GET /api/config -- CONTRACT.md section 3/4. Returns the full config file (all component
// subtrees + concurrency), not a single-component slice: the endpoint takes no parameters and the
// client needs the concurrency subtree regardless of which component(s) it's about to run, plus
// potentially more than one component subtree in "cpu+gpu together" mode. Judgment call flagged in
// the final report since CONTRACT.md doesn't pin down the exact response shape here.
router.get('/api/config', requireApiKey(), (req, res) => {
  try {
    const config = loadConfig();
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: 'config_error', message: err.message });
  }
});

// POST /api/sessions
router.post('/api/sessions', requireApiKey(), async (req, res, next) => {
  const { mobo_serial, customer_name, session_type, notes, ssd_serials, other_serials } =
    req.body || {};

  if (!isNonEmptyString(mobo_serial)) {
    return res.status(400).json({ error: 'invalid_request', message: 'mobo_serial is required' });
  }
  if (!isValidSessionType(session_type)) {
    return res
      .status(400)
      .json({ error: 'invalid_request', message: 'session_type must be new_build or repair' });
  }
  if (ssd_serials !== undefined && !Array.isArray(ssd_serials)) {
    return res.status(400).json({ error: 'invalid_request', message: 'ssd_serials must be an array' });
  }
  if (other_serials !== undefined && (typeof other_serials !== 'object' || Array.isArray(other_serials))) {
    return res
      .status(400)
      .json({ error: 'invalid_request', message: 'other_serials must be an object' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO machines (mobo_serial) VALUES ($1)
       ON CONFLICT (mobo_serial) DO UPDATE SET last_seen_at = now()`,
      [mobo_serial]
    );
    const { rows } = await client.query(
      `INSERT INTO sessions
         (mobo_serial, technician_id, customer_name, session_type, notes, ssd_serials, other_serials)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        mobo_serial,
        req.technician.id,
        customer_name ?? null,
        session_type,
        notes ?? null,
        JSON.stringify(ssd_serials ?? []),
        JSON.stringify(other_serials ?? {}),
      ]
    );
    await client.query('COMMIT');
    res.status(201).json({ session_id: rows[0].id });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// POST /api/sessions/:id/test-runs
router.post('/api/sessions/:id/test-runs', requireApiKey(), async (req, res, next) => {
  const sessionId = req.params.id;
  const { component } = req.body || {};

  if (!isValidUuid(sessionId)) {
    return res.status(400).json({ error: 'invalid_request', message: 'invalid session id' });
  }
  if (!isValidComponent(component)) {
    return res
      .status(400)
      .json({ error: 'invalid_request', message: 'component must be one of cpu, gpu, ram, ssd' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Serialize concurrent "start a test-run" requests for the same session so two racing
    // requests can't both observe an empty active-set and both get admitted.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sessionId]);

    const sessionRes = await client.query(
      'SELECT id, ended_at FROM sessions WHERE id = $1',
      [sessionId]
    );
    if (sessionRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found', message: 'session not found' });
    }
    if (sessionRes.rows[0].ended_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'session_ended', message: 'session has already ended' });
    }

    const activeRes = await client.query(
      'SELECT component FROM test_runs WHERE session_id = $1 AND ended_at IS NULL',
      [sessionId]
    );
    const activeComponents = activeRes.rows.map((r) => r.component);

    const check = checkConcurrency(activeComponents, component);
    if (!check.ok) {
      await client.query('ROLLBACK');
      return res
        .status(409)
        .json({ error: 'exclusive_conflict', active_component: check.active_component });
    }

    const config = loadConfig();
    const configSnapshot = config[component] || {};

    const insertRes = await client.query(
      `INSERT INTO test_runs (session_id, component, config_snapshot)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [sessionId, component, JSON.stringify(configSnapshot)]
    );
    const testRunId = insertRes.rows[0].id;

    await client.query('COMMIT');

    testRunCache.set(testRunId, sessionId, component);
    hub.publish(sessionId, {
      type: 'test_run_status',
      test_run_id: testRunId,
      component,
      status: 'started',
      result: null,
    });

    res.status(201).json({ test_run_id: testRunId });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// PATCH /api/sessions/:id/test-runs/:test_run_id
router.patch('/api/sessions/:id/test-runs/:test_run_id', requireApiKey(), async (req, res, next) => {
  const sessionId = req.params.id;
  const testRunId = req.params.test_run_id;
  const { tool_exit_code, tool_output_raw, summary_stats, stop_reason } = req.body || {};

  if (!isValidUuid(sessionId) || !isValidUuid(testRunId)) {
    return res.status(400).json({ error: 'invalid_request', message: 'invalid id' });
  }
  if (stop_reason !== undefined && stop_reason !== null && !isValidStopReason(stop_reason)) {
    return res.status(400).json({
      error: 'invalid_request',
      message: 'stop_reason must be one of user_abort, tool_crash, client_error',
    });
  }
  if (tool_exit_code !== undefined && tool_exit_code !== null && typeof tool_exit_code !== 'number') {
    return res.status(400).json({ error: 'invalid_request', message: 'tool_exit_code must be a number' });
  }
  if (
    summary_stats !== undefined &&
    summary_stats !== null &&
    (typeof summary_stats !== 'object' || Array.isArray(summary_stats))
  ) {
    return res.status(400).json({ error: 'invalid_request', message: 'summary_stats must be an object' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const runRes = await client.query(
      'SELECT id, session_id, component, ended_at FROM test_runs WHERE id = $1 AND session_id = $2 FOR UPDATE',
      [testRunId, sessionId]
    );
    if (runRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found', message: 'test_run not found' });
    }
    const run = runRes.rows[0];
    if (run.ended_at) {
      await client.query('ROLLBACK');
      return res
        .status(409)
        .json({ error: 'already_completed', message: 'test_run already has an ended_at' });
    }

    const config = loadConfig();
    const { result } = computeResult(run.component, config, summary_stats, stop_reason);

    await client.query(
      `UPDATE test_runs
       SET ended_at = now(),
           tool_exit_code = $1,
           tool_output_raw = $2,
           summary_stats = $3,
           result = $4,
           stop_reason = $5
       WHERE id = $6`,
      [
        tool_exit_code ?? null,
        tool_output_raw ?? null,
        JSON.stringify(summary_stats ?? {}),
        result,
        stop_reason ?? null,
        testRunId,
      ]
    );

    await client.query('COMMIT');

    testRunCache.remove(testRunId);
    hub.publish(sessionId, {
      type: 'test_run_status',
      test_run_id: testRunId,
      component: run.component,
      status: 'completed',
      result,
    });

    res.json({ result });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// PATCH /api/sessions/:id -- end session (CONTRACT.md section 4 + section 7 auto-close rule).
router.patch('/api/sessions/:id', requireApiKey(), async (req, res, next) => {
  const sessionId = req.params.id;
  if (!isValidUuid(sessionId)) {
    return res.status(400).json({ error: 'invalid_request', message: 'invalid session id' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sessionRes = await client.query('SELECT id, ended_at FROM sessions WHERE id = $1', [
      sessionId,
    ]);
    if (sessionRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found', message: 'session not found' });
    }

    // Auto-close any test_run still open in this session (section 7).
    const openRunsRes = await client.query(
      'SELECT id, component FROM test_runs WHERE session_id = $1 AND ended_at IS NULL FOR UPDATE',
      [sessionId]
    );
    for (const run of openRunsRes.rows) {
      await client.query(
        `UPDATE test_runs
         SET ended_at = now(), result = 'aborted', stop_reason = 'session_ended_early'
         WHERE id = $1`,
        [run.id]
      );
    }

    let endedAt = sessionRes.rows[0].ended_at;
    if (!endedAt) {
      const updateRes = await client.query(
        'UPDATE sessions SET ended_at = now() WHERE id = $1 RETURNING ended_at',
        [sessionId]
      );
      endedAt = updateRes.rows[0].ended_at;
    }

    await client.query('COMMIT');

    for (const run of openRunsRes.rows) {
      testRunCache.remove(run.id);
      hub.publish(sessionId, {
        type: 'test_run_status',
        test_run_id: run.id,
        component: run.component,
        status: 'completed',
        result: 'aborted',
      });
    }

    // CONTRACT.md doesn't specify a response body for this endpoint beyond "sets ended_at" --
    // returning the session id/ended_at plus which test_runs (if any) were auto-closed is a
    // judgment call flagged in the final report.
    res.json({
      session_id: sessionId,
      ended_at: endedAt,
      auto_closed_test_run_ids: openRunsRes.rows.map((r) => r.id),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
