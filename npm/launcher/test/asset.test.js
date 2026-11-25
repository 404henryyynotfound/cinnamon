'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const launcher = require('../bin/cinnamon.js');

const COMBINATIONS = [
  ['darwin', 'x64', 'macos', 'x64', 'cinnamon-macos-x64.zip'],
  ['darwin', 'arm64', 'macos', 'arm64', 'cinnamon-macos-arm64.zip'],
  ['win32', 'x64', 'windows', 'x64', 'cinnamon-windows-x64.zip'],
  ['win32', 'arm64', 'windows', 'arm64', 'cinnamon-windows-arm64.zip'],
  ['linux', 'x64', 'linux', 'x64', 'cinnamon-linux-x64.tar.gz'],
  ['linux', 'arm64', 'linux', 'arm64', 'cinnamon-linux-arm64.tar.gz']
];

async function dryRun(platform, arch, version = '1.0.0') {
  const saved = {
    platform: process.env.CINNAMON_PLATFORM,
    arch: process.env.CINNAMON_ARCH,
    version: process.env.CINNAMON_VERSION
  };
  process.env.CINNAMON_PLATFORM = platform;
  process.env.CINNAMON_ARCH = arch;
  process.env.CINNAMON_VERSION = version;
  const original = console.log;
  const lines = [];
  console.log = (line) => { lines.push(line); };
  try {
    const code = await launcher.main(['--dry-run']);
    assert.equal(code, 0);
    assert.equal(lines.length, 1);
    return JSON.parse(lines[0]);
  } finally {
    console.log = original;
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[`CINNAMON_${key.toUpperCase()}`];
      else process.env[`CINNAMON_${key.toUpperCase()}`] = saved[key];
    }
  }
}

for (const [platform, arch, expectedOs, expectedArch, asset] of COMBINATIONS) {
  test(`--dry-run selects ${asset} without downloading`, async () => {
    const result = await dryRun(platform, arch);
    assert.equal(result.platform, expectedOs);
    assert.equal(result.arch, expectedArch);
    assert.equal(result.asset, asset);
    assert.equal(result.version, '1.0.0');
    assert.equal(
      result.url,
      `https://github.com/404henryyynotfound/cinnamon/releases/download/v1.0.0/${asset}`
    );
    assert.equal(result.dir.endsWith(`/${expectedOs}-${expectedArch}`), true);
  });
}

test('accepted platform and architecture aliases normalize', () => {
  process.env.CINNAMON_PLATFORM = 'osx';
  process.env.CINNAMON_ARCH = 'aarch64';
  try {
    assert.equal(launcher.platformName(), 'macos');
    assert.equal(launcher.archName(), 'arm64');
    assert.equal(launcher.assetName(), 'cinnamon-macos-arm64.zip');
  } finally {
    delete process.env.CINNAMON_PLATFORM;
    delete process.env.CINNAMON_ARCH;
  }
});

test('version environment override is used for the asset URL', async () => {
  const result = await dryRun('linux', 'amd64', '9.9.9');
  assert.equal(result.version, '9.9.9');
  assert.equal(result.asset, 'cinnamon-linux-x64.tar.gz');
});
