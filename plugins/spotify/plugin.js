// Spotify: only "Like" needs this plugin (Windows has no like button). Play, pause, skip, shuffle, repeat
// and seek use the starter plugin's generic media-session control and need no Spotify setup or login at all.
const { SpotifyRuntime } = require('./runtime');

module.exports = {
  id: 'spotify',
  name: 'Spotify (Like)',
  version: '1.0.0',
  description: 'Adds the Like button. Play / pause / skip / shuffle / repeat need no setup at all.',
  icon: '💚',
  instructions: () => 'Play, pause, skip, shuffle, repeat and seek for Spotify need no setup at all. Only "Like" does, because Windows has no like button. To set it up: at developer.spotify.com/dashboard create an app, add the redirect URI shown below, tick "Web API", and paste its Client ID here. Spotify currently only lets an app in development mode work while its owner has Premium, for up to 5 people you add under User Management.',
  actions: require('./actions'),
  stateKeys: [
    { key: 'spotify.playing', label: 'Spotify is playing', group: 'Spotify' },
    { key: 'spotify.liked', label: 'The Spotify song playing is liked', group: 'Spotify' },
    { key: 'spotify.shuffle', label: 'Spotify shuffle is on', group: 'Spotify' },
    { key: 'spotify.repeat', label: 'Spotify repeat is on', group: 'Spotify' },
  ],
  settingsFields: [
    { key: 'clientId', label: 'Client ID (from your Spotify developer app)', type: 'text' },
  ],
  connections: [{ id: 'main', label: 'Spotify account', flow: 'redirect' }],
  clientMethods: ['connect', 'disconnect'],
  externalDomains: ['accounts.spotify.com'],
  // "I decorate the generic Windows-media-session reading for apps matching this" — adds the Like state
  // onto whatever the starter pack already read, instead of owning the whole reading like a mediaBridge does.
  likeProvider: { matches: (app) => /spotify/i.test(app) },
  matchState(key) {
    if (!key.startsWith('spotify.')) return null;
    const patch = { media: ['spotify'] };
    if (key === 'spotify.liked' || key === 'spotify.connected') patch.spotify = true;
    return patch;
  },
  createRuntime(ctx) {
    return new SpotifyRuntime(ctx);
  },
};
