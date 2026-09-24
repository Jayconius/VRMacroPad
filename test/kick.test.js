// The Kick plugin (official API), run against a simulated Kick: its sign-in (PKCE + client secret), tokens, every button's
// request, the polled channel / ad state and the error messages.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { StateHub } = require('../src/core/state');
const { createApp } = require('../src/core');
const { FakeHelper, tempDir, waitFor } = require('./helpers');
const { KickClient, SCOPES } = require('../plugins/kick/client');
const { KickRuntime } = require('../plugins/kick/runtime');
const actions = require('../plugins/kick/actions');
const widgets = require('../plugins/kick/widgets');
const manifest = require('../plugins/kick/plugin');

const act = (id) => actions.find((a) => a.id === id);
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// A simulated Kick: id.kick.com (/oauth/token) and api.kick.com (/public/v1/...) on one local port.
async function fakeKick() {
  const seen = [];
  const k = { seen, tokenCalls: [], expire401: 0, refreshFails: false, users: { viewer: 99, mod2: 55 }, online: true, ads: { remaining_ad_breaks: 3, ads_blocked: false, opted_in: true, auto_ads_active: false } };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const url = new URL(req.url, 'http://x');
      const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
      if (url.pathname === '/oauth/token') {
        const form = Object.fromEntries(new URLSearchParams(raw));
        k.tokenCalls.push(form);
        if (form.grant_type === 'refresh_token' && k.refreshFails) return json(400, { error: 'invalid_grant', error_description: 'refresh token revoked' });
        if (form.grant_type === 'authorization_code' && form.code === 'BAD') return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: `access-${k.tokenCalls.length}`, refresh_token: `refresh-${k.tokenCalls.length}`, expires_in: 3600, token_type: 'Bearer', scope: SCOPES.join(' ') });
      }
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization });
      if (k.expire401 > 0) { k.expire401--; return json(401, { message: 'expired' }); }
      if (k.forceStatus) return json(k.forceStatus, { message: k.forceMessage || 'nope' });
      const p = `${req.method} ${url.pathname}`;
      if (p === 'GET /public/v1/users') return json(200, { data: [{ user_id: 7, name: 'Streamer' }] });
      if (p === 'GET /public/v1/channels') {
        const slug = url.searchParams.get('slug');
        if (slug) return k.users[slug] ? json(200, { data: [{ broadcaster_user_id: k.users[slug], slug }] }) : json(200, { data: [] });
        return json(200, { data: [{ broadcaster_user_id: 7, slug: 'streamer', stream_title: 'Playing VRChat', category: { id: 5, name: 'Just Chatting' }, stream: k.online ? { is_live: true, viewer_count: 12, start_time: new Date(Date.now() - 90 * 60000).toISOString() } : { is_live: false, viewer_count: 0 } }] });
      }
      if (p === 'PATCH /public/v1/channels') return json(204);
      if (p === 'GET /public/v1/categories') return json(200, { data: url.searchParams.get('q') === 'nothing' ? [] : [{ id: 8, name: 'Just Chatting Extras' }, { id: 5, name: 'Just Chatting' }] });
      if (p === 'POST /public/v1/chat') return json(200, { data: { is_sent: true, message_id: 'm1' }, message: 'OK' });
      if (p === 'POST /public/v1/ads/ad-break') return json(200, { data: { id: body.id, remaining_ad_breaks: 2 } });
      if (p === 'GET /public/v1/ads/ad-break-status') return json(200, { data: k.ads });
      if (p === 'POST /public/v1/moderation/bans' || p === 'DELETE /public/v1/moderation/bans') return json(200, { message: 'OK' });
      return json(404, { message: 'not found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  k.base = `http://127.0.0.1:${server.address().port}`;
  k.close = () => server.close();
  return k;
}

const memorySecrets = () => { const m = new Map(); return { get: (n) => m.get(n) || '', set: (n, v) => m.set(n, v), delete: (n) => m.delete(n), isEncrypted: () => true, has: (n) => m.has(n) }; };
const SETTINGS = { clientId: 'cid', clientSecret: 'sec' };

// Walks through the real sign-in: startAuth -> "the browser comes back" -> connected.
async function signIn(client) {
  const { url } = await client.startAuth();
  const u = new URL(url);
  const port = client.auth.port;
  const res = await fetch(`http://localhost:${port}/callback?code=CODE1&state=${u.searchParams.get('state')}`);
  await res.text();
  return u;
}

function runtimeFor(k, { settings = SETTINGS, secrets = memorySecrets(), now = () => Date.now(), builtIn = { id: '', secret: '' }, callbackPort = 0 } = {}) {
  const hub = new StateHub();
  const ctx = { hub, now, emitStatus() {}, settings: () => settings, secrets };
  const rt = new KickRuntime(ctx, { apiBase: k.base, authBase: k.base, callbackPort, now, defaultClientId: builtIn.id, defaultClientSecret: builtIn.secret, defaultBrokerUrl: builtIn.broker || '' });
  rt.configure();
  return { rt, hub, secrets, ctx };
}
const toastCtx = (rt) => { const toasts = []; return { toasts, ctx: { plugin: () => rt, toast: (t, l) => toasts.push([t, l]) } }; };

test('kick sign-in: PKCE, the client secret and the scopes go out exactly as Kick documents, and tokens are kept', async () => {
  const k = await fakeKick();
  const { rt, secrets } = runtimeFor(k);
  const { url } = await rt.connect();
  const u = new URL(url);
  assert.equal(`${u.origin}${u.pathname}`, `${k.base}/oauth/authorize`);
  assert.deepEqual([u.searchParams.get('client_id'), u.searchParams.get('response_type'), u.searchParams.get('code_challenge_method')], ['cid', 'code', 'S256']);
  assert.equal(u.searchParams.get('scope'), SCOPES.join(' '), 'scopes are space-separated');
  const redirect = u.searchParams.get('redirect_uri');
  assert.match(redirect, /^http:\/\/localhost:\d+\/callback$/, 'localhost, as Kick\'s documentation says');
  assert.equal(rt.status().status, 'authorizing');
  // the browser comes back with the wrong state: refused
  const bad = await fetch(`http://localhost:${rt.client.auth.port}/callback?code=x&state=wrong`);
  assert.equal(bad.status, 400);
  assert.equal(rt.status().status, 'authorizing');
  const good = await fetch(`http://localhost:${rt.client.auth.port}/callback?code=CODE1&state=${u.searchParams.get('state')}`);
  assert.match(await good.text(), /Kick connected/);
  const call = k.tokenCalls[0];
  assert.deepEqual([call.grant_type, call.code, call.client_id, call.client_secret, call.redirect_uri], ['authorization_code', 'CODE1', 'cid', 'sec', redirect]);
  assert.equal(call.code_verifier && b64url(crypto.createHash('sha256').update(call.code_verifier).digest()), u.searchParams.get('code_challenge'), 'the verifier matches the challenge');
  assert.equal(rt.status().status, 'connected');
  assert.deepEqual(rt.status().user, { id: 7, name: 'Streamer' });
  assert.ok(secrets.has('tokens'), 'the tokens are stored in the secret store');
  assert.ok(!JSON.stringify(rt.status()).includes('sec"'), 'the secret is never part of the status');
  // a fresh start reads them back without asking Kick anything
  const before = k.seen.length;
  const again = runtimeFor(k, { secrets });
  assert.equal(again.rt.status().status, 'connected');
  assert.equal(k.seen.length, before);
  await rt.disconnect();
  assert.equal(secrets.has('tokens'), false);
  assert.equal(rt.status().status, 'needs-auth');
  k.close();
});

test('kick sign-in: refusing on Kick, a bad code and missing settings each give a clear result', async () => {
  const k = await fakeKick();
  const empty = runtimeFor(k, { settings: { clientId: '', clientSecret: '' } });
  await assert.rejects(empty.rt.connect(), /Client ID and Client Secret/);
  assert.equal(empty.rt.status().status, 'off');
  const noSecret = runtimeFor(k, { settings: { clientId: 'cid', clientSecret: '' } });
  await assert.rejects(noSecret.rt.connect(), /Client Secret/);

  const { rt } = runtimeFor(k);
  let { url } = await rt.connect();
  await fetch(`http://localhost:${rt.client.auth.port}/callback?error=access_denied&state=${new URL(url).searchParams.get('state')}`);
  assert.equal(rt.status().status, 'needs-auth');
  assert.match(rt.status().error, /declined/);
  ({ url } = await rt.connect());
  const state = new URL(url).searchParams.get('state');
  await (await fetch(`http://localhost:${rt.client.auth.port}/callback?code=BAD&state=${state}`)).text();
  assert.equal(rt.status().status, 'needs-auth');
  assert.match(rt.status().error, /Kick refused the sign-in.*Client ID, Client Secret and Redirect URL/);
  k.close();
});

test('kick tokens: an expiring token is refreshed with the secret, a 401 is retried once, and a revoked sign-in asks to reconnect', async () => {
  const k = await fakeKick();
  let clock = Date.now();
  const { rt, secrets } = runtimeFor(k, { now: () => clock });
  await signIn(rt.client);
  const first = rt.client.tokens.access;
  clock += 3600 * 1000; // an hour later: expired
  await rt.client.me();
  const refresh = k.tokenCalls.find((c) => c.grant_type === 'refresh_token');
  assert.deepEqual([refresh.client_id, refresh.client_secret], ['cid', 'sec']);
  assert.ok(refresh.refresh_token.startsWith('refresh-'));
  assert.notEqual(rt.client.tokens.access, first);
  assert.equal(k.seen.at(-1).auth, `Bearer ${rt.client.tokens.access}`);

  k.expire401 = 1; // Kick says 401 once (revoked early): refresh and try again
  const before = k.tokenCalls.length;
  await rt.client.me();
  assert.equal(k.tokenCalls.length, before + 1);

  k.refreshFails = true;
  clock += 3600 * 1000;
  await assert.rejects(rt.client.me(), /Kick sign-in expired. Connect again/);
  assert.equal(rt.status().status, 'needs-auth');
  assert.equal(secrets.has('tokens'), false);
  k.close();
});

test('kick chat: sends as you (with your id) or as the bot, refuses empty and over-long messages, and explains when not connected', async () => {
  const k = await fakeKick();
  const { rt } = runtimeFor(k);
  const { ctx, toasts } = toastCtx(rt);
  await assert.rejects(act('kick.chat').run({ message: 'hi' }, ctx), /Kick is not connected yet/);
  await signIn(rt.client);
  await act('kick.chat').run({ message: '  Thanks for watching!  ' }, ctx);
  let call = k.seen.filter((s) => s.path === '/public/v1/chat').at(-1);
  assert.deepEqual(call.body, { content: 'Thanks for watching!', type: 'user', broadcaster_user_id: 7 });
  await act('kick.chat').run({ message: 'beep', as: 'bot' }, ctx);
  call = k.seen.filter((s) => s.path === '/public/v1/chat').at(-1);
  assert.deepEqual(call.body, { content: 'beep', type: 'bot' });
  assert.equal(toasts.at(-1)[0], 'Sent to Kick chat');
  await assert.rejects(act('kick.chat').run({ message: '   ' }, ctx), /Type a message/);
  await assert.rejects(act('kick.chat').run({ message: 'x'.repeat(501) }, ctx), /at most 500/);
  k.close();
});

test('kick title and category: finds the category by name, changes only what was given', async () => {
  const k = await fakeKick();
  const { rt } = runtimeFor(k);
  const { ctx, toasts } = toastCtx(rt);
  await signIn(rt.client);
  await act('kick.channel').run({ title: 'VR night', category: 'just chatting', tags: 'vr, chill , ' }, ctx);
  const patch = k.seen.find((s) => s.method === 'PATCH');
  assert.deepEqual(patch.body, { stream_title: 'VR night', category_id: 5, custom_tags: ['vr', 'chill'] }, 'the exact name match wins over the first result');
  assert.match(toasts.at(-1)[0], /Kick updated: title, category Just Chatting, tags/);
  await act('kick.channel').run({ title: 'Only the title' }, ctx);
  assert.deepEqual(k.seen.filter((s) => s.method === 'PATCH').at(-1).body, { stream_title: 'Only the title' });
  await assert.rejects(act('kick.channel').run({}, ctx), /Give a title, a category or tags/);
  await assert.rejects(act('kick.channel').run({ category: 'nothing' }, ctx), /no category called "nothing"/);
  k.close();
});

test('kick ad breaks: sends the length with an id, checks the range, and reads how many are left', async () => {
  const k = await fakeKick();
  const { rt } = runtimeFor(k);
  const { ctx, toasts } = toastCtx(rt);
  await signIn(rt.client);
  await act('kick.adRun').run({ length: '90' }, ctx);
  const call = k.seen.find((s) => s.path === '/public/v1/ads/ad-break');
  assert.equal(call.body.break_duration_seconds, 90);
  assert.match(call.body.id, /^[0-9a-f-]{36}$/);
  assert.match(toasts.at(-1)[0], /Ad break started. 2 left/);
  await assert.rejects(rt.client.adBreak(3), /7 to 300/);
  assert.deepEqual(await rt.client.adStatus(), { remaining: 3, blocked: false, optedIn: true, auto: false, limits: null });
  assert.equal(act('kick.adRun').defaults.confirm, 'hold', 'a new button asks for a hold');
  assert.deepEqual(act('kick.adRun').needs({}), { kick: true, kickAds: true });
  k.close();
});

test('kick moderation: a timeout finds the viewer by channel name and sends the documented body (no ban or unban buttons exist)', async () => {
  const k = await fakeKick();
  const { rt } = runtimeFor(k);
  const { ctx, toasts } = toastCtx(rt);
  await signIn(rt.client);
  await act('kick.timeout').run({ username: '@Viewer', minutes: 15, reason: 'spam' }, ctx);
  const call = k.seen.filter((s) => s.method === 'POST' && s.path === '/public/v1/moderation/bans').at(-1);
  assert.deepEqual(call.body, { broadcaster_user_id: 7, user_id: 99, reason: 'spam', duration: 15 });
  assert.equal(k.seen.find((s) => s.query.slug).query.slug, 'viewer', 'the @ and capitals are dropped');
  assert.match(toasts.at(-1)[0], /Timed out viewer for 15 min/);
  await assert.rejects(act('kick.timeout').run({ username: 'ghost' }, ctx), /no channel called "ghost"/);
  await assert.rejects(rt.client.ban('viewer', { minutes: 20000 }), /1 to 10080/);
  await assert.rejects(act('kick.timeout').run({ username: ' ' }, ctx), /Type a Kick channel name/);
  assert.ok(!act('kick.ban') && !act('kick.unban'), 'permanent bans and unbans are not offered');
  assert.equal(k.seen.filter((s) => s.method === 'DELETE').length, 0);
  k.close();
});

test('kick errors: a missing permission, a rate limit and a bad request are explained in plain words', async () => {
  const k = await fakeKick();
  const { rt } = runtimeFor(k);
  await signIn(rt.client);
  k.forceStatus = 403; k.forceMessage = 'insufficient scope';
  await assert.rejects(rt.client.adStatus(), /Kick refused \(403: insufficient scope\).*tick the scopes.*Connect again/);
  k.forceStatus = 429;
  await assert.rejects(rt.client.adStatus(), /slow down/);
  k.forceStatus = 422; k.forceMessage = 'stream_title is too long';
  await assert.rejects(rt.client.adStatus(), /Kick rejected that: stream_title is too long/);
  k.close();
});

test('kick live state: polling feeds the state keys and the two mini screens; offline and not-connected read clearly', async () => {
  const k = await fakeKick();
  const { rt, hub } = runtimeFor(k);
  const ctx = { plugin: () => rt, now: Date.now };
  const [stream, ads] = widgets;
  assert.match(stream.data(ctx).subtitle, /not connected/);
  await signIn(rt.client);
  rt.sync({ kick: true, kickAds: true });
  await waitFor(() => hub.eval('kick.live') === true && rt.snapshot().ads, 4000);
  assert.equal(hub.eval('kick.connected'), true);
  const d = stream.data(ctx);
  assert.deepEqual([d.value, d.subtitle, d.status], ['12 watching', 'Playing VRChat · Just Chatting', 'ok']);
  assert.match(d.items[0].value, /1 h 30 min/);
  assert.deepEqual(ads.data(ctx), { value: '3', subtitle: 'ad breaks left', status: 'ok' });
  k.ads = { remaining_ad_breaks: 0, ads_blocked: false, opted_in: true };
  await rt.pollAds();
  assert.equal(ads.data(ctx).status, 'warn');
  k.ads = { remaining_ad_breaks: 1, ads_blocked: true, opted_in: true };
  await rt.pollAds();
  assert.match(ads.data(ctx).subtitle, /not allowing ad breaks/);
  k.online = false;
  await rt.poll();
  assert.equal(hub.eval('kick.live'), false);
  assert.deepEqual([stream.data(ctx).value, stream.data(ctx).status], ['Offline', 'warn']);
  rt.sync({});
  assert.equal(hub.eval('kick.live'), undefined, 'nothing is polled or published once nothing uses Kick');
  assert.equal(rt.timer, null);
  assert.match(widgets[0].data({ plugin: () => null }).subtitle, /switched off/);
  k.close();
});

test('kick plugin: loads like any other, keeps the secret out of exports, and only opens Kick\'s own sign-in page', async () => {
  const app = createApp({ dataDir: tempDir(), helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), port: 0, twitchOptions: { defaultClientId: '' }, pearOptions: { retryMs: 60000 } });
  await app.start();
  assert.deepEqual(app.registry.errors.filter((e) => /kick/.test(e.dir)), []);
  const m = app.registry.get('kick');
  assert.ok(m);
  assert.equal(m.settingsFields.find((f) => f.key === 'clientSecret').type, 'password');
  assert.deepEqual(m.externalDomains, ['id.kick.com']);
  assert.deepEqual(m.matchState('kick.live'), { kick: true });
  assert.equal(m.matchState('twitch.live'), null);
  assert.ok(app.registry.get('kick').connections.length && m.clientMethods.includes('connect'));
  for (const w of ['kick.stream', 'kick.ads']) assert.ok(m.widgets.some((x) => x.id === w), w);
  for (const a of ['kick.chat', 'kick.channel', 'kick.adRun', 'kick.timeout']) assert.ok(m.actions.some((x) => x.id === a), a);
  assert.match(m.instructions(), /Client Secret/);
  assert.match(m.instructions(), /not here|not offer/);
  await app.stop();
});

