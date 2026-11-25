'use strict';

/**
 * Process-changing operations. PIDs, signals and priorities are validated
 * first, --yes is mandatory, and nothing ever runs a shell string. `renice`
 * uses execFile with a fixed numeric argument list.
 */

const childProcess = require('node:child_process');
const { promisify } = require('node:util');
const validate = require('./validate.js');

const execFileAsync = promisify(childProcess.execFile);

function defaultRunCommand(command, args = [], options = {}) {
  return execFileAsync(command, args, {
    timeout: 3000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
    ...options
  }).then((result) => String((result && result.stdout) || '')).catch((error) => {
    const message = error && error.message ? error.message : String(error);
    throw new Error(message);
  });
}

/**
 * Build a fully validated plan. `positional` excludes the command name.
 * Throws before any process is touched if an argument is invalid.
 */
function buildPlan(command, positional = [], flags = {}, options = {}) {
  const name = String(command || '');
  if (!Object.prototype.hasOwnProperty.call(validate.OPERATION_SIGNALS, name) && name !== 'renice') {
    throw new TypeError(`unknown operation: ${name}`);
  }
  const args = Array.isArray(positional) ? positional.slice() : [];

  if (name === 'renice') {
    if (args.length !== 2) throw new TypeError('usage: renice <pid> <priority> [--yes]');
    const pid = validate.validatePid(args[0]);
    const priority = validate.validatePriority(args[1]);
    return {
      operation: name,
      yes: Boolean(flags.yes),
      actions: [{ pid, priority }],
      confirmation: `Change niceness of PID ${pid} to ${priority}?`
    };
  }

  let signal = validate.OPERATION_SIGNALS[name];
  if (name === 'kill' && args.length > 1 && /^SIG[A-Z]+$/i.test(String(args[args.length - 1]))) {
    signal = validate.validateSignal(args.pop());
  }
  if (!args.length) throw new TypeError(`usage: ${name} <pid...> [--yes]`);
  const pids = validate.parsePids(args.join(' '));
  return {
    operation: name,
    yes: Boolean(flags.yes),
    actions: pids.map((pid) => ({ pid, signal })),
    confirmation: `Send ${signal} to ${pids.length === 1 ? `PID ${pids[0]}` : `${pids.length} processes`}?`
  };
}

async function applyAction(action, deps, platform) {
  try {
    if (action.priority !== undefined) {
      if (platform === 'win32') {
        return { ok: false, message: 'Changing priority is not supported on Windows' };
      }
      const runCommand = deps.runCommand || defaultRunCommand;
      const output = await runCommand('renice', ['-n', String(action.priority), '-p', String(action.pid)]);
      if (/\berror\b|operation not permitted|not permitted/i.test(String(output || ''))) {
        return { ok: false, message: String(output).trim().slice(0, 200) };
      }
      return { ok: true, message: `Set niceness ${action.priority} for process ${action.pid}` };
    }
    const signal = validate.validateSignal(action.signal);
    const killImpl = deps.killImpl || ((pid, name) => process.kill(pid, name));
    killImpl(action.pid, signal);
    return { ok: true, message: `Sent ${signal} to process ${action.pid}` };
  } catch (error) {
    return { ok: false, message: error && error.message ? error.message : 'Operation failed' };
  }
}

/** Execute a validated plan. Returns results instead of throwing. */
async function execute(plan, deps = {}) {
  try {
    validate.requireYes(plan);
  } catch (error) {
    return { ok: false, code: 2, message: error.message, confirmation: plan.confirmation, outcomes: [] };
  }
  const platform = deps.platform || process.platform;
  const outcomes = [];
  for (const action of plan.actions) {
    outcomes.push(await applyAction(action, deps, platform));
  }
  const ok = outcomes.every((outcome) => outcome.ok);
  return {
    ok,
    code: ok ? 0 : 1,
    message: ok ? outcomes.map((outcome) => outcome.message).join('\n') : outcomes.filter((o) => !o.ok).map((o) => o.message).join('\n'),
    confirmation: plan.confirmation,
    outcomes
  };
}

module.exports = { buildPlan, execute, defaultRunCommand };
