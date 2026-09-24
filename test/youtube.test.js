// The YouTube plugin, run against a simulated Google + YouTube: its sign-in (PKCE, offline access, client secret), tokens,
// every button's request, the polled broadcast state and the error messages. Also the Cloudflare Worker that keeps the secret.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const nodePath = require('path');
const HAS_WORKER = fs.existsSync(nodePath.join(__dirname, '..', 'plugins', 'youtube', 'broker', 'worker.mjs'));
const NEEDS_WORKER = { skip: !HAS_WORKER && 'the Worker source is not in this checkout' };
const KEY_TOOL = nodePath.join(__dirname, '..', 'tools', 'youtube-keys', 'make-key');
const NEEDS_WORKER_AND_KEY_TOOL = { skip: !(HAS_WORKER && fs.existsSync(KEY_TOOL + '.js')) && 'the Worker source or the key tool is not in this checkout' };
const { pathToFileURL } = require('url');
const { StateHub } = require('../src/core/state');
const { createApp } = require('../src/core');
const { FakeHelper, tempDir } = require('./helpers');
const { SCOPES } = require('../plugins/youtube/client');
const { YouTubeRuntime } = require('../plugins/youtube/runtime');
const actions = require('../plugins/youtube/actions');
const widgets = require('../plugins/youtube/widgets');
const manifest = require('../plugins/youtube/plugin');

const act = (id) => actions.find((a) => a.id === id);
const widget = (id) => widgets.find((w) => w.id === id);
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const LIVE = { id: 'vid1', snippet: { title: 'VRChat night', description: 'hello', liveChatId: 'chat1', actualStartTime: '2026-01-01T10:00:00Z', scheduledStartTime: '2026-01-01T09:55:00Z' }, status: { lifeCycleStatus: 'live', privacyStatus: 'public' }, contentDetails: { boundStreamId: 'strm1' } };
const UPCOMING = (id, at) => ({ id, snippet: { title: `Show ${id}`, liveChatId: `chat-${id}`, scheduledStartTime: at }, status: { lifeCycleStatus: 'ready', privacyStatus: 'unlisted' }, contentDetails: { boundStreamId: 'strm1' } });

