'use strict';

// In-memory pub/sub between the /ws/telemetry ingest endpoint (and the REST routes that change
// test_run status) and /ws/live dashboard subscribers, keyed by session_id. Single-process only --
// fine for a single pm2 instance on the LAN box; would need a shared broker (Redis pub/sub etc.)
// if this were ever scaled to multiple server processes.

const subscribersBySession = new Map(); // session_id -> Set<ws>

function subscribe(sessionId, ws) {
  let set = subscribersBySession.get(sessionId);
  if (!set) {
    set = new Set();
    subscribersBySession.set(sessionId, set);
  }
  set.add(ws);
}

function unsubscribe(sessionId, ws) {
  const set = subscribersBySession.get(sessionId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) subscribersBySession.delete(sessionId);
}

/** Sends `message` (an object, will be JSON-stringified) to every dashboard socket watching sessionId. */
function publish(sessionId, message) {
  const set = subscribersBySession.get(sessionId);
  if (!set || set.size === 0) return;
  const payload = JSON.stringify(message);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}

function subscriberCount(sessionId) {
  return subscribersBySession.get(sessionId)?.size || 0;
}

module.exports = { subscribe, unsubscribe, publish, subscriberCount };
