'use strict';

// /ws/telemetry -- PC client -> server, authenticated (CONTRACT.md section 5).
//
// Client sends one JSON message per sensor sample:
//   { "test_run_id": "uuid", "ts": "2026-08-08T12:00:00.000Z", "sensor_name": "cpu_package_temp_c", "value": 78.4 }
// Server persists each to `telemetry` and relays it to any dashboard subscribed to that session.

const pool = require('../../db/pool');
const hub = require('./hub');
const testRunCache = require('../lib/testRunCache');
const { isValidUuid } = require('../lib/validation');

function isValidMessage(msg) {
  return (
    msg &&
    typeof msg === 'object' &&
    isValidUuid(msg.test_run_id) &&
    typeof msg.ts === 'string' &&
    !Number.isNaN(new Date(msg.ts).getTime()) &&
    typeof msg.sensor_name === 'string' &&
    msg.sensor_name.length > 0 &&
    typeof msg.value === 'number' &&
    Number.isFinite(msg.value)
  );
}

function sendError(ws, message) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type: 'error', message }));
  }
}

function handleConnection(ws, req, technician) {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return sendError(ws, 'invalid JSON');
    }

    if (!isValidMessage(msg)) {
      return sendError(ws, 'malformed telemetry message');
    }

    try {
      const entry = await testRunCache.get(msg.test_run_id);
      if (!entry) {
        return sendError(ws, `unknown test_run_id ${msg.test_run_id}`);
      }

      await pool.query(
        'INSERT INTO telemetry (test_run_id, ts, sensor_name, value) VALUES ($1, $2, $3, $4)',
        [msg.test_run_id, msg.ts, msg.sensor_name, msg.value]
      );

      hub.publish(entry.sessionId, {
        type: 'telemetry',
        test_run_id: msg.test_run_id,
        ts: msg.ts,
        sensor_name: msg.sensor_name,
        value: msg.value,
      });
    } catch (err) {
      console.error(`[ws/telemetry] failed to persist sample from ${technician.name}:`, err.message);
      sendError(ws, 'internal error persisting telemetry');
    }
  });

  ws.on('error', (err) => {
    console.error(`[ws/telemetry] connection error (${technician.name}):`, err.message);
  });
}

module.exports = { handleConnection };
