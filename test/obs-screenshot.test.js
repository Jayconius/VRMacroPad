// "Take a screenshot (OBS)": asks OBS to save a picture, checks it landed, and lets a Discord step send exactly that picture.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { ObsClient } = require('../plugins/obs/client');
const obsActions = require('../plugins/obs/actions');
const discordActions = require('../plugins/discord/actions');
const { tempDir, waitFor } = require('./helpers');

// A tiny obs-websocket v5 server that saves screenshots for real (into the path it is asked for), like OBS on the same PC.
function mockObs({ savesFile = true } = {}) {
  const wss = new WebSocketServer({ port: 0, handleProtocols: (p) => (p.has('obswebsocket.json') ? 'obswebsocket.json' : false) });
  const requests = [];
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.4.0', rpcVersion: 1 } }));
    ws.on('message', (raw) => {
      const { op, d } = JSON.parse(raw.toString());
      if (op === 1) { ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } })); return; }
      if (op !== 6) return;
      requests.push({ type: d.requestType, data: d.requestData });
      let data = {}, ok = true, comment;
      if (d.requestType === 'GetCurrentProgramScene') data = { currentProgramSceneName: 'Gaming', sceneName: 'Gaming' };
      else if (d.requestType === 'SaveSourceScreenshot') {
        if (d.requestData.sourceName === 'Nope') { ok = false; comment = 'No source was found by that name'; }
        else if (savesFile) fs.writeFileSync(d.requestData.imageFilePath, 'PICTURE');
      }
      ws.send(JSON.stringify({ op: 7, d: { requestType: d.requestType, requestId: d.requestId, requestStatus: { result: ok, code: ok ? 100 : 600, comment }, responseData: data } }));
    });
  });
  return new Promise((resolve) => wss.on('listening', async () => {
    const client = new ObsClient();
    client.configure({ host: '127.0.0.1', port: wss.address().port, password: '' });
    client.want(true);
    await waitFor(() => client.status === 'connected');
    resolve({ client, requests, close: () => { client.want(false); wss.close(); } });
  }));
}
const shot = obsActions.find((a) => a.id === 'obs.screenshot');
const context = (client) => { const obs = { client, lastScreenshot: '' }; const toasts = []; return { obs, toasts, ctx: { plugin: () => obs, toast: (t, l) => toasts.push([t, l]) } }; };

test('obs screenshot: saves the current scene into the folder with a dated name, and remembers it', async () => {
  const srv = await mockObs();
  const folder = path.join(tempDir(), 'not', 'made', 'yet');
  const { obs, ctx, toasts } = context(srv.client);
  await shot.run({ what: 'program', folder, format: 'png' }, ctx);
  const req = srv.requests.find((r) => r.type === 'SaveSourceScreenshot');
  assert.equal(req.data.sourceName, 'Gaming', 'the scene that is live');
  assert.equal(req.data.imageFormat, 'png');
  assert.equal(path.dirname(req.data.imageFilePath), folder, 'the folder was created');
  assert.match(path.basename(req.data.imageFilePath), /^OBS_\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d\.png$/);
  assert.equal(fs.readFileSync(req.data.imageFilePath, 'utf8'), 'PICTURE');
  assert.equal(obs.lastScreenshot, req.data.imageFilePath);
  assert.match(toasts[0][0], /Screenshot saved: OBS_/);
  await shot.run({ what: 'program', folder, format: 'png' }, ctx);
  const paths = srv.requests.filter((r) => r.type === 'SaveSourceScreenshot').map((r) => r.data.imageFilePath);
  assert.equal(new Set(paths).size, 2, 'two in the same second never overwrite each other');
  srv.close();
});

test('obs screenshot: one source as a JPG with a quality, and OBS errors are passed on', async () => {
  const srv = await mockObs();
  const folder = tempDir();
  const { ctx } = context(srv.client);
  await shot.run({ what: 'source', source: 'Webcam', folder, format: 'jpg', quality: 70 }, ctx);
  const req = srv.requests.find((r) => r.type === 'SaveSourceScreenshot');
  assert.deepEqual([req.data.sourceName, req.data.imageFormat, req.data.imageCompressionQuality], ['Webcam', 'jpg', 70]);
  assert.match(req.data.imageFilePath, /\.jpg$/);
  assert.ok(!srv.requests.some((r) => r.type === 'GetCurrentProgramScene'), 'a chosen source does not ask which scene is live');
  await assert.rejects(shot.run({ what: 'source', source: 'Nope', folder }, ctx), /No source was found/);
  await assert.rejects(shot.run({ what: 'source', source: '  ', folder }, ctx), /Pick a source first/);
  srv.close();
});

test('obs screenshot: if OBS says it saved but no file appears, it says so instead of pretending', async () => {
  const srv = await mockObs({ savesFile: false });
  const { obs, ctx } = context(srv.client);
  await assert.rejects(shot.run({ what: 'program', folder: tempDir() }, ctx), /file is not there/);
  assert.equal(obs.lastScreenshot, '', 'nothing is remembered');
  srv.close();
});

test('discord: "send the last OBS screenshot" posts exactly the picture OBS just saved, and explains when there is none', async () => {
  const srv = await mockObs();
  const { obs, ctx: obsCtx } = context(srv.client);
  const sent = [];
  const ctx = { toast: () => {}, plugin: (id) => (id === 'obs' ? obs : { send: async (o) => { sent.push(o); }, newestPicture: () => { throw new Error('not used'); } }), helper: { call: async () => [] } };
  const send = discordActions.find((a) => a.id === 'discord.file');
  assert.ok(send.params.find((p) => p.key === 'source').options.some((o) => o[0] === 'obs'));
  await assert.rejects(send.run({ source: 'obs' }, ctx), /No OBS screenshot yet/);
  await shot.run({ what: 'program', folder: tempDir() }, obsCtx);
  await send.run({ source: 'obs', message: 'Live now' }, ctx);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].file, obs.lastScreenshot);
  assert.equal(sent[0].content, 'Live now');
  const discordStub = ctx.plugin('discord');
  ctx.plugin = (id) => { if (id === 'obs') throw new Error('the OBS plugin is switched off'); return discordStub; };
  await assert.rejects(send.run({ source: 'obs' }, ctx), /No OBS screenshot yet/, 'a switched-off OBS plugin gives the same clear message');
  srv.close();
});
