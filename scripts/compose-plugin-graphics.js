// Composes docs/images/plugin-in-action.png and plugin-button-editor.png from the captures made by
// scripts/make-plugin-graphic.js (real Macro Pad screenshots) plus an illustration of the Discord channel.
// Run: PLUGIN_ART_OUT=.art-tmp npx electron scripts/make-plugin-graphic.js && npx electron scripts/compose-plugin-graphics.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IN = path.resolve(process.env.PLUGIN_ART_OUT || path.join(__dirname, '..', '.art-tmp'));
const OUT = path.join(__dirname, '..', 'docs', 'images');
app.setPath('userData', path.join(os.tmpdir(), 'vrmd-compose-profile'));
app.on('window-all-closed', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const img = (f) => `data:image/png;base64,${fs.readFileSync(path.join(IN, f)).toString('base64')}`;
const posted = JSON.parse(fs.readFileSync(path.join(IN, 'posted.json'), 'utf8'))[0];

const BASE = `
  * { box-sizing: border-box; }
  html { overflow: hidden; }
  body { margin: 0; font-family: "Segoe UI", -apple-system, Roboto, Helvetica, Arial, sans-serif; background: #101826; color: #f2f5fa; }
  h1 { margin: 0; font-size: 30px; }
  .sub { color: #9fb0c8; font-size: 17px; margin-top: 6px; }
  .num { display: inline-flex; width: 34px; height: 34px; border-radius: 50%; align-items: center; justify-content: center; font-weight: 700; font-size: 18px; color: #101826; margin-right: 10px; }
  .cap { font-size: 20px; font-weight: 700; margin-bottom: 4px; display: flex; align-items: center; }
  .capsub { color: #9fb0c8; font-size: 15px; margin: 0 0 12px 44px; }
  .shot { border-radius: 12px; border: 2px solid #2b3b58; display: block; }
  code { font-family: ui-monospace, Consolas, monospace; }
`;

const ACTION = `<!doctype html><meta charset="utf-8"><style>${BASE}
  body { width: 1800px; height: 600px; padding: 34px 40px; position: relative; }
  .row { display: flex; align-items: flex-start; margin-top: 30px; }
  .col { width: 500px; }
  .arrow { width: 150px; height: 300px; white-space: nowrap; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #9fb0c8; font-size: 15px; text-align: center; padding-top: 30px; }
  .arrow svg { margin-bottom: 8px; }
  .shot { width: 500px; height: auto; }
  /* the Discord channel illustration */
  .dc { width: 500px; height: 290px; border-radius: 12px; border: 2px solid #2b3b58; background: #313338; overflow: hidden; color: #dbdee1; }
  .dc .bar { height: 46px; background: #2b2d31; display: flex; align-items: center; padding: 0 16px; font-weight: 700; font-size: 17px; border-bottom: 1px solid #1e1f22; }
  .dc .bar span { color: #80848e; font-weight: 400; margin-right: 8px; font-size: 22px; }
  .msg { display: flex; padding: 22px 18px; }
  .av { width: 48px; height: 48px; border-radius: 50%; background: linear-gradient(135deg, #4c8dff, #5865f2); color: #fff; font-weight: 700; font-size: 17px; display: flex; align-items: center; justify-content: center; flex: none; margin-right: 14px; }
  .who { font-size: 16.5px; font-weight: 600; color: #f2f3f5; }
  .tag { background: #5865f2; color: #fff; font-size: 11px; font-weight: 700; border-radius: 4px; padding: 1px 5px; margin-left: 6px; vertical-align: 2px; }
  .time { color: #949ba4; font-size: 12px; margin-left: 8px; font-weight: 400; }
  .text { font-size: 16.5px; margin-top: 4px; line-height: 1.35; }
  .note { position: absolute; left: 40px; right: 40px; bottom: 26px; color: #7d8ba1; font-size: 13.5px; }
</style>
<h1>One button press, one Discord message</h1>
<div class="sub">A real plugin, running in the real app. Everything on the left and middle is a screenshot of VR Macro Pad.</div>
<div class="row">
  <div class="col">
    <div class="cap"><span class="num" style="background:#9fb0c8">1</span>Ready</div>
    <div class="capsub">The plugin's <b>Announce</b> button, waiting</div>
    <img class="shot" src="${img('deck-before.png')}">
  </div>
  <div class="arrow"><svg width="80" height="30" viewBox="0 0 80 30"><path d="M4 15 H68" stroke="#9fb0c8" stroke-width="3.5" fill="none"/><path d="M58 5 L72 15 L58 25" stroke="#9fb0c8" stroke-width="3.5" fill="none"/></svg>tap it, or<br>laser-click in VR</div>
  <div class="col">
    <div class="cap"><span class="num" style="background:#5865f2;color:#fff">2</span>Sent</div>
    <div class="capsub">It lights up and confirms</div>
    <img class="shot" src="${img('deck-after.png')}">
  </div>
  <div class="arrow"><svg width="80" height="30" viewBox="0 0 80 30"><path d="M4 15 H68" stroke="#5865f2" stroke-width="3.5" fill="none"/><path d="M58 5 L72 15 L58 25" stroke="#5865f2" stroke-width="3.5" fill="none"/></svg>POSTs to the<br>webhook</div>
  <div class="col">
    <div class="cap"><span class="num" style="background:#7fe0b8">3</span>Delivered</div>
    <div class="capsub">The message appears in your channel</div>
    <div class="dc">
      <div class="bar"><span>#</span>announcements</div>
      <div class="msg"><div class="av">VM</div><div><div class="who">${posted.username}<span class="tag">BOT</span><span class="time">Today at 6:40 PM</span></div><div class="text">${posted.content}</div></div></div>
    </div>
  </div>
</div>
<div class="note">Panel 3 is an illustration of a Discord channel; the name and message text are exactly what the plugin sent in this run.</div>
`;

const EDITOR = `<!doctype html><meta charset="utf-8"><style>${BASE}
  body { width: 1500px; height: 850px; padding: 34px 40px; position: relative; overflow: hidden; }
  .stage { position: relative; width: 760px; margin-top: 26px; }
  .stage .shot { width: 760px; }
  .pin { position: absolute; width: 34px; height: 34px; border-radius: 50%; background: #e8a45c; color: #101826; font-weight: 700; font-size: 18px; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 0 4px rgba(16,24,38,.75); }
  .side { position: absolute; left: 860px; top: 130px; width: 600px; }
  .item { display: flex; margin-bottom: 30px; }
  .item .pin { position: static; flex: none; margin-right: 16px; }
  .item h3 { margin: 2px 0 8px; font-size: 20px; }
  pre { margin: 0; padding: 12px 14px; background: #0b111c; border: 1px solid #2b3b58; border-radius: 10px; font-size: 14.5px; line-height: 1.5; color: #c9d4e5; white-space: pre-wrap; }
  .k { color: #8fd694; }
</style>
<h1>Your <code>actions.js</code>, as the button editor</h1>
<div class="sub">The editor is generated from what the action declares. You write no interface code.</div>
<div class="stage">
  <img class="shot" src="${img('editor.png')}">
  <div class="pin" style="left:262px;top:270px">1</div>
  <div class="pin" style="left:178px;top:316px">2</div>
  <div class="pin" style="left:452px;top:404px">3</div>
</div>
<div class="side">
  <div class="item"><div class="pin">1</div><div><h3>The step's title and icon</h3><pre>label: <span class="k">'Send a message'</span>,
icon: <span class="k">'💬'</span>,</pre></div></div>
  <div class="item"><div class="pin">2</div><div><h3>A field for each param, and the * for required</h3><pre>params: [{
  key: <span class="k">'message'</span>,
  type: <span class="k">'textarea'</span>,
  required: <span class="k">true</span>,
}],</pre></div></div>
  <div class="item"><div class="pin">3</div><div><h3>The hint under the field</h3><pre>help: <span class="k">'Up to 2000 characters.
       Discord formatting works…'</span></pre></div></div>
  <div style="color:#9fb0c8;font-size:15px">When you press <b>Save</b>, the message you typed is handed to your action as <code>params.message</code>.</div>
</div>
`;

async function render(html, w, h, name) {
  const f = path.join(os.tmpdir(), `${name}.html`);
  fs.writeFileSync(f, html);
  const win = new BrowserWindow({ show: false, width: w, height: h, useContentSize: true, frame: false, backgroundColor: '#101826', webPreferences: { offscreen: true, backgroundThrottling: false } });
  win.webContents.setFrameRate(10);
  await win.loadFile(f);
  await sleep(900);
  const png = (await win.webContents.capturePage()).toPNG();
  fs.writeFileSync(path.join(OUT, `${name}.png`), png);
  win.destroy();
  console.log('wrote', name, png.length);
}

app.whenReady().then(async () => {
  await render(ACTION, 1800, 600, 'plugin-in-action');
  await render(EDITOR, 1500, 850, 'plugin-button-editor');
  app.quit();
});