// A simulated Google: accounts (token endpoint) and the YouTube Data API v3, on one local port.
async function fakeYouTube() {
  const seen = [];
  const k = { seen, tokenCalls: [], expire401: 0, refreshFails: false, active: [], upcoming: [], forceError: null, health: 'good', hasChannel: true };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const url = new URL(req.url, 'http://x');
      const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
      if (url.pathname === '/token') {
        const form = Object.fromEntries(new URLSearchParams(raw));
        k.tokenCalls.push(form);
        if (form.grant_type === 'refresh_token' && k.refreshFails) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        if (form.grant_type === 'authorization_code' && form.code === 'BAD') return json(400, { error: 'invalid_grant', error_description: 'Bad Request' });
        const first = form.grant_type === 'authorization_code';
        return json(200, { access_token: `access-${k.tokenCalls.length}`, ...(first ? { refresh_token: 'refresh-1' } : {}), expires_in: 3600, token_type: 'Bearer', scope: SCOPES.join(' ') });
      }
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method, path: url.pathname.replace('/youtube/v3', ''), query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization });
      if (k.expire401 > 0) { k.expire401--; return json(401, { error: { code: 401, message: 'expired' } }); }
      if (k.forceError) return json(k.forceError.status, { error: { code: k.forceError.status, message: k.forceError.message || 'nope', errors: [{ reason: k.forceError.reason }] } });
      const p = `${req.method} ${url.pathname.replace('/youtube/v3', '')}`;
      const q = url.searchParams;
      if (p === 'GET /channels') {
        if (!k.hasChannel) return json(200, { items: [] });
        return json(200, { items: [q.get('part') === 'statistics' ? { id: 'UC1', statistics: { subscriberCount: '12345', viewCount: '987654', videoCount: '88' } } : { id: 'UC1', snippet: { title: 'My Channel' } }] });
      }
      if (p === 'GET /liveBroadcasts') return json(200, { items: q.get('broadcastStatus') === 'active' ? k.active : k.upcoming });
      if (p === 'GET /videos') {
        const part = q.get('part');
        if (part === 'snippet') return json(200, { items: [{ id: q.get('id'), snippet: { title: 'Old title', description: 'Old description', categoryId: '20', tags: ['vr', 'chat'], defaultLanguage: 'en', channelId: 'UC1' } }] });
        if (part === 'status') return json(200, { items: [{ id: q.get('id'), status: { privacyStatus: 'public', embeddable: true, license: 'youtube', publicStatsViewable: false, madeForKids: false, selfDeclaredMadeForKids: false, uploadStatus: 'uploaded' } }] });
        return json(200, { items: [{ id: q.get('id'), statistics: { likeCount: '42' }, liveStreamingDetails: { concurrentViewers: '17' } }] });
      }
      if (p === 'PUT /videos') return json(200, { id: body.id });
      if (p === 'GET /liveStreams') return json(200, { items: [{ id: q.get('id'), status: { streamStatus: 'active', healthStatus: { status: k.health } } }] });
      if (p === 'POST /liveChat/messages') return json(200, { id: 'msg1' });
      if (p === 'POST /liveBroadcasts/transition') return json(200, { id: q.get('id'), status: { lifeCycleStatus: q.get('broadcastStatus') } });
      if (p === 'POST /liveBroadcasts/cuepoint') return json(200, { cueType: body.cueType });
      return json(404, { error: { code: 404, message: 'not found', errors: [{ reason: 'notFound' }] } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  k.base = `http://127.0.0.1:${server.address().port}`;
  k.close = () => { server.closeAllConnections(); server.close(); };
  return k;
}

const memorySecrets = () => { const m = new Map(); return { get: (n) => m.get(n) || '', set: (n, v) => m.set(n, v), delete: (n) => m.delete(n), isEncrypted: () => true, has: (n) => m.has(n) }; };
const SETTINGS = { clientId: 'cid', clientSecret: 'sec' };

// Walks through the real sign-in: startAuth -> "the browser comes back" -> connected.
async function signIn(client) {
  const { url } = await client.startAuth();
  const u = new URL(url);
  const res = await fetch(`http://127.0.0.1:${client.auth.port}/callback?code=CODE1&state=${u.searchParams.get('state')}`);
  await res.text();
  return u;
}

function runtimeFor(k, { settings = SETTINGS, secrets = memorySecrets(), now = () => Date.now(), builtIn = { broker: '' }, callbackPort = 0 } = {}) {
  const hub = new StateHub();
  const ctx = { hub, now, emitStatus() {}, settings: () => settings, secrets };
  const rt = new YouTubeRuntime(ctx, { apiBase: `${k.base}/youtube/v3`, authUrl: `${k.base}/auth`, tokenUrl: `${k.base}/token`, callbackPort, now, defaultBrokerUrl: builtIn.broker || '' });
  rt.configure();
  return { rt, hub, secrets, ctx };
}
const toastCtx = (rt) => { const toasts = []; return { toasts, ctx: { plugin: () => rt, toast: (t, l) => toasts.push([t, l]) } }; };
const connected = async (k, options) => { const r = runtimeFor(k, options); await signIn(r.rt.client); return r; };
const sent = (k, method, path) => k.seen.filter((s) => s.method === method && s.path === path);

test('youtube sign-in: PKCE, offline access, the secret and the scope go out as Google documents, and tokens are kept', async () => {
  const k = await fakeYouTube();
  const { rt, secrets } = runtimeFor(k);
  const { url } = await rt.connect();
  const u = new URL(url);
  assert.equal(`${u.origin}${u.pathname}`, `${k.base}/auth`);
  assert.deepEqual([u.searchParams.get('client_id'), u.searchParams.get('response_type'), u.searchParams.get('code_challenge_method')], ['cid', 'code', 'S256']);
  assert.deepEqual([u.searchParams.get('access_type'), u.searchParams.get('prompt')], ['offline', 'consent'], 'a refresh token is requested so you sign in once');
  assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/youtube.force-ssl');
  const redirect = u.searchParams.get('redirect_uri');
  assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/callback$/, 'the loopback address a Google desktop app uses');
  assert.equal(rt.status().status, 'authorizing');
  const bad = await fetch(`http://127.0.0.1:${rt.client.auth.port}/callback?code=x&state=wrong`);
  assert.equal(bad.status, 400, 'a return with the wrong state is refused');
  assert.equal(rt.status().status, 'authorizing');
  const wrongHost = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: rt.client.auth.port, path: '/callback?code=x&state=' + u.searchParams.get('state'), headers: { Host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); }));
  assert.equal(wrongHost, 404, 'only the exact local address is answered');
  const good = await fetch(`http://127.0.0.1:${rt.client.auth.port}/callback?code=CODE1&state=${u.searchParams.get('state')}`);
  assert.match(await good.text(), /YouTube connected/);
  const call = k.tokenCalls[0];
  assert.deepEqual([call.grant_type, call.code, call.client_id, call.client_secret, call.redirect_uri], ['authorization_code', 'CODE1', 'cid', 'sec', redirect]);
  assert.equal(b64url(crypto.createHash('sha256').update(call.code_verifier).digest()), u.searchParams.get('code_challenge'), 'the verifier matches the challenge');
  assert.equal(rt.status().status, 'connected');
  assert.deepEqual(rt.status().user, { id: 'UC1', name: 'My Channel' });
  assert.ok(secrets.has('tokens'));
  assert.ok(!JSON.stringify(rt.status()).includes('sec"'), 'the secret is never part of the status');
  const before = k.seen.length;
  assert.equal(runtimeFor(k, { secrets }).rt.status().status, 'connected', 'a fresh start reads the sign-in back');
  assert.equal(k.seen.length, before, 'without asking Google anything');
  await rt.disconnect();
  assert.equal(secrets.has('tokens'), false);
  assert.equal(rt.status().status, 'needs-auth');
  k.close();
});

