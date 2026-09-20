// Older builds were called "VR Macro Deck" and kept their data in %APPDATA%\VR Macro Deck. The first time the
// renamed app starts with no data of its own, it copies your layout, logins and backups across (a copy, so an
// old build keeps working too). Never overwrites anything that is already there.
const fs = require('fs');
const path = require('path');

const FILES = ['config.json', 'secrets.json', 'auth.json', 'runtime.json'];

// Returns what was copied (empty when there was nothing to do).
function migrateOldData(oldDir, newDir) {
  const copied = [];
  try {
    if (!oldDir || !fs.existsSync(path.join(oldDir, 'config.json'))) return copied;
    if (fs.existsSync(path.join(newDir, 'config.json'))) return copied;
    fs.mkdirSync(newDir, { recursive: true });
    for (const name of FILES) {
      const from = path.join(oldDir, name);
      const to = path.join(newDir, name);
      if (fs.existsSync(from) && !fs.existsSync(to)) { fs.copyFileSync(from, to); copied.push(name); }
    }
    const backups = path.join(oldDir, 'backups');
    if (fs.existsSync(backups) && !fs.existsSync(path.join(newDir, 'backups'))) {
      fs.cpSync(backups, path.join(newDir, 'backups'), { recursive: true });
      copied.push('backups/');
    }
  } catch { /* a failed copy just means starting fresh */ }
  return copied;
}

module.exports = { migrateOldData };
