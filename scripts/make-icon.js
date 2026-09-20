// Writes build/icon.png (the same four-buttons icon the tray and window use) for the exe build.
const fs = require('fs');
const path = require('path');
const { makeIconPng } = require('../src/main/icon');

const out = path.join(__dirname, '..', 'build');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.png'), makeIconPng(512));
console.log('Wrote build/icon.png');
