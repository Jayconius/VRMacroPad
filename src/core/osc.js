// Minimal OSC 1.0 encoder/decoder plus UDP helpers, enough for VRChat.
const dgram = require('dgram');
const { EventEmitter } = require('events');

function pad4(buf) {
  const extra = (4 - (buf.length % 4)) % 4;
  return extra ? Buffer.concat([buf, Buffer.alloc(extra)]) : buf;
}

function oscString(s) {
  return pad4(Buffer.concat([Buffer.from(String(s), 'utf8'), Buffer.from([0])]));
}

// arg: boolean | number | string | { type: 'i'|'f'|'s'|'T'|'F', value }
function normalizeArg(arg) {
  if (arg && typeof arg === 'object') return arg;
  if (typeof arg === 'boolean') return { type: arg ? 'T' : 'F', value: arg };
  if (typeof arg === 'number') return { type: Number.isInteger(arg) ? 'i' : 'f', value: arg };
  return { type: 's', value: String(arg) };
}

function encode(address, args = []) {
  if (typeof address !== 'string' || !address.startsWith('/')) throw new Error('OSC address must start with "/"');
  const list = args.map(normalizeArg);
  const tags = ',' + list.map((a) => a.type).join('');
  const parts = [oscString(address), oscString(tags)];
  for (const a of list) {
    if (a.type === 'i') {
      const b = Buffer.alloc(4);
      b.writeInt32BE(Math.trunc(a.value));
      parts.push(b);
    } else if (a.type === 'f') {
      const b = Buffer.alloc(4);
      b.writeFloatBE(Number(a.value));
      parts.push(b);
    } else if (a.type === 's') {
      parts.push(oscString(a.value));
    } else if (a.type !== 'T' && a.type !== 'F') {
      throw new Error(`Unsupported OSC type "${a.type}"`);
    }
  }
  return Buffer.concat(parts);
}

function readString(buf, offset) {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  const value = buf.toString('utf8', offset, end);
  return { value, next: offset + Math.ceil((end - offset + 1) / 4) * 4 };
}

function decodeMessage(buf) {
  const addr = readString(buf, 0);
  if (addr.next >= buf.length) return { address: addr.value, args: [] };
  const tags = readString(buf, addr.next);
  let offset = tags.next;
  const args = [];
  for (const t of tags.value.slice(1)) {
    if (t === 'i') { args.push(buf.readInt32BE(offset)); offset += 4; }
    else if (t === 'f') { args.push(buf.readFloatBE(offset)); offset += 4; }
    else if (t === 'd') { args.push(buf.readDoubleBE(offset)); offset += 8; }
    else if (t === 'h') { args.push(Number(buf.readBigInt64BE(offset))); offset += 8; }
    else if (t === 's') { const s = readString(buf, offset); args.push(s.value); offset = s.next; }
    else if (t === 'T') args.push(true);
    else if (t === 'F') args.push(false);
    else if (t === 'N') args.push(null);
    else throw new Error(`Unsupported OSC type tag "${t}"`);
  }
  return { address: addr.value, args };
}

// Returns a flat list of messages; bundles are unpacked recursively.
function decode(buf) {
  if (buf.toString('utf8', 0, 8) === '#bundle\0') {
    const out = [];
    let offset = 16; // "#bundle\0" + 8-byte timetag
    while (offset + 4 <= buf.length) {
      const size = buf.readInt32BE(offset);
      offset += 4;
      out.push(...decode(buf.subarray(offset, offset + size)));
      offset += size;
    }
    return out;
  }
  return [decodeMessage(buf)];
}

class OscSender {
  constructor() {
    this.socket = dgram.createSocket('udp4');
    this.socket.on('error', () => {});
  }

  send(host, port, address, args) {
    const data = encode(address, args);
    return new Promise((resolve, reject) => {
      this.socket.send(data, port, host, (err) => (err ? reject(err) : resolve()));
    });
  }

  close() {
    try { this.socket.close(); } catch { /* already closed */ }
  }
}

// Emits 'message' ({address,args}), 'listening' and 'error'.
class OscListener extends EventEmitter {
  constructor(port, host = '127.0.0.1') {
    super();
    this.port = port;
    this.host = host;
    this.socket = null;
  }

  start() {
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('message', (buf) => {
      try {
        for (const m of decode(buf)) this.emit('message', m);
      } catch { /* ignore malformed packets */ }
    });
    this.socket.on('error', (err) => this.emit('error', err));
    this.socket.on('listening', () => this.emit('listening'));
    this.socket.bind(this.port, this.host);
  }

  stop() {
    if (!this.socket) return;
    try { this.socket.close(); } catch { /* already closed */ }
    this.socket = null;
  }
}

module.exports = { encode, decode, OscSender, OscListener };
