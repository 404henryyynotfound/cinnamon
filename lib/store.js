'use strict';

/**
 * Atomic JSON persistence for cinnamon settings, watch rules, alert history
 * and the action log. A filePath of null gives a pure in-memory store.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeRule, appendActionLog } = require('./processes.js');

const STATE_VERSION = 1;
const EXPORT_APP = 'cinnamon';

function defaultSettings() {
  return {
    theme: 'light',
    sampleIntervalMs: 2000,
    historyLimit: 600,
    aiMode: 'local',
    alertsEnabled: true,
    byok: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini'
    }
  };
}

function emptyState(now = new Date()) {
  return {
    version: STATE_VERSION,
    settings: defaultSettings(),
    watchRules: [],
    alertHistory: [],
    actionLog: [],
    pinnedProcesses: [],
    meta: { createdAt: now.toISOString(), updatedAt: now.toISOString() }
  };
}

function seedState(now = new Date()) {
  const stamp = now.toISOString();
  const rules = [
    { id: 'rule_high_cpu', name: 'High CPU process', metric: 'cpu', threshold: 85, operator: '>', scope: 'process', severity: 'high', enabled: true, cooldownMinutes: 5 },
    { id: 'rule_memory_hog', name: 'Memory hog', metric: 'memory', threshold: 25, operator: '>', scope: 'process', severity: 'medium', enabled: true, cooldownMinutes: 10 },
    { id: 'rule_memory_pressure', name: 'System memory pressure', metric: 'memory', threshold: 85, operator: '>', scope: 'system', severity: 'critical', enabled: true, cooldownMinutes: 10 },
    { id: 'rule_zombies', name: 'Zombie processes', metric: 'zombies', threshold: 2, operator: '>', scope: 'system', severity: 'medium', enabled: true, cooldownMinutes: 15 }
  ].map((rule) => normalizeRule({ ...rule, createdAt: stamp }, { now }));
  return { version: STATE_VERSION, settings: defaultSettings(), watchRules: rules, alertHistory: [], actionLog: [], pinnedProcesses: [], meta: { createdAt: stamp, updatedAt: stamp } };
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, fallback = '') {
  return value === null || value === undefined ? fallback : String(value);
}

function normalizeState(raw, now = new Date()) {
  const base = emptyState(now);
  if (!isPlainObject(raw)) return base;
  const source = isPlainObject(raw.data) ? raw.data : raw;
  const rules = (Array.isArray(source.watchRules) ? source.watchRules : []).map((rule) => {
    try { return normalizeRule(rule, { now }); } catch { return null; }
  }).filter(Boolean).filter((rule, index, all) => all.findIndex((other) => other.id === rule.id) === index);

  const alerts = (Array.isArray(source.alertHistory) ? source.alertHistory : [])
    .filter(isPlainObject)
    .slice(-500)
    .map((alert) => ({
      id: text(alert.id, `${now.getTime()}-${Math.random()}`),
      ruleId: text(alert.ruleId),
      ruleName: text(alert.ruleName),
      metric: text(alert.metric),
      value: Number(alert.value) || 0,
      threshold: Number(alert.threshold) || 0,
      severity: ['low', 'medium', 'high', 'critical'].includes(alert.severity) ? alert.severity : 'medium',
      message: text(alert.message),
      evidence: text(alert.evidence),
      pid: alert.pid ? Number(alert.pid) : null,
      timestamp: text(alert.timestamp, now.toISOString()),
      acknowledged: Boolean(alert.acknowledged)
    }));

  const actionLog = (Array.isArray(source.actionLog) ? source.actionLog : []).filter(isPlainObject).slice(-300)
    .map((entry) => appendActionLog([], { ...entry, timestamp: text(entry.timestamp, now.toISOString()) })[0]);

  const pinnedProcesses = (Array.isArray(source.pinnedProcesses) ? source.pinnedProcesses : [])
    .filter(isPlainObject)
    .map((entry) => {
      const pid = Number(entry.pid);
      return Number.isInteger(pid) && pid > 0 ? {
        pid,
        name: text(entry.name).slice(0, 120),
        note: text(entry.note).slice(0, 240),
        pinnedAt: text(entry.pinnedAt, now.toISOString())
      } : null;
    })
    .filter(Boolean)
    .slice(0, 100)
    .filter((entry, index, all) => all.findIndex((other) => other.pid === entry.pid) === index);

  const settings = {
    ...base.settings,
    ...(isPlainObject(source.settings) ? source.settings : {}),
    byok: { ...base.settings.byok, ...(isPlainObject(source.settings && source.settings.byok) ? source.settings.byok : {}) }
  };
  settings.sampleIntervalMs = Math.max(500, Math.min(60000, Number(settings.sampleIntervalMs) || 2000));
  settings.historyLimit = Math.max(10, Math.min(5000, Number(settings.historyLimit) || 600));
  settings.theme = ['light', 'dark', 'system'].includes(settings.theme) ? settings.theme : 'light';

  return {
    version: STATE_VERSION,
    settings,
    watchRules: rules,
    alertHistory: alerts,
    actionLog,
    pinnedProcesses,
    meta: {
      createdAt: text(source.meta && source.meta.createdAt, base.meta.createdAt),
      updatedAt: text(source.meta && source.meta.updatedAt, base.meta.updatedAt)
    }
  };
}

function userDataPath() {
  try {
    const electron = require('electron');
    if (electron && electron.app && typeof electron.app.getPath === 'function') return electron.app.getPath('userData');
  } catch { /* not running inside Electron */ }
  return path.join(os.homedir(), '.cinnamon');
}

