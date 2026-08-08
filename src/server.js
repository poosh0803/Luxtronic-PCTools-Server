'use strict';

require('dotenv').config();

const http = require('http');
const { URL } = require('url');
const { WebSocketServer } = require('ws');

const { createApp } = require('./app');
const { findTechnicianByApiKey } = require('./lib/auth');
const { isValidUuid } = require('./lib/validation');
const telemetryWs = require('./ws/telemetry');
const liveWs = require('./ws/live');
const hub = require('./ws/hub');

const PORT = process.env.PORT || 7777;

const app = createApp();
const server = http.createServer(app);

// Two separate WS servers, both attached to the same HTTP server/port via manual upgrade
// handling (CONTRACT.md section 5: "single port handles REST ingestion, live telemetry
// (WebSocket), and the dashboard").
const wssTelemetry = new WebSocketServer({ noServer: true });
const wssLive = new WebSocketServer({ noServer: true });

function rejectUpgrade(socket, statusCode, message) {
  socket.write(
    `HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
  );
  socket.destroy();
}

server.on('upgrade', async (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    return rejectUpgrade(socket, 400, 'Bad Request');
  }

  if (url.pathname === '/ws/telemetry') {
    // Auth per CONTRACT.md section 1: X-Api-Key header, or ?api_key= query param as a fallback
    // for client libraries that can't set headers on a WS handshake.
    const rawKey = req.headers['x-api-key'] || url.searchParams.get('api_key');
    const technician = await findTechnicianByApiKey(rawKey);
    if (!technician) {
      return rejectUpgrade(socket, 401, 'Unauthorized');
    }
    wssTelemetry.handleUpgrade(req, socket, head, (ws) => {
      wssTelemetry.emit('connection', ws, req, technician);
    });
    return;
  }

  if (url.pathname === '/ws/live') {
    const sessionId = url.searchParams.get('session_id');
    if (!isValidUuid(sessionId)) {
      return rejectUpgrade(socket, 400, 'Bad Request: session_id required');
    }
    wssLive.handleUpgrade(req, socket, head, (ws) => {
      wssLive.emit('connection', ws, req, sessionId);
    });
    return;
  }

  rejectUpgrade(socket, 404, 'Not Found');
});

wssTelemetry.on('connection', (ws, req, technician) => {
  telemetryWs.handleConnection(ws, req, technician);
});

wssLive.on('connection', (ws, req, sessionId) => {
  liveWs.handleConnection(ws, sessionId);
});

// Periodic ping/pong liveness check for both WS server sets, so dead connections (client crashed,
// network drop) get cleaned out of the /ws/live fan-out list instead of accumulating forever.
const HEARTBEAT_INTERVAL_MS = 30000;
function heartbeat(wss) {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}
const heartbeatTimer = setInterval(() => {
  heartbeat(wssTelemetry);
  heartbeat(wssLive);
}, HEARTBEAT_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`Luxtronic PCTools server listening on port ${PORT}`);
});

function shutdown() {
  console.log('Shutting down...');
  clearInterval(heartbeatTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { server, app, hub };
