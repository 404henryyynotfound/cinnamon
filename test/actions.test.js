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
