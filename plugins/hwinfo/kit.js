// The widgets and actions both hardware plugins offer (an identical copy lives in plugins/hwinfo/; a test keeps them the
// same). makeKit({ prefix, plugin, category, icon, needsKey, name }) builds them for one plugin.
const { PRESETS, PRESET_BY_ID, display, statusFor, limitInCelsius, toF } = require('./sensors');

const STAT_OPTIONS = [...PRESETS.map((p) => [p.id, `${p.group}: ${p.label}`]), ['custom', 'Any sensor (pick it below)']];
const num = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? NaN : Number(v));

function makeKit({ prefix, plugin, category, icon, needsKey, name }) {
  const needs = () => ({ [needsKey]: true });
  const rt = (ctx) => ctx.plugin(plugin);

  // The reading a widget or action was set to show: a preset, or a sensor picked by name.
  function chosen(runtime, p) {
    return p.stat === 'custom' ? runtime.custom(p.sensor) : runtime.preset(p.stat || 'cpuTemp');
  }

  // Warn and alert levels in °C (or the sensor's own unit): what you typed on the widget, else the plugin's Settings.
  function levels(runtime, p, s, fahrenheit) {
    const preset = PRESET_BY_ID.get(p.stat);
    const lim = runtime.limits();
    let warn = NaN;
    let alert = NaN;
    if (preset && preset.warn !== undefined) {
      warn = preset.type === 'temperature' ? (p.stat === 'driveTemp' ? lim.drive : lim.temp) : (p.stat === 'ramLoad' ? lim.ram : lim.load);
      alert = Math.max(preset.alert, warn + 5);
    } else if (s && s.unit === '°C') { warn = lim.temp; alert = lim.temp + 10; }
    else if (s && s.unit === '%' && s.type === 'load') { warn = lim.load; alert = 99; }
    const typedWarn = num(p.warnAt);
    const typedAlert = num(p.alertAt);
    const conv = (n) => (s && s.unit === '°C' ? limitInCelsius(n, fahrenheit) : n);
    return { warn: Number.isFinite(typedWarn) ? conv(typedWarn) : warn, alert: Number.isFinite(typedAlert) ? conv(typedAlert) : alert };
  }

  function notReady(runtime) {
    const d = runtime.snapshot();
    if (d.connected) return null;
    return { value: '—', subtitle: d.error || `Waiting for ${name}…`, status: 'error' };
  }

  const inUnit = (s, fahrenheit) => (list) => (s.unit === '°C' && fahrenheit ? list.map(toF) : list);

  const widgets = [
    {
      id: `${prefix}.stat`,
      category,
      label: 'Hardware stat with graph',
      description: `One live number from ${name}, such as your CPU or GPU temperature or usage, with a little graph, turning amber and red when it gets high.`,
      icon,
      size: { w: 2, h: 2 },
      params: [
        { key: 'stat', label: 'Show', type: 'select', default: 'cpuTemp', options: STAT_OPTIONS },
        { key: 'sensor', label: 'Sensor', type: 'select', optionsFrom: `${prefix}.sensors`, allowCustom: true, help: `Pick from the list (it fills in while ${name} is running).`, showIf: { key: 'stat', in: ['custom'] } },
        { key: 'graph', label: 'Show the graph of the last minute or so', type: 'boolean', default: true },
        { key: 'range', label: 'Show the lowest and highest since it started', type: 'boolean', default: false },
        { key: 'warnAt', label: 'Turn amber at (optional)', type: 'number', help: 'Leave empty to use the default for this reading (temperatures and usage have one; the plugin\'s Settings can change it). Temperatures are in the unit you chose in Settings.' },
        { key: 'alertAt', label: 'Turn red at (optional)', type: 'number' },
      ],
      defaults: { color: '#1f3a4a' },
      needs,
      initState: () => ({}),
      data(ctx, button) {
        const runtime = rt(ctx);
        const wait = notReady(runtime);
        if (wait) return wait;
        const p = button.widget.params;
        const s = chosen(runtime, p);
        if (!s) return { value: '—', subtitle: p.stat === 'custom' ? 'Pick a sensor' : `${(PRESET_BY_ID.get(p.stat) || {}).label || 'That reading'} isn't reported on this PC`, status: '' };
        const f = runtime.fahrenheit();
        const d = display(s, f);
        const lv = levels(runtime, p, s, f);
        const preset = PRESET_BY_ID.get(p.stat);
        const title = preset ? preset.label : `${s.name}`;
        let subtitle = title;
        if (p.range === true && Number.isFinite(s.min) && Number.isFinite(s.max)) {
          subtitle = `${title} · ${display({ ...s, value: s.min }, f).text} – ${display({ ...s, value: s.max }, f).text}`;
        }
        let progress = null;
        if (s.unit === '%') progress = s.value / 100;
        else if (preset && preset.max) progress = s.value / preset.max;
        else if (Number.isFinite(s.max) && s.max > 0) progress = s.value / s.max;
        const out = { value: d.text, subtitle, progress, status: statusFor(s.value, lv.warn, lv.alert) || 'ok' };
        if (p.graph !== false) {
          out.spark = inUnit(s, f)(runtime.historyOf(s));
          if (s.unit === '%') { out.sparkMin = 0; out.sparkMax = 100; }
          else if (s.unit === '°C' && out.spark.length) {
            // a temperature that wobbles by a degree should not look like a mountain range: show at least a 20 degree window
            const lo = Math.min(...out.spark);
            const hi = Math.max(...out.spark);
            const pad = Math.max(0, 20 - (hi - lo)) / 2;
            out.sparkMin = lo - pad;
            out.sparkMax = hi + pad;
          }
        }
        return out;
      },
      command: async () => {},
    },
    {
      id: `${prefix}.overview`,
      category,
      label: 'Hardware overview',
      description: `A live list of the readings you pick (CPU, GPU, memory...), each turning amber or red when it gets high.`,
      icon,
      size: { w: 3, h: 2 },
      params: [
        { key: 'rows', label: 'Rows', type: 'multiselect', default: ['cpuLoad', 'cpuTemp', 'gpuLoad', 'gpuTemp', 'ramLoad'], options: PRESETS.map((p) => [p.id, `${p.group}: ${p.label}`]) },
      ],
      defaults: { color: '#1f3a4a' },
      needs,
      initState: () => ({}),
      data(ctx, button) {
        const runtime = rt(ctx);
        const wait = notReady(runtime);
        if (wait) return wait;
        const rows = Array.isArray(button.widget.params.rows) && button.widget.params.rows.length ? button.widget.params.rows : ['cpuLoad', 'cpuTemp', 'gpuLoad', 'gpuTemp', 'ramLoad'];
        const lines = rows.map((id) => runtime.line(id)).filter(Boolean);
        const items = lines.map((l) => ({ label: l.label, value: l.text }));
        const worst = lines.some((l) => l.status === 'error') ? 'error' : lines.some((l) => l.status === 'warn') ? 'warn' : 'ok';
        return { subtitle: name, items: items.slice(0, 12), status: worst };
      },
      command: async () => {},
    },
    {
      id: `${prefix}.temps`,
      category,
      label: 'Hottest parts',
      description: 'The hottest temperatures on your PC right now, hottest first.',
      icon: '🌡️',
      size: { w: 2, h: 2 },
      params: [{ key: 'count', label: 'How many to list', type: 'number', min: 1, max: 10, default: 5 }],
      defaults: { color: '#4a2a1f' },
      needs,
      initState: () => ({}),
      data(ctx, button) {
        const runtime = rt(ctx);
        const wait = notReady(runtime);
        if (wait) return wait;
        const f = runtime.fahrenheit();
        const lim = runtime.limits();
        const count = Math.max(1, Math.min(10, Math.round(num(button.widget.params.count)) || 5));
        const temps = runtime.snapshot().sensors
          .filter((s) => s.type === 'temperature' && Number.isFinite(s.value) && s.value > 0 && s.value < (s.hwKind === 'cpu' || s.hwKind === 'gpu' || s.hwKind === 'storage' ? 150 : 100) && !/warning|critical|limit|threshold|target|distance|margin|max|min|\bhigh\b|\blow\b/i.test(s.name))
          .sort((a, b) => b.value - a.value);
        const seen = new Set();
        const top = [];
        for (const s of temps) {
          const label = s.hwKind === 'cpu' ? (/^cpu/i.test(s.name) ? s.name : `CPU ${s.name}`) : s.hwKind === 'gpu' ? (/^gpu/i.test(s.name) ? s.name.replace(/ temperature$/i, '') : `GPU ${s.name}`) : s.hwKind === 'storage' ? s.hw : s.name;
          if (seen.has(label)) continue;
          seen.add(label);
          top.push({ s, label });
          if (top.length >= count) break;
        }
        if (!top.length) return { value: '—', subtitle: 'No temperatures reported', status: '' };
        const hottest = top[0].s;
        return {
          value: display(hottest, f).text,
          subtitle: top[0].label,
          status: statusFor(hottest.value, lim.temp, lim.temp + 10) || 'ok',
          items: top.slice(1).map((t) => ({ label: t.label, value: display(t.s, f).text })),
        };
      },
      command: async () => {},
    },
    {
      id: `${prefix}.network`,
      category,
      label: 'Network speed',
      description: 'Live download and upload speed of the network connection that is in use, with a graph.',
      icon: '🌐',
      size: { w: 2, h: 2 },
      params: [{ key: 'graph', label: 'Show the graph', type: 'boolean', default: true }],
      defaults: { color: '#1f3a2f' },
      needs,
      initState: () => ({}),
      data(ctx, button) {
        const runtime = rt(ctx);
        const wait = notReady(runtime);
        if (wait) return wait;
        const down = runtime.preset('download');
        const up = runtime.preset('upload');
        if (!down && !up) return { value: '—', subtitle: 'No network speed is reported', status: '' };
        const out = { value: `↓ ${display(down, false).text}`, subtitle: `↑ ${display(up, false).text}`, status: 'ok' };
        if (button.widget.params.graph !== false && down) out.spark = runtime.historyOf(down);
        return out;
      },
      command: async () => {},
    },
    {
      id: `${prefix}.drives`,
      category,
      label: 'Drives',
      description: 'Each drive\'s temperature and how full it is.',
      icon: '💽',
      size: { w: 3, h: 2 },
      params: [],
      defaults: { color: '#2a2a4a' },
      needs,
      initState: () => ({}),
      data(ctx) {
        const runtime = rt(ctx);
        const wait = notReady(runtime);
        if (wait) return wait;
        const f = runtime.fahrenheit();
        const lim = runtime.limits();
        const byDrive = new Map();
        for (const s of runtime.snapshot().sensors) {
          if (s.hwKind !== 'storage' || !Number.isFinite(s.value)) continue;
          const d = byDrive.get(s.hw) || {};
          if (s.type === 'temperature' && !/warning|critical|limit|threshold|max|min/i.test(s.name) && (d.temp === undefined || /composite|temperature$/i.test(s.name))) d.temp = s;
          if (s.type === 'load' && /used space|used$/i.test(s.name)) d.used = s;
          byDrive.set(s.hw, d);
        }
        const items = [];
        let worst = 'ok';
        for (const [hw, d] of byDrive) {
          const bits = [];
          if (d.temp) { bits.push(display(d.temp, f).text); const st = statusFor(d.temp.value, lim.drive, lim.drive + 10); if (st === 'error' || (st === 'warn' && worst === 'ok')) worst = st; }
          if (d.used) bits.push(`${Math.round(d.used.value)}% full`);
          if (bits.length) items.push({ label: hw, value: bits.join(' · ') });
        }
        if (!items.length) return { value: '—', subtitle: 'No drives reported', status: '' };
        return { subtitle: 'Drives', items: items.slice(0, 12), status: worst };
      },
      command: async () => {},
    },
  ];

  const statParams = [
    { key: 'stat', label: 'Reading', type: 'select', default: 'cpuTemp', options: STAT_OPTIONS },
    { key: 'sensor', label: 'Sensor', type: 'select', optionsFrom: `${prefix}.sensors`, allowCustom: true, showIf: { key: 'stat', in: ['custom'] } },
  ];

  const actions = [
    {
      id: `${prefix}.show`,
      category,
      label: 'Show a hardware stat',
      description: `Pops up the current value of a reading from ${name}, for example your GPU temperature.`,
      icon,
      params: statParams,
      defaults: { label: 'Stat', icon, color: '#1f3a4a' },
      async run(p, ctx) {
        const runtime = rt(ctx);
        await runtime.ensure();
        const s = chosen(runtime, p);
        if (!s) throw new Error(p.stat === 'custom' ? 'Pick a sensor first.' : 'That reading is not reported on this PC.');
        const preset = PRESET_BY_ID.get(p.stat);
        ctx.toast(`${preset ? preset.label : s.name}: ${display(s, runtime.fahrenheit()).text}`, 'info');
      },
    },
    {
      id: `${prefix}.resetGraphs`,
      category,
      label: 'Clear the hardware graphs',
      description: 'Starts the little graphs over.',
      icon: '🧹',
      params: [],
      defaults: { label: 'Clear graphs', icon: '🧹', color: '#4a4a4a' },
      async run(p, ctx) {
        rt(ctx).clearHistory();
        ctx.toast('Hardware graphs cleared', 'info');
      },
    },
  ];

  const stateKeys = [
    { key: `${prefix}.connected`, label: `${name} is connected`, group: category },
    { key: `${prefix}.cpuHot`, label: 'The CPU is hot', group: category },
    { key: `${prefix}.gpuHot`, label: 'The GPU is hot', group: category },
    { key: `${prefix}.driveHot`, label: 'A drive is hot', group: category },
    { key: `${prefix}.anyHot`, label: 'The CPU, GPU or a drive is hot', group: category },
    { key: `${prefix}.cpuBusy`, label: 'The CPU is nearly maxed out', group: category },
    { key: `${prefix}.gpuBusy`, label: 'The GPU is nearly maxed out', group: category },
    { key: `${prefix}.ramHigh`, label: 'Memory is nearly full', group: category },
  ];

  const settingsFields = [
    { key: 'interval', label: 'Update every (seconds)', type: 'number', min: 0.5, max: 60, default: 2 },
    { key: 'fahrenheit', label: 'Show temperatures in °F', type: 'boolean', default: false },
    { key: 'tempWarn', label: 'CPU / GPU is "hot" at (°C)', type: 'number', min: 30, max: 250, default: 85, advanced: true, help: 'Always in °C. Widgets turn amber here and buttons can follow "the CPU is hot".' },
    { key: 'driveWarn', label: 'A drive is "hot" at (°C)', type: 'number', min: 30, max: 250, default: 60, advanced: true },
    { key: 'loadWarn', label: 'CPU / GPU is "maxed out" at (%)', type: 'number', min: 50, max: 100, default: 95, advanced: true },
    { key: 'ramWarn', label: 'Memory is "nearly full" at (%)', type: 'number', min: 50, max: 100, default: 90, advanced: true },
  ];

  return { widgets, actions, stateKeys, settingsFields, statOptions: STAT_OPTIONS };
}

module.exports = { makeKit };
