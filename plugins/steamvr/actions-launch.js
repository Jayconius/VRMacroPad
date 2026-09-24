// Start, quit and restart SteamVR itself. Moved unchanged from the old src/core/actions/system.js.
const { spawn } = require('child_process');

const STEAMVR_PROCS = ['vrserver.exe', 'vrmonitor.exe', 'vrcompositor.exe', 'vrdashboard.exe', 'vrwebhelper.exe'];

function openTarget(target) {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) throw new Error('That is not a URL (expected something like https://... or steam://...)');
  return new Promise((resolve, reject) => {
    const child = spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', reject);
    child.unref();
    setTimeout(resolve, 150);
  });
}

function killByName(names) {
  return new Promise((resolve) => {
    const args = ['/F'];
    for (const n of names) args.push('/IM', n);
    const child = spawn('taskkill.exe', args, { stdio: 'ignore', windowsHide: true });
    child.on('error', () => resolve());
    child.on('exit', () => resolve());
  });
}

const actions = [
  {
    id: 'steamvr.start',
    category: 'SteamVR',
    label: 'Start SteamVR',
    description: 'Launches SteamVR through Steam.',
    icon: '🥽',
    needs: 'process',
    params: [],
    state: () => 'proc=vrserver.exe',
    defaults: { label: 'SteamVR', icon: '🥽', color: '#4a5568', colorOn: '#2f855a', labelOn: 'SteamVR on' },
    async run() {
      await openTarget('steam://run/250820');
    },
  },
  {
    id: 'steamvr.quit',
    category: 'SteamVR',
    label: 'Quit SteamVR',
    description: 'Force-closes SteamVR. Any running VR game will lose its headset.',
    icon: '⏹️',
    needs: 'process',
    params: [],
    state: () => 'proc=vrserver.exe',
    defaults: { label: 'Quit SteamVR', icon: '⏹️', color: '#9b2c2c', confirm: 'hold' },
    async run() {
      await killByName(STEAMVR_PROCS);
    },
  },
  {
    id: 'steamvr.restart',
    category: 'SteamVR',
    label: 'Restart SteamVR',
    description: 'Force-closes SteamVR, waits, then starts it again.',
    icon: '🔄',
    needs: 'process',
    params: [],
    defaults: { label: 'Restart SteamVR', icon: '🔄', color: '#b7791f', confirm: 'hold' },
    async run() {
      await killByName(STEAMVR_PROCS);
      await new Promise((r) => setTimeout(r, 4000));
      await openTarget('steam://run/250820');
    },
  },
];

module.exports = actions;
