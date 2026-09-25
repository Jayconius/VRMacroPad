// Libre Hardware Monitor (free, open source): live CPU, GPU, memory, drive and network numbers as widgets, plus states
// buttons can follow ("the GPU is hot"). It reads the small web page Libre Hardware Monitor can serve on this PC.
// Read-only: nothing is changed on your PC. The widgets, actions and runtime are shared with the HWiNFO plugin (kit.js).
const { fetchSensors } = require('./client');
const { MonitorRuntime } = require('./monitor');
const { makeKit } = require('./kit');

const kit = makeKit({ prefix: 'lhm', plugin: 'librehardware', category: 'Libre Hardware Monitor', icon: '📊', needsKey: 'lhm', name: 'Libre Hardware Monitor' });

module.exports = {
  id: 'librehardware',
  name: 'Libre Hardware Monitor',
  version: '1.0.0',
  description: 'Live CPU, GPU, memory, drive and network stats as widgets with graphs, and buttons that follow "the GPU is hot".',
  icon: '📊',

  instructions: () => [
    'Libre Hardware Monitor is a free, separate app (it has to be running). Press "Instructions" for the two things to switch on.',
    'Then press "Save and test connection": it lists everything it can see. Add a "Hardware stat with graph" or "Hardware overview" widget to a button to see numbers live.',
  ].join('\n'),

  guide: {
    button: 'Instructions',
    title: 'Connect Libre Hardware Monitor',
    intro: 'VR Macro Pad reads the numbers Libre Hardware Monitor shows through a small web page it serves on this PC. It only reads: nothing is changed on your PC.',
    steps: [
      {
        title: 'Install and start Libre Hardware Monitor',
        text: 'Search the web for "Libre Hardware Monitor" (it is on GitHub), download it (free), unzip it and run LibreHardwareMonitor.exe as administrator, so it can read every sensor. Leave it running (it can sit in the tray).',
      },
      {
        title: 'Turn its web server on',
        text: 'In Libre Hardware Monitor open Options → Remote Web Server → Run. The port is 8085 unless you change it. In Options you can also tick Run On Windows Startup and Start Minimized so it is always ready.',
      },
      {
        title: 'Test it here',
        text: 'Come back to this card and press "Save and test connection". It shows how many sensors it found.',
      },
      {
        title: 'Put numbers on a button',
        text: 'Add a button, choose Widget, and pick "Hardware stat with graph", "Hardware overview", "Hottest parts", "Network speed" or "Drives".',
      },
    ],
  },

  settingsFields: [
    { key: 'host', label: 'Libre Hardware Monitor address', type: 'text', default: '127.0.0.1', advanced: true, help: 'This PC is 127.0.0.1. Only change it if Libre Hardware Monitor runs on another PC on your network.' },
    { key: 'port', label: 'Port', type: 'number', min: 1, max: 65535, default: 8085, advanced: true },
    { key: 'username', label: 'User name (only if you set one in Libre Hardware Monitor)', type: 'text', advanced: true },
    { key: 'password', label: 'Password (only if you set one)', type: 'password', advanced: true },
    ...kit.settingsFields,
  ],

  stateKeys: kit.stateKeys,
  matchState(key) {
    return key.startsWith('lhm.') ? { lhm: true } : null;
  },

  testOptionKind: 'lhm.test',
  optionLists: {
    'lhm.test': (ctx) => ctx.plugins.get('librehardware').options(),
    'lhm.sensors': (ctx) => ctx.plugins.get('librehardware').options(),
  },

  actions: kit.actions,
  widgets: kit.widgets,

  createRuntime(ctx) {
    return new MonitorRuntime(ctx, { prefix: 'lhm', needsKey: 'lhm', fetch: fetchSensors, name: 'Libre Hardware Monitor' });
  },
};
