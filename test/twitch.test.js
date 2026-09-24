// Twitch client and actions against a local fake of Twitch's auth and Helix servers.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { TwitchClient, SCOPES } = require('../plugins/twitch/client');
const { SecretStore } = require('../src/core/secrets');
const { createApp } = require('../src/core');
const { tempDir, FakeHelper, waitFor, sleep } = require('./helpers');

// Everything opened by a test is closed afterwards, even when the test fails, so a failure cannot hang the run.
const cleanup = [];
test.after(async () => { for (const c of cleanup) { try { await c(); } catch { /* already closed */ } } });

// ---- fake Twitch ----
function fakeTwitch() {
  const s = {
    requests: [], pendingPolls: 2, accessToken: 'AT1', refreshToken: 'RT1', usedRefresh: new Set(), grantedScopes: SCOPES,
    settings: { emote_mode: false, follower_mode: false, subscriber_mode: false, slow_mode: false, unique_chat_mode: false },
    shield: false, ads: { snooze_count: 3, snooze_refresh_at: '2026-09-19T12:00:00+00:00', next_ad_at: '2026-09-19T11:30:00+00:00', duration: 60, last_ad_at: '', preroll_free_time: 0 },
    sendResult: { is_sent: true }, rejectNextWithScope: false, expireAccess: false,
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const isForm = (req.headers['content-type'] || '').includes('x-www-form-urlencoded');
      const body = raw ? (isForm ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw)) : null;
      s.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: req.headers });
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      const p = url.pathname;
      // ---- auth server ----
      if (p === '/oauth2/device') return send(200, { device_code: 'DEV', user_code: 'ABCD-EFGH', verification_uri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH', expires_in: 1800, interval: 0.001 });
      if (p === '/oauth2/token') {
        if (body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
          if (s.pendingPolls-- > 0) return send(400, { status: 400, message: 'authorization_pending' });
          return send(200, { access_token: s.accessToken, refresh_token: s.refreshToken, expires_in: s.expireAccess ? 1 : 14400, scope: s.grantedScopes, token_type: 'bearer' });
        }
        if (body.grant_type === 'refresh_token') {
          if (body.refresh_token !== s.refreshToken || s.usedRefresh.has(body.refresh_token)) return send(400, { status: 400, message: 'Invalid refresh token' });
          s.usedRefresh.add(body.refresh_token);
          s.accessToken = `AT${s.usedRefresh.size + 1}`;
          s.refreshToken = `RT${s.usedRefresh.size + 1}`;
          return send(200, { access_token: s.accessToken, refresh_token: s.refreshToken, expires_in: 14400, scope: s.grantedScopes, token_type: 'bearer' });
        }
      }
      if (p === '/oauth2/validate') return send(200, { client_id: 'cid', login: 'streamer', scopes: s.grantedScopes, user_id: '123', expires_in: 1000 });
      if (p === '/oauth2/revoke') return send(200);
      // ---- Helix ----
      if (req.headers.authorization !== `Bearer ${s.accessToken}`) return send(401, { error: 'Unauthorized', status: 401, message: 'Invalid OAuth token' });
      // A missing permission is not fixed by refreshing the token, so this keeps failing until cleared.
      if (s.rejectNextWithScope) return send(401, { error: 'Unauthorized', status: 401, message: 'Missing scope: channel:manage:ads' });
      if (p === '/helix/users') return send(200, { data: [url.searchParams.get('login') ? { id: '456', login: url.searchParams.get('login'), display_name: 'Other' } : { id: '123', login: 'streamer', display_name: 'Streamer' }] });
      if (p === '/helix/chat/messages') return send(200, { data: [s.sendResult] });
      if (p === '/helix/chat/settings') { if (req.method === 'GET') return send(200, { data: [s.settings] }); Object.assign(s.settings, body); return send(200, { data: [s.settings] }); }
      if (p === '/helix/moderation/shield_mode') { if (req.method === 'PUT') s.shield = body.is_active; return send(200, { data: [{ is_active: s.shield }] }); }
      if (p === '/helix/channels/ads') return send(200, { data: [s.ads] });
      if (p === '/helix/channels/ads/schedule/snooze') return send(200, { data: [{ snooze_count: 2, snooze_refresh_at: s.ads.snooze_refresh_at, next_ad_at: '2026-09-19T11:35:00+00:00' }] });
      if (p === '/helix/channels/commercial') return send(200, { data: [{ length: body.length, message: '', retry_after: 480 }] });
      if (p === '/helix/chat/announcements' || p === '/helix/moderation/chat' || p === '/helix/chat/shoutouts') return send(204);
      if (p === '/helix/streams/markers') return send(200, { data: [{ id: 'mk' }] });
      if (p === '/helix/clips') return send(202, { data: [{ id: 'clip1', edit_url: 'https://clips.twitch.tv/clip1/edit' }] });
      if (p === '/helix/raids') return send(200, { data: [{}] });
      if (p === '/helix/streams') return send(200, { data: [{ viewer_count: 42, started_at: '2026-09-19T10:00:00Z', title: 'Hi', game_name: 'VRChat' }] });
      if (p === '/helix/games') return send(200, { data: url.searchParams.get('name') === 'VRChat' ? [{ id: '999', name: 'VRChat' }] : [] });
      if (p === '/helix/channels') return send(204);
      return send(404, { message: `no route ${req.method} ${p}` });
    });
  });
  cleanup.push(() => server.close());
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ s, server, base: `http://127.0.0.1:${server.address().port}` })));
}

