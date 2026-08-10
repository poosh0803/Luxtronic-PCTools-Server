'use strict';

// Result computation, CONTRACT.md section 7. Component-agnostic by design (only "cpu" is
// exercised end-to-end this pass, but the rule itself doesn't special-case any component).
//
// JUDGMENT CALL (flagged in the final report): CONTRACT.md doesn't spell out a generic algorithm
// for matching summary_stats fields against config thresholds across differently-shaped component
// config subtrees (cpu/gpu use `max_temp_c`; ram uses `max_errors`; ssd uses several `max_smart_*`/
// `min_smart_*`/`min_seq_*` keys, see below). This implementation uses a naming convention: any
// config key in the matching component's config subtree that STARTS WITH `max_` is treated as an
// upper-bound hard limit if the SAME key name is present in summary_stats; any key starting with
// `min_` is treated as a lower-bound hard limit the same way. Keys that don't fit that convention
// (non-threshold metadata like `tool`/`mode`/`duration_minutes`/`config_profile`) are simply not
// evaluated as thresholds. Separately, `error_count > 0` is always treated as an unconditional hard
// fail when present in summary_stats, per the literal wording of section 7 ("tool reported errors
// (error_count > 0)"), independent of any config key.
//
// The ssd subtree is a real example of why the prefix (not suffix) matters: an earlier version of
// config/default.json had `smart_reallocated_sectors_max` -- "max" as a suffix, which this
// convention never matches (`startsWith('max_')` is false), so that threshold silently never
// evaluated, ever, since the day it was written. Caught once the client side actually implemented
// SMART reading (Luxtronic-PCTools-Client's SsdSmartReader) and its README flagged that ATA/SATA
// and NVMe drives expose entirely different SMART fields under the same attribute IDs (ATA
// attribute 5 = "Reallocated Sectors Count", NVMe attribute 5 = "Percentage Used" -- unrelated
// metrics that happen to share a number). Fixed by renaming to `max_smart_reallocated_sectors`
// (ATA-only) and adding NVMe-specific `max_smart_percentage_used` / `min_smart_available_spare_percent`
// / `max_smart_media_errors` alongside it. Only whichever subset the client actually populates in
// summary_stats for a given drive's bus type gets evaluated -- the rest are silently skipped by the
// same "missing key -> not evaluated" behavior already relied on elsewhere in this function, which
// is exactly the behavior needed here since a single drive is never both ATA and NVMe.
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
      // limit === 0 is a real, common case here (max_smart_reallocated_sectors: 0,
      // max_errors: 0, ...) -- "5% of zero" is a zero-width band, so limit * 0.95 is just 0
      // again, which would make the >= check true for every non-negative observation and flag
      // the healthy observed=0 case forever. A zero-tolerance metric has no meaningful
      // "approaching the limit" zone below zero (you can't have -1 reallocated sectors) --
      // it's either exactly at the ideal 0 (pass) or over it (already caught above as fail).
      if (limit !== 0 && observed >= limit * 0.95) {
        flagged = true;
        reasons.push(`${key}=${observed} within 5% of limit ${limit}`);
      }
    } else if (key.startsWith('min_')) {
      if (observed < limit - EPSILON) {
        reasons.push(`${key}=${observed} below minimum ${limit}`);
        return { result: 'fail', reasons };
      }
      if (limit !== 0 && observed <= limit * 1.05) {
        flagged = true;
        reasons.push(`${key}=${observed} within 5% of minimum ${limit}`);
      }
    }
  }

  return { result: flagged ? 'flagged' : 'pass', reasons };
}

module.exports = { computeResult };
