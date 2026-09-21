// Desktop shell: window, tray icon, global hotkeys. All app logic lives in ../core.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, Tray, Menu, globalShortcut, nativeImage, clipboard, shell, screen, dialog, safeStorage } = require('electron');
const { execFileSync } = require('child_process');
const { createApp } = require('../core');
const { makeIconPng } = require('./icon');
const { migrateOldData } = require('./migrate');
const { OverlayManager } = require('./overlay');

// A VR overlay app captures this window. Chromium normally stops painting windows that are
// hidden behind others or minimized, which would freeze the picture inside VR.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const SMOKE = process.argv.includes('--smoke');

// Tests and smoke runs point the app at a throwaway folder; keep the browser profile there too,
// so they can never touch (or lock) the profile of a copy you are actually running.
if (process.env.VRMD_DATA_DIR) app.setPath('userData', path.join(process.env.VRMD_DATA_DIR, 'electron-profile'));

let core = null;
let overlay = null; // the SteamVR overlay (off until switched on in Settings)
let win = null;
let tray = null;
let browserUrl = '';
let quitting = false;
let recreating = false;
let shownTrayHint = false;
let boundsTimer = null;
let focusWanted = false; // true while a dialog with text fields is open in the UI
let lastFrameless = true;
let lastClean = false;
let lastTaskbar = true;

// ---- helpers ----
function hwndString() {
  if (!win) return null;
  const buf = win.getNativeWindowHandle();
  return (buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))).toString();
}

function windowSettings() {
  return core.engine.config.settings.window;
}

// The "buttons only" view is a see-through window, which has to be chosen when the window is built,
// and it has no frame either way.
const isBare = (s) => s.frameless || s.cleanView;

// Applies the two Windows style flags that make this window behave like a good VR panel:
//  - no-activate: clicking it does not take focus from your game (lifted while a dialog is open)
//  - app-window:  keeps a taskbar button, which "no-activate" windows otherwise lose
async function applyStyle() {
  if (!win || win.isDestroyed() || !core || process.platform !== 'win32') return null;
  const s = windowSettings();
  try {
    return await core.helper.call('window.style', { hwnd: hwndString(), noActivate: s.nonActivating && !focusWanted, appWindow: s.showInTaskbar });
  } catch {
    return null; // helper unavailable: the window just behaves like a normal one
  }
}

// wantFocus=true lets the window take keyboard focus (dialogs with text fields).
async function applyFocusable(wantFocus) {
  focusWanted = wantFocus;
  await applyStyle();
  if (wantFocus && win && !win.isDestroyed()) win.focus();
}

function applyWindowSettings() {
  if (!win || win.isDestroyed()) return;
  const s = windowSettings();
  win.setAlwaysOnTop(s.alwaysOnTop, 'floating');
  if (isBare(s) !== lastFrameless || s.cleanView !== lastClean) { recreateWindow(); return; }
  applyStyle().then(() => {
    // The taskbar only notices a changed "app window" flag when the window is shown again.
    if (s.showInTaskbar !== lastTaskbar && win.isVisible()) { win.hide(); win.show(); }
    lastTaskbar = s.showInTaskbar;
  });
  updateTray();
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
}

// ---- only one copy at a time ----
// A second launch asks the running copy to come forward. The running copy confirms by creating a
// small "ack" file; if that never happens (it is hung, or still starting), the second launch tells you
// with a plain message instead of silently doing nothing.
const ACK_WAIT_MS = 5000;
const ACK_NAME = /^vrmd-ack-\d+-\d+$/;
let pendingAcks = [];

// Test seam: lets scripts observe what happened without looking at the screen.
function testLog(event) {
  if (process.env.VRMD_TEST_EVENTS) {
    try { fs.appendFileSync(process.env.VRMD_TEST_EVENTS, `${JSON.stringify({ t: Date.now(), pid: process.pid, ...event })}\n`); } catch { /* ignore */ }
  }
}

// Brings the window to the front. Returns false when there is no window yet (still starting up).
function bringToFront() {
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  // Windows may refuse to hand focus to a background app, so also lift it to the top of the stack.
  const onTop = core ? windowSettings().alwaysOnTop : false;
  win.setAlwaysOnTop(true, 'floating');
  win.moveTop();
  if (!onTop) win.setAlwaysOnTop(false);
  win.flashFrame(true); // taskbar flash in case focus was refused
  setTimeout(() => { if (win && !win.isDestroyed()) win.flashFrame(false); }, 1500);
  return true;
}

