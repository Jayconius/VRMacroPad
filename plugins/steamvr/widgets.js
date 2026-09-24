// Battery widget, moved unchanged from the old src/core/widgets.js. Device-picture helpers moved to ./pictures.js.
const { nameDevices, pictureFor, parseNames, CLASS_ORDER } = require('./pictures');

module.exports = [
{
    id: 'battery',
    category: 'SteamVR',
    label: 'SteamVR battery',
    description: 'Battery level of your headset, controllers and trackers (whatever SteamVR reports), as a list or with pictures.',
    icon: '🔋',
    size: { w: 3, h: 2 },
    params: [
      { key: 'layout', label: 'Layout', type: 'select', default: 'list', options: [['list', 'List with battery bars'], ['pictures', 'Pictures (illustrated devices)']] },
      { key: 'show', label: 'Show', type: 'multiselect', default: ['hmd', 'controller', 'tracker'], options: [['hmd', 'Headset'], ['controller', 'Controllers'], ['tracker', 'Trackers'], ['basestation', 'Base stations']] },
      { key: 'showDropped', label: 'Also show devices that are off or dropped out (with their last level)', type: 'boolean', default: true },
      { key: 'lowPercent', label: 'Warn below (%)', type: 'number', min: 1, max: 90, default: 20 },
      { key: 'names', label: 'Nicknames (one per line: serial=Name)', type: 'textarea', placeholder: 'LHR-1A2B3C4D=Left foot', help: 'Trackers only have serial numbers. Turn one on and check the list to find it.' },
      { key: 'pictures', label: 'Pictures (one per line: serial=Style)', type: 'textarea', placeholder: 'LHR-1A2B3C4D=Tracker-1', help: 'Only for the Pictures layout. Styles: HMD-0 to HMD-5, Controller-0 to Controller-3, Tracker-0 to Tracker-2, Lighthouse-1.0, Lighthouse-2.0. Left blank, a picture is chosen from the device model.', showIf: { key: 'layout', in: ['pictures'] } },
    ],
    defaults: { color: '#1f4a4a' },
    needs: () => ({ vr: true }),
    initState: () => ({}),
    data(ctx, button) {
      const vr = ctx.plugin('steamvr');
      const snap = vr ? vr.snapshot() : { connected: false, error: '', devices: [] };
      const p = button.widget.params;
      const show = new Set(Array.isArray(p.show) ? p.show : ['hmd', 'controller', 'tracker']);
      const names = parseNames(p.names);
      const pictures = parseNames(p.pictures);
      const live = (snap.devices || []).map((d) => ({ ...d, connected: true }));
      const gone = p.showDropped === false || !snap.connected ? [] : (snap.dropped || []).map((d) => ({ ...d, connected: false, trackingOk: null, worn: null }));
      const all = [...live, ...gone];
      const shown = all.filter((d) => show.has(d.class));
      const label = nameDevices(all, names);
      const order = (d) => [CLASS_ORDER[d.class] === undefined ? 9 : CLASS_ORDER[d.class], d.role === 'left' ? 0 : d.role === 'right' ? 1 : 2, d.serial || ''];
      shown.sort((a, b) => { const x = order(a); const y = order(b); return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0); });
      const devices = shown.map((d) => ({
        name: label.get(d), class: d.class, role: d.role, serial: d.serial, connected: d.connected,
        hasBattery: d.hasBattery, battery: d.battery, charging: d.charging, trackingOk: d.trackingOk, worn: d.worn,
        picture: pictureFor(d, pictures[(d.serial || '').toLowerCase()]),
      }));
      return { connected: snap.connected, error: snap.error || '', simulated: Boolean(snap.simulated), layout: p.layout === 'pictures' ? 'pictures' : 'list', devices, lowPercent: Number(p.lowPercent) || 20 };
    },
    command: async () => {},
  }
];
