'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const changelog = require('../lib/changelog.js');

const BUNDLED = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');

test('parseSections canonicalizes headings and keeps nested items', () => {
  const sections = changelog.parseSections([
    '### added',
    '- Live process table',
    '- Safe process actions',
    '  - SIGTERM and SIGKILL',
    '### Fixed',
    '* Network counters reset gracefully'
  ].join('\n'));
  assert.deepEqual(sections.map((section) => section.name), ['Added', 'Fixed']);
  assert.equal(sections[0].items.length, 2);
  assert.deepEqual(sections[0].items[1].children, ['SIGTERM and SIGKILL']);
  assert.equal(sections[1].items[0].text, 'Network counters reset gracefully');
  assert.deepEqual(changelog.parseSections(''), []);
});

test('parseChangelog reads the bundled 1.0.0 Keep-a-Changelog file', () => {
  const releases = changelog.parseChangelog(BUNDLED);
  assert.equal(releases.length, 1);
  assert.equal(releases[0].version, '1.0.0');
  assert.equal(releases[0].date, '2026-11-25');
  assert.deepEqual(releases[0].sections.map((section) => section.name), ['Added', 'Changed', 'Fixed']);
  assert.ok(releases[0].items.some((item) => /live process table/i.test(item.text)));
  assert.ok(releases[0].items.some((item) => /BYOK/i.test(item.text)));
  assert.ok(releases[0].items.some((item) => /SVG/i.test(item.text)));
  assert.ok(releases[0].items.some((item) => /watch rules/i.test(item.text)));
  assert.ok(releases.intro.includes('Keep a Changelog'));
  assert.equal(releases[0].source, 'bundled');
});

test('parseChangelog sorts releases by date and version', () => {
  const text = '## [Unreleased]\n\n### Added\n- next\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n- old\n\n## [1.2.0] - 2026-03-01\n\n### Added\n- newer';
  const releases = changelog.parseChangelog(text);
  assert.deepEqual(releases.map((release) => release.version), ['Unreleased', '1.2.0', '1.0.0']);
  assert.equal(changelog.versionKey('v1.0.0'), '1.0.0');
  assert.equal(changelog.versionKey(null), 'unreleased');
});

test('fromGithubRelease converts release payloads into the same shape', () => {
  const release = changelog.fromGithubRelease({
    tag_name: 'v1.1.0',
    published_at: '2026-12-01T10:00:00Z',
    html_url: 'https://github.com/404henryyynotfound/cinnamon/releases/tag/v1.1.0',
    body: '### Added\n- GitHub notes\n\n### Fixed\n- Offline fallback'
  });
  assert.equal(release.version, '1.1.0');
  assert.equal(release.date, '2026-12-01');
  assert.equal(release.source, 'github');
  assert.deepEqual(release.sections.map((section) => section.name), ['Added', 'Fixed']);
  assert.ok(release.url.includes('github.com'));
  assert.equal(changelog.fromGithubRelease(null), null);
  assert.equal(changelog.fromGithubRelease({ body: 'Plain note' }).sections[0].name, 'Notes');
});

test('formatReleaseNotes renders sections, children and links', () => {
  const notes = changelog.formatReleaseNotes(changelog.parseChangelog(BUNDLED));
  assert.match(notes, /^## 1\.0\.0 - 2026-11-25/);
  assert.match(notes, /### Added/);
  assert.match(notes, /- Live process table/);
  assert.equal(changelog.formatReleaseNotes([], { max: 1 }), '');
});

test('mergeSources combines local and remote notes without duplicates', () => {
  const bundled = changelog.parseChangelog(BUNDLED);
  const remote = [
    changelog.fromGithubRelease({ tag_name: 'v1.0.0', body: '### Added\n- duplicate entry' }),
    changelog.fromGithubRelease({ tag_name: 'v1.1.0', published_at: '2026-12-02', body: '### Fixed\n- newer fix' })
  ];
  const merged = changelog.mergeSources(bundled, remote);
  assert.equal(merged.length, 2);
  const local = merged.find((release) => release.version === '1.0.0');
  assert.equal(local.source, 'bundled');
  assert.ok(local.items.some((item) => /live process table/i.test(item.text)));
  assert.ok(!local.items.some((item) => /duplicate entry/.test(item.text)));
  assert.equal(local.githubUrl, null);
  const newer = merged.find((release) => release.version === '1.1.0');
  assert.equal(newer.source, 'github');
  assert.equal(newer.items[0].text, 'newer fix');
  assert.deepEqual(changelog.mergeSources(null, null), []);
});
