'use strict';

// /ws/live?session_id=uuid -- dashboard -> server, no auth (CONTRACT.md section 5).
// Server pushes `telemetry` and `test_run_status` messages for the lifetime of the connection.
// No backlog/replay on connect -- CONTRACT.md describes this as a live push feed; historical data
// for a session is fetched separately via GET /api/sessions/:id/telemetry.

const hub = require('./hub');

function handleConnection(ws, sessionId) {
  hub.subscribe(sessionId, ws);

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('close', () => {
    hub.unsubscribe(sessionId, ws);
  });

  ws.on('error', (err) => {
    console.error(`[ws/live] connection error (session ${sessionId}):`, err.message);
  });
}

module.exports = { handleConnection };