test('kick built-in app: with the app\'s own Kick app inside, users just press Connect; their own app still wins', async () => {
  const k = await fakeKick();
  const builtIn = { id: 'shipped-id', secret: 'shipped-secret' };
  const { rt } = runtimeFor(k, { settings: { clientId: '', clientSecret: '' }, builtIn });
  assert.equal(rt.status().hasBuiltIn, true);
  assert.equal(rt.status().usingBuiltIn, true);
  assert.equal(rt.status().status, 'needs-auth', 'nothing typed, and it is ready to connect');
  const u = await signIn(rt.client);
  assert.equal(u.searchParams.get('client_id'), 'shipped-id');
  assert.deepEqual([k.tokenCalls[0].client_id, k.tokenCalls[0].client_secret], ['shipped-id', 'shipped-secret']);
  assert.equal(rt.status().status, 'connected');

  const own = runtimeFor(k, { settings: { clientId: 'my-id', clientSecret: 'my-secret' }, builtIn });
  assert.equal(own.rt.status().usingBuiltIn, false);
  await signIn(own.rt.client);
  assert.deepEqual([k.tokenCalls.at(-1).client_id, k.tokenCalls.at(-1).client_secret], ['my-id', 'my-secret']);

  const half = runtimeFor(k, { settings: { clientId: 'only-an-id', clientSecret: '' }, builtIn });
  await assert.rejects(half.rt.connect(), /Client ID and Client Secret/, 'half of your own app is not silently swapped for the built-in one');

  const none = runtimeFor(k, { settings: { clientId: '', clientSecret: '' } });
  assert.equal(none.rt.status().hasBuiltIn, false);
  assert.equal(none.rt.status().status, 'off');
  assert.match(manifest.instructions({ hasBuiltIn: true }), /^Press Connect/);
  assert.match(manifest.instructions({ hasBuiltIn: false }), /Create App/);
  assert.ok(manifest.settingsFields.filter((f) => f.builtInAware).length === 2, 'the two boxes tuck into "Advanced" when a built-in app exists');
  k.close();
});

