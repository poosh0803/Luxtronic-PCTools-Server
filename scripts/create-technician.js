#!/usr/bin/env node
// Provisions a technician + API key. CONTRACT.md has no REST endpoint for creating technicians
// (deliberately, presumably -- it's a 2-person shop and this is an infrequent admin action), so
// this is a small CLI instead. Prints the raw API key ONCE, and also writes it to api_keys/ --
// only its SHA-256 hash is stored server-side, so that file (or the console output) is the only
// place the raw key survives after this command exits.
//
// Usage: node scripts/create-technician.js "Technician Name"
'use strict';

require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');
const { hashApiKey } = require('../src/lib/auth');

const API_KEYS_DIR = path.join(__dirname, '..', 'api_keys');

// Matches the file this technician will eventually rename to apikey.txt on their client PC --
// see api_keys/README.md and Luxtronic-PCTools-Client's ApiKeyProvider (which reads the whole
// file, trimmed, as the key -- nothing else belongs in this file).
function keyFilePath(name) {
  const safeName = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return path.join(API_KEYS_DIR, `${safeName || 'technician'}.txt`);
}

async function main() {
  const name = process.argv[2];
  if (!name || !name.trim()) {
    console.error('Usage: node scripts/create-technician.js "Technician Name"');
    process.exit(1);
  }

  const rawKey = crypto.randomBytes(24).toString('base64url');
  const hash = hashApiKey(rawKey);

  const { rows } = await pool.query(
    'INSERT INTO technicians (name, api_key_hash) VALUES ($1, $2) RETURNING id',
    [name.trim(), hash]
  );

  fs.mkdirSync(API_KEYS_DIR, { recursive: true });
  const filePath = keyFilePath(name);
  if (fs.existsSync(filePath)) {
    console.warn(`WARNING: overwriting existing key file at ${filePath} -- ` +
      'the old key still works server-side (this only replaces the local copy); ' +
      'delete the technician\'s row first if you meant to rotate the key.');
  }
  fs.writeFileSync(filePath, rawKey, 'utf8');

  console.log(`Created technician "${name.trim()}" (id ${rows[0].id})`);
  console.log('');
  console.log('API key (save this now -- it is not recoverable, only its hash is stored):');
  console.log(rawKey);
  console.log('');
  console.log(`Also written to: ${filePath}`);
  console.log('Copy that file to the technician\'s PC and rename it to apikey.txt next to the client exe.');

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
