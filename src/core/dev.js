// Runs the core + UI as a plain web server, no Electron. Handy for developing the
// UI in a browser and for automated UI checks. Uses a throwaway data folder.
const path = require('path');
const { createApp } = require('./index');

process.env.VRMD_TOKEN = process.env.VRMD_TOKEN || 'dev-token-dev-token-dev-token-dev-token';
const dataDir = process.env.VRMD_DATA_DIR || path.join(__dirname, '..', '..', '.devdata');
const port = Number(process.env.PORT) || 17420;

const app = createApp({ dataDir, port, devMode: true });
app.start().then(({ url }) => {
  console.log(`VR Macro Pad (dev) running at ${url}`);
  console.log(`Data folder: ${dataDir}`);
});

process.on('SIGINT', () => app.stop().then(() => process.exit(0)));