function writeAck(file) {
  // Only the ack files second launches create in the temp folder, nothing else.
  if (!file || path.dirname(file) !== os.tmpdir() || !ACK_NAME.test(path.basename(file))) return;
  try { fs.writeFileSync(file, 'ok'); } catch { /* the other copy may already have given up */ }
}

function onSecondInstance(data) {
  testLog({ event: 'second-instance' });
  if (process.env.VRMD_TEST_NO_ACK) return; // simulates a copy that is running but not answering
  const ack = data && data.ackFile;
  if (bringToFront()) writeAck(ack); else pendingAcks.push(ack);
}

function flushPendingAcks() {
  if (!pendingAcks.length) return;
  bringToFront();
  for (const f of pendingAcks) writeAck(f);
  pendingAcks = [];
}

// Runs in the second launch: wait for the running copy to confirm, else say it is already running.
function waitForRunningCopy(ackFile) {
  const started = Date.now();
  const timer = setInterval(() => {
    if (fs.existsSync(ackFile)) {
      clearInterval(timer);
      try { fs.unlinkSync(ackFile); } catch { /* ignore */ }
      testLog({ event: 'handed-over' });
      app.exit(0);
    } else if (Date.now() - started > ACK_WAIT_MS) {
      clearInterval(timer);
      const message = 'VR Macro Pad is already running, but it did not respond.\n\nLook for it in the taskbar or in the system tray (near the clock). If it is stuck, close it from there and start it again.';
      testLog({ event: 'already-running-dialog', message });
      if (!process.env.VRMD_TEST_DIALOG_OUT) dialog.showErrorBox('VR Macro Pad is already running', message);
      app.exit(0);
    }
  }, 100);
}

function toggleWindow() {
  if (win && win.isVisible() && !win.isMinimized()) win.hide(); else showWindow();
}

function toggleEditing() {
  core.engine.setEditing(!core.engine.editing);
}

function toggleOverlayHidden() {
  core.engine.patchSettings((s) => { s.overlay.hidden = !s.overlay.hidden; });
}

function toggleCleanView() {
  core.engine.patchSettings((s) => { s.window.cleanView = !s.window.cleanView; });
}

// The see-through window cannot be resized by its edges, so the page asks for the new size.
function setWindowBounds(b) {
  if (!win || win.isDestroyed() || !windowSettings().cleanView) return;
  const min = { width: 240, height: 140 };
  win.setBounds({ x: b.x, y: b.y, width: Math.max(min.width, b.width), height: Math.max(min.height, b.height) });
}

function quitApp() {
  quitting = true;
  app.quit();
}

// Title-bar buttons drawn by the UI (the window has no frame of its own).
function windowControl(cmd) {
  if (!win || win.isDestroyed()) return;
  if (cmd === 'minimize') win.minimize();
  else if (cmd === 'maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
  else if (cmd === 'close') win.close();
}

// ---- hotkeys ----
// Returns the accelerators that could not be registered.
function registerHotkeys(list) {
  globalShortcut.unregisterAll();
  const failed = [];
  const taken = new Set();
  for (const { accelerator, buttonId } of list) {
    const key = accelerator.toLowerCase();
    if (taken.has(key)) { failed.push(accelerator); continue; }
    taken.add(key);
    try {
      if (!globalShortcut.register(accelerator, () => core.engine.press(buttonId, { source: 'hotkey' }))) failed.push(accelerator);
    } catch {
      failed.push(accelerator);
    }
  }
  const clean = core && core.engine.config ? core.engine.config.settings.window.cleanViewHotkey : '';
  if (clean && !taken.has(clean.toLowerCase())) {
    taken.add(clean.toLowerCase());
    try {
      if (!globalShortcut.register(clean, toggleCleanView)) failed.push(clean);
    } catch {
      failed.push(clean);
    }
  }
  const ovKey = core && core.engine.config ? core.engine.config.settings.overlay.hotkey : '';
  if (ovKey && !taken.has(ovKey.toLowerCase())) {
    taken.add(ovKey.toLowerCase());
    try {
      if (!globalShortcut.register(ovKey, toggleOverlayHidden)) failed.push(ovKey);
    } catch {
      failed.push(ovKey);
    }
  }
  const unlock = core && core.engine.config ? core.engine.config.settings.lock.unlockHotkey : 'Ctrl+Alt+Shift+E';
  if (unlock && !taken.has(unlock.toLowerCase())) {
    try {
      if (!globalShortcut.register(unlock, toggleEditing)) failed.push(unlock);
    } catch {
      failed.push(unlock);
    }
  }
  return failed;
}

// ---- window ----
function visibleBounds(saved) {
  if (saved.x === null || saved.y === null) return { width: saved.width, height: saved.height };
  const inside = screen.getAllDisplays().some((d) => {
    const b = d.workArea;
    return saved.x + 60 > b.x && saved.x < b.x + b.width - 60 && saved.y + 30 > b.y && saved.y < b.y + b.height - 60;
  });
  return inside ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : { width: saved.width, height: saved.height };
}

function saveBoundsSoon() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(saveBoundsNow, 800);
}

