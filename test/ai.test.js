'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../lib/ai.js');

function proc(input) {
  return {
    pid: 1, ppid: 0, user: 'u', name: 'p', cpu: 0, memory: 0,
    memoryBytes: 0, uptime: 0, state: 'S', command: '', ...input
  };
}

function snapshot(overrides = {}) {
  return {
    timestamp: '2026-11-25T10:00:00.000Z',
    platform: 'linux', arch: 'x64',
    uptimeSeconds: 3600,
    cpu: { percent: 20, cores: 4, load: [1, 1, 1] },
    memory: { totalBytes: 8 * 1024 ** 3, usedBytes: 4 * 1024 ** 3, freeBytes: 4 * 1024 ** 3, percent: 50 },
    disks: [{ mount: '/', usePercent: 40 }],
    network: { rxBytesPerSec: 100, txBytesPerSec: 50 },
    ...overrides
  };
}

test('bytes and uptimeText format human-readable values', () => {
  assert.equal(ai.bytes(512), '512 B');
  assert.equal(ai.bytes(2048), '2 KB');
  assert.equal(ai.bytes(3 * 1024 ** 2), '3 MB');
  assert.equal(ai.bytes(2 * 1024 ** 3), '2 GB');
  assert.equal(ai.uptimeText(90), '1m');
  assert.equal(ai.uptimeText(7200), '2h 0m');
  assert.equal(ai.uptimeText(90000), '1d 1h');
});

test('analyze ranks CPU offenders with evidence and suggested actions', () => {
  const processes = [proc({ pid: 10, name: 'runaway', cpu: 95, memory: 30, memoryBytes: 3 * 1024 ** 3, uptime: 10000 })];
  const result = ai.analyze(snapshot(), processes);
  const cpuFinding = result.findings.find((finding) => finding.id === 'cpu:10');
  assert.ok(cpuFinding);
  assert.equal(cpuFinding.severity, 'critical');
  assert.match(cpuFinding.evidence, /PID 10/);
  assert.match(cpuFinding.evidence, /2h 46m/);
  assert.ok(cpuFinding.suggestedActions.some((action) => action.action === 'SIGTERM'));
  assert.ok(result.findings.some((finding) => finding.id === 'runaway:10'));
  assert.equal(result.status, 'critical');
  assert.ok(result.healthScore < 50);
});

test('analyze detects memory, disk, network, zombie and load pressure', () => {
  const snap = snapshot({
    cpu: { percent: 90, cores: 2, load: [5, 4, 3] },
    memory: { totalBytes: 1000, usedBytes: 900, freeBytes: 100, percent: 90 },
    disks: [{ mount: '/', usePercent: 97 }],
    network: { rxBytesPerSec: 60 * 1024 ** 2, txBytesPerSec: 5 * 1024 ** 2 }
  });
  const processes = [
    proc({ pid: 1, name: 'z1', state: 'Z' }),
    proc({ pid: 2, name: 'z2', state: 'Z' }),
    proc({ pid: 3, name: 'big', memory: 40, memoryBytes: 500 * 1024 ** 2 })
  ];
  const result = ai.analyze(snap, processes);
  const ids = result.findings.map((finding) => finding.id);
  for (const id of ['memory-pressure', 'disk:/', 'network-spike', 'zombies', 'load']) assert.ok(ids.includes(id), `missing ${id}`);
  assert.equal(result.counts.critical >= 3, true);
  assert.equal(result.status, 'critical');
});

test('analyze is deterministic and healthy on a quiet machine', () => {
  const snap = snapshot();
  const processes = [proc({ pid: 1, name: 'init', cpu: 1, memory: 1, memoryBytes: 1024 })];
  const first = ai.analyze(snap, processes);
  assert.deepEqual(first, ai.analyze(snap, processes));
  assert.equal(first.status, 'healthy');
  assert.equal(first.healthScore, 100);
  assert.deepEqual(first.findings, []);
});

test('summary and enrich include metrics and the top finding', () => {
  const snap = snapshot({ cpu: { percent: 72, cores: 4, load: [1, 1, 1] } });
  const result = ai.enrich(ai.analyze(snap, []), snap);
  assert.match(result.summary, /cinnamon rates this machine/);
  assert.match(result.summary, /72%/);
  assert.equal(ai.systemHealthSummary({ status: 'healthy', healthScore: 98, findings: [] }, snap).includes('No significant issues'), true);
});

test('compareSnapshots explains changes in plain language', () => {
  const before = snapshot();
  const after = snapshot({
    timestamp: '2026-11-25T10:05:00.000Z',
    cpu: { percent: 80, cores: 4, load: [3, 2, 1] },
    memory: { totalBytes: 8 * 1024 ** 3, usedBytes: 6 * 1024 ** 3, freeBytes: 2 * 1024 ** 3, percent: 75 },
    network: { rxBytesPerSec: 300, txBytesPerSec: 50 }
  });
  const result = ai.compareSnapshots(before, after, { now: '2026-11-25T10:05:01.000Z' });
  assert.equal(result.from, before.timestamp);
  assert.equal(result.to, after.timestamp);
  assert.equal(result.generatedAt, '2026-11-25T10:05:01.000Z');
  const cpu = result.changes.find((change) => change.metric === 'cpu');
  assert.equal(cpu.before, 20);
  assert.equal(cpu.after, 80);
  assert.equal(cpu.direction, 'up');
  assert.match(cpu.explanation, /increased/);
  assert.match(result.summary, /Biggest change/);
});
