// Wires the core together. Used by the Electron app, the browser dev server and tests.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('./store');
const { SecretStore } = require('./secrets');
const { Helper, defaultBuildDir } = require('./helper');
const { StateHub } = require('./state');
const { Providers } = require('./providers');
const { TwitchClient } = require('./twitch');
const { SpotifyClient } = require('./spotify');
const { PearClient } = require('./pear');
const { Engine } = require('./engine');
const { createServer } = require('./server');
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
// Overrides (helper, mediaHelper, vrHelper, twitch, now, random) exist for tests.
function createApp({
  dataDir, buildDir = defaultBuildDir(), hooks = {}, port, devMode = false,
  helper: helperOverride, mediaHelper, vrHelper, twitch: twitchOverride, twitchOptions, pear: pearOverride, pearOptions, spotify: spotifyOverride, spotifyOptions, now, random,
}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const fullHooks = {
    registerHotkeys: () => [], setFocusable: () => {}, windowControl: () => {}, setWindowBounds: () => {}, openExternal: () => false, isDesktop: false, ...hooks,
  };
  const store = new Store(dataDir);
  const secrets = new SecretStore(dataDir, fullHooks.secretBox);
  const helper = helperOverride || new Helper(buildDir);
  const media = mediaHelper || new Helper(buildDir, 'media');
  const vr = vrHelper || new Helper(buildDir, 'vr');
  const twitch = twitchOverride || new TwitchClient({ secrets, ...(twitchOptions || {}) });
  const pear = pearOverride || new PearClient({ secrets, ...(pearOptions || {}) });
  const spotify = spotifyOverride || new SpotifyClient({ secrets, ...(spotifyOptions || {}) });
  const hub = new StateHub();
  const providers = new Providers({ helper, media, vr, twitch, pear, spotify, hub, now, dataDir, store });
  const engine = new Engine({ store, helper, providers, hub, hooks: fullHooks, now, random });
  const token = loadToken(dataDir);
  const server = createServer({
    engine, providers, helper, store, hooks: fullHooks, token,
    uiDir: path.join(__dirname, '..', 'ui'),
    sharedDir: path.join(__dirname, '..', 'shared'),
    version: pkg.version,
    devMode,
  });

  return {
    store, secrets, helper, media, vr, twitch, pear, spotify, hub, providers, engine, server, token,
    async start() {
      helper.start();
      engine.init();
      const actual = await server.listen(port !== undefined ? port : engine.config.settings.server.port);
      return { port: actual, url: `http://127.0.0.1:${actual}/?token=${token}` };
    },
    async stop() {
      engine.stop();
      providers.stop();
      twitch.stop();
      pear.stop();
      spotify.stop();
      helper.stop();
      media.stop();
      vr.stop();
      server.close();
    },
  };
}

module.exports = { createApp };