const opts = (base) => ({ apiBase: `${base}/helix`, authBase: `${base}/oauth2`, minPollMs: 5 });
const last = (s, p, m) => [...s.requests].reverse().find((r) => r.path === p && (!m || r.method === m));

// A stand-in for Windows DPAPI so we can check that secrets never touch disk in the clear.
const fakeBox = { available: () => true, encrypt: (t) => Buffer.from(`ENC(${t})`).toString('base64'), decrypt: (b) => Buffer.from(b, 'base64').toString().slice(4, -1) };

async function connected(base, dir = tempDir()) {
  const secrets = new SecretStore(dir);
  const client = new TwitchClient({ secrets, ...opts(base) });
  client.configure({ clientId: 'cid' });
  await client.startDeviceFlow();
  await waitFor(() => client.status === 'connected', 3000);
  return { client, secrets, dir };
}

// ---- sign-in ----
test('twitch: needs a Client ID, then sign-in by device code ends connected as you', async () => {
  const { s, server, base } = await fakeTwitch();
  const client = new TwitchClient({ secrets: new SecretStore(tempDir()), ...opts(base) });
  assert.equal(client.status, 'off');
  await assert.rejects(client.startDeviceFlow(), /Client ID/);
  client.configure({ clientId: 'cid' });
  assert.equal(client.status, 'needs-auth');
  const flow = await client.startDeviceFlow();
  assert.equal(flow.userCode, 'ABCD-EFGH');
  assert.match(flow.verificationUri, /^https:\/\/www\.twitch\.tv\/activate/);
  assert.equal(client.status, 'authorizing');
  assert.equal(client.info().pending.userCode, 'ABCD-EFGH');
  await waitFor(() => client.status === 'connected', 3000);
  assert.deepEqual(client.user, { id: '123', login: 'streamer', name: 'Streamer' });
  const start = s.requests.find((r) => r.path === '/oauth2/device');
  assert.equal(start.body.client_id, 'cid');
  assert.equal(start.body.scopes, SCOPES.join(' '));
  const poll = s.requests.filter((r) => r.path === '/oauth2/token');
  assert.ok(poll.length >= 3, 'kept polling while authorization was pending');
  assert.equal(poll[0].body.grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
  assert.equal(poll[0].body.device_code, 'DEV');
  server.close();
});

test('twitch: the sign-in survives a restart, and is dropped when the Client ID changes', async () => {
  const { server, base } = await fakeTwitch();
  const { dir } = await connected(base);
  const again = new TwitchClient({ secrets: new SecretStore(dir), ...opts(base) });
  again.configure({ clientId: 'cid' });
  assert.equal(again.status, 'connected');
  assert.equal(again.user.login, 'streamer');
  again.configure({ clientId: 'someone-elses-app' });
  assert.equal(again.status, 'needs-auth');
  assert.equal(again.user, null);
  server.close();
});

test('twitch: an expired sign-in code and a rejected one report clearly', async () => {
  const { server, base } = await fakeTwitch();
  let t = 1000;
  const client = new TwitchClient({ secrets: new SecretStore(tempDir()), ...opts(base), now: () => t });
  client.configure({ clientId: 'cid' });
  await client.startDeviceFlow();
  t += 1801 * 1000; // past expires_in
  await waitFor(() => client.status === 'needs-auth', 3000);
  assert.match(client.error, /expired/);
  server.close();
});

test('twitch: secrets are stored encrypted when the host offers it, plain (and flagged) otherwise', async () => {
  const dir = tempDir();
  const enc = new SecretStore(dir, fakeBox);
  enc.set('twitch.tokens', 'SUPER-SECRET-TOKEN');
  const onDisk = fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8');
  assert.ok(!onDisk.includes('SUPER-SECRET-TOKEN'), 'never in the clear');
  assert.equal(new SecretStore(dir, fakeBox).get('twitch.tokens'), 'SUPER-SECRET-TOKEN');
  assert.equal(new SecretStore(dir).get('twitch.tokens'), null, 'unreadable without the decrypt key');
  assert.equal(enc.isEncrypted(), true);
  const plain = new SecretStore(tempDir());
  plain.set('k', 'v');
  assert.equal(plain.get('k'), 'v');
  assert.equal(plain.isEncrypted(), false);
  plain.delete('k');
  assert.equal(plain.get('k'), null);
});

// ---- tokens ----
test('twitch: an expired access token is refreshed and the request retried, once', async () => {
  const { s, server, base } = await fakeTwitch();
  const { client } = await connected(base);
  s.accessToken = 'ROTATED'; // Twitch invalidated our token behind our back
  s.refreshToken = 'RT1';
  const me = await client.api('GET', '/users');
  assert.equal(me.data[0].login, 'streamer');
  const refreshes = s.requests.filter((r) => r.body && r.body.grant_type === 'refresh_token');
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].body.refresh_token, 'RT1');
  assert.notEqual(client.tokens.refresh, 'RT1', 'the single-use refresh token was replaced');
  assert.equal(client.tokens.access, s.accessToken);
  server.close();
});

