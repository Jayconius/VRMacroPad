const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const WebSocket = require('ws');
const { createApp } = require('../src/core');
const { normalizeConfig, defaultConfig } = require('../src/core/schema');
const { Updater, compareVersions, parseRepo, githubTrust, launchDetached, INSTALLER_ARGS } = require('../src/core/updater');
const { tempDir, FakeHelper, waitFor, sleep } = require('./helpers');

const REPO = 'Jayconius/VRMacroPad';
const FILE = Buffer.from('MZ pretend this is an exe '.repeat(4000));
const SHA = crypto.createHash('sha256').update(FILE).digest('hex');

// A stand-in for GitHub: the "latest release" answer, and the files it points to.
async function fakeGithub(release, { file = FILE, redirect = false, hits = { api: 0, file: 0 } } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url === `/repos/${REPO}/releases/latest`) {
      hits.api++;
      if (release === 404) { res.writeHead(404).end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(typeof release === 'function' ? release(server.address().port) : release));
      return;
    }
    if (req.url === '/cdn/VR-Macro-Pad-9.9.9-portable.exe' || req.url === '/cdn/VR-Macro-Pad-Setup-9.9.9.exe') {
      hits.file++;
      res.writeHead(200, { 'Content-Length': file.length }).end(file);
      return;
    }
    if (redirect && req.url.startsWith('/releases/')) { res.writeHead(302, { Location: `/cdn/${req.url.split('/').pop()}` }).end(); return; }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.hits = hits;
  const close = server.close.bind(server);
  server.close = () => { close(); server.closeAllConnections(); };
  server.base = `http://127.0.0.1:${server.address().port}`;
  return server;
}

const releaseFor = (tag, { redirect = false, sha = SHA, size = FILE.length } = {}) => (port) => ({
  tag_name: tag,
  body: `Notes for ${tag}\r\n- a thing`,
  assets: [
    { name: 'VR-Macro-Pad-9.9.9-portable.exe', size, digest: sha ? `sha256:${sha}` : undefined, browser_download_url: `http://127.0.0.1:${port}/${redirect ? 'releases' : 'cdn'}/VR-Macro-Pad-9.9.9-portable.exe` },
    { name: 'VR-Macro-Pad-Setup-9.9.9.exe', size, digest: sha ? `sha256:${sha}` : undefined, browser_download_url: `http://127.0.0.1:${port}/${redirect ? 'releases' : 'cdn'}/VR-Macro-Pad-Setup-9.9.9.exe` },
    { name: 'notes.txt', size: 3, browser_download_url: `http://127.0.0.1:${port}/cdn/notes.txt` },
  ],
});

function makeUpdater(server, extra = {}) {
  const dataDir = tempDir();
  const settings = { check: true, skipped: '', ...(extra.settings || {}) };
  const log = { launched: [], quit: 0, skipped: [], shown: [] };
  const updater = new Updater({
    version: '3.0.0',
    githubUrl: `https://github.com/${REPO}`,
    dataDir,
    getSettings: () => settings,
    skip: (v) => { settings.skipped = v; log.skipped.push(v); },
    env: extra.env || { mode: 'portable', portableDir: path.join(dataDir, 'portable-folder'), downloadsDir: path.join(dataDir, 'downloads') },
    apiBase: server.base,
    trust: (u) => u.startsWith(server.base),
    launch: (file, args) => log.launched.push({ file, args }),
    quit: () => { log.quit++; },
    showFile: (f) => log.shown.push(f),
  });
  return { updater, dataDir, settings, log };
}

test('versions: newer, older, same, pre-releases and junk', () => {
  assert.equal(compareVersions('v3.0.1', '3.0.0'), 1);
  assert.equal(compareVersions('3.10.0', '3.9.9'), 1);
  assert.equal(compareVersions('v3.0.0', '3.0.0'), 0);
  assert.equal(compareVersions('2.9.9', '3.0.0'), -1);
  assert.equal(compareVersions('3.1.0', '3.1.0-beta.1'), 1);
  assert.equal(compareVersions('3.1.0-beta.1', '3.1.0'), -1);
  assert.equal(compareVersions('latest', '3.0.0'), null);
  assert.equal(compareVersions('', '3.0.0'), null);
});