function saveBoundsNow() {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
  const b = win.getBounds();
  core.engine.patchSettings((s) => { s.window.x = b.x; s.window.y = b.y; s.window.width = b.width; s.window.height = b.height; }, { broadcast: false });
}

function createWindow(url, forceShow = false) {
  const settings = windowSettings();
  lastFrameless = isBare(settings);
  lastClean = settings.cleanView;
  lastTaskbar = settings.showInTaskbar;
  win = new BrowserWindow({
    ...visibleBounds(settings),
    minWidth: settings.cleanView ? 240 : 320,
    minHeight: settings.cleanView ? 140 : 240,
    frame: !isBare(settings),
    transparent: settings.cleanView,
    hasShadow: !settings.cleanView,
    resizable: !settings.cleanView, // a see-through window has no native edges (the page draws its own)
    title: 'VR Macro Pad',
    icon: nativeImage.createFromBuffer(makeIconPng(256)),
    backgroundColor: settings.cleanView ? '#00000000' : '#12151c',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  win.setMenuBarVisibility(false);

  // The page only ever talks to our own local server.
  const origin = new URL(url).origin;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, target) => { if (new URL(target).origin !== origin) e.preventDefault(); });

  win.once('ready-to-show', async () => {
    await applyStyle(); // before the first show, so the taskbar button is right from the start
    win.setAlwaysOnTop(windowSettings().alwaysOnTop, 'floating');
    // "Start hidden": for people who only use the VR overlay. The window exists (the tray brings it up) but is not shown.
    if (!forceShow && windowSettings().startHidden && tray && !SMOKE) testLog({ event: 'window-kept-hidden' }); else win.show();
    updateTray();
    testLog({ event: 'window-shown' });
    flushPendingAcks(); // a second launch that arrived while we were starting up
  });
  win.on('resize', saveBoundsSoon);
  win.on('move', saveBoundsSoon);
  win.on('close', (e) => {
    if (quitting || recreating) return;
    if (windowSettings().closeToTray) {
      // Hide to the tray so hotkeys and triggers keep working (and VR overlays keep the window).
      e.preventDefault();
      win.hide();
      if (!shownTrayHint && tray && process.platform === 'win32') {
        shownTrayHint = true;
        tray.displayBalloon({ title: 'VR Macro Pad is still running', content: 'It stays in the tray so hotkeys and triggers keep working. Right-click the tray icon to quit.' });
      }
      return;
    }
    saveBoundsNow();
    quitting = true; // closing the window quits the app, like any normal program
  });
  win.loadURL(url);
}

// Frameless and see-through are chosen when the window is created, so changing them means building a new one.
function recreateWindow() {
  if (!win || win.isDestroyed()) return;
  saveBoundsNow();
  recreating = true;
  win.destroy();
  recreating = false;
  createWindow(browserUrl, true); // it is being rebuilt because you are changing its settings: keep it in front of you
}

