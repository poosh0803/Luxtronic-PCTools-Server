#!/usr/bin/env node
// Provisions a technician + API key. Thin CLI wrapper around src/lib/technicians.js's
// createTechnician(), which the dashboard's POST /api/technicians route (public/technicians.html)
// also uses -- CONTRACT.md still has no REST endpoint for this in its original table, but the
// dashboard now offers it directly, so this script is for anyone who prefers/needs shell access
// to the server box instead (e.g. scripting a bulk import).
//
// Usage: node scripts/create-technician.js "Technician Name"
'use strict';

require('dotenv').config();
const pool = require('../db/pool');
const { createTechnician } = require('../src/lib/technicians');

async function main() {
  const name = process.argv[2];
  if (!name || !name.trim()) {
    console.error('Usage: node scripts/create-technician.js "Technician Name"');
    process.exit(1);
  }

  const result = await createTechnician(name);

  if (result.overwrote) {
    console.warn(`WARNING: overwrote existing key file at ${result.filePath} -- ` +
      'the old key still works server-side (this only replaced the local copy); ' +
      'deactivate the old technician first if you meant to rotate their key.');
  }

  console.log(`Created technician "${result.name}" (id ${result.id})`);
  console.log('');
  console.log('API key (save this now -- it is not recoverable, only its hash is stored):');
  console.log(result.rawKey);
  console.log('');
  console.log(`Also written to: ${result.filePath}`);
  console.log('Copy that file to the technician\'s PC and rename it to apikey.txt next to the client exe.');

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
