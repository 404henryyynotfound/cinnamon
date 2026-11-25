'use strict';

/**
 * Safe process actions. PIDs and signals are strictly validated; arbitrary
 * command strings are never accepted or executed.
 */

const { parsePsOutput, defaultRunCommand } = require('./system.js');

const ALLOWED_SIGNALS = Object.freeze(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGSTOP', 'SIGCONT']);
const SIGNAL_SET = new Set(ALLOWED_SIGNALS);

function validatePid(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) throw new TypeError('pid must be a positive integer');
  return value;
}

function result(ok, message, extra = {}) {
  return { ok, message, ...extra };
}

/** Send an allow-listed POSIX signal to a PID. */
function signal(pid, name, options = {}) {
  try {
    const target = validatePid(pid);
    const sig = String(name || '').toUpperCase();
    if (!SIGNAL_SET.has(sig)) throw new TypeError(`Signal must be one of ${ALLOWED_SIGNALS.join(', ')}`);
    const killImpl = options.killImpl || process.kill.bind(process);
    killImpl(target, sig);
    return result(true, `Sent ${sig} to process ${target}`, { pid: target, signal: sig, action: 'signal' });
  } catch (error) {
    return result(false, error && error.message ? error.message : 'Signal failed', { pid, signal: name, action: 'signal' });
  }
}

/** Change niceness through `renice` with numeric arguments only. */
async function setPriority(pid, niceness, options = {}) {
  try {
    const target = validatePid(pid);
    const value = Math.min(19, Math.max(-20, Math.trunc(Number(niceness))));
    if (!Number.isFinite(value)) throw new TypeError('niceness must be a number');
    if ((options.platform || process.platform) === 'win32') {
      return result(false, 'Changing priority is not supported on Windows', { pid: target, action: 'priority' });
    }
    const runCommand = options.runCommand || defaultRunCommand;
    const output = await runCommand('renice', ['-n', String(value), '-p', String(target)]);
    if (output && /\berror\b|operation not permitted|not permitted/i.test(output)) {
      return result(false, output.trim().slice(0, 200), { pid: target, action: 'priority', niceness: value });
    }
    return result(true, `Set niceness ${value} for process ${target}`, { pid: target, action: 'priority', niceness: value });
  } catch (error) {
    return result(false, error && error.message ? error.message : 'Priority change failed', { pid, action: 'priority' });
  }
}

/** Read one process' details via `ps -p <pid>`. */
async function details(pid, options = {}) {
  try {
    const target = validatePid(pid);
    const runCommand = options.runCommand || defaultRunCommand;
    const output = await runCommand('ps', ['-p', String(target), '-o', 'pid,ppid,user,comm,pcpu,pmem,rss,etime,stat,args']);
    const found = parsePsOutput(output).find((proc) => proc.pid === target);
    if (!found) return result(false, `Process ${target} was not found`, { pid: target, action: 'details' });
    return result(true, `Details for process ${target}`, { pid: target, action: 'details', process: found });
  } catch (error) {
    return result(false, error && error.message ? error.message : 'Could not read details', { pid, action: 'details' });
  }
}

/** UI-facing confirmation copy; the renderer must show this before acting. */
function confirmationFor(action, target = {}) {
  const label = target.name || target.pid || 'this process';
  switch (action) {
    case 'SIGKILL':
      return {
        title: 'Force stop process?',
        message: `Force-stopping ${label} cannot be undone and may lose unsaved work.`,
        severity: 'danger', requireConfirmation: true
      };
    case 'SIGTERM':
      return {
        title: 'Stop process?',
        message: `Ask ${label} to shut down cleanly.`,
        severity: 'warning', requireConfirmation: true
      };
    case 'SIGSTOP':
      return {
        title: 'Pause process?',
        message: `${label} will be frozen until it receives SIGCONT.`,
        severity: 'warning', requireConfirmation: true
      };
    case 'SIGCONT':
      return {
        title: 'Resume process?',
        message: `Continue ${label} if it is paused.`,
        severity: 'info', requireConfirmation: false
      };
    case 'priority':
      return {
        title: 'Change priority?',
        message: `Set niceness for ${label}. Lower values mean higher priority; negative values may need elevated privileges.`,
        severity: 'warning', requireConfirmation: true
      };
    default:
      return {
        title: 'Confirm action',
        message: `Run ${action} on ${label}?`,
        severity: 'info', requireConfirmation: true
      };
  }
}

module.exports = {
  ALLOWED_SIGNALS,
  validatePid,
  signal,
  setPriority,
  details,
  confirmationFor
};
