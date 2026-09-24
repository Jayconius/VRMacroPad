// Finds, validates and registers plugins. A plugin is a folder with a plugin.js exporting a manifest:
//
//   module.exports = {
//     id: 'my-plugin', name: 'My Plugin', version: '1.0.0', description: '...', icon: '🔌',
//     actions: [ ... ],          // same shape as an actions/*.js file (id, category, label, params, run(params, ctx)...)
//     widgets: [ ... ],          // same shape as a widgets.js entry (id, label, params, data(), command()...)
//     stateKeys: [ ... ],        // entries for the "follow a state" / "when a state changes" pickers
//     settingsFields: [ ... ],   // same shape as action params, rendered as this plugin's Settings panel
//                                // ("enabled" is reserved: every plugin gets that toggle automatically;
//                                // "autoConnect" is reserved too, auto-added for a plugin with a connect()
//                                // clientMethod — see needsKeys below for how it reaches your sync(needs))
//     connections: [ ... ],      // optional: { id, label, flow: 'device'|'redirect'|'approve'|'status' } for a "Connect" UI
//     needsKeys: ['id'],         // which needs[] keys this plugin's runtime turns on for (defaults to [id])
//     matchState(key) { ... },   // turns a free-typed state/trigger key into a needs-patch, or null
//     clientMethods: [...],      // runtime method names the browser is allowed to call directly (connect, disconnect...)
//     createRuntime(ctx) { ... } // optional: returns { start(), stop(), sync(needs), configure(settings), status() }
//
//     // All optional, and all Settings → Plugins reads generically (no plugin id is ever special-cased there):
//     instructions(status) { ... },  // returns the "how to set this up" paragraph; status is this plugin's status()
//     guide: { title, intro, steps: [{ title, text, links: [{ label, url }], copy: { label, text } }], outro },
//                                    // an "Instructions" button in the Settings card that opens these steps in a dialog
//                                    // (an object, or a function of status()). Links must be https and in externalDomains.
//     statusHints: { 'some-status': 'shown next to the dot while status() is this' },
//     testOptionKind: 'my-plugin.things', // shows "Save and test connection", calling this registered optionList
//     coreFields: [ ... ],       // rare: settingsField-shaped entries bound to a *shared* core setting by dotted
//                                // path (e.g. 'osc.sendPort') instead of this plugin's own settings — only for
//                                // the handful of settings genuinely shared across plugins, like VRChat's OSC.
//
//     // Rarer still — only for a plugin that wants to participate in the shared "now playing" widget/actions
//     // alongside the starter pack's generic Windows-media-session reading (see plugins/pear, plugins/spotify):
//     mediaBridge: { app: 'my-app-id' },              // "I'm the definitive source for this app id" —
//                                                      // needs control(cmd,arg), view(), optionally thumbFor(url)
//     likeProvider: { matches: (app) => /.../.test(app) }, // "I add Like state onto a matching generic reading" —
//                                                           // needs like(mode), optionally decorate(info)
//   }
//
// See docs/PLUGIN-GUIDE.md for the full contract and a worked example.
const fs = require('fs');
const path = require('path');

const BUILTIN_DIR = path.join(__dirname, '..', '..', 'plugins');
const ID_RE = /^[a-z][a-z0-9-]{1,39}$/;

class PluginError extends Error {}

