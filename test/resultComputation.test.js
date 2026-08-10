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
    max_smart_temp_c: 70,
    max_smart_reallocated_sectors: 0,
    max_smart_percentage_used: 90,
    min_smart_available_spare_percent: 10,
    max_smart_media_errors: 0,
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

// The ssd config subtree carries both ATA-only and NVMe-only SMART thresholds, since a single
// drive is only ever one bus type (see resultComputation.js's comment for the full story). These
// tests submit only the summary_stats keys that drive's bus type would realistically populate --
// the other bus type's config keys are present but have no matching summary_stats key, so per the
// "missing key -> not evaluated" behavior already covered above, they're silently skipped.

test('ssd (ATA/SATA drive): reallocated sectors over the limit -> fail, even with good throughput', () => {
  const r = computeResult(
    'ssd',
    config,
    { min_seq_read_mb_s: 500, min_seq_write_mb_s: 500, max_smart_reallocated_sectors: 3 },
    null
  );
  assert.equal(r.result, 'fail');
});

test('ssd (ATA/SATA drive): zero reallocated sectors, good throughput -> pass', () => {
  const r = computeResult(
    'ssd',
    config,
    { min_seq_read_mb_s: 500, min_seq_write_mb_s: 500, max_smart_reallocated_sectors: 0 },
    null
  );
  assert.equal(r.result, 'pass');
});

test('ssd (NVMe drive): percentage_used over the limit -> fail', () => {
  const r = computeResult(
    'ssd',
    config,
    { min_seq_read_mb_s: 500, min_seq_write_mb_s: 500, max_smart_percentage_used: 95 },
    null
  );
  assert.equal(r.result, 'fail');
});

test('ssd (NVMe drive): available spare below the minimum -> fail', () => {
  const r = computeResult(
    'ssd',
    config,
    { min_seq_read_mb_s: 500, min_seq_write_mb_s: 500, min_smart_available_spare_percent: 5 },
    null
  );
  assert.equal(r.result, 'fail');
});

test('ssd (NVMe drive): healthy wear/spare levels, good throughput -> pass', () => {
  const r = computeResult(
    'ssd',
    config,
    {
      min_seq_read_mb_s: 500,
      min_seq_write_mb_s: 500,
      max_smart_percentage_used: 12,
      min_smart_available_spare_percent: 95,
      max_smart_media_errors: 0,
    },
    null
  );
  assert.equal(r.result, 'pass');
});

// Regression test for a real bug the SSD tests above caught: a zero-value limit made the 5%
// borderline band degenerate to "observed >= 0", which flagged the healthy observed=0 case on
// every zero-tolerance threshold (max_smart_reallocated_sectors: 0, max_errors: 0, etc.) forever.
test('max_ threshold with limit exactly 0: observed 0 -> pass, not flagged', () => {
  const r = computeResult(
    'ssd',
    config,
    { min_seq_read_mb_s: 500, min_seq_write_mb_s: 500, max_smart_reallocated_sectors: 0 },
    null
  );
  assert.equal(r.result, 'pass');
});

test('min_ threshold with limit exactly 0: observed 0 -> pass, not flagged', () => {
  const zeroMinConfig = {
    ...config,
    ssd: { ...config.ssd, min_smart_available_spare_percent: 0 },
  };
  const r = computeResult(
    'ssd',
    zeroMinConfig,
    { min_seq_read_mb_s: 500, min_seq_write_mb_s: 500, min_smart_available_spare_percent: 0 },
    null
  );
  assert.equal(r.result, 'pass');
});

test('missing summary_stats keys for a given config threshold are simply not evaluated', () => {
  // No max_temp_c in stats at all -- shouldn't crash, shouldn't fail/flag on it.
  const r = computeResult('cpu', config, { error_count: 0 }, null);
  assert.equal(r.result, 'pass');
});

// README.md's "Scope notes and judgment calls" section (#3) calls this out explicitly: a
// summary_stats value landing exactly at a configured threshold currently resolves to `flagged`,
// not `fail` or `pass`, for BOTH max_ and min_ style limits (only the max_ case -- max_temp_c
// exactly at 95 -- is covered above). Locking in the min_ side here too, so a future change to
// this boundary behavior is a deliberate test update rather than a silent drift.
test('normal finish, min_seq_read_mb_s exactly at the minimum -> flagged, not fail or pass', () => {
  const r = computeResult(
    'ssd',
    config,
    { min_seq_read_mb_s: 400, min_seq_write_mb_s: 1000 }, // read exactly at the 400 minimum; write comfortably clear
    null
  );
  assert.equal(r.result, 'flagged');
});
