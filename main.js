'use strict';

/**
 * cinnamon Electron main process: sampling, persistence, IPC and desktop
 * integration. No UI logic lives here.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {
  app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, globalShortcut, nativeTheme, shell
} = require('electron');

const { INVOKE, EVENTS, ALLOWED_INVOKE } = require('./lib/channels.js');
const { Store } = require('./lib/store.js');
const system = require('./lib/system.js');
const actions = require('./lib/actions.js');
const ai = require('./lib/ai.js');
const cloud = require('./lib/cloud.js');
const analytics = require('./lib/analytics.js');
const processesLib = require('./lib/processes.js');
const changelog = require('./lib/changelog.js');
const github = require('./lib/github.js');
const reports = require('./lib/reports.js');

let mainWindow = null;
let tray = null;
let sampleTimer = null;
let sampling = false;
let store = null;
let snapshot = null;
let processList = [];
let history = system.createHistory(600);
let snapshots = [];
let analysis = null;
let alerts = [];

// ---------------------------------------------------------------- tray icon

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function trayIcon() {
  const size = 32;
  const raw = [];
  for (let y = 0; y < size; y += 1) {
    raw.push(0);
    for (let x = 0; x < size; x += 1) {
      const dx = x - 15.5;
      const dy = y - 15.5;
      const inside = (dx * dx) / 196 + (dy * dy) / 196 <= 1;
      raw.push(inside ? 210 : 0, inside ? 105 : 0, inside ? 30 : 0, inside ? 255 : 0);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return nativeImage.createFromBuffer(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.from(raw))),
    pngChunk('IEND', Buffer.alloc(0))
  ]));
}

// ------------------------------------------------------------------- window

function sendShortcut(action) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.webContents.send(EVENTS.SHORTCUT, String(action));
  }
}

function emitUpdate() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(EVENTS.SYSTEM_UPDATE, {
      snapshot, processes: processList, tree: actions.processTree(processList), history, analysis, alerts
    });
  }
}

function createWindow() {
  const icon = trayIcon();
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 650,
    title: 'cinnamon',
    backgroundColor: '#f6f2ec',
    icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  return mainWindow;
}

function navigate(view) {
  return () => sendShortcut(`navigate:${view}`);
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Settings', accelerator: 'CommandOrControl+,', click: () => sendShortcut('settings') },
        { type: 'separator' },
        { label: 'Export Data…', click: () => sendShortcut('export') },
        { label: 'Import Data…', click: () => sendShortcut('import') },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Overview', accelerator: 'CommandOrControl+1', click: navigate('overview') },
        { label: 'Processes', accelerator: 'CommandOrControl+2', click: navigate('processes') },
        { label: 'Performance', accelerator: 'CommandOrControl+3', click: navigate('performance') },
        { label: 'AI Diagnostics', accelerator: 'CommandOrControl+4', click: navigate('ai') },
        { label: 'Watchers', accelerator: 'CommandOrControl+5', click: navigate('watchers') },
        { label: 'Changelog', accelerator: 'CommandOrControl+6', click: navigate('changelog') },
        { type: 'separator' },
        { label: 'Command Palette', accelerator: 'CommandOrControl+K', click: () => sendShortcut('palette') },
        { label: 'Toggle Theme', accelerator: 'CommandOrControl+Shift+T', click: () => sendShortcut('toggle-theme') },
        { type: 'separator' },
        { role: 'reload' }, { role: 'toggleDevTools' }
      ]
    },
    {
      label: 'Tools',
      submenu: [
        { label: 'Refresh Now', accelerator: 'CommandOrControl+Shift+R', click: () => sendShortcut('refresh') },
        { label: 'Evaluate Watchers', click: () => sendShortcut('evaluate') },
        { label: 'Settings', click: () => sendShortcut('settings') }
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Changelog', click: navigate('changelog') },
        { label: 'Keyboard Shortcuts', click: () => sendShortcut('help') },
        { label: 'About cinnamon', click: () => sendShortcut('about') }
      ]
    }
  ];
  if (process.platform === 'darwin') template.unshift({ role: 'app', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip('cinnamon — computer task manager');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open cinnamon', click: () => { if (mainWindow) mainWindow.show(); else createWindow(); } },
      { label: 'Refresh Now', click: () => sample() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ]));
    tray.on('double-click', () => { if (mainWindow) mainWindow.show(); else createWindow(); });
  } catch { tray = null; }
}

// ------------------------------------------------------------------ sampling

async function sample() {
  if (sampling || !store) return null;
  sampling = true;
  try {
    const settings = store.getSettings();
    const next = await system.systemSnapshot({ previous: snapshot });
    const processes = await system.listProcesses();
    next.processCount = processes.length;
    next.topProcesses = processes.slice(0, 12);
    const samplePoint = system.sampleFrom(next, processes);
    history = system.pushHistory(history, samplePoint);
    if (history.limit !== settings.historyLimit) {
      history.limit = settings.historyLimit;
      while (history.samples.length > history.limit) history.samples.shift();
    }
    snapshots.push(next);
    while (snapshots.length > Math.min(240, settings.historyLimit)) snapshots.shift();

    analysis = ai.enrich(ai.analyze(next, processes, history), next);
    const evaluated = processesLib.evaluateRules(store.listRules({ enabledOnly: true }), next, processes, { now: next.timestamp });
    if (settings.alertsEnabled && evaluated.alerts.length) store.recordAlerts(evaluated.alerts, evaluated.rules);
    else store.recordAlerts([], evaluated.rules);
    alerts = store.listAlerts(50);

    snapshot = next;
    processList = processes;
    emitUpdate();
    return { snapshot, processes, analysis };
  } catch {
    return null;
  } finally {
    sampling = false;
  }
}

function restartTimer() {
  if (sampleTimer) clearInterval(sampleTimer);
  const interval = store ? store.getSettings().sampleIntervalMs : 2000;
  sampleTimer = setInterval(() => { sample(); }, interval);
}

function applyTheme(settings) {
  if (!nativeTheme || !nativeTheme.themeSource) return;
  nativeTheme.themeSource = settings.theme === 'dark' ? 'dark' : settings.theme === 'light' ? 'light' : 'system';
}

function bundledChangelog() {
  const candidates = [
    path.join(__dirname, 'ui', 'CHANGELOG.md'),
    path.join(__dirname, 'CHANGELOG.md')
  ];
  for (const file of candidates) {
    try {
      const markdown = fs.readFileSync(file, 'utf8');
      const releases = changelog.parseChangelog(markdown);
      return { markdown, releases, intro: releases.intro || '', source: 'bundled' };
    } catch { /* try next location */ }
  }
  return { markdown: '# Changelog\n', releases: [], intro: '', source: 'bundled' };
}

