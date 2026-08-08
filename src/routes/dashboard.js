'use strict';

// Dashboard REST endpoints, CONTRACT.md section 4 "Dashboard (no auth)" table.

const express = require('express');
const pool = require('../../db/pool');
const { isValidUuid } = require('../lib/validation');
const { generateSessionReportPdf } = require('../lib/pdf');

const router = express.Router();

// GET /api/sessions?mobo_serial=&customer_name=&from=&to=&technician_id=
//
// JUDGMENT CALL: CONTRACT.md doesn't define a technicians-list endpoint, so the dashboard has no
// way to populate a technician_id picker on its own. This still honors technician_id as a raw
// query param (e.g. hand-typed or deep-linked), and enriches each row with the technician's name
// (joined, not a schema change) plus a rollup of that session's test_runs so the list view is
// useful without an extra round-trip per row. See final report for the full flag.
router.get('/api/sessions', async (req, res, next) => {
  const { mobo_serial, customer_name, from, to, technician_id } = req.query;

  const conditions = [];
  const params = [];

  if (mobo_serial) {
    params.push(`%${mobo_serial}%`);
    conditions.push(`s.mobo_serial ILIKE $${params.length}`);
  }
  if (customer_name) {
    params.push(`%${customer_name}%`);
    conditions.push(`s.customer_name ILIKE $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`s.started_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`s.started_at <= $${params.length}`);
  }
  if (technician_id) {
    if (!isValidUuid(technician_id)) {
      return res.status(400).json({ error: 'invalid_request', message: 'invalid technician_id' });
    }
    params.push(technician_id);
    conditions.push(`s.technician_id = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const { rows } = await pool.query(
      `SELECT
         s.id, s.mobo_serial, s.customer_name, s.session_type, s.notes,
         s.ssd_serials, s.other_serials, s.started_at, s.ended_at,
         s.technician_id, t.name AS technician_name,
         COALESCE(
           (SELECT json_agg(json_build_object(
              'id', tr.id, 'component', tr.component, 'result', tr.result,
              'started_at', tr.started_at, 'ended_at', tr.ended_at
            ) ORDER BY tr.started_at)
            FROM test_runs tr WHERE tr.session_id = s.id),
           '[]'
         ) AS test_runs
       FROM sessions s
       JOIN technicians t ON t.id = s.technician_id
       ${where}
       ORDER BY s.started_at DESC
       LIMIT 200`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/sessions/:id
router.get('/api/sessions/:id', async (req, res, next) => {
  const sessionId = req.params.id;
  if (!isValidUuid(sessionId)) {
    return res.status(400).json({ error: 'invalid_request', message: 'invalid session id' });
  }
  try {
    const sessionRes = await pool.query(
      `SELECT s.*, t.name AS technician_name
       FROM sessions s
       JOIN technicians t ON t.id = s.technician_id
       WHERE s.id = $1`,
      [sessionId]
    );
    if (sessionRes.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'session not found' });
    }
    const testRunsRes = await pool.query(
      'SELECT * FROM test_runs WHERE session_id = $1 ORDER BY started_at',
      [sessionId]
    );
    res.json({ ...sessionRes.rows[0], test_runs: testRunsRes.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/sessions/:id/telemetry?test_run_id=
//
// JUDGMENT CALL: CONTRACT.md shows test_run_id as a query param but doesn't say whether it's
// required. Treated as optional here: if given, scoped to that one test_run (and validated as
// belonging to the session); if omitted, returns telemetry for every test_run in the session
// (each row tagged with its test_run_id so the client can still split series per run).
router.get('/api/sessions/:id/telemetry', async (req, res, next) => {
  const sessionId = req.params.id;
  const { test_run_id } = req.query;
  if (!isValidUuid(sessionId)) {
    return res.status(400).json({ error: 'invalid_request', message: 'invalid session id' });
  }
  if (test_run_id && !isValidUuid(test_run_id)) {
    return res.status(400).json({ error: 'invalid_request', message: 'invalid test_run_id' });
  }

  try {
    const sessionRes = await pool.query('SELECT id FROM sessions WHERE id = $1', [sessionId]);
    if (sessionRes.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'session not found' });
    }

    if (test_run_id) {
      const runRes = await pool.query(
        'SELECT id FROM test_runs WHERE id = $1 AND session_id = $2',
        [test_run_id, sessionId]
      );
      if (runRes.rows.length === 0) {
        return res.status(404).json({ error: 'not_found', message: 'test_run not found in this session' });
      }
      const { rows } = await pool.query(
        `SELECT test_run_id, ts, sensor_name, value FROM telemetry
         WHERE test_run_id = $1 ORDER BY ts`,
        [test_run_id]
      );
      return res.json(rows);
    }

    const { rows } = await pool.query(
      `SELECT tel.test_run_id, tel.ts, tel.sensor_name, tel.value
       FROM telemetry tel
       JOIN test_runs tr ON tr.id = tel.test_run_id
       WHERE tr.session_id = $1
       ORDER BY tel.ts`,
      [sessionId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/sessions/:id/report.pdf
router.get('/api/sessions/:id/report.pdf', async (req, res, next) => {
  const sessionId = req.params.id;
  if (!isValidUuid(sessionId)) {
    return res.status(400).json({ error: 'invalid_request', message: 'invalid session id' });
  }
  try {
    const sessionRes = await pool.query(
      `SELECT s.*, t.name AS technician_name
       FROM sessions s JOIN technicians t ON t.id = s.technician_id
       WHERE s.id = $1`,
      [sessionId]
    );
    if (sessionRes.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'session not found' });
    }
    const session = sessionRes.rows[0];

    const testRunsRes = await pool.query(
      'SELECT * FROM test_runs WHERE session_id = $1 ORDER BY started_at',
      [sessionId]
    );

    const telemetryByRun = {};
    for (const run of testRunsRes.rows) {
      const { rows } = await pool.query(
        'SELECT ts, sensor_name, value FROM telemetry WHERE test_run_id = $1 ORDER BY ts',
        [run.id]
      );
      telemetryByRun[run.id] = rows;
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="luxtronic-session-${sessionId}.pdf"`
    );

    generateSessionReportPdf({ session, testRuns: testRunsRes.rows, telemetryByRun }).pipe(res);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
