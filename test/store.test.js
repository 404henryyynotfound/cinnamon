'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  Store, STATE_VERSION, EXPORT_APP, defaultSettings, emptyState, seedState, normalizeState
} = require('../lib/store.js');

const NOW = new Date('2026-11-25T10:00:00.000Z');

function memory(options = {}) {
  return new Store({ filePath: null, seed: false, now: () => NOW, debounceMs: 0, ...options });
}

test('in-memory mode needs no Electron and starts empty', () => {
  const store = memory();
  assert.equal(store.filePath, null);
  assert.deepEqual(store.listRules(), []);
  assert.deepEqual(store.listAlerts(), []);
  assert.deepEqual(store.listActions(), []);
  assert.deepEqual(store.getSettings(), defaultSettings());
  assert.equal(STATE_VERSION, 1);
});

test('seed mode creates usable watch rules', () => {
  const store = new Store({ filePath: null, now: () => NOW });
  assert.ok(store.listRules().length >= 4);
  assert.ok(store.listRules().every((rule) => rule.enabled && rule.id));
  assert.deepEqual(seedState(NOW).alertHistory, []);
});

test('rule CRUD normalizes, filters and toggles', () => {
  const store = memory();
  const created = store.addRule({ name: 'Hot CPU', metric: 'cpu', threshold: 90, scope: 'process', cooldownMinutes: 3 });
  assert.equal(created.name, 'Hot CPU');
  assert.equal(store.getRule(created.id).threshold, 90);
  store.addRule({ name: 'Zombies', metric: 'zombies', threshold: 2, scope: 'system', enabled: false });
  assert.deepEqual(store.listRules({ enabledOnly: true }).map((rule) => rule.name), ['Hot CPU']);
  const updated = store.updateRule(created.id, { threshold: 95, enabled: false });
  assert.equal(updated.threshold, 95);
  assert.equal(store.setRuleEnabled(created.id, true).enabled, true);
  assert.equal(store.updateRule('missing', {}), null);
  assert.equal(store.deleteRule(created.id), true);
  assert.equal(store.deleteRule(created.id), false);
  assert.equal(store.getRule(created.id), null);
  assert.throws(() => store.addRule({ name: '' }), /needs a name/);
});

test('settings merge deeply, including BYOK fields', () => {
  const store = memory();
  const next = store.updateSettings({ theme: 'dark', sampleIntervalMs: 5000, byok: { apiKey: 'secret', baseUrl: 'https://ai.test/v1' } });
  assert.equal(next.theme, 'dark');
  assert.equal(next.sampleIntervalMs, 5000);
  assert.equal(next.byok.apiKey, 'secret');
  assert.equal(next.byok.model, 'gpt-4o-mini');
  assert.equal(store.updateSettings({ theme: 'light' }).byok.apiKey, 'secret');
  assert.equal(store.updateSettings({ sampleIntervalMs: -1 }).sampleIntervalMs, 500);
  assert.equal(store.updateSettings({ theme: 'nope' }).theme, 'light');
});

test('alert history deduplicates, acknowledges and clears', () => {
  const store = memory();
  const alert = { id: 'a1', ruleName: 'Hot CPU', severity: 'high', message: 'CPU 95%', timestamp: NOW.toISOString() };
  assert.equal(store.recordAlerts([alert]), 1);
  assert.equal(store.recordAlerts([alert]), 0);
  assert.equal(store.listAlerts().length, 1);
  assert.equal(store.acknowledgeAlert('a1'), true);
  assert.equal(store.listAlerts()[0].acknowledged, true);
  assert.equal(store.listAlerts({ limit: 0 }).length, 0);
  assert.equal(store.clearAlerts(), true);
  assert.deepEqual(store.listAlerts(), []);
});

test('action log is append-only and bounded', () => {
  const store = memory();
  store.logAction({ action: 'signal', pid: 5, name: 'worker', ok: true });
  const latest = store.listActions()[0];
  assert.equal(latest.action, 'signal');
  assert.equal(latest.name, 'worker');
  assert.ok(latest.timestamp);
  assert.equal(store.clearActions(), true);
  assert.deepEqual(store.listActions(), []);
});

test('export/import supports replace and merge without duplicates', () => {
  const store = memory();
  store.addRule({ id: 'r1', name: 'One', metric: 'cpu', threshold: 90 });
  const backup = store.exportJSON();
  assert.equal(JSON.parse(backup).app, EXPORT_APP);

  store.addRule({ id: 'r2', name: 'Two', metric: 'memory', threshold: 80 });
  const merged = store.importJSON(backup, { mode: 'merge' });
  assert.equal(merged.mode, 'merge');
  assert.deepEqual(store.listRules().map((rule) => rule.id), ['r1', 'r2']);

  store.importJSON(backup, { mode: 'replace' });
  assert.deepEqual(store.listRules().map((rule) => rule.id), ['r1']);
  assert.throws(() => store.importJSON('{bad json}'), /not valid JSON/);
  assert.throws(() => store.importJSON('null'), /JSON object/);
});

test('atomic disk persistence writes, reloads and heals corrupt files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinnamon-test-'));
  const file = path.join(dir, 'cinnamon-data.json');
  try {
    const store = new Store({ filePath: file, seed: false, now: () => NOW, debounceMs: 5 });
    store.addRule({ id: 'disk1', name: 'Persisted', metric: 'cpu', threshold: 70 });
    store.flush();
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.existsSync(`${file}.tmp`), false);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).watchRules[0].name, 'Persisted');

    const reloaded = new Store({ filePath: file, seed: false, now: () => NOW });
    assert.deepEqual(reloaded.listRules().map((rule) => rule.id), ['disk1']);
    reloaded.destroy();

    fs.writeFileSync(file, '{not json', 'utf8');
    const healed = new Store({ filePath: file, seed: true, now: () => NOW });
    assert.ok(healed.listRules().length > 0);
    assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('cinnamon-data.json.corrupt-')));
    healed.destroy();
    store.destroy();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeState drops invalid entries and reset can skip seeding', () => {
  const state = normalizeState({
    watchRules: [{ name: 'ok' }, null, {}, { id: 'dup', name: 'dup' }, { id: 'dup', name: 'dup' }],
    alertHistory: [{ message: 'alert' }, null],
    settings: { theme: 'invalid', historyLimit: 999999 }
  }, NOW);
  assert.equal(state.watchRules.length, 2);
  assert.equal(state.alertHistory.length, 1);
  assert.equal(state.settings.theme, 'light');
  assert.equal(state.settings.historyLimit, 5000);
  assert.equal(state.version, STATE_VERSION);
  assert.deepEqual(emptyState(NOW).watchRules, []);

  const store = memory();
  store.addRule({ name: 'Temp' });
  assert.equal(store.reset({ seed: false }).watchRules.length, 0);
  assert.ok(store.reset().watchRules.length > 0);
});
