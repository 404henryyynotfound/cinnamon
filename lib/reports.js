'use strict';

/**
 * Pure process-report builders and small helpers for pinned processes.
 * Report functions never touch the filesystem or the network; callers pass in
 * a snapshot, a process list and (optionally) local AI findings.
 */

const FORMATS = Object.freeze(['json', 'csv', 'markdown']);
const DEFAULT_LIMITS = Object.freeze({ top: 10, groups: 10, rows: 250 });

function text(value, fallback = '') {
  return value === null || value === undefined ? fallback : String(value);
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(num(value) * factor) / factor;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value === undefined || value === null || value === '' ? Date.now() : value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function summarizeProcess(proc) {
  const source = isObject(proc) ? proc : {};
  return {
    pid: Math.max(0, Math.trunc(num(source.pid))),
    ppid: Math.max(0, Math.trunc(num(source.ppid))),
    name: text(source.name, 'unknown').slice(0, 160),
    user: text(source.user, '—'),
    state: text(source.state, '?'),
    command: text(source.command).slice(0, 2000),
    cpu: round(source.cpu),
    memory: round(source.memory),
    memoryBytes: Math.max(0, Math.round(num(source.memoryBytes))),
    uptime: Math.max(0, Math.round(num(source.uptime)))
  };
}

function summarizeFinding(finding) {
  const source = isObject(finding) ? finding : {};
  return {
    severity: text(source.severity, 'medium'),
    title: text(source.title, 'Finding').slice(0, 240),
    evidence: text(source.evidence),
    explanation: text(source.explanation)
  };
}

function groupProcesses(processes, key, limit) {
  const groups = new Map();
  for (const proc of processes) {
    const name = text(proc[key], key === 'user' ? '—' : '?');
    const group = groups.get(name) || { key: name, count: 0, cpu: 0, memoryBytes: 0 };
    group.count += 1;
    group.cpu += proc.cpu;
    group.memoryBytes += proc.memoryBytes;
    groups.set(name, group);
  }
  return Array.from(groups.values())
    .map((group) => ({ ...group, cpu: round(group.cpu) }))
    .sort((a, b) => b.cpu - a.cpu || String(a.key).localeCompare(String(b.key)))
    .slice(0, limit);
}

/** Build a deterministic, JSON-serializable report from sampled data. */
function buildProcessReport(input = {}) {
  const source = isObject(input) ? input : {};
  const snapshot = isObject(source.snapshot) ? source.snapshot : {};
  const requested = isObject(source.limits) ? source.limits : {};
  const limits = {
    top: Math.max(1, Math.min(100, Math.trunc(num(requested.top, DEFAULT_LIMITS.top)))),
    groups: Math.max(1, Math.min(100, Math.trunc(num(requested.groups, DEFAULT_LIMITS.groups)))),
    rows: Math.max(1, Math.min(5000, Math.trunc(num(requested.rows, DEFAULT_LIMITS.rows))))
  };
  const processes = (Array.isArray(source.processes) ? source.processes : [])
    .map(summarizeProcess)
    .filter((proc) => proc.pid > 0);
  const findings = (Array.isArray(source.findings) ? source.findings : []).map(summarizeFinding);
  const byCpu = processes.slice().sort((a, b) => b.cpu - a.cpu || a.pid - b.pid);
  const byMemory = processes.slice().sort((a, b) => b.memoryBytes - a.memoryBytes || a.pid - b.pid);
  const byUser = groupProcesses(processes, 'user', limits.groups);
  const byState = groupProcesses(processes, 'state', limits.groups);
  const uniqueUsers = new Set(processes.map((proc) => proc.user)).size;
  const uniqueStates = new Set(processes.map((proc) => proc.state)).size;

  return {
    app: 'cinnamon',
    type: 'process-report',
    version: 1,
    generatedAt: timestamp(source.now),
    sampledAt: text(snapshot.timestamp) || null,
    host: text(snapshot.hostname) || null,
    platform: text(snapshot.platform) || null,
    limits,
    totals: {
      processes: processes.length,
      users: uniqueUsers,
      states: uniqueStates,
      cpu: round(processes.reduce((sum, proc) => sum + proc.cpu, 0)),
      memoryBytes: processes.reduce((sum, proc) => sum + proc.memoryBytes, 0),
      zombies: processes.filter((proc) => proc.state.toUpperCase().startsWith('Z')).length,
      running: processes.filter((proc) => proc.state.toUpperCase().startsWith('R')).length,
      pinned: Array.isArray(source.pinned) ? source.pinned.length : 0
    },
    topCpu: byCpu.slice(0, limits.top),
    topMemory: byMemory.slice(0, limits.top),
    byUser,
    byState,
    findings,
    rows: (source.preserveOrder ? processes : byCpu).slice(0, limits.rows)
  };
}

function toJSON(report, options = {}) {
  const indent = Number.isFinite(options.indent) ? Math.max(0, Math.min(8, options.indent)) : 2;
  return JSON.stringify(report && typeof report === 'object' ? report : {}, null, indent);
}

function csvCell(value) {
  return `"${text(value).replace(/"/g, '""')}"`;
}

/** Machine-readable CSV of the current process rows. */
function toCSV(report) {
  const rows = report && Array.isArray(report.rows) ? report.rows : [];
  const columns = [
    ['pid', 'pid'], ['ppid', 'ppid'], ['name', 'name'], ['user', 'user'], ['state', 'state'],
    ['cpu_percent', 'cpu'], ['memory_percent', 'memory'], ['memory_bytes', 'memoryBytes'],
    ['uptime_seconds', 'uptime'], ['command', 'command']
  ];
  const lines = [columns.map(([header]) => csvCell(header)).join(',')];
  for (const row of rows) lines.push(columns.map(([, key]) => csvCell(row[key])).join(','));
  return lines.join('\n');
}

function mdCell(value) {
  return text(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function markdownTable(headers, rows) {
  const lines = [
    `| ${headers.map(mdCell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`
  ];
  for (const row of rows) lines.push(`| ${row.map(mdCell).join(' | ')} |`);
  return lines;
}

/** Human-readable Markdown summary with the same data as the JSON report. */
function toMarkdown(report) {
  const data = isObject(report) ? report : {};
  const totals = isObject(data.totals) ? data.totals : {};
  const lines = [
    '# cinnamon process report',
    '',
    `- Generated: ${text(data.generatedAt, '—')}`,
    `- Sampled: ${text(data.sampledAt, '—')}`,
    `- Host: ${text(data.host, '—')}`,
    `- Platform: ${text(data.platform, '—')}`,
    '',
    '## Totals',
    '',
    ...markdownTable(['Metric', 'Value'], [
      ['Processes', totals.processes || 0],
      ['Users', totals.users || 0],
      ['States', totals.states || 0],
      ['CPU %', totals.cpu || 0],
      ['Memory bytes', totals.memoryBytes || 0],
      ['Zombies', totals.zombies || 0],
      ['Running', totals.running || 0],
      ['Pinned', totals.pinned || 0]
    ]),
    '',
    '## Top CPU',
    '',
    ...markdownTable(['PID', 'Process', 'User', 'CPU %', 'Memory %'],
      (data.topCpu || []).map((proc) => [proc.pid, proc.name, proc.user, proc.cpu, proc.memory])),
    '',
    '## Top memory',
    '',
    ...markdownTable(['PID', 'Process', 'User', 'Memory %', 'Bytes'],
      (data.topMemory || []).map((proc) => [proc.pid, proc.name, proc.user, proc.memory, proc.memoryBytes])),
    '',
    '## By user',
    '',
    ...markdownTable(['User', 'Processes', 'CPU %', 'Memory bytes'],
      (data.byUser || []).map((group) => [group.key, group.count, group.cpu, group.memoryBytes])),
    '',
    '## By state',
    '',
    ...markdownTable(['State', 'Processes', 'CPU %'],
      (data.byState || []).map((group) => [group.key, group.count, group.cpu])),
    ''
  ];

  const findings = Array.isArray(data.findings) ? data.findings : [];
  lines.push('## AI findings', '');
  if (findings.length) {
    for (const finding of findings) {
      lines.push(`- **${mdCell(finding.severity)}** ${mdCell(finding.title)}`);
      if (finding.evidence) lines.push(`  - Evidence: ${mdCell(finding.evidence)}`);
      if (finding.explanation) lines.push(`  - Why: ${mdCell(finding.explanation)}`);
    }
  } else {
    lines.push('- No significant issues detected.');
  }
  return lines.join('\n');
}

function toFormat(report, format = 'json') {
  const name = String(format || 'json').toLowerCase();
  if (!FORMATS.includes(name)) throw new Error(`Report format must be one of ${FORMATS.join(', ')}`);
  if (name === 'csv') return toCSV(report);
  if (name === 'markdown') return toMarkdown(report);
  return toJSON(report);
}

// Pin helpers stay in one place so every caller uses the validated store API.
function pinProcess(store, pid, meta = {}) {
  if (!store || typeof store.pinProcess !== 'function') throw new TypeError('store must provide pinProcess()');
  return store.pinProcess(pid, meta);
}

function unpinProcess(store, pid) {
  if (!store || typeof store.unpinProcess !== 'function') throw new TypeError('store must provide unpinProcess()');
  return store.unpinProcess(pid);
}

function listPinned(store) {
  if (!store || typeof store.listPinned !== 'function') return [];
  return store.listPinned();
}

module.exports = {
  FORMATS,
  DEFAULT_LIMITS,
  buildProcessReport,
  toJSON,
  toCSV,
  toMarkdown,
  toFormat,
  pinProcess,
  unpinProcess,
  listPinned
};
