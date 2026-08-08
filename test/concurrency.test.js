'use strict';

// Unit tests for the CONTRACT.md section 6 concurrency rule. These are pure-function tests (no
// DB) covering every case enumerated in the spec's prose, plus the "together" mode example it
// calls out explicitly.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkConcurrency } = require('../src/lib/concurrency');

test('ram requested with nothing active -> allowed', () => {
  assert.deepEqual(checkConcurrency([], 'ram'), { ok: true });
});

test('ssd requested with nothing active -> allowed', () => {
  assert.deepEqual(checkConcurrency([], 'ssd'), { ok: true });
});

test('ram requested with any active test_run -> rejected', () => {
  assert.deepEqual(checkConcurrency(['cpu'], 'ram'), { ok: false, active_component: 'cpu' });
});

test('ssd requested while ram is active -> rejected', () => {
  assert.deepEqual(checkConcurrency(['ram'], 'ssd'), { ok: false, active_component: 'ram' });
});

test('cpu requested with nothing active -> allowed', () => {
  assert.deepEqual(checkConcurrency([], 'cpu'), { ok: true });
});

test('gpu requested while cpu is active -> allowed ("together" mode)', () => {
  assert.deepEqual(checkConcurrency(['cpu'], 'gpu'), { ok: true });
});

test('cpu requested while cpu already active -> rejected (no duplicate same-component runs)', () => {
  assert.deepEqual(checkConcurrency(['cpu'], 'cpu'), { ok: false, active_component: 'cpu' });
});

test('cpu requested while ram is active -> rejected', () => {
  assert.deepEqual(checkConcurrency(['ram'], 'cpu'), { ok: false, active_component: 'ram' });
});

test('gpu requested while ssd is active -> rejected', () => {
  assert.deepEqual(checkConcurrency(['ssd'], 'gpu'), { ok: false, active_component: 'ssd' });
});

test('cpu requested while both cpu and gpu already active -> rejected on the matching component', () => {
  assert.deepEqual(checkConcurrency(['cpu', 'gpu'], 'cpu'), { ok: false, active_component: 'cpu' });
});
