// A worked example plugin: the "real account login" pattern (device code, like Twitch), not a pasted API
// key (see ../example-plugin/ for that one). Copy this whole folder into
// <your data folder>/plugins/example-login/ to try it — press Connect in Settings → Plugins and it
// "approves itself" after a few seconds (see fake-service.js) so you can watch the whole flow with no real
// account. Then read client.js top to bottom: that's the part you rewrite against your own service.
const { ExampleLoginRuntime } = require('./runtime');

module.exports = {
  id: 'example-login',
  name: 'Example Login (template)',
  version: '1.0.0',
  description: 'A worked example: device-code sign-in, a token kept in ctx.secrets, and an action gated on being connected.',
  icon: '🔐',

  actions: require('./actions'),

  stateKeys: [
    { key: 'example-login.connected', label: 'Example Login is connected', group: 'Example Login (template)' },
  ],

  // No settingsFields at all: a device-code login needs no pasted key or host/port, just the Connect button
  // connections/clientMethods add below.
  connections: [{ id: 'main', label: 'Example Service account', flow: 'device' }],
  clientMethods: ['connect', 'disconnect'],
  externalDomains: ['example.com'], // wherever your real verificationUri points; the fake one here is harmless

  matchState(key) {
    if (key === 'example-login.connected') return { exampleLogin: true };
    return null;
  },

  createRuntime(ctx) {
    return new ExampleLoginRuntime(ctx);
  },
};
