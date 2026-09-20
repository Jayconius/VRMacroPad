// Turns "ctrl+shift+F13" style strings into Windows virtual-key codes.
const MODS = { ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b, meta: 0x5b, super: 0x5b, cmd: 0x5b };

const NAMED = {
  backspace: 0x08, tab: 0x09, enter: 0x0d, return: 0x0d, pause: 0x13, capslock: 0x14,
  esc: 0x1b, escape: 0x1b, space: 0x20, pageup: 0x21, pagedown: 0x22, end: 0x23, home: 0x24,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28, printscreen: 0x2c, insert: 0x2d, delete: 0x2e, del: 0x2e,
  apps: 0x5d, menu: 0x5d, numlock: 0x90, scrolllock: 0x91,
  numadd: 0x6b, numsub: 0x6d, nummul: 0x6a, numdiv: 0x6f, numdec: 0x6e,
  semicolon: 0xba, equals: 0xbb, plus: 0xbb, comma: 0xbc, minus: 0xbd, period: 0xbe, slash: 0xbf,
  backtick: 0xc0, lbracket: 0xdb, backslash: 0xdc, rbracket: 0xdd, quote: 0xde,
  ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf, '`': 0xc0, '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde,
};

// Keys reachable by a single name from the media-key action.
const MEDIA = {
  playpause: 0xb3, next: 0xb0, previous: 0xb1, stop: 0xb2,
  volumeup: 0xaf, volumedown: 0xae, volumemute: 0xad,
};

function keyCode(name) {
  const n = name.trim().toLowerCase();
  if (!n) throw new Error('Empty key name');
  if (MODS[n]) return MODS[n];
  if (NAMED[n] !== undefined) return NAMED[n];
  if (/^[a-z]$/.test(n)) return n.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(n)) return n.charCodeAt(0);
  let m = /^f([1-9]|1\d|2[0-4])$/.exec(n);
  if (m) return 0x70 + Number(m[1]) - 1;
  m = /^num([0-9])$/.exec(n);
  if (m) return 0x60 + Number(m[1]);
  throw new Error(`Unknown key "${name}"`);
}

// "ctrl+shift+m" -> { names: [...], vks: [0x11, 0x10, 0x4d] }. Order is kept so
// modifiers written first are pressed first and released last.
function parseCombo(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('No keys given');
  // A trailing "+" means the plus key itself ("ctrl++").
  const parts = text.trim().replace(/\+\+$/, '+plus').split('+');
  const vks = parts.map(keyCode);
  return { names: parts.map((p) => p.trim().toLowerCase()), vks };
}

module.exports = { parseCombo, keyCode, MEDIA };
