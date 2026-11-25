'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cli = require('../lib/cli.js');

const NOW = '2026-11-25T10:00:00.000Z';
const PROCESSES = [
  { pid: 10, ppid: 1, name: 'browser', user: 'henry', state: 'S', cpu: 12.5, memory: 8, memoryBytes: 2048, uptime: 90, command: 'browser --tab' },
  { pid: 20, ppid: 1, name: 'worker', user: 'root', state: 'Z', cpu: 3, memory: 1, memoryBytes: 4096, uptime: 10, command: 'worker' }
];
const SNAPSHOT = {
  timestamp: NOW,
  hostname: 'testbox',
  platform: 'linux',
  cpu: { percent: 30, cores: 2, load: [1, 1, 1] },
  memory: { percent: 65, totalBytes: 10000, usedBytes: 6500, freeBytes: 3500 },
  disks: [],
  network: { rxBytesPerSec: 0, txBytesPerSec: 0 }
};

function harness() {
  const lines = { out: [], err: [] };
  const state = { kills: [], commands: [], sleeps: [] };
  const deps = {
    out: (line) => { lines.out.push(line); },
    err: (line) => { lines.err.push(line); },
    now: NOW,
    sample: async () => PROCESSES.map((proc) => ({ ...proc })),
    snapshot: async () => ({ ...SNAPSHOT }),
    killImpl: (pid, signal) => { state.kills.push([pid, signal]); },
    runCommand: async (command, args) => { state.commands.push([command, args]); return ''; },
    sleep: async (ms) => { state.sleeps.push(ms); }
  };
  return { deps, lines, state };
}

test('--version and --help work without sampling', async () => {
  const first = harness();
  assert.equal(await cli.run(['--version'], first.deps), 0);
  assert.equal(first.lines.out[0], cli.version);
  const second = harness();
  assert.equal(await cli.run(['--help'], second.deps), 0);
  assert.match(second.lines.out[0], /Usage:/);
});

test('ps sorts, limits and emits JSON with injected sampling', async () => {
  const { deps, lines } = harness();
  assert.equal(await cli.run(['ps', '--sort', 'memory', '--limit', '1', '--format', 'json'], deps), 0);
  const parsed = JSON.parse(lines.out[0]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].pid, 20);
  assert.equal(parsed[0].name, 'worker');
});

test('ps emits CSV with process columns', async () => {
  const { deps, lines } = harness();
  assert.equal(await cli.run(['ps', '--format', 'csv'], deps), 0);
  assert.match(lines.out[0], /^"pid","ppid","name"/);
  assert.match(lines.out[0], /"browser"/);
});

test('top repeats injected samples and sleeps between them', async () => {
  const { deps, lines, state } = harness();
  let calls = 0;
  deps.sample = async () => {
    calls += 1;
    return PROCESSES.map((proc) => ({ ...proc, cpu: proc.cpu + calls }));
  };
  assert.equal(await cli.run(['top', '--count', '2', '--interval', '0.25', '--limit', '1'], deps), 0);
  assert.equal(calls, 2);
  assert.deepEqual(state.sleeps, [250]);
  assert.equal(lines.out.length, 4);
  assert.match(lines.out[0], /cinnamon top/);
  assert.match(lines.out[1], /13\.5/);
});

test('report builds JSON from injected snapshot and processes', async () => {
  const { deps, lines } = harness();
  assert.equal(await cli.run(['report', '--format', 'json'], deps), 0);
  const report = JSON.parse(lines.out[0]);
  assert.equal(report.app, 'cinnamon');
  assert.equal(report.generatedAt, NOW);
  assert.equal(report.totals.processes, 2);
  assert.ok(report.findings.some((finding) => /Memory pressure is 65%/.test(finding.title)));
});

test('diagnose prints explainable text findings', async () => {
  const { deps, lines } = harness();
  assert.equal(await cli.run(['diagnose'], deps), 0);
  assert.match(lines.out[0], /cinnamon rates this machine/);
  assert.match(lines.out.join('\n'), /Memory pressure is 65%/);
  assert.match(lines.out.join('\n'), /zombie process/);
});

test('kill refuses to run without --yes', async () => {
  const { deps, lines, state } = harness();
  assert.equal(await cli.run(['kill', '7'], deps), 2);
  assert.match(lines.err[0], /--yes/);
  assert.deepEqual(state.kills, []);
});

test('kill dispatches a validated signal through the injected killer', async () => {
  const { deps, lines, state } = harness();
  assert.equal(await cli.run(['kill', '7', 'SIGKILL', '--yes'], deps), 0);
  assert.deepEqual(state.kills, [[7, 'SIGKILL']]);
  assert.match(lines.out[0], /Sent SIGKILL to process 7/);
});

test('renice dispatches numeric execFile arguments through the injected runner', async () => {
  const { deps, state } = harness();
  assert.equal(await cli.run(['renice', '7', '3', '--yes'], deps), 0);
  assert.deepEqual(state.commands, [['renice', ['-n', '3', '-p', '7']]]);
  assert.deepEqual(state.kills, []);
});

test('unknown commands and options fail cleanly', async () => {
  const first = harness();
  assert.equal(await cli.run(['frobnicate'], first.deps), 1);
  assert.match(first.lines.err[0], /Unknown command/);
  const second = harness();
  assert.equal(await cli.run(['ps', '--execute', 'rm -rf /'], second.deps), 1);
  assert.match(second.lines.err[0], /Unknown option/);
});