test('youtube sign-in: a busy port falls back to a free one, and declining, a bad code, missing settings and no channel are explained', async () => {
  const k = await fakeYouTube();
  const blocker = http.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const busy = blocker.address().port;
  const { rt } = runtimeFor(k, { callbackPort: busy });
  let { url } = await rt.connect();
  assert.notEqual(rt.client.auth.port, busy, 'it did not fight over the busy port');
  assert.match(new URL(url).searchParams.get('redirect_uri'), new RegExp(`:${rt.client.auth.port}/callback$`));
  await fetch(`http://127.0.0.1:${rt.client.auth.port}/callback?error=access_denied&state=${new URL(url).searchParams.get('state')}`);
  assert.match(rt.status().error, /declined/);
  ({ url } = await rt.connect());
  await (await fetch(`http://127.0.0.1:${rt.client.auth.port}/callback?code=BAD&state=${new URL(url).searchParams.get('state')}`)).text();
  assert.equal(rt.status().status, 'needs-auth');
  assert.match(rt.status().error, /Google refused the sign-in.*Desktop app/);
  blocker.close();

  const empty = runtimeFor(k, { settings: { clientId: '', clientSecret: '' } });
  await assert.rejects(empty.rt.connect(), /Client ID and Client Secret.*Instructions button/s);
  assert.equal(empty.rt.status().status, 'off');
  const half = runtimeFor(k, { settings: { clientId: 'cid', clientSecret: '' } });
  await assert.rejects(half.rt.connect(), /Client ID and Client Secret/);

  k.hasChannel = false;
  const noChannel = runtimeFor(k);
  await signIn(noChannel.rt.client);
  assert.equal(noChannel.rt.status().status, 'error');
  assert.match(noChannel.rt.status().error, /no YouTube channel/);
  k.close();
});

test('youtube tokens: refreshed before they expire (keeping the refresh token), retried after a 401, and an expired sign-in asks you to connect again', async () => {
  const k = await fakeYouTube();
  let clock = Date.now();
  const { rt, secrets } = await connected(k, { now: () => clock });
  clock += 3600 * 1000;
  await rt.client.me();
  const refresh = k.tokenCalls.find((c) => c.grant_type === 'refresh_token');
  assert.deepEqual([refresh.refresh_token, refresh.client_id, refresh.client_secret], ['refresh-1', 'cid', 'sec']);
  assert.equal(JSON.parse(secrets.get('tokens')).refresh, 'refresh-1', 'Google sends no new refresh token; the old one is kept');
  assert.equal(k.seen.at(-1).auth, `Bearer access-${k.tokenCalls.length}`, 'the new access token is used');

  k.expire401 = 1;
  await rt.client.me();
  assert.equal(k.tokenCalls.filter((c) => c.grant_type === 'refresh_token').length, 2, 'a 401 triggers one refresh and one retry');

  k.refreshFails = true;
  clock += 3600 * 1000;
  await assert.rejects(rt.client.me(), /sign-in expired/);
  assert.equal(rt.status().status, 'needs-auth');
  assert.match(rt.status().error, /Connect again/);
  assert.equal(secrets.has('tokens'), false);
  k.close();
});

test('youtube chat: goes to the live chat of the active broadcast, with the message checked first', async () => {
  const k = await fakeYouTube();
  const { rt } = await connected(k);
  const { ctx } = toastCtx(rt);
  await assert.rejects(act('youtube.chat').run({ message: 'hi' }, ctx), /no live broadcast with an open chat/);
  k.active = [LIVE];
  await act('youtube.chat').run({ message: '  Welcome in!  ' }, ctx);
  const call = sent(k, 'POST', '/liveChat/messages')[0];
  assert.equal(call.query.part, 'snippet');
  assert.deepEqual(call.body, { snippet: { liveChatId: 'chat1', type: 'textMessageEvent', textMessageDetails: { messageText: 'Welcome in!' } } });
  await assert.rejects(act('youtube.chat').run({ message: '   ' }, ctx), /Type a message/);
  await assert.rejects(act('youtube.chat').run({ message: 'x'.repeat(201) }, ctx), /200 characters/);
  assert.equal(sent(k, 'POST', '/liveChat/messages').length, 1, 'invalid messages never reached YouTube');
  k.close();
});

test('youtube go live / end stream: the right broadcast is moved to the right state, and the wrong moment is explained', async () => {
  const k = await fakeYouTube();
  const { rt } = await connected(k);
  const { ctx, toasts } = toastCtx(rt);
  await assert.rejects(act('youtube.goLive').run({}, ctx), /no live or upcoming broadcast/);
  k.upcoming = [UPCOMING('later', '2026-02-02T10:00:00Z'), UPCOMING('soon', '2026-01-02T10:00:00Z')];
  await act('youtube.goLive').run({}, ctx);
  let call = sent(k, 'POST', '/liveBroadcasts/transition')[0];
  assert.deepEqual([call.query.id, call.query.broadcastStatus, call.query.part], ['soon', 'live', 'id,status'], 'the next upcoming broadcast');
  assert.match(toasts.at(-1)[0], /Going live: Show soon/);
  await assert.rejects(act('youtube.endStream').run({}, ctx), /not live/);

  k.active = [LIVE];
  await assert.rejects(act('youtube.goLive').run({}, ctx), /already live/);
  await act('youtube.endStream').run({}, ctx);
  call = sent(k, 'POST', '/liveBroadcasts/transition').at(-1);
  assert.deepEqual([call.query.id, call.query.broadcastStatus], ['vid1', 'complete']);
  assert.equal(act('youtube.goLive').state({}), 'youtube.live');
  assert.equal(act('youtube.goLive').defaults.confirm, 'hold');
  assert.equal(act('youtube.endStream').defaults.confirm, 'hold');
  k.close();
});

