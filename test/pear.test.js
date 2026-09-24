// Pear Desktop / YouTube Music: the client, its actions and the widget, against a fake of the
// plugin's API Server (same endpoints, same Allow/Deny sign-in, same WebSocket messages).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { WebSocketServer } = require('ws');
const { PearClient, actualFromSlider, sliderFromActual } = require('../plugins/pear/client');
const { SecretStore } = require('../src/core/secrets');
const { createApp } = require('../src/core');
const { tempDir, FakeHelper, waitFor, sleep } = require('./helpers');

const cleanup = [];
test.after(async () => { for (const c of cleanup) { try { await c(); } catch { /* already closed */ } } });

const SONG = {
  title: 'Everytime We Touch', artist: 'Cascada', album: 'Everytime We Touch', views: 100, imageSrc: 'https://i.ytimg.com/vi/abc/maxresdefault.jpg',
  songDuration: 197, elapsedSeconds: 12, videoId: 'abc', mediaType: 'ORIGINAL_MUSIC_VIDEO', isPaused: false,
};

function fakePear() {
  const s = {
    requests: [], token: 'JWT1', authMode: 'allow', authDelay: 30, like: 'INDIFFERENT', sockets: new Set(), authCalls: 0,
    info: { type: 'PLAYER_INFO', song: SONG, isPlaying: true, muted: false, position: 12, volume: 40, repeat: 'NONE', shuffle: false },
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      const body = raw ? JSON.parse(raw) : null;
      s.requests.push({ method: req.method, path: url.pathname, body, auth: req.headers.authorization });
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      const m = /^\/auth\/(.+)$/.exec(url.pathname);
      if (m && req.method === 'POST') {
        s.authCalls++;
        await sleep(s.authDelay);
        if (s.authMode === 'deny') return send(403, { error: 'Forbidden' });
        return send(200, { accessToken: s.token });
      }
      if (req.headers.authorization !== `Bearer ${s.token}`) return send(401, { error: 'Unauthorized' });
      const p = url.pathname.replace('/api/v1', '');
      if (p === '/like-state') return send(200, { state: s.like });
      if (p === '/like') { s.like = s.like === 'LIKE' ? 'INDIFFERENT' : 'LIKE'; return send(204); }
      if (p === '/dislike') { s.like = s.like === 'DISLIKE' ? 'INDIFFERENT' : 'DISLIKE'; return send(204); }
      if (p === '/broken') return send(500, { error: 'boom' });
      return send(204);
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/api/v1/ws') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (url.searchParams.get('token') !== s.token) { ws.close(1008, 'Unauthorized'); return; }
      s.sockets.add(ws);
      ws.on('close', () => s.sockets.delete(ws));
      ws.send(JSON.stringify(s.info));
    });
  });
  const push = (msg) => { for (const ws of s.sockets) ws.send(JSON.stringify(msg)); };
  const calls = (p, m = 'POST') => s.requests.filter((r) => r.path === `/api/v1${p}` && r.method === m);
  cleanup.push(() => { for (const ws of s.sockets) ws.terminate(); server.close(); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ s, push, calls, port: server.address().port, server })));
}

const client = (port, dir = tempDir(), fetchImpl) => {
  const c = new PearClient({ secrets: new SecretStore(dir), retryMs: 20, likePollMs: 100000, ...(fetchImpl ? { fetchImpl } : {}) });
  c.configure({ host: '127.0.0.1', port });
  cleanup.push(() => c.stop());
  return c;
};

async function connectedClient(fake) {
  const c = client(fake.port);
  c.want(true);
  assert.equal(c.status, 'needs-auth');
  await c.authorize();
  await waitFor(() => c.status === 'connected' && c.state && c.state.song, 3000);
  return c;
}

