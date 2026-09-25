// Mix It Up (mixitup.bot): run its commands from a button, through Mix It Up's own Developer API (a small server
// that only listens on this PC). Nothing else is reached and nothing is polled: Mix It Up does the work.
const { MixItUpRuntime } = require('./runtime');

module.exports = {
  id: 'mixitup',
  name: 'Mix It Up',
  version: '1.0.0',
  description: 'Run your Mix It Up commands from buttons, send chat messages and turn commands on or off.',
  icon: '🎛️',

  instructions: () => [
    'Mix It Up is a separate free app (mixitup.bot) that has to be installed and running. Press "Instructions" for the steps to switch its Developer API on.',
    'Then press "Save and test connection" below: it says how many commands it found. On a button choose "Run a Mix It Up command" and pick one.',
    'A button can only fire a command: Mix It Up does not tell this app what happened afterwards, so the button does not show a state.',
  ].join('\n'),

  guide: {
    button: 'Instructions',
    title: 'Connect Mix It Up',
    intro: 'VR Macro Pad talks to Mix It Up through its Developer API, which only listens on this PC and needs no password. Nothing is installed or changed by this app.',
    steps: [
      {
        title: 'Install and start Mix It Up',
        text: 'If you do not have it yet, download it (free), install it and sign in to your channel. Leave it running.',
        links: [{ label: 'Open mixitup.bot', url: 'https://mixitup.bot' }],
      },
      {
        title: 'Turn the Developer API on',
        text: 'In Mix It Up open the Services page, scroll to "Developer API" and press Connect. It uses http://localhost:8911/api/v2 unless you change it.',
      },
      {
        title: 'Test it here',
        text: 'Come back to this card and press "Save and test connection". It should say how many commands it found. If it cannot connect, check that Mix It Up is running and the Developer API says Connected.',
      },
      {
        title: 'Put a command on a button',
        text: 'Add a button, choose "Run a Mix It Up command", and pick the command from the list.',
      },
    ],
  },
  externalDomains: ['mixitup.bot'],

  settingsFields: [
    { key: 'host', label: 'Mix It Up address', type: 'text', default: '127.0.0.1', help: 'This PC is 127.0.0.1. Only change it if Mix It Up runs on another PC on your network and you have exposed its Developer API there.' },
    { key: 'port', label: 'Port', type: 'number', min: 1, max: 65535, default: 8911 },
  ],

  testOptionKind: 'mixitup.test',
  optionLists: {
    'mixitup.test': (ctx) => ctx.plugins.get('mixitup').check(),
    'mixitup.commands': (ctx) => ctx.plugins.get('mixitup').commands(),
  },

  actions: require('./actions'),

  createRuntime(ctx) {
    return new MixItUpRuntime(ctx);
  },
};
