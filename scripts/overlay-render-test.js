// Runs the REAL overlay pipeline inside Electron, with a stand-in for the SteamVR helper:
//   the off-screen page is rendered and streamed as pictures, laser events become clicks on it, and what changes
//   on the desktop side shows up in the overlay's pictures. Nothing here touches SteamVR.
//   npm run test:overlay        (invisible windows only; nothing appears on screen)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createApp } = require('../src/core');
const { FakeHelper } = require('../test/helpers');
const { OverlayManager } = require('../src/main/overlay');
const L = require('../src/core/overlay-logic');

process.env.VRMD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vrmd-ovr-'));
app.setPath('userData', path.join(process.env.VRMD_DATA_DIR, 'electron-profile'));

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000, step = 60) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); } return false; }

const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
class FakeOverlayHelper extends EventEmitter {
  constructor() { super(); this.calls = []; this.last = null; this.count = 0; this.pipeConnected = true; this.error = ''; this.grabResult = { grabbed: true, relative: L.fromOffset({ x: 0.1, y: -0.2, z: -0.7, yaw: 20, pitch: -15, roll: 0 }), world: L.fromOffset({ x: 0.5, y: 1.3, z: -1.2, yaw: 45, pitch: -5, roll: 0 }) }; }
  start() { return true; }
  async stop() {}
  async call(op, args = {}) {
    this.calls.push({ op, ...args });
    if (op === 'attach') return { connected: true, error: '', overlay: true, shown: true };
    if (op === 'poses') return { devices: [{ index: 0, class: 'HMD', role: '', valid: true, matrix: L.fromOffset({ x: 1, y: 1.6, z: 2, yaw: 90, pitch: 0, roll: 0 }), controllerType: '', model: '' }, { index: 3, class: 'Controller', role: 'left', valid: true, matrix: IDENT, controllerType: 'knuckles', model: 'Index' }, { index: 4, class: 'Controller', role: 'right', valid: true, matrix: IDENT, controllerType: 'knuckles', model: 'Index' }] };
    if (op === 'grab.stop') return this.grabResult;
    return true;
  }
  sendFrame(w, h, buf, target = 0) {
    if (target === 1) { this.dashLast = { w, h, buf: Buffer.from(buf) }; this.dashCount = (this.dashCount || 0) + 1; return true; }
    this.last = { w, h, buf: Buffer.from(buf) }; this.count++; return true;
  }
  callsOf(op) { return this.calls.filter((c) => c.op === op); }
}

app.on('window-all-closed', () => {}); // closing the off-screen window must not end the test

