// Local HTTP + WebSocket server. The UI is a normal web page served from here, so
// it works in the desktop window, in any browser, and inside VR overlay browsers.
//
// Because any website can try to reach localhost, every connection must pass:
//   1. Host header is 127.0.0.1/localhost on our port   (blocks DNS rebinding)
//   2. Origin header, if present, is us                  (blocks cross-site WebSockets)
//   3. A secret token in the query string                (blocks everything else)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { catalogForUi, defs } = require('./actions');
const { stripSecrets } = require('./store');
const appConfig = require('./app-config');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function createServer({ engine, providers, helper, store, hooks, token, uiDir, sharedDir, version, devMode }) {
  let port = 0;
  const clients = new Set();

  const allowedHosts = () => [`127.0.0.1:${port}`, `localhost:${port}`];
  const allowedOrigins = () => [`http://127.0.0.1:${port}`, `http://localhost:${port}`];

  function serveFile(res, root, rel) {
    const target = path.normalize(path.join(root, rel));
    if (!target.startsWith(root + path.sep) && target !== root) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(target, (err, data) => {
      if (err) {
        res.writeHead(404).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(target)] || 'application/octet-stream',
        'Cache-Control': rel.startsWith('assets/') ? 'max-age=3600' : 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}; frame-ancestors 'none'`,
      });
      res.end(data);
    });
  }

  const httpServer = http.createServer((req, res) => {
    if (!allowedHosts().includes(req.headers.host)) {
      res.writeHead(403).end('Bad host');
      return;
    }
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405).end('Method not allowed');
      return;
    }
    if (url.pathname.startsWith('/shared/')) return serveFile(res, sharedDir, url.pathname.slice('/shared/'.length));
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    return serveFile(res, uiDir, rel);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const originOk = !req.headers.origin || allowedOrigins().includes(req.headers.origin);
    const ok = url.pathname === '/ws' && allowedHosts().includes(req.headers.host) && originOk && safeEqual(url.searchParams.get('token') || '', token);
    if (!ok) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  function send(ws, obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function broadcast(obj) {
    const data = JSON.stringify(obj);
    for (const ws of clients) if (ws.readyState === 1) ws.send(data);
  }

  const status = () => ({ ...providers.status(), editLocked: !engine.editing });

  function snapshot() {
    return {
      t: 'init',
      config: engine.config,
      catalog: catalogForUi(),
      buttonStates: engine.computeButtonStates(),
      widgetData: engine.computeWidgetData(),
      activePage: engine.activePageId,
      edit: engine.editState(),
      status: status(),
      log: engine.log,
      app: { version, about: { author: appConfig.author, website: appConfig.website, github: appConfig.githubUrl }, devMode: Boolean(devMode), platform: process.platform, hasHost: Boolean(hooks.isDesktop), twitchBuiltIn: Boolean(providers.twitch && providers.twitch.defaultClientId) },
    };
  }

  function requireEditing() {
    if (!engine.editing) throw new Error('Editing is locked. Unlock it first.');
    engine.touchEdit();
  }

  // Each handler returns the value sent back as the reply result.
  const handlers = {
    async press(msg) {
      engine.press(String(msg.id), { source: 'ui' });
      return true;
    },
    async 'page.set'(msg) {
      engine.setActivePage(String(msg.id));
      return true;
    },
    async 'edit.set'(msg) {
      if (msg.on) {
        if (engine.config.settings.lock.unlockMethod === 'hotkey') {
          throw new Error(`Unlock is set to hotkey only. Press ${engine.config.settings.lock.unlockHotkey} or use the tray icon.`);
        }
        engine.setEditing(true);
      } else engine.setEditing(false);
      return engine.editState();
    },
    async 'edit.touch'() {
      engine.touchEdit();
      return true;
    },
    async 'config.set'(msg) {
      requireEditing();
      return { warnings: engine.updateConfig(msg.config) };
    },
    async options(msg) {
      return providers.options(String(msg.kind));
    },
    async test(msg) {
      requireEditing();
      const steps = Array.isArray(msg.steps) ? msg.steps : [];
      await engine.runSteps(steps.map((s) => ({ action: String(s.action), params: s.params || {}, delayMs: Number(s.delayMs) || 0 })));
      return true;
    },
    async window(msg) {
      hooks.setFocusable(Boolean(msg.focusable));
      return true;
    },
    // Custom title-bar buttons of the borderless window.
    async 'window.control'(msg) {
      if (!['minimize', 'maximize', 'close'].includes(msg.cmd)) throw new Error('Unknown window command');
      hooks.windowControl(msg.cmd);
      return true;
    },
    // "Buttons only" view: hides everything but the pages and buttons (and makes the window see-through).
    // A view preference, not a layout edit, so it is allowed while editing is locked.
    async 'view.clean'(msg) {
      engine.patchSettings((s) => { s.window.cleanView = Boolean(msg.on); });
      return true;
    },
    // Resizing the see-through window: it has no native edges, so the page drags them itself.
    async 'window.bounds'(msg) {
      const n = (v) => Math.round(Number(v));
      if (![msg.x, msg.y, msg.width, msg.height].every((v) => Number.isFinite(Number(v)))) throw new Error('Bad window size');
      hooks.setWindowBounds({ x: n(msg.x), y: n(msg.y), width: n(msg.width), height: n(msg.height) });
      return true;
    },
    // Widgets: tap / hold / media commands. Not gated by the edit lock: using a widget is using the deck.
    async widget(msg) {
      const res = await engine.widgetCommand(String(msg.id), String(msg.cmd), msg.arg);
      return res;
    },
    async 'media.thumb'(msg) {
      return providers.thumb(String(msg.key));
    },
    // ---- Pear Desktop / YouTube Music: approve this app once inside Pear ----
    async 'pear.connect'() {
      requireEditing();
      providers.pear.authorize(); // waits for you to click Allow in Pear; progress arrives as status updates
      return true;
    },
    async 'pear.disconnect'() {
      requireEditing();
      providers.pear.disconnect();
      return true;
    },
    // ---- Twitch account link (changes what the app can do, so it needs the edit lock open) ----
    async 'twitch.connect'() {
      requireEditing();
      return providers.twitch.startDeviceFlow();
    },
    async 'twitch.disconnect'() {
      requireEditing();
      await providers.twitch.disconnect();
      return true;
    },
    async 'twitch.check'() {
      requireEditing();
      return providers.twitch.validate();
    },
    // ---- Spotify account link (only used for "Like") ----
    async 'spotify.connect'() {
      requireEditing();
      return providers.spotify.startAuth();
    },
    async 'spotify.disconnect'() {
      requireEditing();
      await providers.spotify.disconnect();
      return true;
    },
    // Only ever opens Twitch's or Spotify's own sign-in page, or the author's own links from the About tab.
    async 'open.external'(msg) {
      let u;
      try { u = new URL(String(msg.url)); } catch { throw new Error('That is not a link'); }
      const own = [appConfig.website, appConfig.githubUrl].filter(Boolean).map((l) => new URL(l));
      const ownLink = own.some((o) => o.hostname === u.hostname && u.pathname.startsWith(o.pathname === '/' ? '/' : o.pathname));
      if (u.protocol !== 'https:' || !(['www.twitch.tv', 'twitch.tv', 'accounts.spotify.com'].includes(u.hostname) || ownLink)) throw new Error('Only twitch.tv, Spotify sign-in and the app\'s own links can be opened from here');
      return hooks.openExternal(u.toString());
    },
    async 'config.export'() {
      return stripSecrets(engine.config, defs);
    },
    async 'config.import'(msg) {
      requireEditing();
      return { warnings: engine.updateConfig(msg.config) };
    },
    async 'backups.list'() {
      return store.listBackups();
    },
    async 'backups.restore'(msg) {
      requireEditing();
      const { config } = store.readBackup(String(msg.name));
      return { warnings: engine.updateConfig(config) };
    },
    async 'status.get'() {
      return status();
    },
  };

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    send(ws, snapshot());
    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const handler = handlers[msg.t];
      if (!handler) {
        send(ws, { t: 'res', rid: msg.rid, ok: false, error: `Unknown message "${msg.t}"` });
        return;
      }
      try {
        const result = await handler(msg);
        if (msg.rid !== undefined) send(ws, { t: 'res', rid: msg.rid, ok: true, result });
      } catch (err) {
        if (msg.rid !== undefined) send(ws, { t: 'res', rid: msg.rid, ok: false, error: err.message });
      }
    });
  });

  engine.on('buttonStates', (states) => broadcast({ t: 'buttonStates', states }));
  engine.on('widgetData', (data) => broadcast({ t: 'widgetData', data }));
  engine.on('config', (config) => broadcast({ t: 'config', config }));
  engine.on('page', (id) => broadcast({ t: 'page', id }));
  engine.on('edit', (edit) => broadcast({ t: 'edit', edit }));
  engine.on('toast', (entry) => broadcast({ t: 'toast', entry }));
  engine.on('running', (r) => broadcast({ t: 'running', ...r }));
  engine.on('pressResult', (r) => broadcast({ t: 'pressResult', ...r }));
  providers.on('status', () => broadcast({ t: 'status', status: status() }));
  helper.on('status', () => broadcast({ t: 'status', status: status() }));
  const statusTimer = setInterval(() => { if (clients.size) broadcast({ t: 'status', status: status() }); }, 5000);

  function listen(preferredPort) {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const tryPort = (p) => {
        port = p;
        httpServer.once('error', (err) => {
          if (err.code === 'EADDRINUSE' && attempts++ < 20) tryPort(p + 1);
          else reject(err);
        });
        httpServer.listen(p, '127.0.0.1', () => {
          httpServer.removeAllListeners('error');
          port = httpServer.address().port; // differs from p when p is 0 (tests)
          resolve(port);
        });
      };
      tryPort(preferredPort);
    });
  }

  function close() {
    clearInterval(statusTimer);
    for (const ws of clients) ws.terminate();
    wss.close();
    httpServer.close();
  }

  return { listen, close, getPort: () => port, clientCount: () => clients.size };
}

module.exports = { createServer };
