'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const diagnose = require('../lib/diagnose.js');

test('analyze ranks a CPU hog and a zombie with evidence', () => {
  const snapshot = {
    timestamp: '2026-11-25T10:00:00.000Z',
    cpu: { percent: 60, cores: 4, load: [5, 2, 1] },
    memory: { percent: 40, totalBytes: 1000, usedBytes: 400, freeBytes: 600 }
  };
  const processes = [
    { pid: 10, name: 'runaway', user: 'henry', state: 'R', cpu: 95, memory: 5, memoryBytes: 1024, uptime: 7200, command: 'runaway' },
    { pid: 20, name: 'gone', user: 'root', state: 'Z', cpu: 0, memory: 0, memoryBytes: 0, uptime: 1, command: '' }
  ];
  const result = diagnose.analyze(snapshot, processes, { now: '2026-11-25T10:00:01.000Z' });
  assert.equal(result.timestamp, '2026-11-25T10:00:01.000Z');
  assert.equal(result.counts.critical, 1);
  assert.equal(result.findings[0].id, 'cpu:10');
  assert.match(result.findings[0].evidence, /PID 10/);
  assert.ok(result.findings.some((finding) => finding.id === 'zombies'));
  assert.ok(result.findings.some((finding) => finding.id === 'load'));
  assert.equal(result.status, 'critical');
  assert.equal(result.metrics.processCount, 2);
});

test('memory pressure is reported with byte formatting', () => {
  const snapshot = {
    cpu: { percent: 10, cores: 8, load: [1, 1, 1] },
    memory: { percent: 90, totalBytes: 1024 ** 3, usedBytes: 900 * 1024 ** 2, freeBytes: 124 * 1024 ** 2 }
  };
  const result = diagnose.analyze(snapshot, []);
  const pressure = result.findings.find((finding) => finding.id === 'memory-pressure');
  assert.ok(pressure);
  assert.equal(pressure.severity, 'critical');
  assert.match(pressure.evidence, /MB/);
});

test('a quiet machine has no findings and a healthy summary', () => {
  const snapshot = {
    cpu: { percent: 5, cores: 4, load: [0.5, 0.4, 0.3] },
    memory: { percent: 20, totalBytes: 1000, usedBytes: 200, freeBytes: 800 }
  };
  const result = diagnose.enrich(diagnose.analyze(snapshot, []), snapshot);
  assert.equal(result.findings.length, 0);
  assert.equal(result.healthScore, 100);
  assert.equal(result.status, 'healthy');
  assert.match(result.summary, /No significant issues detected/);
  assert.equal(diagnose.bytes(2 * 1024 ** 3), '2 GB');
  assert.equal(diagnose.uptimeText(90061), '1d 1h');
});
