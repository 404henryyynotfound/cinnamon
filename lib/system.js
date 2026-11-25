'use strict';

/**
 * cinnamon system sampling. Only Node built-ins are used. All parsing and
 * transforms are pure and accept injected raw output, so tests never need a
 * real `ps`, `df`, /proc, or Electron.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(childProcess.execFile);
const PS_COLUMNS = 'pid,ppid,user,comm,pcpu,pmem,rss,etime,stat,args';
const PROC_NET_DEV = path.join('/proc', 'net', 'dev');

function number(value, fallback = 0) {
  const parsed = Number(String(value === null || value === undefined ? '' : value).replace(/%$/, '').trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(number(value) * factor) / factor;
}

function toDate(value) {
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/** Default command runner: never uses a shell, always bounded. */
async function defaultRunCommand(command, args = [], options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      timeout: 3000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      ...options
    });
    return String((result && result.stdout) || '');
  } catch {
    return '';
  }
}

async function defaultReadFile(file, encoding) {
  try { return String(await fs.promises.readFile(file, encoding || 'utf8')); } catch { return ''; }
}

/** Convert ps `etime` (`mm:ss`, `hh:mm:ss`, `d-hh:mm:ss`) into seconds. */
function parseEtime(value) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (!text) return 0;
  const dayMatch = /^(\d+)-(.+)$/.exec(text);
  const days = dayMatch ? number(dayMatch[1]) : 0;
  const rest = dayMatch ? dayMatch[2] : text;
  const parts = rest.split(':').map((part) => number(part, NaN));
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
  const name = String(raw.name || raw.comm || raw.command || 'unknown').trim().split(/[\\/]/).pop() || 'unknown';
  const memoryBytes = raw.memoryBytes !== undefined
    ? Math.max(0, Math.round(number(raw.memoryBytes)))
    : Math.max(0, Math.round(number(raw.rss) * 1024));
  return {
    pid,
    ppid: Math.trunc(number(raw.ppid)),
    user: String(raw.user || '').trim(),
    name: name.slice(0, 120),
    cpu: round(Math.max(0, number(raw.cpu))),
    memory: round(Math.max(0, number(raw.memory))),
    memoryBytes,
    uptime: parseEtime(raw.uptime === undefined ? raw.etime : raw.uptime),
    state: String(raw.state || raw.stat || '?').trim().slice(0, 8) || '?',
    command: String(raw.command || raw.args || '').trim().slice(0, 2000)
  };
}

/** Parse `ps -eo pid,ppid,user,comm,pcpu,pmem,rss,etime,stat,args --sort=-pcpu`. */
function parsePsOutput(text) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim());
  const processes = [];
  for (const line of lines) {
    if (/^\s*PID\b/i.test(line)) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!match) continue;
    const normalized = normalizeProcess({
      pid: match[1], ppid: match[2], user: match[3], name: match[4],
      cpu: match[5], memory: match[6], memoryBytes: number(match[7]) * 1024,
      uptime: parseEtime(match[8]), state: match[9], command: match[10]
    });
    if (normalized) processes.push(normalized);
  }
  return processes;
}

async function listProcesses(options = {}) {
  const runCommand = options.runCommand || defaultRunCommand;
  try {
    const output = await runCommand('ps', ['-eo', PS_COLUMNS, '--sort=-pcpu']);
    if (output) return parsePsOutput(output);
  } catch { /* graceful fallback below */ }
  return [];
}

/** Parse the one-line-per-filesystem output of `df -Pk`. */
function parseDfOutput(text) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim());
  const disks = [];
  for (const line of lines) {
    if (/^\s*Filesystem\b/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    disks.push({
      filesystem: parts[0],
      sizeKB: number(parts[1]),
      usedKB: number(parts[2]),
      availableKB: number(parts[3]),
      usePercent: round(number(parts[4])),
      mount: parts.slice(5).join(' ')
    });
  }
  return disks;
}

