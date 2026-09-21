// Button pictures (PNG / JPEG / GIF / WebP, per state) and button effects (animations): what is accepted, how it is stored and
// served, and how the settings are cleaned up.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { createApp } = require('../src/core');
const { ImageStore, sniff, MAX_BYTES } = require('../src/core/images');
const { normalizeConfig, defaultConfig } = require('../src/core/schema');
const Effects = require('../src/shared/effects');
const { tempDir, FakeHelper, waitFor } = require('./helpers');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of a png')]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jfif data')]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.from('gif data')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 '), Buffer.from('webp data')]);

// ---- effects ----
test('effects: the list is complete, every effect has a name and the ids are unique', () => {
  const ids = Effects.EFFECTS.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('none'));
  for (const id of ['pulse', 'breathe', 'flash', 'glow', 'ripple', 'heartbeat', 'shake', 'bounce', 'hazard', 'rainbow']) assert.ok(ids.includes(id), id);
  assert.ok(Effects.EFFECTS.every((e) => e.label));
  assert.equal(Effects.isEffect('flash'), true);
  assert.equal(Effects.isEffect('<script>'), false);
  assert.equal(Effects.isSpeed('fast'), true);
  assert.equal(Effects.isSpeed('warp'), false);
  // every effect has its look in the stylesheet, so a menu entry can never do nothing
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'styles.css'), 'utf8');
  for (const id of ids.filter((i) => i !== 'none')) assert.match(css, new RegExp(`\\.fx-${id}\\b`), `.fx-${id} is styled`);
});

// ---- settings ----
test('settings: a button has no picture and no animation by default, and bad values are dropped', () => {
  const { config } = normalizeConfig({ pages: [{ id: 'p', name: 'P', cols: 4, rows: 2, buttons: [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B', image: 'img-0123456789abcdef01234567.gif', imageOn: 'img-0123456789abcdef01234567.png', imageFit: 'contain', anim: 'flash', animOn: 'pulse', animSpeed: 'fast' },
    { id: 'c', label: 'C', image: '../../secret.png', imageOn: 'http://evil/x.png', imageFit: 'stretch', anim: 'explode', animOn: 7, animSpeed: 'warp' },
  ] }] });
  const [a, b, c] = config.pages[0].buttons;
  assert.deepEqual([a.image, a.imageOn, a.imageFit, a.anim, a.animOn, a.animSpeed], ['', '', 'cover', 'none', 'none', 'normal']);
  assert.deepEqual([b.image, b.imageOn, b.imageFit, b.anim, b.animOn, b.animSpeed], ['img-0123456789abcdef01234567.gif', 'img-0123456789abcdef01234567.png', 'contain', 'flash', 'pulse', 'fast']);
  assert.deepEqual([c.image, c.imageOn, c.imageFit, c.anim, c.animOn, c.animSpeed], ['', '', 'cover', 'none', 'none', 'normal'], 'a path, a web address or an unknown value never gets through');
  assert.equal(defaultConfig().settings.animations, true);
  assert.equal(normalizeConfig({ settings: { animations: false } }).config.settings.animations, false);
  assert.equal(normalizeConfig({ settings: { animations: 'no' } }).config.settings.animations, true);
});

// ---- the picture store ----
test('pictures: the real type comes from the bytes, and only PNG, JPEG, GIF and WebP are kept', () => {
  assert.equal(sniff(PNG), 'png');
  assert.equal(sniff(JPG), 'jpg');
  assert.equal(sniff(GIF), 'gif');
  assert.equal(sniff(Buffer.concat([Buffer.from('GIF87a'), Buffer.from('x')])), 'gif');
  assert.equal(sniff(WEBP), 'webp');
  assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), '', 'SVG can carry scripts');
  assert.equal(sniff(Buffer.from('MZ\x90\x00 an exe')), '');
  assert.equal(sniff(Buffer.alloc(0)), '');
  const store = new ImageStore(tempDir());
  assert.throws(() => store.add(Buffer.from('<svg></svg>')), /Only PNG, JPEG, GIF and WebP/);
  assert.throws(() => store.add(Buffer.alloc(0)), /empty/);
  assert.throws(() => store.add(Buffer.concat([PNG, Buffer.alloc(MAX_BYTES)])), /too big/);
});

test('pictures: stored under a hash name, once, served with the right type, and no name can leave the folder', () => {
  const store = new ImageStore(tempDir());
  const name = store.add(GIF);
  assert.match(name, /^img-[0-9a-f]{24}\.gif$/);
  assert.equal(store.add(GIF), name, 'the same picture is stored once');
  assert.equal(store.add(PNG).endsWith('.png'), true);
  const got = store.read(name);
  assert.equal(got.type, 'image/gif');
  assert.ok(got.data.equals(GIF));
  for (const bad of ['../config.json', '..\\config.json', 'img-../x.png', 'config.json', '', null, undefined, 'img-0123456789abcdef01234567.svg', 'img-0123456789abcdef01234567.png/../../x']) {
    assert.equal(store.read(bad), null, String(bad));
  }
  assert.equal(store.read('img-0123456789abcdef01234567.png'), null, 'a name that is not stored');
});

