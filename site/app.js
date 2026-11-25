'use strict';
// Small interactions for the cinnamon landing page. No dependencies, no eval.

(function () {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const toggle = document.querySelector('[data-nav-toggle]');
  const nav = document.querySelector('[data-nav]');
  if (toggle && nav) {
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    nav.addEventListener('click', (event) => {
      if (event.target.tagName === 'A') {
        nav.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  document.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      const target = document.querySelector(button.getAttribute('data-copy'));
      if (!target) return;
      const text = target.textContent.trim();
      try {
        await navigator.clipboard.writeText(text);
      } catch (_) {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      }
      const original = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = original; }, 1400);
    });
  });

  // Tiny animated CPU / memory / network sparklines in the hero window.
  const series = {
    cpu: [12, 18, 15, 32, 24, 19, 28, 16, 21, 18],
    mem: [44, 46, 45, 48, 51, 50, 52, 49, 53, 52],
    net: [8, 14, 22, 11, 30, 18, 12, 26, 17, 20]
  };
  const sparks = Array.from(document.querySelectorAll('[data-spark]'));
  function draw(key) {
    const svg = document.querySelector(`[data-spark="${key}"]`);
    if (!svg) return;
    const values = series[key];
    const max = Math.max(...values, 1);
    const points = values.map((value, index) => {
      const x = (index / (values.length - 1)) * 120;
      const y = 32 - (value / max) * 28;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    svg.innerHTML = `<polyline points="${points}"></polyline>`;
  }
  sparks.forEach((svg) => draw(svg.getAttribute('data-spark')));
  if (!reduceMotion) {
    setInterval(() => {
      Object.keys(series).forEach((key) => {
        const values = series[key];
        const last = values[values.length - 1];
        const next = Math.max(3, Math.min(60, last + Math.round((Math.random() - 0.5) * 14)));
        values.shift();
        values.push(next);
        draw(key);
      });
      const cpu = document.querySelector('[data-stat="cpu"]');
      if (cpu) cpu.textContent = `${series.cpu[series.cpu.length - 1]}%`;
    }, 1600);
  }

  // GitHub release changelog with an offline fallback.
  const list = document.getElementById('release-list');
  const fallback = [{
    name: 'v1.0.0',
    body: '- Live process list with CPU and memory usage\n- Safe kill and renice controls with confirmation\n- Inline SVG performance graphs\n- Explainable local AI diagnostics and optional BYOK AI\n- Watcher rules and action history\n- In-app and GitHub changelogs'
  }];
  function render(releases) {
    if (!list) return;
    list.innerHTML = '';
    releases.slice(0, 4).forEach((release) => {
      const item = document.createElement('article');
      item.className = 'release';
      const title = document.createElement('h3');
      title.textContent = `${release.name || release.tag_name || 'Release'}${release.published_at ? ` · ${release.published_at.slice(0, 10)}` : ''}`;
      const items = document.createElement('ul');
      (release.body || 'No notes for this release.')
        .split('\n')
        .map((line) => line.replace(/^[-*]\s*/, '').trim())
        .filter(Boolean)
        .slice(0, 8)
        .forEach((line) => {
          const li = document.createElement('li');
          li.textContent = line.replace(/[*_`]/g, '');
          items.appendChild(li);
        });
      item.append(title, items);
      list.appendChild(item);
    });
  }
  render(fallback);
  if (list && typeof fetch === 'function') {
    fetch('https://api.github.com/repos/404henryyynotfound/cinnamon/releases', {
      headers: { 'User-Agent': 'cinnamon-site' }
    })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('GitHub unavailable')))
      .then((data) => { if (Array.isArray(data) && data.length) render(data); })
      .catch(() => { /* keep the bundled fallback */ });
  }
})();
