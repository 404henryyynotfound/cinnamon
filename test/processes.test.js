'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const processesLib = require('../lib/processes.js');

function proc(input) {
  return {
    pid: 1, ppid: 0, name: 'p', user: 'u', cpu: 0, memory: 0,
    memoryBytes: 0, uptime: 0, state: 'S', command: '', ...input
  };
}

const NOW = new Date('2026-11-25T10:00:00.000Z');

test('groupProcesses aggregates by executable name and ranks by CPU', () => {
  const groups = processesLib.groupProcesses([
    proc({ pid: 1, name: 'Chrome', cpu: 30, memory: 10, memoryBytes: 1000, state: 'S' }),
    proc({ pid: 2, name: 'chrome', cpu: 20, memory: 5, memoryBytes: 500, state: 'R' }),
    proc({ pid: 3, name: 'node', cpu: 75, memory: 20, memoryBytes: 2000, state: 'S' })
  ]);
  assert.deepEqual(groups.map((group) => group.name), ['node', 'Chrome']);
  assert.equal(groups[1].count, 2);
  assert.equal(groups[1].cpu, 50);
  assert.equal(groups[1].maxCpu, 30);
  assert.deepEqual(groups[1].pids, [1, 2]);
  assert.deepEqual(groups[1].states, { S: 1, R: 1 });
  assert.deepEqual(processesLib.groupProcesses(null), []);
});

test('processTree nests children under their parent', () => {
  const tree = processesLib.processTree([
    proc({ pid: 1, ppid: 0, name: 'init' }),
    proc({ pid: 2, ppid: 1, name: 'shell' }),
    proc({ pid: 3, ppid: 2, name: 'worker' })
  ]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].name, 'init');
  assert.equal(tree[0].children[0].children[0].name, 'worker');
});

test('normalizeRule validates input and fills sensible defaults', () => {
  const rule = processesLib.normalizeRule({ name: 'Hot CPU', metric: 'cpu', threshold: 85 }, { now: NOW });
  assert.equal(rule.name, 'Hot CPU');
  assert.equal(rule.metric, 'cpu');
  assert.equal(rule.scope, 'process');
  assert.equal(rule.operator, '>');
  assert.equal(rule.enabled, true);
  assert.equal(rule.cooldownMinutes, 5);
  assert.equal(rule.createdAt, NOW.toISOString());
  assert.ok(rule.id.startsWith('rule_'));
  assert.equal(processesLib.normalizeRule({ name: 'Zombies', metric: 'zombies', threshold: 2 }, { now: NOW }).scope, 'system');
  assert.throws(() => processesLib.normalizeRule({}), /needs a name/);
  assert.throws(() => processesLib.normalizeRule('nope'), /must be an object/);
});

test('evaluateRules alerts on matching processes with cooldown and severity', () => {
  const rules = [processesLib.normalizeRule({
    id: 'hot', name: 'Hot process', metric: 'cpu', threshold: 80, scope: 'process', cooldownMinutes: 5
  }, { now: NOW })];
  const list = [proc({ pid: 7, name: 'burn', cpu: 95, state: 'R' }), proc({ pid: 8, name: 'calm', cpu: 10 })];
  const first = processesLib.evaluateRules(rules, snapshot(), list, { now: NOW });
  assert.equal(first.alerts.length, 1);
  assert.equal(first.alerts[0].pid, 7);
  assert.equal(first.alerts[0].value, 95);
  assert.equal(first.alerts[0].severity, 'medium');
  assert.match(first.alerts[0].message, /burn/);
  assert.ok(first.rules[0].lastFired);

  const second = processesLib.evaluateRules(first.rules, snapshot(), list, { now: new Date(NOW.getTime() + 60000) });
  assert.equal(second.alerts.length, 0, 'cooldown suppresses repeat alerts');
  const later = processesLib.evaluateRules(first.rules, snapshot(), list, { now: new Date(NOW.getTime() + 6 * 60000) });
  assert.equal(later.alerts.length, 1);

  const disabled = processesLib.evaluateRules([{ ...rules[0], enabled: false, lastFired: null }], snapshot(), list, { now: NOW });
  assert.equal(disabled.alerts.length, 0);
});

test('evaluateRules handles system metrics without processes', () => {
  const rule = processesLib.normalizeRule({
    name: 'Memory pressure', metric: 'memory', threshold: 85, scope: 'system', severity: 'high'
  }, { now: NOW });
  const snap = snapshot({ memory: { percent: 91 }, disks: [{ usePercent: 70 }], network: { rxBytesPerSec: 50, txBytesPerSec: 10 } });
  const result = processesLib.evaluateRules([rule], snap, [], { now: NOW });
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].pid, null);
  assert.match(result.alerts[0].message, /memory is 91/);

  const zombies = processesLib.normalizeRule({ name: 'Zombies', metric: 'zombies', threshold: 1, scope: 'system' }, { now: NOW });
  const found = processesLib.evaluateRules([zombies], snap, [proc({ state: 'Z' }), proc({ state: 'Z' })], { now: NOW });
  assert.equal(found.alerts[0].value, 2);
  assert.equal(processesLib.evaluateRules([rule], snapshot(), [], { now: NOW }).alerts.length, 0);
});

test('appendActionLog and ruleSummary keep bounded, structured history', () => {
  const log = processesLib.appendActionLog([], { action: 'signal', pid: 4, name: 'worker', ok: true, message: 'sent' }, 2);
  assert.equal(log.length, 1);
  assert.ok(log[0].id);
  const next = processesLib.appendActionLog(log, { action: 'priority', pid: 4, ok: false }, 2);
  assert.equal(next.length, 2);
  assert.equal(next[1].ok, false);
  assert.deepEqual(processesLib.ruleSummary([
    { enabled: true, lastFired: NOW.toISOString() }, { enabled: false }, { enabled: true }
  ]), { total: 3, enabled: 2, recentlyFired: 1 });
});

function snapshot(overrides = {}) {
  return {
    timestamp: NOW.toISOString(),
    cpu: { percent: 30, load: [1, 1, 1] },
    memory: { percent: 40 },
    disks: [{ usePercent: 30 }],
    network: { rxBytesPerSec: 10, txBytesPerSec: 10 },
    ...overrides
  };
}