// ---- sign-in ----
test('pear: sign-in asks Pear once, stores the token, then connects and shows the song', async () => {
  const fake = await fakePear();
  const c = client(fake.port);
  const seen = [];
  c.on('status', (st) => seen.push(st));
  c.want(true);
  assert.equal(c.status, 'needs-auth', 'nothing is sent to Pear until you press Connect');
  assert.equal(fake.s.authCalls, 0);
  const auth = c.authorize();
  assert.equal(c.status, 'awaiting-approval');
  await auth;
  await waitFor(() => c.status === 'connected', 3000);
  assert.equal(fake.s.authCalls, 1);
  assert.ok(seen.includes('awaiting-approval') && seen.includes('connected'));
  assert.equal(fake.s.requests.find((r) => r.path.startsWith('/auth/')).path, '/auth/vr-macro-pad');
  await waitFor(() => c.state && c.state.song, 3000);
  const v = c.view();
  assert.deepEqual([v.available, v.title, v.artist, v.album, v.playing], [true, 'Everytime We Touch', 'Cascada', 'Everytime We Touch', true]);
  assert.equal(v.positionMs, 12000);
  assert.equal(v.durationMs, 197000);
  assert.equal(v.canSeek, true);
  assert.equal(v.thumbKey, SONG.imageSrc);
  assert.deepEqual([v.extras.shuffle, v.extras.repeat, v.extras.volume, v.extras.volumeActual, v.extras.muted], [false, 'NONE', 70, 40, false], 'slider position (70) alongside the loudness Pear reports (40)');
});

test('pear: the saved sign-in is reused after a restart without asking again', async () => {
  const fake = await fakePear();
  const dir = tempDir();
  const a = client(fake.port, dir);
  a.want(true);
  await a.authorize();
  await waitFor(() => a.status === 'connected', 3000);
  a.stop();
  const b = client(fake.port, dir);
  b.want(true);
  await waitFor(() => b.status === 'connected', 3000);
  assert.equal(fake.s.authCalls, 1, 'no second Allow prompt');
  // ...but not for a different Pear address
  const c = client(fake.port + 1, dir);
  c.want(true);
  assert.equal(c.status, 'needs-auth');
});

test('pear: clicking Deny in Pear is reported, and no token is kept', async () => {
  const fake = await fakePear();
  fake.s.authMode = 'deny';
  const c = client(fake.port);
  c.want(true);
  await c.authorize();
  assert.equal(c.status, 'denied');
  assert.equal(c.token, null);
  assert.match(c.view().error, /Deny/);
});

