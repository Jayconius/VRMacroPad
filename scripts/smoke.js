// Launches the real desktop app once, checks it came up correctly, and exits.
// Uses a throwaway data folder, so it never touches your real layout.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const electron = require('electron'); // path to the electron binary
const root = path.join(__dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'vrmd-smoke-'));
const out = path.join(data, 'smoke.json');

const res = spawnSync(electron, [root, '--smoke'], {
  env: { ...process.env, VRMD_DATA_DIR: path.join(data, 'data'), VRMD_SMOKE_OUT: out },
  stdio: 'inherit',
  timeout: 60000,
});

let facts = null;
try { facts = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* reported below */ }
fs.rmSync(data, { recursive: true, force: true });

if (!facts) {
  console.error(`Smoke test failed: app did not report (exit ${res.status}).`);
  process.exit(1);
}
console.log(facts);
const checks = {
  'window opened': facts.title === 'VR Macro Pad',
  'UI connected and rendered buttons': facts.connected && facts.buttonsRendered > 0,
  'Windows helper running': facts.helperStatus === 'ok',
  'tray icon created': facts.trayCreated,
  'window is borderless (no title bar)': facts.frameless,
  'custom minimize / maximize / close buttons shown': facts.windowControlsShown === 3,
  'window keeps a taskbar button (app-window style, not a tool window)': facts.appWindowStyle && facts.notToolWindow,
  'window does not steal focus by default': facts.noActivateOnByDefault,
  'focus allowed while a dialog is open': facts.noActivateOffWhileDialogOpen,
  'no-steal and taskbar button restored after dialog': facts.noActivateBackOnAfterDialog && facts.appWindowKeptAfterDialog,
};
let failed = 0;
for (const [name, ok] of Object.entries(checks)) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