test('kick plugin is self-contained: it reaches nothing in the app\'s core, and the core has no Kick settings', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'plugins', 'kick');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 5);
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const outside = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]).filter((p) => p.startsWith('.') && !p.startsWith('./'));
    assert.deepEqual(outside, [], `${f} only requires files inside its own folder (or Node's own modules)`);
  }
  const core = require('../src/core/app-config');
  assert.ok(!Object.keys(core).some((k) => /kick/i.test(k)), 'the core config knows nothing about Kick');
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', 'core', 'kick-app.example.json')), false);
  assert.ok(fs.existsSync(path.join(dir, 'kick-app.example.json')), 'the example file sits with the plugin');
});

// ---------- broker mode: the Cloudflare Worker holds the secret, the app never does ----------
const nodePath = require('path');
const HAS_WORKER = require('fs').existsSync(nodePath.join(__dirname, '..', 'plugins', 'kick', 'broker', 'worker.mjs'));
const NEEDS_WORKER = { skip: !HAS_WORKER && 'the Worker source is not in this checkout' };
const { pathToFileURL } = require('url');
const loadWorker = async () => (await import(pathToFileURL(nodePath.join(__dirname, '..', 'plugins', 'kick', 'broker', 'worker.mjs')).href)).default;
const ENV = { KICK_CLIENT_ID: 'worker-client-id', KICK_CLIENT_SECRET: 'worker-only-secret' };
// A free local port, so the Worker can be told the exact return address the app will use (in real use it is always 17423).
const freePort = () => new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// Runs the real worker.mjs behind a local port; its call to id.kick.com is redirected to the simulated Kick.
async function startBroker(k, env = ENV) {
  const worker = await loadWorker();
  const realFetch = globalThis.fetch;
  const seenByBroker = [];
  globalThis.fetch = (input, init) => realFetch(String(input && input.url ? input.url : input) === 'https://id.kick.com/oauth/token' ? `${k.base}/oauth/token` : input, init);
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    seenByBroker.push({ method: req.method, path: req.url, body: body.toString() });
    const r = await worker.fetch(new Request(`http://broker${req.url}`, { method: req.method, headers: { 'content-type': req.headers['content-type'] || '' }, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(await r.text());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seenByBroker, close: () => { globalThis.fetch = realFetch; server.close(); } };
}

test('kick worker: only the exact sign-in requests get through, for your redirect address, and the secret never comes back out', NEEDS_WORKER, async () => {
  const worker = await loadWorker();
  const realFetch = globalThis.fetch;
  const upstream = [];
  let answer = { status: 200, body: { access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'Bearer', scope: 'user:read', client_secret: 'LEAK', debug: 'x' } };
  globalThis.fetch = async (url, init) => { upstream.push({ url: String(url), form: Object.fromEntries(init.body) }); if (answer.throws) throw new Error('down'); return new Response(JSON.stringify(answer.body), { status: answer.status }); };
  try {
    const call = (method, p, body, env = ENV) => worker.fetch(new Request(`https://w.example${p}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) }), env);
    const good = { code: 'C', code_verifier: 'V', redirect_uri: 'http://localhost:17423/callback' };

    const home = await call('GET', '/');
    const homeHtml = await home.text();
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    assert.ok(/<svg/.test(homeHtml) && /VR Macro Pad/.test(homeHtml), 'a stranger sees the logo and a friendly page');
    assert.ok(!/kick|sign-in|token|client|secret/i.test(homeHtml.replace(/<style>.*?<\/style>/s, '').replace(/<svg.*?<\/svg>/s, '')), 'and nothing about what runs here');
    assert.match(home.headers.get('x-robots-tag'), /noindex/);
    assert.equal((await call('GET', '/kick/')).status, 200, 'the /kick path shows the same page');
    const cfg = await (await call('GET', '/config')).text();
    assert.ok(cfg.includes('worker-client-id') && !cfg.includes('worker-only-secret'), '/config gives the public Client ID, never the secret');
    assert.equal((await call('GET', '/token')).status, 404, 'a browser visit to anything else is the friendly page (404)');
    assert.equal((await call('GET', '/kick/config', undefined, {})).status, 500, 'the /kick path is the same Worker');
    assert.equal((await call('PUT', '/token', good)).status, 405);
    assert.equal((await call('POST', '/nope', good)).status, 404);
    assert.equal((await call('POST', '/token', 'not json')).status, 400);
    assert.equal((await call('POST', '/token', { ...good, redirect_uri: 'https://evil.example/cb' })).status, 400, 'only your own redirect address');
    assert.equal((await call('POST', '/token', { ...good, code: '' })).status, 400);
    assert.equal((await call('POST', '/token', { ...good, code: 'x'.repeat(3000) })).status, 400, 'oversized values are refused');
    assert.equal((await call('POST', '/refresh', {})).status, 400);
    assert.equal(upstream.length, 0, 'nothing bad was ever passed on to Kick');
    assert.equal((await call('GET', '/config', undefined, {})).status, 500, 'an unconfigured Worker says so instead of guessing');

    const ok = await call('POST', '/kick/token', good);
    assert.equal(ok.status, 200, 'works under the /kick path (a Cloudflare Route on a website)');
    assert.deepEqual(upstream[0].form, { client_id: 'worker-client-id', client_secret: 'worker-only-secret', grant_type: 'authorization_code', code: 'C', code_verifier: 'V', redirect_uri: 'http://localhost:17423/callback' });
    const okBody = await ok.json();
    assert.deepEqual(Object.keys(okBody).sort(), ['access_token', 'expires_in', 'refresh_token', 'scope', 'token_type'], 'only token fields come back (nothing Kick echoes, no secret)');
    assert.ok(!JSON.stringify(okBody).includes('worker-only-secret') && !JSON.stringify(okBody).includes('LEAK'));

    const ref = await call('POST', '/refresh', { refresh_token: 'RT' });
    assert.equal(ref.status, 200);
    assert.deepEqual(upstream[1].form, { client_id: 'worker-client-id', client_secret: 'worker-only-secret', grant_type: 'refresh_token', refresh_token: 'RT' });

    answer = { status: 400, body: { error: 'invalid_grant', error_description: 'expired', secret: 'nope' } };
    const bad = await call('POST', '/token', good);
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'invalid_grant', error_description: 'expired' });
    answer = { status: 503, body: { error: 'x' } };
    assert.equal((await call('POST', '/token', good)).status, 502);
    answer = { throws: true };
    assert.equal((await call('POST', '/token', good)).status, 502);
    assert.equal((await call('POST', '/token', good, { ...ENV, KICK_REDIRECT_URI: 'http://localhost:9/cb' })).status, 400, 'KICK_REDIRECT_URI changes the one address it accepts');
  } finally { globalThis.fetch = realFetch; }
});

test('kick broker mode: sign in, refresh and disconnect work with NO secret in the app; the Worker adds it', NEEDS_WORKER, async () => {
  const k = await fakeKick();
  const port = await freePort();
  const broker = await startBroker(k, { ...ENV, KICK_REDIRECT_URI: `http://localhost:${port}/callback` });
  let clock = Date.now();
  const { rt, secrets } = runtimeFor(k, { settings: { clientId: '', clientSecret: '' }, builtIn: { broker: broker.url }, now: () => clock, callbackPort: port });
  assert.equal(rt.status().hasBuiltIn, true);
  assert.equal(rt.status().usingBuiltIn, true);
  assert.equal(rt.status().status, 'needs-auth');
  const u = await signIn(rt.client);
  assert.equal(u.searchParams.get('client_id'), 'worker-client-id', 'the sign-in uses the Client ID the Worker reports');
  assert.equal(rt.status().status, 'connected');
  assert.deepEqual(k.tokenCalls[0].client_secret, 'worker-only-secret', 'Kick received the secret from the Worker');
  assert.ok(!broker.seenByBroker.some((r) => r.body.includes('worker-only-secret')), 'the app never sent or saw the secret');
  assert.ok(!JSON.stringify(rt.status()).includes('worker-only-secret'));
  assert.ok(secrets.has('tokens'), 'tokens are saved');

  clock += 3600 * 1000; // expired: refreshed through the Worker too
  await rt.client.me();
  const refresh = k.tokenCalls.find((c) => c.grant_type === 'refresh_token');
  assert.deepEqual([refresh.client_id, refresh.client_secret], ['worker-client-id', 'worker-only-secret']);
  assert.ok(broker.seenByBroker.some((r) => r.path === '/refresh'));

  // the same saved sign-in is reused by the same Worker, but not by a different one
  const same = runtimeFor(k, { settings: { clientId: '', clientSecret: '' }, builtIn: { broker: broker.url }, secrets, callbackPort: port });
  assert.equal(same.rt.status().status, 'connected');
  const other = runtimeFor(k, { settings: { clientId: '', clientSecret: '' }, builtIn: { broker: 'http://127.0.0.1:1' }, secrets });
  assert.equal(other.rt.status().status, 'needs-auth', 'a different Worker means signing in again');
  await rt.disconnect();
  assert.equal(rt.status().status, 'needs-auth');
  broker.close();
  k.close();
});

test('kick broker mode: a Worker that is down gives a clear message; your own Client ID and Secret still win over the Worker', NEEDS_WORKER, async () => {
  const k = await fakeKick();
  const dead = runtimeFor(k, { settings: { clientId: '', clientSecret: '' }, builtIn: { broker: 'http://127.0.0.1:1' } });
  await assert.rejects(dead.rt.connect(), /Could not reach the Kick sign-in service/);

  const broker = await startBroker(k);
  const own = runtimeFor(k, { settings: { clientId: 'my-id', clientSecret: 'my-secret' }, builtIn: { broker: broker.url } });
  assert.equal(own.rt.status().usingBuiltIn, false);
  const u = await signIn(own.rt.client);
  assert.equal(u.searchParams.get('client_id'), 'my-id');
  assert.deepEqual([k.tokenCalls.at(-1).client_id, k.tokenCalls.at(-1).client_secret], ['my-id', 'my-secret']);
  assert.equal(broker.seenByBroker.filter((r) => r.path === '/token').length, 0, 'the Worker was not used at all');

  const nothing = runtimeFor(k, { settings: { clientId: '', clientSecret: '' } });
  await assert.rejects(nothing.rt.connect(), /not set up in this build/);
  assert.equal(nothing.rt.status().status, 'off');
  broker.close();
  k.close();
});
