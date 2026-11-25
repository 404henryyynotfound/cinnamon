'use strict';

/**
 * cinnamon-cli command dispatcher. Every I/O boundary (sampling, sleeping,
 * signals, renice, output) is injectable, so tests never touch real processes.
 */

const { version } = require('../package.json');
const validate = require('./validate.js');
const sampling = require('./sample.js');
const snapshotLib = require('./snapshot.js');
const reports = require('./report.js');
const diagnose = require('./diagnose.js');
const format = require('./format.js');
const operations = require('./operations.js');

const HELP = `cinnamon-cli ${version} — offline computer task manager

Usage:
  cinnamon-cli <command> [options]

Commands:
  ps [--sort cpu|memory|pid|name] [--limit N] [--format table|json|csv]
  top [--interval SECONDS] [--count N] [--limit N]
  kill <pid...> [SIGTERM|SIGKILL|SIGINT|SIGSTOP|SIGCONT] [--yes]
  pause <pid...> [--yes]          Send SIGSTOP
  resume <pid...> [--yes]         Send SIGCONT
  renice <pid> <priority> [--yes] Set niceness (-20..19)
  report [--format json|csv|markdown]
  diagnose [--format text|json]
  --version, --help

Global options:
  --yes, -y       Confirm a process-changing operation
  --json          Shorthand for --format json
  --help, -h      Show this help (or help for a command)

No account, no telemetry, no downloads. Signal names and priorities are
allow-listed; arbitrary shell strings are never executed.`;

const COMMAND_HELP = Object.freeze({
  ps: `cinnamon-cli ps — list processes\n\nOptions:\n  --sort cpu|memory|pid|name   Sort order (default: cpu)\n  --limit N                    Maximum rows (default: 20)\n  --format table|json|csv      Output format (default: table)`,
  top: `cinnamon-cli top — repeatedly sample the busiest processes\n\nOptions:\n  --interval SECONDS  Delay between samples (default: 1)\n  --count N           Number of samples (default: 1)\n  --limit N           Rows per sample (default: 20)`,
  kill: `cinnamon-cli kill <pid...> [signal] [--yes]\n\nSend an allow-listed signal. Defaults to SIGTERM. Requires --yes.`,
  pause: `cinnamon-cli pause <pid...> [--yes]\n\nSend SIGSTOP. Requires --yes.`,
  resume: `cinnamon-cli resume <pid...> [--yes]\n\nSend SIGCONT. Requires --yes.`,
  renice: `cinnamon-cli renice <pid> <priority> [--yes]\n\nPriority must be an integer from -20 to 19. Requires --yes.`,
  report: `cinnamon-cli report [--format json|csv|markdown]\n\nBuild a deterministic process report on stdout.`,
  diagnose: `cinnamon-cli diagnose [--format text|json]\n\nRank local findings such as CPU hogs, memory pressure and zombies.`
});

