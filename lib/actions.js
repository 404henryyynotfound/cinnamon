'use strict';

/**
 * Safe process actions. PIDs, signals and operation names are strictly
 * validated; arbitrary command strings are never accepted or executed.
 * Every helper accepts injected implementations so it can be tested without
 * touching the real machine.
 */

const fs = require('fs');
const path = require('path');
const { parsePsOutput, defaultRunCommand } = require('./system.js');

const ALLOWED_SIGNALS = Object.freeze(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGSTOP', 'SIGCONT']);
const SIGNAL_SET = new Set(ALLOWED_SIGNALS);

/** UI-facing operation names mapped to the only signals cinnamon may send. */
const OPERATION_SIGNALS = Object.freeze({
  pause: 'SIGSTOP',
  resume: 'SIGCONT',
  interrupt: 'SIGINT',
  terminate: 'SIGTERM',
  kill: 'SIGKILL',
  setPriority: 'priority'
});
const ALLOWED_OPERATIONS = Object.freeze(Object.keys(OPERATION_SIGNALS));

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

/**
 * List open file descriptors from /proc/<pid>/fd on Linux. Directory and link
 * readers are injectable; a missing or disappearing process degrades to an
 * empty list instead of throwing.
 */
async function openFiles(pid, options = {}) {
  let target;
  try {
    target = validatePid(pid);
  } catch (error) {
    return result(false, error.message, { pid, action: 'openFiles', supported: false, files: [] });
  }

  const platform = options.platform || process.platform;
  if (platform !== 'linux') {
    return result(true, 'Open file descriptors are only available on Linux', {
      pid: target, action: 'openFiles', supported: false, files: []
    });
  }

  const limit = Math.max(1, Math.min(1000, Number(options.limit) || 200));
  const directory = options.directory || path.join('/proc', String(target), 'fd');
  const readDir = options.readDir || ((dir) => fs.promises.readdir(dir));
  const readLink = options.readLink || ((file) => fs.promises.readlink(file));

  let entries;
  try {
    entries = await readDir(directory);
  } catch {
    return result(true, 'Open file descriptors unavailable; the process may have exited', {
      pid: target, action: 'openFiles', supported: false, files: [], source: directory
    });
  }

  const files = [];
  for (const entry of entries.slice(0, limit)) {
    const fd = String(entry);
    try {
      files.push({ fd, target: String(await readLink(path.join(directory, fd))) });
    } catch {
      files.push({ fd, target: null });
    }
  }
  return result(true, `${files.length} open file descriptor(s) for process ${target}`, {
    pid: target,
    action: 'openFiles',
    supported: true,
    files,
    truncated: entries.length > limit,
    source: directory
  });
}

/** Build a parent/child tree from a flat process list without mutating it. */
function processTree(processes, options = {}) {
  const nodes = new Map();
  for (const proc of Array.isArray(processes) ? processes : []) {
    if (!proc || typeof proc !== 'object') continue;
    const pid = Number(proc.pid);
    const ppid = Number(proc.ppid) || 0;
    if (!Number.isInteger(pid) || pid <= 0) continue;
    nodes.set(pid, { ...proc, pid, ppid, children: [] });
  }

  const roots = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(node.ppid);
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  // A malformed ppid cycle must never hide every process or recurse forever.
  if (!roots.length && nodes.size) {
    for (const node of nodes.values()) { node.children = []; roots.push(node); }
  }

  const visited = new Set();
  const sort = (items) => {
    items.sort((a, b) => Number(b.cpu) - Number(a.cpu) || a.pid - b.pid);
    for (const node of items) {
      if (visited.has(node.pid)) { node.children = []; continue; }
      visited.add(node.pid);
      sort(node.children);
    }
  };
  sort(roots);
  return options.flat ? Array.from(nodes.values()) : roots;
}

/** UI-facing confirmation copy; signals and operation names are both accepted. */
function confirmationFor(action, target = {}) {
  const label = target.name || target.pid || 'this process';
  const normalized = OPERATION_SIGNALS[String(action)] || String(action || '').toUpperCase();
  switch (normalized) {
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
    case 'SIGINT':
      return {
        title: 'Interrupt process?',
        message: `Send an interrupt to ${label}; it may ignore the request.`,
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

/**
 * Run one of the named operations. Always resolves to a result object and
 * attaches confirmation metadata so callers cannot skip a safety prompt.
 */
async function operate(operation, pid, options = {}) {
  const name = String(operation || '');
  if (!Object.prototype.hasOwnProperty.call(OPERATION_SIGNALS, name)) {
    return result(false, `Operation must be one of ${ALLOWED_OPERATIONS.join(', ')}`, { operation: name, action: 'operate' });
  }
  const target = options.target || { pid: Number(pid) };
  const base = name === 'setPriority'
    ? await setPriority(pid, options.niceness, options)
    : await signal(pid, OPERATION_SIGNALS[name], options);
  return { ...base, operation: name, confirmation: confirmationFor(name, target) };
}

const wrappers = {
  pause: (pid, options = {}) => operate('pause', pid, options),
  resume: (pid, options = {}) => operate('resume', pid, options),
  interrupt: (pid, options = {}) => operate('interrupt', pid, options),
  terminate: (pid, options = {}) => operate('terminate', pid, options),
  kill: (pid, options = {}) => operate('kill', pid, options)
};

module.exports = {
  ALLOWED_SIGNALS,
  ALLOWED_OPERATIONS,
  OPERATION_SIGNALS,
  validatePid,
  signal,
  setPriority,
  details,
  openFiles,
  processTree,
  confirmationFor,
  operate,
  ...wrappers
};
