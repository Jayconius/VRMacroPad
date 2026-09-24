// The action catalog. Built from every loaded plugin's own action list (see src/core/plugin-loader.js and
// docs/PLUGIN-GUIDE.md) plus the state keys the UI offers for "follow a state" and "when a state changes".
// This module itself only carries the plugins bundled with the app (plugins/*), loaded once, exactly like
// the old static per-file action groups; a running app additionally merges in the user's own plugins via
// loadUserPlugins() (called once from src/core/index.js).
const { PluginRegistry, builtinRegistry, BUILTIN_DIR } = require('../plugin-loader');
const { registerWidgets, widgetCatalog } = require('../widgets');

// One shared registry for the whole process (see the loader for why this is safe to share across tests).
const registry = new PluginRegistry();
for (const manifest of builtinRegistry().list()) registry.add(manifest);

const defs = registry.actionDefs; // id -> action def, same Map shape callers have always used
const STATE_KEYS = registry.stateKeys;
registerWidgets(registry.widgetDefs);

// Adds a plugin folder's actions/widgets/state keys into the running catalog. Safe to call more than once
// with the same folder (a no-op the second time); a genuine id clash throws, same as a duplicate built-in.
function loadUserPlugins(dir) {
  if (!dir) return [];
  const before = new Set(registry.plugins.keys());
  registry.addDir(dir);
  registerWidgets(registry.widgetDefs);
  return [...registry.plugins.keys()].filter((id) => !before.has(id));
}

// statusFor(id): the live status() a running app has for that plugin (server.js passes providers.status()
// through); pluginList() calls manifest.instructions(status) here, server-side, because a manifest function
// can never survive the trip to the browser as JSON — everything else it needs is plain data and is sent
// through as-is (statusHints, testOptionKind, coreFields), so the Plugins tab reads it with no plugin id
// ever hardcoded in the UI.
function safeText(fn, arg) {
  if (!fn) return '';
  try { return String(fn(arg) || ''); } catch { return ''; }
}

// A plugin's optional set-up guide (an "Instructions" button in its Settings card): { title, intro, steps: [{ title, text,
// links: [{ label, url }], copy: { label, text } }], outro }. Resolved here, server-side, and cleaned down to plain text and
// https links, so nothing a plugin declares can put markup or a non-web link in front of the user.
function cleanGuide(g) {
  if (!g || typeof g !== 'object') return null;
  const s = (v, n) => String(v == null ? '' : v).slice(0, n);
  const steps = (Array.isArray(g.steps) ? g.steps : []).slice(0, 30).map((st) => ({
    title: s(st && st.title, 120),
    text: s(st && st.text, 1200),
    links: (Array.isArray(st && st.links) ? st.links : []).slice(0, 6)
      .filter((l) => l && /^https:\/\/[^\s]+$/.test(String(l.url)))
      .map((l) => ({ label: s(l.label || l.url, 80), url: s(l.url, 300) })),
    copy: st && st.copy && st.copy.text ? { label: s(st.copy.label || 'Copy', 40), text: s(st.copy.text, 400) } : null,
  })).filter((st) => st.title || st.text);
  if (!steps.length) return null;
  return { button: s(g.button || 'Instructions', 40), title: s(g.title, 120), intro: s(g.intro, 800), steps, outro: s(g.outro, 800) };
}
function safeGuide(guide, arg) {
  if (!guide) return null;
  try { return cleanGuide(typeof guide === 'function' ? guide(arg) : guide); } catch { return null; }
}

function pluginList(statusFor = () => ({})) {
  return registry.list().map((m) => ({
    id: m.id, name: m.name, version: m.version || '', description: m.description || '', icon: m.icon || '🔌',
    builtin: m.dir.startsWith(BUILTIN_DIR),
    settingsFields: m.settingsFields || [],
    connections: m.connections || [],
    clientMethods: m.clientMethods || [],
    instructions: safeText(m.instructions, statusFor(m.id) || {}),
    guide: safeGuide(m.guide, statusFor(m.id) || {}),
    advancedLabel: m.advancedLabel || '',
    statusHints: m.statusHints || {},
    testOptionKind: m.testOptionKind || '',
    coreFields: m.coreFields || [],
  }));
}

// What the browser needs to build forms (functions and run() stay on the server).
function catalogForUi(statusFor) {
  return {
    actions: [...defs.values()].map((d) => ({
      id: d.id,
      category: d.category,
      label: d.label,
      description: d.description,
      icon: d.icon,
      params: d.params,
      defaults: d.defaults,
      hasState: Boolean(d.state),
    })),
    widgets: widgetCatalog(),
    stateKeys: STATE_KEYS,
    plugins: pluginList(statusFor),
    // Plugins that could not be loaded, with the reason, so Settings can say so instead of them silently missing.
    pluginErrors: registry.errors.map((e) => ({ name: e.name, dir: e.dir, error: e.error })),
  };
}

// The state key a button follows when its source is "auto": from its first stateful step.
function autoStateKey(button) {
  for (const step of button.steps) {
    const def = defs.get(step.action);
    if (def && def.state) {
      let key = null;
      try { key = def.state(step.params || {}); } catch { /* a buggy state() just means "no automatic state" */ }
      if (key) return key;
    }
  }
  return null;
}

module.exports = { defs, STATE_KEYS, catalogForUi, autoStateKey, registry, loadUserPlugins, pluginList, cleanGuide };
