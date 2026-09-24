// Wires the core together. Used by the Electron app, the browser dev server and tests.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('./store');
const { ImageStore } = require('./images');
const { SecretStore } = require('./secrets');
const { Helper, defaultBuildDir } = require('./helper');
const { StateHub } = require('./state');
const { PluginRuntime } = require('./plugin-runtime');
const { registry, loadUserPlugins } = require('./actions');
// Twitch/Spotify/Pear's client classes are constructed here (not just through the generic plugin loader)
// so tests can override their behavior via twitchOptions/spotifyOptions/pearOptions. That means their
// require() has to be conditional on the plugin still being loaded, or deleting e.g. plugins/twitch/
// would crash the whole app at startup instead of just that plugin quietly going away.
const TwitchClient = registry.get('twitch') ? require('../../plugins/twitch/client').TwitchClient : null;
const SpotifyClient = registry.get('spotify') ? require('../../plugins/spotify/client').SpotifyClient : null;
const PearClient = registry.get('pear') ? require('../../plugins/pear/client').PearClient : null;
const { Engine } = require('./engine');
const { createServer } = require('./server');
const { Updater } = require('./updater');
const appConfig = require('./app-config');
const pkg = require('../../package.json');

// A stable per-install secret so bookmarked browser URLs keep working.
function loadToken(dataDir) {
  if (process.env.VRMD_TOKEN) return process.env.VRMD_TOKEN;
  const file = path.join(dataDir, 'auth.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof saved.token === 'string' && saved.token.length >= 32) return saved.token;
  } catch { /* first run */ }
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(file, JSON.stringify({ token }));
  return token;
}

// hooks lets the host (Electron) provide things the core cannot do itself:
//   registerHotkeys(list) -> array of accelerators that failed
//   setFocusable(bool)    -> allow the window to take keyboard focus (for text fields)
//   windowControl(cmd)    -> 'minimize' | 'maximize' | 'close' for the borderless title bar
//   openExternal(url)     -> open a link in the default browser
//   secretBox             -> { available, encrypt, decrypt } to protect saved logins
//   updateEnv             -> { mode: 'portable' | 'installer' | 'manual', portableDir, downloadsDir } how this copy was installed
//   quit()                -> close the app (used by "Install and restart")
//   showFile(path)        -> show a file in Explorer
// Overrides (helper, mediaHelper, vrHelper, vmHelper, twitch, pear, spotify, now, random) exist for tests.
// pluginsDir overrides where user plugins are read from (defaults to <dataDir>/plugins); pass false to skip
// loading user plugins at all (most tests want that, so a stray folder never changes what they see).
function createApp({
  dataDir, buildDir = defaultBuildDir(), hooks = {}, port, devMode = false,
  helper: helperOverride, mediaHelper, vrHelper, vmHelper, twitch: twitchOverride, twitchOptions, pear: pearOverride, pearOptions, spotify: spotifyOverride, spotifyOptions, now, random,
  pluginsDir, updaterOptions,
}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const fullHooks = {
    registerHotkeys: () => [], setFocusable: () => {}, windowControl: () => {}, setWindowBounds: () => {}, overlayCommand: async (name, args) => false, overlayInfo: null, openExternal: () => false, isDesktop: false, ...hooks,
  };
  const userPluginsDir = pluginsDir === false ? null : (pluginsDir || path.join(dataDir, 'plugins'));
  if (userPluginsDir) loadUserPlugins(userPluginsDir);

  const store = new Store(dataDir, registry);
  const images = new ImageStore(dataDir);
  const secrets = new SecretStore(dataDir, fullHooks.secretBox);
  const helper = helperOverride || new Helper(buildDir);
  const media = mediaHelper || new Helper(buildDir, 'media');
  const vr = vrHelper || new Helper(buildDir, 'vr');
  const vm = vmHelper || new Helper(buildDir, 'voicemeeter');
  const twitch = twitchOverride || (TwitchClient ? new TwitchClient({ secrets, ...(twitchOptions || {}) }) : null);
  const pear = pearOverride || (PearClient ? new PearClient({ secrets, ...(pearOptions || {}) }) : null);
  const spotify = spotifyOverride || (SpotifyClient ? new SpotifyClient({ secrets, ...(spotifyOptions || {}) }) : null);
  const hub = new StateHub();
  const providers = new PluginRuntime({ registry, helper, media, vr, vm, twitch, pear, spotify, hub, now, dataDir, store, buildDir, secrets });
  const engine = new Engine({ store, helper, providers, hub, hooks: fullHooks, now, random, registry });
  const updater = new Updater({
    version: pkg.version,
    githubUrl: appConfig.githubUrl,
    dataDir,
    getSettings: () => engine.config.settings.updates,
    skip: (v) => engine.patchSettings((st) => { st.updates.skipped = v; }),
    env: fullHooks.updateEnv,
    quit: () => fullHooks.quit && fullHooks.quit(),
    showFile: (f) => fullHooks.showFile && fullHooks.showFile(f),
    ...(updaterOptions || {}),
  });
  engine.on('config', () => updater.sync());
  const token = loadToken(dataDir);
  const server = createServer({
    engine, providers, helper, store, images, hooks: fullHooks, token, updater,
    uiDir: path.join(__dirname, '..', 'ui'),
    sharedDir: path.join(__dirname, '..', 'shared'),
    version: pkg.version,
    devMode,
    registry,
  });

  return {
    store, images, secrets, helper, media, vr, vm, twitch, pear, spotify, hub, providers, engine, server, token, registry, updater,
    async start() {
      helper.start();
      engine.init();
      images.gc(engine.config); // pictures no button uses any more
      updater.sync(); // starts asking GitHub for new versions only if you turned that on
      const actual = await server.listen(port !== undefined ? port : engine.config.settings.server.port);
      return { port: actual, url: `http://127.0.0.1:${actual}/?token=${token}` };
    },
    async stop() {
      updater.stop();
      engine.stop();
      providers.stop();
      if (twitch) twitch.stop();
      if (pear) pear.stop();
      if (spotify) spotify.stop();
      helper.stop();
      media.stop();
      vr.stop();
      vm.stop();
      server.close();
    },
  };
}

module.exports = { createApp };
