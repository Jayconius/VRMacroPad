// Voicemod: change voice, switch the voice changer, mute, hear-myself and background effects, and play soundboard sounds,
// through Voicemod's own Control API (a WebSocket on this PC, ws://localhost:59129/v1/). Buttons light up to match Voicemod.
const { VoicemodRuntime } = require('./runtime');

module.exports = {
  id: 'voicemod',
  name: 'Voicemod',
  version: '1.0.0',
  description: 'Change voice, switch the voice changer, mute and play soundboard sounds in Voicemod, with buttons that light up to match.',
  icon: '🎭',

  instructions: () => [
    'Voicemod has to be installed and running. Its Control API needs a free client key, which you ask Voicemod for: press "Instructions" for the link and the steps.',
    'The key is stored in plain text in your settings file and is left out when you export a layout.',
  ].join('\n'),

  guide: {
    button: 'Instructions',
    title: 'Connect Voicemod',
    intro: 'Voicemod lets other programs control it through its Control API, but only with a client key that Voicemod gives out on request. Nothing is installed or changed in Voicemod.',
    steps: [
      {
        title: 'Ask Voicemod for a client key',
        text: 'Fill in Voicemod\'s API key request form. They send the key by email. (Their page also has the API documentation.)',
        links: [
          { label: 'Open the key request form', url: 'https://voicemod.typeform.com/to/Zh5ZHRED' },
          { label: 'Open Voicemod\'s Control API page', url: 'https://control-api.voicemod.net/' },
        ],
      },
      {
        title: 'Paste it here',
        text: 'Paste the key into "Client key" below, with Voicemod running. Leave the address and port alone.',
      },
      {
        title: 'Test it',
        text: 'Press "Save and test connection". It says how many voices it found. Then add a button and choose one of the Voicemod actions.',
      },
    ],
  },
  advancedLabel: 'Advanced: connection',
  externalDomains: ['voicemod.typeform.com', 'control-api.voicemod.net'],

  settingsFields: [
    { key: 'clientKey', label: 'Client key', type: 'password', default: '', help: 'The key Voicemod sent you. Stored in plain text in your settings file.' },
    { key: 'host', label: 'Voicemod address', type: 'text', default: 'localhost', advanced: true, help: 'Voicemod only accepts programs on this PC.' },
    { key: 'port', label: 'Port', type: 'number', min: 1, max: 65535, default: 59129, advanced: true },
  ],

  testOptionKind: 'voicemod.test',
  optionLists: {
    'voicemod.test': (ctx) => ctx.plugins.get('voicemod').check(),
    'voicemod.voices': (ctx, args) => ctx.plugins.get('voicemod').voices(args),
    'voicemod.voiceLists': (ctx) => ctx.plugins.get('voicemod').voiceLists(),
    'voicemod.soundLists': (ctx) => ctx.plugins.get('voicemod').soundLists(),
    'voicemod.sounds': (ctx, args) => ctx.plugins.get('voicemod').sounds(args),
  },

  actions: require('./actions'),

  stateKeys: [
    { key: 'voicemod.voiceChanger', label: 'Voicemod voice changer is on', group: 'Voicemod' },
    { key: 'voicemod.micMuted', label: 'Voicemod microphone is muted', group: 'Voicemod' },
    { key: 'voicemod.hearMyself', label: 'Voicemod hear-myself is on', group: 'Voicemod' },
    { key: 'voicemod.background', label: 'Voicemod background effects are on', group: 'Voicemod' },
    { key: 'voicemod.voice', label: 'Voicemod voice is…', group: 'Voicemod', arg: 'voicemod.voices' },
  ],
  matchState(key) {
    if (key.startsWith('voicemod.')) return { voicemod: true };
    return null;
  },

  createRuntime(ctx) {
    return new VoicemodRuntime(ctx);
  },
};
