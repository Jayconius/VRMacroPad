// Pictures for buttons (PNG, JPEG, GIF, WebP). They live in the data folder, are named by a hash of what they contain, and are only
// handed out to a page that knows the secret token. SVG is refused on purpose (it can carry scripts).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 8 * 1024 * 1024;
const NAME = /^img-[0-9a-f]{24}\.(png|jpg|gif|webp)$/;
const MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

// The real type is read from the first bytes, never from the file name the browser reported.
function sniff(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return '';
}

class ImageStore {
  constructor(dir) {
    this.dir = path.join(dir, 'images');
  }

  isName(name) {
    return typeof name === 'string' && NAME.test(name);
  }

  // Saves a picture and returns its name. The same picture twice is stored once.
  add(buf) {
    if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('That picture is empty');
    if (buf.length > MAX_BYTES) throw new Error(`That picture is too big (${Math.round(buf.length / 1048576)} MB). The limit is ${MAX_BYTES / 1048576} MB.`);
    const ext = sniff(buf);
    if (!ext) throw new Error('Only PNG, JPEG, GIF and WebP pictures can be used');
    const name = `img-${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24)}.${ext}`;
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
    else fs.utimesSync(file, new Date(), new Date()); // re-adding a picture counts as using it
    return name;
  }

  read(name) {
    if (!this.isName(name)) return null;
    try { return { data: fs.readFileSync(path.join(this.dir, name)), type: MIME[name.split('.').pop()] }; } catch { return null; }
  }

  // Removes pictures no button uses any more, but never one added in the last day (an edit may still be in progress).
  gc(config, minAgeMs = 24 * 3600 * 1000, now = Date.now()) {
    let names;
    try { names = fs.readdirSync(this.dir); } catch { return 0; }
    const used = new Set();
    for (const page of (config && config.pages) || []) for (const b of page.buttons || []) { if (b.image) used.add(b.image); if (b.imageOn) used.add(b.imageOn); }
    let removed = 0;
    for (const n of names) {
      if (!this.isName(n) || used.has(n)) continue;
      const file = path.join(this.dir, n);
      try {
        if (now - fs.statSync(file).mtimeMs < minAgeMs) continue;
        fs.unlinkSync(file);
        removed++;
      } catch { /* in use or already gone */ }
    }
    return removed;
  }
}

module.exports = { ImageStore, sniff, MAX_BYTES, NAME };