test('the repo is read from the GitHub link, and only this repo\'s own https files are trusted', () => {
  assert.equal(parseRepo('https://github.com/Jayconius/VRMacroPad'), REPO);
  assert.equal(parseRepo('https://github.com/Jayconius/VRMacroPad.git/'), REPO);
  assert.equal(parseRepo(''), '');
  assert.equal(parseRepo('http://github.com/a/b'), '');
  const trust = githubTrust(REPO);
  assert.ok(trust(`https://github.com/${REPO}/releases/download/v3.0.1/x.exe`));
  assert.ok(trust('https://release-assets.githubusercontent.com/abc'));
  assert.ok(trust(`https://api.github.com/repos/${REPO}/releases/latest`));
  assert.ok(!trust(`http://github.com/${REPO}/releases/download/v3.0.1/x.exe`), 'plain http is refused');
  assert.ok(!trust('https://github.com/someone-else/VRMacroPad/releases/download/v1/x.exe'), 'another repository is refused');
  assert.ok(!trust('https://evil.example.com/x.exe'));
  assert.ok(!trust('https://githubusercontent.com.evil.example.com/x.exe'));
  assert.ok(!trust('https://api.github.com/repos/other/thing/releases/latest'));
  assert.ok(!trust('not a url'));
});

test('settings: update checking is off by default, and junk falls back to off', () => {
  assert.deepEqual(defaultConfig().settings.updates, { check: false, skipped: '' });
  assert.equal(normalizeConfig({ settings: { updates: { check: 'yes' } } }).config.settings.updates.check, false);
  const on = normalizeConfig({ settings: { updates: { check: true, skipped: ' 3.4.5 ' } } }).config.settings.updates;
  assert.deepEqual(on, { check: true, skipped: '3.4.5' });
});

test('check: a newer release is offered, with notes, link and the file for this kind of copy', async () => {
  const gh = await fakeGithub(releaseFor('v9.9.9'));
  const { updater } = makeUpdater(gh);
  const seen = [];
  updater.on('update', (i) => seen.push(i.status));
  const info = await updater.check({ manual: false });
  assert.equal(info.status, 'available');
  assert.equal(info.latest, '9.9.9');
  assert.equal(info.announce, true);
  assert.equal(info.releaseUrl, `https://github.com/${REPO}/releases/tag/v9.9.9`);
  assert.match(info.notes, /^Notes for v9.9.9\n- a thing$/);
  assert.equal(info.asset.name, 'VR-Macro-Pad-9.9.9-portable.exe', 'a portable copy is offered the portable exe');
  assert.deepEqual(seen.slice(0, 2), ['checking', 'available']);
  gh.close();
});

test('check: an installed copy is offered the Setup, a source copy no file at all', async () => {
  const gh = await fakeGithub(releaseFor('v9.9.9'));
  assert.equal((await makeUpdater(gh, { env: { mode: 'installer' } }).updater.check()).asset.name, 'VR-Macro-Pad-Setup-9.9.9.exe');
  assert.equal((await makeUpdater(gh, { env: { mode: 'manual' } }).updater.check()).asset, null);
  gh.close();
});

test('check: same or older version, or no release yet, is "up to date" and never announced', async () => {
  for (const release of [releaseFor('v3.0.0'), releaseFor('v2.0.0'), 404]) {
    const gh = await fakeGithub(release);
    const { updater } = makeUpdater(gh);
    const info = await updater.check({ manual: true });
    assert.equal(info.status, 'uptodate');
    assert.equal(info.announce, false);
    gh.close();
  }
});

test('check: a broken answer is an error message, not a crash or a pop-up', async () => {
  const gh = await fakeGithub(() => ({ tag_name: 'banana', assets: [] }));
  const { updater } = makeUpdater(gh);
  const info = await updater.check({ manual: true });
  assert.equal(info.status, 'error');
  assert.match(info.error, /version number/);
  assert.equal(info.announce, false);
  gh.close();
  const { updater: nobody } = makeUpdater({ base: 'http://127.0.0.1:1' });
  assert.equal((await nobody.check({ manual: true })).status, 'error', 'no connection is an error too');
});

