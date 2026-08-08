'use strict';

// Concurrency validation rule, CONTRACT.md section 6 -- implemented exactly as specified there,
// component-agnostic (works the same for cpu/gpu/ram/ssd even though only cpu is exercised in
// this pass):
//
//   Given the active (ended_at IS NULL) test_runs already in this session:
//   - Requested component is `ram` or `ssd` -> reject (409) if ANY active test_run exists.
//   - Requested component is `cpu` or `gpu` -> reject (409) if any active test_run is `ram` or
//     `ssd`, or if a test_run for that same component is already active. Otherwise allowed (so
//     `cpu` then `gpu` while `cpu` is still running is valid -- that's the "together" mode).
//
// CONTRACT.md section 6 explicitly calls this out as the one piece of business logic that must
// match exactly between client and server, so this function is a direct, literal translation of
// the prose rule -- deliberately not "cleverer" or more general than what's written.

const EXCLUSIVE_COMPONENTS = new Set(['ram', 'ssd']);

/**
 * @param {string[]} activeComponents - components of currently-active (ended_at IS NULL)
 *   test_runs in the session.
 * @param {string} requestedComponent - the component of the test_run being requested.
 * @returns {{ ok: true } | { ok: false, active_component: string }}
 */
function checkConcurrency(activeComponents, requestedComponent) {
  if (EXCLUSIVE_COMPONENTS.has(requestedComponent)) {
    if (activeComponents.length > 0) {
      return { ok: false, active_component: activeComponents[0] };
    }
    return { ok: true };
  }

  // requestedComponent is cpu or gpu (or any future non-exclusive component).
  const blockingExclusive = activeComponents.find((c) => EXCLUSIVE_COMPONENTS.has(c));
  if (blockingExclusive) {
    return { ok: false, active_component: blockingExclusive };
  }
  if (activeComponents.includes(requestedComponent)) {
    return { ok: false, active_component: requestedComponent };
  }
  return { ok: true };
}

module.exports = { checkConcurrency, EXCLUSIVE_COMPONENTS };
