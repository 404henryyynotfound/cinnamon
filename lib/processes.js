'use strict';

/**
 * cinnamon process grouping and watch rules. Pure and injectable: an injected
 * clock makes scheduling/cooldowns deterministic in tests.
 */

const METRICS = Object.freeze(['cpu', 'memory', 'memoryBytes', 'load', 'disk', 'network', 'zombies', 'count']);
const OPERATORS = Object.freeze(['>', '>=']);
const SCOPES = Object.freeze(['process', 'system']);

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(num(value) * factor) / factor;
}

function toDate(value, fallback) {
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function newId(prefix = 'rule') {
  const uuid = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${uuid}`;
}

/** Aggregate raw processes into application families. */
function groupProcesses(processes) {
  const groups = new Map();
  for (const proc of Array.isArray(processes) ? processes : []) {
    if (!proc || !proc.name) continue;
    const key = String(proc.name).toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, {
        name: proc.name,
        count: 0,
        cpu: 0,
        memory: 0,
        memoryBytes: 0,
        maxCpu: 0,
        pids: [],
        states: {},
        command: proc.command || ''
      });
    }
    const group = groups.get(key);
    group.count += 1;
    group.cpu += num(proc.cpu);
    group.memory += num(proc.memory);
    group.memoryBytes += num(proc.memoryBytes);
    group.maxCpu = Math.max(group.maxCpu, num(proc.cpu));
    group.pids.push(proc.pid);
    group.states[proc.state] = (group.states[proc.state] || 0) + 1;
    if (!group.command && proc.command) group.command = proc.command;
  }
  return Array.from(groups.values()).map((group) => ({
    ...group,
    cpu: round(group.cpu),
    memory: round(group.memory),
    memoryBytes: Math.round(group.memoryBytes)
  })).sort((a, b) => b.cpu - a.cpu || b.memoryBytes - a.memoryBytes);
}

function processTree(processes) {
  const items = Array.isArray(processes) ? processes : [];
  const nodes = new Map(items.map((proc) => [proc.pid, { ...proc, children: [] }]));
  const roots = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(node.ppid);
    if (parent && parent.pid !== node.pid) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function normalizeRule(input = {}, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Rule must be an object');
  const name = String(input.name || '').trim();
  if (!name) throw new TypeError('Rule needs a name');
  const now = options.now ? toDate(options.now, new Date()) : new Date();
  const metric = METRICS.includes(input.metric) ? input.metric : 'cpu';
  const threshold = num(input.threshold, 80);
  if (!Number.isFinite(threshold)) throw new TypeError('Threshold must be a number');
  const rule = {
    id: String(input.id || '').trim() || newId('rule'),
    name: name.slice(0, 120),
    metric,
    threshold: round(threshold, 2),
    operator: OPERATORS.includes(input.operator) ? input.operator : '>',
    scope: SCOPES.includes(input.scope) ? input.scope : metric === 'cpu' || metric === 'memory' || metric === 'memoryBytes' ? 'process' : 'system',
    severity: ['low', 'medium', 'high', 'critical'].includes(input.severity) ? input.severity : null,
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    cooldownMinutes: Math.max(0, Math.min(1440, num(input.cooldownMinutes, 5))),
    lastFired: input.lastFired && !Number.isNaN(new Date(input.lastFired).getTime()) ? new Date(input.lastFired).toISOString() : null,
    createdAt: input.createdAt && !Number.isNaN(new Date(input.createdAt).getTime()) ? new Date(input.createdAt).toISOString() : now.toISOString()
  };
  return rule;
}

function compare(value, threshold, operator) {
  return operator === '>=' ? value >= threshold : value > threshold;
}

function metricValue(proc, metric) {
  if (metric === 'memoryBytes') return num(proc.memoryBytes);
  if (metric === 'count') return 1;
  return num(proc[metric]);
}

function systemValue(snapshot, processes, metric) {
  if (metric === 'cpu') return num(snapshot.cpu && snapshot.cpu.percent);
  if (metric === 'memory') return num(snapshot.memory && snapshot.memory.percent);
  if (metric === 'load') return num(snapshot.cpu && snapshot.cpu.load && snapshot.cpu.load[0]);
  if (metric === 'disk') return Math.max(0, ...(snapshot.disks || []).map((disk) => num(disk.usePercent)));
  if (metric === 'network') return num(snapshot.network && snapshot.network.rxBytesPerSec) + num(snapshot.network && snapshot.network.txBytesPerSec);
  if (metric === 'zombies') return (processes || []).filter((proc) => String(proc.state || '').toUpperCase().startsWith('Z')).length;
  if (metric === 'count') return (processes || []).length;
  return 0;
}

function severityFor(rule, value) {
  if (rule.severity) return rule.severity;
  const ratio = rule.threshold ? value / Math.abs(rule.threshold) : 1;
  return ratio >= 2 ? 'critical' : ratio >= 1.5 ? 'high' : 'medium';
}

/** Evaluate rules without mutating inputs; returns alerts and updated rules. */
function evaluateRules(rules, snapshot = {}, processes = [], options = {}) {
  const now = options.now ? toDate(options.now, new Date()) : new Date();
  const procs = Array.isArray(processes) ? processes : [];
  const alerts = [];
  const nextRules = [];
  let evaluated = 0;

  for (const raw of Array.isArray(rules) ? rules : []) {
    let rule;
    try { rule = normalizeRule(raw); } catch { nextRules.push(raw); continue; }
    nextRules.push(rule);
    if (!rule.enabled) continue;
    evaluated += 1;

    if (rule.lastFired && (now.getTime() - new Date(rule.lastFired).getTime()) < rule.cooldownMinutes * 60000) continue;

    const candidates = rule.scope === 'process'
      ? procs.filter((proc) => compare(metricValue(proc, rule.metric), rule.threshold, rule.operator))
        .sort((a, b) => metricValue(b, rule.metric) - metricValue(a, rule.metric)).slice(0, 3)
      : (compare(systemValue(snapshot, procs, rule.metric), rule.threshold, rule.operator)
        ? [{ system: true, value: systemValue(snapshot, procs, rule.metric) }]
        : []);

    for (const candidate of candidates) {
      const value = rule.scope === 'process' ? metricValue(candidate, rule.metric) : candidate.value;
      alerts.push({
        id: newId('alert'),
        ruleId: rule.id,
        ruleName: rule.name,
        metric: rule.metric,
        value: round(value, 2),
        threshold: rule.threshold,
        severity: severityFor(rule, value),
        message: candidate.system
          ? `${rule.name}: ${rule.metric} is ${round(value, 2)} (${rule.operator} ${rule.threshold})`
          : `${rule.name}: ${candidate.name} (PID ${candidate.pid}) ${rule.metric} is ${round(value, 2)} (${rule.operator} ${rule.threshold})`,
        evidence: candidate.system
          ? `Snapshot at ${snapshot.timestamp || now.toISOString()}`
          : `PID ${candidate.pid} · ${candidate.name} · state ${candidate.state || '?'}`,
        pid: candidate.system ? null : candidate.pid,
        timestamp: now.toISOString(),
        acknowledged: false
      });
    }
    if (candidates.length) {
      const index = nextRules.findIndex((entry) => entry.id === rule.id);
      if (index !== -1) nextRules[index] = { ...rule, lastFired: now.toISOString() };
    }
  }
  return { alerts, rules: nextRules, evaluated, timestamp: now.toISOString() };
}

function appendActionLog(log, entry, limit = 300) {
  const current = Array.isArray(log) ? log : [];
  const next = current.concat([{
    id: String(entry && entry.id || newId('action')),
    timestamp: entry && entry.timestamp ? entry.timestamp : new Date().toISOString(),
    action: String(entry && entry.action || 'unknown'),
    pid: entry && entry.pid ? Number(entry.pid) : null,
    name: String(entry && entry.name || ''),
    ok: entry && entry.ok !== false,
    message: String(entry && entry.message || ''),
    details: entry && entry.details ? entry.details : null
  }]);
  return next.slice(-Math.max(1, num(limit, 300)));
}

function ruleSummary(rules) {
  const list = Array.isArray(rules) ? rules : [];
  return {
    total: list.length,
    enabled: list.filter((rule) => rule.enabled).length,
    recentlyFired: list.filter((rule) => rule.lastFired).length
  };
}

module.exports = {
  METRICS,
  OPERATORS,
  SCOPES,
  groupProcesses,
  processTree,
  normalizeRule,
  evaluateRules,
  appendActionLog,
  ruleSummary
};