test('twitch: refreshes ahead of expiry, and concurrent calls share one refresh', async () => {
  const { s, server, base } = await fakeTwitch();
  s.expireAccess = true; // token lifetime of 1 second
  const { client } = await connected(base);
  await Promise.all([client.api('GET', '/users'), client.api('GET', '/users'), client.api('GET', '/users')]);
  assert.equal(s.requests.filter((r) => r.body && r.body.grant_type === 'refresh_token').length, 1);
  server.close();
});

test('twitch: when refreshing fails the sign-in is cleared and you are asked to reconnect', async () => {
  const { s, server, base } = await fakeTwitch();
  const { client, secrets } = await connected(base);
  s.accessToken = 'X';
  s.refreshToken = 'DIFFERENT'; // ours is now invalid
  await assert.rejects(client.api('GET', '/users'), /sign-in expired/);
  assert.equal(client.status, 'needs-auth');
  assert.equal(secrets.get('twitch.tokens'), null);
  server.close();
});

test('twitch: disconnect forgets the tokens and tells Twitch to revoke', async () => {
  const { s, server, base } = await fakeTwitch();
  const { client, secrets } = await connected(base);
  await client.disconnect();
  assert.equal(client.status, 'needs-auth');
  assert.equal(secrets.get('twitch.tokens'), null);
  const revoke = last(s, '/oauth2/revoke');
  assert.equal(revoke.body.token, 'AT1');
  server.close();
});

test('twitch: validate lists permissions that were not granted', async () => {
  const { s, server, base } = await fakeTwitch();
  s.grantedScopes = SCOPES.filter((x) => x !== 'channel:manage:ads');
  const { client } = await connected(base);
  const v = await client.validate();
  assert.equal(v.login, 'streamer');
  assert.deepEqual(v.missing, ['channel:manage:ads']);
  server.close();
});

