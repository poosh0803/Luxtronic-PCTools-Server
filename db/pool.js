'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  // Idle client errors (e.g. connection dropped) shouldn't crash the whole process.
  console.error('Unexpected error on idle Postgres client', err);
});

module.exports = pool;
