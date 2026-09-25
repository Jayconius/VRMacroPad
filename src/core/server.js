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
const overlayLogic = require('./overlay-logic');

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

function createServer({ engine, providers, helper, store, images, hooks, token, uiDir, sharedDir, version, devMode, registry, updater }) {
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
        'Content-Security-Policy': `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}; frame-ancestors 'self'`,
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
    // Button pictures: private to the app, so they need the secret token like the websocket does.
    if (url.pathname.startsWith('/user-images/')) {
      let wanted = '';
      try { wanted = decodeURIComponent(url.pathname.slice('/user-images/'.length)); } catch { /* a broken address: not found */ }
      const img = images && safeEqual(url.searchParams.get('token') || '', token) ? images.read(wanted) : null;
      if (!img) { res.writeHead(404).end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': img.type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
      res.end(img.data);
      return;
    }
    if (url.pathname.startsWith('/shared/')) return serveFile(res, sharedDir, url.pathname.slice('/shared/'.length));
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    return serveFile(res, uiDir, rel);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 14 * 1024 * 1024 }); // room for an 8 MB picture sent as base64

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

  const status = () => ({ ...providers.status(), editLocked: !engine.editing, overlay: hooks.overlayInfo ? hooks.overlayInfo() : { state: 'unavailable' } });

  function snapshot() {
    return {
      t: 'init',
      config: engine.config,
      catalog: catalogForUi((id) => providers.status().plugins[id]),
      buttonStates: engine.computeButtonStates(),
      widgetData: engine.computeWidgetData(),
      activePage: engine.activePageId,
      edit: engine.editState(),
      status: status(),
      update: updater ? updater.info : null,
      log: engine.log,
      overlay: overlayLogic.pictureSize(engine.config.settings.overlay.resolution),
      // Whether a plugin ships with a bundled key/app-id (Twitch does) is generic: any plugin's own
      // status().hasBuiltIn says so — nothing here needs to know which plugin that happens to be.
      app: { version, overlayDefaults: overlayLogic.DEFAULT_OFFSETS, about: { author: appConfig.author, website: appConfig.website, github: appConfig.githubUrl }, devMode: Boolean(devMode), platform: process.platform, hasHost: Boolean(hooks.isDesktop) },
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
      const warnings = engine.updateConfig(msg.config);
      if (images) images.gc(engine.config);
      return { warnings };
    },
    // A picture for a button (sent as base64). Returns the name to put in the button.
    async 'image.add'(msg) {
      requireEditing();
      if (!images) throw new Error('Pictures are not available here');
      if (typeof msg.data !== 'string' || msg.data.length > 12 * 1024 * 1024) throw new Error('That picture is too big');
      return images.add(Buffer.from(msg.data, 'base64'));
    },
    async options(msg) {
      // Values of the fields a list depends on: a few short strings, nothing else gets through.
      const args = {};
      if (msg.args && typeof msg.args === 'object' && !Array.isArray(msg.args)) {
        for (const [k, v] of Object.entries(msg.args).slice(0, 8)) if (typeof v === 'string' || typeof v === 'number') args[String(k).slice(0, 40)] = String(v).slice(0, 200);
      }
      return providers.options(String(msg.kind), args);
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
    // ---- SteamVR overlay controls: where it is, how big, pinned, collapsed. View preferences, not layout edits. ----
    async 'overlay.anchor'(msg) {
      if (!overlayLogic.ANCHORS.includes(msg.anchor)) throw new Error('Unknown anchor');
      engine.patchSettings((s) => { s.overlay.anchor = msg.anchor; if (overlayLogic.HANDS.includes(msg.hand)) s.overlay.hand = msg.hand; });
      return true;
    },
    // dir: +1 / -1 steps through the preset sizes; width: an exact size in meters.
    async 'overlay.size'(msg) {
      engine.patchSettings((s) => {
        const o = s.overlay;
        if (msg.reset) { o.widths[o.anchor] = overlayLogic.DEFAULT_WIDTHS[o.anchor]; return; }
        o.widths[o.anchor] = msg.width !== undefined ? overlayLogic.clampWidth(msg.width) : overlayLogic.stepWidth(o.widths[o.anchor], Number(msg.dir) >= 0 ? 1 : -1);
      });
      return true;
    },
    async 'overlay.toggle'(msg) {
      if (!['locked', 'collapsed', 'hidden', 'showBar', 'glance', 'enabled'].includes(msg.key)) throw new Error('Unknown switch');
      engine.patchSettings((s) => { s.overlay[msg.key] = msg.on === undefined ? !s.overlay[msg.key] : Boolean(msg.on); });
      return true;
    },
    // Things that need the desktop shell (it talks to SteamVR): grab / drop the panel, bring it back to you.
    async 'overlay.grab'(msg) {
      return hooks.overlayCommand(msg.on ? 'grab' : 'drop');
    },
    // Turn / tilt / flip the panel on the wrist, swap wrists, or reset its wrist position.
    async 'overlay.adjust'(msg) {
      if (!['roll', 'pitch', 'yaw', 'flip', 'reset', 'hand'].includes(msg.kind)) throw new Error('Unknown adjustment');
      return hooks.overlayCommand('adjust', { kind: msg.kind, amount: Number(msg.amount) || 0 });
    },
    // level: 0-90 percent; dir: +1 / -1 steps of 10 percent.
    async 'overlay.dim'(msg) {
      engine.patchSettings((s) => {
        const o = s.overlay;
        const now = Math.round(o.dim * 100);
        const next = msg.level !== undefined ? Number(msg.level) : now + (Number(msg.dir) >= 0 ? 10 : -10);
        o.dim = Math.max(0, Math.min(90, Math.round(next))) / 100;
      });
      return true;
    },
    // "I lost it": visible, not shrunk, the standard size for every anchor, and back within reach.
    async 'overlay.reset'() {
      engine.patchSettings((s) => {
        const o = s.overlay;
        o.hidden = false;
        o.collapsed = false;
        o.widths = { ...overlayLogic.DEFAULT_WIDTHS };
      });
      return hooks.overlayCommand('bring');
    },
    // The editor inside SteamVR's dashboard asks for SteamVR's on-screen keyboard when a text box gets focus.
    async 'dash.keyboard'(msg) {
      return hooks.overlayCommand('keyboard', { text: String(msg.text || '').slice(0, 4000), multiline: Boolean(msg.multiline), password: Boolean(msg.password), desc: String(msg.desc || '').slice(0, 200) });
    },
    async 'dash.keyboard.hide'() {
      return hooks.overlayCommand('keyboard.hide');
    },
    async 'overlay.bring'() {
      return hooks.overlayCommand('bring');
    },
    // Widgets: tap / hold / media commands. Not gated by the edit lock: using a widget is using the deck.
    async widget(msg) {
      const res = await engine.widgetCommand(String(msg.id), String(msg.cmd), msg.arg);
      return res;
    },
    async 'media.thumb'(msg) {
      return providers.thumb(String(msg.key));
    },
    // A plugin's own "Connect", "Disconnect", "Check permissions" and the like. Only method names the
    // plugin itself lists in clientMethods can be called this way (see plugin.js / docs/PLUGIN-GUIDE.md),
    // so a plugin controls exactly what the browser may trigger, nothing more.
    async 'plugin.call'(msg) {
      requireEditing();
      const manifest = registry.get(String(msg.plugin || ''));
      if (!manifest) throw new Error('Unknown plugin');
      const method = String(msg.method || '');
      if (!(manifest.clientMethods || []).includes(method)) throw new Error(`"${method}" cannot be called from the browser`);
      const rt = providers.get(manifest.id);
      if (!rt || typeof rt[method] !== 'function') throw new Error('That plugin is not available right now');
      const args = Array.isArray(msg.args) ? msg.args.slice(0, 4) : [];
      return rt[method](...args);
    },
    // Only ever opens a plugin's own sign-in page (each plugin lists the domains it needs), or the author's
    // own links from the About tab.
    async 'open.external'(msg) {
      let u;
      try { u = new URL(String(msg.url)); } catch { throw new Error('That is not a link'); }
      const own = [appConfig.website, appConfig.githubUrl].filter(Boolean).map((l) => new URL(l));
      const ownLink = own.some((o) => o.hostname === u.hostname && u.pathname.startsWith(o.pathname === '/' ? '/' : o.pathname));
      const pluginHosts = new Set();
      for (const m of registry.list()) for (const h of m.externalDomains || []) pluginHosts.add(h);
      if (u.protocol !== 'https:' || !(pluginHosts.has(u.hostname) || ownLink)) throw new Error('Only a plugin\'s sign-in page and the app\'s own links can be opened from here');
      return hooks.openExternal(u.toString());
    },
    async 'config.export'() {
      return stripSecrets(engine.config, defs, registry);
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
    // ---- updates (Settings → General turns the automatic check on; "Check now" always works) ----
    async 'update.check'() {
      return updater.check({ manual: true });
    },
    async 'update.download'() {
      updater.download().catch(() => {}); // progress arrives as 'update' messages
      return updater.info;
    },
    async 'update.skip'() {
      return updater.skip();
    },
    async 'update.install'() {
      if (!hooks.isDesktop) throw new Error('Only the desktop app can install an update');
      return updater.install();
    },
    async 'update.reveal'() {
      if (!hooks.isDesktop) throw new Error('Only the desktop app can show files');
      return updater.reveal();
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
  if (updater) updater.on('update', (info) => broadcast({ t: 'update', update: info }));
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
