// Checks GitHub for a newer release and, when asked, downloads it. Off by default (Settings → General).
//
// It only ever ASKS GitHub "what is the latest release?" (one anonymous request, nothing about you is sent),
// and it downloads nothing until you press Download. What it does after that depends on how you run the app:
//   portable   the new .exe is saved in the same folder as the one you are running (the old one is left alone)
//   installer  the new Setup is downloaded, then "Install and restart" closes this copy, runs it quietly and reopens the app
//   manual     (running from source) nothing is downloaded; you get the link
//
// Downloads are only accepted from this project's own GitHub releases, over https, and are checked against the
// size (and the SHA-256, when GitHub publishes one) before anything runs.
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');

const FIRST_CHECK_MS = 20 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const MAX_NOTES = 1500;
const MAX_REDIRECTS = 5;
const INSTALLER_ARGS = ['/S', '--updated', '--force-run']; // quiet install, then start the app again

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(v || '').trim());
  return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' } : null;
}

// 1 when a is newer than b, -1 when older, 0 when the same, null when either is not a version.
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] > y.n[i] ? 1 : -1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1; // 3.1.0 is newer than 3.1.0-beta
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

function parseRepo(githubUrl) {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(githubUrl || ''));
  return m ? `${m[1]}/${m[2]}` : '';
}

// Who a download may come from: this project's own release files on GitHub (which hands them to its CDN).
function githubTrust(repo) {
  return (url) => {
    let u;
    try { u = new URL(url); } catch { return false; }
    if (u.protocol !== 'https:') return false;
    if (u.hostname === 'api.github.com') return u.pathname.startsWith(`/repos/${repo}/`);
    if (u.hostname === 'github.com') return u.pathname.startsWith(`/${repo}/releases/download/`);
    return u.hostname.endsWith('.githubusercontent.com');
  };
}

// A file name that is safe to create: one plain name, ending .exe.
const SAFE_EXE = /^[\w.\- ]{1,120}\.exe$/i;
const SAFE_TAG = /^[\w.\-+]{1,60}$/;

