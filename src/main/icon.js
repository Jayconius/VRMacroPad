// Draws the app icon (four colored buttons on a dark tile) as a PNG at runtime,
// so the repo needs no binary assets.
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function roundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r - 1);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r - 1);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function makeIconPng(size = 256) {
  const px = Buffer.alloc(size * size * 4);
  const pad = size * 0.1;
  const gap = size * 0.06;
  const cell = (size - pad * 2 - gap) / 2;
  const tiles = [
    [pad, pad, '#2f855a'], [pad + cell + gap, pad, '#4c8dff'],
    [pad, pad + cell + gap, '#b7791f'], [pad + cell + gap, pad + cell + gap, '#6b46c1'],
  ].map(([x, y, hex]) => ({ x, y, rgb: [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) }));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      let rgb = null;
      if (roundedRect(x, y, 0, 0, size, size, size * 0.2)) rgb = [24, 29, 41];
      for (const t of tiles) if (roundedRect(x, y, t.x, t.y, t.x + cell, t.y + cell, size * 0.09)) rgb = t.rgb;
      if (rgb) { px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2]; px[o + 3] = 255; }
    }
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { makeIconPng };
