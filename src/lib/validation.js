'use strict';

const COMPONENTS = ['cpu', 'gpu', 'ram', 'ssd'];
const SESSION_TYPES = ['new_build', 'repair'];
// manual_stop is distinct from the other three: those are set by the PC client describing why
// *it* stopped: manual_stop is set by the server itself (dashboard.js's POST .../stop route)
// when a technician force-stops a test_run that's been "running" indefinitely because the client
// that owns it crashed, lost network, or otherwise never called anything again -- there's no
// client-reported reason available for those, so this is the dashboard's own explanation.
const STOP_REASONS = ['user_abort', 'tool_crash', 'client_error', 'manual_stop'];

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isValidComponent(v) {
  return COMPONENTS.includes(v);
}

function isValidSessionType(v) {
  return SESSION_TYPES.includes(v);
}

function isValidStopReason(v) {
  return STOP_REASONS.includes(v);
}

function isValidUuid(v) {
  return (
    typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  );
}

module.exports = {
  COMPONENTS,
  SESSION_TYPES,
  STOP_REASONS,
  isNonEmptyString,
  isValidComponent,
  isValidSessionType,
  isValidStopReason,
  isValidUuid,
};
