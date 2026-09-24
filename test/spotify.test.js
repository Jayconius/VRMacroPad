// Spotify Web API ("Like"): the PKCE sign-in on a local callback page, token refresh, like / unlike,
// error messages, and the buttons and widget that use it. Runs against a local fake of Spotify.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { SpotifyClient } = require('../plugins/spotify/client');
const { SecretStore } = require('../src/core/secrets');
const { createApp } = require('../src/core');
const { tempDir, FakeHelper, waitFor } = require('./helpers');

const cleanup = [];
test.after(async () => { for (const c of cleanup) { try { await c(); } catch { /* already stopped */ } } });

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// A stand-in for accounts.spotify.com (token endpoint) and api.spotify.com.
async function fakeSpotify() {
  const f = {
    calls: [], tokenCalls: [], saved: new Set(), playing: { uri: 'spotify:track:abc', name: 'Song', type: 'track' },
    accessN: 0, refreshN: 0, expireAccess: false, failRefresh: false, modern: true, denyAll: 0, challenge: '',
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      if (url.pathname === '/api/token') {
        const p = new URLSearchParams(body);
        f.tokenCalls.push(Object.fromEntries(p));
        if (p.get('grant_type') === 'authorization_code') {
          const okVerifier = b64url(crypto.createHash('sha256').update(p.get('code_verifier') || '').digest()) === f.challenge;
          if (p.get('code') !== 'GOODCODE' || !okVerifier) return send(400, { error: 'invalid_grant', error_description: 'bad code or verifier' });
          f.accessN++;
          return send(200, { access_token: `access${f.accessN}`, refresh_token: 'refresh1', expires_in: f.expireAccess ? 90 : 3600, scope: 'user-read-currently-playing user-library-read user-library-modify' });
        }
        if (p.get('grant_type') === 'refresh_token') {
          if (f.failRefresh) return send(400, { error: 'invalid_grant', error_description: 'Refresh token revoked' });
          f.refreshN++; f.accessN++;
          return send(200, { access_token: `access${f.accessN}`, expires_in: 3600, scope: '' }); // no new refresh token: keep the old one
        }
        return send(400, { error: 'unsupported_grant_type' });
      }
      const auth = req.headers.authorization || '';
      f.calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth });
      if (f.denyAll) return send(f.denyAll, { error: { status: f.denyAll, message: 'User not registered in the Developer Dashboard' } });
      if (auth === 'Bearer stale') return send(401, { error: { status: 401, message: 'The access token expired' } });
      if (url.pathname === '/v1/me') return send(200, { id: 'u1', display_name: 'Jay' });
      if (url.pathname === '/v1/me/player/currently-playing') {
        if (!f.playing) return send(204);
        return send(200, { item: { ...f.playing, artists: [{ name: 'Band' }] }, currently_playing_type: f.playing.type });
      }
      const modern = url.pathname.startsWith('/v1/me/library');
      const old = url.pathname.startsWith('/v1/me/tracks');
      if ((modern && !f.modern) || old && f.modern) return send(404, { error: { status: 404, message: 'Service not found' } });
      if (modern || old) {
        const key = modern ? url.searchParams.get('uris') : `spotify:track:${url.searchParams.get('ids')}`;
        if (url.pathname.endsWith('/contains')) return send(200, [f.saved.has(key)]);
        if (req.method === 'PUT') { f.saved.add(key); return send(200); }
        if (req.method === 'DELETE') { f.saved.delete(key); return send(200); }
      }
      return send(404, { error: { status: 404, message: 'no such thing' } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  f.base = `http://127.0.0.1:${server.address().port}`;
  f.close = () => { server.closeAllConnections(); server.close(); };
  cleanup.push(f.close);
  return f;
}

function makeClient(f, extra = {}) {
  const secrets = new SecretStore(tempDir());
  const client = new SpotifyClient({ secrets, apiBase: `${f.base}/v1`, authBase: f.base, callbackPort: 0, defaultClientId: '', ...extra });
  cleanup.push(() => client.stop());
  return { client, secrets };
}

// What the browser does after you click Allow on Spotify: open the redirect URI with a code.
function browserGet(port, pathAndQuery, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathAndQuery, headers, agent: false }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    }).on('error', reject);
  });
}

async function signedIn(f, extra) {
  const made = makeClient(f, extra);
  made.client.configure({ clientId: 'cid' });
  const { url } = await made.client.startAuth();
  const u = new URL(url);
  f.challenge = u.searchParams.get('code_challenge');
  const redirect = new URL(u.searchParams.get('redirect_uri'));
  const r = await browserGet(redirect.port, `${redirect.pathname}?code=GOODCODE&state=${u.searchParams.get('state')}`, { Host: redirect.host });
  assert.equal(r.status, 200);
  await waitFor(() => made.client.isConnected(), 2000);
  return made;
}

