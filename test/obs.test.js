const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const { ObsClient, authString } = require('../plugins/obs/client');
const { PluginRuntime } = require('../src/core/plugin-runtime');
const { registry } = require('../src/core/actions');
const { StateHub } = require('../src/core/state');
const { FakeHelper, waitFor } = require('./helpers');

// Minimal obs-websocket v5 server: hello -> identify (with optional auth) -> requests + events.
function mockObs({ password = '' } = {}) {
  const wss = new WebSocketServer({ port: 0, handleProtocols: (p) => (p.has('obswebsocket.json') ? 'obswebsocket.json' : false) });
  const state = { scene: 'Gaming', recording: false, requests: [], sockets: new Set(), inputMuted: { Mic: false } };
  const salt = 'c2FsdHNhbHRzYWx0';
  const challenge = 'Y2hhbGxlbmdl';
  wss.on('connection', (ws) => {
    state.sockets.add(ws);
    ws.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.4.0', rpcVersion: 1, ...(password ? { authentication: { challenge, salt } } : {}) } }));
    ws.on('message', (raw) => {
      const { op, d } = JSON.parse(raw.toString());
      if (op === 1) {
        if (password && d.authentication !== authString(password, salt, challenge)) {
          ws.close(4009, 'Authentication failed');
          return;
        }
        ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
      } else if (op === 6) {
        state.requests.push({ type: d.requestType, data: d.requestData });
        let data = {};
        let ok = true;
        switch (d.requestType) {
          case 'GetSceneList': data = { currentProgramSceneName: state.scene, scenes: [{ sceneName: 'Gaming' }, { sceneName: 'Chatting' }] }; break;
          case 'GetRecordStatus': data = { outputActive: state.recording }; break;
          case 'GetStreamStatus': data = { outputActive: false }; break;
          case 'GetReplayBufferStatus': ok = false; break;
          case 'GetInputList': data = { inputs: [{ inputName: 'Mic' }] }; break;
          case 'GetInputMute': data = { inputMuted: state.inputMuted[d.requestData.inputName] }; break;
          case 'SetCurrentProgramScene': state.scene = d.requestData.sceneName; break;
          case 'ToggleRecord': state.recording = !state.recording; data = { outputActive: state.recording }; break;
          default: break;
        }
        ws.send(JSON.stringify({ op: 7, d: { requestType: d.requestType, requestId: d.requestId, requestStatus: { result: ok, code: ok ? 100 : 604, comment: ok ? undefined : 'Replay buffer is not enabled' }, responseData: data } }));
      }
    });
    ws.on('close', () => state.sockets.delete(ws));
  });
  const emit = (eventType, eventData) => { for (const s of state.sockets) s.send(JSON.stringify({ op: 5, d: { eventType, eventIntent: 1, eventData } })); };
  return new Promise((resolve) => wss.on('listening', () => resolve({ wss, state, emit, port: wss.address().port })));
}

test('obs: auth string matches the v5 spec algorithm', () => {
  // secret = b64(sha256(password+salt)); auth = b64(sha256(secret+challenge))
  const crypto = require('crypto');
  const b64 = (s) => crypto.createHash('sha256').update(s).digest('base64');
  assert.equal(authString('pw', 'salt', 'chal'), b64(b64('pwsalt') + 'chal'));
});

test('obs: connects without a password, answers requests, receives events', async () => {
  const srv = await mockObs();
  const obs = new ObsClient();
  obs.configure({ host: '127.0.0.1', port: srv.port, password: '' });
  const events = [];
  obs.on('event', (e) => events.push(e));
  obs.want(true);
  await waitFor(() => obs.status === 'connected');
  const list = await obs.request('GetSceneList');
  assert.equal(list.currentProgramSceneName, 'Gaming');
  srv.emit('RecordStateChanged', { outputActive: true });
  await waitFor(() => events.length);
  assert.deepEqual(events[0], { type: 'RecordStateChanged', data: { outputActive: true } });
  await assert.rejects(obs.request('GetReplayBufferStatus'), /Replay buffer is not enabled/);
  obs.want(false);
  srv.wss.close();
});

test('obs: authenticates with a password and reports a wrong one without retry-spamming', async () => {
  const srv = await mockObs({ password: 'hunter2' });
  const good = new ObsClient();
  good.configure({ host: '127.0.0.1', port: srv.port, password: 'hunter2' });
  good.want(true);
  await waitFor(() => good.status === 'connected');
  good.want(false);

  const bad = new ObsClient();
  bad.configure({ host: '127.0.0.1', port: srv.port, password: 'wrong' });
  bad.want(true);
  await waitFor(() => bad.status === 'auth-failed');
  assert.match(bad.error, /password/);
  await assert.rejects(bad.request('GetSceneList'), /password is wrong/);
  bad.want(false);
  srv.wss.close();
});

test('obs: requests fail fast when not connected, and it reconnects after a drop', async () => {
  const srv = await mockObs();
  const obs = new ObsClient();
  obs.configure({ host: '127.0.0.1', port: srv.port, password: '' });
  await assert.rejects(obs.request('GetSceneList'), /not connected/);
  obs.want(true);
  await waitFor(() => obs.status === 'connected');
  for (const s of srv.state.sockets) s.terminate();
  await waitFor(() => obs.status !== 'connected');
  await waitFor(() => obs.status === 'connected', 5000);
  obs.want(false);
  srv.wss.close();
});

test('providers: OBS state reaches the hub, follows events, and clears on disconnect', async () => {
  const srv = await mockObs();
  const hub = new StateHub();
  const providers = new PluginRuntime({ registry, helper: new FakeHelper(), hub });
  providers.configure({ plugins: { obs: { host: '127.0.0.1', port: srv.port, password: '' } }, osc: { host: '127.0.0.1', sendPort: 9000, listenPort: 0, listen: false } });
  providers.sync({ obs: true });
  await waitFor(() => hub.eval('obs.scene=Gaming') === true);
  assert.equal(hub.eval('obs.recording'), false);
  assert.equal(hub.eval('obs.replay'), false, 'replay buffer error becomes "off", not a crash');
  assert.equal(hub.eval('obs.inputMuted=Mic'), false);
  srv.emit('RecordStateChanged', { outputActive: true });
  await waitFor(() => hub.eval('obs.recording') === true);
  srv.emit('CurrentProgramSceneChanged', { sceneName: 'Chatting' });
  await waitFor(() => hub.eval('obs.scene=Chatting') === true);
  assert.equal(hub.eval('obs.scene=Gaming'), false);
  const scenes = await providers.options('obs.scenes');
  assert.deepEqual(scenes.map((s) => s.value).sort(), ['Chatting', 'Gaming']);
  for (const s of srv.state.sockets) s.terminate();
  providers.sync({ obs: false });
  await waitFor(() => hub.eval('obs.recording') === undefined);
  providers.stop();
  srv.wss.close();
});

test('providers: asking for OBS scenes when OBS is down gives a helpful error', async () => {
  const hub = new StateHub();
  const providers = new PluginRuntime({ registry, helper: new FakeHelper(), hub });
  providers.configure({ plugins: { obs: { host: '127.0.0.1', port: 1, password: '' } }, osc: { host: '127.0.0.1', sendPort: 9000, listenPort: 0, listen: false } });
  await assert.rejects(providers.options('obs.scenes'), /not reachable/);
  providers.stop();
});