test('skip: a skipped version stays quiet on automatic checks, but "Check now" still shows it, and a newer one comes back', async () => {
  const gh = await fakeGithub(releaseFor('v9.9.9'));
  const { updater, settings, log } = makeUpdater(gh);
  await updater.check({ manual: false });
  updater.skip();
  assert.deepEqual(log.skipped, ['9.9.9']);
  assert.equal(updater.info.status, 'uptodate');
  assert.equal(updater.info.announce, false);
  const auto = await updater.check({ manual: false });
  assert.equal(auto.status, 'uptodate', 'skipped: no pop-up');
  assert.equal(auto.announce, false);
  const manual = await updater.check({ manual: true });
  assert.equal(manual.status, 'available', 'asking by hand shows it');
  gh.close();
  const gh2 = await fakeGithub(releaseFor('v10.0.0'));
  updater.apiBase = gh2.base;
  updater.trust = (u) => u.startsWith(gh2.base);
  updater.set({ status: 'idle' });
  assert.equal((await updater.check({ manual: false })).status, 'available', 'a newer release than the skipped one is announced');
  assert.equal(settings.skipped, '9.9.9');
  gh2.close();
});

test('portable: the download lands next to the running exe, verified, and the old one is untouched', async () => {
  const hits = { api: 0, file: 0 };
  const gh = await fakeGithub(releaseFor('v9.9.9', { redirect: true }), { redirect: true, hits });
  const { updater, dataDir, log } = makeUpdater(gh);
  const folder = path.join(dataDir, 'portable-folder');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'VR-Macro-Pad-3.0.0-portable.exe'), 'the old one');
  await updater.check();
  const progress = [];
  updater.on('update', (i) => { if (i.status === 'downloading') progress.push(i.progress); });
  const done = await updater.download();
  assert.equal(done.status, 'ready');
  assert.equal(done.file, path.join(folder, 'VR-Macro-Pad-9.9.9-portable.exe'));
  assert.deepEqual(fs.readFileSync(done.file), FILE);
  assert.equal(fs.readFileSync(path.join(folder, 'VR-Macro-Pad-3.0.0-portable.exe'), 'utf8'), 'the old one');
  assert.deepEqual(fs.readdirSync(folder).sort(), ['VR-Macro-Pad-3.0.0-portable.exe', 'VR-Macro-Pad-9.9.9-portable.exe'], 'no half-finished .part file is left');
  assert.equal(hits.file, 1, 'the redirect was followed');
  // "Quit and open the new version" starts the new exe with no options, then quits.
  updater.install();
  assert.deepEqual(log.launched, [{ file: done.file, args: [] }]);
  assert.equal(log.quit, 1);
  updater.reveal();
  assert.deepEqual(log.shown, [done.file]);
  gh.close();
});

test('portable: if the exe\'s own folder cannot be written, the Downloads folder is used', async () => {
  const gh = await fakeGithub(releaseFor('v9.9.9'));
  const { updater, dataDir } = makeUpdater(gh);
  const blocked = path.join(dataDir, 'a-file-not-a-folder');
  fs.writeFileSync(blocked, 'x');
  updater.env.portableDir = path.join(blocked, 'inside'); // cannot be created: its parent is a file
  await updater.check();
  const done = await updater.download();
  assert.equal(done.status, 'ready');
  assert.equal(path.dirname(done.file), path.join(dataDir, 'downloads'));
  gh.close();
});

test('installer: the Setup goes to the data folder, and "Install and restart" runs it quietly, then quits', async () => {
  const gh = await fakeGithub(releaseFor('v9.9.9'));
  const { updater, dataDir, log } = makeUpdater(gh, { env: { mode: 'installer' } });
  await updater.check();
  const done = await updater.download();
  assert.equal(done.status, 'ready');
  assert.equal(done.file, path.join(dataDir, 'updates', 'VR-Macro-Pad-Setup-9.9.9.exe'));
  assert.equal(updater.install(), true);
  assert.deepEqual(log.launched, [{ file: done.file, args: INSTALLER_ARGS }]);
  assert.deepEqual(INSTALLER_ARGS, ['/S', '--updated', '--force-run']);
  assert.equal(log.quit, 1);
  gh.close();
});