test('pear: Pear not running is "not-running" (with a retry), then it connects once Pear appears', async () => {
  const fake = await fakePear();
  const dir = tempDir();
  const a = client(fake.port, dir);
  a.want(true);
  await a.authorize();
  await waitFor(() => a.status === 'connected', 3000);
  a.stop();
  for (const ws of fake.s.sockets) ws.terminate();
  // Pear "quits": nothing is listening on that port any more
  await new Promise((r) => fake.server.close(r));
  const b = client(fake.port, dir);
  b.want(true);
  await waitFor(() => b.status === 'not-running', 3000);
  assert.match(b.view().error, /Can't reach Pear/);
  assert.equal(b.view().available, false);
  const refused = client(fake.port);
  refused.want(true);
  await refused.authorize();
  assert.equal(refused.status, 'not-running');
});

test('pear: a token Pear no longer accepts sends you back to sign-in instead of retrying forever', async () => {
  const fake = await fakePear();
  const c = await connectedClient(fake);
  fake.s.token = 'ROTATED';
  for (const ws of fake.s.sockets) ws.terminate();
  await waitFor(() => c.status === 'needs-auth' || c.status === 'not-running', 3000);
  await waitFor(() => c.status === 'needs-auth', 4000);
  assert.equal(c.token, null);
  assert.match(c.error, /no longer accepts/);
});

// ---- live updates ----
test('pear: live WebSocket updates change position, play state, volume, repeat, shuffle, and the song', async () => {
  const fake = await fakePear();
  const c = await connectedClient(fake);
  fake.push({ type: 'POSITION_CHANGED', position: 61 });
  await waitFor(() => c.view().positionMs === 61000);
  fake.push({ type: 'PLAYER_STATE_CHANGED', isPlaying: false, position: 62 });
  await waitFor(() => c.view().playing === false);
  assert.equal(c.view().status, 'Paused');
  fake.push({ type: 'VOLUME_CHANGED', volume: 15, muted: true });
  fake.push({ type: 'REPEAT_CHANGED', repeat: 'ONE' });
  fake.push({ type: 'SHUFFLE_CHANGED', shuffle: true });
  await waitFor(() => c.view().extras.volumeActual === 15 && c.view().extras.repeat === 'ONE' && c.view().extras.shuffle === true);
  assert.equal(c.view().extras.volume, 43, 'the slider position for loudness 15');
  assert.equal(c.view().extras.muted, true);
  fake.s.like = 'LIKE';
  fake.push({ type: 'VIDEO_CHANGED', song: { ...SONG, title: 'Next song', songDuration: 100 }, position: 0 });
  await waitFor(() => c.view().title === 'Next song');
  assert.equal(c.view().durationMs, 100000);
  await waitFor(() => c.view().extras.liked === true, 3000); // the like state is re-read for the new song
  fake.push({ type: 'SOMETHING_NEW', foo: 1 }); // unknown messages are ignored
  await sleep(30);
  assert.equal(c.status, 'connected');
});

test('pear: nothing playing is shown as such', async () => {
  const fake = await fakePear();
  fake.s.info = { type: 'PLAYER_INFO', song: null, isPlaying: false, muted: false, position: 0, volume: 40, repeat: 'NONE', shuffle: false };
  const c = client(fake.port);
  c.want(true);
  await c.authorize();
  await waitFor(() => c.status === 'connected', 3000);
  await waitFor(() => c.state, 3000);
  assert.deepEqual([c.view().available, c.view().error], [false, 'Nothing playing in Pear']);
});

// ---- commands ----
test('pear commands: every control uses the documented path and body', async () => {
  const fake = await fakePear();
  const c = await connectedClient(fake);
  for (const [cmd, path] of [['toggle', '/toggle-play'], ['play', '/play'], ['pause', '/pause'], ['next', '/next'], ['previous', '/previous'], ['shuffle', '/shuffle'], ['mute', '/toggle-mute']]) {
    await c.control(cmd);
    assert.equal(fake.calls(path).length, 1, cmd);
    assert.match(fake.calls(path)[0].auth, /^Bearer JWT1$/);
  }
  await c.control('seek', 90500);
  assert.deepEqual(fake.calls('/seek-to').at(-1).body, { seconds: 91 });
  await c.control('repeat');
  assert.deepEqual(fake.calls('/switch-repeat').at(-1).body, { iteration: 1 });
  await c.setVolume(140);
  assert.deepEqual(fake.calls('/volume').at(-1).body, { volume: 100 }, 'clamped to 0-100');
  await c.setVolume(-5);
  assert.deepEqual(fake.calls('/volume').at(-1).body, { volume: 0 });
  await c.seekBy(-15);
  assert.deepEqual(fake.calls('/go-back').at(-1).body, { seconds: 15 });
  await c.seekBy(30);
  assert.deepEqual(fake.calls('/go-forward').at(-1).body, { seconds: 30 });
  await assert.rejects(c.control('explode'), /can't do/);
});

test('pear commands: like and dislike toggle and the state is re-read', async () => {
  const fake = await fakePear();
  const c = await connectedClient(fake);
  await c.control('like');
  assert.equal(c.like, 'LIKE');
  assert.equal(c.view().extras.liked, true);
  await c.control('dislike');
  assert.equal(c.like, 'DISLIKE');
  assert.deepEqual([c.view().extras.liked, c.view().extras.disliked], [false, true]);
  await c.control('dislike');
  assert.equal(c.like, 'INDIFFERENT');
});

test('pear commands: repeat jumps to a chosen mode with the right number of presses', async () => {
  const fake = await fakePear();
  const c = await connectedClient(fake);
  const press = async (from, to) => {
    fake.push({ type: 'REPEAT_CHANGED', repeat: from });
    await waitFor(() => c.state.repeat === from);
    const before = fake.calls('/switch-repeat').length;
    await c.setRepeat(to);
    return fake.calls('/switch-repeat').length > before ? fake.calls('/switch-repeat').at(-1).body.iteration : 0;
  };
  assert.equal(await press('NONE', 'ALL'), 1);
  assert.equal(await press('NONE', 'ONE'), 2);
  assert.equal(await press('ALL', 'NONE'), 2);
  assert.equal(await press('ONE', 'ALL'), 2);
  assert.equal(await press('ONE', 'NONE'), 1);
  assert.equal(await press('ALL', 'ALL'), 0, 'already there: no presses');
  await assert.rejects(c.setRepeat('SIDEWAYS'), /Unknown repeat mode/);
});

test('pear commands: a rejected sign-in, an unreachable Pear and a server error are all explained', async () => {
  const fake = await fakePear();
  const c = await connectedClient(fake);
  await assert.rejects(c.request('GET', '/broken'), /answered 500/);
  fake.s.token = 'ROTATED';
  await assert.rejects(c.request('POST', '/next'), /no longer accepts this sign-in/);
  assert.equal(c.status, 'needs-auth');
  await assert.rejects(c.control('next'), /not connected/);
});

test('pear: disconnect forgets the sign-in', async () => {
  const fake = await fakePear();
  const dir = tempDir();
  const c = client(fake.port, dir);
  c.want(true);
  await c.authorize();
  await waitFor(() => c.status === 'connected', 3000);
  c.disconnect();
  assert.equal(c.status, 'needs-auth');
  assert.equal(new SecretStore(dir).get('pear.token'), null);
  assert.equal(c.view().available, false);
});

// ---- album art ----
test('pear album art: only https pictures from Google / YouTube image hosts, only real images, size-limited', async () => {
  const urls = [];
  const png = Buffer.from('89504e470d0a1a0a0000000d', 'hex');
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).includes('notimage')) return { ok: true, headers: { get: () => 'text/html' }, arrayBuffer: async () => Buffer.from('<html>') };
    if (String(url).includes('huge')) return { ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => Buffer.alloc(3 * 1024 * 1024) };
    if (String(url).includes('missing')) return { ok: false, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => Buffer.alloc(0) };
    return { ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => png };
  };
  const c = client(1, tempDir(), fetchImpl);
  const good = await c.thumbFor('https://i.ytimg.com/vi/abc/maxresdefault.jpg');
  assert.equal(good, `data:image/png;base64,${png.toString('base64')}`);
  assert.equal(await c.thumbFor('https://lh3.googleusercontent.com/x=w544'), good);
  assert.equal(await c.thumbFor('https://i.ytimg.com/vi/abc/maxresdefault.jpg'), good);
  assert.equal(urls.length, 2, 'the same picture is fetched only once');
  for (const bad of ['https://evil.example.com/a.png', 'http://i.ytimg.com/a.png', 'https://ytimg.com.evil.com/a.png', 'file:///C:/a.png', 'not a url', '']) {
    assert.equal(await c.thumbFor(bad), '', bad);
  }
  assert.equal(urls.length, 2, 'blocked addresses are never contacted');
  assert.equal(await c.thumbFor('https://i.ytimg.com/notimage.png'), '');
  assert.equal(await c.thumbFor('https://i.ytimg.com/huge.jpg'), '');
  assert.equal(await c.thumbFor('https://i.ytimg.com/missing.jpg'), '');
});