// ---- sign-in ----
test('sign-in: builds a PKCE request for exactly what it needs, and only the right callback completes it', async () => {
  const f = await fakeSpotify();
  const { client, secrets } = makeClient(f);
  await assert.rejects(() => client.startAuth(), /Client ID/);
  client.configure({ clientId: 'my-client' });
  assert.equal(client.status, 'needs-auth');

  const { url, redirectUri } = await client.startAuth();
  const u = new URL(url);
  assert.equal(u.origin, f.base);
  assert.equal(u.pathname, '/authorize');
  assert.equal(u.searchParams.get('client_id'), 'my-client');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('redirect_uri'), redirectUri);
  assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/, 'loopback IP, never "localhost"');
  assert.deepEqual(u.searchParams.get('scope').split(' ').sort(), ['user-library-modify', 'user-library-read', 'user-read-currently-playing']);
  assert.ok(!u.searchParams.has('client_secret'));
  assert.equal(client.status, 'authorizing');
  f.challenge = u.searchParams.get('code_challenge');
  const state = u.searchParams.get('state');
  const redirect = new URL(redirectUri);

  const wrongState = await browserGet(redirect.port, `/callback?code=GOODCODE&state=nope`, { Host: redirect.host });
  assert.equal(wrongState.status, 400);
  const wrongHost = await browserGet(redirect.port, `/callback?code=GOODCODE&state=${state}`, { Host: `evil.example:${redirect.port}` });
  assert.equal(wrongHost.status, 404, 'a request with a foreign Host header (DNS rebinding) is ignored');
  const wrongPath = await browserGet(redirect.port, `/other?code=GOODCODE&state=${state}`, { Host: redirect.host });
  assert.equal(wrongPath.status, 404);
  assert.equal(client.status, 'authorizing', 'none of those ended the sign-in');
  assert.equal(f.tokenCalls.length, 0);

  const ok = await browserGet(redirect.port, `/callback?code=GOODCODE&state=${state}`, { Host: redirect.host });
  assert.equal(ok.status, 200);
  assert.match(ok.text, /Spotify connected/);
  assert.equal(client.status, 'connected');
  assert.deepEqual(client.user, { id: 'u1', name: 'Jay' });
  assert.equal(f.tokenCalls[0].client_id, 'my-client');
  assert.ok(!('client_secret' in f.tokenCalls[0]));
  assert.equal(f.tokenCalls[0].redirect_uri, redirectUri);
  const saved = JSON.parse(secrets.get('spotify.tokens'));
  assert.equal(saved.refresh, 'refresh1');
  assert.equal(saved.clientId, 'my-client');
  await assert.rejects(() => browserGet(redirect.port, '/callback', { Host: redirect.host }), 'the callback page is gone once signed in');
});

test('sign-in: declining on Spotify, a bad code, and a busy port are reported plainly', async () => {
  const f = await fakeSpotify();
  const a = makeClient(f);
  a.client.configure({ clientId: 'cid' });
  let { url } = await a.client.startAuth();
  let u = new URL(url);
  let redirect = new URL(u.searchParams.get('redirect_uri'));
  await browserGet(redirect.port, `/callback?error=access_denied&state=${u.searchParams.get('state')}`, { Host: redirect.host });
  assert.equal(a.client.status, 'needs-auth');
  assert.match(a.client.error, /declined/i);

  ({ url } = await a.client.startAuth());
  u = new URL(url);
  f.challenge = 'something else'; // Spotify would reject a verifier that does not match
  redirect = new URL(u.searchParams.get('redirect_uri'));
  await browserGet(redirect.port, `/callback?code=GOODCODE&state=${u.searchParams.get('state')}`, { Host: redirect.host });
  assert.equal(a.client.status, 'needs-auth');
  assert.match(a.client.error, /refused the sign-in/);
  assert.equal(a.secrets.get('spotify.tokens'), null);

  // the fixed port is taken by another copy
  const blocker = http.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  cleanup.push(() => blocker.close());
  const b = makeClient(f, { callbackPort: blocker.address().port });
  b.client.configure({ clientId: 'cid' });
  await assert.rejects(() => b.client.startAuth(), /is busy/);
});

