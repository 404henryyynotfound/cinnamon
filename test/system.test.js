'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const system = require('../lib/system.js');

const PS = [
  '  PID PPID USER     COMM     PCCPU PMEM   RSS ELAPSED STAT COMMAND',
  ' 4242    1 root     node       78.5  12.4 512000 02:15:30 S    node /srv/worker.js',
  ' 4243 4242 henry    chrome      3.2   4.1 132000 1-01:20:10 Sl   /usr/bin/chrome --type=renderer',
  ' bad line that should be skipped',
  ' 99     0 root     zombie     0.0   0.0     0 00:00:05 Z    [defunct]'
];

test('parseEtime understands mm:ss, hh:mm:ss and d-hh:mm:ss', () => {
  assert.equal(system.parseEtime('01:30'), 90);
  assert.equal(system.parseEtime('02:15:30'), 8130);
  assert.equal(system.parseEtime('1-01:20:10'), 91210);
  assert.equal(system.parseEtime('nonsense'), 0);
  assert.equal(system.parseEtime(''), 0);
});

test('parsePsOutput normalizes processes and skips headers and junk', () => {
  const processes = system.parsePsOutput(PS.join('\n'));
  assert.equal(processes.length, 3);
  assert.equal(processes[0].pid, 4242);
  assert.equal(processes[0].name, 'node');
  assert.equal(processes[0].cpu, 78.5);
  assert.equal(processes[0].memoryBytes, 512000 * 1024);
  assert.equal(processes[0].uptime, 8130);
  assert.equal(processes[0].state, 'S');
  assert.ok(processes[0].command.includes('/srv/worker.js'));
  assert.equal(processes[1].uptime, 91210);
  assert.equal(processes[2].state, 'Z');
  assert.deepEqual(system.parsePsOutput(''), []);
});

test('listProcesses uses an injected command and degrades gracefully', async () => {
  const calls = [];
  const processes = await system.listProcesses({ runCommand: async (command, args) => { calls.push([command, args]); return PS.join('\n'); } });
  assert.equal(processes.length, 3);
  assert.equal(calls[0][0], 'ps');
  assert.ok(calls[0][1].includes('--sort=-pcpu'));
  assert.deepEqual(await system.listProcesses({ runCommand: async () => { throw new Error('no ps'); } }), []);
});

test('parseDfOutput ignores headers and returns mounts', () => {
  const text = [
    'Filesystem     1024-blocks    Used Available Capacity Mounted on',
    '/dev/sda1         10000000 7500000   2500000      75% /',
    'tmpfs              1000000  100000    900000      10% /run'
  ].join('\n');
  const disks = system.parseDfOutput(text);
  assert.equal(disks.length, 2);
  assert.equal(disks[0].mount, '/');
  assert.equal(disks[0].usePercent, 75);
  assert.equal(disks[1].filesystem, 'tmpfs');
  assert.deepEqual(system.parseDfOutput('garbage'), []);
});

test('parseProcNetDev and computeNetworkRates use counter deltas', () => {
  const text = [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '  eth0: 1000000 1000 0 0 0 0 0 0 2000000 2000 0 0 0 0 0 0',
    '    lo: 500 5 0 0 0 0 0 0 500 5 0 0 0 0 0 0'
  ].join('\n');
  const current = system.parseProcNetDev(text);
  assert.equal(current.eth0.rxBytes, 1000000);
  assert.equal(current.eth0.txBytes, 2000000);
  assert.deepEqual(system.parseProcNetDev(''), {});
  const previous = { eth0: { rxBytes: 900000, txBytes: 1900000 } };
  const rates = system.computeNetworkRates(current, previous, 2);
  assert.equal(rates.eth0.rxBytesPerSec, 50000);
  assert.equal(rates.eth0.txBytesPerSec, 50000);
  assert.equal(rates.lo.available, false);
});

test('cpuTimes and computeCpuUsage calculate deltas safely', () => {
  const current = system.cpuTimes([{ times: { user: 70, nice: 0, sys: 30, idle: 100, irq: 0 } }]);
  const previous = { total: 100, idle: 50 };
  assert.equal(current.total, 200);
  assert.equal(current.idle, 100);
  assert.equal(system.computeCpuUsage(current, previous), 50);
  assert.equal(system.computeCpuUsage(previous, current), 0);
  assert.equal(system.computeCpuUsage(current, null), 0);
});

test('systemSnapshot accepts injected commands, files and clock', async () => {
  const previous = { timestamp: '2026-11-25T10:00:00.000Z', cpu: { cpuTimes: { total: 100, idle: 50 } }, network: { interfaces: { eth0: { rxBytes: 100, txBytes: 100 } } } };
  const snapshot = await system.systemSnapshot({
    now: new Date('2026-11-25T10:00:02.000Z'),
    previous,
    platform: 'linux',
    runCommand: async (command) => command === 'df' ? 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 60 40 60% /' : '',
    readFile: async () => 'Inter-| Receive | Transmit\n face |bytes|bytes\n eth0: 1100 0 0 0 0 0 0 0 1200 0 0 0 0 0 0 0'
  });
  assert.equal(snapshot.timestamp, '2026-11-25T10:00:02.000Z');
  assert.equal(snapshot.platform, 'linux');
  assert.ok(snapshot.cpu.cores >= 1);
  assert.equal(snapshot.disks.length, 1);
  assert.equal(snapshot.network.rates.eth0.rxBytesPerSec, 500);
  assert.equal(snapshot.network.rates.eth0.txBytesPerSec, 550);
  assert.equal(snapshot.network.supported, true);
});

test('history ring and sampleFrom derive chart-friendly points', () => {
  const history = system.createHistory(2);
  const point = (timestamp, cpu) => ({ timestamp, cpu, memory: 50, memoryBytes: 1000, disk: 20, networkRx: 5, networkTx: 7 });
  let next = system.pushHistory(history, point('2026-11-25T10:00:00.000Z', 10));
  next = system.pushHistory(next, point('2026-11-25T10:00:02.000Z', 30));
  next = system.pushHistory(next, point('2026-11-25T10:00:04.000Z', 50));
  assert.equal(next.samples.length, 2);
  assert.deepEqual(system.historySeries(next, 'cpu').map((item) => item.value), [30, 50]);
  const sample = system.sampleFrom({
    timestamp: '2026-11-25T10:00:06.000Z',
    cpu: { percent: 42, load: [1, 2, 3] },
    memory: { percent: 60, usedBytes: 2048 },
    disks: [{ usePercent: 70 }],
    network: { rxBytesPerSec: 10, txBytesPerSec: 20 }
  }, [{ pid: 1, name: 'init', cpu: 5, memory: 1, memoryBytes: 128 }]);
  assert.equal(sample.cpu, 42);
  assert.equal(sample.memoryBytes, 2048);
  assert.equal(sample.disk, 70);
  assert.equal(sample.processCount, 1);
  assert.equal(sample.topProcesses[0].name, 'init');
  assert.equal(system.sampleFrom(null), null);
});