test('a download that does not match its checksum or size is thrown away, and can be retried', async () => {
  const gh = await fakeGithub(releaseFor('v9.9.9', { sha: 'a'.repeat(64) }));
  const { updater, dataDir } = makeUpdater(gh);
  await updater.check();
  const bad = await updater.download();
  assert.equal(bad.status, 'available', 'back to "available" so it can be tried again');
  assert.match(bad.error, /checksum/);
  const folder = path.join(dataDir, 'portable-folder');
  assert.deepEqual(fs.existsSync(folder) ? fs.readdirSync(folder) : [], [], 'nothing is left behind');
  assert.throws(() => updater.install(), /no downloaded update/);
  gh.close();

  const gh2 = await fakeGithub(releaseFor('v9.9.9', { size: FILE.length + 5 }));
  const { updater: u2 } = makeUpdater(gh2);
  await u2.check();
  const short = await u2.download();
  assert.equal(short.status, 'available');
  assert.match(short.error, /cut short/);
  gh2.close();

  const gh3 = await fakeGithub(releaseFor('v9.9.9', { size: 100 }));
  const { updater: u3 } = makeUpdater(gh3);
  await u3.check();
  assert.match((await u3.download()).error, /bigger than expected/);
  gh3.close();
});

test('nothing is downloaded from an address that is not trusted, or for a file name that could escape', async () => {
  const gh = await fakeGithub((port) => ({
    tag_name: 'v9.9.9',
    assets: [
      { name: '..\\..\\evil-portable.exe', size: 10, browser_download_url: `http://127.0.0.1:${port}/cdn/VR-Macro-Pad-9.9.9-portable.exe` },
      { name: 'x-portable.exe', size: 10, browser_download_url: 'https://evil.example.com/x-portable.exe' },
    ],
  }));
  const { updater } = makeUpdater(gh);
  const info = await updater.check();
  assert.equal(info.status, 'available');
  assert.equal(info.asset, null, 'no usable file, so only the link is offered');
  assert.equal((await updater.download()).status, 'available');
  assert.throws(() => updater.install(), /no downloaded update/);
  gh.close();
});

test('a copy running from source cannot install, and install needs a finished download', async () => {
  const gh = await fakeGithub(releaseFor('v9.9.9'));
  const { updater } = makeUpdater(gh, { env: { mode: 'manual' } });
  await updater.check();
  assert.equal((await updater.download()).status, 'available', 'no file offered, so nothing happens');
  assert.throws(() => updater.install(), /no downloaded update/);
  gh.close();
});

test('the schedule only runs while "Check for updates" is on, and never asks GitHub when it is off', async () => {
  const hits = { api: 0, file: 0 };
  const gh = await fakeGithub(releaseFor('v9.9.9'), { hits });
  const { updater, settings } = makeUpdater(gh, { settings: { check: false } });
  updater.sync();
  assert.equal(updater.timer, null, 'off: no timer');
  settings.check = true;
  updater.sync();
  assert.ok(updater.timer, 'on: a timer is running');
  settings.check = false;
  updater.sync();
  assert.equal(updater.timer, null, 'off again: stopped');
  await sleep(50);
  assert.equal(hits.api, 0);
  gh.close();
});

test('launcher: starts the program a moment later with the given options, and refuses risky paths', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const dir = tempDir();
  const marker = path.join(dir, 'ran.txt');
  const bat = path.join(dir, 'fake installer.cmd');
  fs.writeFileSync(bat, `@echo off\r\necho %* > "${marker}"\r\n`);
  const started = Date.now();
  launchDetached(bat, ['/S', '--updated', '--force-run'], { delaySec: 1 });
  assert.ok(Date.now() - started < 500, 'it returns at once (it does not wait for the program)');
  await waitFor(() => fs.existsSync(marker), 8000, 50);
  assert.match(fs.readFileSync(marker, 'utf8'), /\/S --updated --force-run/);
  assert.throws(() => launchDetached('C:\\a"b\\x.exe'), /cannot be started safely/);
  assert.throws(() => launchDetached('C:\\100%\\x.exe'), /cannot be started safely/);
  assert.throws(() => launchDetached('C:\\ok\\x.exe', ['/S & calc']), /Bad start-up option/);
});