// Starts a program a few seconds from now, after this app has quit (so an installer never finds the app still running).
function launchDetached(file, args = [], { delaySec = 3 } = {}) {
  if (process.platform !== 'win32') throw new Error('Updating in place is only available on Windows');
  if (/["%^&|<>\r\n]/.test(file)) throw new Error('That file location cannot be started safely');
  if (!args.every((a) => /^[\w/\-=.]+$/.test(a))) throw new Error('Bad start-up option');
  const line = `ping -n ${Math.max(1, delaySec) + 1} 127.0.0.1 >nul & start "" "${file}"${args.length ? ` ${args.join(' ')}` : ''}`;
  const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
  child.on('error', () => {});
  child.unref();
}

class Updater extends EventEmitter {
  // getSettings() -> the "updates" settings ({ check, skipped }); skip(version) remembers a skipped version.
  // env: { mode: 'portable' | 'installer' | 'manual', portableDir, downloadsDir }
  constructor({ version, githubUrl, dataDir, getSettings, skip, env = {}, trust, apiBase = 'https://api.github.com', launch = launchDetached, quit = () => {}, showFile = () => {} }) {
    super();
    this.version = version;
    this.repo = parseRepo(githubUrl);
    this.dataDir = dataDir;
    this.getSettings = getSettings;
    this.skipVersion = skip;
    this.env = { mode: 'manual', ...env };
    this.trust = trust || githubTrust(this.repo);
    this.apiBase = apiBase;
    this.launch = launch;
    this.quit = quit;
    this.showFile = showFile;
    this.timer = null;
    this.busy = false;
    this.info = { status: 'idle', current: version, mode: this.env.mode, announce: false };
    // Files from an earlier update (an installer that has already run) are not needed any more.
    try { for (const f of fs.readdirSync(path.join(dataDir, 'updates'))) fs.unlinkSync(path.join(dataDir, 'updates', f)); } catch { /* none */ }
  }

  set(patch) {
    this.info = { ...this.info, ...patch };
    this.emit('update', this.info);
  }

  // ---- the schedule: only while "Check for updates" is on ----
  sync() {
    const on = Boolean(this.getSettings().check) && Boolean(this.repo);
    if (on && !this.timer) {
      const tick = () => {
        this.check({ manual: false }).catch(() => {});
        this.timer = setTimeout(tick, CHECK_EVERY_MS);
        this.timer.unref();
      };
      this.timer = setTimeout(tick, FIRST_CHECK_MS);
      this.timer.unref();
    } else if (!on && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      if (this.info.status === 'available' || this.info.status === 'uptodate' || this.info.status === 'error') this.set({ status: 'idle', announce: false, error: '' });
    }
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  // ---- asking GitHub ----
  async check({ manual = false } = {}) {
    if (!this.repo) { this.set({ status: 'error', error: 'This copy does not know where its releases are.' }); return this.info; }
    if (this.busy || this.info.status === 'downloading' || this.info.status === 'ready') return this.info;
    this.busy = true;
    const before = this.info;
    this.set({ status: 'checking', error: '' });
    try {
      const release = await this.getJson(`${this.apiBase}/repos/${this.repo}/releases/latest`);
      const tag = String(release && release.tag_name || '');
      const cmp = compareVersions(tag, this.version);
      if (!SAFE_TAG.test(tag) || cmp === null) throw new Error('GitHub answered, but the release has no version number I understand.');
      const checkedAt = Date.now();
      if (cmp <= 0) { this.set({ status: 'uptodate', latest: tag.replace(/^v/, ''), announce: false, checkedAt }); return this.info; }
      const latest = tag.replace(/^v/, '');
      if (!manual && (this.getSettings().skipped || '') === latest) { this.set({ status: 'uptodate', latest, announce: false, skippedVersion: latest, checkedAt }); return this.info; }
      this.set({
        status: 'available', latest, checkedAt, announce: true, skippedVersion: '',
        releaseUrl: `https://github.com/${this.repo}/releases/tag/${tag}`,
        notes: String(release.body || '').replace(/\r/g, '').trim().slice(0, MAX_NOTES),
        asset: this.pickAsset(release.assets || []), file: '', savedTo: '', progress: 0, error: '',
      });
    } catch (err) {
      if (err.status === 404) this.set({ status: 'uptodate', latest: '', announce: false, checkedAt: Date.now(), note: 'No release has been published yet.' });
      else this.set({ status: 'error', error: this.friendly(err), announce: false, latest: before.latest });
    } finally {
      this.busy = false;
    }
    return this.info;
  }

  pickAsset(assets) {
    const want = this.env.mode === 'portable' ? /portable\.exe$/i : this.env.mode === 'installer' ? /setup.*\.exe$/i : null;
    if (!want) return null;
    for (const a of assets) {
      if (!a || !want.test(String(a.name)) || !SAFE_EXE.test(String(a.name)) || !this.trust(String(a.browser_download_url))) continue;
      const size = Number(a.size);
      if (!Number.isFinite(size) || size <= 0) continue;
      const digest = /^sha256:([0-9a-f]{64})$/i.exec(String(a.digest || ''));
      return { name: a.name, url: a.browser_download_url, size, sha256: digest ? digest[1].toLowerCase() : '' };
    }
    return null;
  }

  friendly(err) {
    if (err.status === 403 || err.status === 429) return 'GitHub is limiting requests right now. Try again in a little while.';
    if (err.status) return `GitHub answered with an error (${err.status}).`;
    return err.message || 'Could not reach GitHub.';
  }

  // ---- downloading ----
  async download() {
    const info = this.info;
    if (this.busy || info.status !== 'available' || !info.asset) return this.info;
    this.busy = true;
    this.set({ status: 'downloading', progress: 0, error: '' });
    const asset = info.asset;
    let last = 0;
    try {
      const dir = this.env.mode === 'portable' ? this.portableDestination() : path.join(this.dataDir, 'updates');
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, asset.name);
      await this.fetchTo(asset.url, `${dest}.part`, asset, (p) => {
        const now = Date.now();
        if (now - last > 250) { last = now; this.set({ progress: p }); }
      });
      fs.renameSync(`${dest}.part`, dest);
      this.set({ status: 'ready', progress: 1, file: dest, savedTo: dir });
    } catch (err) {
      this.set({ status: 'available', progress: 0, error: err.message || 'The download failed.' });
    } finally {
      this.busy = false;
    }
    return this.info;
  }

  // Next to the running portable exe; if that folder cannot be written to (Program Files...), the Downloads folder.
  portableDestination() {
    const tryDir = (d) => {
      if (!d) return null;
      try { fs.mkdirSync(d, { recursive: true }); const probe = path.join(d, `.vrmd-write-test-${process.pid}`); fs.writeFileSync(probe, ''); fs.unlinkSync(probe); return d; } catch { return null; }
    };
    const dir = tryDir(this.env.portableDir) || tryDir(this.env.downloadsDir);
    if (!dir) throw new Error('There is nowhere I can save the new version. Download it from the release page instead.');
    return dir;
  }

  // ---- what happens next ----
  install() {
    const info = this.info;
    if (info.status !== 'ready' || !info.file || !fs.existsSync(info.file)) throw new Error('There is no downloaded update to run.');
    if (this.env.mode === 'manual') throw new Error('This copy cannot update itself.');
    if (fs.statSync(info.file).size !== info.asset.size) throw new Error('The downloaded file is not the right size. Download it again.');
    this.launch(info.file, this.env.mode === 'installer' ? INSTALLER_ARGS : []);
    this.quit();
    return true;
  }

  reveal() {
    if (this.info.file && fs.existsSync(this.info.file)) this.showFile(this.info.file);
    return true;
  }

  skip() {
    const v = this.info.latest;
    if (!v) return this.info;
    this.skipVersion(v);
    this.set({ status: 'uptodate', announce: false, skippedVersion: v });
    return this.info;
  }

  // ---- HTTP ----
  open(url, headers, redirects = 0) {
    return new Promise((resolve, reject) => {
      if (!this.trust(url)) { reject(new Error('That download address is not one I trust.')); return; }
      const lib = url.startsWith('https:') ? https : http;
      const req = lib.get(url, { headers: { 'User-Agent': `VR-Macro-Pad/${this.version}`, ...headers } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirects >= MAX_REDIRECTS) { reject(new Error('Too many redirects.')); return; }
          this.open(new URL(res.headers.location, url).toString(), headers, redirects + 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) { res.resume(); const e = new Error(`HTTP ${res.statusCode}`); e.status = res.statusCode; reject(e); return; }
        resolve(res);
      });
      req.setTimeout(30000, () => req.destroy(new Error('The connection timed out.')));
      req.on('error', reject);
    });
  }

  async getJson(url) {
    const res = await this.open(url, { Accept: 'application/vnd.github+json' });
    const chunks = [];
    let total = 0;
    for await (const c of res) { total += c.length; if (total > 2 * 1024 * 1024) throw new Error('GitHub sent too much data.'); chunks.push(c); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('GitHub sent something I could not read.'); }
  }

  async fetchTo(url, file, asset, onProgress) {
    const res = await this.open(url, { Accept: 'application/octet-stream' });
    const hash = crypto.createHash('sha256');
    let got = 0;
    const out = fs.createWriteStream(file);
    let failure = null;
    try {
      await new Promise((resolve, reject) => {
        res.on('data', (c) => {
          got += c.length;
          if (got > asset.size) { failure = new Error('The file is bigger than expected.'); res.destroy(failure); return; }
          hash.update(c);
          onProgress(got / asset.size);
        });
        res.on('error', (e) => reject(failure || e));
        res.on('aborted', () => reject(failure || new Error('The connection dropped.')));
        out.on('error', reject);
        out.on('finish', resolve);
        res.pipe(out);
      });
      if (got !== asset.size) throw new Error('The download was cut short.');
      if (asset.sha256 && hash.digest('hex') !== asset.sha256) throw new Error('The downloaded file does not match its checksum, so I threw it away.');
    } catch (err) {
      out.destroy();
      try { fs.unlinkSync(file); } catch { /* not there */ }
      throw err;
    }
  }
}

module.exports = { Updater, compareVersions, parseVersion, parseRepo, githubTrust, launchDetached, INSTALLER_ARGS };
