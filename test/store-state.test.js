const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Store, stripSecrets } = require('../src/core/store');
const { StateHub } = require('../src/core/state');
const { defaultConfig } = require('../src/core/schema');
const { defs } = require('../src/core/actions');
const { tempDir } = require('./helpers');

test('store: first load creates defaults; save then load round-trips', () => {
  const dir = tempDir();
  const store = new Store(dir);
  const first = store.load();
  assert.equal(first.fresh, true);
  first.config.pages[0].name = 'Renamed';
  store.save(first.config);
  const second = new Store(dir).load();
  assert.equal(second.fresh, false);
  assert.equal(second.config.pages[0].name, 'Renamed');
  assert.ok(!fs.existsSync(path.join(dir, 'config.json.tmp')), 'temp file cleaned up');
});

test('store: a corrupt config is set aside, not overwritten', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'config.json'), '{ this is not json');
  const store = new Store(dir);
  const res = store.load();
  assert.equal(res.fresh, true);
  assert.match(res.warnings[0], /could not be read/);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('config.json.corrupt-')));
});

test('store: backups are written, listed newest-first, capped, and restorable', () => {
  const dir = tempDir();
  const store = new Store(dir);
  const cfg = defaultConfig();
  store.save(cfg); // first save writes a backup
  assert.equal(store.listBackups().length, 1);
  store.save(cfg); // within the interval: no extra backup
  assert.equal(store.listBackups().length, 1);
  for (let i = 0; i < 25; i++) {
    store.lastBackup = 0;
    store.maybeBackup(JSON.stringify(cfg), true);
    fs.utimesSync(path.join(store.backupDir, store.listBackups()[0].name), new Date(Date.now() + i * 1000), new Date(Date.now() + i * 1000));
  }
  assert.ok(store.listBackups().length <= 20);
  const restored = store.readBackup(store.listBackups()[0].name);
  assert.equal(restored.config.pages[0].name, cfg.pages[0].name);
  assert.throws(() => store.readBackup('../../etc/passwd'), /Invalid backup name/);
});

test('store: runtime state persists separately from config', () => {
  const store = new Store(tempDir());
  assert.deepEqual(store.readRuntime(), {});
  store.writeRuntime({ activePage: 'p_1' });
  store.writeRuntime({ other: 1 });
  assert.deepEqual(store.readRuntime(), { activePage: 'p_1', other: 1 });
});

test('store: stripSecrets blanks the OBS password and secret params, and leaves the original alone', () => {
  const cfg = defaultConfig();
  cfg.settings.plugins.obs.password = 'pw';
  cfg.pages[0].buttons[0].steps = [{ action: 'ha.service', delayMs: 0, params: { token: 'SECRET', domain: 'light' } }];
  const clean = stripSecrets(cfg, defs);
  assert.equal(clean.settings.plugins.obs.password, '');
  assert.equal(clean.pages[0].buttons[0].steps[0].params.token, '');
  assert.equal(clean.pages[0].buttons[0].steps[0].params.domain, 'light');
  assert.equal(cfg.settings.plugins.obs.password, 'pw');
  assert.equal(cfg.pages[0].buttons[0].steps[0].params.token, 'SECRET');
});

test('state: plain keys, argument keys and unknown values', () => {
  const hub = new StateHub();
  assert.equal(hub.eval('obs.recording'), undefined, 'unknown until set');
  hub.set('obs.recording', true);
  hub.set('obs.scene', 'Gaming');
  hub.set('proc', { 'vrchat.exe': true });
  hub.set('obs.inputMuted', { Mic: true, Desk: false });
  assert.equal(hub.eval('obs.recording'), true);
  assert.equal(hub.eval('obs.scene=Gaming'), true);
  assert.equal(hub.eval('obs.scene=Chatting'), false);
  assert.equal(hub.eval('proc=vrchat.exe'), true);
  assert.equal(hub.eval('proc=steam.exe'), false);
  assert.equal(hub.eval('obs.inputMuted=Mic'), true);
  assert.equal(hub.eval('obs.inputMuted=Desk'), false);
  assert.equal(hub.eval(''), undefined);
});

test('state: only real changes emit, and removal makes the value unknown again', () => {
  const hub = new StateHub();
  const seen = [];
  hub.on('change', (k) => seen.push(k));
  hub.set('a', { x: 1 });
  hub.set('a', { x: 1 });
  hub.set('a', { x: 2 });
  hub.remove('a');
  hub.remove('a');
  assert.deepEqual(seen, ['a', 'a', 'a']);
  assert.equal(hub.eval('a'), undefined);
});
