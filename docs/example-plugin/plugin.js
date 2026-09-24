// A worked example plugin: "manual API setup" style (a pasted API key, like the Spotify Dev API), not an
// OAuth login. See ../PLUGIN-GUIDE.md for the full contract this is demonstrating, and the real plugins/
// folder (twitch, spotify, pear) for the three OAuth-login patterns this one deliberately skips.
//
// Copy this whole folder into <your data folder>/plugins/weather/ to try it. It polls a (fake, offline)
// weather API on a timer, publishes whether it is "hot" as a state key, offers an action that announces
// the temperature, and a small widget that shows it live.
const { WeatherRuntime } = require('./runtime');

module.exports = {
  id: 'weather',
  name: 'Weather (example)',
  version: '1.0.0',
  description: 'A worked example plugin: a pasted API key, a poll loop, an action, a widget, a state key.',
  icon: '⛅',

  actions: require('./actions'),
  widgets: require('./widgets'),

  stateKeys: [
    { key: 'weather.hot', label: 'It is hot outside', group: 'Weather (example)' },
  ],

  // Settings -> Connections gets a "Weather (example)" section built from this automatically, since this
  // plugin isn't one of the app's hand-written built-in sections. Saved to settings.plugins.weather.*.
  settingsFields: [
    { key: 'apiKey', label: 'API key', type: 'password', help: 'A pretend key: any non-empty text works for this example.' },
    { key: 'city', label: 'City', type: 'text', default: 'London' },
    { key: 'hotAboveC', label: 'Consider it "hot" above (°C)', type: 'number', min: -20, max: 50, default: 25 },
  ],

  // No `connections`/`clientMethods`/`externalDomains` here: a pasted API key needs no "Connect" button.

  // Turns "weather.hot" (typed into a trigger, or a button's state source) into a needs-patch, so
  // sync(needs) below only starts polling once something actually uses this plugin.
  matchState(key) {
    if (key === 'weather.hot') return { weather: true };
    return null;
  },

  createRuntime(ctx) {
    return new WeatherRuntime(ctx);
  },
};