// ---- tray ----
function updateTray() {
  if (!tray || !core) return;
  const editing = core.engine.editing;
  const onTop = windowSettings().alwaysOnTop;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / hide window', click: toggleWindow },
    { label: 'Start with no window (VR only)', type: 'checkbox', checked: windowSettings().startHidden, click: (item) => core.engine.patchSettings((s) => { s.window.startHidden = item.checked; }) },
    { label: editing ? 'Lock editing' : 'Unlock editing', click: toggleEditing },
    { label: 'Show in SteamVR (overlay)', type: 'checkbox', checked: core.engine.config.settings.overlay.enabled, click: (item) => core.engine.patchSettings((s) => { s.overlay.enabled = item.checked; }) },
    { label: 'Hide / show the overlay', enabled: core.engine.config.settings.overlay.enabled, click: toggleOverlayHidden },
    { label: 'Buttons only (see-through)', type: 'checkbox', checked: windowSettings().cleanView, click: toggleCleanView },
    { label: 'Keep window on top', type: 'checkbox', checked: onTop, click: (item) => core.engine.patchSettings((s) => { s.window.alwaysOnTop = item.checked; }) },
    { type: 'separator' },
    { label: 'Copy browser link', click: () => clipboard.writeText(browserUrl) },
    { label: 'Open in browser', click: () => shell.openExternal(browserUrl) },
    { type: 'separator' },
    { label: 'Quit VR Macro Pad', click: quitApp },
  ]));
}

function createTray() {
  tray = new Tray(nativeImage.createFromBuffer(makeIconPng(64)).resize({ width: 32, height: 32 }));
  tray.setToolTip('VR Macro Pad');
  tray.on('click', toggleWindow);
  updateTray();
}

// ---- smoke test: start, report facts about the running app as JSON, exit ----
// One screen pixel, read back (only used by the see-through check: is the desktop behind the window visible?).
function screenPixel(x, y) {
  const script = `Add-Type -AssemblyName System.Drawing; $b = New-Object System.Drawing.Bitmap 1,1; $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(${x},${y},0,0,$b.Size); $c = $b.GetPixel(0,0); '{0},{1},{2}' -f $c.R,$c.G,$c.B`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
}

// Compares the pixel in an empty corner of the window with the same pixel while the window is hidden.
async function seeThroughProbe() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  await sleep(700);
  const b = win.getBounds();
  const p = screen.dipToScreenPoint({ x: b.x + b.width - 40, y: b.y + b.height - 40 });
  const shown = screenPixel(p.x, p.y);
  win.hide();
  await sleep(700);
  const hidden = screenPixel(p.x, p.y);
  win.showInactive();
  await sleep(500);
  return {
    seeThrough: shown === hidden, pixelShown: shown, pixelHidden: hidden,
    cleanView: windowSettings().cleanView,
    exitButtons: await js("document.querySelectorAll('.clean-exit').length"),
    windowControls: await js("document.querySelectorAll('.win-ctl').length"),
    pageTabs: await js("document.querySelectorAll('.page-tab').length"),
    otherTopbarButtons: await js("document.querySelectorAll('.topbar button:not(.page-tab):not(.clean-exit)').length"),
    visibleTopbarButtons: await js("[...document.querySelectorAll('.topbar button:not(.page-tab):not(.clean-exit)')].filter((b) => b.offsetParent !== null).length"),
    buttonsRendered: await js("document.querySelectorAll('.btn').length"),
  };
}

