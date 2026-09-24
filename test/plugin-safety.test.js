// A plugin someone else wrote must never be able to crash the app or break another plugin.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createApp } = require('../src/core');
const { FakeHelper, tempDir } = require('./helpers');

// Builds <dir>/plugins/<name>/plugin.js (plus any extra files) and boots an app that loads it.
async function boot(files) {
  const dataDir = tempDir();
  const pluginsDir = path.join(dataDir, 'plugins');
  for (const [name, content] of Object.entries(files)) {
    const dir = path.join(pluginsDir, name.split('/')[0]);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, name), content);
  }
  const app = createApp({ dataDir, pluginsDir, helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), port: 0, twitchOptions: { defaultClientId: '' }, pearOptions: { retryMs: 60000 } });
  const log = [];
  app.engine.on('toast', (t) => log.push(t));
  await app.start();
  // The registry is shared by every app in one test process, so only look at this test's own folder.
  return { app, log, engine: app.engine, errors: () => app.registry.errors.filter((e) => e.dir.startsWith(pluginsDir)) };
}
const press = (app, action) => {
  const cfg = JSON.parse(JSON.stringify(app.engine.config));
  cfg.pages[0].buttons = [{ id: 'b', x: 0, y: 0, w: 1, h: 1, steps: [{ action, params: {}, delayMs: 0 }] }];
  app.engine.updateConfig(cfg);
  return app.engine.press('b');
};

test('safety: a plugin.js that requires a missing file is reported, and the app still starts', async () => {
  const { app, errors, log } = await boot({ 'typo/plugin.js': "module.exports = { id: 'typo', name: 'Typo', actions: require('./nope') };" });
  assert.equal(errors().length, 1);
  assert.match(errors()[0].error, /Cannot find module/);
  assert.equal(errors()[0].name, 'typo');
  assert.ok(log.some((t) => t.level === 'error' && /Typo|typo/.test(t.text) && /could not be loaded/.test(t.text)), 'the Activity log says so');
  assert.ok(app.registry.get('obs'), 'built-in plugins are unaffected');
  await app.stop();
});

test('safety: a syntax error is reported with its file and line', async () => {
  const { app, errors } = await boot({ 'syn/plugin.js': "module.exports = {\n  id: 'syn',\n  name: 'Syn',\n  actions: [ ,, oops\n};" });
  assert.equal(errors().length, 1);
  assert.match(errors()[0].error, /plugin\.js, line \d+/);
  await app.stop();
});

test('safety: a bad manifest is explained in plain words', async () => {
  const cases = {
    'a/plugin.js': "module.exports = { id: 'Bad Id', name: 'A' };",
    'b/plugin.js': "module.exports = { id: 'bee', name: 'B', actions: [{ label: 'no id', run() {} }] };",
    'c/plugin.js': "module.exports = { id: 'cee', name: 'C', actions: [{ id: 'cee.x', label: 'no run' }] };",
    'd/plugin.js': "module.exports = { id: 'dee', name: 'D', widgets: [{ id: 'dee.w' }] };",
    'e/plugin.js': "module.exports = { id: 'eee', name: 'E', settingsFields: [{ key: 'enabled', type: 'text' }] };",
  };
  const { app, errors } = await boot(cases);
  const msgs = errors().map((e) => e.error).join('\n');
  assert.match(msgs, /"id" must be lowercase/);
  assert.match(msgs, /actions\[0\] needs a string "id"/);
  assert.match(msgs, /action "cee.x" needs a run/);
  assert.match(msgs, /widget "dee.w" needs a data/);
  assert.match(msgs, /"enabled" and "autoConnect" are reserved/);
  assert.equal(errors().length, 5);
  await app.stop();
});

test('safety: a clashing action id refuses the whole plugin, and never half-registers it', async () => {
  const { app, errors } = await boot({
    'dupe/plugin.js': "module.exports = { id: 'dupe', name: 'Dupe', actions: [{ id: 'dupe.fine', label: 'ok', run() {} }, { id: 'audio.micMute', label: 'clash', run() {} }] };",
  });
  assert.equal(errors().length, 1);
  assert.match(errors()[0].error, /"audio.micMute" is already taken by another plugin/);
  assert.equal(app.registry.get('dupe'), null);
  assert.equal(app.registry.actionDefs.has('dupe.fine'), false, 'the non-clashing action was not registered either');
  await app.stop();
});

test('safety: two plugins with the same id, and two actions with the same id in one plugin', async () => {
  const one = "module.exports = { id: 'same', name: 'One', actions: [{ id: 'same.a', label: 'a', run() {} }] };";
  const { app, errors } = await boot({
    'one/plugin.js': one,
    'two/plugin.js': one.replace('One', 'Two'),
    'twice/plugin.js': "module.exports = { id: 'twice', name: 'Twice', actions: [{ id: 'twice.a', label: 'a', run() {} }, { id: 'twice.a', label: 'b', run() {} }] };",
  });
  assert.ok(app.registry.get('same'));
  assert.equal(errors().length, 2);
  assert.ok(errors().some((e) => /already uses the id "same"/.test(e.error)));
  assert.ok(errors().some((e) => /by another action in this plugin/.test(e.error)));
  await app.stop();
});