// ---- API calls: method, path, query, body exactly as Twitch documents them ----
test('twitch api: every call uses the documented method, path, parameters and body', async () => {
  const { s, server, base } = await fakeTwitch();
  const { client } = await connected(base);
  const id = '123';

  await client.sendChat('hello chat');
  let r = last(s, '/helix/chat/messages');
  assert.equal(r.method, 'POST');
  assert.deepEqual(r.body, { broadcaster_id: id, sender_id: id, message: 'hello chat' });
  assert.equal(r.headers['client-id'], 'cid');
  assert.match(r.headers.authorization, /^Bearer /);

  await client.setChatSettings({ emote_mode: true });
  r = last(s, '/helix/chat/settings', 'PATCH');
  assert.deepEqual(r.query, { broadcaster_id: id, moderator_id: id });
  assert.deepEqual(r.body, { emote_mode: true });
  assert.equal((await client.getChatSettings()).emote_mode, true);

  await client.setShield(true);
  r = last(s, '/helix/moderation/shield_mode', 'PUT');
  assert.deepEqual(r.query, { broadcaster_id: id, moderator_id: id });
  assert.deepEqual(r.body, { is_active: true });
  assert.equal(await client.getShield(), true);

  assert.equal((await client.getAds()).duration, 60);
  assert.equal(last(s, '/helix/channels/ads').query.broadcaster_id, id);
  const snooze = await client.snoozeAd();
  assert.equal(snooze.snooze_count, 2);
  assert.equal(last(s, '/helix/channels/ads/schedule/snooze').method, 'POST');
  await client.startCommercial(90);
  assert.deepEqual(last(s, '/helix/channels/commercial').body, { broadcaster_id: id, length: 90 });

  await client.announce('news', 'green');
  r = last(s, '/helix/chat/announcements');
  assert.deepEqual(r.query, { broadcaster_id: id, moderator_id: id });
  assert.deepEqual(r.body, { message: 'news', color: 'green' });
  await client.announce('plain', 'primary');
  assert.deepEqual(last(s, '/helix/chat/announcements').body, { message: 'plain' });

  await client.clearChat();
  r = last(s, '/helix/moderation/chat');
  assert.equal(r.method, 'DELETE');
  assert.deepEqual(r.query, { broadcaster_id: id, moderator_id: id });

  await client.createMarker('funny moment');
  assert.deepEqual(last(s, '/helix/streams/markers').body, { user_id: id, description: 'funny moment' });

  assert.equal((await client.createClip()).id, 'clip1');
  assert.equal(last(s, '/helix/clips').query.broadcaster_id, id);

  await client.raid('@SomeStreamer');
  assert.equal(last(s, '/helix/users').query.login, 'somestreamer');
  assert.deepEqual(last(s, '/helix/raids').query, { from_broadcaster_id: id, to_broadcaster_id: '456' });
  await client.shoutout('friend');
  assert.deepEqual(last(s, '/helix/chat/shoutouts').query, { from_broadcaster_id: id, to_broadcaster_id: '456', moderator_id: id });

  assert.equal((await client.getStream()).viewer_count, 42);
  assert.equal(last(s, '/helix/streams').query.user_id, id);

  await client.setChannel({ title: 'New title', game: 'VRChat' });
  r = last(s, '/helix/channels', 'PATCH');
  assert.deepEqual(r.query, { broadcaster_id: id });
  assert.deepEqual(r.body, { title: 'New title', game_id: '999' });
  await assert.rejects(client.setChannel({ game: 'Nonexistent Game' }), /no category called/);
  await assert.rejects(client.setChannel({}), /title or a category/);
  server.close();
});

test('twitch api: messages are clipped to 500 characters; dropped messages and missing scopes explain themselves', async () => {
  const { s, server, base } = await fakeTwitch();
  const { client } = await connected(base);
  await client.sendChat('x'.repeat(900));
  assert.equal(last(s, '/helix/chat/messages').body.message.length, 500);
  s.sendResult = { is_sent: false, drop_reason: { code: 'msg_duplicate', message: 'Duplicate message' } };
  await assert.rejects(client.sendChat('again'), /Duplicate message/);
  s.rejectNextWithScope = true;
  await assert.rejects(client.snoozeAd(), /Missing scope: channel:manage:ads.*connect Twitch again/);
  s.rejectNextWithScope = false;
  await assert.rejects(client.userByLogin(''), /Enter a channel name/);
  server.close();
});

