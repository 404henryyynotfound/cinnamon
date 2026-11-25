'use strict';

/**
 * Pure changelog helpers. Parses Keep-a-Changelog markdown into structured
 * releases and merges bundled notes with GitHub releases without duplicates.
 */

const KNOWN_SECTIONS = Object.freeze(['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']);

function canonicalSection(name) {
  const text = String(name || '').trim();
  const found = KNOWN_SECTIONS.find((section) => section.toLowerCase() === text.toLowerCase());
  return found || text || 'Notes';
}

/** Parse `### Added` style sections and their bullet items from a markdown block. */
function parseSections(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const sections = [];
  let current = null;
  for (const line of lines) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { name: canonicalSection(heading[1]), items: [] };
      sections.push(current);
      continue;
    }
    const item = /^(\s*)[-*]\s+(.+)$/.exec(line);
    if (item && current) {
      const entry = { text: item[2].trim(), children: [] };
      if (item[1].length >= 2 && current.items.length) {
        current.items[current.items.length - 1].children.push(entry.text);
      } else {
        current.items.push(entry);
      }
      continue;
    }
    if (current && current.items.length && /^\s{2,}\S/.test(line) && line.trim()) {
      current.items[current.items.length - 1].text += ` ${line.trim()}`;
    }
  }
  return sections.map((section) => ({
    name: section.name,
    items: section.items.map((entry) => ({ text: entry.text.trim(), children: entry.children.map((child) => String(child).trim()) }))
  }));
}

function versionKey(value) {
  return String(value || 'unreleased').trim().replace(/^v/i, '').toLowerCase();
}

function flatten(sections) {
  return sections.reduce((all, section) => all.concat(section.items.map((item) => ({
    section: section.name, text: item.text, children: item.children.slice()
  }))), []);
}

/** Parse a full Keep-a-Changelog document into releases. */
function parseChangelog(markdown) {
  const text = String(markdown || '');
  const lines = text.split(/\r?\n/);
  const releases = [];
  let intro = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    const raw = current.lines.join('\n').trim();
    const sections = parseSections(raw);
    releases.push({
      version: current.version,
      date: current.date,
      sections,
      items: flatten(sections),
      source: 'bundled',
      url: null,
      raw
    });
    current = null;
  };

  for (const line of lines) {
    const heading = /^##\s+(?:\[([^\]]+)\]|([^\s\[]+))(?:\s*-\s*(\d{4}-\d{2}-\d{2}))?/.exec(line);
    if (heading) {
      flush();
      current = { version: heading[1] || heading[2] || 'unreleased', date: heading[3] || null, lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
    else if (line.trim()) intro.push(line.trim());
  }
  flush();

  releases.sort((a, b) => {
    if (a.date && b.date && a.date !== b.date) return b.date.localeCompare(a.date);
    return String(b.version).localeCompare(String(a.version), undefined, { numeric: true });
  });
  releases.intro = intro.join('\n');
  return releases;
}

/** Convert a GitHub release payload into the same shape as bundled releases. */
function fromGithubRelease(release) {
  if (!release || typeof release !== 'object') return null;
  const version = String(release.tag_name || release.version || release.name || 'unreleased').trim();
  const date = String(release.published_at || release.created_at || '').slice(0, 10) || null;
  const body = String(release.body || '');
  let sections = parseSections(body);
  if (!sections.length && body.trim()) {
    sections = [{ name: 'Notes', items: [{ text: body.trim().split(/\r?\n/)[0].replace(/^#+\s*/, ''), children: [] }] }];
  }
  return {
    version: version.replace(/^v/i, ''),
    tag: version,
    date,
    sections,
    items: flatten(sections),
    source: 'github',
    url: String(release.html_url || release.url || '') || null,
    raw: body
  };
}

/** Human-readable release notes from one or more structured releases. */
function formatReleaseNotes(releases, options = {}) {
  const list = (Array.isArray(releases) ? releases : []).slice(0, options.max || Infinity);
  return list.map((release) => {
    const block = [`## ${release.version}${release.date ? ` - ${release.date}` : ''}`];
    for (const section of release.sections || []) {
      block.push(`### ${section.name}`);
      for (const item of section.items || []) {
        block.push(`- ${item.text}`);
        for (const child of item.children || []) block.push(`  - ${child}`);
      }
    }
    if (release.url) block.push(`[View on GitHub](${release.url})`);
    return block.join('\n');
  }).join('\n\n');
}

/** Combine bundled and GitHub releases, preferring bundled notes on conflicts. */
function mergeSources(bundled, github) {
  const merged = new Map();
  for (const release of Array.isArray(bundled) ? bundled : []) {
    if (!release) continue;
    const key = versionKey(release.version);
    merged.set(key, { ...release, source: 'bundled' });
  }
  for (const raw of Array.isArray(github) ? github : []) {
    const release = raw && raw.sections ? raw : fromGithubRelease(raw);
    if (!release) continue;
    const key = versionKey(release.version);
    if (!merged.has(key)) {
      merged.set(key, { ...release, source: 'github' });
    } else {
      const existing = merged.get(key);
      existing.githubUrl = release.url || null;
      if (!existing.sections || !existing.sections.length) existing.sections = release.sections;
      existing.items = flatten(existing.sections || []);
    }
  }
  return Array.from(merged.values()).sort((a, b) => {
    if (a.date && b.date && a.date !== b.date) return b.date.localeCompare(a.date);
    return String(b.version).localeCompare(String(a.version), undefined, { numeric: true });
  });
}

module.exports = {
  KNOWN_SECTIONS,
  parseSections,
  parseChangelog,
  fromGithubRelease,
  formatReleaseNotes,
  mergeSources,
  versionKey
};
