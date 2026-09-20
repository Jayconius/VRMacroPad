// Launches real copies of the app (each scenario in its own throwaway data folder, so your own
// copy is never touched) and checks the "only one copy" behavior end to end.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const electron = require('electron');
const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };

function launch(dir, events, extraEnv = {}) {
  const child = spawn(electron, [root], {
    env: { ...process.env, VRMD_DATA_DIR: dir, VRMD_TEST_EVENTS: events, ...extraEnv },
    stdio: 'ignore',
  });
  const state = { child, exited: false, code: null, startedAt: Date.now(), exitedAt: 0 };
  child.on('exit', (code) => { state.exited = true; state.code = code; state.exitedAt = Date.now(); });
  return state;
}

const readEvents = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const hasEvent = (file, name, pid) => readEvents(file).some((e) => e.event === name && (pid === undefined || e.pid === pid));

async function waitUntil(fn, ms, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(step); }
  return false;
}

function killTree(state) {
  if (state && !state.exited && state.child.pid) spawnSync('taskkill.exe', ['/PID', String(state.child.pid), '/T', '/F'], { stdio: 'ignore' });
}

async function scenario(name, fn) {
  console.log(`\n--- ${name}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrmd-single-'));
  const events = path.join(dir, 'events.jsonl');
  const started = [];
  const start = (env) => { const s = launch(path.join(dir, 'data'), events, env); started.push(s); return s; };
  try { await fn({ dir, events, start }); } catch (err) { check(`${name}: ran without errors`, false, err.message); } finally {
    for (const s of started) killTree(s);
    await sleep(500);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  await scenario('Second launch while the first is running: it hands over and quits, silently', async ({ events, start }) => {
    const a = start();
    check('first copy shows its window', await waitUntil(() => hasEvent(events, 'window-shown', a.child.pid), 40000));
    const b = start();
    check('second launch exits by itself', await waitUntil(() => b.exited, 12000));
    check('second launch exits cleanly (code 0)', b.code === 0, `code ${b.code}`);
    check('...quickly, not after a long wait', b.exitedAt - b.startedAt < 4500, `${b.exitedAt - b.startedAt} ms`);
    check('running copy noticed the second launch and came forward', hasEvent(events, 'second-instance', a.child.pid));
    check('second launch was told "handed over"', hasEvent(events, 'handed-over', b.child.pid));
    check('no "already running" message was needed', !hasEvent(events, 'already-running-dialog'));
    check('first copy is still running (one instance)', !a.exited);
    check('second launch never opened a window', !hasEvent(events, 'window-shown', b.child.pid));
    const c = start();
    check('a third launch is handled the same way', await waitUntil(() => c.exited, 12000) && c.code === 0 && hasEvent(events, 'handed-over', c.child.pid));
  });

  await scenario('Running copy does not respond: the second launch says "already running"', async ({ events, start }) => {
    const a = start({ VRMD_TEST_NO_ACK: '1', VRMD_TEST_DIALOG_OUT: '1' });
    check('first copy shows its window', await waitUntil(() => hasEvent(events, 'window-shown', a.child.pid), 40000));
    const b = start({ VRMD_TEST_DIALOG_OUT: '1' });
    check('second launch gives up and exits', await waitUntil(() => b.exited, 15000));
    const dialog = readEvents(events).find((e) => e.event === 'already-running-dialog' && e.pid === b.child.pid);
    check('it shows the "already running" message', Boolean(dialog));
    check('the message says what to do', Boolean(dialog) && /already running/.test(dialog.message) && /taskbar|tray/.test(dialog.message));
    check('it waited a few seconds first, not instantly', b.exitedAt - b.startedAt >= 4500, `${b.exitedAt - b.startedAt} ms`);
    check('first copy is still running', !a.exited);
  });

  await scenario('Second launch arrives while the first is still starting up', async ({ events, start }) => {
    const a = start();
    await sleep(250); // long before the first window exists
    const b = start();
    check('first copy still comes up with its window', await waitUntil(() => hasEvent(events, 'window-shown', a.child.pid), 40000));
    check('second launch is answered once the window is up', await waitUntil(() => b.exited, 15000) && b.code === 0);
    check('it was handed over, not shown an error', hasEvent(events, 'handed-over', b.child.pid) && !hasEvent(events, 'already-running-dialog'));
    check('still just one copy running', !a.exited);
  });

  const failed = results.filter((r) => !r).length;
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll single-instance checks passed');
  process.exit(failed ? 1 : 0);
})();
