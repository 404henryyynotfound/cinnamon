'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const validate = require('../lib/validate.js');

test('validatePid accepts only positive integers', () => {
  assert.equal(validate.validatePid('42'), 42);
  for (const pid of [0, -1, 1.5, 'abc', '', null, 0x80000000]) {
    assert.throws(() => validate.validatePid(pid), /positive integer/);
  }
});

test('parsePids accepts comma or whitespace separated PIDs', () => {
  assert.deepEqual(validate.parsePids('10, 20 30'), [10, 20, 30]);
  assert.throws(() => validate.parsePids('10, oops'), /positive integer/);
  assert.throws(() => validate.parsePids(''), /required/);
});

test('validateSignal defaults safely and rejects unknown signals', () => {
  assert.equal(validate.validateSignal(undefined), 'SIGTERM');
  assert.equal(validate.validateSignal('sigkill'), 'SIGKILL');
  assert.throws(() => validate.validateSignal('rm -rf /'), /signal must be one of/);
  assert.throws(() => validate.validateSignal('SIGSPAM'), /signal must be one of/);
});

test('validatePriority enforces the niceness range', () => {
  assert.equal(validate.validatePriority('-20'), -20);
  assert.equal(validate.validatePriority(19), 19);
  for (const priority of [-21, 20, 1.5, 'high']) {
    assert.throws(() => validate.validatePriority(priority), /priority must be an integer/);
  }
});

test('numeric and format options have bounded defaults', () => {
  assert.equal(validate.validateLimit(undefined, 20), 20);
  assert.equal(validate.validateLimit('5'), 5);
  assert.throws(() => validate.validateLimit(0), /limit must be/);
  assert.equal(validate.validateCount('2'), 2);
  assert.throws(() => validate.validateCount(61), /limit must be/);
  assert.equal(validate.validateSeconds('0.5'), 0.5);
  assert.throws(() => validate.validateSeconds(0), /seconds must be/);
  assert.equal(validate.validateFormat(undefined, ['json', 'csv'], 'json'), 'json');
  assert.throws(() => validate.validateFormat('xml', ['json', 'csv']), /format must be/);
});

test('requireYes refuses to confirm implicit changes', () => {
  assert.doesNotThrow(() => validate.requireYes({ yes: true }));
  assert.throws(() => validate.requireYes({}), (error) => error.code === 'CONFIRMATION_REQUIRED');
});