function dataFilePath() {
  return path.join(userDataPath(), 'cinnamon-data.json');
}

class Store {
  constructor(options = {}) {
    this.filePath = options.filePath === undefined ? dataFilePath() : options.filePath;
    this.debounceMs = Number.isFinite(options.debounceMs) ? Math.max(0, options.debounceMs) : 250;
    this.seed = options.seed !== false;
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
    this._timer = null;
    this._state = null;
    this.load();
  }

  load() {
    if (!this.filePath) {
      this._state = this.seed ? seedState(this.now()) : emptyState(this.now());
      return this.snapshot();
    }
    try {
      if (!fs.existsSync(this.filePath)) {
        this._state = this.seed ? seedState(this.now()) : emptyState(this.now());
        this.save();
        return this.snapshot();
      }
      this._state = normalizeState(JSON.parse(fs.readFileSync(this.filePath, 'utf8')), this.now());
      return this.snapshot();
    } catch {
      try { fs.copyFileSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`); } catch { /* best effort */ }
      this._state = this.seed ? seedState(this.now()) : emptyState(this.now());
      this.save();
      return this.snapshot();
    }
  }

  save() {
    if (!this.filePath) return false;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this._state.meta.updatedAt = this.now().toISOString();
    const temp = `${this.filePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this._state, null, 2), 'utf8');
    fs.renameSync(temp, this.filePath);
    return true;
  }

  scheduleSave() {
    if (!this.filePath || this.debounceMs === 0) return this.save();
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      try { this.save(); } catch { /* explicit flush surfaces errors */ }
    }, this.debounceMs);
    return true;
  }

  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    return this.save();
  }

  destroy() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  snapshot() { return clone(this._state); }

  _commit() {
    this._state.meta.updatedAt = this.now().toISOString();
    this.scheduleSave();
  }

  // --------------------------------------------------------------- settings

  getSettings() { return clone(this._state.settings); }

  updateSettings(patch = {}) {
    const merged = normalizeState({
      ...this._state,
      settings: {
        ...this._state.settings,
        ...patch,
        byok: { ...this._state.settings.byok, ...(patch.byok || {}) }
      }
    }, this.now());
    this._state.settings = merged.settings;
    this._commit();
    return this.getSettings();
  }

  // ------------------------------------------------------------ watch rules

  listRules(options = {}) {
    let rules = this._state.watchRules.slice();
    if (options.enabledOnly) rules = rules.filter((rule) => rule.enabled);
    return clone(rules);
  }

  getRule(id) {
    const rule = this._state.watchRules.find((candidate) => candidate.id === id);
    return rule ? clone(rule) : null;
  }

  addRule(input) {
    const rule = normalizeRule(input, { now: this.now() });
    if (this._state.watchRules.some((candidate) => candidate.id === rule.id)) {
      throw new Error(`A rule with id ${rule.id} already exists`);
    }
    this._state.watchRules.push(rule);
    this._commit();
    return clone(rule);
  }

  updateRule(id, patch = {}) {
    const index = this._state.watchRules.findIndex((candidate) => candidate.id === id);
    if (index === -1) return null;
    const next = normalizeRule({ ...this._state.watchRules[index], ...patch, id }, { now: this.now() });
    this._state.watchRules[index] = next;
    this._commit();
    return clone(next);
  }

  deleteRule(id) {
    const index = this._state.watchRules.findIndex((candidate) => candidate.id === id);
    if (index === -1) return false;
    this._state.watchRules.splice(index, 1);
    this._commit();
    return true;
  }

  setRuleEnabled(id, enabled) {
    return this.updateRule(id, { enabled: Boolean(enabled) });
  }

  // ---------------------------------------------------------- alert history

  listAlerts(options = {}) {
    const alerts = this._state.alertHistory.slice().sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    return clone(Number.isFinite(options.limit) ? alerts.slice(0, options.limit) : alerts);
  }

  recordAlerts(alerts = [], updatedRules = []) {
    const known = new Set(this._state.alertHistory.map((alert) => alert.id));
    let added = 0;
    for (const alert of Array.isArray(alerts) ? alerts : []) {
      if (!alert || known.has(alert.id)) continue;
      this._state.alertHistory.push({
        id: text(alert.id),
        ruleId: text(alert.ruleId),
        ruleName: text(alert.ruleName),
        metric: text(alert.metric),
        value: Number(alert.value) || 0,
        threshold: Number(alert.threshold) || 0,
        severity: ['low', 'medium', 'high', 'critical'].includes(alert.severity) ? alert.severity : 'medium',
        message: text(alert.message),
        evidence: text(alert.evidence),
        pid: alert.pid ? Number(alert.pid) : null,
        timestamp: text(alert.timestamp, this.now().toISOString()),
        acknowledged: false
      });
      known.add(alert.id);
      added += 1;
    }
    if (this._state.alertHistory.length > 500) this._state.alertHistory.splice(0, this._state.alertHistory.length - 500);
    if (Array.isArray(updatedRules)) {
      for (const rule of updatedRules) {
        const index = this._state.watchRules.findIndex((candidate) => candidate.id === rule.id);
        if (index !== -1 && rule.lastFired) this._state.watchRules[index].lastFired = rule.lastFired;
      }
    }
    this._commit();
    return added;
  }

  acknowledgeAlert(id) {
    const alert = this._state.alertHistory.find((candidate) => candidate.id === id);
    if (!alert) return false;
    alert.acknowledged = true;
    this._commit();
    return true;
  }

  clearAlerts() {
    this._state.alertHistory = [];
    this._commit();
    return true;
  }

  // -------------------------------------------------------------- action log

  listActions(options = {}) {
    const actions = this._state.actionLog.slice().sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    return clone(Number.isFinite(options.limit) ? actions.slice(0, options.limit) : actions);
  }

  logAction(entry) {
    this._state.actionLog = appendActionLog(this._state.actionLog, {
      ...entry,
      timestamp: entry && entry.timestamp ? entry.timestamp : this.now().toISOString()
    });
    this._commit();
    return clone(this._state.actionLog[this._state.actionLog.length - 1]);
  }

  clearActions() {
    this._state.actionLog = [];
    this._commit();
    return true;
  }

  // ------------------------------------------------------- pinned processes

  listPinned() {
    return clone(this._state.pinnedProcesses);
  }

  isPinned(pid) {
    return this._state.pinnedProcesses.some((entry) => entry.pid === Number(pid));
  }

  pinProcess(pid, meta = {}) {
    const target = Number(pid);
    if (!Number.isInteger(target) || target <= 0) throw new TypeError('pid must be a positive integer');
    const existing = this._state.pinnedProcesses.find((entry) => entry.pid === target);
    if (existing) {
      if (meta && meta.name) existing.name = text(meta.name).slice(0, 120);
      if (meta && meta.note) existing.note = text(meta.note).slice(0, 240);
      this._commit();
      return clone(existing);
    }
    const entry = {
      pid: target,
      name: text(meta && meta.name).slice(0, 120),
      note: text(meta && meta.note).slice(0, 240),
      pinnedAt: this.now().toISOString()
    };
    this._state.pinnedProcesses.push(entry);
    if (this._state.pinnedProcesses.length > 100) this._state.pinnedProcesses.shift();
    this._commit();
    return clone(entry);
  }

  unpinProcess(pid) {
    const target = Number(pid);
    const index = this._state.pinnedProcesses.findIndex((entry) => entry.pid === target);
    if (index === -1) return false;
    this._state.pinnedProcesses.splice(index, 1);
    this._commit();
    return true;
  }

  // ---------------------------------------------------------- export/import

  exportJSON() {
    return JSON.stringify({ app: EXPORT_APP, version: STATE_VERSION, exportedAt: this.now().toISOString(), data: this.snapshot() }, null, 2);
  }

  importJSON(input, options = {}) {
    let parsed = input;
    if (typeof input === 'string') {
      try { parsed = JSON.parse(input); } catch (error) { throw new Error(`Import file is not valid JSON: ${error.message}`); }
    }
    if (!isPlainObject(parsed)) throw new Error('Import data must be a JSON object');
    const incoming = normalizeState(parsed, this.now());
    if (options.mode === 'merge') {
      const byId = (current, added) => {
        const ids = new Set(current.map((item) => item.id));
        return current.concat(added.filter((item) => !ids.has(item.id)));
      };
      this._state.watchRules = byId(this._state.watchRules, incoming.watchRules);
      this._state.alertHistory = byId(this._state.alertHistory, incoming.alertHistory);
      this._state.actionLog = byId(this._state.actionLog, incoming.actionLog);
      const pinnedByPid = (current, added) => {
        const pids = new Set(current.map((item) => item.pid));
        return current.concat(added.filter((item) => !pids.has(item.pid)));
      };
      this._state.pinnedProcesses = pinnedByPid(this._state.pinnedProcesses, incoming.pinnedProcesses);
      this._state.settings = { ...this._state.settings, ...incoming.settings, byok: { ...this._state.settings.byok, ...incoming.settings.byok } };
    } else {
      this._state = incoming;
    }
    this._commit();
    return {
      mode: options.mode === 'merge' ? 'merge' : 'replace',
      rules: incoming.watchRules.length,
      alerts: incoming.alertHistory.length,
      actions: incoming.actionLog.length,
      pinned: incoming.pinnedProcesses.length
    };
  }

  reset(options = {}) {
    this._state = options.seed === false ? emptyState(this.now()) : seedState(this.now());
    this._commit();
    return this.snapshot();
  }
}

module.exports = {
  Store,
  STATE_VERSION,
  EXPORT_APP,
  defaultSettings,
  emptyState,
  seedState,
  normalizeState,
  userDataPath,
  dataFilePath
};
