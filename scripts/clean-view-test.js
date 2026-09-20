// Launches the REAL desktop app twice to check the "buttons only" view:
//   run A starts normal, then switches to buttons-only from inside the app;
//   run B starts in buttons-only, then switches back.
// "See-through" is measured, not assumed: one screen pixel in an empty corner of the window is compared
// with the same pixel while the window is hidden. A window briefly appears on screen each time.
//   npm run test:clean
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { defaultConfig, normalizeConfig } = require('../src/core/schema');

const electron = require('electron');
const root = path.join(__dirname, '..');
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };

function run(startClean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrmd-clean-'));
  const data = path.join(dir, 'data');
  fs.mkdirSync(data, { recursive: true });
  // One small button in the top-left corner, so the bottom-right corner of the window is empty.
  const cfg = defaultConfig();
  cfg.settings.window.cleanView = startClean;
  cfg.settings.window.width = 640;
  cfg.settings.window.height = 420;
  cfg.pages = [{ id: 'p', name: 'Test', cols: 8, rows: 6, buttons: [{ id: 'b', x: 0, y: 0, w: 1, h: 1, label: 'Hi', color: '#2f855a', steps: [] }] }];
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(normalizeConfig(cfg).config, null, 2));
  const out = path.join(dir, 'smoke.json');
  const res = spawnSync(electron, [root, '--smoke'], {
    env: { ...process.env, VRMD_DATA_DIR: data, VRMD_SMOKE_OUT: out, VRMD_SMOKE_SEETHROUGH: '1' }, stdio: 'inherit', timeout: 90000,
  });
  let facts = null;
  try { facts = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* reported by the caller */ }
  fs.rmSync(dir, { recursive: true, force: true });
  if (!facts) console.error(`The app did not report (exit ${res.status}).`);
  return facts;
}

const a = run(false);
if (a) {
  const before = a.seeThroughBefore; const after = a.seeThroughAfter;
  check('A: a normal window is NOT see-through (control)', before.cleanView === false && before.seeThrough === false, `${before.pixelShown} vs ${before.pixelHidden}`);
  check('A: normal window shows its tools and window buttons', before.exitButtons === 0 && before.windowControls === 3 && before.visibleTopbarButtons >= 3);
  check('A: switching the view rebuilds the window', a.windowRebuilt === true);
  check('A: after switching, the window IS see-through', after.cleanView === true && after.seeThrough === true, `${after.pixelShown} vs ${after.pixelHidden}`);
  check('A: only pages, buttons and the one way back are left', after.exitButtons === 1 && after.pageTabs === 1 && after.visibleTopbarButtons === 0 && after.windowControls === 0 && after.buttonsRendered >= 1);
} else check('A: the app ran', false);

const b = run(true);
if (b) {
  const before = b.seeThroughBefore; const after = b.seeThroughAfter;
  check('B: starting in buttons-only gives a see-through window', before.cleanView === true && before.seeThrough === true, `${before.pixelShown} vs ${before.pixelHidden}`);
  check('B: the buttons and pages are still there', before.buttonsRendered >= 1 && before.pageTabs === 1 && before.exitButtons === 1);
  check('B: switching back rebuilds the window with everything back', b.windowRebuilt === true && after.cleanView === false && after.seeThrough === false && after.windowControls === 3 && after.exitButtons === 0);
} else check('B: the app ran', false);

console.log(results.every(Boolean) ? '\nAll checks passed.' : '\nSome checks FAILED.');
process.exit(results.every(Boolean) ? 0 : 1);