test('youtube ad break: only while live, with a cuepoint of the chosen length', async () => {
  const k = await fakeYouTube();
  const { rt } = await connected(k);
  const { ctx } = toastCtx(rt);
  await assert.rejects(act('youtube.adBreak').run({ length: '30' }, ctx), /only run an ad break while you are live/);
  k.active = [LIVE];
  await act('youtube.adBreak').run({ length: '60' }, ctx);
  const call = sent(k, 'POST', '/liveBroadcasts/cuepoint')[0];
  assert.deepEqual([call.query.id, call.body], ['vid1', { cueType: 'cueTypeAd', durationSecs: 60 }]);
  await assert.rejects(act('youtube.adBreak').run({ length: '5' }, ctx), /10 to 180/);
  k.close();
});

test('youtube title / description / category: reads the video first and sends it all back with only your changes', async () => {
  const k = await fakeYouTube();
  const { rt } = await connected(k);
  const { ctx } = toastCtx(rt);
  k.active = [LIVE];
  await act('youtube.details').run({ title: 'New title', description: '', category: '24' }, ctx);
  let put = sent(k, 'PUT', '/videos')[0];
  assert.equal(put.query.part, 'snippet');
  assert.deepEqual(put.body, { id: 'vid1', snippet: { title: 'New title', description: 'Old description', categoryId: '24', tags: ['vr', 'chat'], defaultLanguage: 'en' } }, 'tags, language and the description are kept');
  await act('youtube.details').run({ title: '', description: 'Fresh text', category: '' }, ctx);
  put = sent(k, 'PUT', '/videos')[1];
  assert.deepEqual([put.body.snippet.title, put.body.snippet.description, put.body.snippet.categoryId], ['Old title', 'Fresh text', '20']);
  await assert.rejects(act('youtube.details').run({ title: '', description: '', category: '' }, ctx), /Give a title/);
  await assert.rejects(act('youtube.details').run({ title: 'x'.repeat(101) }, ctx), /100 characters/);
  await assert.rejects(act('youtube.details').run({ title: 'a <b> c' }, ctx), /cannot contain/);
  assert.equal(sent(k, 'PUT', '/videos').length, 2, 'invalid changes never reached YouTube');
  assert.deepEqual(act('youtube.details').params.find((p) => p.key === 'category').options[1], ['20', 'Gaming']);
  k.close();
});

test('youtube visibility: changes only the privacy and keeps the rest of the video\'s settings', async () => {
  const k = await fakeYouTube();
  const { rt } = await connected(k);
  const { ctx, toasts } = toastCtx(rt);
  k.upcoming = [UPCOMING('soon', '2026-01-02T10:00:00Z')];
  await act('youtube.privacy').run({ privacy: 'unlisted' }, ctx);
  const put = sent(k, 'PUT', '/videos')[0];
  assert.equal(put.query.part, 'status');
  assert.deepEqual(put.body, { id: 'soon', status: { privacyStatus: 'unlisted', embeddable: true, license: 'youtube', publicStatsViewable: false, selfDeclaredMadeForKids: false } }, 'read-only fields are not sent back');
  assert.match(toasts.at(-1)[0], /unlisted/);
  await assert.rejects(rt.client.setPrivacy('secret'), /public, unlisted or private/);
  k.close();
});

test('youtube errors: quota, live streaming not enabled, permissions and a missing chat each say what to do', async () => {
  const k = await fakeYouTube();
  const { rt } = await connected(k);
  const { ctx } = toastCtx(rt);
  k.active = [LIVE];
  for (const [status, reason, expected] of [
    [403, 'quotaExceeded', /daily allowance.*midnight Pacific/],
    [403, 'liveStreamingNotEnabled', /not enabled for live streaming.*youtube\.com\/features/],
    [403, 'insufficientPermissions', /Disconnect and Connect again/],
    [403, 'liveChatDisabled', /no live chat open/],
    [429, 'rateLimitExceeded', /slow down/],
    [404, 'notFound', /could not find that/],
    [400, 'invalidTransition', /rejected that/],
  ]) {
    k.forceError = { status, reason, message: 'detail' };
    await assert.rejects(act('youtube.chat').run({ message: 'hi' }, ctx), expected, `${status} ${reason}`);
  }
  k.forceError = null;
  await act('youtube.chat').run({ message: 'ok again' }, ctx);
  k.close();
});

test('youtube live state: polls the broadcast, viewers, likes and stream health, and only while something on the deck uses it', async () => {
  const k = await fakeYouTube();
  const { rt, hub } = await connected(k);
  assert.equal(hub.eval('youtube.connected'), true);
  await rt.poll();
  assert.equal(hub.eval('youtube.live'), false);
  assert.equal(rt.pollMs, 120000, 'slow while you are not live');
  assert.equal(sent(k, 'GET', '/videos').length, 0, 'nothing extra is asked while offline');

  k.active = [LIVE];
  await rt.poll();
  assert.equal(hub.eval('youtube.live'), true);
  assert.deepEqual([rt.viewers, rt.likes, rt.health], [17, 42, { status: 'active', health: 'good' }]);
  assert.equal(rt.pollMs, 60000);
  const live = widget('youtube.stream').data({ plugin: () => rt, now: () => Date.parse('2026-01-01T10:12:00Z') });
  assert.deepEqual([live.value, live.subtitle, live.status], ['17 watching', 'VRChat night', 'ok']);
  assert.deepEqual(live.items, [{ label: 'Live for', value: '12 min' }, { label: 'Likes', value: '42' }, { label: 'Health', value: 'Good' }]);
  k.health = 'bad';
  await rt.poll();
  assert.equal(widget('youtube.stream').data({ plugin: () => rt, now: () => Date.now() }).status, 'warn', 'a bad stream turns the screen to a warning');

  k.active = [];
  k.upcoming = [UPCOMING('soon', '2026-01-02T10:00:00Z')];
  await rt.poll();
  const idle = widget('youtube.stream').data({ plugin: () => rt, now: () => Date.now() });
  assert.deepEqual([idle.value, idle.subtitle], ['Offline', 'Next: Show soon']);

  // sync(): polling starts only when needed
  const s = runtimeFor(k);
  await signIn(s.rt.client);
  const before = k.seen.length;
  s.rt.sync({});
  assert.equal(s.rt.timer, null);
  assert.equal(k.seen.length, before, 'nothing polls when the deck does not use YouTube');
  s.rt.sync({ youtube: true, youtubeStats: true });
  assert.ok(s.rt.timer && s.rt.statsTimer);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.rt.stats && s.rt.stats.subscribers, 12345);
  s.rt.sync({});
  assert.equal(s.hub.eval('youtube.live'), undefined, 'its state keys are removed again');
  assert.equal(s.rt.statsTimer, null);
  k.close();
});

