'use strict';

/**
 * Pure chart data derived from cinnamon's history ring buffer. Everything is
 * a plain array/object so the UI can draw inline SVG without a chart library.
 */

const { historySeries } = require('./system.js');

const COLORS = Object.freeze(['#d2691e', '#e4933b', '#b45309', '#4f7c6a', '#5373ad', '#8b5a8c', '#a16207', '#8a7d71']);

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(num(value) * factor) / factor;
}

function samplesOf(history) {
  return history && Array.isArray(history.samples) ? history.samples : [];
}

function labelOf(sample) {
  return String(sample && sample.timestamp || '').slice(11, 16) || '—';
}

function cpuSeries(history) {
  return historySeries(history, 'cpu').map((point) => ({ ...point, label: labelOf({ timestamp: point.timestamp }) }));
}

function memorySeries(history) {
  return samplesOf(history).map((sample) => ({
    timestamp: sample.timestamp,
    label: labelOf(sample),
    value: round(num(sample.memory)),
    bytes: num(sample.memoryBytes)
  }));
}

function diskSeries(history) {
  const samples = samplesOf(history);
  return samples.map((sample, index) => {
    const value = round(num(sample.disk));
    let ratePerHour = 0;
    if (index > 0) {
      const timestamp = new Date(sample.timestamp).getTime();
      const previous = new Date(samples[index - 1].timestamp).getTime();
      const hours = (timestamp - previous) / 3600000;
      if (hours > 0) ratePerHour = round((value - num(samples[index - 1].disk)) / hours);
    }
    return { timestamp: sample.timestamp, label: labelOf(sample), value, ratePerHour };
  });
}

function networkSeries(history) {
  const samples = samplesOf(history);
  return {
    rx: samples.map((sample) => ({ timestamp: sample.timestamp, label: labelOf(sample), value: round(num(sample.networkRx)) })),
    tx: samples.map((sample) => ({ timestamp: sample.timestamp, label: labelOf(sample), value: round(num(sample.networkTx)) })),
    total: samples.map((sample) => ({
      timestamp: sample.timestamp,
      label: labelOf(sample),
      value: round(num(sample.networkRx) + num(sample.networkTx))
    }))
  };
}

function processBars(processes, metric = 'cpu', count = 10) {
  const key = metric === 'memory' ? 'memoryBytes' : metric;
  return (Array.isArray(processes) ? processes : []).slice()
    .sort((a, b) => num(b[key]) - num(a[key]))
    .slice(0, Math.max(1, num(count, 10)))
    .map((proc) => ({
      pid: proc.pid,
      name: proc.name,
      value: round(num(proc[key])),
      label: `${proc.name} (${proc.pid})`
    }));
}

function memoryDonut(processes, count = 7) {
  const procs = (Array.isArray(processes) ? processes : []).slice()
    .sort((a, b) => num(b.memoryBytes) - num(a.memoryBytes));
  const limit = Math.max(1, num(count, 7));
  const top = procs.slice(0, limit).map((proc) => ({ name: `${proc.name} (${proc.pid})`, value: Math.max(0, num(proc.memoryBytes)) }));
  const rest = procs.slice(limit).reduce((sum, proc) => sum + Math.max(0, num(proc.memoryBytes)), 0);
  if (rest > 0) top.push({ name: 'Other processes', value: rest });
  const total = top.reduce((sum, entry) => sum + entry.value, 0);
  return top.map((entry, index) => ({
    ...entry,
    percent: total ? round(entry.value / total * 100) : 0,
    color: COLORS[index % COLORS.length]
  }));
}

function activityHeatmap(history) {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const counts = new Map();
  for (const sample of samplesOf(history)) {
    const date = new Date(sample.timestamp);
    if (Number.isNaN(date.getTime())) continue;
    const row = (date.getDay() + 6) % 7;
    const col = date.getHours();
    const id = `${row}:${col}`;
    const weight = Math.max(0.1, num(sample.cpu) / 25 + 0.1);
    counts.set(id, round((counts.get(id) || 0) + weight, 2));
  }
  const cells = [];
  let max = 0;
  for (let row = 0; row < 7; row += 1) {
    for (let col = 0; col < 24; col += 1) {
      const value = counts.get(`${row}:${col}`) || 0;
      max = Math.max(max, value);
      cells.push({ row, col, day: days[row], hour: col, value });
    }
  }
  return { days, hours: Array.from({ length: 24 }, (_, index) => index), cells, max: round(max, 2), samples: samplesOf(history).length };
}

function derivedStats(history, key = 'cpu') {
  const values = samplesOf(history).map((sample) => num(sample[key]));
  if (!values.length) return { peak: 0, average: 0, latest: 0, min: 0, trend: 0, samples: 0 };
  const firstThird = values.slice(0, Math.max(1, Math.floor(values.length / 3)));
  const lastThird = values.slice(-Math.max(1, Math.floor(values.length / 3)));
  const avg = (list) => list.reduce((sum, value) => sum + value, 0) / list.length;
  const initial = avg(firstThird);
  const latestAvg = avg(lastThird);
  return {
    peak: round(Math.max(...values)),
    average: round(avg(values)),
    latest: round(values[values.length - 1]),
    min: round(Math.min(...values)),
    trend: initial ? round((latestAvg - initial) / Math.abs(initial) * 100) : 0,
    samples: values.length
  };
}

function all(history, processes = []) {
  return {
    generatedAt: new Date().toISOString(),
    cpu: cpuSeries(history),
    memory: memorySeries(history),
    disk: diskSeries(history),
    network: networkSeries(history),
    processBars: {
      cpu: processBars(processes, 'cpu'),
      memory: processBars(processes, 'memory')
    },
    memoryDonut: memoryDonut(processes),
    heatmap: activityHeatmap(history),
    stats: {
      cpu: derivedStats(history, 'cpu'),
      memory: derivedStats(history, 'memory'),
      disk: derivedStats(history, 'disk'),
      networkRx: derivedStats(history, 'networkRx'),
      networkTx: derivedStats(history, 'networkTx')
    }
  };
}

module.exports = {
  COLORS,
  cpuSeries,
  memorySeries,
  diskSeries,
  networkSeries,
  processBars,
  memoryDonut,
  activityHeatmap,
  derivedStats,
  all
};
