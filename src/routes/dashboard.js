'use strict';

// Dashboard REST endpoints, CONTRACT.md section 4 "Dashboard (no auth)" table.

const express = require('express');
const pool = require('../../db/pool');
const { isValidUuid, isNonEmptyString } = require('../lib/validation');
const { generateSessionReportPdf } = require('../lib/pdf');
const testRunCache = require('../lib/testRunCache');
const hub = require('../ws/hub');
const { createTechnician } = require('../lib/technicians');

const router = express.Router();

// GET /api/technicians
//
// NOT in CONTRACT.md's original table -- fills the gap the comment below used to describe (no
// endpoint existed for the dashboard to discover technician names/IDs at all). Never returns
// api_key_hash -- there's no way to recover a raw key once issued, by design (CONTRACT.md
// section 1), and this endpoint doesn't change that.
router.get('/api/technicians', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, active, created_at FROM technicians ORDER BY name'
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/technicians
//
// NOT in CONTRACT.md's original table -- dashboard equivalent of scripts/create-technician.js
// (public/technicians.html), so provisioning a new technician doesn't require shell access to the
// server box. Returns the raw API key ONCE, same as the CLI -- only its hash is stored, so this
// response (or the api_keys/<name>.txt file src/lib/technicians.js also writes) is the only place
// it survives after this request completes.
router.post('/api/technicians', async (req, res, next) => {
  const { name } = req.body || {};
  if (!isNonEmptyString(name)) {
    return res.status(400).json({ error: 'invalid_request', message: 'name is required' });
  }
  try {
    const result = await createTechnician(name);
    res.status(201).json({
      id: result.id,
      name: result.name,
      api_key: result.rawKey,
      key_file_path: result.filePath,
      overwrote_existing_file: result.overwrote,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/technicians/:id
//
// NOT in CONTRACT.md's original table -- toggles `active` (revoke/reactivate an API key without
// deleting the technician or their session history). auth.js's findTechnicianByApiKey() already
// rejects inactive technicians, so a deactivation takes effect on that technician's very next
// request -- no other code needed to actually enforce it.
router.patch('/api/technicians/:id', async (req, res, next) => {
  const techId = req.params.id;
  const { active } = req.body || {};
  if (!isValidUuid(techId)) {
    return res.status(400).json({ error: 'invalid_request', message: 'invalid technician id' });
  }
  if (typeof active !== 'boolean') {
    return res.status(400).json({ error: 'invalid_request', message: 'active must be a boolean' });
  }
  try {
    const { rows } = await pool.query(
      'UPDATE technicians SET active = $1 WHERE id = $2 RETURNING id, name, active, created_at',
      [active, techId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'technician not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/technicians/:id
//
// NOT in CONTRACT.md's original table. Distinct from PATCH .../active=false: that's a reversible
// revoke that keeps the technician's name attached to their past sessions; this is a permanent
// removal, only really useful for cleaning up an accidental duplicate/typo'd entry created
// seconds ago. sessions.technician_id has no ON DELETE CASCADE (migrations/001_init.sql) --
// Postgres itself refuses to delete a technician referenced by any session, which is exactly the
// safety net wanted here (never silently orphan/cascade-delete real session history). This route
// checks for that up front so the error is a clear message instead of a raw DB constraint error,
// with the FK violation itself (code 23503) still caught as a defensive fallback in case a
// session gets created in the gap between the check and the DELETE.
router.delete('/api/technicians/:id', async (req, res, next) => {
  const techId = req.params.id;
  if (!isValidUuid(techId)) {
    return res.status(400).json({ error: 'invalid_request', message: 'invalid technician id' });
  }
  try {
    const countRes = await pool.query('SELECT COUNT(*) FROM sessions WHERE technician_id = $1', [
      techId,
    ]);
    const sessionCount = Number(countRes.rows[0].count);
    if (sessionCount > 0) {
      return res.status(409).json({
        error: 'has_sessions',
        message: `Cannot delete: ${sessionCount} session(s) are attributed to this technician. ` +
          'Deactivate instead to preserve that history while blocking their API key.',
        session_count: sessionCount,
      });
    }

    const { rows } = await pool.query('DELETE FROM technicians WHERE id = $1 RETURNING id', [
      techId,
    ]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'technician not found' });
    }
    res.status(204).end();
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({
        error: 'has_sessions',
        message: 'Cannot delete: this technician now has session history (created after this ' +
          'request started). Deactivate instead to preserve it.',
      });
    }
    next(err);
  }
});

// GET /api/sessions?mobo_serial=&customer_name=&from=&to=&technician_id=
//
// JUDGMENT CALL: CONTRACT.md doesn't define a technicians-list endpoint in its original table,
// but GET /api/technicians above now fills that gap -- this still honors technician_id as a raw
// query param (e.g. hand-typed, deep-linked, or picked from that new endpoint's response), and
// enriches each row with the technician's name (joined, not a schema change) plus a rollup of
// that session's test_runs so the list view is useful without an extra round-trip per row.
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

// POST /api/sessions/:id/test-runs/:test_run_id/stop
//
// NOT in CONTRACT.md's original endpoint table -- added to fix a real gap. Every route that can
// close a test_run (PATCH .../test-runs/:id, and the auto-close in PATCH /api/sessions/:id) lives
// in pcClient.js behind requireApiKey(), because normally it's the PC client reporting its own
// result. But if that client crashes, loses network, or is force-quit before it calls either of
// those, nothing ever closes the test_run -- the dashboard has no API key and so had no way to
// intervene, and the "running" badge (and the pulsing live indicator) would show forever. This
// gives the dashboard its own way to force a stuck test_run closed, with a distinct stop_reason
// (manual_stop, see validation.js) so it's clearly distinguishable in the data from a clean
// client-reported stop. Mirrors the auto-close logic in PATCH /api/sessions/:id: if this was the
// last open test_run in the session, the session itself is also closed, so it doesn't keep
// showing as "active" in the session list with nothing actually running in it.
router.post('/api/sessions/:id/test-runs/:test_run_id/stop', async (req, res, next) => {
  const sessionId = req.params.id;
  const testRunId = req.params.test_run_id;
  if (!isValidUuid(sessionId) || !isValidUuid(testRunId)) {
    return res.status(400).json({ error: 'invalid_request', message: 'invalid id' });
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
      return res.status(404).json({ error: 'not_found', message: 'test_run not found in this session' });
    }
    const run = runRes.rows[0];
    if (run.ended_at) {
      await client.query('ROLLBACK');
      return res
        .status(409)
        .json({ error: 'already_completed', message: 'test_run already has an ended_at' });
    }

    await client.query(
      `UPDATE test_runs
       SET ended_at = now(), result = 'aborted', stop_reason = 'manual_stop'
       WHERE id = $1`,
      [testRunId]
    );

    // If nothing else in this session is still running, close the session too -- otherwise it
    // would keep showing as "active" in the session list even though every test_run in it has
    // now ended (same reasoning as the auto-close in PATCH /api/sessions/:id, just triggered by
    // a manual stop instead of the client ending the session itself).
    const stillOpenRes = await client.query(
      'SELECT id FROM test_runs WHERE session_id = $1 AND ended_at IS NULL AND id != $2',
      [sessionId, testRunId]
    );
    let sessionEndedAt = null;
    if (stillOpenRes.rows.length === 0) {
      const updateRes = await client.query(
        'UPDATE sessions SET ended_at = COALESCE(ended_at, now()) WHERE id = $1 RETURNING ended_at',
        [sessionId]
      );
      sessionEndedAt = updateRes.rows[0]?.ended_at ?? null;
    }

    await client.query('COMMIT');

    testRunCache.remove(testRunId);
    hub.publish(sessionId, {
      type: 'test_run_status',
      test_run_id: testRunId,
      component: run.component,
      status: 'completed',
      result: 'aborted',
    });

    res.json({ result: 'aborted', session_ended_at: sessionEndedAt });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// POST /api/sessions/:id/end
//
// NOT in CONTRACT.md's original endpoint table -- dashboard-side equivalent of pcClient.js's
// PATCH /api/sessions/:id (which requires the client's API key and so isn't callable from here).
// Added because a session can get stuck showing "in progress" on the dashboard in two ways that
// only the earlier POST .../stop (per test_run) doesn't fully cover:
//   (a) a test_run's owning client crashed/vanished mid-run -- POST .../stop handles this by
//       closing that one test_run, and closes the session too if it was the last one open.
//   (b) EVERY test_run already completed normally, but the client itself crashed/vanished before
//       it got to call its own end-session PATCH -- there's no open test_run left to hang a
//       "stop" action off of, so POST .../stop has nothing to close and the session just sits
//       open forever with a stop button that (correctly) has nothing to show, per whether a
//       test_run is running. This endpoint covers both cases at once: close any still-open
//       test_runs (stop_reason: manual_stop, same as .../stop) AND unconditionally set the
//       session's ended_at if it isn't already, regardless of whether anything needed closing.
router.post('/api/sessions/:id/end', async (req, res, next) => {
  const sessionId = req.params.id;
  if (!isValidUuid(sessionId)) {
    return res.status(400).json({ error: 'invalid_request', message: 'invalid session id' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sessionRes = await client.query('SELECT id, ended_at FROM sessions WHERE id = $1', [sessionId]);
    if (sessionRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found', message: 'session not found' });
    }

    const openRunsRes = await client.query(
      'SELECT id, component FROM test_runs WHERE session_id = $1 AND ended_at IS NULL FOR UPDATE',
      [sessionId]
    );
    for (const run of openRunsRes.rows) {
      await client.query(
        `UPDATE test_runs
         SET ended_at = now(), result = 'aborted', stop_reason = 'manual_stop'
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

    res.json({
      session_id: sessionId,
      ended_at: endedAt,
      stopped_test_run_ids: openRunsRes.rows.map((r) => r.id),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
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
