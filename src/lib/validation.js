'use strict';

const COMPONENTS = ['cpu', 'gpu', 'ram', 'ssd'];
const SESSION_TYPES = ['new_build', 'repair'];
const STOP_REASONS = ['user_abort', 'tool_crash', 'client_error'];

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