/** Shared IPC path for every named process operation. */
async function runOperation(operation, payload = {}) {
  const target = processList.find((proc) => proc.pid === Number(payload.pid));
  const result = await actions.operate(operation, payload.pid, {
    niceness: payload.niceness,
    target: target || { pid: Number(payload.pid) }
  });
  store.logAction({ ...result, action: result.operation || result.action, name: target ? target.name : '' });
  return result;
}

function currentReport(options = {}) {
  let processes = processList;
  if (options && Array.isArray(options.pids)) {
    const order = options.pids.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
    const byPid = new Map(processList.map((proc) => [Number(proc.pid), proc]));
    processes = order.map((pid) => byPid.get(pid)).filter(Boolean);
  }
  return reports.buildProcessReport({
    snapshot: snapshot || {},
    processes,
    findings: analysis && analysis.findings ? analysis.findings : [],
    pinned: store.listPinned(),
    preserveOrder: Boolean(options && options.preserveOrder)
  });
}

// ---------------------------------------------------------------------- IPC

function handlers() {
  const map = {
    [INVOKE.SYSTEM_SNAPSHOT]: () => snapshot,
    [INVOKE.SYSTEM_PROCESSES]: () => processList,
    [INVOKE.SYSTEM_HISTORY]: () => history,
    [INVOKE.SYSTEM_REFRESH]: async () => { await sample(); return { snapshot, processes: processList, analysis }; },
    [INVOKE.SYSTEM_INFO]: () => ({
      platform: process.platform,
      arch: process.arch,
      hostname: require('os').hostname(),
      cores: require('os').cpus().length,
      totalMemory: require('os').totalmem(),
      node: process.version,
      electron: process.versions.electron || null
    }),

    [INVOKE.ACTIONS_SIGNAL]: (payload) => {
      const proc = processList.find((candidate) => candidate.pid === Number(payload.pid));
      const result = actions.signal(payload.pid, payload.signal);
      store.logAction({ ...result, name: proc ? proc.name : '' });
      return result;
    },
    [INVOKE.ACTIONS_PRIORITY]: async (payload) => {
      const proc = processList.find((candidate) => candidate.pid === Number(payload.pid));
      const result = await actions.setPriority(payload.pid, payload.niceness);
      store.logAction({ ...result, name: proc ? proc.name : '' });
      return result;
    },
    [INVOKE.ACTIONS_DETAILS]: (payload) => actions.details(payload.pid),

    [INVOKE.ACTIONS_SET_PRIORITY]: (payload) => runOperation('setPriority', payload),
    [INVOKE.ACTIONS_PAUSE]: (payload) => runOperation('pause', payload),
    [INVOKE.ACTIONS_RESUME]: (payload) => runOperation('resume', payload),
    [INVOKE.ACTIONS_INTERRUPT]: (payload) => runOperation('interrupt', payload),
    [INVOKE.ACTIONS_TERMINATE]: (payload) => runOperation('terminate', payload),
    [INVOKE.ACTIONS_KILL]: (payload) => runOperation('kill', payload),
    [INVOKE.ACTIONS_CONFIRMATION]: (payload) => actions.confirmationFor(
      payload && payload.operation,
      payload && payload.target ? payload.target : {}
    ),
    [INVOKE.ACTIONS_OPEN_FILES]: (payload) => actions.openFiles(payload && payload.pid),
    [INVOKE.ACTIONS_TREE]: () => actions.processTree(processList),

    [INVOKE.REPORTS_EXPORT]: (payload = {}) => {
      const format = String(payload.format || 'json').toLowerCase();
      if (!reports.FORMATS.includes(format)) throw new Error(`Report format must be one of ${reports.FORMATS.join(', ')}`);
      return reports.toFormat(currentReport(payload), format);
    },
    [INVOKE.PINS_LIST]: () => store.listPinned(),
    [INVOKE.PINS_ADD]: (payload) => reports.pinProcess(store, payload && payload.pid, payload && payload.meta ? payload.meta : {}),
    [INVOKE.PINS_REMOVE]: (payload) => reports.unpinProcess(store, payload && payload.pid),

    [INVOKE.AI_ANALYZE]: () => analysis || ai.enrich(ai.analyze(snapshot || {}, processList, history), snapshot || {}),
    [INVOKE.AI_SUMMARY]: () => (analysis ? analysis.summary : ai.systemHealthSummary(ai.analyze(snapshot || {}, processList, history), snapshot || {})),
    [INVOKE.AI_COMPARE]: (payload = {}) => {
      const before = snapshots.find((item) => item.timestamp === payload.before) || snapshots[0] || {};
      const after = snapshots.find((item) => item.timestamp === payload.after) || snapshots[snapshots.length - 1] || {};
      return ai.compareSnapshots(before, after, { now: new Date().toISOString() });
    },
    [INVOKE.AI_ASK]: async (payload = {}) => {
      const settings = store.getSettings();
      const local = analysis || ai.analyze(snapshot || {}, processList, history);
      const result = await cloud.withFallback({
        config: settings.byok,
        prompt: payload.prompt || cloud.diagnosticPrompt(snapshot || {}, local, processList),
        system: 'You are a system diagnostics assistant. Return strict JSON only, shaped as {"findings":[{"severity":"low|medium|high|critical","title":"...","explanation":"..."}]}.',
        validator: cloud.findingsValidator,
        local
      });
      return { ...result, local };
    },

    [INVOKE.ANALYTICS_ALL]: () => analytics.all(history, processList),

    [INVOKE.RULES_LIST]: (payload) => store.listRules(payload || {}),
    [INVOKE.RULES_ADD]: (payload) => store.addRule(payload),
    [INVOKE.RULES_UPDATE]: (payload) => store.updateRule(payload.id, payload.patch || {}),
    [INVOKE.RULES_DELETE]: (payload) => store.deleteRule(payload.id),
    [INVOKE.RULES_EVALUATE]: () => {
      const evaluated = processesLib.evaluateRules(store.listRules(), snapshot || {}, processList, { now: new Date().toISOString() });
      if (evaluated.alerts.length) store.recordAlerts(evaluated.alerts, evaluated.rules);
      alerts = store.listAlerts(50);
      emitUpdate();
      return { alerts: evaluated.alerts, evaluated: evaluated.evaluated, total: store.listAlerts().length };
    },

    [INVOKE.ALERTS_LIST]: (payload) => store.listAlerts(payload || {}),
    [INVOKE.ALERTS_ACK]: (payload) => store.acknowledgeAlert(payload.id),
    [INVOKE.ALERTS_CLEAR]: () => store.clearAlerts(),
    [INVOKE.ACTIONS_LIST]: (payload) => store.listActions(payload || {}),
    [INVOKE.ACTIONS_CLEAR]: () => store.clearActions(),

    [INVOKE.SETTINGS_GET]: () => store.getSettings(),
    [INVOKE.SETTINGS_UPDATE]: (payload) => {
      const next = store.updateSettings((payload && payload.patch) || {});
      applyTheme(next);
      restartTimer();
      return next;
    },

    [INVOKE.DATA_EXPORT]: () => store.exportJSON(),
    [INVOKE.DATA_IMPORT]: async (payload) => {
      const result = store.importJSON(payload && payload.json, { mode: payload && payload.mode });
      applyTheme(store.getSettings());
      restartTimer();
      await sample();
      return result;
    },
    [INVOKE.DATA_RESET]: async (payload) => {
      const result = store.reset({ seed: !payload || payload.seed !== false });
      applyTheme(result.settings);
      restartTimer();
      await sample();
      return result;
    },

    [INVOKE.APP_INFO]: () => ({ name: 'cinnamon', version: '1.0.0', platform: process.platform, dataPath: store.filePath || null }),
    [INVOKE.CHANGELOG_BUNDLED]: () => bundledChangelog(),
    [INVOKE.CHANGELOG_GITHUB]: () => github.fetchGithubReleases()
  };

  for (const channel of Object.keys(map)) {
    if (!ALLOWED_INVOKE.includes(channel)) throw new Error(`Handler uses unlisted channel: ${channel}`);
    ipcMain.handle(channel, async (_event, payload) => map[channel](payload === null ? {} : payload));
  }
}

// ----------------------------------------------------------------- lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else createWindow();
  });

  app.whenReady().then(async () => {
    store = new Store({ filePath: path.join(app.getPath('userData'), 'cinnamon-data.json') });
    applyTheme(store.getSettings());
    handlers();
    createWindow();
    buildMenu();
    createTray();

    for (const [accelerator, action] of [
      ['CommandOrControl+N', 'palette'],
      ['CommandOrControl+,', 'settings'],
      ['CommandOrControl+Shift+T', 'toggle-theme'],
      ['CommandOrControl+Shift+R', 'refresh']
    ]) {
      try { globalShortcut.register(accelerator, () => sendShortcut(action)); } catch { /* unavailable */ }
    }

    await sample();
    restartTimer();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

app.on('before-quit', () => {
  if (sampleTimer) clearInterval(sampleTimer);
  try { globalShortcut.unregisterAll(); } catch { /* no shortcuts */ }
  if (tray) { try { tray.destroy(); } catch { /* ignore */ } }
  if (store) { try { store.flush(); } catch { /* best effort */ } }
});
