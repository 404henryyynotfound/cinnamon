'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const actions = require('../lib/actions.js');

test('validatePid rejects anything but positive integers', () => {
  assert.equal(actions.validatePid('4242'), 4242);
  assert.throws(() => actions.validatePid(0), /positive integer/);
  assert.throws(() => actions.validatePid(-1), /positive integer/);
  assert.throws(() => actions.validatePid(1.5), /positive integer/);
  assert.throws(() => actions.validatePid('abc'), /positive integer/);
});

test('signal only sends allow-listed POSIX signals', () => {
  const sent = [];
  const result = actions.signal('123', 'sigterm', { killImpl: (pid, sig) => sent.push([pid, sig]) });
  assert.deepEqual(sent, [[123, 'SIGTERM']]);
  assert.equal(result.ok, true);
  assert.equal(result.action, 'signal');

  const rejected = actions.signal(123, 'rm -rf /', { killImpl: () => { throw new Error('should not run'); } });
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /Signal must be one of/);
  assert.deepEqual(actions.ALLOWED_SIGNALS, ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGSTOP', 'SIGCONT']);
});

test('signal reports kill implementation failures without throwing', () => {
  const result = actions.signal(123, 'SIGKILL', { killImpl: () => { throw new Error('operation not permitted'); } });
  assert.equal(result.ok, false);
  assert.match(result.message, /operation not permitted/);
});

test('setPriority passes numeric arguments to renice only', async () => {
  const calls = [];
  const result = await actions.setPriority('77', '999', {
    platform: 'linux',
    runCommand: async (command, args) => { calls.push([command, args]); return ''; }
  });
  assert.deepEqual(calls, [['renice', ['-n', '19', '-p', '77']]]);
  assert.equal(result.ok, true);
  assert.equal(result.niceness, 19);

  const failed = await actions.setPriority(77, 5, { platform: 'linux', runCommand: async () => 'renice: operation not permitted' });
  assert.equal(failed.ok, false);
  const windows = await actions.setPriority(77, 5, { platform: 'win32', runCommand: async () => { throw new Error('should not run'); } });
  assert.equal(windows.ok, false);
  assert.match(windows.message, /not supported on Windows/);
});

test('details parses one process from ps output', async () => {
  const ps = '  PID PPID USER     COMM     PCPU PMEM  RSS ELAPSED STAT COMMAND\n 321 1 root node 1.5 2.5 40960 00:10:00 S node server.js';
  const found = await actions.details('321', { runCommand: async () => ps });
  assert.equal(found.ok, true);
  assert.equal(found.process.pid, 321);
  assert.equal(found.process.name, 'node');
  const missing = await actions.details(999, { runCommand: async () => ps });
  assert.equal(missing.ok, false);
});

test('confirmationFor describes destructive actions and requires confirmation', () => {
  const kill = actions.confirmationFor('SIGKILL', { name: 'worker' });
  assert.equal(kill.requireConfirmation, true);
  assert.equal(kill.severity, 'danger');
  assert.match(kill.message, /worker/);
  assert.equal(actions.confirmationFor('SIGCONT', { pid: 4 }).requireConfirmation, false);
  assert.equal(actions.confirmationFor('unknown', {}).requireConfirmation, true);
});

test('named operations map only to allow-listed signals and carry confirmation metadata', async () => {
  const sent = [];
  const options = { killImpl: (pid, sig) => sent.push([pid, sig]) };
  const expected = [
    ['pause', 'SIGSTOP'],
    ['resume', 'SIGCONT'],
    ['interrupt', 'SIGINT'],
    ['terminate', 'SIGTERM'],
    ['kill', 'SIGKILL']
  ];

  for (const [operation, signalName] of expected) {
    const result = await actions[operation]('55', options);
    assert.equal(result.ok, true);
    assert.equal(result.operation, operation);
    assert.equal(result.signal, signalName);
    assert.equal(result.confirmation.requireConfirmation, signalName !== 'SIGCONT');
  }
  assert.deepEqual(sent, expected.map(([, signalName]) => [55, signalName]));
  assert.deepEqual(actions.ALLOWED_OPERATIONS, ['pause', 'resume', 'interrupt', 'terminate', 'kill', 'setPriority']);

  const rejected = await actions.operate('rm -rf /', 55, options);
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /Operation must be one of/);
});

test('setPriority operation clamps niceness and uses the named confirmation copy', async () => {
  const calls = [];
  const result = await actions.operate('setPriority', '77', {
    niceness: 999,
    platform: 'linux',
    runCommand: async (command, args) => { calls.push([command, args]); return ''; }
  });
  assert.deepEqual(calls, [['renice', ['-n', '19', '-p', '77']]]);
  assert.equal(result.ok, true);
  assert.equal(result.operation, 'setPriority');
  assert.equal(result.confirmation.title, 'Change priority?');
});

test('openFiles reads /proc descriptors and degrades gracefully', async () => {
  const ok = await actions.openFiles('321', {
    platform: 'linux',
    directory: '/proc/321/fd',
    readDir: async () => ['0', '1', '2'],
    readLink: async (file) => {
      if (file.endsWith('2')) throw new Error('gone');
      return `/tmp/${file.split('/').pop()}`;
    }
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.supported, true);
  assert.deepEqual(ok.files, [
    { fd: '0', target: '/tmp/0' },
    { fd: '1', target: '/tmp/1' },
    { fd: '2', target: null }
  ]);

  const missing = await actions.openFiles(321, {
    platform: 'linux',
    readDir: async () => { throw new Error('process exited'); }
  });
  assert.equal(missing.ok, true);
  assert.equal(missing.supported, false);
  assert.deepEqual(missing.files, []);

  const unsupported = await actions.openFiles(321, { platform: 'darwin' });
  assert.equal(unsupported.ok, true);
  assert.equal(unsupported.supported, false);

  const invalid = await actions.openFiles('not-a-pid');
  assert.equal(invalid.ok, false);
});

test('processTree nests children by ppid without mutating the input', () => {
  const processes = [
    { pid: 1, ppid: 0, name: 'init', cpu: 0 },
    { pid: 10, ppid: 1, name: 'alpha', cpu: 5 },
    { pid: 11, ppid: 1, name: 'beta', cpu: 9 },
    { pid: 12, ppid: 11, name: 'child', cpu: 1 },
    { pid: 99, ppid: 999, name: 'orphan', cpu: 0 }
  ];
  const tree = actions.processTree(processes);
  assert.deepEqual(tree.map((node) => node.pid), [1, 99]);
  const init = tree[0];
  assert.deepEqual(init.children.map((node) => node.pid), [11, 10]);
  assert.equal(init.children[0].children[0].pid, 12);
  assert.equal(processes[0].children, undefined);

  const flat = actions.processTree(processes, { flat: true });
  assert.equal(flat.length, 5);

  const cyclic = actions.processTree([{ pid: 1, ppid: 2 }, { pid: 2, ppid: 1 }]);
  assert.deepEqual(cyclic.map((node) => node.pid), [1, 2]);
});