function parseArgs(argv) {
  const flags = {};
  const options = {};
  const positional = [];
  const valueOptions = new Set(['format', 'limit', 'sort', 'interval', 'count']);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (arg === '--yes' || arg === '-y') flags.yes = true;
    else if (arg === '--json') options.format = 'json';
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (valueOptions.has(arg.replace(/^--/, '')) && arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[index + 1];
      if (value === undefined || String(value).startsWith('--')) throw new TypeError(`${arg} needs a value`);
      options[key] = value;
      index += 1;
    } else if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      if (equals !== -1) {
        const key = arg.slice(2, equals);
        if (!valueOptions.has(key)) throw new TypeError(`Unknown option: --${key}`);
        options[key] = arg.slice(equals + 1);
      } else {
        throw new TypeError(`Unknown option: ${arg}`);
      }
    } else if (arg.startsWith('-') && arg !== '-') {
      throw new TypeError(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { flags, options, positional };
}

function help(topic, out, err) {
  if (!topic) { out(HELP); return 0; }
  const text = COMMAND_HELP[String(topic).toLowerCase()];
  if (!text) {
    err(`Unknown command: ${topic}`);
    return 1;
  }
  out(text);
  return 0;
}

function sampleOptions(deps, options) {
  return { platform: deps.platform, ...(deps.sampleOptions || {}), ...options };
}

async function getProcesses(deps, options = {}) {
  const sample = deps.sample || sampling.listProcesses;
  const processes = await sample(sampleOptions(deps, options));
  return Array.isArray(processes) ? processes : [];
}

async function collect(deps, options = {}) {
  const snapshotFn = deps.snapshot || snapshotLib.systemSnapshot;
  const [processes, snapshot] = await Promise.all([
    getProcesses(deps, options),
    Promise.resolve(snapshotFn({ platform: deps.platform, now: deps.now, ...(deps.snapshotOptions || {}) }))
  ]);
  return { processes, snapshot: snapshot || {} };
}

function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function runCommandLine(argv = [], deps = {}) {
  const out = deps.out || ((line) => { process.stdout.write(`${line}\n`); });
  const err = deps.err || ((line) => { process.stderr.write(`${line}\n`); });
  const args = Array.isArray(argv) ? argv.slice() : [];
  const first = String(args[0] || '');

  try {
    if (first === '--version' || first === '-V' || first === 'version') { out(version); return 0; }
    if (!args.length || first === '--help' || first === '-h') {
      return help(args[1], out, err);
    }

    const parsed = parseArgs(args);
    const command = String(parsed.positional[0] || '').toLowerCase();
    if (!command) return parsed.flags.help ? help(undefined, out, err) : help(undefined, out, err);
    if (command === 'help') return help(parsed.positional[1], out, err);
    if (parsed.flags.help) return help(command, out, err);

    if (command === 'ps' || command === 'list' || command === 'ls') {
      const sort = validate.validateFormat(parsed.options.sort, format.SORTS, 'cpu');
      const limit = validate.validateLimit(parsed.options.limit, 20, 5000);
      const output = validate.validateFormat(parsed.options.format, ['table', 'json', 'csv'], 'table');
      const processes = format.sortProcesses(await getProcesses(deps, parsed.options), sort).slice(0, limit);
      if (output === 'json') out(JSON.stringify(processes, null, 2));
      else if (output === 'csv') out(reports.toCSV(reports.buildProcessReport({ processes })));
      else out(format.processTable(processes, { sort, limit }));
      return 0;
    }

    if (command === 'top') {
      const limit = validate.validateLimit(parsed.options.limit, 20, 5000);
      const count = validate.validateCount(parsed.options.count, 1, 60);
      const seconds = validate.validateSeconds(parsed.options.interval, 1);
      const sleep = deps.sleep || defaultSleep;
      for (let index = 0; index < count; index += 1) {
        const processes = await getProcesses(deps, parsed.options);
        const now = deps.now ? new Date(deps.now) : new Date();
        out(`cinnamon top · ${now.toISOString()} · ${processes.length} processes`);
        out(format.processTable(processes, { sort: 'cpu', limit }));
        if (index < count - 1) await sleep(seconds * 1000);
      }
      return 0;
    }

    if (command === 'report' || command === 'diagnose') {
      const allowed = command === 'report' ? reports.FORMATS : ['text', 'json'];
      const output = validate.validateFormat(parsed.options.format, allowed,
        command === 'report' ? 'json' : (parsed.flags.json ? 'json' : 'text'));
      const { processes, snapshot } = await collect(deps, parsed.options);
      const analysis = diagnose.enrich(diagnose.analyze(snapshot, processes, { now: deps.now }), snapshot);
      if (command === 'diagnose') {
        out(output === 'json' ? JSON.stringify(analysis, null, 2) : format.findingLines(analysis).join('\n'));
      } else {
        out(reports.toFormat(reports.buildProcessReport({
          snapshot, processes, findings: analysis.findings, now: deps.now
        }), output));
      }
      return 0;
    }

    if (Object.prototype.hasOwnProperty.call(validate.OPERATION_SIGNALS, command) || command === 'renice') {
      const plan = operations.buildPlan(command, parsed.positional.slice(1), parsed.flags);
      const result = await operations.execute(plan, {
        killImpl: deps.killImpl,
        runCommand: deps.runCommand,
        platform: deps.platform
      });
      if (!result.ok) {
        err(result.message);
        return result.code || 1;
      }
      out(result.message);
      return 0;
    }

    err(`Unknown command: ${command}. Try cinnamon-cli --help`);
    return 1;
  } catch (error) {
    err(`cinnamon-cli: ${error && error.message ? error.message : error}`);
    return 1;
  }
}

module.exports = { version, HELP, parseArgs, help, run: runCommandLine };
