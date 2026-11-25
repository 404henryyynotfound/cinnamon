'use strict';

/**
 * Cross-platform process sampling with Node built-ins only.
 * Linux is read from /proc; every other platform uses `ps` through execFile
 * (never a shell). All readers are injectable so tests use fixtures only.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const childProcess = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(childProcess.execFile);
const PS_COLUMNS = 'pid,ppid,user,comm,pcpu,pmem,rss,etime,stat,args';

function number(value, fallback = 0) {
  const text = String(value === null || value === undefined ? '' : value).replace(/%$/, '').trim();
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(number(value) * factor) / factor;
}

function cleanCommand(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

/** Convert ps `etime` (`mm:ss`, `hh:mm:ss`, `d-hh:mm:ss`) into seconds. */
function parseEtime(value) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (!text) return 0;
  const dayMatch = /^(\d+)-(.+)$/.exec(text);
  const days = dayMatch ? number(dayMatch[1]) : 0;
  const parts = (dayMatch ? dayMatch[2] : text).split(':').map((part) => number(part, NaN));
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  let seconds = 0;
  if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
  else if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else seconds = parts[0];
  return Math.max(0, Math.round(days * 86400 + seconds));
}

function normalizeProcess(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pid = Math.trunc(number(raw.pid, -1));
  if (pid <= 0) return null;
  const name = String(raw.name || raw.comm || 'unknown').trim().split(/[\\/]/).pop() || 'unknown';
  const memoryBytes = raw.memoryBytes !== undefined
    ? Math.max(0, Math.round(number(raw.memoryBytes)))
    : Math.max(0, Math.round(number(raw.rss) * 1024));
  return {
    pid,
    ppid: Math.max(0, Math.trunc(number(raw.ppid))),
    user: String(raw.user || '').trim().slice(0, 80),
    name: name.slice(0, 120),
    state: String(raw.state || raw.stat || '?').trim().slice(0, 8) || '?',
    cpu: round(Math.max(0, number(raw.cpu))),
    memory: round(Math.max(0, number(raw.memory))),
    memoryBytes,
    uptime: Math.max(0, Math.round(number(raw.uptime === undefined ? raw.etime : raw.uptime))),
    command: cleanCommand(raw.command || raw.args)
  };
}

/** Parse `ps -eo pid,ppid,user,comm,pcpu,pmem,rss,etime,stat,args`. */
function parsePsOutput(text) {
  const processes = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim() || /^\s*PID\b/i.test(line)) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!match) continue;
    const proc = normalizeProcess({
      pid: match[1], ppid: match[2], user: match[3], name: match[4],
      cpu: match[5], memory: match[6], memoryBytes: number(match[7]) * 1024,
      uptime: parseEtime(match[8]), state: match[9], command: match[10]
    });
    if (proc) processes.push(proc);
  }
  return processes;
}

/** Parse one `/proc/<pid>/stat` line; comm may contain spaces or parentheses. */
function parseProcStat(text) {
  const source = String(text || '');
  const open = source.indexOf('(');
  const close = source.lastIndexOf(')');
  if (open === -1 || close <= open) return null;
  const pid = Math.trunc(number(source.slice(0, open)));
  if (pid <= 0) return null;
  const fields = source.slice(close + 1).trim().split(/\s+/);
  return {
    pid,
    comm: source.slice(open + 1, close),
    state: fields[0] || '?',
    ppid: Math.trunc(number(fields[1])),
    utime: number(fields[11]),
    stime: number(fields[12]),
    starttime: number(fields[19])
  };
}

/** Parse the small subset of `/proc/<pid>/status` fields the CLI needs. */
function parseStatus(text) {
  const status = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (match) status[match[1]] = match[2].trim();
  }
  return status;
}

/** Total CPU jiffies from the aggregate `/proc/stat` line. */
function parseCpuTicks(text) {
  const line = String(text || '').split(/\r?\n/).find((entry) => /^cpu\s/.test(entry));
  if (!line) return 0;
  const fields = line.trim().split(/\s+/).slice(1, 9);
  return fields.reduce((sum, field) => sum + number(field), 0);
}

/** Map `/etc/passwd` UIDs to login names. */
function parsePasswd(text) {
  const users = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const fields = line.split(':');
    if (fields.length < 3 || !fields[0]) continue;
    users[fields[2]] = fields[0];
  }
  return users;
}

function defaultRunCommand(command, args = [], options = {}) {
  return execFileAsync(command, args, {
    timeout: 3000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    ...options
  }).then((result) => String((result && result.stdout) || '')).catch(() => '');
}

function defaultReadFile(file, encoding = 'utf8') {
  return fs.promises.readFile(file, encoding).then(String);
}

