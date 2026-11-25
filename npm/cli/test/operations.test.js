'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const operations = require('../lib/operations.js');

function recorder() {
  const state = { kills: [], commands: [] };
  return {
    state,
    killImpl: (pid, signal) => { state.kills.push([pid, signal]); },
    runCommand: async (command, args) => { state.commands.push([command, args]); return ''; }
  };
}

test('destructive plans require --yes before touching any process', async () => {
  const deps = recorder();
  const plan = operations.buildPlan('kill', ['123'], {});
  const result = await operations.execute(plan, deps);
  assert.equal(result.ok, false);
  assert.equal(result.code, 2);
  assert.match(result.message, /--yes/);
  assert.deepEqual(deps.state.kills, []);
  assert.deepEqual(deps.state.commands, []);
});

test('kill sends only validated signals through the injected killer', async () => {
  const deps = recorder();
  const plan = operations.buildPlan('kill', ['123', '456', 'SIGKILL'], { yes: true });
  assert.deepEqual(plan.actions, [
    { pid: 123, signal: 'SIGKILL' },
    { pid: 456, signal: 'SIGKILL' }
  ]);
  const result = await operations.execute(plan, deps);
  assert.equal(result.ok, true);
  assert.deepEqual(deps.state.kills, [[123, 'SIGKILL'], [456, 'SIGKILL']]);
});

test('pause and resume map to the allow-listed signals', async () => {
  const deps = recorder();
  await operations.execute(operations.buildPlan('pause', ['7'], { yes: true }), deps);
  await operations.execute(operations.buildPlan('resume', ['7'], { yes: true }), deps);
  assert.deepEqual(deps.state.kills, [[7, 'SIGSTOP'], [7, 'SIGCONT']]);
});

test('renice uses numeric execFile arguments and rejects Windows', async () => {
  const deps = recorder();
  const plan = operations.buildPlan('renice', ['12', '5'], { yes: true });
  const result = await operations.execute(plan, deps);
  assert.equal(result.ok, true);
  assert.deepEqual(deps.state.commands, [['renice', ['-n', '5', '-p', '12']]]);
  assert.deepEqual(deps.state.kills, []);
  const windows = await operations.execute(plan, { ...deps, platform: 'win32' });
  assert.equal(windows.ok, false);
  assert.match(windows.message, /not supported on Windows/);
  assert.equal(deps.state.commands.length, 1);
});

test('invalid PIDs, signals and priorities are rejected before execution', () => {
  const deps = recorder();
  assert.throws(() => operations.buildPlan('kill', ['0'], { yes: true }), /positive integer/);
  assert.throws(() => operations.buildPlan('kill', ['12', 'SIGSHELL'], { yes: true }), /signal must be one of/);
  assert.throws(() => operations.buildPlan('renice', ['12', '99'], { yes: true }), /priority must be/);
  assert.throws(() => operations.buildPlan('renice', ['12'], { yes: true }), /usage: renice/);
  assert.deepEqual(deps.state.kills, []);
  assert.deepEqual(deps.state.commands, []);
});