async function diskUsage(options = {}) {
  const runCommand = options.runCommand || defaultRunCommand;
  try {
    const output = await runCommand('df', ['-Pk']);
    return parseDfOutput(output);
  } catch { return []; }
}

/** Parse Linux `/proc/net/dev` into byte/packet/error counters. */
function parseProcNetDev(text) {
  const interfaces = {};
  for (const line of String(text || '').split(/\r?\n/).slice(2)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim();
    if (!name) continue;
    const fields = line.slice(colon + 1).trim().split(/\s+/).map((field) => number(field));
    if (fields.length < 12) continue;
    interfaces[name] = {
      rxBytes: fields[0], rxPackets: fields[1], rxErrors: fields[2], rxDropped: fields[3],
      txBytes: fields[8], txPackets: fields[9], txErrors: fields[10], txDropped: fields[11]
    };
  }
  return interfaces;
}

async function networkInterfaces(options = {}) {
  const readFile = options.readFile || defaultReadFile;
  if (!options.readFile && !options.file && options.platform && options.platform !== 'linux') return {};
  const output = await readFile(options.file || PROC_NET_DEV, 'utf8');
  return parseProcNetDev(output);
}

/** Bytes-per-second rates for each interface versus the previous sample. */
function computeNetworkRates(current, previous, elapsedSeconds) {
  const seconds = Math.max(0.001, number(elapsedSeconds, 1));
  const rates = {};
  for (const [name, counters] of Object.entries(current || {})) {
    const before = (previous || {})[name];
    if (!before) { rates[name] = { rxBytesPerSec: 0, txBytesPerSec: 0, available: false }; continue; }
    const rxBytesPerSec = Math.max(0, (number(counters.rxBytes) - number(before.rxBytes)) / seconds);
    const txBytesPerSec = Math.max(0, (number(counters.txBytes) - number(before.txBytes)) / seconds);
    rates[name] = {
      rxBytesPerSec: round(rxBytesPerSec, 2),
      txBytesPerSec: round(txBytesPerSec, 2),
      available: true
    };
  }
  return rates;
}

function cpuTimes(cpus) {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus || []) {
    for (const value of Object.values(cpu.times || {})) total += number(value);
    idle += number((cpu.times || {}).idle);
  }
  return { idle, total };
}

function computeCpuUsage(current, previous) {
  if (!previous || !previous.total || current.total <= previous.total) return 0;
  const deltaTotal = current.total - previous.total;
  const deltaIdle = Math.max(0, current.idle - previous.idle);
  return round(Math.max(0, Math.min(100, (1 - deltaIdle / deltaTotal) * 100)));
}

