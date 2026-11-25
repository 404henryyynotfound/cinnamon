'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sampling = require('../lib/sample.js');

function statLine(pid, comm, state, ppid, utime, stime, starttime) {
  const fields = [state, String(ppid), '0', '0', '0', '0', '-1', '0', '0', '0', '0',
    String(utime), String(stime), '0', '0', '0', '0', '0', '0', String(starttime)];
  return `${pid} (${comm}) ${fields.join(' ')}\n`;
}

const PS_OUTPUT = `  PID  PPID USER     COMM          %CPU %MEM   RSS ELAPSED   STAT COMMAND
   42     1 root     node          12.5  1.2 40960 01:23:45 Sl   node /srv/app.js
    7     0 root     init           0.0  0.1  2048 2-03:04:05 Ss  /sbin/init
this row is deliberately malformed
`;

function procFiles() {
  return {
    '/proc': ['1', '2', 'self', 'net'],
    '/proc/stat': 'cpu  100 0 50 850 0 0 0 0\ncpu0 100 0 50 850 0 0 0 0\n',
    '/proc/uptime': '1000.0 0.0',
    '/etc/passwd': 'root:x:0:0:root:/root:/bin/sh\nhenry:x:1000:1000:Henry:/home/henry:/bin/bash\n',
    '/proc/1/stat': statLine(1, 'init', 'S', 0, 10, 5, 100),
    '/proc/1/status': 'Name:\tinit\nState:\tS (sleeping)\nUid:\t0 0 0 0\nPPid:\t0\nVmRSS:\t  2048 kB\n',
    '/proc/1/cmdline': '/sbin/init\u0000',
    '/proc/2/stat': statLine(2, 'worker', 'R', 1, 190, 10, 900),
    '/proc/2/status': 'Name:\tworker\nState:\tR (running)\nUid:\t1000 1000 1000 1000\nPPid:\t1\nVmRSS:\t  8192 kB\n',
    '/proc/2/cmdline': 'node\u0000worker.js\u0000'
  };
}

function procDeps(files) {
  return {
    platform: 'linux',
    totalMemory: 1024 * 1024,
    readDir: async (dir) => {
      if (!(dir in files)) throw new Error(`ENOENT ${dir}`);
      return files[dir];
    },
    readFile: async (file) => {
      if (!(file in files)) throw new Error(`ENOENT ${file}`);
      return files[file];
    }
  };
}

test('parseProcStat keeps comm with parentheses and spaces', () => {
  const parsed = sampling.parseProcStat(statLine(123, 'my (weird) proc', 'R', 9, 4, 6, 20));
  assert.equal(parsed.pid, 123);
  assert.equal(parsed.comm, 'my (weird) proc');
  assert.equal(parsed.ppid, 9);
  assert.equal(parsed.utime, 4);
  assert.equal(parsed.stime, 6);
  assert.equal(parsed.starttime, 20);
});

test('parse helpers read status, CPU ticks and passwd safely', () => {
  const files = procFiles();
  assert.equal(sampling.parseCpuTicks(files['/proc/stat']), 1000);
  assert.deepEqual(sampling.parsePasswd(files['/etc/passwd']), {
    0: 'root',
    1000: 'henry'
  });
  assert.equal(sampling.parseStatus(files['/proc/1/status']).VmRSS, '2048 kB');
  assert.equal(sampling.parseEtime('2-03:04:05'), 183845);
});

test('listProcesses reads /proc with injected readers and no commands', async () => {
  const calls = [];
  const deps = procDeps(procFiles());
  deps.runCommand = async (command, args) => { calls.push([command, args]); return ''; };
  const processes = await sampling.listProcesses(deps);
  assert.equal(processes.length, 2);
  assert.deepEqual(processes.map((proc) => proc.pid), [1, 2]);
  assert.deepEqual(processes.map((proc) => proc.user), ['root', 'henry']);
  assert.equal(processes[0].cpu, 1.5);
  assert.equal(processes[1].cpu, 20);
  assert.equal(processes[0].name, 'init');
  assert.equal(processes[0].uptime, 999);
  assert.equal(processes[1].uptime, 991);
  assert.equal(processes[1].memoryBytes, 8192 * 1024);
  assert.equal(processes[1].command, 'node worker.js');
  assert.deepEqual(calls, []);
});

test('listProcesses uses safely parsed ps on macOS', async () => {
  const calls = [];
  const processes = await sampling.listProcesses({
    platform: 'darwin',
    runCommand: async (command, args) => { calls.push([command, args]); return PS_OUTPUT; }
  });
  assert.equal(processes.length, 2);
  assert.equal(processes[0].pid, 42);
  assert.equal(processes[0].cpu, 12.5);
  assert.equal(processes[0].memoryBytes, 40960 * 1024);
  assert.equal(processes[0].uptime, 5025);
  assert.equal(processes[0].command, 'node /srv/app.js');
  assert.equal(processes[1].uptime, 183845);
  assert.equal(calls[0][0], 'ps');
  assert.ok(calls[0][1].includes('-r'));
});

test('listProcesses falls back to ps when /proc cannot be read', async () => {
  const calls = [];
  const deps = procDeps({});
  deps.runCommand = async (command, args) => { calls.push([command, args]); return PS_OUTPUT; };
  const processes = await sampling.listProcesses(deps);
  assert.equal(processes.length, 2);
  assert.equal(calls[0][0], 'ps');
  assert.ok(calls[0][1].includes('--sort=-pcpu'));
});

test('parsePsOutput ignores malformed lines and headers', () => {
  const parsed = sampling.parsePsOutput(PS_OUTPUT);
  assert.equal(parsed.length, 2);
  assert.ok(parsed.every((proc) => Number.isInteger(proc.pid) && proc.pid > 0));
});
