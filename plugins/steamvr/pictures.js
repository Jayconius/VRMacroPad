// Device names and pictures for the SteamVR battery widget. Moved unchanged from the old src/core/widgets.js
// (the only thing that ever used them).
// "serial=Name" per line -> { serial: Name }
function parseNames(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

const CLASS_ORDER = { hmd: 0, controller: 1, tracker: 2, basestation: 3, other: 4 };

// Names for a whole list of devices. Trackers are numbered by serial so the numbers stay put when one
// drops out or the order SteamVR reports them in changes.
function nameDevices(devices, names) {
  const trackers = devices.filter((d) => d.class === 'tracker' && !names[(d.serial || '').toLowerCase()]).map((d) => d.serial).sort();
  const out = new Map();
  for (const d of devices) {
    const custom = names[(d.serial || '').toLowerCase()];
    let name = custom;
    if (!name) {
      if (d.class === 'hmd') name = 'Headset';
      else if (d.class === 'controller') name = d.role === 'left' ? 'Left controller' : d.role === 'right' ? 'Right controller' : 'Controller';
      else if (d.class === 'tracker') name = `Tracker ${trackers.indexOf(d.serial) + 1}`;
      else if (d.class === 'basestation') name = 'Base station';
      else name = d.model || 'Device';
    }
    out.set(d, name);
  }
  return out;
}

// The illustrated pack in src/ui/assets/devices: HMD-0..5, Controller-0..3 (+L/R), Tracker-0..2,
// Lighthouse-1.0/2.0. The UI adds "L" for the low-battery version and "DC" to a base station that is off.
const PICTURE_PREFIX = { hmd: 'HMD', controller: 'Controller', tracker: 'Tracker', basestation: 'Lighthouse' };
const PICTURE_STYLES = { hmd: ['0', '1', '2', '3', '4', '5'], controller: ['0', '1', '2', '3'], tracker: ['0', '1', '2'], basestation: ['1.0', '2.0'] };

function pictureFor(d, override) {
  const prefix = PICTURE_PREFIX[d.class];
  if (!prefix) return '';
  const styles = PICTURE_STYLES[d.class];
  let style = '';
  const m = /^([a-z]+)-(\d(?:\.0)?)$/i.exec(String(override || '').trim());
  if (m && m[1].toLowerCase() === prefix.toLowerCase() && styles.includes(m[2])) style = m[2];
  const text = `${d.model || ''} ${d.manufacturer || ''} ${d.type || ''}`;
  if (!style) {
    if (d.class === 'hmd') style = /cv1|rift(?! ?s(?![a-z]))/i.test(text) ? '0' : /quest ?2/i.test(text) ? '5' : /quest ?3s/i.test(text) ? '4' : /quest ?3/i.test(text) ? '3' : '1';
    else if (d.class === 'controller') style = /knuckles|index/i.test(text) ? '1' : /cosmos/i.test(text) ? '3' : /touch.?pro|quest pro/i.test(text) ? '2' : '0';
    else if (d.class === 'tracker') style = /tundra/i.test(text) ? '1' : '2';
    else style = '2.0';
  }
  return `${prefix}-${style}${d.class === 'controller' ? (d.role === 'right' ? 'R' : 'L') : ''}`;
}

module.exports = { parseNames, CLASS_ORDER, nameDevices, PICTURE_PREFIX, PICTURE_STYLES, pictureFor };