/** Snapshot of the machine. Pure parts are exported for direct testing. */
async function systemSnapshot(options = {}) {
  const now = options.now ? toDate(options.now) : new Date();
  const previous = options.previous || null;
  const cpus = os.cpus();
  const load = os.loadavg().map((value) => round(value, 2));
  const currentTimes = cpuTimes(cpus);
  const previousTimes = previous && previous.cpu && previous.cpu.cpuTimes;
  const cpuPercent = previousTimes
    ? computeCpuUsage(currentTimes, previousTimes)
    : round(Math.min(100, (load[0] || 0) / Math.max(1, cpus.length) * 100));

  const perCoreTimes = cpus.map((cpu, index) => {
    const prior = previous && previous.cpu && Array.isArray(previous.cpu.perCoreTimes) ? previous.cpu.perCoreTimes[index] : null;
    return { times: cpu.times || {}, usage: prior ? computeCpuUsage(cpu.times || {}, prior) : 0 };
  });

  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const disks = await diskUsage({ runCommand: options.runCommand });
  // networkInterfaces already parses the raw /proc/net/dev text into counters.
  const interfaces = await networkInterfaces({ readFile: options.readFile, platform: options.platform || process.platform });
  const elapsed = previous && previous.timestamp
    ? Math.max(0.001, (now.getTime() - toDate(previous.timestamp).getTime()) / 1000)
    : 0;
  const rates = previous && previous.network && previous.network.interfaces
    ? computeNetworkRates(interfaces, previous.network.interfaces, elapsed)
    : {};

  return {
    timestamp: now.toISOString(),
    platform: options.platform || process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    release: os.release(),
    uptimeSeconds: Math.round(os.uptime()),
    cpu: {
      percent: cpuPercent,
      cores: cpus.length,
      model: cpus[0] && cpus[0].model ? cpus[0].model : 'unknown',
      speeds: cpus.map((cpu) => number(cpu.speed)),
      load,
      perCore: perCoreTimes.map((core) => round(core.usage)),
      cpuTimes: currentTimes,
      perCoreTimes: perCoreTimes.map((core) => core.times)
    },
    memory: {
      totalBytes, freeBytes, usedBytes,
      percent: totalBytes ? round(usedBytes / totalBytes * 100) : 0
    },
    disks,
    network: {
      interfaces,
      rates,
      supported: Object.keys(interfaces).length > 0,
      rxBytesPerSec: round(Object.values(rates).reduce((sum, rate) => sum + number(rate.rxBytesPerSec), 0), 2),
      txBytesPerSec: round(Object.values(rates).reduce((sum, rate) => sum + number(rate.txBytesPerSec), 0), 2)
    },
    processCount: 0,
    topProcesses: []
  };
}

// -------------------------------------------------------------- history ring

function createHistory(limit = 180) {
  return { limit: Math.max(2, Math.trunc(number(limit, 180))), samples: [] };
}

function pushHistory(history, sample) {
  if (!sample) return history;
  const limit = history && history.limit ? history.limit : 180;
  const samples = (history && Array.isArray(history.samples) ? history.samples : []).concat([{ ...sample }]);
  while (samples.length > limit) samples.shift();
  return { limit, samples };
}

function historySeries(history, key = 'cpu') {
  const samples = history && Array.isArray(history.samples) ? history.samples : [];
  return samples.map((sample) => ({
    timestamp: sample.timestamp,
    value: number(sample[key]),
    label: sample.label || String(sample.timestamp || '').slice(11, 16)
  }));
}

function sampleFrom(snapshot, processes = []) {
  if (!snapshot) return null;
  return {
    timestamp: snapshot.timestamp,
    cpu: number(snapshot.cpu && snapshot.cpu.percent),
    memory: number(snapshot.memory && snapshot.memory.percent),
    memoryBytes: number(snapshot.memory && snapshot.memory.usedBytes),
    disk: Math.max(0, ...(snapshot.disks || []).map((disk) => number(disk.usePercent))),
    networkRx: number(snapshot.network && snapshot.network.rxBytesPerSec),
    networkTx: number(snapshot.network && snapshot.network.txBytesPerSec),
    load: (snapshot.cpu && snapshot.cpu.load) || [0, 0, 0],
    processCount: Array.isArray(processes) ? processes.length : number(snapshot.processCount),
    topProcesses: (Array.isArray(processes) ? processes : []).slice(0, 20).map((proc) => ({
      pid: proc.pid, name: proc.name, cpu: proc.cpu, memory: proc.memory, memoryBytes: proc.memoryBytes
    }))
  };
}

module.exports = {
  PS_COLUMNS,
  PROC_NET_DEV,
  defaultRunCommand,
  defaultReadFile,
  parseEtime,
  normalizeProcess,
  parsePsOutput,
  listProcesses,
  parseDfOutput,
  diskUsage,
  parseProcNetDev,
  networkInterfaces,
  computeNetworkRates,
  cpuTimes,
  computeCpuUsage,
  systemSnapshot,
  createHistory,
  pushHistory,
  historySeries,
  sampleFrom
};