test('youtube screens: not connected, errors, channel numbers and hidden subscribers read clearly', async () => {
  const k = await fakeYouTube();
  const off = runtimeFor(k, { settings: { clientId: '', clientSecret: '' } });
  assert.match(widget('youtube.stream').data({ plugin: () => off.rt, now: () => 0 }).subtitle, /not connected/);
  assert.match(widget('youtube.channel').data({ plugin: () => null }).subtitle, /switched off/);
  const { rt } = await connected(k);
  assert.equal(widget('youtube.channel').data({ plugin: () => rt }).subtitle, 'Loading…');
  await rt.pollStats();
  const d = widget('youtube.channel').data({ plugin: () => rt });
  assert.deepEqual([d.value, d.subtitle, d.status], ['12K subscribers', '988K views · 88 videos', 'ok']);
  rt.stats = { subscribers: null, views: 5, videos: 1 };
  assert.equal(widget('youtube.channel').data({ plugin: () => rt }).value, 'Subs hidden');
  k.forceError = { status: 500, reason: 'backendError', message: 'boom' };
  await rt.poll();
  assert.equal(widget('youtube.stream').data({ plugin: () => rt, now: () => 0 }).status, 'error');
  assert.equal(widget('youtube.stream').needs().youtube, true);
  assert.deepEqual(widget('youtube.channel').needs(), { youtube: true, youtubeStats: true });
  k.close();
});

test('youtube plugin loads like any other, offers nothing that targets one viewer, and needs nothing outside its own folder', async () => {
  const app = createApp({ dataDir: tempDir(), helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), port: 0, twitchOptions: { defaultClientId: '' }, pearOptions: { retryMs: 60000 } });
  await app.start();
  assert.deepEqual(app.registry.errors.filter((e) => /youtube/.test(e.dir)), []);
  const m = app.registry.get('youtube');
  assert.ok(m);
  assert.deepEqual(m.actions.map((a) => a.id).sort(), ['youtube.adBreak', 'youtube.chat', 'youtube.details', 'youtube.endStream', 'youtube.goLive', 'youtube.privacy']);
  assert.ok(!m.actions.some((a) => /ban|timeout|unban|delete|mod/i.test(a.id)), 'no button targets a particular viewer');
  assert.deepEqual(m.matchState('youtube.live'), { youtube: true });
  assert.equal(m.matchState('twitch.live'), null);
  assert.match(m.instructions({ usingBuiltIn: true }), /built-in YouTube login.*access key/s);
  assert.match(m.instructions({}), /Client ID.*Client Secret.*Instructions/s);
  assert.match(m.instructions(), /Instructions/, 'works with no argument too');
  // the "Instructions" button: numbered steps whose links are https and only to hosts this plugin is allowed to open
  const { cleanGuide } = require('../src/core/actions');
  const guide = cleanGuide(m.guide);
  assert.equal(guide.button, 'Instructions');
  assert.ok(guide.steps.length >= 6);
  const links = guide.steps.flatMap((s) => s.links);
  assert.ok(links.length >= 6 && links.every((l) => l.url.startsWith('https://') && m.externalDomains.includes(new URL(l.url).hostname)), 'every guide link opens on a listed domain');
  assert.ok(guide.steps.some((s) => s.copy && s.copy.text === SCOPES[0]), 'the permission to paste can be copied');
  // the fields: Client ID + Secret up front; the access key tucked away, and never exported
  const field = (k) => m.settingsFields.find((f) => f.key === k);
  assert.ok(!field('clientId').advanced && !field('clientSecret').advanced);
  assert.deepEqual([field('accessKey').advanced, field('accessKey').type, field('clientSecret').type], [true, 'password', 'password']);
  assert.deepEqual(m.connections, [{ id: 'main', label: 'YouTube account', flow: 'redirect' }]);
  assert.deepEqual(m.externalDomains, ['accounts.google.com', 'console.cloud.google.com']);
  await app.stop();
  const dir = nodePath.join(__dirname, '..', 'plugins', 'youtube');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(nodePath.join(dir, f), 'utf8');
    const outside = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((x) => x[1]).filter((p) => p.startsWith('.') && !p.startsWith('./'));
    assert.deepEqual(outside, [], `${f} only requires files inside its own folder`);
  }
  assert.ok(fs.existsSync(nodePath.join(dir, 'youtube-app.example.json')));
  // your own youtube-app.json may exist locally; it must never be committed
  assert.match(fs.readFileSync(nodePath.join(__dirname, '..', '.gitignore'), 'utf8'), /plugins\/youtube\/youtube-app\.json/);
});