test('safety: createRuntime throwing shows as an error on that plugin only', async () => {
  const { app, log } = await boot({
    'thrower/plugin.js': "module.exports = { id: 'thrower', name: 'Thrower', actions: [{ id: 'thrower.go', label: 'go', run() {} }], createRuntime() { throw new Error('boom in createRuntime'); } };",
  });
  const st = app.providers.status().plugins.thrower;
  assert.equal(st.state, 'error');
  assert.match(st.error, /createRuntime\(\) failed: boom in createRuntime/);
  assert.ok(log.some((t) => t.level === 'error' && /Thrower/.test(t.text) && /boom in createRuntime/.test(t.text)));
  assert.equal(app.providers.status().plugins.obs.state, 'off', 'other plugins are fine');
  await app.stop();
});

test('safety: sync/configure/status throwing is contained, reported once, and other plugins still sync', async () => {
  const { app, log, engine } = await boot({
    'syncthrow/plugin.js': "module.exports = { id: 'syncthrow', name: 'SyncThrow', actions: [{ id: 'st.go', label: 'go', needs: 'syncthrow', run() {} }], createRuntime() { return { sync() { throw new Error('sync boom'); }, configure() { throw new Error('configure boom'); }, status() { throw new Error('status boom'); } }; } };",
  });
  await press(app, 'st.go'); // forces a sync with needs.syncthrow
  const st = app.providers.status().plugins.syncthrow;
  assert.equal(st.state, 'error');
  assert.match(st.error, /failed: .* boom/);
  const errs = log.filter((t) => t.level === 'error' && /SyncThrow/.test(t.text));
  assert.ok(errs.length >= 1 && errs.length <= 3, `reported, not spammed (${errs.length})`);
  const before = errs.length;
  engine.applyConfig();
  engine.applyConfig();
  assert.equal(log.filter((t) => t.level === 'error' && /SyncThrow/.test(t.text)).length, before, 'the same problem is not reported again');
  await app.stop();
});

test('safety: a plugin whose own functions throw cannot break needs, state or widgets', async () => {
  const { app, engine } = await boot({
    'evil/plugin.js': `module.exports = {
      id: 'evil', name: 'Evil',
      matchState() { throw new Error('matchState boom'); },
      actions: [{ id: 'evil.a', label: 'a', needs() { throw new Error('needs boom'); }, state() { throw new Error('state boom'); }, run() {} }],
      widgets: [{ id: 'evil.w', label: 'w', needs() { throw new Error('wneeds'); }, initState: () => ({}), data() { throw new Error('data boom'); }, command() {} }],
    };`,
  });
  const cfg = JSON.parse(JSON.stringify(engine.config));
  cfg.pages[0].buttons = [
    { id: 'a', x: 0, y: 0, w: 1, h: 1, steps: [{ action: 'evil.a', params: {}, delayMs: 0 }], state: { source: 'auto', key: '' } },
    { id: 'w', x: 1, y: 0, w: 2, h: 1, widget: { type: 'evil.w', params: {} }, steps: [], triggers: [], state: { source: 'none', key: '' } },
  ];
  engine.updateConfig(cfg);
  assert.doesNotThrow(() => engine.computeButtonStates());
  const data = engine.computeWidgetData();
  assert.equal(data.w.unavailable, true);
  assert.match(data.w.error, /data boom/);
  await app.stop();
});

test('safety: the same broken plugin folder loaded by two apps in one process is not reported twice', async () => {
  const dataDir = tempDir();
  const pluginsDir = path.join(dataDir, 'plugins', 'typo');
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, 'plugin.js'), "module.exports = { id: 'typo2', name: 'T', actions: require('./nope') };");
  const make = () => createApp({ dataDir, pluginsDir: path.join(dataDir, 'plugins'), helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), port: 0, twitchOptions: { defaultClientId: '' } });
  const a = make();
  const b = make();
  assert.equal(b.registry.errors.filter((e) => e.dir === pluginsDir).length, 1);
  await a.stop();
  await b.stop();
});

test('widgets: a plugin widget declares how it reacts to taps, and the catalog tells the browser', async () => {
  const { app } = await boot({
    'tapw/plugin.js': "module.exports = { id: 'tapw', name: 'TapW', widgets: [{ id: 'tapw.a', label: 'A', interaction: 'tap', initState: () => ({}), data: () => ({ value: '1' }), command() {} }, { id: 'tapw.b', label: 'B', initState: () => ({}), data: () => ({}), command() {} }, { id: 'tapw.c', label: 'C', interaction: 'sideways', data: () => ({}) }] };",
  });
  const { catalogForUi } = require('../src/core/actions');
  const byId = Object.fromEntries(catalogForUi().widgets.map((w) => [w.id, w.interaction]));
  assert.equal(byId['tapw.a'], 'tap');
  assert.equal(byId['tapw.b'], 'none');
  assert.equal(byId['tapw.c'], 'none', 'an unknown value falls back to none');
  await app.stop();
});
