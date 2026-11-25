#!/usr/bin/env node
'use strict';
// Downloads, verifies, caches and starts the matching cinnamon desktop build.
// Zero dependencies; public GitHub release assets only.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { https } = require('https');

const VERSION = require('../package.json').version;
const REPO = '404henryyynotfound/cinnamon';

function platformName() {
  switch (process.platform) {
    case 'linux': return 'linux';
    case 'darwin': return 'macos';
    case 'win32': return 'windows';
    default: return process.platform;
  }
}

function archName() {
  if (process.arch === 'x64' || process.arch === 'x86_64') return 'x64';
  if (process.arch === 'arm64' || process.arch === 'aarch64') return 'arm64';
  return process.arch;
}

function assetName() {
  const osName = platformName();
  const arch = archName();
  if (osName === 'windows') return `cinnamon-windows-${arch}.zip`;
  if (osName === 'macos') return `cinnamon-macos-${arch}.zip`;
  return `cinnamon-linux-${arch}.tar.gz`;
}

function cacheRoot() {
  return process.env.CINNAMON_HOME || path.join(os.homedir(), '.cinnamon');
}

function baseUrl(version) {
  return `https://github.com/${REPO}/releases/download/v${version}`;
}

function request(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    https.get(url, { headers: { 'User-Agent': `cinnamon-gui/${VERSION}` } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        return resolve(request(next, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      resolve(res);
    }).on('error', reject);
  });
}

async function download(url, destination) {
  const res = await request(url);
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination, { mode: 0o755 });
    res.pipe(file);
    file.on('finish', () => file.close(resolve));
    file.on('error', reject);
    res.on('error', reject);
  });
}

async function fetchText(url) {
  const res = await request(url);
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function verify(file, checksumUrl) {
  const text = await fetchText(checksumUrl);
  const expected = (text.match(/[a-f0-9]{64}/i) || [])[0];
  if (!expected) throw new Error(`No checksum found in ${checksumUrl}`);
  const actual = sha256(file);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Checksum mismatch for ${path.basename(file)}`);
  }
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code || 0));
  });
}

async function extract(archive, dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (archive.endsWith('.tar.gz')) {
    return runCommand('tar', ['-xzf', archive, '--strip-components=1', '-C', dir]);
  }
  if (archive.endsWith('.zip')) {
    if (process.platform === 'win32') {
      return runCommand('powershell', ['-NoProfile', '-Command',
        `Expand-Archive -Force -Path "${archive}" -DestinationPath "${dir}"`]);
    }
    return runCommand('unzip', ['-o', '-q', archive, '-d', dir]);
  }
  throw new Error(`Unsupported archive: ${archive}`);
}

function findLauncher(dir) {
  const candidates = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (/\.(exe|AppImage|app)$/.test(entry.name) || entry.name === 'cinnamon') {
        if (!/uninstall|helper|elevate/i.test(entry.name)) candidates.push(full);
      }
    }
  };
  walk(dir);
  candidates.sort((a, b) => (a.includes('cinnamon') ? -1 : 1) - (b.includes('cinnamon') ? -1 : 1));
  const chosen = candidates.find((file) => {
    if (process.platform !== 'win32') {
      try { fs.accessSync(file, fs.constants.X_OK); return true; } catch (_) { return false; }
    }
    return true;
  });
  if (!chosen) throw new Error('No cinnamon executable found in the downloaded archive');
  return chosen;
}

async function main(argv) {
  if (argv.includes('--version')) { console.log(VERSION); return 0; }
  const requested = (argv.find((a) => /^\d+\.\d+\.\d+$/.test(a)) || VERSION);
  const osName = platformName();
  const arch = archName();
  const asset = assetName();
  const url = `${baseUrl(requested)}/${asset}`;
  const dir = path.join(cacheRoot(), requested, `${osName}-${arch}`);
  const marker = path.join(dir, '.verified');

  if (argv.includes('--dry-run')) {
    console.log(JSON.stringify({ version: requested, platform: osName, arch, asset, url, dir }, null, 2));
    return 0;
  }

  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, asset);
  if (!fs.existsSync(marker)) {
    const part = `${archive}.part`;
    console.log(`Downloading ${asset}...`);
    await download(url, part);
    await verify(part, `${url}.sha256`);
    fs.renameSync(part, archive);
    await extract(archive, dir);
    fs.writeFileSync(marker, new Date().toISOString());
  }

  const launcher = findLauncher(dir);
  return runCommand(launcher, argv.filter((a) => !a.startsWith('--')));
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`cinnamon: ${error && error.message ? error.message : error}\n`);
  process.exitCode = 1;
});