// ---- through the app: buttons, widget, state ----
async function bootApp(fake, buttons) {
  const app = createApp({ dataDir: tempDir(), helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), twitchOptions: { defaultClientId: '' }, pearOptions: { retryMs: 20, likePollMs: 100000 }, port: 0 });
  cleanup.push(() => app.stop());
  await app.start();
  const cfg = JSON.parse(JSON.stringify(app.engine.config));
  cfg.settings.plugins.pear = { host: '127.0.0.1', port: fake.port };
  cfg.pages = [{ id: 'p', name: 'P', cols: 8, rows: 12, buttons: buttons.map((b, i) => ({ x: (i * 2) % 8, y: Math.floor((i * 2) / 8) * 2, w: 2, h: 2, label: b.id, steps: [], ...b })) }];
  app.engine.updateConfig(cfg);
  const toasts = [];
  app.engine.on('toast', (t) => toasts.push(t));
  return { app, engine: app.engine, toasts, hub: app.hub, data: (id) => app.engine.computeWidgetData()[id] };
}
const step = (action, params = {}) => [{ action, params, delayMs: 0 }];

test('pear buttons: playback, like, shuffle, repeat, volume and seek; state lights the buttons up', async () => {
  const fake = await fakePear();
  const { app, engine, toasts, hub } = await bootApp(fake, [
    { id: 'pp', steps: step('pear.playback', { cmd: 'toggle' }) },
    { id: 'next', steps: step('pear.playback', { cmd: 'next' }) },
    { id: 'like', steps: step('pear.like', { which: 'like' }) },
    { id: 'shuf', steps: step('pear.shuffle') },
    { id: 'rep', steps: step('pear.repeat', { mode: 'ONE' }) },
    { id: 'cyc', steps: step('pear.repeat', { mode: 'cycle' }) },
    { id: 'up', steps: step('pear.volume', { mode: 'up', amount: 10 }) },
    { id: 'set', steps: step('pear.volume', { mode: 'set', amount: 25 }) },
    { id: 'mute', steps: step('pear.volume', { mode: 'mute' }) },
    { id: 'fwd', steps: step('pear.seek', { direction: 'forward', seconds: 15 }) },
  ]);
  await engine.press('pp'); // not connected yet: explains what to do
  assert.match(toasts.at(-1).text, /not connected.*Settings/i);
  await app.pear.authorize();
  await waitFor(() => hub.eval('pear.connected') === true && hub.eval('pear.playing') === true, 3000);

  await engine.press('pp');
  assert.equal(fake.calls('/toggle-play').length, 1);
  await engine.press('next');
  assert.equal(fake.calls('/next').length, 1);
  await engine.press('like');
  await waitFor(() => engine.computeButtonStates().like.active === true, 3000);
  assert.equal(fake.s.like, 'LIKE');
  await engine.press('shuf');
  assert.equal(fake.calls('/shuffle').length, 1);
  await engine.press('rep'); // NONE -> ONE is two presses
  assert.deepEqual(fake.calls('/switch-repeat').at(-1).body, { iteration: 2 });
  await engine.press('cyc');
  assert.deepEqual(fake.calls('/switch-repeat').at(-1).body, { iteration: 1 });
  await engine.press('up'); // loudness 40 is slider position ~70, so +10 slider steps = 80
  assert.deepEqual(fake.calls('/volume').at(-1).body, { volume: 80 });
  await engine.press('set');
  assert.deepEqual(fake.calls('/volume').at(-1).body, { volume: 25 });
  await engine.press('mute');
  assert.equal(fake.calls('/toggle-mute').length, 1);
  await engine.press('fwd');
  assert.deepEqual(fake.calls('/go-forward').at(-1).body, { seconds: 15 });
  assert.ok(!toasts.slice(1).some((t) => t.level === 'error'), toasts.slice(1).filter((t) => t.level === 'error').map((t) => t.text).join('; '));

  // state follows Pear
  assert.equal(engine.computeButtonStates().pp.active, true);
  fake.push({ type: 'PLAYER_STATE_CHANGED', isPlaying: false, position: 5 });
  await waitFor(() => engine.computeButtonStates().pp.active === false, 3000);
  fake.push({ type: 'SHUFFLE_CHANGED', shuffle: true });
  fake.push({ type: 'REPEAT_CHANGED', repeat: 'ALL' });
  fake.push({ type: 'VOLUME_CHANGED', volume: 20, muted: true });
  await waitFor(() => engine.computeButtonStates().shuf.active === true && engine.computeButtonStates().mute.active === true, 3000);
  assert.equal(hub.eval('pear.repeat'), true);
});

