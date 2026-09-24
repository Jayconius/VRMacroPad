// Draws docs/images/banner.png (the README header) and docs/images/plugins.png (every bundled plugin at a glance),
// from the real plugin list, so they never go stale. Run with: npx electron scripts/make-readme-graphics.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { registry } = require('../src/core/actions');

app.on('window-all-closed', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IMAGES = path.join(__dirname, '..', 'docs', 'images');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const BASE_CSS = `
  * { box-sizing: border-box; margin: 0; }
  body { font-family: "Segoe UI", system-ui, sans-serif; color: #f2f4fa; background: linear-gradient(120deg, #141622 0%, #1b1a35 55%, #2b2260 100%); overflow: hidden; }
  .logo { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; width: 162px; }
  .logo i { display: block; aspect-ratio: 1; border-radius: 22px; }
`;

async function render(html, width, height, file) {
  const tmp = path.join(require('os').tmpdir(), `vrmd-readme-art-${process.pid}-${path.basename(file)}.html`);
  fs.writeFileSync(tmp, html);
  const win = new BrowserWindow({ show: false, width, height, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false } });
  await win.loadFile(tmp);
  await sleep(900);
  const fit = await win.webContents.executeJavaScript('document.documentElement.scrollHeight');
  if (fit !== height) { win.setContentSize(width, fit); await sleep(500); }
  const png = (await win.webContents.capturePage()).toPNG();
  fs.writeFileSync(path.join(IMAGES, file), png);
  console.log('wrote', file, png.length, 'bytes');
  win.destroy();
  fs.unlinkSync(tmp);
}

const banner = (deckB64) => `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
  body { width: 1280px; height: 420px; position: relative; }
  .logo { position: absolute; left: 70px; top: 70px; }
  h1 { position: absolute; left: 264px; top: 62px; font-size: 68px; font-weight: 700; letter-spacing: -1px; }
  .sub { position: absolute; left: 268px; top: 152px; width: 380px; font-size: 27px; line-height: 1.32; color: #b9bfdc; }
  .pills { position: absolute; left: 70px; top: 300px; width: 640px; display: flex; flex-wrap: wrap; gap: 10px; }
  .pills span { padding: 8px 18px; border-radius: 999px; background: rgba(255,255,255,.10); border: 1px solid rgba(255,255,255,.14); font-size: 19px; font-weight: 600; }
  .new { background: rgba(76,141,255,.25) !important; border-color: rgba(120,170,255,.5) !important; }
  .shot { position: absolute; left: 770px; top: 84px; width: 470px; border-radius: 12px; box-shadow: 0 22px 50px rgba(0,0,0,.55); border: 1px solid rgba(255,255,255,.12); }
</style></head><body>
  <div class="logo"><i style="background:#2f855a"></i><i style="background:#4c8dff"></i><i style="background:#b7791f"></i><i style="background:#6b46c1"></i></div>
  <h1>VR Macro Pad</h1>
  <div class="sub">Push-button macros and live mini screens, for the desktop and for pinning in VR.</div>
  <div class="pills"><span>SteamVR</span><span>Twitch</span><span class="new">YouTube</span><span class="new">Kick</span><span>OBS</span><span>VRChat</span><span class="new">Discord</span><span class="new">Streamer.bot</span><span>Spotify</span><span class="new">+ your own plugins</span></div>
  <img class="shot" src="${deckB64}">
</body></html>`;

const plugins = () => {
  const list = registry.list().filter((m) => m.id !== 'starter');
  const cards = list.map((m) => `<div class="card"><div class="ic">${esc(m.icon || '🔌')}</div><div><b>${esc(m.name.replace(/ \(.*\)$/, ''))}</b><p>${esc(String(m.description || '').replace(/\s+/g, ' '))}</p></div></div>`).join('');
  return { list, html: `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
  body { width: 1280px; padding: 44px 50px 46px; }
  h2 { font-size: 40px; letter-spacing: -.5px; }
  .lead { margin: 6px 0 26px; font-size: 20px; color: #b9bfdc; }
  .grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; }
  .card { display: flex; gap: 14px; align-items: flex-start; padding: 16px 18px; min-height: 108px; border-radius: 16px; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.12); }
  .ic { flex: none; width: 52px; height: 52px; display: grid; place-items: center; font-size: 30px; border-radius: 14px; background: rgba(255,255,255,.10); }
  .card b { font-size: 21px; }
  .card p { margin-top: 4px; font-size: 15px; line-height: 1.35; color: #b9bfdc; }
  .own { border-style: dashed; background: transparent; }
</style></head><body>
  <h2>Every integration is a plugin</h2>
  <div class="lead">Switch each one on or off in Settings → Plugins. And you can write your own: a folder with a few small JavaScript files.</div>
  <div class="grid">${cards}<div class="card own"><div class="ic">➕</div><div><b>Your own</b><p>Drop a folder in, restart, done. No build step. See "Build your own plugin".</p></div></div></div>
</body></html>` };
};

app.whenReady().then(async () => {
  const deck = `data:image/png;base64,${fs.readFileSync(path.join(IMAGES, 'deck.png')).toString('base64')}`;
  await render(banner(deck), 1280, 420, 'banner.png');
  const p = plugins();
  await render(p.html, 1280, 600, 'plugins.png'); // the height is measured and fitted in render()
  app.exit(0);
});
