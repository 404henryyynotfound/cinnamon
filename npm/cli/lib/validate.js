'use strict';

/**
 * Strict validation for every value that can affect a process. Adapted from
 * cinnamon/lib/actions.js so the CLI stays standalone and dependency-free.
 * Nothing here accepts a shell string.
 */

const ALLOWED_SIGNALS = Object.freeze(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGSTOP', 'SIGCONT']);
const OPERATION_SIGNALS = Object.freeze({
  kill: 'SIGKILL',
  terminate: 'SIGTERM',
  interrupt: 'SIGINT',
  pause: 'SIGSTOP',
  resume: 'SIGCONT'
});

function validatePid(value, label = 'pid') {
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return pid;
}

function parsePids(value, label = 'pid') {
  if (value === undefined || value === null) throw new TypeError(`${label} is required`);
  const items = String(value).split(/[\s,]+/).filter(Boolean);
  if (!items.length) throw new TypeError(`${label} is required`);
  return items.map((item) => validatePid(item, label));
}

function validateSignal(value, fallback = 'SIGTERM') {
  if (value === undefined || value === null || value === '') return fallback;
  const signal = String(value).trim().toUpperCase();
  if (!ALLOWED_SIGNALS.includes(signal)) {
    throw new TypeError(`signal must be one of ${ALLOWED_SIGNALS.join(', ')}`);
  }
  return signal;
}

function validatePriority(value) {
  const priority = Number(value);
  if (!Number.isInteger(priority) || priority < -20 || priority > 19) {
    throw new TypeError('priority must be an integer from -20 to 19');
  }
  return priority;
}

function validateLimit(value, fallback = 20, max = 5000) {
  if (value === undefined || value === null || value === '') return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new TypeError(`limit must be an integer from 1 to ${max}`);
  }
  return limit;
}

function validateCount(value, fallback = 1, max = 60) {
  return validateLimit(value, fallback, max);
}

function validateSeconds(value, fallback = 1, max = 3600) {
  if (value === undefined || value === null || value === '') return fallback;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0.1 || seconds > max) {
    throw new TypeError(`seconds must be a number from 0.1 to ${max}`);
  }
  return seconds;
}

function validateFormat(value, allowed, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const format = String(value).trim().toLowerCase();
  if (!allowed.includes(format)) throw new TypeError(`format must be one of ${allowed.join(', ')}`);
  return format;
}

function requireYes(flags) {
  if (!flags || !flags.yes) {
    const error = new Error('This operation changes a process; add --yes to confirm');
    error.code = 'CONFIRMATION_REQUIRED';
    throw error;
  }
}

module.exports = {
  ALLOWED_SIGNALS,
  OPERATION_SIGNALS,
  validatePid,
  parsePids,
  validateSignal,
  validatePriority,
  validateLimit,
  validateCount,
  validateSeconds,
  validateFormat,
  requireYes
};