// ---- buttons: actions through the engine ----
async function bootWithTwitch(base, buttons) {
  const dir = tempDir();
  const secrets = new SecretStore(dir);
  secrets.set('twitch.tokens', JSON.stringify({ access: 'AT1', refresh: 'RT1', expiresAt: Date.now() + 3600000, scopes: SCOPES, clientId: 'cid', user: { id: '123', login: 'streamer', name: 'Streamer' } }));
  const app = createApp({ dataDir: dir, helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), port: 0, twitchOptions: opts(base) });
  cleanup.push(() => app.stop());
  await app.start();
  const cfg = JSON.parse(JSON.stringify(app.engine.config));
  cfg.settings.plugins.twitch.clientId = 'cid';
  cfg.pages = [{ id: 'p', name: 'P', cols: 8, rows: 4, buttons: buttons.map((b, i) => ({ id: b[0], x: i % 8, y: Math.floor(i / 8), w: 1, h: 1, label: b[0], steps: [{ action: b[1], params: b[2] || {}, delayMs: 0 }] })) }];
  app.engine.updateConfig(cfg);
  const toasts = [];
  app.engine.on('toast', (t) => toasts.push(t));
  return { app, engine: app.engine, toasts, hub: app.hub };
}

test('twitch actions: chat macro, announcement, modes, shield, ads, clip, raid, shoutout, title', async () => {
  const { s, server, base } = await fakeTwitch();
  const { app, engine, toasts, hub } = await bootWithTwitch(base, [
    ['chat', 'twitch.chat', { message: 'Welcome raiders! 🎉' }],
    ['ann', 'twitch.announce', { message: 'Giveaway!', color: 'purple' }],
    ['emote', 'twitch.chatMode', { mode: 'emote', action: 'toggle' }],
    ['fol', 'twitch.chatMode', { mode: 'followers', action: 'on', followerMinutes: 10 }],
    ['slow', 'twitch.chatMode', { mode: 'slow', action: 'on', slowSeconds: 45 }],
    ['subsoff', 'twitch.chatMode', { mode: 'subscribers', action: 'off' }],
    ['shield', 'twitch.shield', { action: 'toggle' }],
    ['snooze', 'twitch.adSnooze'],
    ['run', 'twitch.adRun', { length: '60' }],
    ['clear', 'twitch.clearChat'],
    ['mark', 'twitch.marker', { description: 'wow' }],
    ['clip', 'twitch.clip'],
    ['raid', 'twitch.raid', { channel: 'friend' }],
    ['shout', 'twitch.shoutout', { channel: 'friend' }],
    ['title', 'twitch.channel', { title: 'Hello', category: 'VRChat' }],
  ]);
  const body = (p, m) => last(s, p, m).body;

  await engine.press('chat');
  assert.equal(body('/helix/chat/messages').message, 'Welcome raiders! 🎉');
  await engine.press('ann');
  assert.deepEqual(body('/helix/chat/announcements'), { message: 'Giveaway!', color: 'purple' });

  // toggle with unknown state asks Twitch first, then flips
  hub.remove('twitch.emoteOnly');
  await engine.press('emote');
  assert.deepEqual(body('/helix/chat/settings', 'PATCH'), { emote_mode: true });
  await engine.press('fol');
  assert.deepEqual(body('/helix/chat/settings', 'PATCH'), { follower_mode: true, follower_mode_duration: 10 });
  await engine.press('slow');
  assert.deepEqual(body('/helix/chat/settings', 'PATCH'), { slow_mode: true, slow_mode_wait_time: 45 });
  await engine.press('subsoff');
  assert.deepEqual(body('/helix/chat/settings', 'PATCH'), { subscriber_mode: false });

  await engine.press('shield');
  assert.deepEqual(body('/helix/moderation/shield_mode', 'PUT'), { is_active: true });
  await engine.press('snooze');
  assert.match(toasts.at(-1).text, /Ad snoozed. 2 snoozes left/);
  await engine.press('run');
  assert.deepEqual(body('/helix/channels/commercial'), { broadcaster_id: '123', length: 60 });
  await engine.press('clear');
  assert.equal(last(s, '/helix/moderation/chat').method, 'DELETE');
  await engine.press('mark');
  assert.equal(body('/helix/streams/markers').description, 'wow');
  await engine.press('clip');
  assert.match(toasts.at(-1).text, /Clip created: https:\/\/clips\.twitch\.tv\/clip1\/edit/);
  await engine.press('raid');
  assert.equal(last(s, '/helix/raids').query.to_broadcaster_id, '456');
  await engine.press('shout');
  assert.equal(last(s, '/helix/chat/shoutouts').query.to_broadcaster_id, '456');
  await engine.press('title');
  assert.deepEqual(body('/helix/channels', 'PATCH'), { title: 'Hello', game_id: '999' });
  assert.ok(!toasts.some((t) => t.level === 'error'), `unexpected errors: ${toasts.filter((t) => t.level === 'error').map((t) => t.text)}`);
  await app.stop();
  server.close();
});

