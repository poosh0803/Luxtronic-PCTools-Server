'use strict';

// Unit tests for the pure parts of src/lib/technicians.js. createTechnician() itself needs a live
// Postgres connection (it inserts a row) and touches the filesystem (writes api_keys/<name>.txt),
// so it's out of scope here per this suite's convention -- covered by the manual checklist in
// README.md instead.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { sanitizeFileName, keyFilePath, API_KEYS_DIR } = require('../src/lib/technicians');

test('sanitizeFileName: lowercases and replaces spaces with hyphens', () => {
  assert.equal(sanitizeFileName('Jane Smith'), 'jane-smith');
});

test('sanitizeFileName: collapses runs of non-alphanumeric characters into one hyphen', () => {
  assert.equal(sanitizeFileName("O'Brien -- Repairs!!"), 'o-brien-repairs');
});

test('sanitizeFileName: trims leading/trailing hyphens left over from punctuation at the edges', () => {
  assert.equal(sanitizeFileName('  #1 Tech!  '), '1-tech');
});

test('sanitizeFileName: a name with no alphanumeric characters at all sanitizes to an empty string', () => {
  // keyFilePath (not this function) is what falls back to "technician" for this case.
  assert.equal(sanitizeFileName('!!!'), '');
});

test('keyFilePath: builds a .txt path under API_KEYS_DIR from the sanitized name', () => {
  const result = keyFilePath('Jane Smith');
  assert.equal(result, path.join(API_KEYS_DIR, 'jane-smith.txt'));
});

test('keyFilePath: falls back to "technician.txt" when the name sanitizes to nothing', () => {
  const result = keyFilePath('!!!');
  assert.equal(result, path.join(API_KEYS_DIR, 'technician.txt'));
});
