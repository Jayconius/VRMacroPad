// Config persistence: atomic writes, rolling backups, secret-stripping export.
const fs = require('fs');
const path = require('path');
const { defaultConfig, normalizeConfig } = require('./schema');

const BACKUP_KEEP = 20;
const BACKUP_MIN_INTERVAL_MS = 5 * 60 * 1000;

class Store {
  // registry: the plugin registry to normalize settings against (built-ins plus any user plugins); defaults
  // to the built-ins, which is what every caller that never mentions plugins wants.
  constructor(dir, registry) {
    this.dir = dir;
    this.file = path.join(dir, 'config.json');
    this.backupDir = path.join(dir, 'backups');
    this.lastBackup = 0;
    this.registry = registry;
    fs.mkdirSync(this.backupDir, { recursive: true });
  }

  load() {
    let warnings = [];
    if (fs.existsSync(this.file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        const res = normalizeConfig(raw, this.registry);
        return { config: res.config, warnings: res.warnings, fresh: false };
      } catch (err) {
        // Keep the unreadable file around instead of overwriting it with defaults.
        const bad = `${this.file}.corrupt-${Date.now()}`;
        try { fs.renameSync(this.file, bad); } catch { /* ignore */ }
        warnings = [`config.json could not be read (${err.message}); it was moved to ${path.basename(bad)} and defaults were loaded.`];
      }
    }
    return { config: defaultConfig(this.registry), warnings, fresh: true };
  }

  save(config) {
    const json = JSON.stringify(config, null, 2);
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, this.file);
    this.maybeBackup(json);
  }

  // Small non-config state (which page was open) that changes without needing the edit lock.
  readRuntime() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, 'runtime.json'), 'utf8'));
    } catch {
      return {};
    }
  }

  writeRuntime(patch) {
    const next = { ...this.readRuntime(), ...patch };
    fs.writeFileSync(path.join(this.dir, 'runtime.json'), JSON.stringify(next));
  }

  maybeBackup(json, force = false) {
    const now = Date.now();
    if (!force && now - this.lastBackup < BACKUP_MIN_INTERVAL_MS) return;
    this.lastBackup = now;
    const name = `config-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(path.join(this.backupDir, name), json);
    const files = this.listBackups();
    for (const old of files.slice(BACKUP_KEEP)) {
      try { fs.unlinkSync(path.join(this.backupDir, old.name)); } catch { /* ignore */ }
    }
  }

  // Newest first.
  listBackups() {
    return fs
      .readdirSync(this.backupDir)
      .filter((f) => /^config-.*\.json$/.test(f))
      .map((name) => ({ name, mtime: fs.statSync(path.join(this.backupDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  }

  readBackup(name) {
    if (!/^config-[\w.-]+\.json$/.test(name)) throw new Error('Invalid backup name');
    const raw = JSON.parse(fs.readFileSync(path.join(this.backupDir, name), 'utf8'));
    return normalizeConfig(raw, this.registry);
  }
}

// Copy of the config safe to share: passwords and any param (or plugin settings field) flagged secret are
// blanked. `registry` is the app's plugin registry (so a third-party plugin's own secret fields are covered
// too); it defaults to the plugins bundled with the app.
function stripSecrets(config, actionDefs, registry = require('./plugin-loader').builtinRegistry()) {
  const copy = JSON.parse(JSON.stringify(config));
  for (const manifest of registry.list()) {
    const slice = copy.settings.plugins && copy.settings.plugins[manifest.id];
    if (!slice) continue;
    for (const f of manifest.settingsFields || []) if (f.secret || f.type === 'password') slice[f.key] = '';
  }
  for (const page of copy.pages) {
    for (const b of page.buttons) {
      for (const step of b.steps) {
        const def = actionDefs.get(step.action);
        if (!def) continue;
        for (const p of def.params || []) {
          if (p.secret && step.params[p.key]) step.params[p.key] = '';
        }
      }
    }
  }
  return copy;
}

module.exports = { Store, stripSecrets };
