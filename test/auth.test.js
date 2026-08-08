'use strict';

// Unit tests for the technician API key hashing helper (CONTRACT.md section 1). Only
// `hashApiKey` is pure/testable without a DB -- `findTechnicianByApiKey` and `requireApiKey`
// both need a live Postgres connection and are out of scope here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hashApiKey } = require('../src/lib/auth');

test('hashApiKey is deterministic: same input always produces the same hash', () => {
  const a = hashApiKey('technician-raw-key-123');
  const b = hashApiKey('technician-raw-key-123');
  assert.equal(a, b);
});

test('hashApiKey produces different hashes for different inputs', () => {
  const a = hashApiKey('technician-raw-key-123');
  const b = hashApiKey('technician-raw-key-124');
  assert.notEqual(a, b);
});

test('hashApiKey output looks like a SHA-256 hex digest (64 lowercase hex chars)', () => {
  const hash = hashApiKey('some-raw-key');
  assert.equal(typeof hash, 'string');
  assert.equal(hash.length, 64);
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test('hashApiKey of the empty string is still a well-formed digest', () => {
  const hash = hashApiKey('');
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test('hashApiKey is sensitive to a single-character difference', () => {
  const a = hashApiKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  const b = hashApiKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'); // one extra "A"
  assert.notEqual(a, b);
});