// ---- the whole thing through the app's own server ----
test('the app: off by default (asks nobody), and Check now / Download / Skip work over the socket', async () => {
  const hits = { api: 0, file: 0 };
  const gh = await fakeGithub(releaseFor('v9.9.9'), { hits });
  const dir = tempDir();
  const quits = [];
  const app = createApp({
    dataDir: dir, helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), port: 0,
    twitchOptions: { defaultClientId: '' },
    hooks: { isDesktop: true, quit: () => quits.push(1), updateEnv: { mode: 'installer' } },
    updaterOptions: { apiBase: gh.base, trust: (u) => u.startsWith(gh.base), launch: () => {} },
  });
  const { port } = await app.start();
  try {
    assert.equal(app.engine.config.settings.updates.check, false);
    assert.equal(app.updater.timer, null);
    await sleep(100);
    assert.equal(hits.api, 0, 'nothing asked GitHub');

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${app.token}`);
    const messages = [];
    const waiters = new Map();
    ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); messages.push(m); if (m.t === 'res' && waiters.has(m.rid)) { waiters.get(m.rid)(m); waiters.delete(m.rid); } });
    await new Promise((r) => ws.on('open', r));
    let rid = 1;
    const ask = (t, payload = {}) => new Promise((resolve) => { const id = rid++; waiters.set(id, resolve); ws.send(JSON.stringify({ t, rid: id, ...payload })); });
    const init = await waitFor(() => messages.find((m) => m.t === 'init'));
    assert.equal(init.update.status, 'idle');
    assert.equal(init.config.settings.updates.check, false);

    const checked = await ask('update.check');
    assert.equal(checked.ok, true);
    assert.equal(checked.result.status, 'available');
    assert.equal(hits.api, 1);
    assert.ok(messages.some((m) => m.t === 'update' && m.update.status === 'available'), 'the page is told');

    await ask('update.download');
    await waitFor(() => messages.find((m) => m.t === 'update' && m.update.status === 'ready'));
    assert.equal(fs.readFileSync(path.join(dir, 'updates', 'VR-Macro-Pad-Setup-9.9.9.exe')).length, FILE.length);
    assert.equal((await ask('update.install')).ok, true);
    assert.equal(quits.length, 1);

    // skipping is saved in the settings
    app.updater.set({ status: 'available', announce: true });
    assert.equal((await ask('update.skip')).ok, true);
    assert.equal(app.engine.config.settings.updates.skipped, '9.9.9');
    ws.close();
  } finally {
    await app.stop();
    gh.close();
  }
});

test('the app: install and show-file are desktop-only, and turning the check on starts the schedule', async () => {
  const dir = tempDir();
  const app = createApp({ dataDir: dir, helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), port: 0, twitchOptions: { defaultClientId: '' } });
  const { port } = await app.start();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${app.token}`);
    const waiters = new Map();
    ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.t === 'res' && waiters.has(m.rid)) { waiters.get(m.rid)(m); waiters.delete(m.rid); } });
    await new Promise((r) => ws.on('open', r));
    let rid = 1;
    const ask = (t, payload = {}) => new Promise((resolve) => { const id = rid++; waiters.set(id, resolve); ws.send(JSON.stringify({ t, rid: id, ...payload })); });
    assert.match((await ask('update.install')).error, /desktop app/);
    assert.match((await ask('update.reveal')).error, /desktop app/);
    app.engine.patchSettings((s) => { s.updates.check = true; });
    assert.ok(app.updater.timer, 'switching it on starts the schedule');
    app.engine.patchSettings((s) => { s.updates.check = false; });
    assert.equal(app.updater.timer, null);
    ws.close();
  } finally {
    await app.stop();
  }
});
