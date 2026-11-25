'use strict';

/**
 * cinnamon local AI: deterministic, explainable system diagnostics. Pure
 * functions only — no network, no clocks, no side effects.
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

function processActions(proc, includeStop = true) {
  const actions = [
    { label: 'Inspect details', action: 'details', pid: proc.pid },
    { label: 'Lower priority (niceness 10)', action: 'priority', pid: proc.pid, niceness: 10 }
  ];
  if (includeStop) actions.push({ label: 'Ask process to stop', action: 'SIGTERM', pid: proc.pid });
  return actions;
}

/** Rank findings from a snapshot, process list and optional history. */
function analyze(snapshot = {}, processes = [], history = null, options = {}) {
  const procs = Array.isArray(processes) ? processes.filter(Boolean) : [];
  const cpu = snapshot.cpu || {};
  const memory = snapshot.memory || {};
  const network = snapshot.network || {};
  const disks = Array.isArray(snapshot.disks) ? snapshot.disks : [];
  const now = options.now || snapshot.timestamp || new Date().toISOString();
  const findings = [];

  const add = (finding) => findings.push({
    id: finding.id,
    severity: finding.severity,
    title: finding.title,
    evidence: finding.evidence,
    explanation: finding.explanation,
    suggestedActions: finding.suggestedActions || [],
    metric: finding.metric || null,
    value: finding.value === undefined ? null : finding.value
  });

  const byCpu = procs.slice().sort((a, b) => num(b.cpu) - num(a.cpu));
  const cpuOffenders = byCpu.filter((proc) => num(proc.cpu) >= 40).slice(0, 3);
  for (const proc of cpuOffenders) {
    const severity = num(proc.cpu) >= 90 ? 'critical' : num(proc.cpu) >= 70 ? 'high' : 'medium';
    add({
      id: `cpu:${proc.pid}`,
      severity,
      title: `${proc.name} is using ${round(proc.cpu)}% CPU`,
      evidence: `PID ${proc.pid} (${proc.user || 'unknown user'}) · ${round(proc.cpu)}% CPU · up ${uptimeText(proc.uptime)}`,
      explanation: 'A single process consuming a large share of CPU can make the whole desktop feel sluggish. Check whether work is expected before stopping it.',
      suggestedActions: processActions(proc),
      metric: 'cpu', value: round(proc.cpu)
    });
  }

  const byMemory = procs.slice().sort((a, b) => num(b.memoryBytes) - num(a.memoryBytes));
  const memoryOffenders = byMemory.filter((proc) => num(proc.memory) >= 15 || num(proc.memoryBytes) >= 512 * 1024 ** 2).slice(0, 3);
  for (const proc of memoryOffenders) {
    add({
      id: `memory:${proc.pid}`,
      severity: num(proc.memory) >= 30 ? 'high' : 'medium',
      title: `${proc.name} holds ${bytes(proc.memoryBytes)} of memory`,
      evidence: `PID ${proc.pid} · ${round(proc.memory)}% RAM · ${bytes(proc.memoryBytes)} resident`,
      explanation: 'High resident memory reduces what is available for other applications and can trigger swapping.',
      suggestedActions: [
        { label: 'Inspect details', action: 'details', pid: proc.pid },
        { label: 'Ask process to stop', action: 'SIGTERM', pid: proc.pid }
      ],
      metric: 'memoryBytes', value: num(proc.memoryBytes)
    });
  }

  const runaway = byCpu.find((proc) => num(proc.cpu) >= 90 && num(proc.uptime) >= 7200);
  if (runaway) {
    add({
      id: `runaway:${runaway.pid}`,
      severity: 'critical',
      title: `${runaway.name} looks like a runaway process`,
      evidence: `${round(runaway.cpu)}% CPU sustained over ${uptimeText(runaway.uptime)} (PID ${runaway.pid})`,
      explanation: 'A process that has consumed CPU continuously for hours is often stuck in a loop. Verify it is safe to restart before acting.',
      suggestedActions: [
        { label: 'Inspect details', action: 'details', pid: runaway.pid },
        { label: 'Pause process', action: 'SIGSTOP', pid: runaway.pid },
        { label: 'Ask process to stop', action: 'SIGTERM', pid: runaway.pid }
      ],
      metric: 'runaway', value: round(runaway.cpu)
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
      suggestedActions: [
        { label: 'Review memory users', action: 'navigate:processes' },
        { label: 'Open performance charts', action: 'navigate:performance' }
      ],
      metric: 'memory', value: round(memoryPercent)
    });
  }

  for (const disk of disks.slice().sort((a, b) => num(b.usePercent) - num(a.usePercent)).slice(0, 2)) {
    if (num(disk.usePercent) < 80) continue;
    add({
      id: `disk:${disk.mount}`,
      severity: num(disk.usePercent) >= 95 ? 'critical' : 'high',
      title: `Disk ${disk.mount} is ${round(disk.usePercent)}% full`,
      evidence: `${bytes(disk.usedKB * 1024)} used of ${bytes(disk.sizeKB * 1024)} · ${bytes(disk.availableKB * 1024)} available`,
      explanation: 'Nearly full filesystems can break updates, caches and temporary files.',
      suggestedActions: [{ label: 'Review large files outside cinnamon', action: 'none' }],
      metric: 'disk', value: round(disk.usePercent)
    });
  }

  const rx = num(network.rxBytesPerSec);
  const tx = num(network.txBytesPerSec);
  const totalRate = rx + tx;
  const samples = history && Array.isArray(history.samples) ? history.samples : [];
  const recent = samples.slice(-20);
  const averageRate = recent.length
    ? recent.reduce((sum, sample) => sum + num(sample.networkRx) + num(sample.networkTx), 0) / recent.length
    : 0;
  if (totalRate >= 20 * 1024 ** 2 || (averageRate > 1024 ** 2 && totalRate > averageRate * 3)) {
    add({
      id: 'network-spike',
      severity: totalRate >= 50 * 1024 ** 2 ? 'high' : 'medium',
      title: `Unusual network activity: ${bytes(totalRate)}/s`,
      evidence: `↓ ${bytes(rx)}/s · ↑ ${bytes(tx)}/s · recent average ${bytes(averageRate)}/s`,
      explanation: 'Traffic well above the recent baseline may indicate a large transfer or unexpected background activity.',
      suggestedActions: [{ label: 'Review processes', action: 'navigate:processes' }],
      metric: 'network', value: round(totalRate)
    });
  }

  const zombies = procs.filter((proc) => String(proc.state || '').toUpperCase().startsWith('Z'));
  if (zombies.length) {
    add({
      id: 'zombies',
      severity: zombies.length >= 5 ? 'high' : zombies.length >= 2 ? 'medium' : 'low',
      title: `${zombies.length} zombie process${zombies.length === 1 ? '' : 'es'} detected`,
      evidence: zombies.slice(0, 5).map((proc) => `PID ${proc.pid} (${proc.name})`).join(', '),
      explanation: 'Zombies are finished processes whose parent has not reaped them. They use no CPU but consume a process slot.',
      suggestedActions: [{ label: 'Review parent processes', action: 'navigate:processes' }],
      metric: 'zombies', value: zombies.length
    });
  }

  const uptimeDays = num(snapshot.uptimeSeconds) / 86400;
  if (uptimeDays >= 30) {
    add({
      id: 'long-uptime',
      severity: 'low',
      title: `Uptime is ${Math.floor(uptimeDays)} days`,
      evidence: `System has been running for ${uptimeText(snapshot.uptimeSeconds)}`,
      explanation: 'Long uptime can accumulate leaked memory and unfinished kernel work. A scheduled restart may help.',
      suggestedActions: [{ label: 'Plan a restart', action: 'none' }],
      metric: 'uptime', value: Math.floor(uptimeDays)
    });
  }

  const load = Array.isArray(cpu.load) ? num(cpu.load[0]) : 0;
  const cores = Math.max(1, num(cpu.cores, 1));
  if (load > cores) {
    add({
      id: 'load',
      severity: load > cores * 2 ? 'critical' : load > cores * 1.5 ? 'high' : 'medium',
      title: `Load average is ${round(load)} on ${cores} core${cores === 1 ? '' : 's'}`,
      evidence: `1m ${round(load)} · 5m ${round(cpu.load[1])} · 15m ${round(cpu.load[2])}`,
      explanation: 'Load above the core count means processes are waiting for CPU or I/O.',
      suggestedActions: [{ label: 'Review CPU users', action: 'navigate:processes' }],
      metric: 'load', value: round(load)
    });
  }

  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] = (counts[finding.severity] || 0) + 1;
  const penalty = findings.reduce((sum, finding) => sum + (PENALTY[finding.severity] || 0), 0);
  const healthScore = Math.max(0, Math.min(100, 100 - penalty));
  const status = counts.critical || healthScore < 50 ? 'critical' : counts.high || healthScore < 80 ? 'warning' : 'healthy';
  const ordered = findings.slice().sort((a, b) => {
    const rank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    return (rank[a.severity] - rank[b.severity]) || String(b.id).localeCompare(String(a.id));
  });

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
      networkBytesPerSec: round(totalRate),
      processCount: procs.length
    },
    summary: ''
  };
}