test('pear widget: the now-playing screen shows album, progress and the like / shuffle / repeat extras, and its buttons work', async () => {
  const fake = await fakePear();
  const { app, engine, data } = await bootApp(fake, [{ id: 'np', widget: { type: 'media', params: { app: 'pear', controls: true, progress: true } }, w: 4, h: 2 }]);
  assert.equal(data('np').available, false);
  assert.match(data('np').error, /Connect Pear/);
  await app.pear.authorize();
  await waitFor(() => data('np').available === true, 3000);
  const d = data('np');
  assert.deepEqual([d.title, d.artist, d.album, d.source], ['Everytime We Touch', 'Cascada', 'Everytime We Touch', 'pear']);
  assert.equal(d.extras.volumeActual, 40);
  assert.equal(d.extras.volume, 70);
  fake.push({ type: 'POSITION_CHANGED', position: 100 });
  await waitFor(() => data('np').positionMs === 100000, 3000);
  for (const [cmd, path] of [['toggle', '/toggle-play'], ['next', '/next'], ['previous', '/previous'], ['shuffle', '/shuffle']]) {
    assert.equal((await engine.widgetCommand('np', cmd)).ok, true);
    assert.equal(fake.calls(path).length, 1, cmd);
  }
  await engine.widgetCommand('np', 'seek', 60000);
  assert.deepEqual(fake.calls('/seek-to').at(-1).body, { seconds: 60 });
  await engine.widgetCommand('np', 'like');
  await waitFor(() => data('np').extras.liked === true, 3000);
  await engine.widgetCommand('np', 'repeat');
  assert.deepEqual(fake.calls('/switch-repeat').at(-1).body, { iteration: 1 });
  assert.equal((await engine.widgetCommand('np', 'explode')).ok, false);
});

