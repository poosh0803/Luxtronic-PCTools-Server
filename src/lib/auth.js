'use strict';

// Technician API key auth (CONTRACT.md section 1).
//
// Every PC-client request carries `X-Api-Key: <key>`. The server stores only a hash of each key
// (technicians.api_key_hash), never the raw value. Plain SHA-256 (not bcrypt/scrypt) is used
// deliberately here: these are static, long-lived, low-entropy-risk internal technician keys (not
// user passwords), generated server-side with enough randomness that offline brute force isn't a
// realistic threat on a LAN-only tool for a 2-person shop. A fast deterministic hash also makes
// WebSocket upgrade auth (which needs a quick synchronous lookup) simpler.

const crypto = require('crypto');
const pool = require('../../db/pool');

function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

/**
 * Looks up the technician for a raw API key. Returns the technician row ({id, name, active}) or
 * null if the key is missing/unknown/inactive.
 */
async function findTechnicianByApiKey(rawKey) {
  if (!rawKey) return null;
  const hash = hashApiKey(rawKey);
  const { rows } = await pool.query(
    'SELECT id, name, active FROM technicians WHERE api_key_hash = $1',
    [hash]
  );
  const tech = rows[0];
  if (!tech || !tech.active) return null;
  return tech;
}

/** Express middleware: requires a valid X-Api-Key header, attaches req.technician. */
function requireApiKey() {
  return async (req, res, next) => {
    const rawKey = req.header('X-Api-Key');
    const tech = await findTechnicianByApiKey(rawKey);
    if (!tech) {
      return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid X-Api-Key' });
    }
    req.technician = tech;
    next();
  };
}

module.exports = { hashApiKey, findTechnicianByApiKey, requireApiKey };
