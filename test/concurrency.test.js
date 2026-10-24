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

test('vram requested with nothing active -> allowed', () => {
  assert.deepEqual(checkConcurrency([], 'vram'), { ok: true });
});

test('vram requested while cpu is active -> allowed (cpu does not touch the graphics card)', () => {
  assert.deepEqual(checkConcurrency(['cpu'], 'vram'), { ok: true });
});

test('cpu requested while vram is active -> allowed', () => {
  assert.deepEqual(checkConcurrency(['vram'], 'cpu'), { ok: true });
});

test('vram requested while gpu is active -> rejected (same graphics card)', () => {
  assert.deepEqual(checkConcurrency(['gpu'], 'vram'), { ok: false, active_component: 'gpu' });
});

test('gpu requested while vram is active -> rejected', () => {
  assert.deepEqual(checkConcurrency(['vram'], 'gpu'), { ok: false, active_component: 'vram' });
});

test('vram requested while vram already active -> rejected (no duplicate same-component runs)', () => {
  assert.deepEqual(checkConcurrency(['vram'], 'vram'), { ok: false, active_component: 'vram' });
});

test('vram requested while ram is active -> rejected', () => {
  assert.deepEqual(checkConcurrency(['ram'], 'vram'), { ok: false, active_component: 'ram' });
});

test('ram requested while vram is active -> rejected (exclusive)', () => {
  assert.deepEqual(checkConcurrency(['vram'], 'ram'), { ok: false, active_component: 'vram' });
});
