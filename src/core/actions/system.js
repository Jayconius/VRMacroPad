// Keyboard, media keys, launching things, SteamVR start/stop, HTTP and Home Assistant.
const { spawn } = require('child_process');
const { parseCombo, MEDIA } = require('../keys');

const SHORTCUTS = {
  alttab: 'alt+tab',
  winkey: 'win',
  taskview: 'win+tab',
  desktop: 'win+d',
  escape: 'esc',
  enter: 'enter',
  screenshot: 'win+shift+s',
};

function quoteArg(s) {
  return `"${String(s).replace(/"/g, '')}"`;
}

// Detached so the launched app outlives us, and so closing the deck never closes it.
function startDetached(commandLine) {
  return new Promise((resolve, reject) => {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', commandLine], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    child.on('error', reject);
    child.unref();
    setTimeout(resolve, 150);
  });
}

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

function parseHeaders(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? `No answer from ${url} after ${ms / 1000}s` : `Request failed: ${err.cause ? err.cause.message : err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

const STEAMVR_PROCS = ['vrserver.exe', 'vrmonitor.exe', 'vrcompositor.exe', 'vrdashboard.exe', 'vrwebhelper.exe'];

const actions = [
  {
    id: 'keys.press',
    category: 'Keyboard & system',
    label: 'Press keys',
    description: 'Press a key or shortcut, e.g. ctrl+shift+m or F13.',
    icon: '⌨️',
    params: [
      { key: 'keys', label: 'Keys', type: 'keys', required: true, help: 'Click, then press the shortcut. Or type it like ctrl+alt+F13.' },
      { key: 'holdMs', label: 'Hold for (ms)', type: 'number', min: 0, max: 5000, default: 30, help: 'Some games only notice keys held for 50-100 ms.' },
      { key: 'scan', label: 'Send as hardware scan codes', type: 'boolean', default: false, help: 'Turn on if a game ignores the normal key press.' },
    ],
    defaults: { label: 'Key', icon: '⌨️', color: '#3b5b8f' },
    async run(p, ctx) {
      const { vks } = parseCombo(p.keys);
      await ctx.helper.call('keys.combo', { vks, holdMs: Number(p.holdMs ?? 30), scan: Boolean(p.scan) });
    },
  },
  {
    id: 'keys.type',
    category: 'Keyboard & system',
    label: 'Type text',
    description: 'Types the text into whichever window has focus.',
    icon: '🔤',
    params: [{ key: 'text', label: 'Text', type: 'textarea', required: true }],
    defaults: { label: 'Type', icon: '🔤', color: '#3b5b8f' },
    async run(p, ctx) {
      if (!p.text) throw new Error('No text to type');
      await ctx.helper.call('keys.text', { text: String(p.text), delayMs: 5 });
    },
  },
  {
    id: 'system.shortcut',
    category: 'Keyboard & system',
    label: 'Common shortcut',
    description: 'Alt+Tab, Windows key, Task View, Show desktop and friends.',
    icon: '🔀',
    params: [
      {
        key: 'shortcut', label: 'Shortcut', type: 'select', default: 'alttab',
        options: [['alttab', 'Alt+Tab (switch window)'], ['winkey', 'Windows key'], ['taskview', 'Task View (Win+Tab)'], ['desktop', 'Show desktop (Win+D)'], ['screenshot', 'Snipping tool (Win+Shift+S)'], ['escape', 'Escape'], ['enter', 'Enter']],
      },
    ],
    defaults: { label: 'Alt+Tab', icon: '🔀', color: '#3b5b8f' },
    async run(p, ctx) {
      const combo = SHORTCUTS[p.shortcut];
      if (!combo) throw new Error('Unknown shortcut');
      await ctx.helper.call('keys.combo', { vks: parseCombo(combo).vks, holdMs: 30, scan: false });
    },
  },
  {
    id: 'media.key',
    category: 'Keyboard & system',
    label: 'Media key',
    description: 'Play/pause, next, previous track, or system volume keys.',
    icon: '⏯️',
    params: [
      {
        key: 'key', label: 'Key', type: 'select', default: 'playpause',
        options: [['playpause', 'Play / Pause'], ['next', 'Next track'], ['previous', 'Previous track'], ['stop', 'Stop'], ['volumeup', 'Volume up'], ['volumedown', 'Volume down'], ['volumemute', 'Mute']],
      },
    ],
    defaults: { label: 'Play / Pause', icon: '⏯️', color: '#6b46c1' },
    async run(p, ctx) {
      const vk = MEDIA[p.key];
      if (!vk) throw new Error('Unknown media key');
      await ctx.helper.call('keys.combo', { vks: [vk], holdMs: 20, scan: false });
    },
  },
  {
    id: 'system.launch',
    category: 'Keyboard & system',
    label: 'Launch program or file',
    description: 'Start a program, script or open a file.',
    icon: '🚀',
    params: [
      { key: 'path', label: 'Program or file', type: 'text', required: true, placeholder: 'C:\\Program Files\\App\\app.exe' },
      { key: 'args', label: 'Arguments', type: 'text', placeholder: '--flag value' },
    ],
    defaults: { label: 'Launch', icon: '🚀', color: '#b7791f' },
    async run(p) {
      if (!p.path) throw new Error('No program chosen');
      await startDetached(`start "" ${quoteArg(p.path)} ${p.args || ''}`.trim());
    },
  },
  {
    id: 'system.openUrl',
    category: 'Keyboard & system',
    label: 'Open link',
    description: 'Open a web page or a steam:// / discord:// style link.',
    icon: '🔗',
    params: [{ key: 'url', label: 'Link', type: 'text', required: true, placeholder: 'https://...' }],
    defaults: { label: 'Link', icon: '🔗', color: '#2b6cb0' },
    async run(p) {
      await openTarget(String(p.url || '').trim());
    },
  },
  {
    id: 'system.toast',
    category: 'Keyboard & system',
    label: 'Show a message',
    description: 'Pops a message up in the deck. Handy as a confirmation step.',
    icon: '💬',
    params: [
      { key: 'message', label: 'Message', type: 'text', required: true },
      { key: 'level', label: 'Style', type: 'select', options: [['info', 'Info'], ['warn', 'Warning'], ['error', 'Error']], default: 'info' },
    ],
    defaults: { label: 'Message', icon: '💬', color: '#b7791f' },
    async run(p, ctx) {
      ctx.toast(String(p.message || ''), p.level || 'info');
    },
  },
  {
    id: 'system.wait',
    category: 'Keyboard & system',
    label: 'Wait',
    description: 'Pause between steps.',
    icon: '⏱️',
    params: [{ key: 'ms', label: 'Milliseconds', type: 'number', min: 0, max: 600000, default: 500 }],
    defaults: { label: 'Wait', icon: '⏱️', color: '#4a5568' },
    async run(p) {
      await new Promise((r) => setTimeout(r, Math.min(600000, Math.max(0, Number(p.ms) || 0))));
    },
  },
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
  {
    id: 'http.request',
    category: 'Web & smart home',
    label: 'HTTP request / webhook',
    description: 'Send a web request to any URL (webhooks, local servers, smart-home hubs).',
    icon: '🌐',
    params: [
      { key: 'method', label: 'Method', type: 'select', options: [['GET', 'GET'], ['POST', 'POST'], ['PUT', 'PUT'], ['DELETE', 'DELETE']], default: 'POST' },
      { key: 'url', label: 'URL', type: 'text', required: true, placeholder: 'http://192.168.1.20/api/...' },
      { key: 'headers', label: 'Headers (one per line, Name: value)', type: 'textarea', secret: true },
      { key: 'body', label: 'Body', type: 'textarea', showIf: { key: 'method', in: ['POST', 'PUT'] } },
    ],
    defaults: { label: 'Webhook', icon: '🌐', color: '#2b6cb0' },
    async run(p) {
      if (!/^https?:\/\//i.test(p.url || '')) throw new Error('URL must start with http:// or https://');
      const opts = { method: p.method || 'GET', headers: parseHeaders(p.headers) };
      if (p.body && (opts.method === 'POST' || opts.method === 'PUT')) opts.body = p.body;
      const res = await fetchWithTimeout(p.url, opts, 8000);
      if (!res.ok) throw new Error(`${p.url} answered ${res.status} ${res.statusText}`);
    },
  },
  {
    id: 'ha.service',
    category: 'Web & smart home',
    label: 'Home Assistant: call service',
    description: 'Turn a light or fan on/off, run a scene or script through Home Assistant.',
    icon: '🏠',
    params: [
      { key: 'baseUrl', label: 'Home Assistant address', type: 'text', required: true, placeholder: 'http://homeassistant.local:8123' },
      { key: 'token', label: 'Long-lived access token', type: 'password', secret: true, required: true, help: 'Create one in your Home Assistant profile page. It is stored in plain text in your config.' },
      { key: 'domain', label: 'Domain', type: 'text', required: true, placeholder: 'light' },
      { key: 'service', label: 'Service', type: 'text', required: true, placeholder: 'toggle' },
      { key: 'entityId', label: 'Entity', type: 'text', placeholder: 'light.desk' },
      { key: 'data', label: 'Extra data (JSON, optional)', type: 'textarea', placeholder: '{"brightness_pct": 40}' },
    ],
    defaults: { label: 'Lights', icon: '💡', color: '#b7791f' },
    async run(p) {
      let extra = {};
      if (p.data && String(p.data).trim()) {
        try { extra = JSON.parse(p.data); } catch { throw new Error('Extra data is not valid JSON'); }
      }
      const body = { ...extra };
      if (p.entityId) body.entity_id = p.entityId;
      const base = String(p.baseUrl || '').replace(/\/+$/, '');
      const url = `${base}/api/services/${encodeURIComponent(p.domain)}/${encodeURIComponent(p.service)}`;
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${p.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, 8000);
      if (res.status === 401) throw new Error('Home Assistant rejected the token');
      if (!res.ok) throw new Error(`Home Assistant answered ${res.status} ${res.statusText}`);
    },
  },
];

module.exports = actions;
