'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { INVOKE, EVENTS, ALLOWED_INVOKE, ALLOWED_EVENTS } = require('../lib/channels.js');

test('every process, report and pin channel is allow-listed exactly once', () => {
  const keys = [
    'ACTIONS_SET_PRIORITY', 'ACTIONS_PAUSE', 'ACTIONS_RESUME', 'ACTIONS_INTERRUPT',
    'ACTIONS_TERMINATE', 'ACTIONS_KILL', 'ACTIONS_CONFIRMATION', 'ACTIONS_OPEN_FILES',
    'ACTIONS_TREE', 'REPORTS_EXPORT', 'PINS_LIST', 'PINS_ADD', 'PINS_REMOVE'
  ];
  for (const key of keys) {
    assert.equal(typeof INVOKE[key], 'string', `${key} must be defined`);
    assert.equal(ALLOWED_INVOKE.filter((channel) => channel === INVOKE[key]).length, 1);
  }
  assert.equal(new Set(ALLOWED_INVOKE).size, ALLOWED_INVOKE.length);
  assert.equal(new Set(ALLOWED_EVENTS).size, ALLOWED_EVENTS.length);
  assert.deepEqual(Object.values(EVENTS), ALLOWED_EVENTS);
});