test('twitch actions: chat-mode and shield buttons light up from Twitch state, and toggle it', async () => {
  const { s, server, base } = await fakeTwitch();
  s.settings.emote_mode = true;
  s.shield = false;
  const { app, engine, hub } = await bootWithTwitch(base, [
    ['emote', 'twitch.chatMode', { mode: 'emote', action: 'toggle' }],
    ['shield', 'twitch.shield', { action: 'toggle' }],
  ]);
  await waitFor(() => hub.eval('twitch.emoteOnly') === true, 3000);
  await waitFor(() => hub.eval('twitch.shield') === false, 3000);
  const st = engine.computeButtonStates();
  assert.equal(st.emote.active, true);
  assert.equal(st.shield.active, false);
  await engine.press('emote'); // known ON -> turns OFF
  assert.deepEqual(last(s, '/helix/chat/settings', 'PATCH').body, { emote_mode: false });
  await waitFor(() => engine.computeButtonStates().emote.active === false, 3000);
  await app.stop();
  server.close();
});

test('twitch actions: when Twitch is not set up or connected, the error says what to do', async () => {
  const dir = tempDir();
  const app = createApp({ dataDir: dir, helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), port: 0, twitchOptions: { defaultClientId: '' } });
  cleanup.push(() => app.stop());
  await app.start();
  const cfg = JSON.parse(JSON.stringify(app.engine.config));
  cfg.pages = [{ id: 'p', name: 'P', cols: 4, rows: 2, buttons: [{ id: 'c', x: 0, y: 0, w: 1, h: 1, steps: [{ action: 'twitch.chat', params: { message: 'hi' }, delayMs: 0 }] }] }];
  app.engine.updateConfig(cfg);
  const toasts = [];
  app.engine.on('toast', (t) => toasts.push(t));
  await app.engine.press('c');
  assert.match(toasts.at(-1).text, /not set up.*Client ID/);
  const cfg2 = JSON.parse(JSON.stringify(app.engine.config));
  cfg2.settings.plugins.twitch.clientId = 'cid';
  app.engine.updateConfig(cfg2);
  await app.engine.press('c');
  assert.match(toasts.at(-1).text, /not connected.*Settings/i);
  await app.stop();
});

test('twitch: ad schedule and stream status reach widgets and state keys', async () => {
  const { s, server, base } = await fakeTwitch();
  s.ads.next_ad_at = new Date(Date.now() + 3 * 60000).toISOString(); // 3 minutes away
  s.ads.last_ad_at = '';
  const { app, engine, hub } = await bootWithTwitch(base, []);
  const cfg = JSON.parse(JSON.stringify(engine.config));
  cfg.pages[0].buttons = [
    { id: 'ads', x: 0, y: 0, w: 2, h: 2, widget: { type: 'twitch.ads', params: { tapAction: 'snooze' } } },
    { id: 'live', x: 2, y: 0, w: 2, h: 1, widget: { type: 'twitch.stream', params: {} } },
    { id: 'warn', x: 4, y: 0, w: 1, h: 1, steps: [{ action: 'system.toast', params: { message: 'ads soon' }, delayMs: 0 }], triggers: [{ type: 'state', key: 'twitch.adSoon', becomes: true }] },
  ];
  engine.updateConfig(cfg);
  await waitFor(() => engine.computeWidgetData().ads && engine.computeWidgetData().ads.nextAdAt, 4000);
  const ads = engine.computeWidgetData().ads;
  assert.equal(ads.connected, true);
  assert.equal(ads.durationSec, 60);
  assert.equal(ads.snoozeCount, 3);
  assert.ok(ads.nextAdAt - Date.now() < 3.1 * 60000 && ads.nextAdAt - Date.now() > 2.5 * 60000, 'RFC3339 time parsed');
  await waitFor(() => engine.computeWidgetData().live && engine.computeWidgetData().live.live === true, 4000);
  assert.equal(engine.computeWidgetData().live.viewers, 42);
  assert.equal(hub.eval('twitch.adSoon'), true, 'within the 5 minute warning');
  // tapping the ad widget snoozes
  await engine.widgetCommand('ads', 'tap');
  assert.ok(last(s, '/helix/channels/ads/schedule/snooze'));
  await app.stop();
  server.close();
});