test('sign-in: a saved sign-in is restored, and one made with a different Client ID is not', async () => {
  const f = await fakeSpotify();
  const first = await signedIn(f);
  const again = new SpotifyClient({ secrets: first.secrets, apiBase: `${f.base}/v1`, authBase: f.base, callbackPort: 0, defaultClientId: '' });
  again.configure({ clientId: 'cid' });
  assert.equal(again.status, 'connected');
  assert.equal(again.user.name, 'Jay');
  again.configure({ clientId: 'someone-elses' });
  assert.equal(again.status, 'needs-auth');
  await first.client.disconnect();
  assert.equal(first.secrets.get('spotify.tokens'), null);
  assert.equal(first.client.status, 'needs-auth');
});

// ---- like ----
test('like: toggles the current song in and out of Liked Songs, and says what happened', async () => {
  const f = await fakeSpotify();
  const { client } = await signedIn(f);
  let r = await client.likeCurrent('toggle');
  assert.equal(r.liked, true);
  assert.equal(r.track.name, 'Song');
  const put = f.calls.find((c) => c.method === 'PUT');
  assert.equal(put.path, '/v1/me/library');
  assert.equal(put.query.uris, 'spotify:track:abc');
  assert.equal(put.auth, 'Bearer access1');
  assert.deepEqual(await client.likedState(), { track: { uri: 'spotify:track:abc', name: 'Song', artist: 'Band' }, liked: true });
  r = await client.likeCurrent('toggle');
  assert.equal(r.liked, false);
  assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 1);
  assert.equal((await client.likeCurrent('unlike')).liked, false);
  assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 1, '"unlike" on a song that is not liked does nothing');
  assert.equal((await client.likeCurrent('like')).liked, true);
  assert.equal((await client.likeCurrent('like')).liked, true);
  assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 2, '"like" on a liked song does nothing');
});

test('like: nothing playing, an ad or a podcast, and apps that still have the old library endpoints', async () => {
  const f = await fakeSpotify();
  const { client } = await signedIn(f);
  f.playing = null;
  await assert.rejects(() => client.likeCurrent(), /Nothing is playing/);
  assert.equal(await client.likedState(), null);
  f.playing = { uri: 'spotify:episode:xyz', name: 'Pod', type: 'episode' };
  await assert.rejects(() => client.likeCurrent(), /Nothing is playing/);

  f.playing = { uri: 'spotify:track:old1', name: 'Old', type: 'track' };
  f.modern = false; // an app that predates the February 2026 change
  assert.equal((await client.likeCurrent()).liked, true);
  assert.ok(f.calls.some((c) => c.path === '/v1/me/tracks' && c.method === 'PUT' && c.query.ids === 'old1'));
});

test('like: development-mode refusals explain themselves', async () => {
  const f = await fakeSpotify();
  const { client } = await signedIn(f);
  f.denyAll = 403;
  await assert.rejects(() => client.likeCurrent(), (e) => /403/.test(e.message) && /Premium/.test(e.message) && /User Management/.test(e.message));
  f.denyAll = 429;
  await assert.rejects(() => client.likeCurrent(), /slow down/);
});

// ---- tokens ----
test('tokens: refreshed before they run out and after a 401; a revoked sign-in asks for a new one', async () => {
  const f = await fakeSpotify();
  f.expireAccess = true; // tokens that live only 90 s (the app refreshes when under 60 s are left)
  let t = 1_000_000;
  const { client, secrets } = await signedIn(f, { now: () => t });
  assert.equal(f.refreshN, 0);
  t += 40_000; // 50 s left: refresh first
  await client.likedState();
  assert.equal(f.refreshN, 1);
  assert.equal(f.calls.at(-1).auth, 'Bearer access2');
  assert.equal(JSON.parse(secrets.get('spotify.tokens')).refresh, 'refresh1', 'keeps the old refresh token when Spotify sends no new one');

  client.tokens.access = 'stale'; // Spotify says 401 although we thought it was fine
  client.tokens.expiresAt = t + 3_600_000;
  await client.likedState();
  assert.equal(f.refreshN, 2);
  assert.equal(f.calls.at(-1).auth, 'Bearer access3');

  f.failRefresh = true;
  client.tokens.expiresAt = t - 1;
  await assert.rejects(() => client.likedState(), /expired/);
  assert.equal(client.status, 'needs-auth');
  assert.equal(secrets.get('spotify.tokens'), null);
});

