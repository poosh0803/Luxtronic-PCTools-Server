'use strict';

// Shared technician-provisioning logic, used by both scripts/create-technician.js (CLI) and the
// dashboard's POST /api/technicians route (public/technicians.html) -- pulled out so "generate a
// key, hash it, insert the row, write the api_keys/ file" isn't duplicated in two places now that
// there are two ways to provision a technician.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pool = require('../../db/pool');
const { hashApiKey } = require('./auth');

const API_KEYS_DIR = path.join(__dirname, '..', '..', 'api_keys');

/**
 * Pure string transform, split out from keyFilePath() so it's unit-testable without touching the
 * filesystem. Matches the file a technician eventually renames to apikey.txt on their client PC
 * -- see api_keys/README.md and Luxtronic-PCTools-Client's ApiKeyProvider (reads the whole file,
 * trimmed, as the key -- nothing else belongs in this file).
 */
function sanitizeFileName(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function keyFilePath(name) {
  const safeName = sanitizeFileName(name);
  return path.join(API_KEYS_DIR, `${safeName || 'technician'}.txt`);
}

/**
 * Creates a technician + API key: generates a random key, hashes it, inserts the DB row, and
 * writes the raw key to api_keys/<name>.txt. If two technicians sanitize to the same file name
 * (e.g. same first name), the second's file overwrites the first's local copy -- the first
 * technician's key still works server-side (only the hash is checked), this just means their
 * convenience file needs regenerating; `overwrote` tells the caller this happened so it can warn.
 * @returns {Promise<{ id: string, name: string, active: boolean, created_at: Date, rawKey: string, filePath: string, overwrote: boolean }>}
 */
async function createTechnician(name) {
  const trimmedName = name.trim();
  const rawKey = crypto.randomBytes(24).toString('base64url');
  const hash = hashApiKey(rawKey);

  const { rows } = await pool.query(
    'INSERT INTO technicians (name, api_key_hash) VALUES ($1, $2) RETURNING id, name, active, created_at',
    [trimmedName, hash]
  );

  fs.mkdirSync(API_KEYS_DIR, { recursive: true });
  const filePath = keyFilePath(trimmedName);
  const overwrote = fs.existsSync(filePath);
  fs.writeFileSync(filePath, rawKey, 'utf8');

  return { ...rows[0], rawKey, filePath, overwrote };
}

module.exports = { createTechnician, keyFilePath, sanitizeFileName, API_KEYS_DIR };
