'use strict';

/** Single source of truth for allow-listed IPC channels. */

const INVOKE = Object.freeze({
  SYSTEM_SNAPSHOT: 'system:snapshot',
  SYSTEM_PROCESSES: 'system:processes',
  SYSTEM_HISTORY: 'system:history',
  SYSTEM_REFRESH: 'system:refresh',
  SYSTEM_INFO: 'system:info',

  ACTIONS_SIGNAL: 'actions:signal',
  ACTIONS_PRIORITY: 'actions:priority',
  ACTIONS_SET_PRIORITY: 'actions:set-priority',
  ACTIONS_PAUSE: 'actions:pause',
  ACTIONS_RESUME: 'actions:resume',
  ACTIONS_INTERRUPT: 'actions:interrupt',
  ACTIONS_TERMINATE: 'actions:terminate',
  ACTIONS_KILL: 'actions:kill',
  ACTIONS_CONFIRMATION: 'actions:confirmation',
  ACTIONS_DETAILS: 'actions:details',
  ACTIONS_OPEN_FILES: 'actions:open-files',
  ACTIONS_TREE: 'actions:tree',

  REPORTS_EXPORT: 'reports:export',
  PINS_LIST: 'pins:list',
  PINS_ADD: 'pins:add',
  PINS_REMOVE: 'pins:remove',

  AI_ANALYZE: 'ai:analyze',
  AI_SUMMARY: 'ai:summary',
  AI_COMPARE: 'ai:compare',
  AI_ASK: 'ai:ask',

  ANALYTICS_ALL: 'analytics:all',

  RULES_LIST: 'rules:list',
  RULES_ADD: 'rules:add',
  RULES_UPDATE: 'rules:update',
  RULES_DELETE: 'rules:delete',
  RULES_EVALUATE: 'rules:evaluate',

  ALERTS_LIST: 'alerts:list',
  ALERTS_ACK: 'alerts:ack',
  ALERTS_CLEAR: 'alerts:clear',

  ACTIONS_LIST: 'log:actions',
  ACTIONS_CLEAR: 'log:clear',

  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',

  DATA_EXPORT: 'data:export',
  DATA_IMPORT: 'data:import',
  DATA_RESET: 'data:reset',

  APP_INFO: 'app:info',

  CHANGELOG_BUNDLED: 'changelog:bundled',
  CHANGELOG_GITHUB: 'changelog:github'
});

const EVENTS = Object.freeze({
  SYSTEM_UPDATE: 'system:update',
  SHORTCUT: 'shortcut:action'
});

const ALLOWED_INVOKE = Object.freeze(Object.values(INVOKE));
const ALLOWED_EVENTS = Object.freeze(Object.values(EVENTS));

module.exports = { INVOKE, EVENTS, ALLOWED_INVOKE, ALLOWED_EVENTS };