function validate(manifest, file) {
  if (!manifest || typeof manifest !== 'object') throw new PluginError(`plugin.js: plugin.js must export an object`);
  if (typeof manifest.id !== 'string' || !ID_RE.test(manifest.id)) throw new PluginError(`plugin.js: "id" must be lowercase letters, numbers and hyphens (2-40 chars)`);
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) throw new PluginError(`plugin.js: "name" is required`);
  for (const key of ['actions', 'widgets', 'stateKeys', 'settingsFields', 'connections']) {
    if (manifest[key] !== undefined && !Array.isArray(manifest[key])) throw new PluginError(`plugin.js: "${key}" must be an array`);
  }
  if (manifest.createRuntime !== undefined && typeof manifest.createRuntime !== 'function') throw new PluginError(`plugin.js: "createRuntime" must be a function`);
  if (manifest.matchState !== undefined && typeof manifest.matchState !== 'function') throw new PluginError(`plugin.js: "matchState" must be a function`);
  if (manifest.instructions !== undefined && typeof manifest.instructions !== 'function') throw new PluginError(`plugin.js: "instructions" must be a function`);
  if (manifest.guide !== undefined && typeof manifest.guide !== 'function' && (typeof manifest.guide !== 'object' || manifest.guide === null)) throw new PluginError(`plugin.js: "guide" must be an object or a function`);
  if (manifest.coreFields !== undefined && !Array.isArray(manifest.coreFields)) throw new PluginError(`plugin.js: "coreFields" must be an array`);
  if ((manifest.settingsFields || []).some((f) => f && (f.key === 'enabled' || f.key === 'autoConnect'))) throw new PluginError(`plugin.js: settingsFields keys "enabled" and "autoConnect" are reserved — every plugin already gets those for free`);
  (manifest.actions || []).forEach((a, i) => {
    if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !a.id) throw new PluginError(`plugin.js: actions[${i}] needs a string "id"`);
    if (typeof a.run !== 'function') throw new PluginError(`plugin.js: action "${a.id}" needs a run(params, ctx) function`);
    if (a.params !== undefined && !Array.isArray(a.params)) throw new PluginError(`plugin.js: action "${a.id}": "params" must be an array`);
  });
  (manifest.widgets || []).forEach((w, i) => {
    if (!w || typeof w !== 'object' || typeof w.id !== 'string' || !w.id) throw new PluginError(`plugin.js: widgets[${i}] needs a string "id"`);
    if (typeof w.data !== 'function') throw new PluginError(`plugin.js: widget "${w.id}" needs a data(ctx, button, state) function`);
  });
  (manifest.settingsFields || []).forEach((f, i) => {
    if (!f || typeof f.key !== 'string' || !f.key) throw new PluginError(`plugin.js: settingsFields[${i}] needs a string "key"`);
  });
  (manifest.stateKeys || []).forEach((k, i) => {
    if (!k || typeof k.key !== 'string' || !k.key) throw new PluginError(`plugin.js: stateKeys[${i}] needs a string "key"`);
  });
  return manifest;
}

// A folder is a plugin if <dir>/plugin.js exists. Returns manifests in a stable (alphabetical) order.
function scanDir(dir) {
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const found = [];
  for (const ent of names.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!ent.isDirectory()) continue;
    const file = path.join(dir, ent.name, 'plugin.js');
    if (!fs.existsSync(file)) continue;
    try {
      delete require.cache[require.resolve(file)];
      const manifest = validate(require(file), file);
      found.push({ ...manifest, dir: path.join(dir, ent.name), file });
    } catch (err) {
      // First line only (Node appends a long "Require stack"); a syntax error also gets its file and line.
      let msg = String(err.message).split(/\r?\n/)[0];
      const loc = err instanceof SyntaxError ? String(err.stack || '').split(/\r?\n/)[0].match(/([^\\/]+):(\d+)$/) : null;
      if (loc) msg += ` (${loc[1]}, line ${loc[2]})`;
      found.push({ id: `broken:${ent.name}`, name: ent.name, error: msg, broken: true, dir: path.join(dir, ent.name), file });
    }
  }
  return found;
}

// The registry every part of the app reads from: actions, widgets, state keys, and the plugin list itself.
class PluginRegistry {
  constructor() {
    this.plugins = new Map(); // id -> manifest
    this.actionDefs = new Map(); // action id -> { def, pluginId }
    this.widgetDefs = new Map(); // widget id -> { def, pluginId }
    this.stateKeys = []; // [{ ...entry, pluginId }]
    this.errors = []; // plugins that failed to load
  }

