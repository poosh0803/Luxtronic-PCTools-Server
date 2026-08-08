#!/usr/bin/env node
// Provisions a technician + API key. CONTRACT.md has no REST endpoint for creating technicians
// (deliberately, presumably -- it's a 2-person shop and this is an infrequent admin action), so
// this is a small CLI instead. Prints the raw API key ONCE; only its SHA-256 hash is stored.
//
// Usage: node scripts/create-technician.js "Technician Name"
'use strict';

require('dotenv').config();
const crypto = require('crypto');
const pool = require('../db/pool');
const { hashApiKey } = require('../src/lib/auth');

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

  console.log(`Created technician "${name.trim()}" (id ${rows[0].id})`);
  console.log('');
  console.log('API key (save this now -- it is not recoverable, only its hash is stored):');
  console.log(rawKey);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
