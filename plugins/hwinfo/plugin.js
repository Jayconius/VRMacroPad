// HWiNFO (free for personal use): live CPU, GPU, memory, drive and network stats as widgets, plus states buttons can
// follow ("the GPU is hot"). It reads HWiNFO's read-only "Shared Memory Support". Nothing is changed on your PC.
// The widgets, actions and runtime are shared with the Libre Hardware Monitor plugin (kit.js).
const { makeFetch } = require('./client');
const { MonitorRuntime } = require('./monitor');
const { makeKit } = require('./kit');

const kit = makeKit({ prefix: 'hwinfo', plugin: 'hwinfo', category: 'HWiNFO', icon: '🖥️', needsKey: 'hwinfo', name: 'HWiNFO' });

module.exports = {
  id: 'hwinfo',
  name: 'HWiNFO',
  version: '1.0.0',
  description: 'Live CPU, GPU, memory, drive and network stats as widgets with graphs, and buttons that follow "the GPU is hot".',
  icon: '🖥️',

  instructions: () => [
    'HWiNFO is a free, separate app. It has to be running with its Sensors window open and "Shared Memory Support" ticked, and HWiNFO must be restarted once after you tick it. Press "Instructions" for the steps.',
    'Then press "Save and test connection": it lists everything it can see. Add a "Hardware stat with graph" or "Hardware overview" widget to a button to see numbers live.',
    'The free version of HWiNFO switches Shared Memory Support off 12 hours after you tick it (tick it again to restart the 12 hours). HWiNFO Pro has no limit. Libre Hardware Monitor is a free alternative with no limit.',
  ].join('\n'),

  guide: {
    button: 'Instructions',
    title: 'Connect HWiNFO',
    intro: 'VR Macro Pad reads the numbers HWiNFO shows through its "Shared Memory Support". It only reads: nothing is changed on your PC.',
    steps: [
      {
        title: 'Install and start HWiNFO',
        text: 'Download HWiNFO (free) and install it. Start it and choose "Sensors-only", or tick Sensors when the start window shows.',
        links: [{ label: 'Open hwinfo.com', url: 'https://www.hwinfo.com/download/' }],
      },
      {
        title: 'Turn Shared Memory Support on',
        text: 'In HWiNFO open Settings (the gear on the Sensors window, then "Main Settings"), stay on the "General / User Interface" tab and tick "Shared Memory Support", then OK. Then RESTART HWiNFO: close it completely (also from the tray icon) and open it again. HWiNFO only starts sharing after a restart. The free version switches it off again after 12 hours: tick it again and restart HWiNFO when that happens (HWiNFO Pro has no limit).',
      },
      {
        title: 'Keep the Sensors window running',
        text: 'HWiNFO only shares numbers while its Sensors window is running. You can minimise it to the tray (tick "Minimize Sensors on Startup" and "Show Sensors on Startup" in the same Settings page to have it ready at every start).',
      },
      {
        title: 'Test it here',
        text: 'Come back to this card and press "Save and test connection". It shows how many readings it found.',
      },
    ],
  },
  externalDomains: ['hwinfo.com'],

  settingsFields: kit.settingsFields,

  stateKeys: kit.stateKeys,
  matchState(key) {
    return key.startsWith('hwinfo.') ? { hwinfo: true } : null;
  },

  testOptionKind: 'hwinfo.test',
  optionLists: {
    'hwinfo.test': (ctx) => ctx.plugins.get('hwinfo').options(),
    'hwinfo.sensors': (ctx) => ctx.plugins.get('hwinfo').options(),
  },

  actions: kit.actions,
  widgets: kit.widgets,

  createRuntime(ctx) {
    return new MonitorRuntime(ctx, { prefix: 'hwinfo', needsKey: 'hwinfo', fetch: makeFetch(ctx), name: 'HWiNFO' });
  },
};