function systemHealthSummary(analysis, snapshot = {}) {
  const state = analysis || analyze(snapshot);
  const cpu = num(state.metrics && state.metrics.cpuPercent);
  const memory = num(state.metrics && state.metrics.memoryPercent);
  const top = (state.findings || [])[0];
  const lead = `cinnamon rates this machine ${state.status} (${state.healthScore}/100). CPU ${round(cpu)}%, memory ${round(memory)}%.`;
  if (!top) return `${lead} No significant issues detected.`;
  return `${lead} Top finding: ${top.title}. ${top.explanation}`;
}

function enrich(analysis, snapshot) {
  return { ...analysis, summary: systemHealthSummary(analysis, snapshot) };
}

/** Explainable before/after comparison of two snapshots. */
function compareSnapshots(before = {}, after = {}, options = {}) {
  const b = {
    cpu: num(before.cpu && before.cpu.percent),
    memory: num(before.memory && before.memory.percent),
    load: num(before.cpu && before.cpu.load && before.cpu.load[0]),
    disk: Math.max(0, ...(before.disks || []).map((disk) => num(disk.usePercent))),
    networkRx: num(before.network && before.network.rxBytesPerSec),
    networkTx: num(before.network && before.network.txBytesPerSec),
    processes: num(before.processCount)
  };
  const a = {
    cpu: num(after.cpu && after.cpu.percent),
    memory: num(after.memory && after.memory.percent),
    load: num(after.cpu && after.cpu.load && after.cpu.load[0]),
    disk: Math.max(0, ...(after.disks || []).map((disk) => num(disk.usePercent))),
    networkRx: num(after.network && after.network.rxBytesPerSec),
    networkTx: num(after.network && after.network.txBytesPerSec),
    processes: num(after.processCount)
  };
  const definitions = [
    ['cpu', 'CPU usage', '%'],
    ['memory', 'Memory usage', '%'],
    ['load', 'Load average', ''],
    ['disk', 'Disk usage', '%'],
    ['networkRx', 'Network download', 'B/s'],
    ['networkTx', 'Network upload', 'B/s'],
    ['processes', 'Process count', '']
  ];
  const changes = definitions.map(([key, label, unit]) => {
    const from = round(b[key]);
    const to = round(a[key]);
    const delta = round(to - from);
    const percentChange = b[key] ? round(delta / Math.abs(b[key]) * 100) : null;
    const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
    const verdict = Math.abs(delta) < 0.05 ? 'unchanged' : direction === 'up' ? 'increased' : 'decreased';
    return {
      metric: key,
      label,
      unit,
      before: from,
      after: to,
      delta,
      percentChange,
      direction,
      explanation: `${label} ${verdict}${Math.abs(delta) >= 0.05 ? ` by ${Math.abs(delta)}${unit}` : ''}${percentChange !== null ? ` (${percentChange > 0 ? '+' : ''}${percentChange}%)` : ''}.`
    };
  });
  const biggest = changes.slice().sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))[0];
  return {
    from: before.timestamp || null,
    to: after.timestamp || null,
    generatedAt: options.now || new Date().toISOString(),
    changes,
    summary: biggest ? `Biggest change: ${biggest.explanation}` : 'No metric changed.'
  };
}

module.exports = {
  PENALTY,
  analyze,
  diagnose: analyze,
  enrich,
  systemHealthSummary,
  compareSnapshots,
  bytes,
  uptimeText
};
