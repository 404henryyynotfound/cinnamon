'use strict';

/** The only bridge to Electron. Every channel is checked against an allowlist. */

const { contextBridge, ipcRenderer } = require('electron');
const { INVOKE, EVENTS, ALLOWED_INVOKE, ALLOWED_EVENTS } = require('./lib/channels.js');

function invoke(channel, payload) {
  if (!ALLOWED_INVOKE.includes(channel)) return Promise.reject(new Error(`Blocked IPC channel: ${channel}`));
  return ipcRenderer.invoke(channel, payload === undefined ? null : payload);
}

function listen(channel, handler) {
  if (!ALLOWED_EVENTS.includes(channel) || typeof handler !== 'function') return () => {};
  const listener = (_event, value) => handler(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = Object.freeze({
  system: Object.freeze({
    snapshot: () => invoke(INVOKE.SYSTEM_SNAPSHOT),
    processes: () => invoke(INVOKE.SYSTEM_PROCESSES),
    history: () => invoke(INVOKE.SYSTEM_HISTORY),
    refresh: () => invoke(INVOKE.SYSTEM_REFRESH),
    info: () => invoke(INVOKE.SYSTEM_INFO)
  }),
  actions: Object.freeze({
    signal: (pid, signal) => invoke(INVOKE.ACTIONS_SIGNAL, { pid, signal }),
    priority: (pid, niceness) => invoke(INVOKE.ACTIONS_PRIORITY, { pid, niceness }),
    details: (pid) => invoke(INVOKE.ACTIONS_DETAILS, { pid })
  }),
  ai: Object.freeze({
    analyze: (payload = {}) => invoke(INVOKE.AI_ANALYZE, payload),
    summary: (payload = {}) => invoke(INVOKE.AI_SUMMARY, payload),
    compare: (payload = {}) => invoke(INVOKE.AI_COMPARE, payload),
    ask: (payload = {}) => invoke(INVOKE.AI_ASK, payload)
  }),
  analytics: Object.freeze({
    all: () => invoke(INVOKE.ANALYTICS_ALL)
  }),
  rules: Object.freeze({
    list: (payload = {}) => invoke(INVOKE.RULES_LIST, payload),
    add: (input) => invoke(INVOKE.RULES_ADD, input),
    update: (id, patch) => invoke(INVOKE.RULES_UPDATE, { id, patch }),
    remove: (id) => invoke(INVOKE.RULES_DELETE, { id }),
    evaluate: () => invoke(INVOKE.RULES_EVALUATE)
  }),
  alerts: Object.freeze({
    list: (limit = 100) => invoke(INVOKE.ALERTS_LIST, { limit }),
    ack: (id) => invoke(INVOKE.ALERTS_ACK, { id }),
    clear: () => invoke(INVOKE.ALERTS_CLEAR)
  }),
  log: Object.freeze({
    actions: (limit = 100) => invoke(INVOKE.ACTIONS_LIST, { limit }),
    clear: () => invoke(INVOKE.ACTIONS_CLEAR)
  }),
  settings: Object.freeze({
    get: () => invoke(INVOKE.SETTINGS_GET),
    update: (patch) => invoke(INVOKE.SETTINGS_UPDATE, { patch })
  }),
  data: Object.freeze({
    export: () => invoke(INVOKE.DATA_EXPORT),
    import: (json, mode = 'replace') => invoke(INVOKE.DATA_IMPORT, { json, mode }),
    reset: (seed = true) => invoke(INVOKE.DATA_RESET, { seed })
  }),
  app: Object.freeze({
    info: () => invoke(INVOKE.APP_INFO)
  }),
  changelog: Object.freeze({
    bundled: () => invoke(INVOKE.CHANGELOG_BUNDLED),
    github: () => invoke(INVOKE.CHANGELOG_GITHUB)
  }),
  onSystemUpdate: (handler) => listen(EVENTS.SYSTEM_UPDATE, handler),
  onShortcut: (handler) => listen(EVENTS.SHORTCUT, handler),
  platform: process.platform,
  isElectron: true
});

contextBridge.exposeInMainWorld('cinnamon', api);
