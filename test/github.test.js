'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const github = require('../lib/github.js');

test('public releases URL and timeout are fixed', () => {
  assert.equal(github.RELEASES_URL, 'https://api.github.com/repos/404henryyynotfound/cinnamon/releases');
  assert.equal(github.DEFAULT_TIMEOUT_MS, 10000);
});

test('fetchGithubReleases requests public JSON without authentication', async () => {
  let request;
  const fetchImpl = async (url, init) => {
    request = { url, init };
    return {
      ok: true,
      status: 200,
      json: async () => [{
        tag_name: 'v1.0.0',
        published_at: '2026-11-25T10:00:00Z',
        html_url: 'https://github.com/404henryyynotfound/cinnamon/releases/tag/v1.0.0',
        body: '### Added\n- Live process table'
      }]
    };
  };
  const result = await github.fetchGithubReleases({ fetchImpl, timeoutMs: 250 });
  assert.equal(result.error, null);
  assert.equal(result.source, 'github');
  assert.equal(result.releases.length, 1);
  assert.equal(result.releases[0].version, '1.0.0');
  assert.ok(result.fetchedAt);
  assert.equal(request.url, github.RELEASES_URL);
  assert.equal(request.init.method, 'GET');
  assert.match(request.init.headers['user-agent'], /cinnamon-gui/);
  assert.match(request.init.headers.accept, /application\/vnd.github\+json/);
  assert.equal(request.init.headers.authorization, undefined);
  assert.equal(request.init.signal.aborted, false);
});

test('fetchGithubReleases returns graceful errors as data', async () => {
  const network = await github.fetchGithubReleases({ fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(network.releases.length, 0);
  assert.equal(network.error.code, 'NETWORK');
  assert.match(network.error.message, /bundled release notes/);

  const http = await github.fetchGithubReleases({ fetchImpl: async () => ({ ok: false, status: 403 }) });
  assert.equal(http.error.code, 'HTTP_403');

  const badJSON = await github.fetchGithubReleases({ fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('bad'); } }) });
  assert.equal(badJSON.error.code, 'BAD_JSON');

  const badShape = await github.fetchGithubReleases({ fetchImpl: async () => ({ ok: true, json: async () => ({ message: 'rate limited' }) }) });
  assert.equal(badShape.error.code, 'BAD_RESPONSE');

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = undefined;
    const noFetch = await github.fetchGithubReleases();
    assert.equal(noFetch.error.code, 'NO_FETCH');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchGithubReleases reports timeouts and honors external aborts', async () => {
  const timeout = await github.fetchGithubReleases({
    timeoutMs: 5,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      if (init.signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      init.signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); });
    })
  });
  assert.equal(timeout.error.code, 'TIMEOUT');

  const controller = new AbortController();
  controller.abort();
  const aborted = await github.fetchGithubReleases({
    signal: controller.signal,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      if (init.signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      init.signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); });
    })
  });
  assert.equal(aborted.error.code, 'TIMEOUT');
});
