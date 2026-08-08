'use strict';

const path = require('path');
const express = require('express');
const pcClientRoutes = require('./routes/pcClient');
const dashboardRoutes = require('./routes/dashboard');

function createApp() {
  const app = express();

  app.use(express.json({ limit: '2mb' }));

  // PC client endpoints (CONTRACT.md section 4, "auth required" table). Each route inside
  // pcClientRoutes applies its own auth check (not a blanket app.use() here) -- a blanket
  // middleware at this level would also run for dashboard requests mounted below, since an
  // unpathed router still evaluates its `.use()` middleware for every request before falling
  // through on a route mismatch.
  app.use(pcClientRoutes);

  // Dashboard endpoints (CONTRACT.md section 4, "no auth" table).
  app.use(dashboardRoutes);

  // Static dashboard UI.
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // JSON body parse errors -> 400 instead of the default 500.
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid_request', message: 'malformed JSON body' });
    }
    next(err);
  });

  // Fallback error handler.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: 'unexpected server error' });
  });

  return app;
}

module.exports = { createApp };