// ---------- the private helper: the Cloudflare Worker holds the secret and only answers people with an access key ----------
const loadWorker = async () => (await import(pathToFileURL(nodePath.join(__dirname, '..', 'plugins', 'youtube', 'broker', 'worker.mjs')).href)).default;
const KEY = 'good-key-1';
const ENV = { GOOGLE_CLIENT_ID: 'worker-client-id', GOOGLE_CLIENT_SECRET: 'worker-only-secret', YOUTUBE_ACCESS_KEYS: `${KEY}, second-key\nthird-key` };
const NO_OWN = { clientId: '', clientSecret: '' };

// Runs the real worker.mjs behind a local port; its call to Google's token endpoint is redirected to the simulated Google.
async function startBroker(k, env = { ...ENV }) {
  const worker = await loadWorker();
  const realFetch = globalThis.fetch;
  const seenByBroker = [];
  globalThis.fetch = (input, init) => realFetch(String(input && input.url ? input.url : input) === 'https://oauth2.googleapis.com/token' ? `${k.base}/token` : input, init);
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    seenByBroker.push({ method: req.method, path: req.url, body: body.toString(), key: req.headers['x-access-key'] });
    const headers = { 'content-type': req.headers['content-type'] || '' };
    if (req.headers['x-access-key'] !== undefined) headers['x-access-key'] = req.headers['x-access-key'];
    const r = await worker.fetch(new Request(`http://broker${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(await r.text());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, env, seenByBroker, close: () => { globalThis.fetch = realFetch; server.closeAllConnections(); server.close(); } };
}

test('youtube worker: a stranger sees only a friendly page; nothing works without a valid access key; and the secret never comes back out', NEEDS_WORKER, async () => {
  const worker = await loadWorker();
  const realFetch = globalThis.fetch;
  const upstream = [];
  let answer = { status: 200, body: { access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'Bearer', scope: 'x', id_token: 'LEAK', client_secret: 'LEAK' } };
  globalThis.fetch = async (url, init) => { upstream.push({ url: String(url), form: Object.fromEntries(init.body) }); if (answer.throws) throw new Error('down'); return new Response(JSON.stringify(answer.body), { status: answer.status }); };
  try {
    const call = (method, p, body, { env = ENV, key } = {}) => worker.fetch(new Request(`https://w.example${p}`, { method, headers: { 'content-type': 'application/json', ...(key === undefined ? {} : { 'X-Access-Key': key }) }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) }), env);
    const good = { code: 'C', code_verifier: 'V', redirect_uri: 'http://127.0.0.1:17424/callback' };

    // what someone who stumbles on the address sees
    for (const p of ['/', '/youtube', '/youtube/']) {
      const r = await call('GET', p);
      const html = await r.text();
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type'), /text\/html/);
      assert.match(html, /<svg/, 'it has the logo');
      assert.match(html, /VR Macro Pad/);
      assert.ok(!/youtube|google|sign-in|token|client|secret|key/i.test(html.replace(/<style>.*?<\/style>/s, '').replace(/<svg.*?<\/svg>/s, '')), 'the page says nothing about what runs here');
      assert.match(r.headers.get('x-robots-tag'), /noindex/, 'search engines are asked to skip it');
    }
    for (const p of ['/token', '/refresh', '/nope', '/youtube/token']) assert.equal((await call('GET', p)).status, 404, p);
    assert.match(await (await call('GET', '/token')).text(), /<svg/, 'a browser visit to anything else is the friendly page too');

    // no key, a wrong key, an empty key: refused, and nothing ever reaches Google
    for (const key of [undefined, '', 'wrong-key', 'good-key', 'x'.repeat(500)]) {
      for (const [method, p, body] of [['GET', '/config'], ['POST', '/token', good], ['POST', '/refresh', { refresh_token: 'RT' }], ['GET', '/youtube/config']]) {
        const r = await call(method, p, body, { key });
        assert.equal(r.status, 403, `${method} ${p} with key ${JSON.stringify(key)}`);
        const text = await r.text();
        assert.ok(!text.includes('worker-client-id') && !text.includes('worker-only-secret'), 'a refused request learns nothing');
      }
    }
    assert.equal(upstream.length, 0, 'nothing was passed on to Google');
    assert.equal((await call('GET', '/config', undefined, { env: { ...ENV, YOUTUBE_ACCESS_KEYS: '' }, key: KEY })).status, 500, 'no keys configured means nobody gets in');
    assert.equal((await call('GET', '/config', undefined, { env: {}, key: KEY })).status, 500, 'an unconfigured Worker says so instead of guessing');

    // with a valid key (any of several)
    for (const key of [KEY, 'second-key', 'third-key']) {
      const cfg = await (await call('GET', '/config', undefined, { key })).text();
      assert.ok(cfg.includes('worker-client-id') && !cfg.includes('worker-only-secret'), '/config gives the public Client ID, never the secret');
    }
    assert.equal((await call('GET', '/youtube/config', undefined, { key: KEY })).status, 200, 'works under the /youtube path too');
    assert.equal((await call('PUT', '/token', good, { key: KEY })).status, 405);
    assert.equal((await call('POST', '/nope', good, { key: KEY })).status, 404);
    assert.equal((await call('POST', '/token', 'not json', { key: KEY })).status, 400);
    for (const bad of ['https://evil.example/callback', 'http://127.0.0.1.evil.example:1234/callback', 'http://localhost:17424/callback', 'http://127.0.0.1:17424/other', 'http://127.0.0.1/callback']) {
      assert.equal((await call('POST', '/token', { ...good, redirect_uri: bad }, { key: KEY })).status, 400, bad);
    }
    assert.equal((await call('POST', '/token', { ...good, code: '' }, { key: KEY })).status, 400);
    assert.equal((await call('POST', '/token', { ...good, code: 'x'.repeat(3000) }, { key: KEY })).status, 400, 'oversized values are refused');
    assert.equal((await call('POST', '/refresh', {}, { key: KEY })).status, 400);
    assert.equal(upstream.length, 0);

    const ok = await call('POST', '/youtube/token', { ...good, redirect_uri: 'http://127.0.0.1:50123/callback' }, { key: 'second-key' });
    assert.equal(ok.status, 200, 'any free port on this PC works');
    assert.equal(upstream[0].url, 'https://oauth2.googleapis.com/token');
    assert.deepEqual(upstream[0].form, { client_id: 'worker-client-id', client_secret: 'worker-only-secret', grant_type: 'authorization_code', code: 'C', code_verifier: 'V', redirect_uri: 'http://127.0.0.1:50123/callback' });
    const okBody = await ok.json();
    assert.deepEqual(Object.keys(okBody).sort(), ['access_token', 'expires_in', 'refresh_token', 'scope', 'token_type'], 'only token fields come back');
    assert.ok(!JSON.stringify(okBody).includes('LEAK') && !JSON.stringify(okBody).includes('worker-only-secret'));

    assert.equal((await call('POST', '/refresh', { refresh_token: 'RT' }, { key: KEY })).status, 200);
    assert.deepEqual(upstream[1].form, { client_id: 'worker-client-id', client_secret: 'worker-only-secret', grant_type: 'refresh_token', refresh_token: 'RT' });

    answer = { status: 400, body: { error: 'invalid_grant', error_description: 'expired', secret: 'nope' } };
    const bad = await call('POST', '/token', good, { key: KEY });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'invalid_grant', error_description: 'expired' });
    answer = { status: 503, body: { error: 'x' } };
    assert.equal((await call('POST', '/token', good, { key: KEY })).status, 502);
    answer = { throws: true };
    assert.equal((await call('POST', '/token', good, { key: KEY })).status, 502);
  } finally { globalThis.fetch = realFetch; }
});

