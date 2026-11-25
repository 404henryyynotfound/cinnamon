'use strict';

/**
 * Deterministic process reports. Adapted from cinnamon/lib/reports.js so the
 * CLI package can be published and used without the desktop app.
 */

const FORMATS = Object.freeze(['json', 'csv', 'markdown']);

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

function buildProcessReport(input = {}) {
  const source = isObject(input) ? input : {};
  const snapshot = isObject(source.snapshot) ? source.snapshot : {};
  const requested = isObject(source.limits) ? source.limits : {};
  const limits = {
    top: Math.max(1, Math.min(100, Math.trunc(num(requested.top, 10)))),
    groups: Math.max(1, Math.min(100, Math.trunc(num(requested.groups, 10)))),
    rows: Math.max(1, Math.min(5000, Math.trunc(num(requested.rows, 250))))
  };
  const processes = (Array.isArray(source.processes) ? source.processes : [])
    .map(summarizeProcess)
    .filter((proc) => proc.pid > 0);
  const findings = (Array.isArray(source.findings) ? source.findings : []).map(summarizeFinding);
  const byCpu = processes.slice().sort((a, b) => b.cpu - a.cpu || a.pid - b.pid);
  const byMemory = processes.slice().sort((a, b) => b.memoryBytes - a.memoryBytes || a.pid - b.pid);
  const date = source.now ? new Date(source.now) : new Date();
  const generatedAt = Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();

  return {
    app: 'cinnamon',
    type: 'process-report',
    version: 1,
    generatedAt,
    sampledAt: text(snapshot.timestamp) || null,
    host: text(snapshot.hostname) || null,
    platform: text(snapshot.platform) || null,
    limits,
    totals: {
      processes: processes.length,
      users: new Set(processes.map((proc) => proc.user)).size,
      states: new Set(processes.map((proc) => proc.state)).size,
      cpu: round(processes.reduce((sum, proc) => sum + proc.cpu, 0)),
      memoryBytes: processes.reduce((sum, proc) => sum + proc.memoryBytes, 0),
      zombies: processes.filter((proc) => proc.state.toUpperCase().startsWith('Z')).length,
      running: processes.filter((proc) => proc.state.toUpperCase().startsWith('R')).length,
      pinned: Array.isArray(source.pinned) ? source.pinned.length : 0
    },
    topCpu: byCpu.slice(0, limits.top),
    topMemory: byMemory.slice(0, limits.top),
    byUser: groupProcesses(processes, 'user', limits.groups),
    byState: groupProcesses(processes, 'state', limits.groups),
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

function toCSV(report) {
  const rows = report && Array.isArray(report.rows) ? report.rows : [];
  const columns = [
    ['pid', 'pid'], ['ppid', 'ppid'], ['name', 'name'], ['user', 'user'], ['state', 'state'],
    ['cpu_percent', 'cpu'], ['memory_percent', 'memory'], ['memory_bytes', 'memoryBytes'],
    ['uptime_seconds', 'uptime'], ['command', 'command']
  ];
  return [columns.map(([header]) => csvCell(header)).join(',')]
    .concat(rows.map((row) => columns.map(([, key]) => csvCell(row[key])).join(',')))
    .join('\n');
}

function mdCell(value) {
  return text(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function markdownTable(headers, rows) {
  return [
    `| ${headers.map(mdCell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`
  ].concat(rows.map((row) => `| ${row.map(mdCell).join(' | ')} |`));
}

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
      ['Processes', totals.processes || 0], ['Users', totals.users || 0],
      ['States', totals.states || 0], ['CPU %', totals.cpu || 0],
      ['Memory bytes', totals.memoryBytes || 0], ['Zombies', totals.zombies || 0],
      ['Running', totals.running || 0], ['Pinned', totals.pinned || 0]
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
    '## Findings',
    ''
  ];
  const findings = Array.isArray(data.findings) ? data.findings : [];
  if (findings.length) {
    for (const finding of findings) {
      lines.push(`- **${mdCell(finding.severity)}** ${mdCell(finding.title)}`);
      if (finding.evidence) lines.push(`  - Evidence: ${mdCell(finding.evidence)}`);
    }
  } else {
    lines.push('- No significant issues detected.');
  }
  return lines.join('\n');
}

function toFormat(report, format = 'json') {
  const name = text(format, 'json').toLowerCase();
  if (!FORMATS.includes(name)) throw new TypeError(`format must be one of ${FORMATS.join(', ')}`);
  if (name === 'csv') return toCSV(report);
  if (name === 'markdown') return toMarkdown(report);
  return toJSON(report);
}

module.exports = {
  FORMATS,
  buildProcessReport,
  toJSON,
  toCSV,
  toMarkdown,
  toFormat
};
