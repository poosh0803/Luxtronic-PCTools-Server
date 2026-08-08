'use strict';

// Unit tests for CONTRACT.md section 7 result computation. Focused on the CPU config subtree
// (this pass's scope), plus the component-agnostic stop_reason/aborted path.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeResult } = require('../src/lib/resultComputation');

const config = {
  cpu: { tool: 'prime95', mode: 'blend', duration_minutes: 60, max_temp_c: 95 },
  gpu: { tool: 'furmark', duration_minutes: 20, max_temp_c: 90 },
  ram: { tool: 'tm5', config_profile: 'anta777-extreme', duration_minutes: 60, max_errors: 0 },
  ssd: {
    tool: 'crystaldiskmark',
    min_seq_read_mb_s: 400,
    min_seq_write_mb_s: 300,
    smart_reallocated_sectors_max: 0,
  },
  concurrency: { cpu_gpu_together_allowed: true, exclusive_components: ['ram', 'ssd'] },
};

test('stop_reason present -> aborted unconditionally, even if stats look fine', () => {
  const r = computeResult('cpu', config, { max_temp_c: 40, error_count: 0 }, 'user_abort');
  assert.equal(r.result, 'aborted');
});

test('stop_reason present -> aborted even with no summary_stats at all', () => {
  const r = computeResult('cpu', config, null, 'tool_crash');
  assert.equal(r.result, 'aborted');
});

test('normal finish, well under threshold -> pass', () => {
  const r = computeResult('cpu', config, { max_temp_c: 70, error_count: 0 }, null);
  assert.equal(r.result, 'pass');
});

test('normal finish, error_count > 0 -> fail regardless of temps', () => {
  const r = computeResult('cpu', config, { max_temp_c: 40, error_count: 1 }, null);
  assert.equal(r.result, 'fail');
});

test('normal finish, max_temp_c exceeds hard limit -> fail', () => {
  const r = computeResult('cpu', config, { max_temp_c: 96, error_count: 0 }, undefined);
  assert.equal(r.result, 'fail');
});

test('normal finish, max_temp_c exactly at limit -> not fail (only strictly over triggers fail)', () => {
  const r = computeResult('cpu', config, { max_temp_c: 95, error_count: 0 }, null);
  assert.equal(r.result, 'flagged'); // at the limit is also within the 5% borderline band
});

test('normal finish, max_temp_c within 5% of limit (borderline) -> flagged', () => {
  // 95 * 0.95 = 90.25, so 91 is within the borderline band but doesn't exceed 95.
  const r = computeResult('cpu', config, { max_temp_c: 91, error_count: 0 }, null);
  assert.equal(r.result, 'flagged');
});

test('normal finish, max_temp_c comfortably below the 5% borderline band -> pass', () => {
  // 90 is below 90.25 (the 5% band), so this should NOT be flagged.
  const r = computeResult('cpu', config, { max_temp_c: 90, error_count: 0 }, null);
  assert.equal(r.result, 'pass');
});

test('ssd min_seq_read_mb_s below minimum -> fail', () => {
  const r = computeResult('ssd', config, { min_seq_read_mb_s: 350, min_seq_write_mb_s: 350 }, null);
  assert.equal(r.result, 'fail');
});

test('ssd throughput comfortably above minimums -> pass', () => {
  const r = computeResult('ssd', config, { min_seq_read_mb_s: 500, min_seq_write_mb_s: 500 }, null);
  assert.equal(r.result, 'pass');
});

test('missing summary_stats keys for a given config threshold are simply not evaluated', () => {
  // No max_temp_c in stats at all -- shouldn't crash, shouldn't fail/flag on it.
  const r = computeResult('cpu', config, { error_count: 0 }, null);
  assert.equal(r.result, 'pass');
});