  // Loads one manifest (already required + validated). Ignored if the same id is already loaded
  // (so restarting the app, or loading the same user folder twice, is harmless). A plugin that clashes with
  // one already loaded (same id, or an action/widget id someone else owns) is refused whole — never
  // half-registered — and recorded in .errors so Settings can show why. This never throws.
  fail(manifest, error) {
    if (!this.errors.some((e) => e.dir === manifest.dir && e.error === error)) this.errors.push({ id: manifest.id, name: manifest.name, error, dir: manifest.dir });
    return false;
  }

  add(manifest) {
    if (manifest.broken) return this.fail(manifest, manifest.error);
    const existing = this.plugins.get(manifest.id);
    if (existing) {
      if (existing.dir === manifest.dir) return true; // the exact same plugin, loaded again: fine
      return this.fail(manifest, `Another plugin already uses the id "${manifest.id}" (${existing.dir}). Change the "id" in plugin.js.`);
    }
    const seen = new Set();
    for (const def of manifest.actions || []) {
      if (this.actionDefs.has(def.id) || seen.has(def.id)) return this.fail(manifest, `The action id "${def.id}" is already taken${this.actionDefs.has(def.id) ? ' by another plugin' : ' by another action in this plugin'}. Action ids must be unique: use "${manifest.id}.something".`);
      seen.add(def.id);
    }
    const seenW = new Set();
    for (const def of manifest.widgets || []) {
      if (this.widgetDefs.has(def.id) || seenW.has(def.id)) return this.fail(manifest, `The widget id "${def.id}" is already taken. Widget ids must be unique: use "${manifest.id}.something".`);
      seenW.add(def.id);
    }
    this.plugins.set(manifest.id, manifest);
    for (const def of manifest.actions || []) this.actionDefs.set(def.id, def);
    for (const def of manifest.widgets || []) this.widgetDefs.set(def.id, def);
    for (const sk of manifest.stateKeys || []) this.stateKeys.push({ ...sk, pluginId: manifest.id });
    return true;
  }

  addDir(dir) {
    for (const manifest of scanDir(dir)) this.add(manifest);
  }

  get(id) {
    return this.plugins.get(id) || null;
  }

  list() {
    return [...this.plugins.values()];
  }

  // Every needs-patch a free-typed key (a trigger's "when a state changes", a button's "follow this state")
  // could turn into, asked of each plugin's matchState in turn. Also merges any providers the STATE_KEYS
  // entry itself says it needs (arg lists like "obs.scenes" never call for a running provider).
  needsForKey(key) {
    if (!key) return null;
    for (const manifest of this.plugins.values()) {
      if (!manifest.matchState) continue;
      let patch = null;
      try { patch = manifest.matchState(key); } catch { /* a buggy matchState just doesn't match */ }
      if (patch) return patch;
    }
    return null;
  }
}

let builtin = null; // the registry loaded from the bundled plugins/ folder, cached across require()s

// The plugins shipped with the app. Loaded once per process (like the old static action-group list), so
// every existing `require('./actions')` keeps working without a separate bootstrap step.
function builtinRegistry() {
  if (!builtin) {
    builtin = new PluginRegistry();
    builtin.addDir(BUILTIN_DIR);
  }
  return builtin;
}

// A full registry for one running app: the built-ins plus whatever the user dropped in <dataDir>/plugins.
// Built fresh per call (cheap: it just re-adds the cached built-ins and re-scans the user folder), so two
// app instances (or two tests) with different user plugin folders never see each other's plugins.
function loadRegistry({ userDir } = {}) {
  const reg = new PluginRegistry();
  for (const manifest of builtinRegistry().list()) reg.add(manifest);
  reg.errors.push(...builtinRegistry().errors);
  if (userDir) reg.addDir(userDir);
  return reg;
}

module.exports = { PluginRegistry, PluginError, loadRegistry, builtinRegistry, BUILTIN_DIR, scanDir };