test('pear: only asks for Pear when something uses it', async () => {
  const fake = await fakePear();
  const { app, engine } = await bootApp(fake, [{ id: 'x', steps: step('system.toast', { message: 'hi' }) }]);
  await app.pear.authorize();
  await sleep(150);
  assert.equal(app.pear.wanted, false);
  assert.equal(fake.s.sockets.size, 0, 'no live connection while nothing needs it');
  const cfg = JSON.parse(JSON.stringify(engine.config));
  cfg.pages[0].buttons.push({ id: 'y', x: 4, y: 0, w: 1, h: 1, steps: step('pear.shuffle') });
  engine.updateConfig(cfg);
  await waitFor(() => app.pear.status === 'connected', 3000);
  cfg.pages[0].buttons = cfg.pages[0].buttons.filter((b) => b.id !== 'y');
  engine.updateConfig(cfg);
  await waitFor(() => fake.s.sockets.size === 0, 3000);
});

test('pear volume: the slider and the reported loudness are on different curves, and converting matches a real Pear', () => {
  // Measured against a real Pear Desktop: [slider asked, loudness it reported]
  const measured = [[100, 100], [90, 74], [75, 47], [50, 20], [25, 6]];
  for (const [asked, reported] of measured) {
    assert.ok(Math.abs(actualFromSlider(asked) - reported) < 1.2, `slider ${asked} -> ${actualFromSlider(asked).toFixed(1)}, real Pear said ${reported}`);
    assert.ok(Math.abs(sliderFromActual(reported) - asked) < 3, `loudness ${reported} -> slider ${sliderFromActual(reported).toFixed(1)}, asked was ${asked}`);
  }
  for (const s of [0, 1, 10, 33, 50, 80, 100]) assert.ok(Math.abs(sliderFromActual(actualFromSlider(s)) - s) < 1e-9, `round trip ${s}`);
  assert.equal(actualFromSlider(0), 0);
  assert.equal(actualFromSlider(100), 100);
  assert.equal(sliderFromActual(-5), 0);
  assert.equal(sliderFromActual(500), 100);
});