// Draws docs/images/vr-overlay.png: the real overlay page (the same one SteamVR shows) placed in an illustrated VR scene.
// Run with: npx electron scripts/make-vr-graphic.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/core');
const { FakeHelper } = require('../test/helpers');
const { makeIconPng } = require('../src/main/icon');

process.env.VRMD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vrmd-art-'));
app.setPath('userData', path.join(process.env.VRMD_DATA_DIR, 'electron-profile'));
app.on('window-all-closed', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Renders one page off-screen and returns it as a PNG data URL (transparent where the page is).
async function shoot(url, width, height, { transparent = true, wait = 2200 } = {}) {
  const win = new BrowserWindow({ show: false, width, height, useContentSize: true, transparent, frame: false, backgroundColor: transparent ? '#00000000' : '#14161c', webPreferences: { offscreen: true, backgroundThrottling: false } });
  win.webContents.setFrameRate(20);
  await win.loadURL(url);
  await sleep(wait);
  const img = await win.webContents.capturePage();
  win.destroy();
  return `data:image/png;base64,${img.toPNG().toString('base64')}`;
}

app.whenReady().then(async () => {
  const core = createApp({ dataDir: process.env.VRMD_DATA_DIR, helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), port: 0, twitchOptions: { defaultClientId: '' }, pearOptions: { retryMs: 60000 } });
  const { url } = await core.start();
  const icon = core.images.add(makeIconPng(128));
  const btn = (id, x, y, w, h, label, ic, color, extra = {}) => ({ id, x, y, w, h, label, icon: ic, color, steps: [{ action: 'system.toast', params: { message: label }, delayMs: 0 }], state: { source: 'toggle', key: '' }, ...extra });
  const cfg = JSON.parse(JSON.stringify(core.engine.config));
  cfg.settings.accent = '#4c8dff';
  cfg.pages = [
    { id: 'p1', name: 'Stream', cols: 6, rows: 3, buttons: [
      btn('mic', 0, 0, 1, 1, 'Mic', '🎙️', '#2f855a', { labelOn: 'Muted', colorOn: '#c53030', animOn: 'hazard' }),
      btn('rec', 1, 0, 1, 1, 'Record', '⏺️', '#9b2c2c', { colorOn: '#e53e3e', labelOn: 'REC', animOn: 'heartbeat' }),
      btn('live', 2, 0, 1, 1, 'Go live', '📡', '#2b6cb0', { labelOn: 'On air', colorOn: '#6b46c1', animOn: 'ripple' }),
      btn('game', 3, 0, 1, 1, 'Gaming', '🎮', '#6b46c1'),
      btn('chat', 4, 0, 1, 1, 'Chat', '💬', '#0e7490'),
      btn('dim', 5, 0, 1, 1, 'Dim', '🌙', '#3b5b8f', { labelOn: 'Dimmed', colorOn: '#2c5282' }),
      { id: 'clock', x: 0, y: 1, w: 2, h: 1, label: '', icon: '', color: '#1a365d', widget: { type: 'clock', params: {} }, steps: [], triggers: [], state: { source: 'none', key: '' } },
      btn('vol', 2, 1, 1, 1, 'Vol +', '🔊', '#3b4a63'),
      btn('vm', 3, 1, 1, 1, 'Headset', '🎧', '#b7791f', { labelOn: 'Headset', colorOn: '#dd6b20', animOn: 'glow' }),
      btn('home', 4, 1, 1, 1, 'Home', '', '#222b3d', { image: icon, imageFit: 'contain' }),
      btn('bright', 5, 1, 1, 1, 'Bounds', '🧱', '#4a5568', { colorOn: '#b7791f', animOn: 'pulse' }),
      { id: 'dice', x: 0, y: 2, w: 2, h: 1, label: 'Dice', icon: '', color: '#553c9a', widget: { type: 'dice', params: {} }, steps: [], triggers: [], state: { source: 'none', key: '' } },
      btn('scene1', 2, 2, 1, 1, 'Scene 1', '🎬', '#3b4a63'),
      btn('scene2', 3, 2, 1, 1, 'BRB', '💤', '#3b4a63'),
      btn('song', 4, 2, 1, 1, 'Skip', '⏭️', '#2f855a', { animOn: 'shake' }),
      btn('panic', 5, 2, 1, 1, 'Panic', '🛑', '#9b2c2c', { colorOn: '#e53e3e', animOn: 'flash' }),
    ] },
    { id: 'p2', name: 'VRChat', cols: 4, rows: 3, buttons: [] },
    { id: 'p3', name: 'Music', cols: 4, rows: 3, buttons: [] },
  ];
  cfg.settings.overlay.enabled = true;
  cfg.settings.overlay.showBar = true;
  cfg.settings.overlay.anchor = 'front';
  core.engine.updateConfig(cfg);
  for (const id of ['mic', 'rec', 'live', 'vm', 'bright']) await core.engine.press(id);
  await sleep(400);

  const overlayUrl = new URL(url); overlayUrl.searchParams.set('view', 'overlay');
  const dashUrl = new URL(url); dashUrl.searchParams.set('view', 'dashboard');
  const deck = await shoot(overlayUrl.toString(), 1024, 640);
  // the wrist copy: wrist anchor shows the strip with the wrist row
  const wristCfg = JSON.parse(JSON.stringify(core.engine.config));
  wristCfg.settings.overlay.anchor = 'wrist';
  core.engine.updateConfig(wristCfg);
  await sleep(300);
  const wrist = await shoot(overlayUrl.toString(), 1024, 640);
  core.engine.updateConfig(cfg);
  const dash = await shoot(dashUrl.toString(), 1280, 800, { transparent: false });

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; }
    body { width: 1600px; height: 900px; overflow: hidden; font-family: 'Segoe UI', system-ui, sans-serif; color: #fff;
      background: radial-gradient(ellipse at 50% 62%, #ff9a4d 0%, #d4506a 14%, #5a2d7a 34%, #1a1442 60%, #0a0a1c 100%); position: relative; }
    .stars { position: absolute; inset: 0; background-image: radial-gradient(1.4px 1.4px at 8% 12%, #fff, transparent), radial-gradient(1.2px 1.2px at 22% 30%, #fff, transparent), radial-gradient(1.6px 1.6px at 41% 8%, #fff, transparent), radial-gradient(1.2px 1.2px at 63% 22%, #fff, transparent), radial-gradient(1.4px 1.4px at 78% 10%, #fff, transparent), radial-gradient(1.2px 1.2px at 91% 27%, #fff, transparent), radial-gradient(1px 1px at 33% 18%, #fff, transparent), radial-gradient(1px 1px at 55% 33%, #fff, transparent), radial-gradient(1px 1px at 86% 40%, #fff, transparent); opacity: 0.8; }
    .mount { position: absolute; left: 0; right: 0; top: 500px; height: 120px; background: linear-gradient(#150f33, #0b0a1e); clip-path: polygon(0 60%, 6% 40%, 14% 55%, 23% 30%, 31% 52%, 40% 35%, 50% 58%, 60% 32%, 70% 50%, 80% 28%, 90% 48%, 100% 34%, 100% 100%, 0 100%); opacity: 0.9; }
    .floor { position: absolute; left: -20%; right: -20%; top: 560px; bottom: 0; background:
      linear-gradient(#0b0a1e, #06060f);
      transform-origin: top; }
    .grid { position: absolute; left: -30%; right: -30%; top: 560px; bottom: -200px; transform: perspective(500px) rotateX(62deg); transform-origin: top;
      background-image: linear-gradient(rgba(255, 140, 90, 0.35) 2px, transparent 2px), linear-gradient(90deg, rgba(255, 140, 90, 0.35) 2px, transparent 2px); background-size: 90px 90px; }
    .haze { position: absolute; left: 0; right: 0; top: 540px; height: 70px; background: linear-gradient(transparent, rgba(255, 140, 90, 0.35), transparent); }
    .title { position: absolute; left: 60px; top: 48px; }
    .title h1 { font-size: 54px; letter-spacing: -1px; text-shadow: 0 4px 24px rgba(0, 0, 0, 0.6); }
    .title p { font-size: 24px; margin-top: 6px; color: #ffd9c2; text-shadow: 0 2px 12px rgba(0, 0, 0, 0.7); }
    .stage { position: absolute; inset: 0; perspective: 1400px; }
    .deck { position: absolute; left: 305px; top: 160px; width: 820px; height: 512px; transform: rotateY(-9deg) rotateX(3deg); transform-style: preserve-3d;
      border-radius: 26px; filter: drop-shadow(0 30px 60px rgba(0, 0, 0, 0.65)) drop-shadow(0 0 40px rgba(76, 141, 255, 0.35)); }
    .deck img { width: 100%; height: 100%; display: block; border-radius: 20px; }
    .deck::before { content: ''; position: absolute; inset: -10px; border-radius: 30px; background: rgba(20, 24, 40, 0.55); border: 1px solid rgba(255, 255, 255, 0.18); backdrop-filter: blur(6px); z-index: -1; }
    .dash { position: absolute; left: 1125px; top: 372px; width: 400px; height: 250px; transform: rotateY(-24deg) rotateX(2deg); border-radius: 14px; overflow: hidden; border: 2px solid rgba(255, 255, 255, 0.25); filter: drop-shadow(0 20px 40px rgba(0, 0, 0, 0.6)); }
    .dash img { width: 100%; height: 100%; display: block; }
    .wrist { position: absolute; left: 14px; top: 500px; width: 330px; height: 206px; transform: rotateY(18deg) rotateX(48deg) rotateZ(-10deg); filter: drop-shadow(0 16px 30px rgba(0, 0, 0, 0.7)) drop-shadow(0 0 24px rgba(255, 176, 32, 0.4)); }
    .wrist img { width: 100%; height: 100%; display: block; border-radius: 12px; }
    svg.hand { position: absolute; left: 0; top: 0; width: 1600px; height: 900px; pointer-events: none; }
    .tag { position: absolute; padding: 10px 18px; border-radius: 999px; background: rgba(12, 14, 30, 0.78); border: 1px solid rgba(255, 255, 255, 0.28); font-size: 21px; font-weight: 600; backdrop-filter: blur(4px); white-space: nowrap; }
    .tag b { color: #ffb020; }
    .chips { position: absolute; left: 60px; bottom: 34px; display: flex; gap: 12px; }
    .chips span { padding: 8px 16px; border-radius: 999px; background: rgba(12, 14, 30, 0.72); border: 1px solid rgba(255, 255, 255, 0.22); font-size: 19px; }
  </style></head><body>
    <div class="stars"></div><div class="mount"></div><div class="haze"></div><div class="floor"></div><div class="grid"></div>
    <div class="title"><h1>VR Macro Pad 3.0</h1><p>A real SteamVR overlay: your deck, in the headset</p></div>
    <div class="stage">
      <div class="deck"><img src="${deck}"></div>
      <div class="dash"><img src="${dash}"></div>
      <div class="wrist"><img src="${wrist}"></div>
    </div>
    <svg class="hand" viewBox="0 0 1600 900">
      <defs><linearGradient id="beam" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#7fd0ff" stop-opacity="0.05"/><stop offset="1" stop-color="#7fd0ff" stop-opacity="0.95"/></linearGradient></defs>
      <!-- controller in the right hand and its laser -->
      <g transform="translate(1290 810) rotate(-28)">
        <rect x="-26" y="-12" width="52" height="150" rx="24" fill="#1c2233" stroke="#5b6b8f" stroke-width="3"/>
        <circle cx="0" cy="24" r="12" fill="#2b3450" stroke="#7d8db5" stroke-width="2"/>
        <circle cx="0" cy="-30" r="34" fill="none" stroke="#5b6b8f" stroke-width="7"/>
      </g>
      <line x1="1262" y1="775" x2="818" y2="410" stroke="url(#beam)" stroke-width="5" stroke-linecap="round"/>
      <circle cx="818" cy="410" r="11" fill="#fff" fill-opacity="0.95"/><circle cx="818" cy="410" r="22" fill="none" stroke="#7fd0ff" stroke-width="3"/>
      <!-- left controller under the wrist panel -->
      <g transform="translate(180 838) rotate(18)">
        <rect x="-24" y="-10" width="48" height="130" rx="22" fill="#1c2233" stroke="#5b6b8f" stroke-width="3"/>
        <circle cx="0" cy="20" r="11" fill="#2b3450" stroke="#7d8db5" stroke-width="2"/>
        <circle cx="0" cy="-28" r="31" fill="none" stroke="#5b6b8f" stroke-width="6"/>
      </g>
    </svg>
    <div class="tag" style="left:600px; top:84px">Grab it, move it, <b>resize</b> it</div>
    <div class="tag" style="left:64px; top:418px">Snaps to your <b>wrist</b></div>
    <div class="tag" style="left:1125px; top:312px"><b>Editor</b> in the SteamVR dashboard</div>
    <div class="chips"><span>Front · Room · Wrist</span><span>Dim the view</span><span>Effects and GIFs</span><span>Voicemeeter</span><span>VRChat</span><span>Any headset</span></div>
  </body></html>`;
  const file = path.join(process.env.VRMD_DATA_DIR, 'scene.html');
  fs.writeFileSync(file, html);
  const win = new BrowserWindow({ show: false, width: 1600, height: 900, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false } });
  await win.loadFile(file);
  await sleep(1500);
  const out = (await win.webContents.capturePage()).toPNG();
  const dest = path.join(__dirname, '..', 'docs', 'images', 'vr-overlay.png');
  fs.writeFileSync(dest, out);
  console.log('wrote', dest, out.length, 'bytes');
  win.destroy();
  await core.stop();
  app.exit(0);
});