// ---- inside the app ----
test('app: the Like button, its lit-up state, and the now-playing widget heart', async () => {
  const f = await fakeSpotify();
  const dir = tempDir();
  new SecretStore(dir).set('spotify.tokens', JSON.stringify({ access: 'access0', refresh: 'refresh1', expiresAt: Date.now() + 3_600_000, scopes: [], clientId: 'built-in-id', user: { id: 'u1', name: 'Jay' } }));
  const media = new FakeHelper({
    get: () => ({ available: true, appId: 'Spotify.exe', sessions: ['Spotify.exe'], title: 'Song', artist: 'Band', album: '', status: 'Playing', positionMs: 0, startMs: 0, endMs: 1000, updatedAt: 0, canSeek: true, thumbKey: 'k', thumb: '', shuffle: false, repeat: 'None' }),
    control: true,
  });
  const app = createApp({
    dataDir: dir, helper: new FakeHelper(), mediaHelper: media, vrHelper: new FakeHelper(), port: 0,
    twitchOptions: { defaultClientId: '' }, pearOptions: { retryMs: 60000 },
    spotifyOptions: { apiBase: `${f.base}/v1`, authBase: f.base, callbackPort: 0, defaultClientId: 'built-in-id' },
  });
  cleanup.push(() => app.stop());
  await app.start();
  const cfg = JSON.parse(JSON.stringify(app.engine.config));
  cfg.pages = [{ id: 'p', name: 'P', cols: 8, rows: 4, buttons: [
    { id: 'like', x: 0, y: 0, w: 2, h: 2, label: 'Like', steps: [{ action: 'spotify.like', params: {}, delayMs: 0 }] },
    { id: 'np', x: 2, y: 0, w: 4, h: 2, label: '', widget: { type: 'media', params: { app: 'spotify' } }, steps: [] },
  ] }];
  app.engine.updateConfig(cfg);

  await waitFor(() => app.hub.eval('spotify.liked') === false, 3000);
  assert.equal(app.providers.status().plugins.spotify.status, 'connected');
  assert.equal(app.engine.computeButtonStates().like.active, false);
  await waitFor(() => app.engine.computeWidgetData().np.available === true, 3000);
  assert.equal(app.engine.computeWidgetData().np.extras.liked, false);
  assert.equal(app.engine.computeWidgetData().np.extras.shuffle, false, 'Windows still supplies shuffle and repeat');

  await app.engine.press('like');
  assert.equal(f.saved.has('spotify:track:abc'), true);
  assert.equal(app.hub.eval('spotify.liked'), true);
  assert.equal(app.engine.computeButtonStates().like.active, true, 'the button lights up');
  assert.equal(app.engine.computeWidgetData().np.extras.liked, true, 'and so does the widget heart');

  const tapped = await app.engine.widgetCommand('np', 'like'); // the heart in the widget
  assert.equal(tapped.ok, true);
  assert.equal(f.saved.has('spotify:track:abc'), false);
  assert.equal(app.engine.computeWidgetData().np.extras.liked, false);
  const nope = await app.engine.widgetCommand('np', 'dislike');
  assert.equal(nope.ok, false);
});

test('app: without a connection, Like tells you how to set it up instead of failing silently', async () => {
  const f = await fakeSpotify();
  const app = createApp({
    dataDir: tempDir(), helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), port: 0,
    twitchOptions: { defaultClientId: '' }, pearOptions: { retryMs: 60000 },
    spotifyOptions: { apiBase: `${f.base}/v1`, authBase: f.base, callbackPort: 0, defaultClientId: '' },
  });
  cleanup.push(() => app.stop());
  await app.start();
  const toasts = [];
  app.engine.on('toast', (t) => toasts.push(t));
  const cfg = JSON.parse(JSON.stringify(app.engine.config));
  cfg.pages = [{ id: 'p', name: 'P', cols: 8, rows: 4, buttons: [{ id: 'like', x: 0, y: 0, w: 2, h: 2, label: 'Like', steps: [{ action: 'spotify.like', params: {}, delayMs: 0 }] }] }];
  app.engine.updateConfig(cfg);
  await app.engine.press('like');
  assert.ok(toasts.some((t) => /Settings/.test(t.text) && /Spotify/.test(t.text)), 'a message that points at Settings');
  assert.equal(f.calls.length, 0, 'and nothing was sent to Spotify');
});

test('settings: the Spotify client id is kept, trimmed, and never appears in an exported layout twice', async () => {
  const f = await fakeSpotify();
  const app = createApp({ dataDir: tempDir(), helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), port: 0, twitchOptions: { defaultClientId: '' }, spotifyOptions: { apiBase: `${f.base}/v1`, authBase: f.base, callbackPort: 0, defaultClientId: '' } });
  cleanup.push(() => app.stop());
  await app.start();
  const cfg = JSON.parse(JSON.stringify(app.engine.config));
  cfg.settings.plugins.spotify = { clientId: '   abc123  ' };
  app.engine.updateConfig(cfg);
  assert.equal(app.engine.config.settings.plugins.spotify.clientId, 'abc123');
  assert.equal(app.spotify.clientId, 'abc123');
  assert.equal(app.spotify.status, 'needs-auth');
  assert.ok(fs.existsSync(path.join(app.store.dir, 'config.json')));
});
