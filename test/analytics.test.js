'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const analytics = require('../lib/analytics.js');

function history() {
  return {
    limit: 600,
    samples: [
      { timestamp: '2026-11-25T10:00:00.000Z', cpu: 10, memory: 40, memoryBytes: 1000, disk: 20, networkRx: 100, networkTx: 20 },
      { timestamp: '2026-11-25T10:00:02.000Z', cpu: 50, memory: 60, memoryBytes: 2000, disk: 40, networkRx: 300, networkTx: 40 },
      { timestamp: '2026-11-25T10:00:04.000Z', cpu: 30, memory: 50, memoryBytes: 1500, disk: 45, networkRx: 200, networkTx: 30 }
    ]
  };
}

const processes = [
  { pid: 1, name: 'alpha', cpu: 70, memory: 40, memoryBytes: 5000 },
  { pid: 2, name: 'beta', cpu: 20, memory: 20, memoryBytes: 2000 },
  { pid: 3, name: 'gamma', cpu: 5, memory: 5, memoryBytes: 500 }
];

test('series helpers map history values with labels', () => {
  const h = history();
  assert.deepEqual(analytics.cpuSeries(h).map((point) => point.value), [10, 50, 30]);
  assert.equal(analytics.cpuSeries(h)[0].label, '10:00');
  assert.deepEqual(analytics.memorySeries(h).map((point) => point.bytes), [1000, 2000, 1500]);
  assert.deepEqual(analytics.diskSeries(h).map((point) => point.value), [20, 40, 45]);
  assert.ok(analytics.diskSeries(h)[1].ratePerHour > 0);
  const network = analytics.networkSeries(h);
  assert.deepEqual(network.rx.map((point) => point.value), [100, 300, 200]);
  assert.deepEqual(network.total.map((point) => point.value), [120, 340, 230]);
});

test('processBars and memoryDonut rank and group processes', () => {
  const cpuBars = analytics.processBars(processes, 'cpu', 2);
  assert.deepEqual(cpuBars.map((bar) => bar.name), ['alpha', 'beta']);
  assert.equal(cpuBars[0].value, 70);
  assert.deepEqual(analytics.processBars(processes, 'memory').map((bar) => bar.value), [5000, 2000, 500]);
  const donut = analytics.memoryDonut(processes, 2);
  assert.deepEqual(donut.map((entry) => entry.name), ['alpha (1)', 'beta (2)', 'Other processes']);
  assert.equal(Math.round(donut.reduce((sum, entry) => sum + entry.percent, 0)), 100);
  assert.deepEqual(analytics.memoryDonut([], 3), []);
});

test('activityHeatmap produces a full week by hour grid', () => {
  const heat = analytics.activityHeatmap(history());
  assert.deepEqual(heat.days, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.equal(heat.cells.length, 168);
  assert.equal(heat.samples, 3);
  assert.ok(heat.max > 0);
  assert.equal(analytics.activityHeatmap({ samples: [] }).cells.length, 168);
});

test('derivedStats reports peak, average, latest and trend', () => {
  const stats = analytics.derivedStats(history(), 'cpu');
  assert.equal(stats.peak, 50);
  assert.equal(stats.min, 10);
  assert.equal(stats.average, 30);
  assert.equal(stats.latest, 30);
  assert.ok(stats.trend > 0);
  assert.equal(stats.samples, 3);
  assert.equal(analytics.derivedStats({ samples: [] }, 'cpu').samples, 0);
});

test('all combines every chart dataset in one call', () => {
  const data = analytics.all(history(), processes);
  assert.equal(data.cpu.length, 3);
  assert.equal(data.network.tx.length, 3);
  assert.equal(data.processBars.cpu[0].name, 'alpha');
  assert.equal(data.memoryDonut.length, 3);
  assert.equal(data.heatmap.cells.length, 168);
  assert.equal(data.stats.memory.peak, 60);
  assert.equal(data.stats.networkRx.latest, 200);
  assert.ok(data.generatedAt);
});
