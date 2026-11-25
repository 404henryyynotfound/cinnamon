'use strict';

/** Small, offline system snapshot for CLI reports and diagnostics. */

const os = require('node:os');

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(number(value) * factor) / factor;
}

function systemSnapshot(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const timestamp = Number.isNaN(now.getTime()) ? new Date().toISOString() : now.toISOString();
  const cpus = Array.isArray(options.cpus) ? options.cpus : os.cpus();
  const totalBytes = number(options.totalMemory, os.totalmem());
  const freeBytes = number(options.freeMemory, os.freemem());
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const load = Array.isArray(options.load) ? options.load : os.loadavg();

  return {
    timestamp,
    platform: options.platform || process.platform,
    arch: options.arch || process.arch,
    hostname: options.hostname || os.hostname(),
    release: os.release(),
    uptimeSeconds: Math.max(0, Math.round(number(options.uptimeSeconds, os.uptime()))),
    cpu: {
      percent: round(number(options.cpuPercent)),
      cores: Math.max(1, cpus.length),
      model: cpus[0] && cpus[0].model ? cpus[0].model : 'unknown',
      load: load.map((value) => round(value, 2))
    },
    memory: {
      totalBytes,
      freeBytes,
      usedBytes,
      percent: totalBytes > 0 ? round(usedBytes / totalBytes * 100) : 0
    },
    disks: Array.isArray(options.disks) ? options.disks : [],
    network: {
      rxBytesPerSec: round(number(options.rxBytesPerSec)),
      txBytesPerSec: round(number(options.txBytesPerSec))
    }
  };
}

module.exports = { systemSnapshot };
