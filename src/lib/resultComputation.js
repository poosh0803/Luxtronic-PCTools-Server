'use strict';

// Result computation, CONTRACT.md section 7. Component-agnostic by design (only "cpu" is
// exercised end-to-end this pass, but the rule itself doesn't special-case any component).
//
// JUDGMENT CALL (flagged in the final report): CONTRACT.md doesn't spell out a generic algorithm
// for matching summary_stats fields against config thresholds across differently-shaped component
// config subtrees (cpu/gpu use `max_temp_c`; ram uses `max_errors`; ssd uses
// `min_seq_read_mb_s`/`min_seq_write_mb_s`/`smart_reallocated_sectors_max`). This implementation
// uses a naming convention: any config key in the matching component's config subtree that starts
// with `max_` is treated as an upper-bound hard limit if the SAME key name is present in
// summary_stats; any key starting with `min_` is treated as a lower-bound hard limit the same way.
// Keys that don't fit that convention (e.g. `smart_reallocated_sectors_max`, or non-threshold keys
// like `tool`/`mode`/`duration_minutes`/`config_profile`) are simply not evaluated as thresholds --
// they're metadata, or in the case of `smart_reallocated_sectors_max`, the client's parsed
// summary_stats key isn't specified by CONTRACT.md and so isn't guessed at here. Separately,
// `error_count > 0` is always treated as an unconditional hard fail when present in summary_stats,
// per the literal wording of section 7 ("tool reported errors (error_count > 0)"), independent of
// any config key.
//
// "Borderline" for `flagged` is interpreted as within 5% of a hard-limit threshold (section 7's
// own example: "within 5% of a threshold"), applied to whichever max_/min_ keys were checked.

const EPSILON = 1e-9;

function isThresholdKey(key) {
  return key.startsWith('max_') || key.startsWith('min_');
}

/**
 * @param {string} component - e.g. "cpu"
 * @param {object} config - the full config object (all component subtrees + concurrency)
 * @param {object} summaryStats - client-submitted summary_stats for this test_run
 * @param {string|null|undefined} stopReason - client-submitted stop_reason, if any
 * @returns {{ result: 'pass'|'fail'|'flagged'|'aborted', reasons: string[] }}
 *   `reasons` is extra diagnostic detail (not part of CONTRACT.md's response shape) useful for
 *   logs/debugging; callers should only persist/return `result`.
 */
function computeResult(component, config, summaryStats, stopReason) {
  if (stopReason) {
    return { result: 'aborted', reasons: [`stop_reason=${stopReason}`] };
  }

  const stats = summaryStats && typeof summaryStats === 'object' ? summaryStats : {};
  const componentConfig = (config && config[component]) || {};
  const reasons = [];
  let flagged = false;

  if (typeof stats.error_count === 'number' && stats.error_count > 0) {
    reasons.push(`error_count=${stats.error_count} > 0`);
    return { result: 'fail', reasons };
  }

  for (const [key, limit] of Object.entries(componentConfig)) {
    if (typeof limit !== 'number' || !isThresholdKey(key)) continue;
    const observed = stats[key];
    if (typeof observed !== 'number') continue;

    if (key.startsWith('max_')) {
      if (observed > limit + EPSILON) {
        reasons.push(`${key}=${observed} exceeds limit ${limit}`);
        return { result: 'fail', reasons };
      }
      if (observed >= limit * 0.95) {
        flagged = true;
        reasons.push(`${key}=${observed} within 5% of limit ${limit}`);
      }
    } else if (key.startsWith('min_')) {
      if (observed < limit - EPSILON) {
        reasons.push(`${key}=${observed} below minimum ${limit}`);
        return { result: 'fail', reasons };
      }
      if (observed <= limit * 1.05) {
        flagged = true;
        reasons.push(`${key}=${observed} within 5% of minimum ${limit}`);
      }
    }
  }

  return { result: flagged ? 'flagged' : 'pass', reasons };
}

module.exports = { computeResult };