function defaultReadDir(dir) {
  return fs.promises.readdir(dir);
}

function context(options) {
  return {
    platform: options.platform || process.platform,
    procRoot: options.procRoot || '/proc',
    passwdFile: options.passwdFile || '/etc/passwd',
    clockTicks: number(options.clockTicks, 100) || 100,
    totalMemory: number(options.totalMemory, os.totalmem()),
    systemUptime: options.systemUptime,
    readDir: options.readDir || defaultReadDir,
    readFile: options.readFile || defaultReadFile,
    runCommand: options.runCommand || defaultRunCommand
  };
}

async function safeRead(ctx, file) {
  try { return String(await ctx.readFile(file, 'utf8')); } catch { return ''; }
}

async function readOneProc(pid, ctx, shared) {
  const base = path.join(ctx.procRoot, String(pid));
  const [statText, statusText, cmdline] = await Promise.all([
    safeRead(ctx, path.join(base, 'stat')),
    safeRead(ctx, path.join(base, 'status')),
    safeRead(ctx, path.join(base, 'cmdline'))
  ]);
  const stat = parseProcStat(statText);
  if (!stat) return null;
  const status = parseStatus(statusText);
  const uid = String(status.Uid || '').split(/\s+/)[0] || '';
  const ticks = Math.max(0, stat.utime + stat.stime);
  const memoryBytes = Math.max(0, number(String(status.VmRSS || '').split(/\s+/)[0]) * 1024);
  return normalizeProcess({
    pid,
    ppid: number(status.PPid, stat.ppid),
    user: shared.users[uid] || uid || '—',
    name: status.Name || stat.comm,
    state: status.State || stat.state,
    cpu: shared.totalTicks > 0 ? ticks / shared.totalTicks * 100 : 0,
    memory: ctx.totalMemory > 0 ? memoryBytes / ctx.totalMemory * 100 : 0,
    memoryBytes,
    uptime: Math.max(0, shared.uptimeSeconds - stat.starttime / ctx.clockTicks),
    command: cmdline
  });
}

/** Read the process table from /proc with no external commands. */
async function listFromProc(options = {}) {
  const ctx = context(options);
  let entries;
  try {
    entries = await ctx.readDir(ctx.procRoot);
  } catch {
    return null;
  }
  const pids = Array.from(entries || [])
    .map((entry) => String(entry))
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .filter((pid) => pid > 0);

  const [passwd, statText, uptimeText] = await Promise.all([
    safeRead(ctx, ctx.passwdFile),
    safeRead(ctx, path.join(ctx.procRoot, 'stat')),
    safeRead(ctx, path.join(ctx.procRoot, 'uptime'))
  ]);
  const uptimeField = uptimeText.split(/\s+/)[0];
  const fallbackUptime = uptimeField ? number(uptimeField, os.uptime()) : os.uptime();
  const shared = {
    users: parsePasswd(passwd),
    totalTicks: parseCpuTicks(statText),
    uptimeSeconds: ctx.systemUptime === undefined ? fallbackUptime : number(ctx.systemUptime)
  };

  const settled = await Promise.all(pids.map((pid) => readOneProc(pid, ctx, shared).catch(() => null)));
  const processes = settled.filter(Boolean);
  return processes.length ? processes : null;
}

function psArgs(platform) {
  const base = ['-eo', PS_COLUMNS];
  if (platform === 'darwin') return base.concat(['-r']);
  if (platform === 'linux') return base.concat(['--sort=-pcpu']);
  return base;
}

/** Fallback for macOS, Windows and any other POSIX host with `ps`. */
async function listFromPs(options = {}) {
  const ctx = context(options);
  let output = await ctx.runCommand('ps', psArgs(ctx.platform));
  if (!output && psArgs(ctx.platform).length > 2) {
    output = await ctx.runCommand('ps', ['-eo', PS_COLUMNS]);
  }
  return output ? parsePsOutput(output) : [];
}

/** Prefer /proc on Linux, otherwise use safely parsed `ps` output. */
async function listProcesses(options = {}) {
  if (context(options).platform === 'linux' && !options.forcePs) {
    const fromProc = await listFromProc(options);
    if (fromProc) return fromProc;
  }
  return listFromPs(options);
}

module.exports = {
  PS_COLUMNS,
  number,
  round,
  cleanCommand,
  parseEtime,
  normalizeProcess,
  parsePsOutput,
  parseProcStat,
  parseStatus,
  parseCpuTicks,
  parsePasswd,
  defaultRunCommand,
  defaultReadFile,
  defaultReadDir,
  listFromProc,
  listFromPs,
  listProcesses
};
