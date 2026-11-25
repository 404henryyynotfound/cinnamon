'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cloud = require('../lib/cloud.js');

function response(payload, ok = true, status = 200) {
  return { ok, status, json: async () => payload };
}

const CONFIG = { baseUrl: 'https://example.test/v1/', apiKey: 'sk-secret-value', model: 'test-model' };

test('config helpers normalize URLs and never expose full keys', () => {
  assert.deepEqual(cloud.normalizeConfig(CONFIG), { baseUrl: 'https://example.test/v1', apiKey: 'sk-secret-value', model: 'test-model' });
  assert.equal(cloud.isConfigured(CONFIG), true);
  assert.equal(cloud.isConfigured({ apiKey: '' }), false);
  assert.equal(cloud.maskKey(''), '');
  assert.equal(cloud.maskKey('sk-secret-value'), 'sk-••••alue');
  assert.equal(cloud.maskKey('short'), '•••••');
});

test('parseStrictJSON strips fences and reports bad JSON', () => {
  assert.deepEqual(cloud.parseStrictJSON('```json\n{"ok":true}\n```'), { ok: true });
  assert.deepEqual(cloud.parseStrictJSON(' {"ok":1} '), { ok: 1 });
  assert.throws(() => cloud.parseStrictJSON('not json'), /strict JSON/);
  assert.throws(() => cloud.parseStrictJSON(''), /empty response/);
});

test('findingsValidator requires a findings array', () => {
  assert.equal(cloud.findingsValidator({ findings: [] }).ok, true);
  assert.equal(cloud.findingsValidator({ nope: 1 }).ok, false);
  assert.equal(cloud.objectValidator([]).ok, false);
});

test('chatJSON sends a strict JSON request to the configured endpoint', async () => {
  let request;
  const fetchImpl = async (url, init) => {
    request = { url, init };
    return response({ choices: [{ message: { content: '```json\n{"findings":[{"title":"CPU hot"}]}\n```' } }] });
  };
  const result = await cloud.chatJSON({ config: CONFIG, prompt: 'check the machine', fetchImpl, validator: cloud.findingsValidator, timeoutMs: 500 });
  assert.deepEqual(result.findings, [{ title: 'CPU hot' }]);
  assert.equal(request.url, 'https://example.test/v1/chat/completions');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers.authorization, 'Bearer sk-secret-value');
  assert.equal(request.init.headers['content-type'], 'application/json');
  const body = JSON.parse(request.init.body);
  assert.equal(body.model, 'test-model');
  assert.equal(body.response_format.type, 'json_object');
  assert.equal(body.messages[1].content, 'check the machine');
});

test('chatJSON rejects missing keys, invalid URLs, HTTP errors and invalid shapes', async () => {
  await assert.rejects(() => cloud.chatJSON({ config: { apiKey: '' }, fetchImpl: async () => response({}) }), /Add an API key/);
  await assert.rejects(() => cloud.chatJSON({ config: { apiKey: 'k', baseUrl: 'ftp://bad' }, fetchImpl: async () => response({}) }), /http or https/);
  await assert.rejects(() => cloud.chatJSON({ config: CONFIG, fetchImpl: async () => response({}, false, 401) }), (error) => error.code === 'HTTP_401' && /API key/.test(error.message));
  await assert.rejects(() => cloud.chatJSON({ config: CONFIG, fetchImpl: async () => response({ choices: [{ message: { content: '{"wrong":1}' } }] }), validator: cloud.findingsValidator }), (error) => error.code === 'INVALID_RESULT');
  await assert.rejects(() => cloud.chatJSON({ config: CONFIG, fetchImpl: async () => { throw new Error('offline'); } }), (error) => error.code === 'NETWORK');
});

test('withFallback returns cloud data, then gracefully uses local data', async () => {
  const good = await cloud.withFallback({
    config: CONFIG,
    fetchImpl: async () => response({ choices: [{ message: { content: '{"findings":[]}' } }] }),
    validator: cloud.findingsValidator,
    local: { findings: ['local'] }
  });
  assert.equal(good.source, 'cloud');
  assert.deepEqual(good.data, { findings: [] });

  const fallback = await cloud.withFallback({
    config: CONFIG,
    fetchImpl: async () => response({}, false, 500),
    validator: cloud.findingsValidator,
    local: { findings: ['local'] }
  });
  assert.equal(fallback.source, 'local');
  assert.deepEqual(fallback.data, { findings: ['local'] });
  assert.equal(fallback.code, 'HTTP_500');
  assert.doesNotThrow(() => JSON.stringify(fallback));
  assert.equal(JSON.stringify(fallback).includes('sk-secret-value'), false);
});

test('diagnosticPrompt summarizes only supplied local evidence', () => {
  const prompt = cloud.diagnosticPrompt(
    { platform: 'linux', arch: 'x64', cpu: { percent: 80, load: [2, 1, 1] }, disks: [{ mount: '/' }] },
    { healthScore: 55, status: 'warning', findings: [{ title: 'CPU hot', evidence: 'PID 1' }] },
    [{ pid: 1, name: 'worker', cpu: 90 }]
  );
  assert.match(prompt, /strict JSON/);
  assert.match(prompt, /CPU hot/);
  assert.match(prompt, /worker/);
  assert.match(prompt, /health 55\/100/);
});
