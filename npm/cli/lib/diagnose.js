'use strict';

/**
 * Deterministic local diagnostics adapted from cinnamon/lib/ai.js. No network,
 * no clocks and no side effects: callers supply the snapshot and process list.
 */

const PENALTY = Object.freeze({ critical: 22, high: 14, medium: 7, low: 3, info: 0 });

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(num(value) * factor) / factor;
}

function bytes(value) {
  const n = Math.max(0, num(value));
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 ** 2) return `${round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${round(n / 1024 ** 2)} MB`;
  return `${round(n / 1024 ** 3)} GB`;
}

function uptimeText(seconds) {
  const value = Math.max(0, num(seconds));
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${Math.floor((value % 3600) / 60)}m`;
  return `${Math.floor(value / 60)}m`;
}

function analyze(snapshot = {}, processes = [], options = {}) {
  const procs = Array.isArray(processes) ? processes.filter(Boolean) : [];
  const cpu = snapshot.cpu || {};
  const memory = snapshot.memory || {};
  const disks = Array.isArray(snapshot.disks) ? snapshot.disks : [];
  const now = options.now || snapshot.timestamp || new Date().toISOString();
  const findings = [];

  const add = (finding) => findings.push({
    id: finding.id,
    severity: finding.severity,
    title: finding.title,
    evidence: finding.evidence,
    explanation: finding.explanation,
    metric: finding.metric || null,
    value: finding.value === undefined ? null : finding.value
  });

  const byCpu = procs.slice().sort((a, b) => num(b.cpu) - num(a.cpu));
  for (const proc of byCpu.filter((entry) => num(entry.cpu) >= 40).slice(0, 3)) {
    add({
      id: `cpu:${proc.pid}`,
      severity: num(proc.cpu) >= 90 ? 'critical' : num(proc.cpu) >= 70 ? 'high' : 'medium',
      title: `${proc.name} is using ${round(proc.cpu)}% CPU`,
      evidence: `PID ${proc.pid} (${proc.user || 'unknown user'}) · up ${uptimeText(proc.uptime)}`,
      explanation: 'A process consuming a large share of CPU can make the machine feel sluggish. Check whether the work is expected before acting.',
      metric: 'cpu',
      value: round(proc.cpu)
    });
  }

  const byMemory = procs.slice().sort((a, b) => num(b.memoryBytes) - num(a.memoryBytes));
  for (const proc of byMemory.filter((entry) => num(entry.memory) >= 15 || num(entry.memoryBytes) >= 512 * 1024 ** 2).slice(0, 3)) {
    add({
      id: `memory:${proc.pid}`,
      severity: num(proc.memory) >= 30 ? 'high' : 'medium',
      title: `${proc.name} holds ${bytes(proc.memoryBytes)} of memory`,
      evidence: `PID ${proc.pid} · ${round(proc.memory)}% RAM · ${bytes(proc.memoryBytes)} resident`,
      explanation: 'High resident memory leaves less available for other applications and can trigger swapping.',
      metric: 'memoryBytes',
      value: num(proc.memoryBytes)
    });
  }

  const memoryPercent = num(memory.percent);
  if (memoryPercent >= 60) {
    add({
      id: 'memory-pressure',
      severity: memoryPercent >= 85 ? 'critical' : memoryPercent >= 75 ? 'high' : 'medium',
      title: `Memory pressure is ${round(memoryPercent)}%`,
      evidence: `${bytes(memory.usedBytes)} used of ${bytes(memory.totalBytes)} (${bytes(memory.freeBytes)} free)`,
      explanation: 'When memory fills up, the operating system swaps to disk and applications become slow.',
      metric: 'memory',
      value: round(memoryPercent)
    });
  }

  for (const disk of disks.slice().sort((a, b) => num(b.usePercent) - num(a.usePercent)).slice(0, 2)) {
    if (num(disk.usePercent) < 80) continue;
    add({
      id: `disk:${disk.mount}`,
      severity: num(disk.usePercent) >= 95 ? 'critical' : 'high',
      title: `Disk ${disk.mount} is ${round(disk.usePercent)}% full`,
      evidence: `${bytes(num(disk.usedKB) * 1024)} used of ${bytes(num(disk.sizeKB) * 1024)}`,
      explanation: 'Nearly full filesystems can break updates, caches and temporary files.',
      metric: 'disk',
      value: round(disk.usePercent)
    });
  }

  const zombies = procs.filter((proc) => String(proc.state || '').toUpperCase().startsWith('Z'));
  if (zombies.length) {
    add({
      id: 'zombies',
      severity: zombies.length >= 5 ? 'high' : zombies.length >= 2 ? 'medium' : 'low',
      title: `${zombies.length} zombie process${zombies.length === 1 ? '' : 'es'} detected`,
      evidence: zombies.slice(0, 5).map((proc) => `PID ${proc.pid} (${proc.name})`).join(', '),
      explanation: 'Zombies have finished but were not reaped by their parent. They use no CPU but consume a process slot.',
      metric: 'zombies',
      value: zombies.length
    });
  }

  const load = Array.isArray(cpu.load) ? num(cpu.load[0]) : 0;
  const cores = Math.max(1, num(cpu.cores, 1));
  if (load > cores) {
    add({
      id: 'load',
      severity: load > cores * 2 ? 'critical' : load > cores * 1.5 ? 'high' : 'medium',
      title: `Load average is ${round(load)} on ${cores} core${cores === 1 ? '' : 's'}`,
      evidence: `1m ${round(load)} · 5m ${round(num(cpu.load[1]))} · 15m ${round(num(cpu.load[2]))}`,
      explanation: 'Load above the core count means processes are waiting for CPU or I/O.',
      metric: 'load',
      value: round(load)
    });
  }

  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] = (counts[finding.severity] || 0) + 1;
  const penalty = findings.reduce((sum, finding) => sum + (PENALTY[finding.severity] || 0), 0);
  const healthScore = Math.max(0, Math.min(100, 100 - penalty));
  const status = counts.critical || healthScore < 50 ? 'critical'
    : counts.high || healthScore < 80 ? 'warning' : 'healthy';
  const rank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const ordered = findings.slice().sort((a, b) => (rank[a.severity] - rank[b.severity]) || String(b.id).localeCompare(String(a.id)));

  return {
    timestamp: now,
    healthScore,
    status,
    findings: ordered,
    counts,
    metrics: {
      cpuPercent: round(cpu.percent),
      memoryPercent: round(memory.percent),
      diskPercent: Math.max(0, ...disks.map((disk) => num(disk.usePercent))),
      networkBytesPerSec: round(num(snapshot.network && snapshot.network.rxBytesPerSec) + num(snapshot.network && snapshot.network.txBytesPerSec)),
      processCount: procs.length
    },
    summary: ''
  };
}

function enrich(analysis, snapshot = {}) {
  const state = analysis || analyze(snapshot);
  const cpu = num(state.metrics && state.metrics.cpuPercent);
  const memory = num(state.metrics && state.metrics.memoryPercent);
  const top = (state.findings || [])[0];
  const lead = `cinnamon rates this machine ${state.status} (${state.healthScore}/100). CPU ${round(cpu)}%, memory ${round(memory)}%.`;
  return {
    ...state,
    summary: top ? `${lead} Top finding: ${top.title}. ${top.explanation}` : `${lead} No significant issues detected.`
  };
}

module.exports = { PENALTY, analyze, diagnose: analyze, enrich, bytes, uptimeText, number: num, round };