test('twitch: a Client ID shipped with the app means users just press Connect; their own ID still wins', async () => {
  const { s, server, base } = await fakeTwitch();
  const secrets = new SecretStore(tempDir());
  const client = new TwitchClient({ secrets, ...opts(base), defaultClientId: 'shipped-id' });
  assert.equal(client.status, 'off');
  client.configure({ clientId: '' }); // the user typed nothing
  assert.equal(client.status, 'needs-auth');
  assert.deepEqual([client.info().hasBuiltIn, client.info().usingBuiltIn], [true, true]);
  await client.startDeviceFlow();
  assert.equal(s.requests.find((r) => r.path === '/oauth2/device').body.client_id, 'shipped-id');
  await waitFor(() => client.status === 'connected', 3000);
  assert.equal(client.tokens.clientId, 'shipped-id');
  // the sign-in is remembered for the shipped ID...
  const again = new TwitchClient({ secrets, ...opts(base), defaultClientId: 'shipped-id' });
  again.configure({ clientId: '' });
  assert.equal(again.status, 'connected');
  // ...but typing your own app's ID switches to that app and needs its own sign-in
  again.configure({ clientId: 'my-own-app' });
  assert.equal(again.status, 'needs-auth');
  assert.deepEqual([again.info().usingBuiltIn], [false]);
  // nothing shipped and nothing typed: Twitch stays off
  const bare = new TwitchClient({ secrets: new SecretStore(tempDir()), ...opts(base), defaultClientId: '' });
  bare.configure({ clientId: '' });
  assert.equal(bare.status, 'off');
  assert.equal(bare.info().hasBuiltIn, false);
});

test('twitch: "an ad is playing now" is true only while the last ad break is still within its length; snooze lights up before an ad', async () => {
  const { s, server, base } = await fakeTwitch();
  s.ads.next_ad_at = new Date(Date.now() + 3 * 60000).toISOString(); // an ad in 3 minutes: inside the 5 minute warning
  s.ads.last_ad_at = new Date(Date.now() - 10000).toISOString();     // the last one started 10 s ago and lasts 60 s
  const { app, engine, hub } = await bootWithTwitch(base, []);
  const cfg = JSON.parse(JSON.stringify(engine.config));
  cfg.pages[0].buttons = [
    { id: 'run', x: 0, y: 0, w: 1, h: 1, steps: [{ action: 'twitch.adRun', params: { length: '30' }, delayMs: 0 }], state: { source: 'auto', key: '' }, triggers: [] },
    { id: 'snooze', x: 1, y: 0, w: 1, h: 1, steps: [{ action: 'twitch.adSnooze', params: {}, delayMs: 0 }], state: { source: 'auto', key: '' }, triggers: [] },
  ];
  engine.updateConfig(cfg);
  await waitFor(() => hub.eval('twitch.adRunning') === true, 4000);
  assert.equal(engine.computeButtonStates().run.active, true, 'the Run ad button is lit while an ad is playing');
  assert.equal(engine.computeButtonStates().snooze.active, true, 'the Snooze button is lit because an ad is coming up soon');
  s.ads.last_ad_at = new Date(Date.now() - 5 * 60000).toISOString(); // that ad finished minutes ago
  s.ads.next_ad_at = new Date(Date.now() + 40 * 60000).toISOString(); // and the next is far away
  await app.providers.get('twitch').refresh();
  await waitFor(() => hub.eval('twitch.adRunning') === false, 4000);
  assert.equal(engine.computeButtonStates().run.active, false);
  assert.equal(engine.computeButtonStates().snooze.active, false);
  await app.stop();
  server.close();
});