test('youtube worker: a key made with make-key.js works the moment it exists (nothing to list), can be revoked by id, and a forged one fails', NEEDS_WORKER_AND_KEY_TOOL, async () => {
  const worker = await loadWorker();
  const { makeKey } = require(KEY_TOOL);
  const secret = 'signing-secret-for-tests';
  const env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', YOUTUBE_KEY_SECRET: secret };
  const ask = (key, e = env) => worker.fetch(new Request('https://w.example/config', { headers: key === undefined ? {} : { 'X-Access-Key': key } }), e).then((r) => r.status);

  const a = makeKey(secret);
  const b = makeKey(secret);
  assert.notEqual(a.key, b.key);
  assert.match(a.key, /^vrmp-[0-9a-f]{10}-[0-9a-f]{16}$/, 'hex only, so no look-alike letters when typing it');
  assert.equal(await ask(a.key), 200, 'a brand-new key works with nothing added to the Worker but the one signing secret');
  assert.equal(await ask(b.key), 200);

  // forged or damaged
  assert.equal(await ask(`vrmp-${a.id}-${'0'.repeat(16)}`), 403, 'right id, made-up signature');
  assert.equal(await ask(makeKey('a-different-secret').key), 403, 'signed with somebody else\'s secret');
  assert.equal(await ask(a.key.replace(a.id, b.id)), 403, 'a signature moved onto another id');
  assert.equal(await ask(a.key.slice(0, -1)), 403, 'one character short');
  assert.equal(await ask(a.key.toUpperCase()), 403, 'wrong case');
  assert.equal(await ask(undefined), 403);

  // switching a key off by its id
  assert.equal(await ask(a.key, { ...env, YOUTUBE_REVOKED_KEYS: `zzzzzzzzzz, ${a.id}` }), 403, 'a revoked key stops working');
  assert.equal(await ask(b.key, { ...env, YOUTUBE_REVOKED_KEYS: a.id }), 200, 'and only that one');

  // signed keys mean nothing without the signing secret; listed keys still work beside them; and something must be configured
  assert.equal(await ask(a.key, { ...env, YOUTUBE_KEY_SECRET: '', YOUTUBE_ACCESS_KEYS: 'a-listed-key' }), 403);
  assert.equal(await ask('a-listed-key', { ...env, YOUTUBE_ACCESS_KEYS: 'x, a-listed-key' }), 200);
  assert.equal(await ask(a.key, { ...env, YOUTUBE_ACCESS_KEYS: 'x, a-listed-key' }), 200, 'signed and listed keys work together');
  assert.equal(await ask(a.key, { GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's' }), 500);
});

