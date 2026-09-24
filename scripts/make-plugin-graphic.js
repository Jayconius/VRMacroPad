// Captures the real Macro Pad UI running the Discord example plugin (before / editor / after a press), into
// a temp folder, for docs/images/plugin-in-action.png. Run with: npx electron scripts/make-plugin-graphic.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/core');
const { FakeHelper } = require('../test/helpers');

const OUT = process.env.PLUGIN_ART_OUT || path.join(os.tmpdir(), 'plugin-art');
fs.mkdirSync(OUT, { recursive: true });
// A neutral-looking data folder so screenshots of file paths don't show anyone's username (falls back to temp).
let dataRoot;
try { dataRoot = path.join(path.parse(os.tmpdir()).root, 'demo', 'VR Macro Pad'); fs.rmSync(dataRoot, { recursive: true, force: true }); fs.mkdirSync(dataRoot, { recursive: true }); } catch { dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vrmd-art-')); }
process.env.VRMD_DATA_DIR = dataRoot;
app.setPath('userData', path.join(process.env.VRMD_DATA_DIR, 'electron-profile'));
app.on('window-all-closed', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MESSAGE = 'Going live now! 🔴 Come hang out';

app.whenReady().then(async () => {
  // A stand-in for Discord: accepts the webhook POST like the real one does (204).
  const posted = [];
  const fake = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => { if (req.method === 'POST') posted.push(JSON.parse(b)); res.writeHead(204); res.end(); });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));

  // Only the Discord plugin, exactly as a user would have it: <plugins folder>/discord/
  const pluginsDir = path.join(process.env.VRMD_DATA_DIR, 'plugins');
  fs.cpSync(path.join(__dirname, '..', 'docs', 'example-plugin-discord'), path.join(pluginsDir, 'mydiscord'), { recursive: true });
  // Two deliberately broken plugins, to show how the app reports them.
  fs.mkdirSync(path.join(pluginsDir, 'my-broken-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, 'my-broken-plugin', 'plugin.js'), ['module.exports = {', "  id: 'my-broken',", "  name: 'My Broken Plugin',", '  actions: [ ,, oops', '};', ''].join('\n'));
  fs.mkdirSync(path.join(pluginsDir, 'typo-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, 'typo-plugin', 'plugin.js'), "module.exports = { id: 'typo-plugin', name: 'Typo Plugin', actions: require('./actoins') };\n");
  const core = createApp({ dataDir: process.env.VRMD_DATA_DIR, pluginsDir, helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), port: 0, twitchOptions: { defaultClientId: '' }, pearOptions: { retryMs: 60000 } });
  const { url } = await core.start();
  const cfg = JSON.parse(JSON.stringify(core.engine.config));
  cfg.settings.accent = '#4c8dff';
  cfg.settings.plugins.mydiscord.webhookUrl = `http://127.0.0.1:${fake.address().port}/api/webhooks/1/demo`;
  const btn = (id, x, y, label, icon, color, extra = {}) => ({ id, x, y, w: 1, h: 1, label, icon, color, steps: [{ action: 'system.toast', params: { message: label }, delayMs: 0 }], state: { source: 'toggle', key: '' }, ...extra });
  cfg.pages = [{ id: 'p1', name: 'Stream', cols: 4, rows: 2, buttons: [
    { id: 'announce', x: 0, y: 0, w: 1, h: 1, label: 'Announce', icon: '💬', color: '#4a5568', colorOn: '#5865f2', labelOn: 'Sent!',
      steps: [{ action: 'mydiscord.send', params: { message: MESSAGE }, delayMs: 0 }], state: { source: 'auto', key: '' } },
    btn('mic', 1, 0, 'Mic', '🎙️', '#2f855a'),
    btn('rec', 2, 0, 'Record', '⏺️', '#9b2c2c'),
    btn('scene', 3, 0, 'BRB', '💤', '#3b4a63'),
    { id: 'clock', x: 0, y: 1, w: 2, h: 1, label: '', icon: '', color: '#1a365d', widget: { type: 'clock', params: {} }, steps: [], triggers: [], state: { source: 'none', key: '' } },
    btn('vol', 2, 1, 'Vol +', '🔊', '#3b4a63'),
  ] }];
  core.engine.updateConfig(cfg);

  const win = new BrowserWindow({ show: false, width: 620, height: 360, useContentSize: true, frame: false, backgroundColor: '#14161c', webPreferences: { offscreen: true, backgroundThrottling: false } });
  win.webContents.setFrameRate(20);
  await win.loadURL(url);
  await sleep(2000);
  const shot = async (name) => { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, name), img.toPNG()); };
  const js = (code) => win.webContents.executeJavaScript(code);

  await shot('deck-before.png');

  // Press the button (the same call a tap or a VR laser click makes).
  await core.engine.press('announce');
  await sleep(700);
  await shot('deck-after.png');
  console.log('discord received:', JSON.stringify(posted));
  fs.writeFileSync(path.join(OUT, 'posted.json'), JSON.stringify(posted));

  // The button editor with the Discord action chosen (real mouse events, in a taller window).
  win.setContentSize(760, 720);
  core.engine.setEditing(true);
  await sleep(4500);
  const click = async (x, y) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await sleep(60);
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  };
  const center = (sel, nth = 0) => js(`(() => { const b = document.querySelectorAll(${JSON.stringify(sel)})[${nth}].getBoundingClientRect(); return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)]; })()`);
  const clickSel = async (sel, nth = 0) => { const [x, y] = await center(sel, nth); await click(x, y); await sleep(500); };
  await clickSel('.btn');
  await sleep(700);
  await shot('editor.png');
  await js(`[...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === 'Cancel')?.click()`);
  await sleep(600);
  console.log('after cancel, modal open:', await js(`Boolean(document.querySelector('.modal'))`), 'cells:', await js(`document.querySelectorAll('.cell').length`));

  // The action picker, filtered to the Discord actions.
  await clickSel('.cell');
  await sleep(900);
  console.log('after cell click, modal:', await js(`(document.querySelector('.modal') || {}).textContent ? document.querySelector('.modal').textContent.slice(0, 60) : 'none'`));
  await js(`(() => { const i = document.querySelector('input[type=search]'); i.value = 'mydiscord'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(500);
  await shot('picker.png');
  await js(`document.querySelector('.modal .icon-btn, .modal [aria-label=Close], .modal button')?.click()`);
  await js(`[...document.querySelectorAll('.modal button')].find((b) => /close|cancel|✕/i.test(b.textContent + (b.title || '')))?.click()`);
  await sleep(500);

  // Settings -> Plugins: the failed-plugin notice and the Discord card.
  await js(`document.querySelector('[title="Settings"]').click()`);
  await sleep(700);
  await js(`[...document.querySelectorAll('.tabs button')].find((b) => b.textContent === 'Plugins').click()`);
  await sleep(600);
  await shot('settings-plugins.png');
  await js(`[...document.querySelectorAll('.plugin-card summary')].find((s) => s.textContent.includes('My Discord')).click()`);
  await sleep(300);
  await js(`document.querySelector('.plugin-card[open]')?.scrollIntoView({ block: 'start' })`);
  await sleep(500);
  await shot('settings-discord.png');
  console.log('done', OUT);
  fake.close();
  await core.stop();

  // The generic widget: the weather example plugin's widget, drawn with no drawing code of its own.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vrmd-art2-'));
  fs.cpSync(path.join(__dirname, '..', 'docs', 'example-plugin'), path.join(dir2, 'plugins', 'weather'), { recursive: true });
  const core2 = createApp({ dataDir: dir2, pluginsDir: path.join(dir2, 'plugins'), helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), port: 0, twitchOptions: { defaultClientId: '' }, pearOptions: { retryMs: 60000 } });
  const { url: url2 } = await core2.start();
  const c2 = JSON.parse(JSON.stringify(core2.engine.config));
  c2.settings.plugins.weather = { enabled: true, apiKey: 'demo', city: 'London', hotAboveC: 25 };
  c2.pages = [{ id: 'p1', name: 'Stream', cols: 4, rows: 2, buttons: [
    { id: 'wx', x: 0, y: 0, w: 2, h: 1, label: 'London', icon: '', color: '#2b5a7a', widget: { type: 'weather.now', params: {} }, steps: [], triggers: [], state: { source: 'none', key: '' } },
    btn('mic', 2, 0, 'Mic', '🎙️', '#2f855a'),
    btn('rec', 3, 0, 'Record', '⏺️', '#9b2c2c'),
  ] }];
  core2.engine.updateConfig(c2);
  const win2 = new BrowserWindow({ show: false, width: 620, height: 250, useContentSize: true, frame: false, backgroundColor: '#14161c', webPreferences: { offscreen: true, backgroundThrottling: false } });
  win2.webContents.setFrameRate(20);
  await win2.loadURL(url2);
  await sleep(2500);
  fs.writeFileSync(path.join(OUT, 'widget.png'), (await win2.webContents.capturePage()).toPNG());
  await core2.stop();
  app.quit();
}).catch((e) => { console.error('ART FAIL', e && e.message); app.quit(); });
