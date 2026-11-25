'use strict';

/**
 * Optional bring-your-own-key AI for second opinions on system diagnostics.
 * The key is never logged. Any failure falls back to the local diagnosis.
 */

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 10000;

class CloudError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CloudError';
    this.code = code;
  }
}

function normalizeConfig(config = {}) {
  const baseUrl = String(config.baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  return {
    baseUrl,
    apiKey: String(config.apiKey || '').trim(),
    model: String(config.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL
  };
}

function isConfigured(config) {
  return Boolean(normalizeConfig(config).apiKey);
}

function maskKey(key) {
  const value = String(key || '');
  if (!value) return '';
  if (value.length <= 8) return '•'.repeat(value.length);
  return `${value.slice(0, 3)}••••${value.slice(-4)}`;
}

function extractContent(payload) {
  if (!payload || typeof payload !== 'object') throw new CloudError('BAD_RESPONSE', 'The provider returned an unexpected payload.');
  const message = payload.choices && payload.choices[0] && payload.choices[0].message;
  if (!message) throw new CloudError('BAD_RESPONSE', 'The provider response contained no choices.');
  let content = message.content;
  if (Array.isArray(content)) content = content.map((part) => (part && typeof part === 'object' ? part.text || '' : part)).join('');
  if (typeof content !== 'string') throw new CloudError('BAD_RESPONSE', 'The provider message was not text.');
  return content;
}

function parseStrictJSON(content) {
  let text = String(content || '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(text);
  if (fence) text = fence[1].trim();
  if (!text) throw new CloudError('BAD_JSON', 'The provider returned an empty response.');
  try { return JSON.parse(text); } catch { throw new CloudError('BAD_JSON', 'The provider did not return strict JSON.'); }
}

function objectValidator(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'Expected a JSON object.' };
  return { ok: true, value };
}

function findingsValidator(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'Expected a JSON object.' };
  if (!Array.isArray(value.findings)) return { ok: false, error: 'Expected a "findings" array in the JSON response.' };
  return { ok: true, value };
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function chatJSON(options = {}) {
  const config = normalizeConfig(options.config);
  if (!config.apiKey) throw new CloudError('MISSING_API_KEY', 'Add an API key in Settings → AI to enable BYOK mode.');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new CloudError('NO_FETCH', 'This Node/Electron build has no global fetch.');

  const url = `${config.baseUrl}/chat/completions`;
  let protocol;
  try { protocol = new URL(url).protocol; } catch { throw new CloudError('BAD_BASE_URL', 'The BYOK base URL is not valid.'); }
  if (protocol !== 'http:' && protocol !== 'https:') throw new CloudError('BAD_BASE_URL', 'The BYOK base URL must use http or https.');

  const system = options.system || 'You are a precise system diagnostic assistant. Respond with strict JSON only. No markdown, no prose, no code fences.';
  const timeoutMs = Math.max(1, positiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const relayAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', relayAbort, { once: true });
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: String(options.prompt || '') }
        ]
      }),
      signal: controller.signal
    });
  } catch (error) {
    const aborted = error && (error.name === 'AbortError' || controller.signal.aborted);
    throw new CloudError(
      aborted ? 'TIMEOUT' : 'NETWORK',
      aborted ? `The AI provider did not answer within ${timeoutMs / 1000}s.` : 'Could not reach the AI provider. Check the base URL and your connection.'
    );
  } finally {
    clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener('abort', relayAbort);
  }

  if (!response || !response.ok) {
    const status = response ? response.status : 'unknown';
    const hint = status === 401 || status === 403 ? ' Check the API key.' : status === 404 ? ' Check the base URL and model.' : '';
    throw new CloudError(`HTTP_${status}`, `The AI provider returned ${status}.${hint}`);
  }

  let payload;
  try {
    payload = typeof response.json === 'function' ? await response.json() : parseStrictJSON(await response.text());
  } catch (error) {
    if (error instanceof CloudError) throw error;
    throw new CloudError('BAD_JSON', 'The provider response was not valid JSON.');
  }

  const parsed = parseStrictJSON(extractContent(payload));
  const validator = options.validator || objectValidator;
  const validated = validator(parsed);
  if (!validated || !validated.ok) {
    throw new CloudError('INVALID_RESULT', (validated && validated.error) || 'The AI result did not match the expected format.');
  }
  return validated.value !== undefined ? validated.value : parsed;
}

async function withFallback(options = {}) {
  try {
    const data = await chatJSON(options);
    return { source: 'cloud', data, error: null };
  } catch (error) {
    const cloudError = error instanceof CloudError;
    return {
      source: 'local',
      data: options.local !== undefined ? options.local : null,
      error: cloudError ? error.message : 'BYOK AI failed unexpectedly; using local diagnosis.',
      code: cloudError ? error.code : 'UNKNOWN'
    };
  }
}

/** Prompt describing the local diagnosis so the model can add a second opinion. */
function diagnosticPrompt(snapshot = {}, analysis = {}, processes = []) {
  const cpu = snapshot.cpu || {};
  const memory = snapshot.memory || {};
  const top = (Array.isArray(processes) ? processes : []).slice(0, 12).map((proc) => ({
    pid: proc.pid, name: proc.name, cpu: proc.cpu, memory: proc.memory, memoryBytes: proc.memoryBytes, state: proc.state
  }));
  return [
    'Review this local system diagnosis and return a second opinion as strict JSON.',
    'Shape: {"findings":[{"severity":"low|medium|high|critical","title":"short title","explanation":"one or two sentences"}]}.',
    'Only report actionable findings supported by the supplied metrics. Do not invent data.',
    `Machine: ${snapshot.platform || 'unknown'} ${snapshot.arch || ''}, ${cpu.cores || 0} cores, uptime ${snapshot.uptimeSeconds || 0}s`,
    `CPU ${cpu.percent || 0}% (load ${JSON.stringify(cpu.load || [])}), memory ${memory.percent || 0}%, disks ${JSON.stringify(snapshot.disks || [])}`,
    `Network ${JSON.stringify(snapshot.network && snapshot.network.rates || {})}`,
    `Local health ${analysis.healthScore || 0}/100 (${analysis.status || 'unknown'})`,
    `Local findings: ${JSON.stringify((analysis.findings || []).map((finding) => ({ severity: finding.severity, title: finding.title, evidence: finding.evidence })))}`,
    `Top processes: ${JSON.stringify(top)}`
  ].join('\n');
}

module.exports = {
  CloudError,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  normalizeConfig,
  isConfigured,
  maskKey,
  extractContent,
  parseStrictJSON,
  objectValidator,
  findingsValidator,
  chatJSON,
  withFallback,
  diagnosticPrompt
};
