'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const reports = require('../lib/reports.js');

const NOW = new Date('2026-11-25T12:00:00.000Z');
const PROCESSES = [
  { pid: 10, ppid: 1, name: 'alpha', user: 'alice', state: 'R', cpu: 12.345, memory: 3.456, memoryBytes: 1024, uptime: 90, command: 'alpha --serve' },
  { pid: 20, ppid: 1, name: 'beta', user: 'alice', state: 'S', cpu: 2.1, memory: 1.2, memoryBytes: 2048, uptime: 30, command: 'beta' },
  { pid: 30, ppid: 20, name: 'stuck', user: 'bob', state: 'Z', cpu: 0, memory: 0, memoryBytes: 0, uptime: 5, command: '' }
];
const FINDINGS = [{ severity: 'high', title: 'CPU hog', evidence: 'alpha uses 12%', explanation: 'Investigate the workload.' }];

function build() {
  return reports.buildProcessReport({
    now: NOW,
    snapshot: { timestamp: '2026-11-25T11:59:58.000Z', hostname: 'localhost', platform: 'linux' },
    processes: PROCESSES,
    findings: FINDINGS,
    pinned: [{ pid: 10 }]
  });
}

test('buildProcessReport creates a deterministic, JSON-serializable summary', () => {
  const report = build();
  assert.equal(report.app, 'cinnamon');
  assert.equal(report.type, 'process-report');
  assert.equal(report.version, 1);
  assert.equal(report.generatedAt, NOW.toISOString());
  assert.equal(report.sampledAt, '2026-11-25T11:59:58.000Z');
  assert.equal(report.host, 'localhost');
  assert.equal(report.platform, 'linux');

  assert.equal(report.totals.processes, 3);
  assert.equal(report.totals.users, 2);
  assert.equal(report.totals.states, 3);
  assert.equal(report.totals.memoryBytes, 3072);
  assert.equal(report.totals.zombies, 1);
  assert.equal(report.totals.running, 1);
  assert.equal(report.totals.pinned, 1);
  assert.ok(Math.abs(report.totals.cpu - 14.45) < 0.01);

  assert.deepEqual(report.topCpu.map((proc) => proc.pid), [10, 20, 30]);
  assert.deepEqual(report.topMemory.map((proc) => proc.pid), [20, 10, 30]);
  assert.equal(report.byUser[0].key, 'alice');
  assert.equal(report.byUser[0].count, 2);
  assert.equal(report.byState[0].key, 'R');
  assert.deepEqual(report.findings, FINDINGS);
  assert.equal(report.rows.length, 3);
  assert.deepEqual(JSON.parse(reports.toJSON(report)), report);
});

test('buildProcessReport validates limits and tolerates malformed input', () => {
  const report = reports.buildProcessReport({
    processes: [null, { pid: 0 }, { pid: '3', name: 'ok', cpu: '4.5' }],
    limits: { top: 999, groups: -4 }
  });
  assert.deepEqual(report.limits, { top: 100, groups: 1, rows: 250 });
  assert.equal(report.totals.processes, 1);
  assert.equal(report.rows[0].name, 'ok');
  assert.equal(report.rows[0].cpu, 4.5);
  assert.equal(reports.buildProcessReport(null).totals.processes, 0);
});

test('toCSV quotes commas and quotes and matches the report rows', () => {
  const report = reports.buildProcessReport({
    now: NOW,
    processes: [{ pid: 1, name: 'a,b', command: 'say "hi", now' }]
  });
  const csv = reports.toCSV(report);
  const lines = csv.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^"pid","ppid","name","user","state","cpu_percent"/);
  assert.match(lines[1], /"a,b"/);
  assert.match(lines[1], /"say ""hi"", now"/);
  assert.equal(reports.toCSV({}).split('\n').length, 1);
});

test('preserveOrder keeps exported rows in the caller-supplied table order', () => {
  const report = reports.buildProcessReport({
    processes: [
      { pid: 1, name: 'first', cpu: 1 },
      { pid: 2, name: 'second', cpu: 9 }
    ],
    preserveOrder: true
  });
  assert.deepEqual(report.topCpu.map((proc) => proc.pid), [2, 1]);
  assert.deepEqual(report.rows.map((proc) => proc.pid), [1, 2]);
  assert.match(reports.toCSV(report).split('\n')[1], /^"1","0","first"/);
});

test('toMarkdown and toFormat produce readable reports and reject unknown formats', () => {
  const markdown = reports.toMarkdown(build());
  assert.match(markdown, /^# cinnamon process report/);
  assert.match(markdown, /## Totals/);
  assert.match(markdown, /\| PID \| Process \| User \| CPU % \| Memory % \|/);
  assert.match(markdown, /## AI findings/);
  assert.match(markdown, /\*\*high\*\* CPU hog/);
  assert.match(reports.toMarkdown(reports.buildProcessReport({})), /No significant issues detected\./);

  assert.equal(reports.toFormat(build(), 'json'), reports.toJSON(build()));
  assert.equal(reports.toFormat(build(), 'CSV'), reports.toCSV(build()));
  assert.equal(reports.toFormat(build(), 'markdown'), markdown);
  assert.deepEqual(reports.FORMATS, ['json', 'csv', 'markdown']);
  assert.throws(() => reports.toFormat(build(), 'pdf'), /Report format must be one of/);
});

test('pin helpers delegate to the store and fail loudly on an invalid store', () => {
  const calls = [];
  const store = {
    pinProcess: (pid, meta) => { calls.push(['pin', pid, meta]); return { pid }; },
    unpinProcess: (pid) => { calls.push(['unpin', pid]); return true; },
    listPinned: () => [{ pid: 10 }]
  };
  assert.deepEqual(reports.pinProcess(store, '10', { name: 'alpha' }), { pid: '10' });
  assert.equal(reports.unpinProcess(store, 10), true);
  assert.deepEqual(reports.listPinned(store), [{ pid: 10 }]);
  assert.deepEqual(calls, [
    ['pin', '10', { name: 'alpha' }],
    ['unpin', 10]
  ]);
  assert.throws(() => reports.pinProcess({}, 1), /pinProcess/);
  assert.throws(() => reports.unpinProcess(null, 1), /unpinProcess/);
  assert.deepEqual(reports.listPinned(null), []);
});
