// TeamSpeak 3: mute your microphone or speakers, go away, and light buttons up to match, through the ClientQuery plugin
// that comes with the TS3 client (a local-only interface on 127.0.0.1:25639). TeamSpeak 5 / 6 have no such interface.
const { Ts3Runtime } = require('./runtime');

module.exports = {
  id: 'teamspeak3',
  name: 'TeamSpeak 3',
  version: '1.0.0',
  description: 'Mute your microphone or speakers and set yourself away in TeamSpeak 3, with buttons that light up to match.',
  icon: '🗣️',

  instructions: () => [
    'This works with TeamSpeak 3 only. TeamSpeak 5 and 6 have no way for other programs to control them.',
    'Press "Instructions" for the two steps: copy the API key from TeamSpeak\'s ClientQuery settings, then paste it below and press "Save and test connection".',
    'The key is stored in plain text in your settings file. It only lets programs on this PC control TeamSpeak, and it is left out when you export a layout.',
  ].join('\n'),

  guide: {
    button: 'Instructions',
    title: 'Connect TeamSpeak 3',
    intro: 'TeamSpeak 3 comes with a small plugin called ClientQuery that lets programs on this PC control it. It is switched on by default and cannot be reached from any other PC.',
    steps: [
      {
        title: 'Find your API key in TeamSpeak',
        text: 'In TeamSpeak 3 open Tools → Options → Addons, pick ClientQuery in the list and press Settings. Copy the API key: it looks like ABCD-EFGH-IJKL-MNOP-QRST-UVWX. If ClientQuery is not in the list or is switched off, tick it and restart TeamSpeak.',
      },
      {
        title: 'Paste it here',
        text: 'Paste the key into "API key" below. Leave the address and port alone unless you know they were changed.',
      },
      {
        title: 'Test it',
        text: 'Connect TeamSpeak to a server, then press "Save and test connection". It should say it found you by name. Then add a button and choose one of the TeamSpeak 3 actions.',
      },
    ],
  },

  settingsFields: [
    { key: 'apiKey', label: 'API key', type: 'password', default: '', help: 'From TeamSpeak: Tools → Options → Addons → ClientQuery → Settings. Stored in plain text in your settings file.' },
    { key: 'host', label: 'TeamSpeak address', type: 'text', default: '127.0.0.1', advanced: true, help: 'This PC is 127.0.0.1. TeamSpeak only accepts programs on the same PC.' },
    { key: 'port', label: 'Port', type: 'number', min: 1, max: 65535, default: 25639, advanced: true },
  ],

  testOptionKind: 'ts3.test',
  optionLists: {
    'ts3.test': (ctx) => ctx.plugins.get('teamspeak3').check(),
  },

  actions: require('./actions'),

  stateKeys: [
    { key: 'ts3.micMuted', label: 'TeamSpeak microphone is muted', group: 'TeamSpeak 3' },
    { key: 'ts3.speakersMuted', label: 'TeamSpeak speakers are muted', group: 'TeamSpeak 3' },
    { key: 'ts3.away', label: 'You are away on TeamSpeak', group: 'TeamSpeak 3' },
    { key: 'ts3.speaking', label: 'You are talking on TeamSpeak', group: 'TeamSpeak 3' },
  ],
  matchState(key) {
    if (key.startsWith('ts3.')) return { ts3: true };
    return null;
  },

  createRuntime(ctx) {
    return new Ts3Runtime(ctx);
  },
};
