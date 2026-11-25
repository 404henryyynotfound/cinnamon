'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const reports = require('../lib/report.js');

const PROCESSES = [
  { pid: 10, ppid: 1, name: 'browser', user: 'henry', state: 'S', cpu: 12.5, memory: 8, memoryBytes: 2048, uptime: 90, command: 'browser --tab' },
  { pid: 20, ppid: 1, name: 'worker', user: 'root', state: 'Z', cpu: 3, memory: 1, memoryBytes: 1024, uptime: 10, command: 'worker' }
];

const SNAPSHOT = { timestamp: '2026-11-25T10:00:00.000Z', hostname: 'pi', platform: 'linux' };

test('buildProcessReport is deterministic and sorted', () => {
  const report = reports.buildProcessReport({ snapshot: SNAPSHOT, processes: PROCESSES, now: '2026-11-25T10:00:01.000Z' });
  assert.equal(report.app, 'cinnamon');
  assert.equal(report.generatedAt, '2026-11-25T10:00:01.000Z');
  assert.equal(report.sampledAt, SNAPSHOT.timestamp);
  assert.deepEqual(report.topCpu.map((proc) => proc.pid), [10, 20]);
  assert.equal(report.totals.processes, 2);
  assert.equal(report.totals.users, 2);
  assert.equal(report.totals.zombies, 1);
  assert.equal(report.totals.cpu, 15.5);
  assert.equal(report.totals.memoryBytes, 3072);
});

test('CSV output quotes values and keeps machine-readable headers', () => {
  const report = reports.buildProcessReport({ processes: PROCESSES });
  const csv = reports.toCSV(report);
  assert.match(csv, /^"pid","ppid","name","user","state"/);
  assert.match(csv, /"10","1","browser","henry","S"/);
  assert.equal(csv.split('\n').length, 3);
});

test('Markdown output includes totals, top CPU and findings', () => {
  const report = reports.buildProcessReport({
    snapshot: SNAPSHOT,
    processes: PROCESSES,
    findings: [{ severity: 'low', title: 'A finding', evidence: 'some evidence' }]
  });
  const markdown = reports.toMarkdown(report);
  assert.match(markdown, /# cinnamon process report/);
  assert.match(markdown, /## Totals/);
  assert.match(markdown, /## Top CPU/);
  assert.match(markdown, /\*\*low\*\* A finding/);
});

test('toFormat validates formats and emits JSON by default', () => {
  const report = reports.buildProcessReport({ processes: PROCESSES });
  assert.deepEqual(JSON.parse(reports.toFormat(report)).topCpu[0], report.topCpu[0]);
  assert.equal(reports.toFormat(report, 'csv'), reports.toCSV(report));
  assert.equal(reports.toFormat(report, 'markdown'), reports.toMarkdown(report));
  assert.throws(() => reports.toFormat(report, 'xml'), /format must be/);
});
