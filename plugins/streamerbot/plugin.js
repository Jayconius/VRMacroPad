// Streamer.bot: run its actions from a button, through Streamer.bot's own WebSocket server. Nothing else is
// reached, and nothing is polled. Streamer.bot itself does the work (chat modes, clips, scenes, sounds... whatever
// the action you built does).
const { StreamerbotRuntime } = require('./runtime');

module.exports = {
  id: 'streamerbot',
  name: 'Streamer.bot',
  version: '1.0.0',
  description: 'Run your Streamer.bot actions from buttons.',
  icon: '🤖',

  instructions: () => [
    '1) In Streamer.bot open Servers/Clients → WebSocket Server and make sure it is started (Auto Start on). It listens on 127.0.0.1, port 8080 by default. If you set a password there, type it below.',
    '2) Press "Save and test connection" below. If it can see Streamer.bot, it says how many actions it found.',
    '3) On a button choose "Run a Streamer.bot action", and pick the action (or type its exact name).',
    'A button can only fire an action: Streamer.bot does not tell this app whether something (like emote-only mode) is currently on, so the button will not show that.',
  ].join('\n'),

  settingsFields: [
    { key: 'host', label: 'Streamer.bot address', type: 'text', default: '127.0.0.1', help: 'This PC is 127.0.0.1. If Streamer.bot runs on another PC, type that PC\'s address and set its WebSocket Server to listen on the network.' },
    { key: 'port', label: 'Port', type: 'number', min: 1, max: 65535, default: 8080 },
    { key: 'password', label: 'Password (only if you set one)', type: 'password', help: 'The password of Streamer.bot\'s WebSocket Server. Leave empty if it has none.' },
  ],

  testOptionKind: 'streamerbot.test',
  optionLists: {
    'streamerbot.test': (ctx) => ctx.plugins.get('streamerbot').check(),
    'streamerbot.actions': (ctx) => ctx.plugins.get('streamerbot').actions(),
  },

  actions: require('./actions'),

  createRuntime(ctx) {
    return new StreamerbotRuntime(ctx);
  },
};