async function smokeReport(url) {
  const out = process.env.VRMD_SMOKE_OUT;
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 1500)); // let the page connect and render
  const js = (code) => win.webContents.executeJavaScript(code);
  const facts = {
    title: win.getTitle(),
    url: url.replace(/token=[^&]+/, 'token=…'),
    pageTitle: await js('document.title'),
    buttonsRendered: await js("document.querySelectorAll('.btn').length"),
    widgetsRendered: await js("document.querySelectorAll('.btn.widget').length"),
    connected: await js('window.__vrmd.state.ready'),
    hasHost: await js('window.__vrmd.state.app.hasHost'),
    helperStatus: core.helper.status,
    trayCreated: Boolean(tray),
    // Borderless: no title bar means the window and its content area are the same size.
    cleanView: windowSettings().cleanView,
    frameless: win.getBounds().height === win.getContentBounds().height && win.getBounds().width === win.getContentBounds().width,
    windowControlsShown: await js("document.querySelectorAll('.win-ctl').length"),
  };
  // Prove the "does not steal focus" style is really applied, is lifted for dialogs, and that
  // the window keeps its taskbar button (a no-activate window loses it unless flagged).
  const style = await core.helper.call('window.style', { hwnd: hwndString() });
  facts.noActivateOnByDefault = style.noActivate;
  facts.appWindowStyle = style.appWindow;
  facts.notToolWindow = !style.toolWindow;
  await applyFocusable(true);
  facts.noActivateOffWhileDialogOpen = !(await core.helper.call('window.style', { hwnd: hwndString() })).noActivate;
  await applyFocusable(false);
  const after = await core.helper.call('window.style', { hwnd: hwndString() });
  facts.noActivateBackOnAfterDialog = after.noActivate;
  facts.appWindowKeptAfterDialog = after.appWindow;
  if (process.env.VRMD_SMOKE_CAPTURE) {
    // The page's own pixels (with their transparency), for looking at the layout.
    fs.writeFileSync(process.env.VRMD_SMOKE_CAPTURE, (await win.webContents.capturePage()).toPNG());
  }
  if (process.env.VRMD_SMOKE_SEETHROUGH) {
    // Before, then after switching the view from the app itself (which rebuilds the window).
    facts.seeThroughBefore = await seeThroughProbe();
    const oldWin = win;
    core.engine.patchSettings((s) => { s.window.cleanView = !s.window.cleanView; });
    await new Promise((r) => win.webContents.once('did-finish-load', r)); // the new window, built synchronously by the change above
    await new Promise((r) => setTimeout(r, 1500));
    facts.windowRebuilt = win !== oldWin && oldWin.isDestroyed();
    facts.seeThroughAfter = await seeThroughProbe();
  }
  if (out) fs.writeFileSync(out, JSON.stringify(facts, null, 2));
  else console.log(JSON.stringify(facts, null, 2));
}

// ---- startup ----
// Smoke runs use their own throwaway profile and skip the check; a normal launch must be the only one.
const myAckFile = path.join(os.tmpdir(), `vrmd-ack-${process.pid}-${Date.now()}`);
const gotLock = SMOKE ? true : app.requestSingleInstanceLock({ ackFile: myAckFile });

if (!gotLock) {
  waitForRunningCopy(myAckFile);
} else {
  app.on('second-instance', (event, argv, cwd, data) => onSecondInstance(data));
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    try {
      const dataDir = process.env.VRMD_DATA_DIR || app.getPath('userData');
      fs.mkdirSync(dataDir, { recursive: true });
      // The app used to be called "VR Macro Deck": bring its layout and logins along the first time (tests skip this).
      if (!process.env.VRMD_DATA_DIR) migrateOldData(path.join(app.getPath('appData'), 'VR Macro Deck'), dataDir);
      core = createApp({
        dataDir,
        buildDir: path.join(dataDir, 'helper'),
        hooks: {
          isDesktop: true,
          registerHotkeys,
          setFocusable: (on) => applyFocusable(Boolean(on)),
          windowControl,
          setWindowBounds,
          overlayCommand: async (name, args) => { if (!overlay) throw new Error('The overlay is not available'); return overlay.command(name, args); },
          overlayInfo: () => (overlay ? overlay.info() : { state: 'off' }),
          openExternal: (url) => { shell.openExternal(url); return true; },
          // Windows encrypts these with your own account, so a copied file is useless elsewhere.
          secretBox: {
            available: () => safeStorage.isEncryptionAvailable(),
            encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
            decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
          },
        },
      });
      const { url } = await core.start();
      browserUrl = url;
      core.engine.on('edit', updateTray);
      core.engine.on('config', applyWindowSettings);
      overlay = new OverlayManager({ core, url, buildDir: path.join(dataDir, 'helper'), dataDir, BrowserWindow });
      core.engine.on('config', () => { overlay.sync(); updateTray(); });
      overlay.sync();
      createTray();
      createWindow(url);
      if (SMOKE) {
        await smokeReport(url);
        quitApp();
      }
    } catch (err) {
      dialog.showErrorBox('VR Macro Pad could not start', String(err && err.stack ? err.stack : err));
      quitApp();
    }
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (overlay) overlay.stop();
    if (core) core.stop();
  });
  // With "hide to tray" the app keeps running without a window; otherwise closing it quits.
  app.on('window-all-closed', () => { if (quitting && !recreating) app.quit(); });
}
