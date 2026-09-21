// Compiles the small Windows helper programs with the .NET Framework compiler that
// ships with Windows (no SDK needed). Each build is skipped when nothing changed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WINMD = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WinMetadata');

// audio: keys + Windows audio. media: media sessions (Spotify etc). vr: SteamVR battery. overlay: the SteamVR overlay.
const TARGETS = {
  audio: {
    exe: 'vrmd-helper.exe',
    sources: ['src/helper/Helper.cs'],
    refs: ['System.Web.Extensions.dll'],
  },
  media: {
    exe: 'vrmd-media.exe',
    sources: ['src/helper/MediaHelper.cs'],
    refs: ['System.Web.Extensions.dll', 'System.Runtime.dll', path.join(WINMD, 'Windows.Media.winmd'), path.join(WINMD, 'Windows.Storage.winmd'), path.join(WINMD, 'Windows.Foundation.winmd')],
  },
  vr: {
    exe: 'vrmd-vr.exe',
    sources: ['src/helper/VrHelper.cs', 'vendor/openvr/openvr_api.cs'],
    refs: ['System.Web.Extensions.dll'],
    flags: ['/platform:x64'], // openvr_api.dll is 64-bit
    copy: ['vendor/openvr/openvr_api.dll'],
  },
  // voicemeeter: controls Voicemeeter through its official Remote API (the DLL comes with Voicemeeter, nothing is bundled).
  voicemeeter: {
    exe: 'vrmd-voicemeeter.exe',
    sources: ['src/helper/VoiceMeeter.cs'],
    refs: ['System.Web.Extensions.dll'],
    flags: ['/platform:x64'],
    copy: [],
  },
  // overlay: puts the app's picture into SteamVR and reports laser clicks back.
  overlay: {
    exe: 'vrmd-overlay.exe',
    sources: ['src/helper/VrOverlay.cs', 'vendor/openvr/openvr_api.cs'],
    refs: ['System.Web.Extensions.dll'],
    flags: ['/platform:x64'],
    copy: ['vendor/openvr/openvr_api.dll'],
  },
};

function cscPath() {
  const win = process.env.WINDIR || 'C:\\Windows';
  for (const dir of ['Framework64', 'Framework']) {
    const p = path.join(win, 'Microsoft.NET', dir, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Could not find the .NET Framework compiler (csc.exe).');
}

// The program's file name includes a fingerprint of its source, so an update is a new file.
// That way a still-running older copy (locked by Windows) can never block an update.
function buildHelper(outDir, kind = 'audio') {
  const t = TARGETS[kind];
  if (!t) throw new Error(`Unknown helper "${kind}"`);
  fs.mkdirSync(outDir, { recursive: true });
  const files = [...t.sources, ...(t.copy || [])].map((f) => path.join(ROOT, f));
  const hash = crypto.createHash('sha256');
  for (const f of files) hash.update(fs.readFileSync(f));
  hash.update(JSON.stringify([t.refs, t.flags]));
  const digest = hash.digest('hex');
  const base = t.exe.replace(/\.exe$/, '');
  const exe = path.join(outDir, `${base}-${digest.slice(0, 10)}.exe`);
  const dllsPresent = (t.copy || []).every((f) => fs.existsSync(path.join(outDir, path.basename(f))));
  if (fs.existsSync(exe) && dllsPresent) return exe;

  // Compile from real files on disk: the compiler cannot read from inside an Electron .asar archive.
  const srcDir = path.join(outDir, `src-${kind}`);
  fs.mkdirSync(srcDir, { recursive: true });
  const local = t.sources.map((s) => {
    const dest = path.join(srcDir, path.basename(s));
    fs.writeFileSync(dest, fs.readFileSync(path.join(ROOT, s)));
    return dest;
  });
  for (const c of t.copy || []) {
    const src = fs.readFileSync(path.join(ROOT, c));
    const dest = path.join(outDir, path.basename(c));
    // A DLL that is already in place (and possibly in use by a running helper) is left alone.
    if (!fs.existsSync(dest) || !fs.readFileSync(dest).equals(src)) fs.writeFileSync(dest, src);
  }
  try {
    execFileSync(cscPath(), ['/nologo', '/target:exe', '/optimize+', ...(t.flags || []), `/out:${exe}`, ...t.refs.map((r) => `/r:${r}`), ...local], { stdio: 'pipe' });
  } catch (err) {
    const out = (err.stdout || '').toString() + (err.stderr || '').toString();
    throw new Error(`Helper "${kind}" build failed:\n${out || err.message}`);
  }
  // Tidy up older builds; ones still running are locked, so those are simply skipped.
  for (const f of fs.readdirSync(outDir)) {
    if (f !== path.basename(exe) && new RegExp(`^${base}(-[0-9a-f]{10})?\\.exe(\\.hash)?$`).test(f)) {
      try { fs.unlinkSync(path.join(outDir, f)); } catch { /* still running */ }
    }
  }
  return exe;
}

module.exports = { buildHelper, TARGETS };

if (require.main === module) {
  const out = path.join(ROOT, '.helper-build');
  for (const kind of Object.keys(TARGETS)) console.log('Built', buildHelper(out, kind));
}