test('pictures: pictures no button uses are cleaned up, but not new ones and not ones in use', () => {
  const dir = tempDir();
  const store = new ImageStore(dir);
  const used = store.add(PNG);
  const fresh = store.add(GIF);
  const old = store.add(JPG);
  const oldUsedOn = store.add(WEBP);
  const day = 24 * 3600 * 1000;
  for (const n of [used, old, oldUsedOn]) { const t = new Date(Date.now() - 3 * day); fs.utimesSync(path.join(store.dir, n), t, t); }
  const config = { pages: [{ buttons: [{ image: used }, { image: '', imageOn: oldUsedOn }] }] };
  assert.equal(store.gc(config), 1, 'only the old, unused one goes');
  assert.ok(store.read(used) && store.read(fresh) && store.read(oldUsedOn));
  assert.equal(store.read(old), null);
  fs.writeFileSync(path.join(store.dir, 'notes.txt'), 'not ours');
  store.gc({ pages: [] }, 0, Date.now() + day);
  assert.ok(fs.existsSync(path.join(store.dir, 'notes.txt')), 'files that are not pictures are left alone');
});

// ---- over the wire ----
function getBinary(port, pathName, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function connect(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const client = { ws, rid: 1, waiters: new Map() };
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === 'res' && client.waiters.has(m.rid)) { client.waiters.get(m.rid)(m); client.waiters.delete(m.rid); }
    });
    ws.on('open', () => resolve(client));
    ws.on('error', reject);
  });
}
const ask = (c, t, payload = {}) => new Promise((resolve) => { const rid = c.rid++; c.waiters.set(rid, resolve); c.ws.send(JSON.stringify({ t, rid, ...payload })); });

test('pictures: uploading needs editing to be unlocked, returns a name, and the picture is served only with the secret token', async () => {
  const app = createApp({ dataDir: tempDir(), helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), port: 0, twitchOptions: { defaultClientId: '' }, pearOptions: { retryMs: 60000 } });
  const p = (await app.start()).port;
  const client = await connect(p, app.token);
  try {
    let r = await ask(client, 'image.add', { data: GIF.toString('base64') });
    assert.equal(r.ok, false);
    assert.match(r.error, /locked/i, 'locked editing refuses uploads');
    app.engine.setEditing(true);
    r = await ask(client, 'image.add', { data: GIF.toString('base64') });
    assert.equal(r.ok, true, r.error);
    const name = r.result;
    assert.match(name, /^img-[0-9a-f]{24}\.gif$/);
    r = await ask(client, 'image.add', { data: Buffer.from('<svg/>').toString('base64') });
    assert.equal(r.ok, false);
    assert.match(r.error, /Only PNG/);
    r = await ask(client, 'image.add', { data: 12345 });
    assert.equal(r.ok, false);

    const ok = await getBinary(p, `/user-images/${name}?token=${app.token}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['content-type'], 'image/gif');
    assert.equal(ok.headers['x-content-type-options'], 'nosniff');
    assert.ok(ok.body.equals(GIF), 'the bytes come back untouched');
    assert.equal((await getBinary(p, `/user-images/${name}`)).status, 404, 'no token, no picture');
    assert.equal((await getBinary(p, `/user-images/${name}?token=wrong`)).status, 404);
    assert.equal((await getBinary(p, `/user-images/..%2Fauth.json?token=${app.token}`)).status, 404, 'no way out of the folder');
    assert.equal((await getBinary(p, `/user-images/%E0%A4%A?token=${app.token}`)).status, 404, 'a broken address is just not found');
    assert.equal((await getBinary(p, `/user-images/${name}?token=${app.token}`, { Host: 'evil.example' })).status, 403, 'and the host check still applies');

    // a button can use it, and saving the layout keeps it
    const cfg = JSON.parse(JSON.stringify(app.engine.config));
    cfg.pages[0].buttons[0].image = name;
    cfg.pages[0].buttons[0].animOn = 'hazard';
    r = await ask(client, 'config.set', { config: cfg });
    assert.equal(r.ok, true, r.error);
    const saved = app.engine.config.pages[0].buttons[0];
    assert.equal(saved.image, name);
    assert.equal(saved.animOn, 'hazard');
    assert.ok(app.images.read(name), 'a picture in use stays');
    await waitFor(() => true);
  } finally {
    client.ws.close();
    await app.stop();
  }
});
