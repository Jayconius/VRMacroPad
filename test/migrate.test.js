// Moving your layout and logins across when the app was renamed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { migrateOldData } = require('../src/main/migrate');
const { tempDir } = require('./helpers');

function oldInstall() {
  const dir = tempDir('vrmd-old-');
  fs.writeFileSync(path.join(dir, 'config.json'), '{"old":true}');
  fs.writeFileSync(path.join(dir, 'secrets.json'), '{"twitch.tokens":"enc:xyz"}');
  fs.writeFileSync(path.join(dir, 'auth.json'), '{"token":"t"}');
  fs.mkdirSync(path.join(dir, 'backups'));
  fs.writeFileSync(path.join(dir, 'backups', 'config-1.json'), '{}');
  fs.mkdirSync(path.join(dir, 'electron-profile-cache'));
  fs.writeFileSync(path.join(dir, 'electron-profile-cache', 'junk.bin'), 'x');
  return dir;
}

test('migrate: copies the layout, logins and backups to a fresh folder, and leaves the old one alone', () => {
  const oldDir = oldInstall();
  const newDir = path.join(tempDir('vrmd-new-'), 'VR Macro Pad');
  const copied = migrateOldData(oldDir, newDir);
  assert.deepEqual(copied.sort(), ['auth.json', 'backups/', 'config.json', 'secrets.json']);
  assert.equal(fs.readFileSync(path.join(newDir, 'config.json'), 'utf8'), '{"old":true}');
  assert.equal(fs.readFileSync(path.join(newDir, 'secrets.json'), 'utf8'), '{"twitch.tokens":"enc:xyz"}');
  assert.ok(fs.existsSync(path.join(newDir, 'backups', 'config-1.json')));
  assert.equal(fs.existsSync(path.join(newDir, 'electron-profile-cache')), false, 'browser cache files are not copied');
  assert.ok(fs.existsSync(path.join(oldDir, 'config.json')), 'the old copy still works');
});

test('migrate: never overwrites data the new app already has, and does nothing without old data', () => {
  const oldDir = oldInstall();
  const newDir = tempDir('vrmd-new-');
  fs.writeFileSync(path.join(newDir, 'config.json'), '{"new":true}');
  assert.deepEqual(migrateOldData(oldDir, newDir), []);
  assert.equal(fs.readFileSync(path.join(newDir, 'config.json'), 'utf8'), '{"new":true}');
  assert.equal(fs.existsSync(path.join(newDir, 'secrets.json')), false);
  assert.deepEqual(migrateOldData(path.join(tempDir(), 'nope'), tempDir()), []);
  assert.deepEqual(migrateOldData('', tempDir()), []);
});
