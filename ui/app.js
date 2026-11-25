'use strict';

/**
 * cinnamon renderer — a local-first computer task manager.
 * No framework, no bundler, no external assets. Every read/write goes
 * through the allow-listed window.cinnamon bridge.
 */

(function () {
  const api = window.cinnamon;
  const viewRoot = document.getElementById('view');

  if (!api) {
    viewRoot.innerHTML = '<div class="empty">cinnamon must be opened in Electron so the safe IPC bridge is available.</div>';
    return;
  }

  const VIEWS = [
    { id: 'overview', label: 'Overview', icon: '◉', title: 'Overview', sub: 'A calm view of what your computer is doing.' },
    { id: 'processes', label: 'Processes', icon: '⟳', title: 'Processes', sub: 'Inspect processes and act safely with confirmation.' },
    { id: 'performance', label: 'Performance', icon: '◫', title: 'Performance', sub: 'Inline SVG charts from locally sampled history.' },
    { id: 'ai', label: 'AI Diagnostics', icon: '✦', title: 'AI Diagnostics', sub: 'Explainable local findings, with an optional BYOK second opinion.' },
    { id: 'watchers', label: 'Watchers', icon: '⚑', title: 'Watchers', sub: 'Thresholds, alerts and a record of every action.' },
    { id: 'changelog', label: 'Changelog', icon: '≡', title: 'Changelog', sub: 'Bundled release notes and public GitHub releases.' },
    { id: 'settings', label: 'Settings', icon: '⚙', title: 'Settings', sub: 'Make cinnamon fit the way you work.' }
  ];

  const state = {
    view: 'overview',
    snapshot: null,
    processes: [],
    history: { samples: [], limit: 600 },
    analysis: null,
    alerts: [],
    settings: {},
    info: null,
    analytics: null,
    rules: [],
    actionLog: [],
    aiAnswer: null,
    askPrompt: '',
    compare: null,
    compareBefore: '',
    compareAfter: '',
    processQuery: '',
    processSort: 'cpu',
    changelogTab: 'inapp',
    bundled: null,
    github: null,
    githubLoading: false,
    paletteQuery: '',
    paletteCommands: [],
    paletteIndex: 0,
    confirmAction: null,
    details: null
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function num(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function bytes(value) {
    const n = Math.max(0, num(value));
    if (n < 1024) return `${Math.round(n)} B`;
    if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
    if (n < 1024 ** 3) return `${Math.round(n / 1024 ** 2)} MB`;
    return `${Math.round(n / 1024 ** 3)} GB`;
  }

  function rate(value) {
    return `${bytes(value)}/s`;
  }

  function pct(value) {
    return `${num(value).toFixed(1)}%`;
  }

  function uptime(seconds) {
    const value = Math.max(0, num(seconds));
    const days = Math.floor(value / 86400);
    const hours = Math.floor((value % 86400) / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    if (days) return `${days}d ${hours}h`;
    if (hours) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  function time(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
  }

  function barClass(value) {
    return value >= 85 ? 'bad' : value >= 65 ? 'warn' : 'ok';
  }

  function toast(message, type = 'info') {
    const node = document.createElement('div');
    node.className = `toast toast-${esc(type)}`;
    node.textContent = String(message);
    document.getElementById('toast-root').appendChild(node);
    setTimeout(() => node.remove(), 4500);
  }

  async function call(promiseFactory, fallback) {
    try { return await promiseFactory(); } catch (error) {
      toast(error && error.message ? error.message : 'Something went wrong', 'error');
      return fallback;
    }
  }

  function applyTheme() {
    const theme = state.settings.theme || 'light';
    const dark = theme === 'dark' || (theme === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const label = $('#theme-label');
    if (label) label.textContent = dark ? 'Dark theme' : 'Light theme';
  }

  function updateLiveLabel() {
    const indicator = $('#live-indicator');
    const label = $('#live-label');
    if (!indicator || !label) return;
    const stamp = state.snapshot && state.snapshot.timestamp;
    indicator.classList.toggle('live', Boolean(stamp));
    label.textContent = stamp ? `Updated ${time(stamp)}` : 'Waiting for first sample…';
  }

  async function loadCore() {
    const [snapshot, processes, history, settings, info, rules, alerts, actionLog] = await Promise.all([
      call(() => api.system.snapshot(), null),
      call(() => api.system.processes(), []),
      call(() => api.system.history(), { samples: [] }),
      call(() => api.settings.get(), {}),
      call(() => api.system.info(), null),
      call(() => api.rules.list(), []),
      call(() => api.alerts.list(100), []),
      call(() => api.log.actions(100), [])
    ]);
    state.snapshot = snapshot || state.snapshot;
    state.processes = processes || [];
    state.history = history || { samples: [] };
    state.settings = settings || {};
    state.info = info;
    state.rules = rules || [];
    state.alerts = alerts || [];
    state.actionLog = actionLog || [];
    state.analysis = await call(() => api.ai.analyze(), null);
    state.analytics = await call(() => api.analytics.all(), null);
    applyTheme();
  }

  async function refreshAll() {
    await call(() => api.system.refresh(), null);
    await loadCore();
    render();
  }

  // ------------------------------------------------------------------ render

  function renderNav() {
    const badge = {
      processes: state.processes.length,
      watchers: state.alerts.filter((alert) => !alert.acknowledged).length,
      changelog: ''
    };
    const groups = [
      { label: 'Monitor', views: VIEWS.slice(0, 3) },
      { label: 'Intelligence', views: VIEWS.slice(3, 5) },
      { label: 'System', views: VIEWS.slice(5) }
    ];
    $('#nav').innerHTML = groups.map((group) => `
      <div class="nav-section">${esc(group.label)}</div>
      ${group.views.map((view) => `
        <button class="nav-item ${state.view === view.id ? 'active' : ''}" data-action="view" data-view="${esc(view.id)}">
          <span class="nav-icon">${view.icon}</span><span>${esc(view.label)}</span>
          ${badge[view.id] ? `<span class="nav-badge">${esc(badge[view.id])}</span>` : ''}
        </button>`).join('')}`).join('');
    updateLiveLabel();
  }

  function render() {
    const view = VIEWS.find((candidate) => candidate.id === state.view) || VIEWS[0];
    $('#view-title').textContent = view.title;
    $('#view-subtitle').textContent = view.sub;
    renderNav();
    const renderers = {
      overview: renderOverview,
      processes: renderProcesses,
      performance: renderPerformance,
      ai: renderAI,
      watchers: renderWatchers,
      changelog: renderChangelog,
      settings: renderSettings
    };
    viewRoot.innerHTML = (renderers[state.view] || renderOverview)();
  }

  function setView(id) {
    if (!VIEWS.some((view) => view.id === id)) return;
    state.view = id;
    viewRoot.scrollTop = 0;
    render();
    if (id === 'changelog') loadBundled();
    if (id === 'performance' || id === 'overview') refreshAnalytics();
  }

  async function refreshAnalytics() {
    state.analytics = await call(() => api.analytics.all(), state.analytics);
    if (state.view === 'performance' || state.view === 'overview') render();
  }

  // ---------------------------------------------------------------- overview

  function healthRing(score, status) {
    const value = num(score);
    const radius = 52;
    const circumference = 2 * Math.PI * radius;
    const length = value / 100 * circumference;
    const color = status === 'healthy' ? 'var(--green)' : status === 'warning' ? 'var(--amber)' : 'var(--red)';
    return `<div class="health-ring">
      <svg viewBox="0 0 128 128" style="width:128px;height:128px" role="img" aria-label="Health score ${esc(value)} out of 100">
        <circle cx="64" cy="64" r="${radius}" fill="none" stroke="var(--surface-3)" stroke-width="9"/>
        <circle cx="64" cy="64" r="${radius}" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round"
          stroke-dasharray="${length.toFixed(1)} ${(circumference - length).toFixed(1)}" transform="rotate(-90 64 64)"/>
      </svg>
      <strong>${esc(Math.round(value))}</strong><span>health score</span>
    </div>`;
  }

  function metricCard(label, value, detail, percent) {
    return `<div class="card stat-card">
      <div class="stat-value small">${esc(value)}</div>
      <div class="stat-label">${esc(label)}</div>
      ${percent === undefined ? `<div class="tiny muted" style="margin-top:6px">${esc(detail)}</div>` : `
        <div class="metric-bar"><span class="${barClass(percent)}" style="width:${Math.min(100, Math.max(0, percent))}%"></span></div>
        <div class="tiny muted" style="margin-top:6px">${esc(detail)}</div>`}
    </div>`;
  }

  function processRows(list, limit = 10) {
    const items = list.slice(0, limit);
    if (!items.length) return '<div class="empty">No processes sampled yet.</div>';
    return `<div class="table-wrap"><table class="table">
      <thead><tr><th>Process</th><th class="num">CPU</th><th class="num">Memory</th><th class="num">PID</th><th>State</th></tr></thead>
      <tbody>${items.map((proc) => `<tr>
        <td><span class="name">${esc(proc.name)}</span>${proc.command ? `<div class="cmd mono" title="${esc(proc.command)}">${esc(proc.command)}</div>` : ''}</td>
        <td class="num">${pct(proc.cpu)}</td>
        <td class="num">${bytes(proc.memoryBytes)}</td>
        <td class="num mono">${esc(proc.pid)}</td>
        <td><span class="chip chip-${String(proc.state || '').toUpperCase().startsWith('Z') ? 'warning' : 'low'}">${esc(proc.state)}</span></td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  }

  function findingList(findings, limit = 5) {
    const items = (findings || []).slice(0, limit);
    if (!items.length) return '<div class="empty">No significant issues detected.</div>';
    return items.map((finding) => `
      <div class="finding ${esc(finding.severity)}">
        <div class="spread"><span class="finding-title">${esc(finding.title)}</span><span class="chip chip-${esc(finding.severity)}">${esc(finding.severity)}</span></div>
        ${finding.evidence ? `<div class="finding-evidence">${esc(finding.evidence)}</div>` : ''}
        ${finding.explanation ? `<div class="finding-explain">${esc(finding.explanation)}</div>` : ''}
      </div>`).join('');
  }

  function renderOverview() {
    const snapshot = state.snapshot;
    const cpu = snapshot && snapshot.cpu || {};
    const memory = snapshot && snapshot.memory || {};
    const network = snapshot && snapshot.network || {};
    const disks = snapshot && snapshot.disks || [];
    const diskPercent = Math.max(0, ...disks.map((disk) => num(disk.usePercent)));
    const analysis = state.analysis || {};
    const alerts = state.alerts.filter((alert) => !alert.acknowledged).slice(0, 6);

    if (!snapshot) {
      return `<div class="empty"><p>No system sample yet.</p><button class="btn btn-primary" data-action="refresh">Refresh now</button></div>`;
    }

    return `
      <section class="hero">
        <div class="hero-date">${esc(time(snapshot.timestamp))} · live system sample</div>
        <div class="hero-message">${esc(analysis.summary || 'cinnamon is sampling this machine locally. Open AI Diagnostics for explainable findings.')}</div>
        <div class="hero-highlights">
          <span>${esc(snapshot.hostname || 'this machine')}</span>
          <span>${esc(snapshot.platform || 'unknown')} · ${esc(snapshot.arch || '')}</span>
          <span>${esc(cpu.cores || 0)} cores</span>
          <span>up ${esc(uptime(snapshot.uptimeSeconds))}</span>
        </div>
        <div class="hero-stats">
          <div class="stat"><div class="stat-value">${pct(cpu.percent)}</div><div class="stat-label">CPU</div></div>
          <div class="stat"><div class="stat-value">${pct(memory.percent)}</div><div class="stat-label">Memory</div></div>
          <div class="stat"><div class="stat-value">${pct(diskPercent)}</div><div class="stat-label">Disk</div></div>
          <div class="stat"><div class="stat-value small">${esc(rate(network.rxBytesPerSec))}</div><div class="stat-label">Download</div></div>
          <div class="stat"><div class="stat-value">${esc(state.processes.length)}</div><div class="stat-label">Processes</div></div>
        </div>
      </section>

      <div class="grid grid-4">
        ${metricCard('CPU load', pct(cpu.percent), `load ${esc((cpu.load || []).join(' · '))}`, cpu.percent)}
        ${metricCard('Memory', bytes(memory.usedBytes), `${esc(bytes(memory.freeBytes))} free of ${esc(bytes(memory.totalBytes))}`, memory.percent)}
        ${metricCard('Busiest disk', pct(diskPercent), disks.length ? esc(disks.slice().sort((a, b) => num(b.usePercent) - num(a.usePercent))[0].mount) : 'No disk data', diskPercent)}
        ${metricCard('Upload', rate(network.txBytesPerSec), network.supported ? `${esc(Object.keys(network.interfaces || {}).length)} interface(s)` : 'Network rates unavailable')}
      </div>

      <div class="grid grid-side">
        <div class="stack">
          <section class="card">
            <div class="card-head">
              <div><h2 class="card-title">Top processes</h2><p class="card-sub">Ranked by CPU from the latest local sample.</p></div>
              <button class="btn btn-small btn-subtle" data-action="view" data-view="processes">All processes →</button>
            </div>
            ${processRows(state.processes.slice().sort((a, b) => num(b.cpu) - num(a.cpu)))}
          </section>
          <section class="card">
            <div class="card-head"><div><h2 class="card-title">Disk usage</h2><p class="card-sub">Reported by df, refreshed with each sample.</p></div></div>
            ${disks.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Mount</th><th>Filesystem</th><th class="num">Used</th><th class="num">Available</th><th class="num">Use</th></tr></thead><tbody>
              ${disks.map((disk) => `<tr>
                <td class="name">${esc(disk.mount)}</td><td class="mono">${esc(disk.filesystem)}</td>
                <td class="num">${esc(bytes(disk.usedKB * 1024))}</td><td class="num">${esc(bytes(disk.availableKB * 1024))}</td>
                <td class="num"><div class="spread" style="justify-content:flex-end"><span class="progress"><span class="progress-bar" style="width:${Math.min(100, num(disk.usePercent))}%"></span></span><span>${pct(disk.usePercent)}</span></div></td>
              </tr>`).join('')}</tbody></table></div>` : '<div class="empty">No disk data available on this platform.</div>'}
          </section>
        </div>

        <div class="stack">
          <section class="card">
            <div class="card-head"><div><h2 class="card-title">System health</h2><p class="card-sub">Deterministic local score, no cloud required.</p></div>
              <span class="chip chip-${esc(analysis.status || 'healthy')}">${esc(analysis.status || 'unknown')}</span></div>
            <div class="row" style="gap:18px">
              ${healthRing(analysis.healthScore, analysis.status)}
              <div class="stack" style="gap:6px;flex:1">
                <div class="spread tiny"><span class="muted">Critical</span><strong>${esc((analysis.counts || {}).critical || 0)}</strong></div>
                <div class="spread tiny"><span class="muted">High</span><strong>${esc((analysis.counts || {}).high || 0)}</strong></div>
                <div class="spread tiny"><span class="muted">Medium</span><strong>${esc((analysis.counts || {}).medium || 0)}</strong></div>
                <div class="spread tiny"><span class="muted">Low</span><strong>${esc((analysis.counts || {}).low || 0)}</strong></div>
                <button class="btn btn-small btn-subtle" data-action="view" data-view="ai">Open diagnosis →</button>
              </div>
            </div>
          </section>
          <section class="card">
            <div class="card-head"><div><h2 class="card-title">Latest findings</h2><p class="card-sub">Evidence behind the health score.</p></div></div>
            ${findingList(analysis.findings, 4)}
          </section>
          <section class="card">
            <div class="card-head"><div><h2 class="card-title">Unacknowledged alerts</h2><p class="card-sub">From your watch rules.</p></div>
              <button class="btn btn-small btn-subtle" data-action="view" data-view="watchers">Watchers →</button></div>
            ${alerts.length ? alerts.map((alert) => `<div class="result-line">
              <div class="spread"><strong class="tiny">${esc(alert.message)}</strong><span class="chip chip-${esc(alert.severity)}">${esc(alert.severity)}</span></div>
              <div class="muted tiny">${esc(time(alert.timestamp))}</div>
            </div>`).join('') : '<div class="empty">No active alerts.</div>'}
          </section>
        </div>
      </div>`;
  }

  // --------------------------------------------------------------- processes

  function sortedProcesses() {
    const query = state.processQuery.trim().toLowerCase();
    const key = state.processSort;
    return state.processes.filter((proc) => !query || `${proc.name} ${proc.pid} ${proc.user} ${proc.command}`.toLowerCase().includes(query))
      .sort((a, b) => num(b[key]) - num(a[key]) || num(a.pid) - num(b.pid));
  }

  function processTableHTML() {
    const list = sortedProcesses();
    if (!list.length) return '<div class="empty">No processes match this filter.</div>';
    return `<div class="table-wrap"><table class="table">
      <thead><tr>
        <th>Process</th><th class="num">CPU</th><th class="num">Memory</th><th>User</th><th class="num">Uptime</th><th>State</th><th class="num">PID</th><th></th>
      </tr></thead>
      <tbody>${list.slice(0, 250).map((proc) => `<tr>
        <td><span class="name">${esc(proc.name)}</span>${proc.command ? `<div class="cmd mono" title="${esc(proc.command)}">${esc(proc.command)}</div>` : ''}</td>
        <td class="num">${pct(proc.cpu)}</td>
        <td class="num">${bytes(proc.memoryBytes)}<div class="muted tiny">${pct(proc.memory)}</div></td>
        <td class="tiny">${esc(proc.user || '—')}</td>
        <td class="num">${esc(uptime(proc.uptime))}</td>
        <td><span class="chip chip-${String(proc.state || '').toUpperCase().startsWith('Z') ? 'warning' : 'low'}">${esc(proc.state)}</span></td>
        <td class="num mono">${esc(proc.pid)}</td>
        <td><div class="row-actions">
          <button class="btn btn-small btn-subtle" data-action="proc-details" data-pid="${esc(proc.pid)}" title="Inspect details">Details</button>
          <button class="btn btn-small btn-subtle" data-action="proc-action" data-pid="${esc(proc.pid)}" data-signal="priority" data-nice="10" title="Lower priority">Nice +10</button>
          <button class="btn btn-small btn-subtle" data-action="proc-action" data-pid="${esc(proc.pid)}" data-signal="SIGTERM" title="Ask to stop">Stop</button>
          <button class="btn btn-small btn-danger" data-action="proc-action" data-pid="${esc(proc.pid)}" data-signal="SIGKILL" title="Force stop">Kill</button>
        </div></td>
      </tr>`).join('')}</tbody>
    </table></div>
    ${list.length > 250 ? `<div class="muted tiny" style="padding:10px">Showing the first 250 of ${esc(list.length)} processes.</div>` : ''}`;
  }

  function renderProcesses() {
    const groups = new Map();
    for (const proc of state.processes) {
      const key = String(proc.name || 'unknown').toLowerCase();
      const group = groups.get(key) || { name: proc.name, count: 0, cpu: 0, memoryBytes: 0 };
      group.count += 1;
      group.cpu += num(proc.cpu);
      group.memoryBytes += num(proc.memoryBytes);
      groups.set(key, group);
    }
    const topGroups = Array.from(groups.values()).sort((a, b) => b.cpu - a.cpu).slice(0, 8);
    const actions = state.actionLog.slice(0, 12);

    return `
      <div class="card">
        <div class="row">
          <input id="process-search" placeholder="Filter by name, PID, user or command…" value="${esc(state.processQuery)}" style="max-width:360px">
          <select id="process-sort" style="max-width:180px" aria-label="Sort processes">
            ${[['cpu', 'Sort by CPU'], ['memoryBytes', 'Sort by memory'], ['uptime', 'Sort by uptime'], ['pid', 'Sort by PID']]
              .map(([value, label]) => `<option value="${esc(value)}" ${state.processSort === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}
          </select>
          <span class="muted tiny">${esc(state.processes.length)} process(es) · actions require confirmation</span>
        </div>
      </div>

      <section class="card">
        <div class="card-head"><div><h2 class="card-title">Running processes</h2><p class="card-sub">Sampled with ps. Signals are allow-listed and logged.</p></div>
          <button class="btn btn-small btn-subtle" data-action="refresh">↻ Refresh</button></div>
        <div id="process-table-wrap">${processTableHTML()}</div>
      </section>

      <div class="grid grid-side">
        <section class="card">
          <div class="card-head"><div><h2 class="card-title">Application families</h2><p class="card-sub">Processes grouped by executable name.</p></div></div>
          ${topGroups.length ? topGroups.map((group) => `<div class="bar-row">
            <span class="name">${esc(group.name)} <span class="muted tiny">×${esc(group.count)}</span></span>
            <span class="bar-track"><span class="bar-fill" style="width:${Math.min(100, group.cpu)}%"></span></span>
            <span class="bar-value">${pct(group.cpu)}</span>
          </div>`).join('') : '<div class="empty">No groups available.</div>'}
        </section>
        <section class="card">
          <div class="card-head"><div><h2 class="card-title">Action log</h2><p class="card-sub">Every signal and priority change is kept locally.</p></div>
            ${actions.length ? '<button class="btn btn-small btn-subtle" data-action="clear-log">Clear</button>' : ''}</div>
          ${actions.length ? actions.map((entry) => `<div class="result-line">
            <div class="spread"><strong class="tiny">${esc(entry.action)} · ${esc(entry.name || `PID ${entry.pid || '?'}`)}</strong>
              <span class="chip chip-${entry.ok ? 'ok' : 'critical'}">${entry.ok ? 'ok' : 'failed'}</span></div>
            <div class="muted tiny">${esc(entry.message)} · ${esc(time(entry.timestamp))}</div>
          </div>`).join('') : '<div class="empty">No actions recorded.</div>'}
        </section>
      </div>`;
  }

  // -------------------------------------------------------------- performance

  function svgLine(series, options = {}) {
    const width = 620, height = 190;
    const left = 40, right = 14, top = 14, bottom = 28;
    const values = series.map((point) => num(point.value));
    const max = Math.max(options.min || 1, ...values);
    const x = (index) => left + index * (width - left - right) / Math.max(1, series.length - 1);
    const y = (value) => top + (height - top - bottom) * (1 - num(value) / max);
    const path = series.map((point, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(point.value).toFixed(1)}`).join(' ');
    const area = series.length ? `${path} L${x(series.length - 1).toFixed(1)},${(height - bottom).toFixed(1)} L${left},${(height - bottom).toFixed(1)} Z` : '';
    const ticks = [0, max / 2, max];
    const labelEvery = Math.max(1, Math.ceil(series.length / 7));
    const fmtTick = (tick) => options.percent ? `${Math.round(tick)}%` : bytes(tick);
    return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(options.label || 'Performance chart')}">
      ${ticks.map((tick) => `<line class="chart-grid-line" x1="${left}" y1="${y(tick)}" x2="${width - right}" y2="${y(tick)}"/><text class="chart-label" x="2" y="${(y(tick) + 3).toFixed(1)}">${esc(fmtTick(tick))}</text>`).join('')}
      ${area ? `<path d="${area}" fill="var(--accent-soft)" opacity=".55"/>` : ''}
      <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>
      ${series.map((point, index) => index % labelEvery === 0 ? `<text class="chart-label" x="${x(index).toFixed(1)}" y="${height - 7}" text-anchor="middle">${esc(point.label)}</text>` : '').join('')}
    </svg>`;
  }

  function svgDonut(entries) {
    const radius = 52, circumference = 2 * Math.PI * radius;
    let offset = 0;
    const segments = (entries || []).map((entry) => {
      const length = num(entry.percent) / 100 * circumference;
      const segment = `<circle cx="80" cy="80" r="${radius}" fill="none" stroke="${esc(entry.color || 'var(--accent)')}" stroke-width="18"
        stroke-dasharray="${length.toFixed(2)} ${(circumference - length).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 80 80)">
        <title>${esc(entry.name)}: ${esc(bytes(entry.value))} (${esc(entry.percent)}%)</title></circle>`;
      offset += length;
      return segment;
    }).join('');
    return `<div class="row" style="align-items:center;gap:18px">
      <svg class="chart" style="width:160px;flex:0 0 160px" viewBox="0 0 160 160" role="img" aria-label="Memory use by process">
        <circle cx="80" cy="80" r="${radius}" fill="none" stroke="var(--surface-3)" stroke-width="18"/>${segments}
        <text x="80" y="77" text-anchor="middle" class="chart-value" style="font-size:16px">RAM</text>
        <text x="80" y="94" text-anchor="middle" class="chart-label">by process</text>
      </svg>
      <div class="stack" style="gap:5px;flex:1">
        ${(entries || []).map((entry) => `<div class="spread tiny"><span class="legend-item"><span class="legend-swatch" style="background:${esc(entry.color || 'var(--accent)')}"></span>${esc(entry.name)}</span><strong>${esc(entry.percent)}%</strong></div>`).join('') || '<div class="muted tiny">No process memory data.</div>'}
      </div>
    </div>`;
  }

  function svgHeatmap(heat) {
    if (!heat || !heat.cells) return '<div class="empty">Not enough history for an activity map.</div>';
    const cell = 17, gap = 2, left = 38, top = 26;
    const width = left + 24 * (cell + gap) + 10;
    const height = top + 7 * (cell + gap) + 10;
    const max = Math.max(1, num(heat.max));
    const rects = heat.cells.map((point) => {
      const alpha = point.value ? 0.18 + 0.82 * (num(point.value) / max) : 0.04;
      return `<rect class="heat-cell" x="${left + point.col * (cell + gap)}" y="${top + point.row * (cell + gap)}" width="${cell}" height="${cell}" rx="3"
        fill="var(--accent)" fill-opacity="${alpha.toFixed(2)}"><title>${esc(point.day)} ${esc(point.hour)}:00 — load ${esc(point.value)}</title></rect>`;
    }).join('');
    const hourLabels = [0, 4, 8, 12, 16, 20].map((hour) => `<text class="chart-label" x="${left + hour * (cell + gap) + cell / 2}" y="${top - 8}" text-anchor="middle">${hour}</text>`).join('');
    const dayLabels = (heat.days || []).map((day, index) => `<text class="chart-label" x="${left - 7}" y="${top + index * (cell + gap) + 12}" text-anchor="end">${esc(day)}</text>`).join('');
    return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="System activity by weekday and hour">${hourLabels}${dayLabels}${rects}</svg>`;
  }

  function barRows(list, unit) {
    if (!list || !list.length) return '<div class="empty">No process data.</div>';
    const max = Math.max(1, ...list.map((entry) => num(entry.value)));
    return list.map((entry) => `<div class="bar-row">
      <span class="name" title="${esc(entry.label)}">${esc(entry.label)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(num(entry.value) / max * 100).toFixed(1)}%"></span></span>
      <span class="bar-value">${unit === 'bytes' ? esc(bytes(entry.value)) : pct(entry.value)}</span>
    </div>`).join('');
  }

  function statStrip(stats, label, unit = '%') {
    const fmt = (value) => unit === 'bytes' ? rate(value) : `${num(value).toFixed(1)}${unit}`;
    return `<div class="tiny muted">peak ${esc(fmt(stats.peak))} · avg ${esc(fmt(stats.average))} · now ${esc(fmt(stats.latest))} · trend ${esc(stats.trend > 0 ? '+' : '')}${esc(stats.trend)}% · ${esc(stats.samples)} samples</div>`;
  }

  function renderPerformance() {
    const data = state.analytics;
    if (!data || !data.cpu || !data.cpu.length) {
      return `<div class="empty"><p>No history yet. cinnamon collects samples every few seconds.</p><button class="btn btn-primary" data-action="refresh">Collect a sample</button></div>`;
    }
    const networkStats = data.stats && data.stats.networkRx || {};
    return `
      <div class="grid grid-4">
        ${metricCard('CPU now', pct((data.stats || {}).cpu && data.stats.cpu.latest), `peak ${pct((data.stats || {}).cpu && data.stats.cpu.peak)}`, (data.stats || {}).cpu && data.stats.cpu.latest)}
        ${metricCard('Memory now', pct((data.stats || {}).memory && data.stats.memory.latest), `peak ${pct((data.stats || {}).memory && data.stats.memory.peak)}`, (data.stats || {}).memory && data.stats.memory.latest)}
        ${metricCard('Disk now', pct((data.stats || {}).disk && data.stats.disk.latest), `peak ${pct((data.stats || {}).disk && data.stats.disk.peak)}`, (data.stats || {}).disk && data.stats.disk.latest)}
        ${metricCard('Network now', rate(networkStats.latest), `peak ${rate(networkStats.peak)}`)}
      </div>

      <div class="chart-grid">
        <section class="card chart-card">
          <div class="card-head"><div><h2 class="card-title">CPU usage</h2><p class="card-sub">Percent across all cores.</p></div></div>
          ${svgLine(data.cpu, { percent: true, min: 100, label: 'CPU usage history' })}
          ${statStrip((data.stats || {}).cpu || {}, 'CPU')}
        </section>
        <section class="card chart-card">
          <div class="card-head"><div><h2 class="card-title">Memory usage</h2><p class="card-sub">Resident memory as a percent of total.</p></div></div>
          ${svgLine(data.memory, { percent: true, min: 100, label: 'Memory usage history' })}
          ${statStrip((data.stats || {}).memory || {}, 'Memory')}
        </section>
        <section class="card chart-card">
          <div class="card-head"><div><h2 class="card-title">Disk usage</h2><p class="card-sub">Highest filesystem use each sample.</p></div></div>
          ${svgLine(data.disk, { percent: true, min: 100, label: 'Disk usage history' })}
          ${statStrip((data.stats || {}).disk || {}, 'Disk')}
        </section>
        <section class="card chart-card">
          <div class="card-head"><div><h2 class="card-title">Network throughput</h2><p class="card-sub">Download + upload bytes per second.</p></div></div>
          ${svgLine(data.network.total, { label: 'Network throughput history' })}
          ${statStrip(networkStats, 'Download', 'bytes')}
        </section>
      </div>

      <div class="grid grid-side">
        <div class="stack">
          <section class="card">
            <div class="card-head"><div><h2 class="card-title">CPU by process</h2><p class="card-sub">Top ten from the latest sample.</p></div></div>
            ${barRows((data.processBars || {}).cpu, 'percent')}
          </section>
          <section class="card">
            <div class="card-head"><div><h2 class="card-title">Memory by process</h2><p class="card-sub">Resident set size, largest first.</p></div></div>
            ${barRows((data.processBars || {}).memory, 'bytes')}
          </section>
        </div>
        <div class="stack">
          <section class="card">
            <div class="card-head"><div><h2 class="card-title">Memory donut</h2><p class="card-sub">Largest memory holders plus "Other".</p></div></div>
            ${svgDonut(data.memoryDonut)}
          </section>
          <section class="card">
            <div class="card-head"><div><h2 class="card-title">Activity heatmap</h2><p class="card-sub">Sample load by weekday and hour.</p></div>
              <span class="tiny muted">${esc((data.heatmap || {}).samples || 0)} samples</span></div>
            ${svgHeatmap(data.heatmap)}
          </section>
        </div>
      </div>`;
  }

  // ---------------------------------------------------------------------- AI

  function fullFindingList(findings) {
    if (!findings || !findings.length) return '<div class="empty">No findings. This machine looks calm.</div>';
    return findings.map((finding) => {
      const buttons = (finding.suggestedActions || []).map((action) => {
        if (String(action.action || '').startsWith('navigate:')) {
          return `<button class="btn btn-small btn-subtle" data-action="view" data-view="${esc(String(action.action).slice(9))}">${esc(action.label)}</button>`;
        }
        if (action.action === 'none' || !action.action) return '';
        if (action.action === 'priority') {
          return `<button class="btn btn-small btn-subtle" data-action="proc-action" data-pid="${esc(action.pid)}" data-signal="priority" data-nice="${esc(action.niceness || 10)}">${esc(action.label)}</button>`;
        }
        return `<button class="btn btn-small ${action.action === 'SIGKILL' ? 'btn-danger' : 'btn-subtle'}" data-action="proc-action" data-pid="${esc(action.pid)}" data-signal="${esc(action.action)}">${esc(action.label)}</button>`;
      }).join('');
      return `<div class="finding ${esc(finding.severity)}">
        <div class="spread"><span class="finding-title">${esc(finding.title)}</span><span class="chip chip-${esc(finding.severity)}">${esc(finding.severity)}</span></div>
        ${finding.evidence ? `<div class="finding-evidence">${esc(finding.evidence)}</div>` : ''}
        ${finding.explanation ? `<div class="finding-explain">${esc(finding.explanation)}</div>` : ''}
        ${buttons ? `<div class="finding-actions">${buttons}</div>` : ''}
      </div>`;
    }).join('');
  }

  function compareHTML() {
    if (!state.compare) return '<div class="muted tiny">Pick two samples to see an explainable before/after comparison.</div>';
    const rows = (state.compare.changes || []).map((change) => `<tr>
      <td class="name">${esc(change.label)}</td>
      <td class="num">${esc(change.before)}${esc(change.unit)}</td>
      <td class="num">${esc(change.after)}${esc(change.unit)}</td>
      <td class="num"><span class="chip chip-${change.direction === 'up' ? 'high' : change.direction === 'down' ? 'low' : 'medium'}">${change.delta > 0 ? '+' : ''}${esc(change.delta)}${esc(change.unit)}</span></td>
      <td class="tiny">${esc(change.explanation)}</td>
    </tr>`).join('');
    return `<div class="notice">${esc(state.compare.summary)}</div>
      <div class="table-wrap" style="margin-top:12px"><table class="table"><thead><tr><th>Metric</th><th class="num">Before</th><th class="num">After</th><th class="num">Change</th><th>Explanation</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function renderAI() {
    const analysis = state.analysis || {};
    const settings = state.settings || {};
    const byok = settings.byok || {};
    const samples = ((state.history || {}).samples || []).slice();
    const optionHTML = (selected) => samples.map((sample, index) => {
      const chosen = selected ? sample.timestamp === selected : index === 0;
      return `<option value="${esc(sample.timestamp)}" ${chosen ? 'selected' : ''}>${esc(time(sample.timestamp))}</option>`;
    }).join('');
    const options = optionHTML(state.compareBefore);
    const afterOptions = optionHTML(state.compareAfter);
    const answer = state.aiAnswer;

    return `
      <div class="grid grid-side">
        <div class="stack">
          <section class="card">
            <div class="card-head"><div><h2 class="card-title">Explainable local diagnosis</h2><p class="card-sub">${esc(analysis.summary || 'Waiting for the first sample.')}</p></div>
              <span class="chip chip-${esc(analysis.status || 'healthy')}">${esc(analysis.status || 'unknown')}</span></div>
            <div class="row" style="gap:20px;align-items:flex-start">
              ${healthRing(analysis.healthScore, analysis.status)}
              <div class="stack" style="gap:8px;flex:1">
                ${findingList(analysis.findings, 12)}
              </div>
            </div>
          </section>
          <section class="card">
            <div class="card-head"><div><h2 class="card-title">Full findings</h2><p class="card-sub">Each finding includes evidence and safe next steps.</p></div>
              <span class="tiny muted">${esc((analysis.findings || []).length)} found</span></div>
            ${fullFindingList(analysis.findings)}
          </section>
        </div>

        <div class="stack">
          <section class="card">
            <div class="card-head"><div><h2 class="card-title">AI mode</h2><p class="card-sub">Local analysis is always available and never leaves this device.</p></div></div>
            <div class="segmented" style="margin-bottom:14px">
              <button class="${settings.aiMode === 'byok' ? '' : 'active'}" data-action="set-mode" data-mode="local">Local</button>
              <button class="${settings.aiMode === 'byok' ? 'active' : ''}" data-action="set-mode" data-mode="byok">BYOK</button>
            </div>
            <div class="tiny muted">Endpoint: ${esc(byok.baseUrl || 'not set')}<br>Model: ${esc(byok.model || 'not set')}<br>Key: ${byok.apiKey ? esc(String(byok.apiKey).slice(0, 3) + '••••' + String(byok.apiKey).slice(-4)) : 'not configured'}</div>
            <div class="form-actions"><button class="btn btn-small btn-subtle" data-action="view" data-view="settings">Configure in Settings</button></div>
          </section>

          <section class="card">
            <h2 class="card-title">Ask for a second opinion</h2>
            <p class="card-sub">Uses your own key and endpoint only when you press Ask. Any failure falls back to the local diagnosis.</p>
            <form id="ask-form" style="margin-top:12px">
              <textarea id="ask-prompt" rows="3" placeholder="What should I check first on this machine, and why?">${esc(state.askPrompt)}</textarea>
              <div class="form-actions"><button class="btn btn-primary btn-small" type="submit">Ask AI</button></div>
            </form>
            ${answer ? `<div class="ai-answer ${answer.source === 'local' && answer.error ? 'error' : ''}" style="margin-top:12px">
              <strong>Source: ${esc(answer.source)}</strong>${answer.error ? ` · ${esc(answer.error)}` : ''}
              ${((answer.data || {}).findings || []).length ? (answer.data.findings).map((finding) => `<div class="result-line">
                <span class="chip chip-${esc(finding.severity || 'medium')}">${esc(finding.severity || 'medium')}</span>
                <strong class="tiny">${esc(finding.title)}</strong><div class="muted tiny">${esc(finding.explanation || '')}</div>
              </div>`).join('') : '<div class="tiny muted">No structured findings returned.</div>'}
            </div>` : ''}
          </section>

          <section class="card">
            <div class="card-head"><div><h2 class="card-title">Before / after</h2><p class="card-sub">Compare two sampled moments.</p></div></div>
            <form id="compare-form">
              <div class="field"><label for="compare-before">Earlier sample</label><select id="compare-before">${options}</select></div>
              <div class="field"><label for="compare-after">Later sample</label><select id="compare-after">${afterOptions || '<option value="">no samples</option>'}</select></div>
              <div class="form-actions"><button class="btn btn-small btn-subtle" type="submit" ${samples.length < 2 ? 'disabled' : ''}>Compare samples</button></div>
            </form>
            <div style="margin-top:12px">${compareHTML()}</div>
          </section>
        </div>
      </div>`;
  }

  // ---------------------------------------------------------------- watchers

  function renderRules() {
    if (!state.rules.length) return '<div class="empty">No watch rules yet. Add one to track a process or system metric.</div>';
    return `<div class="table-wrap"><table class="table">
      <thead><tr><th>Rule</th><th>Condition</th><th>Scope</th><th>Cooldown</th><th>Last fired</th><th>Enabled</th><th></th></tr></thead>
      <tbody>${state.rules.map((rule) => `<tr>
        <td><span class="name">${esc(rule.name)}</span>${rule.severity ? `<div><span class="chip chip-${esc(rule.severity)}">${esc(rule.severity)}</span></div>` : ''}</td>
        <td class="mono">${esc(rule.metric)} ${esc(rule.operator)} ${esc(rule.threshold)}</td>
        <td><span class="chip">${esc(rule.scope)}</span></td>
        <td class="tiny">${esc(rule.cooldownMinutes)} min</td>
        <td class="tiny">${rule.lastFired ? esc(time(rule.lastFired)) : 'never'}</td>
        <td><label class="switch"><input type="checkbox" data-action="toggle-rule" data-id="${esc(rule.id)}" ${rule.enabled ? 'checked' : ''} aria-label="Enable ${esc(rule.name)}"><span class="switch-slider"></span></label></td>
        <td><div class="row-actions">
          <button class="btn btn-small btn-subtle" data-action="edit-rule" data-id="${esc(rule.id)}">Edit</button>
          <button class="btn btn-small btn-danger" data-action="delete-rule" data-id="${esc(rule.id)}">Delete</button>
        </div></td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  }

  function renderAlerts() {
    if (!state.alerts.length) return '<div class="empty">No alerts yet.</div>';
    return state.alerts.slice(0, 40).map((alert) => `<div class="result-line">
      <div class="spread"><strong class="tiny">${esc(alert.message)}</strong>
        <span class="row-wrap"><span class="chip chip-${esc(alert.severity)}">${esc(alert.severity)}</span>
          ${alert.acknowledged ? '<span class="chip chip-ok">ack</span>' : `<button class="btn btn-small btn-subtle" data-action="ack-alert" data-id="${esc(alert.id)}">Ack</button>`}</span></div>
      <div class="muted tiny">${esc(alert.evidence)} · ${esc(time(alert.timestamp))}</div>
    </div>`).join('');
  }

  function renderWatchers() {
    const enabled = state.rules.filter((rule) => rule.enabled).length;
    const unack = state.alerts.filter((alert) => !alert.acknowledged).length;
    return `
      <div class="grid grid-3">
        <div class="card stat-card"><div class="stat-value">${esc(state.rules.length)}</div><div class="stat-label">Rules</div></div>
        <div class="card stat-card"><div class="stat-value">${esc(enabled)}</div><div class="stat-label">Enabled</div></div>
        <div class="card stat-card"><div class="stat-value">${esc(unack)}</div><div class="stat-label">Unacknowledged alerts</div></div>
      </div>

      <section class="card">
        <div class="card-head"><div><h2 class="card-title">Watch rules</h2><p class="card-sub">Evaluated on every sample; cooldowns prevent alert storms.</p></div>
          <div class="row-wrap">
            <button class="btn btn-small btn-subtle" data-action="evaluate">Evaluate now</button>
            <button class="btn btn-small btn-primary" data-action="new-rule">+ New rule</button>
          </div></div>
        ${renderRules()}
      </section>

      <div class="grid grid-side">
        <section class="card">
          <div class="card-head"><div><h2 class="card-title">Alert history</h2><p class="card-sub">Newest first, stored locally.</p></div>
            ${state.alerts.length ? '<button class="btn btn-small btn-subtle" data-action="clear-alerts">Clear</button>' : ''}</div>
          ${renderAlerts()}
        </section>
        <section class="card">
          <div class="card-head"><div><h2 class="card-title">Action log</h2><p class="card-sub">Process signals and priority changes.</p></div>
            ${state.actionLog.length ? '<button class="btn btn-small btn-subtle" data-action="clear-log">Clear</button>' : ''}</div>
          ${state.actionLog.length ? state.actionLog.slice(0, 25).map((entry) => `<div class="result-line">
            <div class="spread"><strong class="tiny">${esc(entry.action)} · ${esc(entry.name || `PID ${entry.pid || '?'}`)}</strong>
              <span class="chip chip-${entry.ok ? 'ok' : 'critical'}">${entry.ok ? 'ok' : 'failed'}</span></div>
            <div class="muted tiny">${esc(entry.message)} · ${esc(time(entry.timestamp))}</div>
          </div>`).join('') : '<div class="empty">No actions recorded.</div>'}
        </section>
      </div>`;
  }

  // --------------------------------------------------------------- changelog

  async function loadBundled() {
    state.bundled = await call(() => api.changelog.bundled(), { releases: [], intro: '', markdown: '', source: 'bundled' });
    if (state.view === 'changelog') render();
  }

  async function loadGithub() {
    state.githubLoading = true;
    if (state.view === 'changelog') render();
    state.github = await call(() => api.changelog.github(), { releases: [], error: { message: 'Could not fetch releases.' }, source: 'github' });
    state.githubLoading = false;
    if (state.view === 'changelog') render();
  }

  function releaseCard(release, githubSource) {
    const sections = release.sections || [];
    return `<article class="release">
      <div class="release-head">
        <span class="release-version">${esc(release.version || 'unreleased')}</span>
        ${release.date ? `<span class="release-date">${esc(release.date)}</span>` : ''}
        <span class="chip chip-${githubSource ? 'medium' : 'low'}">${githubSource ? 'GitHub' : 'In app'}</span>
        ${release.githubUrl || release.url ? `<a class="release-link" href="${esc(release.githubUrl || release.url)}" data-action="external">View on GitHub ↗</a>` : ''}
      </div>
      ${sections.length ? sections.map((section) => `
        <div class="release-section-title">${esc(section.name)}</div>
        <ul class="release-items">${(section.items || []).map((item) => `<li>${esc(item.text)}${(item.children || []).length ? `<ul>${item.children.map((child) => `<li>${esc(child)}</li>`).join('')}</ul>` : ''}</li>`).join('')}</ul>
      `).join('') : `<div class="release-section-title">Notes</div><div class="tiny muted">${esc(release.raw || 'No details provided.')}</div>`}
    </article>`;
  }

  function renderChangelog() {
    const tab = state.changelogTab;
    let content;

    if (tab === 'inapp') {
      const bundled = state.bundled;
      const releases = bundled && bundled.releases || [];
      content = `${bundled && bundled.intro ? `<div class="notice">${esc(bundled.intro)}</div>` : ''}
        ${releases.length ? releases.map((release) => releaseCard(release, false)).join('') : '<div class="empty">Bundled changelog is not available in this build.</div>'}`;
    } else {
      const github = state.github;
      if (state.githubLoading) {
        content = '<div class="empty">Fetching public GitHub releases…</div>';
      } else if (github && github.releases && github.releases.length) {
        content = `${github.error ? `<div class="notice warn">${esc(github.error.message || 'GitHub fetch failed.')}</div>` : ''}
          <div class="tiny muted" style="margin-bottom:12px">Fetched ${esc(time(github.fetchedAt))} from the public releases endpoint.</div>
          ${github.releases.map((release) => releaseCard(release, true)).join('')}`;
      } else {
        const bundled = state.bundled;
        const releases = bundled && bundled.releases || [];
        content = `${github && github.error ? `<div class="notice warn">${esc(github.error.message || 'GitHub is unavailable.')} Showing bundled release notes offline.</div>` : '<div class="notice">Click “Fetch releases” to load public GitHub release notes.</div>'}
          ${releases.length ? `<div class="section-title">Bundled notes (offline)</div>${releases.map((release) => releaseCard(release, false)).join('')}` : '<div class="empty">No bundled notes available.</div>'}`;
      }
    }

    return `
      <div class="card">
        <div class="spread">
          <div class="tabs" role="tablist" aria-label="Changelog source">
            <button class="${tab === 'inapp' ? 'active' : ''}" data-action="changelog-tab" data-tab="inapp" role="tab" aria-selected="${tab === 'inapp'}">In app</button>
            <button class="${tab === 'github' ? 'active' : ''}" data-action="changelog-tab" data-tab="github" role="tab" aria-selected="${tab === 'github'}">GitHub</button>
          </div>
          <div class="row-wrap">
            <span class="tiny muted">${tab === 'inapp' ? 'Works offline, shipped with the app' : 'Public releases, fetched on demand'}</span>
            ${tab === 'github' ? `<button class="btn btn-small btn-subtle" data-action="changelog-refresh" ${state.githubLoading ? 'disabled' : ''}>↻ Refresh</button>` : ''}
          </div>
        </div>
      </div>
      ${content}`;
  }

  // ---------------------------------------------------------------- settings

  function renderSettings() {
    const settings = state.settings || {};
    const byok = settings.byok || {};
    const info = state.info || {};
    const appInfo = state.appInfo || {};
    return `
      <div class="grid grid-side">
        <div class="stack">
          <form id="settings-form">
            <section class="card">
              <h2 class="card-title">Monitoring</h2>
              <p class="card-sub">Sampling uses Node built-ins only. Changes take effect immediately.</p>
              <div class="form-grid" style="margin-top:12px">
                <div class="field"><label for="settings-theme">Theme</label>
                  <select id="settings-theme">
                    ${[['light', 'Light'], ['dark', 'Dark'], ['system', 'Follow system']].map(([value, label]) => `<option value="${value}" ${settings.theme === value ? 'selected' : ''}>${label}</option>`).join('')}
                  </select></div>
                <div class="field"><label for="settings-interval">Sample interval (ms)</label>
                  <input id="settings-interval" type="number" min="500" max="60000" step="500" value="${esc(settings.sampleIntervalMs || 2000)}"></div>
                <div class="field"><label for="settings-history">History samples</label>
                  <input id="settings-history" type="number" min="10" max="5000" step="10" value="${esc(settings.historyLimit || 600)}"></div>
                <div class="field"><label for="settings-ai-mode">AI mode</label>
                  <select id="settings-ai-mode">
                    <option value="local" ${settings.aiMode !== 'byok' ? 'selected' : ''}>Local (private)</option>
                    <option value="byok" ${settings.aiMode === 'byok' ? 'selected' : ''}>BYOK second opinion</option>
                  </select></div>
              </div>
              <label class="checkbox-row"><input type="checkbox" id="settings-alerts" ${settings.alertsEnabled !== false ? 'checked' : ''}> Record alerts from watch rules</label>
            </section>

            <section class="card" style="margin-top:14px">
              <h2 class="card-title">Bring your own key</h2>
              <p class="card-sub">Optional. Requests go directly from cinnamon to the endpoint you configure, only when you press “Ask AI”.</p>
              <div class="field" style="margin-top:12px"><label for="settings-base">Base URL</label><input id="settings-base" value="${esc(byok.baseUrl || '')}" placeholder="https://api.openai.com/v1"></div>
              <div class="form-grid">
                <div class="field"><label for="settings-model">Model</label><input id="settings-model" value="${esc(byok.model || '')}" placeholder="gpt-4o-mini"></div>
                <div class="field"><label for="settings-key">API key</label><input id="settings-key" type="password" value="" placeholder="${byok.apiKey ? 'Saved key present' : 'Not configured'}" autocomplete="off">
                  <span class="field-hint">Leave blank to keep the saved key. Keys are never logged.</span></div>
              </div>
              <div class="form-actions"><button class="btn btn-primary" type="submit">Save settings</button></div>
            </section>
          </form>
        </div>

        <div class="stack">
          <section class="card">
            <h2 class="card-title">Your data</h2>
            <p class="card-sub">Everything lives in a local JSON file with atomic writes. No account, no telemetry.</p>
            <div class="stack" style="gap:8px;margin-top:14px">
              <button class="btn btn-subtle" data-action="export">↓ Export JSON backup</button>
              <button class="btn btn-subtle" data-action="import">↑ Import JSON backup</button>
              <button class="btn btn-danger" data-action="reset">↺ Reset to default rules</button>
            </div>
          </section>
          <section class="notice">
            <strong>Privacy first.</strong> Local diagnostics never leave this device. GitHub release notes are fetched from a public endpoint only when you open the GitHub tab. BYOK mode is opt-in.
          </section>
          <section class="card">
            <h2 class="card-title">About</h2>
            <div class="tiny muted" style="line-height:2">
              <div>cinnamon ${esc(appInfo.version || '1.0.0')}</div>
              <div>Platform: ${esc(info.platform || processPlatform())} · ${esc(info.arch || '')}</div>
              <div>Node: ${esc(info.node || '—')}${info.electron ? ` · Electron ${esc(info.electron)}` : ''}</div>
              <div>Host: ${esc(info.hostname || '—')}</div>
              <div>Data: ${esc(appInfo.dataPath || 'in memory')}</div>
            </div>
            <div class="form-actions"><button class="btn btn-small btn-subtle" data-action="view" data-view="changelog">Open changelog →</button></div>
          </section>
          <section class="card">
            <h2 class="card-title">Shortcuts</h2>
            <div class="tiny muted" style="line-height:2">
              <div><kbd>Ctrl K</kbd> command palette</div>
              <div><kbd>Ctrl 1–7</kbd> switch views</div>
              <div><kbd>Ctrl ,</kbd> settings</div>
              <div><kbd>Ctrl Shift T</kbd> toggle theme</div>
              <div><kbd>Ctrl Shift R</kbd> refresh sample</div>
              <div><kbd>Esc</kbd> close dialog</div>
            </div>
          </section>
        </div>
      </div>`;
  }

  function processPlatform() {
    return api.platform || 'unknown';
  }

  // ------------------------------------------------------------------ modals

  function openModal(html, options = {}) {
    document.getElementById('modal-root').innerHTML = `
      <div class="modal-backdrop" data-action="close-modal">
        <div class="modal ${options.wide ? 'modal-wide' : ''} ${options.palette ? 'palette' : ''}">${html}</div>
      </div>`;
  }

  function closeModal() {
    document.getElementById('modal-root').innerHTML = '';
    state.confirmAction = null;
  }

  function confirmCopy(signal, target) {
    const label = target && (target.name || `PID ${target.pid}`) || 'this process';
    if (signal === 'SIGKILL') return { title: 'Force stop process?', message: `Force-stopping ${label} cannot be undone and may lose unsaved work.`, severity: 'danger' };
    if (signal === 'SIGTERM') return { title: 'Stop process?', message: `Ask ${label} to shut down cleanly.`, severity: 'warning' };
    if (signal === 'SIGSTOP') return { title: 'Pause process?', message: `${label} will be frozen until it receives SIGCONT.`, severity: 'warning' };
    if (signal === 'priority') return { title: 'Change priority?', message: `Set niceness for ${label}. Lower values mean higher priority; negative values may need elevated privileges.`, severity: 'warning' };
    return { title: 'Confirm action', message: `Send ${signal} to ${label}?`, severity: 'info' };
  }

  function confirmAction(signal, target, onConfirm) {
    const copy = confirmCopy(signal, target);
    state.confirmAction = onConfirm;
    openModal(`<div class="modal-head"><h2>${esc(copy.title)}</h2><button class="btn btn-icon btn-small" data-action="close-modal" title="Close">✕</button></div>
      <div class="modal-body">
        <p>${esc(copy.message)}</p>
        ${copy.severity === 'danger' ? '<div class="confirm-warning">cinnamon will log this action locally. Use it only when you are sure the work can be lost.</div>' : ''}
      </div>
      <div class="modal-foot">
        <button class="btn btn-subtle" data-action="close-modal">Cancel</button>
        <button class="btn ${copy.severity === 'danger' ? 'btn-danger' : 'btn-primary'}" data-action="confirm-action">Confirm</button>
      </div>`);
  }

  async function runProcessAction(pid, signal, niceness) {
    const proc = state.processes.find((candidate) => candidate.pid === Number(pid)) || { pid: Number(pid) };
    const execute = async () => {
      const result = signal === 'priority'
        ? await call(() => api.actions.priority(Number(pid), Number(niceness || 10)), { ok: false, message: 'Priority change failed' })
        : await call(() => api.actions.signal(Number(pid), signal), { ok: false, message: 'Signal failed' });
      toast(result.message || (result.ok ? 'Action completed' : 'Action failed'), result.ok ? 'ok' : 'error');
      closeModal();
      state.actionLog = await call(() => api.log.actions(100), state.actionLog);
      render();
    };
    confirmAction(signal, proc, execute);
  }

  async function showDetails(pid) {
    const result = await call(() => api.actions.details(Number(pid)), null);
    if (!result || !result.ok) return toast(result && result.message ? result.message : 'Could not read process details', 'error');
    const proc = result.process || {};
    openModal(`<div class="modal-head"><h2>Process ${esc(proc.pid)}</h2><button class="btn btn-icon btn-small" data-action="close-modal">✕</button></div>
      <div class="modal-body">
        <div class="spread"><h3 class="card-title">${esc(proc.name)}</h3><span class="chip">${esc(proc.state)}</span></div>
        <div class="table-wrap" style="margin-top:14px"><table class="table"><tbody>
          <tr><td>Command</td><td class="mono">${esc(proc.command)}</td></tr>
          <tr><td>User</td><td>${esc(proc.user || '—')}</td></tr>
          <tr><td>Parent PID</td><td class="mono">${esc(proc.ppid)}</td></tr>
          <tr><td>CPU</td><td>${pct(proc.cpu)}</td></tr>
          <tr><td>Memory</td><td>${bytes(proc.memoryBytes)} (${pct(proc.memory)})</td></tr>
          <tr><td>Uptime</td><td>${esc(uptime(proc.uptime))}</td></tr>
        </tbody></table></div>
      </div>
      <div class="modal-foot"><button class="btn btn-subtle" data-action="close-modal">Close</button></div>`, { wide: true });
  }

  function openRuleModal(rule) {
    const source = rule || { name: '', metric: 'cpu', threshold: 80, operator: '>', scope: 'process', severity: 'medium', cooldownMinutes: 5, enabled: true };
    openModal(`<div class="modal-head"><h2>${rule ? 'Edit rule' : 'New watch rule'}</h2><button class="btn btn-icon btn-small" data-action="close-modal">✕</button></div>
      <form id="rule-form">
        <input type="hidden" id="rule-id" value="${esc(rule ? rule.id : '')}">
        <div class="modal-body">
          <div class="field"><label for="rule-name">Name *</label><input id="rule-name" maxlength="120" value="${esc(source.name)}" placeholder="High CPU process"></div>
          <div class="form-grid">
            <div class="field"><label for="rule-metric">Metric</label><select id="rule-metric">
              ${['cpu', 'memory', 'memoryBytes', 'load', 'disk', 'network', 'zombies', 'count'].map((metric) => `<option value="${metric}" ${source.metric === metric ? 'selected' : ''}>${metric}</option>`).join('')}
            </select></div>
            <div class="field"><label for="rule-threshold">Threshold</label><input id="rule-threshold" type="number" step="0.1" value="${esc(source.threshold)}"></div>
            <div class="field"><label for="rule-operator">Operator</label><select id="rule-operator">
              ${['>', '>='].map((operator) => `<option value="${operator}" ${source.operator === operator ? 'selected' : ''}>${operator}</option>`).join('')}
            </select></div>
            <div class="field"><label for="rule-scope">Scope</label><select id="rule-scope">
              ${['process', 'system'].map((scope) => `<option value="${scope}" ${source.scope === scope ? 'selected' : ''}>${scope}</option>`).join('')}
            </select></div>
            <div class="field"><label for="rule-severity">Severity</label><select id="rule-severity">
              ${['low', 'medium', 'high', 'critical'].map((severity) => `<option value="${severity}" ${source.severity === severity ? 'selected' : ''}>${severity}</option>`).join('')}
            </select></div>
            <div class="field"><label for="rule-cooldown">Cooldown (minutes)</label><input id="rule-cooldown" type="number" min="0" max="1440" value="${esc(source.cooldownMinutes)}"></div>
          </div>
          <label class="checkbox-row"><input type="checkbox" id="rule-enabled" ${source.enabled !== false ? 'checked' : ''}> Rule enabled</label>
        </div>
        <div class="modal-foot">
          <button type="button" class="btn btn-subtle" data-action="close-modal">Cancel</button>
          <button type="submit" class="btn btn-primary">${rule ? 'Save rule' : 'Add rule'}</button>
        </div>
      </form>`);
  }

  function paletteCommands() {
    const commands = VIEWS.map((view) => ({ id: `view:${view.id}`, icon: view.icon, label: view.label, hint: 'Go to view', run: () => setView(view.id) }));
    commands.push(
      { id: 'refresh', icon: '↻', label: 'Refresh system sample', hint: 'Ctrl Shift R', run: refreshAll },
      { id: 'theme', icon: '◐', label: 'Toggle light / dark theme', hint: 'Ctrl Shift T', run: toggleTheme },
      { id: 'evaluate', icon: '⚑', label: 'Evaluate watch rules now', hint: 'Watchers', run: evaluateRules },
      { id: 'changelog:inapp', icon: '≡', label: 'Changelog: In app', hint: 'Bundled notes', run: () => { state.changelogTab = 'inapp'; setView('changelog'); } },
      { id: 'changelog:github', icon: '↗', label: 'Changelog: GitHub releases', hint: 'Fetch on demand', run: () => { state.changelogTab = 'github'; setView('changelog'); loadGithub(); } },
      { id: 'export', icon: '↓', label: 'Export JSON data', hint: 'Settings', run: exportData },
      { id: 'import', icon: '↑', label: 'Import JSON data', hint: 'Settings', run: () => document.getElementById('import-file').click() }
    );
    return commands;
  }

  function openPalette() {
    state.paletteCommands = paletteCommands();
    state.paletteQuery = '';
    state.paletteIndex = 0;
    renderPalette();
    setTimeout(() => { const input = $('#palette-input'); if (input) input.focus(); }, 0);
  }

  function filteredPalette() {
    const query = state.paletteQuery.trim().toLowerCase();
    return state.paletteCommands.filter((command) => !query || `${command.label} ${command.hint}`.toLowerCase().includes(query));
  }

  function renderPalette() {
    const list = filteredPalette();
    state.paletteIndex = Math.max(0, Math.min(state.paletteIndex, list.length - 1));
    openModal(`<div class="modal-head" style="border-bottom:0;padding-bottom:6px"><h2>Command palette</h2><span class="tiny muted">↑ ↓ to navigate · Enter to run · Esc to close</span></div>
      <input id="palette-input" class="palette-input" placeholder="Type a view or action…" value="${esc(state.paletteQuery)}">
      <div class="palette-list">${list.length ? list.map((command, index) => `
        <button class="palette-item ${index === state.paletteIndex ? 'active' : ''}" data-action="palette-run" data-id="${esc(command.id)}">
          <span class="palette-icon">${command.icon}</span><span>${esc(command.label)}</span><small>${esc(command.hint)}</small>
        </button>`).join('') : '<div class="empty">No matching commands.</div>'}</div>`, { palette: true });
  }

  function runPalette(id) {
    const command = state.paletteCommands.find((candidate) => candidate.id === id);
    closeModal();
    if (command) command.run();
  }

  // ----------------------------------------------------------------- actions

  async function toggleTheme() {
    const theme = state.settings.theme === 'dark' ? 'light' : 'dark';
    await saveSettings({ theme });
  }

  async function saveSettings(patch) {
    state.settings = await call(() => api.settings.update(patch), state.settings);
    applyTheme();
    render();
    toast('Settings saved', 'ok');
  }

  async function evaluateRules() {
    const result = await call(() => api.rules.evaluate(), null);
    if (!result) return;
    toast(`${result.alerts.length} alert(s) from ${result.evaluated} rule(s)`, 'ok');
    await loadCore();
    render();
  }

  async function exportData() {
    const json = await call(() => api.data.export(), null);
    if (!json) return;
    const blob = new Blob([json], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'cinnamon-backup.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    toast('Backup exported', 'ok');
  }

  async function importData(file) {
    if (!file) return;
    const json = await file.text();
    const result = await call(() => api.data.import(json, 'replace'), null);
    if (!result) return;
    toast(`Imported ${result.rules} rule(s), ${result.alerts} alert(s)`, 'ok');
    await loadCore();
    render();
  }

  async function ruleSubmit() {
    const id = $('#rule-id').value;
    const payload = {
      name: $('#rule-name').value.trim(),
      metric: $('#rule-metric').value,
      threshold: Number($('#rule-threshold').value),
      operator: $('#rule-operator').value,
      scope: $('#rule-scope').value,
      severity: $('#rule-severity').value,
      cooldownMinutes: Number($('#rule-cooldown').value),
      enabled: $('#rule-enabled').checked
    };
    if (!payload.name) return toast('Give the rule a name', 'error');
    const result = id
      ? await call(() => api.rules.update(id, payload), null)
      : await call(() => api.rules.add(payload), null);
    if (!result) return;
    closeModal();
    state.rules = await call(() => api.rules.list(), state.rules);
    render();
    toast(id ? 'Rule updated' : 'Rule added', 'ok');
  }

  // --------------------------------------------------------------- listeners

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    switch (action) {
      case 'view':
        event.preventDefault();
        setView(target.dataset.view);
        break;
      case 'refresh': refreshAll(); break;
      case 'palette': openPalette(); break;
      case 'palette-run': runPalette(target.dataset.id); break;
      case 'close-modal':
        if (event.target === target || target.classList.contains('btn') || target.classList.contains('modal-head')) closeModal();
        break;
      case 'confirm-action':
        if (state.confirmAction) state.confirmAction();
        break;
      case 'toggle-theme': toggleTheme(); break;
      case 'proc-details': showDetails(Number(target.dataset.pid)); break;
      case 'proc-action': runProcessAction(Number(target.dataset.pid), target.dataset.signal, Number(target.dataset.nice || 10)); break;
      case 'clear-log':
        call(() => api.log.clear(), false).then(() => { state.actionLog = []; render(); toast('Action log cleared', 'ok'); });
        break;
      case 'new-rule': openRuleModal(null); break;
      case 'edit-rule': openRuleModal(state.rules.find((rule) => rule.id === target.dataset.id)); break;
      case 'delete-rule':
        confirmAction('delete-rule', { name: (state.rules.find((rule) => rule.id === target.dataset.id) || {}).name }, async () => {
          await call(() => api.rules.remove(target.dataset.id), false);
          closeModal();
          state.rules = await call(() => api.rules.list(), state.rules);
          render();
          toast('Rule deleted', 'ok');
        });
        break;
      case 'toggle-rule': break; // handled by change listener
      case 'ack-alert':
        call(() => api.alerts.ack(target.dataset.id), false).then(() => {
          const alert = state.alerts.find((candidate) => candidate.id === target.dataset.id);
          if (alert) alert.acknowledged = true;
          render();
        });
        break;
      case 'clear-alerts':
        confirmAction('clear-alerts', { name: 'all alerts' }, async () => {
          await call(() => api.alerts.clear(), false);
          closeModal();
          state.alerts = [];
          render();
          toast('Alerts cleared', 'ok');
        });
        break;
      case 'evaluate': evaluateRules(); break;
      case 'set-mode': saveSettings({ aiMode: target.dataset.mode }); break;
      case 'changelog-tab':
        state.changelogTab = target.dataset.tab;
        render();
        if (state.changelogTab === 'github' && !state.github) loadGithub();
        break;
      case 'changelog-refresh': loadGithub(); break;
      case 'export': exportData(); break;
      case 'import': document.getElementById('import-file').click(); break;
      case 'reset':
        confirmAction('reset', { name: 'all local data' }, async () => {
          await call(() => api.data.reset(true), null);
          closeModal();
          await loadCore();
          render();
          toast('Local data reset', 'ok');
        });
        break;
      case 'external': {
        event.preventDefault();
        const url = String(target.href || '');
        if (/^https:\/\//i.test(url) && typeof window.open === 'function') window.open(url, '_blank');
        break; // main process opens https links through setWindowOpenHandler
      }
      default: break;
    }
  });

  document.addEventListener('change', (event) => {
    const target = event.target;
    if (target.id === 'process-sort') {
      state.processSort = target.value;
      const wrap = $('#process-table-wrap');
      if (wrap) wrap.innerHTML = processTableHTML();
      return;
    }
    if (target.dataset.action === 'toggle-rule') {
      call(() => api.rules.update(target.dataset.id, { enabled: target.checked }), null).then((rule) => {
        const current = state.rules.find((candidate) => candidate.id === target.dataset.id);
        if (current && rule) current.enabled = rule.enabled;
        render();
      });
      return;
    }
    if (target.id === 'import-file') {
      importData(target.files && target.files[0]);
      target.value = '';
    }
  });

  document.addEventListener('input', (event) => {
    if (event.target.id === 'process-search') {
      state.processQuery = event.target.value;
      const wrap = $('#process-table-wrap');
      if (wrap) wrap.innerHTML = processTableHTML();
      return;
    }
    if (event.target.id === 'palette-input') {
      state.paletteQuery = event.target.value;
      state.paletteIndex = 0;
      renderPalette();
      const input = $('#palette-input');
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    }
  });

  document.addEventListener('submit', (event) => {
    event.preventDefault();
    switch (event.target.id) {
      case 'settings-form': {
        const patch = {
          theme: $('#settings-theme').value,
          sampleIntervalMs: Number($('#settings-interval').value),
          historyLimit: Number($('#settings-history').value),
          aiMode: $('#settings-ai-mode').value,
          alertsEnabled: $('#settings-alerts').checked,
          byok: {
            baseUrl: $('#settings-base').value.trim(),
            model: $('#settings-model').value.trim()
          }
        };
        const key = $('#settings-key').value.trim();
        if (key) patch.byok.apiKey = key;
        saveSettings(patch);
        break;
      }
      case 'rule-form': ruleSubmit(); break;
      case 'ask-form': {
        state.askPrompt = $('#ask-prompt').value;
        state.aiAnswer = awaitAsk(state.askPrompt);
        render();
        break;
      }
      case 'compare-form': {
        const before = $('#compare-before').value;
        const after = $('#compare-after').value;
        if (!before || !after) return toast('Pick two samples', 'error');
        state.compareBefore = before;
        state.compareAfter = after;
        call(() => api.ai.compare({ before, after }), null).then((result) => {
          state.compare = result;
          render();
        });
        break;
      }
      default: break;
    }
  });

  // Placeholder value for the async ask; resolved below and rendered on completion.
  function awaitAsk(prompt) {
    call(() => api.ai.ask({ prompt }), { source: 'local', data: null, error: 'Ask did not complete' }).then((answer) => {
      state.aiAnswer = answer;
      if (state.view === 'ai') render();
    });
    return { source: 'local', data: null, error: 'Thinking…' };
  }

  document.addEventListener('keydown', (event) => {
    const modifier = event.ctrlKey || event.metaKey;
    const paletteOpen = Boolean($('#palette-input'));

    if (event.key === 'Escape') {
      if (paletteOpen || document.getElementById('modal-root').innerHTML) closeModal();
      return;
    }

    if (paletteOpen) {
      const list = filteredPalette();
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        state.paletteIndex = Math.min(list.length - 1, state.paletteIndex + 1);
        renderPalette();
        const input = $('#palette-input');
        if (input) input.focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        state.paletteIndex = Math.max(0, state.paletteIndex - 1);
        renderPalette();
        const input = $('#palette-input');
        if (input) input.focus();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const selected = list[state.paletteIndex];
        if (selected) runPalette(selected.id);
      }
      return;
    }

    if (!modifier) return;
    const key = event.key.toLowerCase();
    if (key === 'k' || key === 'n') { event.preventDefault(); openPalette(); return; }
    if (key === ',') { event.preventDefault(); setView('settings'); return; }
    if (key === 'r' && event.shiftKey) { event.preventDefault(); refreshAll(); return; }
    if (key === 't' && event.shiftKey) { event.preventDefault(); toggleTheme(); return; }
    if (/^[1-7]$/.test(key) && !event.shiftKey) {
      event.preventDefault();
      const view = VIEWS[Number(key) - 1];
      if (view) setView(view.id);
    }
  });

  api.onSystemUpdate((payload) => {
    if (!payload) return;
    state.snapshot = payload.snapshot || state.snapshot;
    state.processes = payload.processes || state.processes;
    state.history = payload.history || state.history;
    state.analysis = payload.analysis || state.analysis;
    state.alerts = payload.alerts || state.alerts;
    updateLiveLabel();
    const active = document.activeElement;
    const typing = active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);
    if (!typing && !document.getElementById('modal-root').innerHTML) render();
    if ((state.view === 'performance' || state.view === 'overview') && !typing) refreshAnalytics();
  });

  api.onShortcut((action) => {
    if (!action) return;
    const text = String(action);
    if (text.startsWith('navigate:')) return setView(text.slice(9));
    switch (text) {
      case 'palette': openPalette(); break;
      case 'refresh': refreshAll(); break;
      case 'settings': setView('settings'); break;
      case 'evaluate': evaluateRules(); break;
      case 'toggle-theme': toggleTheme(); break;
      case 'export': exportData(); break;
      case 'import': document.getElementById('import-file').click(); break;
      case 'help':
        openModal('<div class="modal-head"><h2>Keyboard shortcuts</h2><button class="btn btn-icon btn-small" data-action="close-modal">✕</button></div><div class="modal-body"><div class="tiny" style="line-height:2">Ctrl K palette · Ctrl 1–7 views · Ctrl , settings · Ctrl Shift T theme · Ctrl Shift R refresh · Esc close</div></div><div class="modal-foot"><button class="btn btn-subtle" data-action="close-modal">Close</button></div>');
        break;
      case 'about': setView('settings'); break;
      default: break;
    }
  });

  applyTheme();
  loadCore().then(() => {
    call(() => api.app.info(), null).then((info) => { state.appInfo = info || {}; if (state.view === 'settings') render(); });
    if (state.view === 'changelog') loadBundled();
    render();
  });
})();
