'use strict';

/** Terminal-friendly formatting for process tables and findings. */

const { bytes, uptimeText, number } = require('./diagnose.js');

const SORTS = Object.freeze(['cpu', 'memory', 'pid', 'name']);

function cell(value, width) {
  const text = String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ');
  return text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text.padEnd(width);
}

function table(headers, rows, limits = {}) {
  const widths = headers.map((header, index) => Math.min(
    number(limits[index], 80),
    Math.max(String(header).length, ...rows.map((row) => String(row[index] === null || row[index] === undefined ? '' : row[index]).length))
  ));
  const line = (values) => values.map((value, index) => cell(value, widths[index])).join('  ').trimEnd();
  const separator = widths.map((width) => '─'.repeat(width)).join('  ');
  return [line(headers), separator].concat(rows.map(line)).join('\n');
}

function sortProcesses(processes, sort = 'cpu') {
  const items = Array.isArray(processes) ? processes.slice() : [];
  switch (sort) {
    case 'memory': return items.sort((a, b) => number(b.memoryBytes) - number(a.memoryBytes) || number(a.pid) - number(b.pid));
    case 'pid': return items.sort((a, b) => number(a.pid) - number(b.pid));
    case 'name': return items.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')) || number(a.pid) - number(b.pid));
    default: return items.sort((a, b) => number(b.cpu) - number(a.cpu) || number(a.pid) - number(b.pid));
  }
}

function processTable(processes, options = {}) {
  const headers = ['PID', 'PPID', 'USER', 'STATE', 'CPU%', 'MEM%', 'RSS', 'UPTIME', 'COMMAND'];
  const rows = sortProcesses(processes, options.sort).slice(0, options.limit || 20).map((proc) => [
    proc.pid,
    proc.ppid,
    proc.user || '—',
    proc.state || '?',
    number(proc.cpu).toFixed(1),
    number(proc.memory).toFixed(1),
    bytes(proc.memoryBytes),
    uptimeText(proc.uptime),
    proc.command || proc.name || ''
  ]);
  return table(headers, rows, [8, 8, 14, 7, 7, 7, 11, 10, 48]);
}

function findingLines(analysis) {
  const data = analysis || {};
  const lines = [data.summary || `cinnamon rates this machine ${data.status || 'unknown'} (${data.healthScore ?? '?'} / 100).`];
  const findings = Array.isArray(data.findings) ? data.findings : [];
  if (!findings.length) return lines.concat(['No significant issues detected.']);
  for (const finding of findings) {
    lines.push(`- [${finding.severity}] ${finding.title}`);
    if (finding.evidence) lines.push(`    ${finding.evidence}`);
    if (finding.explanation) lines.push(`    ${finding.explanation}`);
  }
  return lines;
}

module.exports = { SORTS, cell, table, sortProcesses, processTable, findingLines };
