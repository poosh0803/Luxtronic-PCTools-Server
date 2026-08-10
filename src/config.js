'use strict';

// Config loader for the thresholds/durations JSON file (CONTRACT.md section 3).
//
// CONTRACT.md says: "Client fetches the relevant subtree at session start; server re-reads the
// same file when computing `result` on test-run completion, so both sides evaluate against the
// same numbers." That implies the file can be hand-edited on the LAN box and picked up without a
// server restart -- so this deliberately does NOT cache at module-load time. The file is small
// (a handful of KB) and read infrequently (session start, test-run completion), so re-reading
// from disk on every call is cheap and keeps behavior simple and predictable.

const fs = require('fs');
const path = require('path');

const REQUIRED_COMPONENTS = ['cpu', 'gpu', 'ram', 'ssd'];

function configPath() {
  const configured = process.env.CONFIG_PATH || 'config/default.json';
  return path.isAbsolute(configured) ? configured : path.join(__dirname, '..', configured);
}

function loadConfig() {
  const filePath = configPath();
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read config file at ${filePath}: ${err.message}`);
  }

  // Strip a leading UTF-8 BOM if present. This file is meant to be hand-edited on the LAN box
  // (no admin UI for v1 -- see PROJECT_PLAN.md section 5), and Windows editors commonly save
  // "UTF-8" as UTF-8-with-BOM (Notepad does this by default) -- JSON.parse treats the BOM as an
  // invalid leading character and fails the whole file over an invisible byte, which is a
  // confusing failure mode for whoever just edited a threshold and saved.
  if (raw.charCodeAt(0) === 0xfeff) {
    raw = raw.slice(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Config file at ${filePath} is not valid JSON: ${err.message}`);
  }

  for (const component of REQUIRED_COMPONENTS) {
    if (!parsed[component] || typeof parsed[component] !== 'object') {
      throw new Error(`Config file at ${filePath} is missing required section "${component}"`);
    }
  }
  if (!parsed.concurrency || typeof parsed.concurrency !== 'object') {
    throw new Error(`Config file at ${filePath} is missing required section "concurrency"`);
  }

  return parsed;
}

module.exports = { loadConfig, configPath };
