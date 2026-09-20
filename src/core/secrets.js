// Small key/value store for credentials (Twitch tokens), kept out of config.json so
// exporting or sharing a layout never leaks them. When the host provides encryption
// (Electron's safeStorage = Windows DPAPI, tied to your Windows account) values are encrypted.
const fs = require('fs');
const path = require('path');

class SecretStore {
  // box: optional { available(): bool, encrypt(text) -> base64, decrypt(base64) -> text }
  constructor(dir, box = null) {
    this.file = path.join(dir, 'secrets.json');
    this.box = box && box.available() ? box : null;
    this.data = {};
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch { /* first run */ }
  }

  get(key) {
    const raw = this.data[key];
    if (typeof raw !== 'string') return null;
    try {
      if (raw.startsWith('enc:')) return this.box ? this.box.decrypt(raw.slice(4)) : null;
      if (raw.startsWith('plain:')) return raw.slice(6);
    } catch { /* unreadable (e.g. different Windows account) */ }
    return null;
  }

  set(key, value) {
    this.data[key] = this.box ? `enc:${this.box.encrypt(String(value))}` : `plain:${value}`;
    this.persist();
  }

  delete(key) {
    if (key in this.data) {
      delete this.data[key];
      this.persist();
    }
  }

  isEncrypted() {
    return Boolean(this.box);
  }

  persist() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { SecretStore };
