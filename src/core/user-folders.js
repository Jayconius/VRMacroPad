// Finds where this PC keeps things, instead of assuming the usual places. Used to fill the {steam},
// {pictures} and {vrchat} shortcuts in folder settings (the Discord and OBS plugins share it). Every lookup is cached and can fail
// quietly (then the shortcut simply matches no folder).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const cache = new Map();
function once(key, fn) {
  if (!cache.has(key)) { let v = ''; try { v = fn() || ''; } catch { v = ''; } cache.set(key, v); }
  return cache.get(key);
}

// Reads one value from the registry: "reg query <key> /v <name>" prints "    name    REG_SZ    value".
function regValue(key, name) {
  if (process.platform !== 'win32') return '';
  const out = execFileSync('reg.exe', ['query', key, '/v', name], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  const m = new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+REG_\\w+\\s+(.+?)\\s*$`, 'mi').exec(out);
  return m ? m[1] : '';
}
const expandVars = (s) => String(s).replace(/%([^%]+)%/g, (m, n) => { const k = Object.keys(process.env).find((e) => e.toLowerCase() === n.toLowerCase()); return k ? process.env[k] : m; });

// The folder Steam is installed in (wherever the user put it).
const steam = () => once('steam', () => {
  const p = regValue('HKCU\\Software\\Valve\\Steam', 'SteamPath');
  return p ? path.normalize(p) : '';
});

// The real Pictures folder (it moves when OneDrive backs up Pictures, or the user relocated it).
const pictures = () => once('pictures', () => {
  const p = regValue('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', 'My Pictures');
  return p ? path.normalize(expandVars(p)) : path.join(process.env.USERPROFILE || '', 'Pictures');
});

// VRChat's screenshot folder: the one named in its own config.json if the user changed it, else Pictures\VRChat.
const vrchat = () => once('vrchat', () => {
  try {
    const cfg = path.join(process.env.USERPROFILE || '', 'AppData', 'LocalLow', 'VRChat', 'VRChat', 'config.json');
    const c = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    if (c && typeof c.picture_output_folder === 'string' && c.picture_output_folder.trim()) {
      const folder = path.normalize(expandVars(c.picture_output_folder.trim()));
      return path.basename(folder).toLowerCase() === 'vrchat' ? folder : path.join(folder, 'VRChat'); // VRChat adds its own "VRChat" folder
    }
  } catch { /* no custom setting */ }
  return path.join(pictures(), 'VRChat');
});

// {steam} {pictures} {vrchat} and %ENV% variables -> real text.
// `overrides` ({ steam, vrchat }) are folders typed in Settings; they win over what was detected.
function expandShortcuts(text, overrides = {}) {
  const own = (v) => (String(v || '').trim() ? path.normalize(expandVars(String(v).trim())) : '');
  return expandVars(String(text)
    .replace(/\{steam\}/gi, () => own(overrides.steam) || steam() || '\0none')
    .replace(/\{pictures\}/gi, () => pictures())
    .replace(/\{vrchat\}/gi, () => own(overrides.vrchat) || vrchat()));
}

module.exports = { steam, pictures, vrchat, expandShortcuts, regValue };
