'use strict';

// Unit tests for the pure predicate helpers in src/lib/validation.js. Table-driven, covering the
// documented valid sets (COMPONENTS / SESSION_TYPES / STOP_REASONS) plus edge cases for each
// predicate.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isNonEmptyString,
  isValidComponent,
  isValidSessionType,
  isValidStopReason,
  isValidUuid,
} = require('../src/lib/validation');

test('isNonEmptyString: valid cases', () => {
  for (const v of ['a', 'hello', '  padded but has content  ', '0', 'false']) {
    assert.equal(isNonEmptyString(v), true, `expected ${JSON.stringify(v)} to be valid`);
  }
});

test('isNonEmptyString: invalid cases', () => {
  const cases = ['', '   ', '\t\n', null, undefined, 0, 1, {}, [], true, false];
  for (const v of cases) {
    assert.equal(isNonEmptyString(v), false, `expected ${JSON.stringify(v)} to be invalid`);
  }
});

test('isValidComponent: accepts exactly cpu/gpu/ram/ssd', () => {
  for (const v of ['cpu', 'gpu', 'ram', 'ssd']) {
    assert.equal(isValidComponent(v), true, `expected ${v} to be valid`);
  }
});

test('isValidComponent: rejects unknown/wrong-case/non-string values', () => {
  const cases = ['CPU', 'Gpu', 'motherboard', '', null, undefined, 123, {}];
  for (const v of cases) {
    assert.equal(isValidComponent(v), false, `expected ${JSON.stringify(v)} to be invalid`);
  }
});

test('isValidSessionType: accepts exactly new_build/repair', () => {
  for (const v of ['new_build', 'repair']) {
    assert.equal(isValidSessionType(v), true, `expected ${v} to be valid`);
  }
});

test('isValidSessionType: rejects unknown/wrong-case/non-string values', () => {
  const cases = ['New_Build', 'upgrade', '', null, undefined, 123, {}];
  for (const v of cases) {
    assert.equal(isValidSessionType(v), false, `expected ${JSON.stringify(v)} to be invalid`);
  }
});

test('isValidStopReason: accepts exactly user_abort/tool_crash/client_error', () => {
  for (const v of ['user_abort', 'tool_crash', 'client_error']) {
    assert.equal(isValidStopReason(v), true, `expected ${v} to be valid`);
  }
});

test('isValidStopReason: rejects unknown/wrong-case/non-string values', () => {
  const cases = ['User_Abort', 'crash', '', null, undefined, 123, {}];
  for (const v of cases) {
    assert.equal(isValidStopReason(v), false, `expected ${JSON.stringify(v)} to be invalid`);
  }
});

test('isValidUuid: accepts a well-formed v4-shaped UUID', () => {
  assert.equal(isValidUuid('550e8400-e29b-41d4-a716-446655440000'), true);
});

test('isValidUuid: is case-insensitive (uppercase hex letters accepted)', () => {
  assert.equal(isValidUuid('550E8400-E29B-41D4-A716-446655440000'), true);
});

test('isValidUuid: accepts mixed-case hex letters', () => {
  assert.equal(isValidUuid('550e8400-E29b-41D4-a716-446655440000'), true);
});

test('isValidUuid: rejects a UUID missing a segment', () => {
  assert.equal(isValidUuid('550e8400-e29b-41d4-a716'), false);
});

test('isValidUuid: rejects a UUID with a segment too short', () => {
  assert.equal(isValidUuid('550e8400-e29b-41d4-a716-44665544000'), false); // last segment 11 chars, not 12
});

test('isValidUuid: rejects a UUID with wrong dash placement', () => {
  assert.equal(isValidUuid('550e8400e29b-41d4-a716-446655440000'), false);
});

test('isValidUuid: rejects non-hex characters', () => {
  assert.equal(isValidUuid('550e8400-e29b-41d4-a716-44665544000g'), false);
});

test('isValidUuid: rejects empty string, null, undefined, non-string', () => {
  const cases = ['', null, undefined, 12345, {}, []];
  for (const v of cases) {
    assert.equal(isValidUuid(v), false, `expected ${JSON.stringify(v)} to be invalid`);
  }
});

test('isValidUuid: rejects a plain non-UUID string', () => {
  assert.equal(isValidUuid('not-a-uuid'), false);
});
