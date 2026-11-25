'use strict';

/**
 * Public GitHub release fetcher. No authentication is required or sent.
 * Failures are returned as data so the UI can show a clear offline fallback.
 */

const { fromGithubRelease } = require('./changelog.js');

const RELEASES_URL = 'https://api.github.com/repos/404henryyynotfound/cinnamon/releases';
const DEFAULT_TIMEOUT_MS = 10000;

function failure(code, message) {
  return { releases: [], error: { code, message }, source: 'github', fetchedAt: new Date().toISOString(), url: RELEASES_URL };
}

async function fetchGithubReleases(options = {}) {
  const url = options.url || RELEASES_URL;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return failure('NO_FETCH', 'This Electron build has no global fetch.');
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const relay = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', relay, { once: true });
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'user-agent': 'cinnamon-gui/1.0.0 (local-first system monitor)',
        accept: 'application/vnd.github+json'
      },
      signal: controller.signal
    });
  } catch (error) {
    const aborted = error && (error.name === 'AbortError' || controller.signal.aborted);
    return failure(aborted ? 'TIMEOUT' : 'NETWORK', aborted
      ? `GitHub did not answer within ${timeoutMs / 1000}s. Showing bundled release notes.`
      : 'Could not reach GitHub. Showing bundled release notes.');
  } finally {
    clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener('abort', relay);
  }

  if (!response || !response.ok) {
    const status = response ? response.status : 'unknown';
    return failure(`HTTP_${status}`, `GitHub returned ${status}. Showing bundled release notes.`);
  }

  let payload;
  try { payload = await response.json(); } catch { return failure('BAD_JSON', 'GitHub returned invalid JSON.'); }
  if (!Array.isArray(payload)) return failure('BAD_RESPONSE', 'GitHub response was not a release list.');

  const releases = payload.map(fromGithubRelease).filter(Boolean);
  return { releases, error: null, source: 'github', fetchedAt: new Date().toISOString(), url };
}

module.exports = { RELEASES_URL, DEFAULT_TIMEOUT_MS, fetchGithubReleases };