app.whenReady().then(async () => {
  let core = null; let mgr = null;
  try {
    const helper = new FakeOverlayHelper();
    core = createApp({ dataDir: process.env.VRMD_DATA_DIR, helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), port: 0, twitchOptions: { defaultClientId: '' }, pearOptions: { retryMs: 60000 },
      hooks: { overlayCommand: async (name, args) => mgr.command(name, args), overlayInfo: () => (mgr ? mgr.info() : { state: 'off' }) } });
    const { url } = await core.start();
    const cfg = JSON.parse(JSON.stringify(core.engine.config));
    const btn = (id, x, y, label, color) => ({ id, x, y, w: 2, h: 2, label, icon: '', color, steps: [{ action: 'system.toast', params: { message: `pressed ${id}` }, delayMs: 0 }] });
    cfg.pages = [
      { id: 'one', name: 'Stream', cols: 4, rows: 3, buttons: [btn('a', 0, 0, 'Alpha', '#2f855a'), btn('b', 2, 0, 'Bravo', '#2b6cb0')] },
      { id: 'two', name: 'Games', cols: 4, rows: 3, buttons: [btn('c', 0, 0, 'Charlie', '#b7791f')] },
    ];
    cfg.settings.overlay.enabled = true;
    core.engine.updateConfig(cfg);
    const toasts = [];
    core.engine.on('toast', (t) => toasts.push(t.text));

    mgr = new OverlayManager({ core, url, buildDir: '', dataDir: process.env.VRMD_DATA_DIR, BrowserWindow, createHelper: () => helper });
    core.engine.on('config', () => mgr.sync()); // as the desktop shell does
    mgr.sync();
    const js = (code) => mgr.win.webContents.executeJavaScript(code);
    const rect = (sel, nth = 0) => js(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${nth}]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
    // A laser event aimed at a spot on the page: overlay coordinates start at the BOTTOM left.
    const aim = (p) => ({ x: p.x, y: mgr.frame.h - p.y });
    const laser = (type, p, extra = {}) => helper.emit('event', { ev: 'mouse', type, ...aim(p), button: 1, device: 3, ...extra });
    const clickAt = async (p) => { laser('move', p); await sleep(40); laser('down', p); await sleep(60); laser('up', p); await sleep(120); };

    // ---- 1. it comes up, connects and streams pictures ----
    check('the overlay starts and connects', await until(() => mgr.state === 'connected'), mgr.state);
    check('pictures are streamed at the configured size (1024x640)', await until(() => helper.last && helper.last.w === 1024 && helper.last.h === 640), helper.last ? `${helper.last.w}x${helper.last.h}` : 'none');
    check('the page loaded as the overlay view with its own bar', await until(async () => (await js("document.body.classList.contains('overlay') && document.querySelectorAll('.ov-handle').length === 1")) === true));
    const alphaAt = (f, x, y) => f.buf[(y * f.w + x) * 4 + 3];
    await sleep(500);
    check('the background is see-through (empty corner has zero alpha) and the buttons are solid', alphaAt(helper.last, 1000, 620) === 0 && (await until(async () => { const r = await rect('.btn', 0); return r && alphaAt(helper.last, Math.round(r.x), Math.round(r.y)) === 255; })));
    const pos = helper.callsOf('place').at(-1);
    const props = helper.callsOf('props').at(-1);
    check('the panel is placed in front of the head at 0.7 m wide', pos && pos.mode === 'device' && pos.role === 'hmd' && props && props.width === 0.7, JSON.stringify({ mode: pos && pos.mode, role: pos && pos.role, width: props && props.width }));

    // ---- 2. everything set up on the desktop shows in the overlay ----
    const before = helper.count;
    const labels0 = await js("[...document.querySelectorAll('.btn')].map((b) => b.textContent.trim())");
    const c2 = JSON.parse(JSON.stringify(core.engine.config));
    c2.pages[0].buttons[0].label = 'Renamed';
    c2.pages[0].buttons[0].color = '#c53030';
    core.engine.updateConfig(c2);
    check('a button renamed and recolored on the desktop changes in the overlay', await until(async () => (await js("[...document.querySelectorAll('.btn')].map((b) => b.textContent.trim())")).includes('Renamed')) && labels0.includes('Alpha'));
    check('...and a new picture is sent for it', await until(() => helper.count > before));

    // ---- 3. laser clicks press buttons (and up is up, not down) ----
    const bravo = await rect('.btn', 1);
    await clickAt(bravo);
    check('a laser click on a button runs its action', await until(() => toasts.includes('pressed b'), 3000), toasts.join(','));
    const alpha = await rect('.btn', 0);
    await clickAt({ x: alpha.x, y: alpha.y });
    check('a click on the other button runs the other action', toasts.includes('pressed a'));
    toasts.length = 0;
    await clickAt({ x: bravo.x, y: 600 }); // the empty bottom row
    check('a click on empty space does nothing', toasts.length === 0);
    check('a click buzzes the controller', helper.callsOf('haptic').length >= 1);

    // ---- 4. the overlay has its own page; editing on the desktop does not disturb it ----
    const games = await rect('.page-tab', 1);
    await clickAt(games);
    check('tapping a page tab in the overlay changes the overlay page', await until(async () => (await js("[...document.querySelectorAll('.btn')].map((b) => b.textContent.trim()).join()")).includes('Charlie')));
    check('...without changing the desktop\'s page', core.engine.activePageId === 'one');
    core.engine.setEditing(true);
    await sleep(500);
    check('unlocking editing on the desktop does not put the overlay into edit mode', (await js("document.querySelectorAll('.stage.editing, .edit-banner:not([hidden])').length")) === 0);
    const charlie = await rect('.btn', 0);
    toasts.length = 0;
    await clickAt(charlie);
    check('overlay buttons still work while the desktop is editing', toasts.includes('pressed c'));
    core.engine.setEditing(false);

    // ---- 5. the tool strip: size, anchors, pin, collapse ----
    const bigger = await rect('.ov-btn[title="Bigger"]');
    await clickAt(bigger);
    check('"+" makes it bigger (0.7 m -> 0.9 m) and tells SteamVR', await until(() => core.engine.config.settings.overlay.widths.front === 0.9 && helper.callsOf('props').at(-1).width === 0.9));
    await clickAt(await rect('.ov-btn[title="Smaller"]'));
    await clickAt(await rect('.ov-btn[title="Smaller"]'));
    check('"-" makes it smaller', await until(() => core.engine.config.settings.overlay.widths.front === 0.55), String(core.engine.config.settings.overlay.widths.front));
    await clickAt(await rect('.ov-btn[title="Sit on my wrist"]'));
    check('choosing Wrist anchors it to the left controller, small', await until(() => { const p = helper.callsOf('place').at(-1); const pr = helper.callsOf('props').at(-1); return core.engine.config.settings.overlay.anchor === 'wrist' && p.role === 'left' && p.mode === 'device' && pr.width === 0.28; }));
    await clickAt(await rect('.ov-btn[title="Stay where it is in the room"]'));
    check('choosing Room fixes it in the room', await until(() => { const p = helper.callsOf('place').at(-1); return p.mode === 'absolute'; }));
    await clickAt(await rect('.ov-btn[title="Float in front of me"]'));
    check('choosing Front puts it back in front of the head', await until(() => helper.callsOf('place').at(-1).role === 'hmd'));

    // ---- 6. grab: hold to drag, click to carry, pin to lock ----
    const handle = await rect('.ov-handle');
    laser('move', handle); await sleep(40); laser('down', handle); await sleep(120);
    check('pressing on the handle starts a grab with that controller', await until(() => helper.callsOf('grab.start').length === 1 && helper.callsOf('grab.start')[0].device === 3));
    await sleep(500); // held longer than a click
    laser('up', handle);
    check('letting go after holding drops it and stores the new position', await until(() => helper.callsOf('grab.stop').length === 1 && core.engine.config.settings.overlay.offsets.front.x === 0.1 && core.engine.config.settings.overlay.offsets.front.y === -0.2), JSON.stringify(core.engine.config.settings.overlay.offsets.front));
    await sleep(700);
    const h2 = await rect('.ov-handle');
    laser('down', h2); await sleep(80); laser('up', h2);
    await until(() => helper.callsOf('grab.start').length === 2);
    await sleep(300);
    check('a quick click picks it up and it stays on the hand (no drop yet)', helper.callsOf('grab.stop').length === 1);
    laser('down', { x: 500, y: 400 }); await sleep(80); laser('up', { x: 500, y: 400 });
    check('the next click drops it', await until(() => helper.callsOf('grab.stop').length === 2));
    await sleep(700);
    await clickAt(await rect('.ov-btn[title="Pin in place"]'));
    check('the pin locks it', await until(() => core.engine.config.settings.overlay.locked === true));
    const starts = helper.callsOf('grab.start').length;
    const h3 = await rect('.ov-handle');
    laser('move', h3); await sleep(40); laser('down', h3); await sleep(100); laser('up', h3);
    await sleep(300);
    check('a pinned overlay cannot be grabbed', helper.callsOf('grab.start').length === starts);
    await clickAt(await rect('.ov-btn[title="Unpin"]'));
    await until(() => core.engine.config.settings.overlay.locked === false);

    // ---- 6b. snapping to a wrist, turning it there, taking it off again ----
    const ov = () => core.engine.config.settings.overlay;
    const dropWith = async (result) => {
      helper.grabResult = { grabbed: true, ...result };
      const hh = await rect('.ov-handle');
      laser('move', hh); await sleep(40); laser('down', hh); await sleep(80);
      await until(() => mgr.grab.on, 2000);
      await sleep(450);
      laser('up', hh);
      await sleep(400);
    };
    const world = L.fromOffset({ x: 0.5, y: 1.3, z: -1.2, yaw: 45, pitch: -5, roll: 0 });
    await sleep(150);
    const buzzes = helper.callsOf('haptic').length;
    helper.emit('event', { ev: 'snap', role: 'left' });
    check('being close to a wrist lights up the Wrist button and buzzes', await until(async () => mgr.info().snap === 'left' && (await js("document.body.classList.contains('snap-wrist')")) === true && helper.callsOf('haptic').length > buzzes));
    helper.emit('event', { ev: 'snap', role: '' });
    check('...and it goes out when you move away', await until(async () => mgr.info().snap === '' && (await js("document.body.classList.contains('snap-wrist')")) === false));
    await sleep(700);
    await dropWith({ world, relative: L.fromOffset({ x: 0.3, y: 0.3, z: -0.6, yaw: 10, pitch: -30, roll: 5 }), snapRole: 'left', snapType: 'knuckles' });
    check('letting go near the left wrist snaps it there (using the standard wrist spot)', await until(() => ov().anchor === 'wrist' && ov().hand === 'left' && helper.callsOf('place').at(-1).role === 'left' && JSON.stringify(helper.callsOf('place').at(-1).matrix) === JSON.stringify(L.fromOffset(L.DEFAULT_OFFSETS.wrist))), JSON.stringify({ anchor: ov().anchor, hand: ov().hand }));
    check('the wrist controls appear on the overlay', await until(async () => (await js("document.querySelectorAll('.ov-wrist').length")) === 1));
    check('it knows the controller is an Index (knuckles)', mgr.info().diag.hands.left === 'knuckles');

    await clickAt(await rect('.ov-btn[title="Turn it clockwise (15°)"]'));
    check('"turn clockwise" turns it in place and remembers that for this controller and hand', await until(() => ov().wristOffsets['knuckles:left'] && ov().wristOffsets['knuckles:left'].roll === 15 && helper.callsOf('place').at(-1).matrix[1] !== L.fromOffset(L.DEFAULT_OFFSETS.wrist)[1]), JSON.stringify(ov().wristOffsets));
    await clickAt(await rect('.ov-btn[title="Turn it counter-clockwise (15°)"]'));
    await clickAt(await rect('.ov-btn[title="Turn it counter-clockwise (15°)"]'));
    check('"turn counter-clockwise" goes back past zero', await until(() => ov().wristOffsets['knuckles:left'].roll === -15));
    await clickAt(await rect('.ov-btn[title="Tilt the top edge toward me"]'));
    check('"tilt" changes the angle of the panel', await until(() => ov().wristOffsets['knuckles:left'].pitch === L.DEFAULT_OFFSETS.wrist.pitch + 10));
    await clickAt(await rect('.ov-btn[title="Turn it upside down"]'));
    check('"flip" turns it upside down', await until(() => ov().wristOffsets['knuckles:left'].roll === 165));
    check('the other wrist and another controller type still have the standard angle', L.wristOffsetFor({ ...ov(), hand: 'right' }, 'knuckles').roll === 0 && L.wristOffsetFor(ov(), 'oculus_touch').roll === 0);
    await clickAt(await rect('.ov-btn[title="Back to the standard wrist position"]'));
    check('"reset" brings back the standard wrist position', await until(() => !ov().wristOffsets['knuckles:left'] && JSON.stringify(helper.callsOf('place').at(-1).matrix) === JSON.stringify(L.fromOffset(L.DEFAULT_OFFSETS.wrist))));
    await clickAt(await rect('.ov-btn[title="Move it to the other wrist"]'));
    check('"other wrist" moves it to the right controller', await until(() => ov().hand === 'right' && helper.callsOf('place').at(-1).role === 'right'));
    await clickAt(await rect('.ov-btn[title="Move it to the other wrist"]'));
    await until(() => ov().hand === 'left');

    // letting go near the same wrist after turning the panel by hand keeps the new angle
    const held = L.fromOffset({ x: 0, y: 0.04, z: 0.1, yaw: 5, pitch: -60, roll: 40 });
    await sleep(600);
    await dropWith({ world, relative: held, snapRole: 'left', snapType: 'knuckles' });
    check('letting go near the same wrist keeps the new position and angle', await until(() => ov().anchor === 'wrist' && ov().wristOffsets['knuckles:left'] && ov().wristOffsets['knuckles:left'].roll === 40 && ov().wristOffsets['knuckles:left'].pitch === -60), JSON.stringify(ov().wristOffsets));

    // pulling it off the wrist leaves it in the room where you let go
    await sleep(600);
    await dropWith({ world, relative: held, snapRole: '', snapType: '' });
    check('letting go away from the wrist takes it off and leaves it in the room', await until(() => ov().anchor === 'room' && ov().offsets.room.x === 0.5 && ov().offsets.room.y === 1.3 && helper.callsOf('place').at(-1).mode === 'absolute'), JSON.stringify({ anchor: ov().anchor, room: ov().offsets.room }));
    check('the wrist controls go away with it', await until(async () => (await js("document.querySelectorAll('.ov-wrist').length")) === 0));

    // snapping onto the other wrist from the room
    await sleep(600);
    await dropWith({ world, relative: held, snapRole: 'right', snapType: 'knuckles' });
    check('letting go near the right wrist from the room snaps it to the right', await until(() => ov().anchor === 'wrist' && ov().hand === 'right' && helper.callsOf('place').at(-1).role === 'right'));
    check('and its own adjusted angle is used if that wrist has one', L.wristOffsetFor({ ...ov(), wristOffsets: { 'knuckles:right': { ...L.DEFAULT_OFFSETS.wrist, roll: 90 } } }, 'knuckles').roll === 90);
    // the list of remembered adjustments stays small
    const many = { wristOffsets: {} };
    for (let i = 0; i < 20; i++) mgr.storeWrist(many, `type${i}:left`, L.DEFAULT_OFFSETS.wrist);
    check('only the newest adjusted positions are kept', Object.keys(many.wristOffsets).length === L.MAX_WRIST_ADJUSTMENTS && 'type19:left' in many.wristOffsets && !('type0:left' in many.wristOffsets));
    core.engine.patchSettings((s) => { s.overlay.anchor = 'front'; s.overlay.hand = 'left'; s.overlay.wristOffsets = {}; });
    await sleep(500);

    // ---- 7. bring it back, collapse, expand ----
    await clickAt(await rect('.ov-btn[title="Bring it back to me"]'));
    check('"bring it back" resets a front panel to its default spot', await until(() => core.engine.config.settings.overlay.offsets.front.z === L.DEFAULT_OFFSETS.front.z && core.engine.config.settings.overlay.offsets.front.x === 0));
    core.engine.patchSettings((s) => { s.overlay.anchor = 'room'; });
    await sleep(300);
    await mgr.command('bring');
    const room = core.engine.config.settings.overlay.offsets.room;
    check('for the room anchor it puts the panel 1 m ahead of where you look, facing you', Math.abs(room.x - 0) < 0.01 && Math.abs(room.z - 2) < 0.01 && Math.abs(room.y - 1.48) < 0.01 && Math.abs(room.yaw - 90) < 0.1, JSON.stringify(room));
    core.engine.patchSettings((s) => { s.overlay.anchor = 'front'; });
    await sleep(300);
    await clickAt(await rect('.ov-btn[title="Shrink the whole deck to a small tab"]'));
    check('collapse shrinks it to a small tab', await until(async () => core.engine.config.settings.overlay.collapsed === true && helper.callsOf('props').at(-1).width === 0.14 && (await js("document.querySelectorAll('.ov-expand').length")) === 1));
    await clickAt(await rect('.ov-expand'));
    check('tapping the tab expands it again', await until(() => core.engine.config.settings.overlay.collapsed === false));

    // ---- 7a. button pictures and effects, as the VR page draws them ----
    const { makeIconPng } = require('../src/main/icon');
    const imgA = core.images.add(makeIconPng(64));
    const imgB = core.images.add(makeIconPng(96));
    const fxCfg = JSON.parse(JSON.stringify(core.engine.config));
    // the deck page the overlay is showing right now may be either one, so the button goes on both
    for (const pg of fxCfg.pages) pg.buttons.push({ id: 'fxb', x: 0, y: 2, w: 1, h: 1, label: 'FX', steps: [{ action: 'system.toast', params: { message: 'pressed fxb' }, delayMs: 0 }], state: { source: 'toggle', key: '' }, image: imgA, imageOn: imgB, imageFit: 'contain', anim: 'pulse', animOn: 'flash', animSpeed: 'fast' });
    core.engine.updateConfig(fxCfg);
    const fxJs = (expr) => js(`(() => { const e = document.querySelector('.btn[data-id="fxb"]'); if (!e) return null; const cs = getComputedStyle(e); return (${expr}); })()`);
    check('a button with a picture and an effect is drawn with both', await until(async () => (await fxJs("e.classList.contains('fx-pulse') && e.classList.contains('has-img') && cs.backgroundImage.includes('" + imgA + "')")) === true), await fxJs('e.className + " | " + cs.backgroundImage'));
    check('...the picture loads (it needs the secret token, which the page has)', (await js(`fetch(getComputedStyle(document.querySelector('.btn[data-id="fxb"]')).backgroundImage.slice(5, -2)).then((r) => r.status + ' ' + r.headers.get('content-type'))`)) === '200 image/png');
    check('...and follows its speed and fit', (await fxJs("e.style.getPropertyValue('--fx-speed') === '0.55' && e.style.getPropertyValue('--fit') === 'contain'")) === true);
    await clickAt(await rect('.btn[data-id="fxb"]'));
    check('when it turns active it shows the active picture and the active effect', await until(async () => (await fxJs("e.classList.contains('active') && e.classList.contains('fx-flash') && !e.classList.contains('fx-pulse') && cs.backgroundImage.includes('" + imgB + "')")) === true), await fxJs('e.className + " | " + cs.backgroundImage'));
    check('the effect really animates', await until(async () => (await fxJs("cs.animationName === 'fx-flash'")) === true));
    core.engine.patchSettings((s) => { s.animations = false; });
    check('with animations turned off in Settings the effect stops but the picture stays', await until(async () => (await fxJs("document.body.classList.contains('no-fx') && cs.animationName === 'none' && e.classList.contains('has-img')")) === true));
    core.engine.patchSettings((s) => { s.animations = true; });
    for (const pg of fxCfg.pages) pg.buttons = pg.buttons.filter((b) => b.id !== 'fxb');
    core.engine.updateConfig(fxCfg);
    check('the test button is gone again', await until(async () => (await fxJs('1')) === null));

    // ---- 7b. hide / show the options strip from inside VR ----
    await clickAt(await rect('.ov-btn[title^="Hide these buttons"]'));
    check('"Hide options" removes the strip but keeps the macros and a small gear', await until(async () => core.engine.config.settings.overlay.showBar === false && (await js("document.querySelectorAll('.ov-btn').length")) === 1 && (await js("document.querySelectorAll('.btn').length")) > 0));
    await clickAt(await rect('.ov-btn[title^="Show the options"]'));
    check('the gear brings the options back', await until(async () => core.engine.config.settings.overlay.showBar === true && (await js("document.querySelectorAll('.ov-btn').length")) > 5));

    // ---- 7c. the SteamVR dashboard entry: its own page, its own picture, laser clicks that work ----
    check('the dashboard page is drawn and sent to SteamVR as its own picture', await until(() => helper.dashLast && helper.dashLast.w === 1280 && helper.dashLast.h === 800), JSON.stringify(helper.dashLast && [helper.dashLast.w, helper.dashLast.h]));
    check('the deck picture stays the deck picture (not overwritten by the dashboard)', helper.last.w === 1024 && helper.last.h === 640);
    check('attaching passes the thumbnail file for the dashboard entry', helper.callsOf('attach').some((c) => c.icon && fs.existsSync(c.icon)));
    const dashJs = (code) => mgr.dash.webContents.executeJavaScript(code);
    const dashRect = (label) => dashJs(`(() => { const e = [...document.querySelectorAll('.dash-btn, .dash-tab')].find((b) => b.textContent.includes(${JSON.stringify(label)})); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const dashClick = async (label) => {
      const p = await dashRect(label);
      if (!p) return false;
      const ev = (type, extra = {}) => helper.emit('event', { ev: 'mouse', target: 'dash', type, x: p.x, y: 800 - p.y, button: 1, device: 3, ...extra });
      ev('move'); await sleep(40); ev('down'); await sleep(60); ev('up'); await sleep(150);
      return true;
    };
    check('the dashboard panel lists the controls', (await dashJs("document.querySelector('.dash') ? document.querySelector('.dash').textContent : ''")).includes('Hide the deck'));
    await dashClick('Hide the deck');
    check('"Hide the deck" on the dashboard hides the deck', await until(() => core.engine.config.settings.overlay.hidden === true && helper.callsOf('props').at(-1).visible === false));
    check('...and the panel then offers to show it', await until(async () => (await dashJs("document.querySelector('.dash').textContent")).includes('Show the deck')));
    await dashClick('Show the deck');
    check('"Show the deck" brings it back', await until(() => core.engine.config.settings.overlay.hidden === false));
    await dashClick('In the room');
    check('the anchor can be changed from the dashboard', await until(() => core.engine.config.settings.overlay.anchor === 'room'));
    await dashClick('In front of me');
    await dashClick('Options strip');
    check('the options strip can be switched off from the dashboard', await until(() => core.engine.config.settings.overlay.showBar === false));
    await dashClick('Options strip');
    check('...and back on', await until(() => core.engine.config.settings.overlay.showBar === true));
    // ---- the editor tab: the whole app inside the dashboard ----
    // The page's own security policy forbids eval, so the test runs its scripts inside the editor's frame the way Electron offers.
    const ed = (code) => { const fr = mgr.dash.webContents.mainFrame.frames.find((x) => x.url.includes('view=editor')); return fr ? fr.executeJavaScript(code).catch(() => null) : Promise.resolve(null); };
    const edRect = (sel, nth = 0) => dashJs(`(() => { const fr = document.querySelector('iframe'); const r0 = fr.getBoundingClientRect(); const e = fr.contentDocument.querySelectorAll(${JSON.stringify(sel)})[${nth}]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r0.left + r.left + r.width / 2, y: r0.top + r.top + r.height / 2 }; })()`);
    const edClick = async (sel, nth = 0) => {
      const p = await edRect(sel, nth);
      if (!p) return false;
      const ev = (type) => helper.emit('event', { ev: 'mouse', target: 'dash', type, x: p.x, y: 800 - p.y, button: 1, device: 3 });
      ev('move'); await sleep(40); ev('down'); await sleep(60); ev('up'); await sleep(200);
      return true;
    };
    await dashClick('Editor');
    check('the Editor tab shows the whole app (its buttons are there)', await until(async () => (await ed("document.querySelectorAll('.btn').length")) > 0));
    check('...without window buttons, and it knows it is the VR editor', (await ed("document.body.classList.contains('editor') && !document.querySelector('.win-controls')")) === true);
    // changes made elsewhere show up in the editor at once...
    core.engine.patchSettings((s) => { s.accent = '#aa3399'; });
    check('a change made on the desktop shows in the VR editor', await until(async () => (await ed("document.documentElement.style.getPropertyValue('--accent')")) === '#aa3399'));
    // ...and a change made in the editor reaches the core (unlocking editing is shared by every view)
    core.engine.setEditing(false);
    await sleep(200);
    core.engine.setEditing(true);
    check('unlocking editing is seen by the editor (one core, every view)', await until(async () => (await ed("Boolean(document.querySelector('.lock-btn.unlocked'))")) === true));
    await edClick('.icon-btn[title="Settings"]');
    check('opening Settings inside the editor works with the laser', await until(async () => (await ed("document.querySelectorAll('.modal-body').length")) === 1));
    // drop-down lists: the native ones cannot be seen off-screen, so ours must appear and work
    const selects = await ed("document.querySelectorAll('.modal-body select').length");
    await edClick('.modal-body select');
    check('a drop-down opens our own list', await until(async () => (await ed("document.querySelectorAll('.vr-pop .vr-item').length")) > 1), String(selects));
    const selBefore = await ed("document.querySelector('.modal-body select').value");
    const items = await ed("[...document.querySelectorAll('.vr-pop .vr-item')].map((i) => i.textContent)");
    const other = await ed("(() => { const s = document.querySelector('.modal-body select'); return [...s.options].findIndex((o) => o.value !== s.value); })()");
    await edClick('.vr-pop .vr-item', other);
    check('choosing an entry sets the drop-down and closes the list', await until(async () => (await ed("document.querySelector('.modal-body select').value")) !== selBefore && (await ed("document.querySelectorAll('.vr-pop').length")) === 0), items.join(','));
    // colour picker
    const hasColor = await ed("document.querySelectorAll('.modal-body input[type=color]').length");
    if (hasColor) {
      await edClick('.modal-body input[type=color]');
      check('a colour box opens our palette', await until(async () => (await ed("document.querySelectorAll('.vr-pop .vr-swatch').length")) > 20));
      await edClick('.vr-pop .vr-swatch', 3);
      check('choosing a swatch sets the colour', await until(async () => (await ed("document.querySelector('.modal-body input[type=color]').value")) === '#d9b52b'));
    }
    // typing: a text box asks for SteamVR's keyboard, and what is typed comes back
    helper.calls.length = 0;
    // (the first Settings tab has no text box, so put one on top of it: the page treats every text box the same way)
    await ed("(() => { const i = document.createElement('input'); i.id = 'vr-test-input'; i.type = 'text'; i.style.cssText = 'position:fixed;left:30px;top:120px;width:320px;height:44px;z-index:5000'; document.body.append(i); })()");
    await edClick('#vr-test-input');
    check('a text box asks for the SteamVR keyboard', await until(() => helper.callsOf('keyboard').length >= 1), JSON.stringify(helper.callsOf('keyboard')));
    helper.emit('event', { ev: 'keyboard', target: 'dash', kind: 'text', text: 'Hello VR' });
    check('typed text arrives in the box', await until(async () => (await ed("document.activeElement && document.activeElement.value")) === 'Hello VR'));
    helper.emit('event', { ev: 'keyboard', target: 'dash', kind: 'done', text: 'Hello VR!' });
    check('pressing Done keeps it and leaves the box', await until(async () => (await ed("document.activeElement === document.body || document.activeElement.tagName !== 'INPUT'")) === true));
    await ed("document.getElementById('vr-test-input').remove()");
    // scrolling with the thumbstick
    await edClick('.modal-body h2, .modal-body .field, .modal-body .stack');
    const canScroll = await ed("(() => { const b = document.querySelector('.modal-body'); return b.scrollHeight > b.clientHeight + 1; })()");
    if (canScroll) {
      helper.emit('event', { ev: 'scroll', target: 'dash', dx: 0, dy: -2, device: 3 });
      check('the thumbstick scrolls what is under the laser', await until(async () => (await ed("document.querySelector('.modal-body').scrollTop")) > 0));
    }
    await ed("document.querySelector('.modal-head button') && document.querySelector('.modal-head button').click()");
    core.engine.setEditing(false);
    await dashClick('Controls');
    check('the Controls tab comes back', await until(async () => (await dashJs("document.querySelector('.dash-controls').hidden")) === false));

    // lost-it buttons
    core.engine.patchSettings((s) => { s.overlay.anchor = 'front'; s.overlay.widths.front = 2.5; s.overlay.offsets.front.z = -3; });
    await sleep(300);
    await dashClick('Reset size');
    check('"Reset size" on the dashboard brings back the standard size for this placement', await until(() => core.engine.config.settings.overlay.widths.front === L.DEFAULT_WIDTHS.front));
    await dashClick('Reset position');
    check('"Reset position" puts it back at the standard spot', await until(() => core.engine.config.settings.overlay.offsets.front.z === L.DEFAULT_OFFSETS.front.z));
    core.engine.patchSettings((s) => { s.overlay.hidden = true; s.overlay.collapsed = true; s.overlay.widths = { front: 2, room: 2, wrist: 1 }; });
    await sleep(300);
    await dashClick('Reset everything');
    check('"Reset everything" shows it, un-shrinks it and restores every size', await until(() => { const o = core.engine.config.settings.overlay; return !o.hidden && !o.collapsed && o.widths.front === L.DEFAULT_WIDTHS.front && o.widths.room === L.DEFAULT_WIDTHS.room && o.widths.wrist === L.DEFAULT_WIDTHS.wrist; }));
    helper.emit('event', { ev: 'dashboard', open: true, panel: true });
    helper.emit('event', { ev: 'dashboard', open: false });
    helper.calls.length = 0;
    core.engine.patchSettings((s) => { s.overlay.upload = 'raw'; });
    check('the picture path setting reaches the helper (raw)', await until(() => helper.callsOf('upload').some((c) => c.mode === 'raw')));
    core.engine.patchSettings((s) => { s.overlay.upload = 'auto'; });
    check('...and back to the GPU path', await until(() => helper.callsOf('upload').some((c) => c.mode === 'gpu')));

    // ---- 8. settings: hidden, opacity, pages, resolution, diagnostics ----
    core.engine.patchSettings((s) => { s.overlay.hidden = true; s.overlay.opacity = 0.6; });
    check('hidden and opacity reach SteamVR', await until(() => { const p = helper.callsOf('props').at(-1); return p.visible === false && p.alpha === 0.6; }));
    core.engine.patchSettings((s) => { s.overlay.glance = true; });
    check('the look-at-it switch reaches SteamVR', await until(() => helper.callsOf('props').at(-1).glance === true));
    core.engine.patchSettings((s) => { s.overlay.glance = false; s.overlay.hidden = false; s.overlay.opacity = 1; s.overlay.pages = ['two']; });
    check('choosing which pages the overlay shows hides the others', await until(async () => (await js("document.querySelectorAll('.page-tab').length")) === 0 && (await js("[...document.querySelectorAll('.btn')].map((b) => b.textContent.trim()).join()")).includes('Charlie')));
    core.engine.patchSettings((s) => { s.overlay.pages = []; s.overlay.resolution = 1536; });
    check('a higher resolution makes bigger pictures and keeps clicks lined up', await until(() => helper.last.w === 1536 && helper.last.h === 960));
    await sleep(600);
    toasts.length = 0;
    const b1536 = await rect('.btn', 0);
    helper.emit('event', { ev: 'mouse', type: 'move', x: b1536.x, y: 960 - b1536.y, button: 0, device: 3 });
    await sleep(40);
    helper.emit('event', { ev: 'mouse', type: 'down', x: b1536.x, y: 960 - b1536.y, button: 1, device: 3 });
    await sleep(60);
    helper.emit('event', { ev: 'mouse', type: 'up', x: b1536.x, y: 960 - b1536.y, button: 1, device: 3 });
    check('...click positions are still right at the new size', await until(() => toasts.some((t) => t.startsWith('pressed ')), 3000), toasts.join(','));
    core.engine.patchSettings((s) => { s.overlay.resolution = 1024; s.overlay.diagnostics = true; });
    check('diagnostics shows the laser readout and the pointer ring', await until(async () => (await js("(document.querySelector('.ov-diag') || {}).textContent || ''")).includes('laser (from SteamVR)') && (await js("document.querySelectorAll('.ov-dot:not([hidden])').length")) === 1));

    // ---- 9. SteamVR going away and coming back ----
    helper.emit('event', { ev: 'quit' });
    check('when SteamVR quits the overlay waits for it', await until(() => mgr.state === 'waiting'), mgr.state);
    helper.calls.length = 0;
    await mgr.tryAttach();
    check('when SteamVR is back it reconnects and puts everything back', await until(() => mgr.state === 'connected' && helper.callsOf('props').length >= 1 && helper.callsOf('place').length >= 1));

    // ---- 9b. dim the view: a dark sheet that also works when the deck itself is off ----
    helper.calls.length = 0;
    core.engine.patchSettings((s) => { s.overlay.dim = 0.4; });
    check('the dim level reaches SteamVR', await until(() => helper.callsOf('dim').some((c) => c.level === 0.4)));
    await dashClick('Darker');
    check('"Darker" on the dashboard steps it up by 10 percent', await until(() => core.engine.config.settings.overlay.dim === 0.5));
    await dashClick('Lighter');
    await dashClick('Lighter');
    check('"Lighter" steps it down', await until(() => core.engine.config.settings.overlay.dim === 0.3));
    core.engine.patchSettings((s) => { s.overlay.enabled = false; });
    await sleep(400);
    check('with the deck off but the view dimmed, SteamVR stays connected for the dimmer', mgr.state === 'connected' && mgr.running);
    check('...and the deck itself is hidden', await until(() => helper.callsOf('props').at(-1).visible === false));
    core.engine.patchSettings((s) => { s.overlay.enabled = true; });
    await dashClick('Off');
    check('"Off" brings back full brightness', await until(() => core.engine.config.settings.overlay.dim === 0));
    check('...and the deck is visible again', await until(() => helper.callsOf('props').at(-1).visible === true));

    // ---- 10. off means off ----
    await dashClick('Turn the overlay off');
    mgr.sync();
    check('"Turn the overlay off" on the dashboard stops everything', await until(() => mgr.state === 'off' && !mgr.win));
    const log = fs.readFileSync(path.join(process.env.VRMD_DATA_DIR, 'overlay.log'), 'utf8');
    check('what happened was written to overlay.log', /connected to SteamVR/.test(log) && /grab by device 3/.test(log) && /dashboard click at/.test(log) && /SteamVR dashboard opened/.test(log));
  } catch (err) {
    check('test run', false, err.stack || err.message);
  } finally {
    try { if (mgr) await mgr.stop(); } catch { /* ignore */ }
    try { if (core) await core.stop(); } catch { /* ignore */ }
    console.log(results.every(Boolean) ? `\nAll ${results.length} checks passed.` : `\n${results.filter((r) => !r).length} of ${results.length} checks FAILED.`);
    app.exit(results.every(Boolean) ? 0 : 1);
  }
});