test('youtube built-in login: an access key signs in through the Worker with NO secret in the app; no key, or a wrong one, is explained', NEEDS_WORKER, async () => {
  const k = await fakeYouTube();
  const broker = await startBroker(k);
  let clock = Date.now();

  // no key: the built-in login is simply not there
  const noKey = runtimeFor(k, { settings: NO_OWN, builtIn: { broker: broker.url } });
  assert.equal(noKey.rt.status().usingBuiltIn, false);
  assert.equal(noKey.rt.status().status, 'off');
  await assert.rejects(noKey.rt.connect(), /Client ID and Client Secret.*access key/s);
  assert.equal(broker.seenByBroker.length, 0, 'the app did not even contact the Worker');
  assert.ok(!('hasBuiltIn' in noKey.rt.status()), 'the card is not told a built-in login exists');

  // a wrong key
  const wrong = runtimeFor(k, { settings: { ...NO_OWN, accessKey: 'nope' }, builtIn: { broker: broker.url } });
  await assert.rejects(wrong.rt.connect(), /access key was not accepted/);
  assert.equal(broker.seenByBroker.at(-1).key, 'nope', 'the key travels in a header');

  // the right key
  const { rt, secrets } = runtimeFor(k, { settings: { ...NO_OWN, accessKey: KEY }, builtIn: { broker: broker.url }, now: () => clock });
  assert.equal(rt.status().usingBuiltIn, true);
  assert.match(rt.status().note, /Built-in login is ON.*Client ID and Secret empty/, 'the card is told to say the built-in login is on');
  assert.equal(noKey.rt.status().note, '', 'and says nothing without a key');
  assert.equal(rt.status().status, 'needs-auth');
  const u = await signIn(rt.client);
  assert.equal(u.searchParams.get('client_id'), 'worker-client-id', 'the sign-in uses the Client ID the Worker reports');
  assert.equal(rt.status().status, 'connected');
  assert.equal(k.tokenCalls[0].client_secret, 'worker-only-secret', 'Google received the secret from the Worker');
  assert.ok(!broker.seenByBroker.some((r) => r.body.includes('worker-only-secret')), 'the app never sent or saw the secret');
  assert.ok(!JSON.stringify(rt.status()).includes('worker-only-secret') && !JSON.stringify(rt.status()).includes(KEY), 'neither the secret nor the key is part of the status');
  assert.ok(secrets.has('tokens'));
  assert.ok(!secrets.get('tokens').includes(KEY), 'the access key is not stored with the tokens');

  clock += 3600 * 1000; // expired: refreshed through the Worker too, with the key
  await rt.client.me();
  const refresh = k.tokenCalls.find((c) => c.grant_type === 'refresh_token');
  assert.deepEqual([refresh.client_id, refresh.client_secret], ['worker-client-id', 'worker-only-secret']);
  assert.ok(broker.seenByBroker.filter((r) => r.path === '/refresh').every((r) => r.key === KEY));

  // the same saved sign-in is reused with the key, but is not there for a different Worker
  const same = runtimeFor(k, { settings: { ...NO_OWN, accessKey: KEY }, builtIn: { broker: broker.url }, secrets });
  assert.equal(same.rt.status().status, 'connected');
  const other = runtimeFor(k, { settings: { ...NO_OWN, accessKey: KEY }, builtIn: { broker: 'http://127.0.0.1:1' }, secrets });
  assert.equal(other.rt.status().status, 'needs-auth');

  // the key is turned off at the Worker: the next refresh says so plainly and asks to sign in again
  broker.env.YOUTUBE_ACCESS_KEYS = 'someone-elses-key';
  clock += 3600 * 1000;
  await assert.rejects(rt.client.me(), /access key was not accepted/);
  assert.equal(rt.status().status, 'needs-auth');
  assert.equal(secrets.has('tokens'), false);
  broker.close();
  k.close();
});

test('youtube built-in login: a Worker that is down is explained, and your own Client ID and Secret win over an access key', NEEDS_WORKER, async () => {
  const k = await fakeYouTube();
  const dead = runtimeFor(k, { settings: { ...NO_OWN, accessKey: KEY }, builtIn: { broker: 'http://127.0.0.1:1' } });
  await assert.rejects(dead.rt.connect(), /Could not reach the YouTube sign-in service/);

  const broker = await startBroker(k);
  const own = runtimeFor(k, { settings: { clientId: 'my-id', clientSecret: 'my-secret', accessKey: KEY }, builtIn: { broker: broker.url } });
  assert.equal(own.rt.status().usingBuiltIn, false);
  const u = await signIn(own.rt.client);
  assert.equal(u.searchParams.get('client_id'), 'my-id');
  assert.deepEqual([k.tokenCalls.at(-1).client_id, k.tokenCalls.at(-1).client_secret], ['my-id', 'my-secret']);
  assert.equal(broker.seenByBroker.length, 0, 'the Worker was not used at all');

  // a secret written into the bundled file is never picked up: only an address is
  const fileSrc = fs.readFileSync(nodePath.join(__dirname, '..', 'plugins', 'youtube', 'client.js'), 'utf8');
  assert.ok(!/clientSecret\s*:\s*String\(j\./.test(fileSrc), 'client.js does not read a Client Secret from youtube-app.json');
  broker.close();
  k.close();
});
