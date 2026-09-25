# Writing a plugin

VR Macro Pad's Windows integrations (OBS, VRChat, Twitch, Spotify, YouTube Music via Pear, SteamVR,
Voicemeeter) and everything else (audio, keyboard, system control, webhooks, the clock/timer/dice
widgets...) are all plugins, loaded the same way whether they shipped with the app or you wrote them. This
guide covers the contract a plugin has to meet, and walks through a worked example.

## Where a plugin lives

Drop a folder in `<your data folder>/plugins/`. Windows: `%APPDATA%\VR Macro Pad\plugins\`. The data folder
is shown in Settings → Backup & data. Each subfolder needs a `plugin.js` that exports a manifest:

```js
module.exports = {
  id: 'my-plugin',       // lowercase letters, numbers, hyphens, 2-40 chars. Must be unique.
  name: 'My Plugin',
  version: '1.0.0',
  description: 'One line shown in Settings.',
  icon: '🔌',             // one emoji, shown next to the name

  actions: [ ... ],        // buttons can run these — see below
  widgets: [ ... ],        // mini screens buttons can show — see below
  stateKeys: [ ... ],      // entries for the "follow a state" / "when a state changes" pickers
  settingsFields: [ ... ], // rendered as this plugin's card in Settings → Plugins
  connections: [ ... ],    // optional: adds a "Connect" button for a sign-in flow
  clientMethods: [ ... ],  // runtime method names the browser is allowed to call (connect, disconnect...)

  matchState(key) { ... },   // turns one of your state keys (typed into a trigger/button) into a needs-patch
  createRuntime(ctx) { ... } // the live part: connects out, polls, publishes state — see below
};
```

Nothing here is mandatory except `id`, `name` and `version` — a plugin that only adds actions and no
`createRuntime` is fine (it just never needs a live connection). The app restarts to pick up a new or
changed plugin; a broken one (a thrown error, a duplicate id) is skipped and reported in Settings, not a
crash for everyone else.

## Actions

Same shape whether it's yours or a built-in's. An array of:

```js
{
  id: 'my-plugin.doThing',      // "<plugin-id>.<name>" by convention; must be globally unique
  category: 'My Plugin',        // groups it in the action picker
  label: 'Do the thing',
  description: 'Shown under the label in the picker.',
  icon: '⚡',
  needs: 'myPlugin',            // a needs-key: while a button/trigger uses this, sync(needs) below sees it
  params: [
    { key: 'amount', label: 'Amount', type: 'number', min: 0, max: 100, default: 10 },
  ],
  defaults: { label: 'Thing', icon: '⚡', color: '#4a5568' }, // pre-fills a new button
  state: (params) => 'my-plugin.on',   // optional: the state key this button "is" when no explicit one is set
  async run(params, ctx) {
    // ctx.plugin('my-plugin') is your own runtime (whatever createRuntime returned below) — the ONLY way
    // any action, yours or a built-in's, reaches its plugin's runtime; see engine.js "context()" for the
    // handful of other things every action gets: ctx.hub, ctx.toast(text, level), ctx.osc, ctx.oscTo(...),
    // ctx.mediaControl(app, cmd, arg) / ctx.media(app) (Windows media-session control, not plugin-specific),
    // ctx.patchSettings(fn).
    await ctx.plugin('my-plugin').doTheThing(params.amount);
  },
}
```

`needs` can be a plain string (always the same key) or a function `(params) => ({ ... })` when it depends on
the button's own params (see `plugins/vrchat/actions.js`'s `vrc.paramStep`, which needs the specific avatar
parameter it steps). A needs-patch is `{ key: true }` for "just start me", or `{ key: [ ...names ] }` /
`{ key: new Set([...]) }` when your runtime needs to know exactly *which* things are wanted (avatar
parameters, macro numbers, a media app id) — see `sync(needs)` below.

**Params types**: `text`, `password` (masked, still plain-text in the saved config), `number`
(`min`/`max`), `boolean`, `select` (`options: [[value, label], ...]` or `optionsFrom: 'a-kind-you-registered'`
via `optionLists`), `multiselect`, `keys` (a hotkey/macro combo), `textarea`, and `notice` (not a field: a highlighted warning or tip shown in the editor, with `title`, `text` and `level: 'warn'|'info'`; it saves nothing).

## Widgets

An array of mini-screen definitions:

```js
{
  id: 'my-widget',
  label: 'My Widget',
  description: 'Shown in the widget picker.',
  icon: '📊',
  size: { w: 2, h: 1 },          // default button size in grid cells
  params: [ /* same shape as action params */ ],
  defaults: { color: '#1f3a5f' },
  interaction: 'tap',                     // 'none' (default) | 'tap' | 'tap-hold': whether the widget reacts to presses
  initState: () => ({ count: 0 }),        // per-button state, persisted across restarts
  data(ctx, button, state) {              // what the browser draws; called often, keep it cheap
    return { value: String(state.count), subtitle: 'presses', status: 'ok' };
  },
  async command(ctx, button, state, cmd, arg) {  // a tap, hold, or a button on the widget itself
    if (cmd === 'tap') state.count++;
  },
}
```

**How it is drawn.** A plugin widget has no browser code of its own: the app draws whatever `data()` returns using one
generic layout. All fields are optional and unknown ones are ignored: `value` (big text), `subtitle` (or `title`),
`progress` (0 to 1), `status` (`'ok'`, `'warn'`, `'error'`) `items` (up to 12 `{ label, value }` rows) and `spark` (recent numbers, oldest first, drawn as a small bar graph; scaled between their lowest and highest unless you also give `sparkMin` / `sparkMax`). If `data()` throws,
the widget shows the error text instead of breaking the page.

`ctx` here has `now()`, `random(n)`, `runtime` (the WidgetRuntime itself — `ctx.runtime.setTimer(...)` is how
the built-in timer widget works), and `ctx.plugin(id)` for reaching a runtime the same way actions do.

## Settings and connections

Settings → Plugins lists every loaded plugin as its own card: icon, name, status dot, an **Enabled**
toggle, then its settings and its "Connect" if it has one — the same shape whether it's a built-in or
something you wrote. Nothing here is optional UI you have to build: it's generated from the manifest.

The **Enabled** toggle is free and automatic — every plugin gets one, you don't declare it. Switching it
off calls your runtime's `stop()` and then simply never calls `sync()`/`configure()` on it again (and
`status()` is reported as `disabled`) until it's switched back on; nothing else about your plugin changes.
`ctx.plugin(id)` throws a clear "disabled" error while it's off, the same way it does when the plugin isn't
loaded at all — you don't need to check `enabled` yourself.

A handful of the built-ins add a little more to their card than a plain form — a device-code box, a
redirect URI to copy, a "test connection" button. None of that is hardcoded to their plugin id; it's driven
by manifest fields any plugin can use:

```js
instructions: (status) => 'How to set this up, shown under the description. status is this plugin\'s own status().',
statusHints: { 'some-status': 'Shown next to the dot instead of the generic word for that status.' },
testOptionKind: 'my-plugin.things',  // adds a "Save and test connection" button that calls this optionList
```

And on a `settingsFields` entry:

```js
{ key: 'clientId', label: 'Client ID', type: 'text', builtInAware: true }
```

`builtInAware` tucks the field inside a collapsed "Advanced" section with an adjusted placeholder whenever
`status().hasBuiltIn` is true — for a plugin that ships with its own bundled key/app id the way Twitch does,
so most people never have to touch the field at all.

A plugin can also put a `note` string in its `status()`; the Settings card shows it above the Connect button (handy for "a special mode is on").

`advanced: true` on a settings field tucks it inside a collapsed "Advanced" section always (`advancedLabel` on the manifest
renames the section), for things most people never need.

`section: 'Some title'` on several settings fields keeps them together in one collapsed box whose title line summarises what is inside
(its text values, and how many things are ticked in a `multiselect`; `countLabel: 'voices'` names what is counted). It is for a few
related settings that would otherwise clutter the card, like a set of named groups. A `multiselect` setting (with `optionsFrom`) is saved
as a list of text values, and its tick-list gets a filter box once it has more than a dozen entries.

An option list can depend on other fields of the same button: give a param `optionsFilter: ['otherKey']`. The list is then asked again
whenever that field changes, and its function gets their current values as its second argument (`(ctx, args) => ...`).

An `Instructions` button: give the manifest a `guide` (an object, or a function of `status()`):

```js
guide: {
  title: 'Set up My Plugin',
  intro: 'Takes about five minutes.',
  steps: [
    { title: 'Make an app', text: 'Name it anything.', links: [{ label: 'Open the developer site', url: 'https://example.com/apps' }] },
    { title: 'Copy this permission', text: 'Paste it into the scopes box.', copy: { label: 'Copy', text: 'read.things' } },
  ],
  outro: 'Then paste the details below and press Connect.',
}
```

The Settings card gets an "Instructions" button that opens the steps in a dialog. Link buttons open in the normal browser, so
their hosts must be listed in `externalDomains`; only `https` links are shown.

The connect/disconnect flow itself (the code box, the redirect URI field, "Connect"/"Disconnect", any other
`clientMethods` you list) is entirely generic — it reads `connections[].flow`, `clientMethods`, and whatever
your `status()` returns (`pending: { userCode, verificationUri }`, `redirectUri`, `hasToken`, `encrypted`,
`user`). Nothing about it is specific to a built-in plugin; `docs/example-plugin-login/` gets the exact same
UI your own login-flow plugin would.

Two much rarer manifest fields, for the one or two cases in this app that genuinely need them: `coreFields`
binds a settingsField-shaped entry to a *shared* core setting by dotted path (`{ path: 'osc.sendPort', ... }`)
instead of your own plugin's settings — only VRChat's OSC ports use this, since OSC is shared core transport,
not one plugin's own setting. `mediaBridge`/`likeProvider` let a plugin participate in the shared "now
playing" widget/actions (see plugins/pear and plugins/spotify, and the comment above `mediaControl()` in
`src/core/plugin-runtime.js`) — you'll only need these if your plugin is itself a media source or adds a
Like-style decoration onto one.

`settingsFields` is the same shape as action `params`; each entry becomes one field in your plugin's card,
saved to `config.settings.plugins.<your-id>.<key>`. `enabled` is a reserved key — don't use it for your own
field. A `type: 'password'` field is blanked out of exported layouts automatically.

```js
settingsFields: [
  { key: 'apiKey', label: 'API key', type: 'password', help: 'From your account page on example.com.' },
  { key: 'city', label: 'City', type: 'text', default: 'London' },
],
```

If your plugin needs a "Connect" step (an API login, not just a pasted key), add:

```js
connections: [{ id: 'main', label: 'My Service account', flow: 'device' /* or 'redirect', 'approve' */ }],
clientMethods: ['connect', 'disconnect'],
externalDomains: ['example.com'],  // lets open.external open your sign-in page; otherwise it's refused
```

and give your runtime (below) `connect()`/`disconnect()` methods the browser can call by name — nothing
else can call them, and only while editing is unlocked. A handful of the built-ins (Twitch, Pear, Spotify,
OBS, VRChat) keep a bit of hand-written extra UI in their card (a device-code box, a redirect URI to copy, a
"test connection" button) because their sign-in needs more than one field; any other plugin's card is built
straight from `settingsFields`/`connections` — you don't have to write any UI code for this to work, though
it will look plainer than those five.

Any plugin with a `connect()` clientMethod also gets a reserved **"Auto-connect on startup"** checkbox for
free (`settings.plugins.<your-id>.autoConnect`, don't declare it yourself). When it's on, `PluginRuntime`
treats your plugin as always needed — your `sync(needs)` sees `needs[id] = true` (or `needs[k] = true` for
each `k` in a `needsKeys` array you declare, if your own `sync` checks a key that doesn't match your plugin
id) regardless of whether any button currently uses you, so a *previously saved* session reconnects at app
startup, and again the moment the service you talk to becomes reachable if it wasn't yet — Pear's own retry
loop already does the second part, and if your client has something similar it works the same way with no
extra code. It never triggers a fresh sign-in on its own: `connect()` is only ever called by a person
pressing the button, since only a person can approve a device code, a browser consent screen, or an "Allow"
prompt.

**Two logins, two patterns already in this codebase to copy from:**
- **A real account login (OAuth), like Twitch or Spotify** — see `plugins/twitch/client.js` (device-code
  flow: show a short code, poll until approved, no redirect server) or `plugins/spotify/client.js` (PKCE +
  a tiny local redirect server). Both keep their token in `ctx.secrets` (see below), refresh it before it
  expires, and expose `connect()`/`disconnect()`/`info()`.
- **A pasted API key or local token, like an OBS password or a Spotify Dev API key** — just a
  `settingsFields` entry of `type: 'password'`; no `connections`/`clientMethods` needed at all. See
  `plugins/obs/plugin.js`.

## The runtime: `createRuntime(ctx)`

The live part — connects, polls, publishes state, remembers what a button/trigger last set. Called once
when the app starts (or your plugin is (re)loaded), with a `ctx` built just for you:

```js
createRuntime(ctx) {
  return new MyRuntime(ctx);
}
```

| `ctx.*` | what it is |
|---|---|
| `id` | your plugin's own id |
| `hub` | the shared `StateHub` — `hub.set(key, value)`, `hub.get(key)`, `hub.remove(key)`, `hub.on('change', ...)` |
| `now()` | the clock (tests substitute a fake one — never call `Date.now()` directly) |
| `settings()` | your own `config.settings.plugins.<id>` block, live (always current, no stale copies) |
| `coreSettings()` | the full settings object, for the handful of shared bits (`osc`, `overlay`) |
| `secrets` | `{ get(key), set(key, value), delete(key), isEncrypted() }` — a per-plugin secret store (see below) |
| `winHelper(kind)` | a Windows helper process. `'audio'`, `'media'`, `'vr'`, `'voicemeeter'` are the four the app ships; any other string gets you your own, built on first use |
| `osc` | `{ send(address, args) }` to VRChat's configured address; `oscListen(port, host)` opens your own listener |
| `dataDir` / `buildDir` | paths, if you need to read/write your own files |
| `store` | `{ readRuntime(), writeRuntime(patch) }` — the same small JSON file the app uses for things that must survive a restart but aren't part of the layout (a timer's remaining time, SteamVR's remembered devices...) |
| `app` | `{ twitchClientId, spotifyClientId }` — the app's own built-in OAuth client ids, if you need to check whether one is set |
| `plugins.get(otherId)` | another plugin's runtime, if you genuinely depend on one (the starter pack's media polling, say) |
| `emitStatus()` | call this when your connection state changes, so the status dot and any open Settings page update immediately instead of on the next 5-second tick |

A runtime instance can implement any of:

```js
{
  configure()          { /* settings() changed; reconnect if the host/port/etc actually differ */ },
  sync(needs)           { /* something started or stopped needing you; needs.<yourKey> is true/Set/undefined */ },
  stop()                { /* app is shutting down, or nothing needs you any more: let go of everything */ },
  status()               { return { state: 'off'|'connecting'|'connected'|'error', error: '' }; },
  connect()  { /* only if you listed it in clientMethods */ },
  disconnect() { /* likewise */ },
}
```

`status()`'s exact extra fields are yours — the OAuth-flavoured plugins use `.status` (not `.state`) plus
`.user`/`.pending`/`.encrypted` because their `client.info()` predates the plugin split; either key is read
by the generic UI (`state.status.plugins.<id>.state ?? .status`). New plugins should prefer `.state`.

## Secrets

Never write a token or password to `config.json` yourself (it's exported, backed up, and easy to
accidentally screenshot). Use `ctx.secrets` instead — it's a `SecretStore` automatically namespaced to your
plugin id (`plugin:<your-id>:<key>`), so you can't collide with, or read, another plugin's secrets. It's
encrypted with the user's Windows account when the desktop app offers that (`secrets.isEncrypted()`); a
`settingsFields` password field is a shortcut for a value that belongs in `config.json` (visible, but not
exported) — use `ctx.secrets` for anything that shouldn't be either.

## State keys and `matchState`

`stateKeys` lists the values your plugin publishes to `hub`, for the "follow a state" (button lights up) and
"when a state changes" (trigger) pickers:

```js
stateKeys: [
  { key: 'my-plugin.online', label: 'My Service is reachable', group: 'My Plugin' },
  { key: 'my-plugin.level', label: 'My Service reports…', group: 'My Plugin', arg: 'text' }, // "arg" means it takes a value to compare against, e.g. my-plugin.level=5
],
matchState(key) {
  if (!key.startsWith('my-plugin.')) return null; // not yours: let another plugin's matchState try
  return { myPlugin: true }; // the needs-key your sync(needs) checks for
},
```

`matchState` is how a free-typed key (someone chooses your state key in the UI) turns into a needs-patch —
it's what makes your `sync(needs)` actually get called once a button uses you.

## A generic dropdown (`optionLists`)

If a param wants `type: 'select', optionsFrom: 'my-plugin.things'`, register it:

```js
optionLists: {
  'my-plugin.things': async (ctx) => {
    const list = await ctx.plugin('my-plugin').fetchThings();
    return list.map((t) => ({ value: t.id, label: t.name }));
  },
},
```

## Worked examples

Two complete, runnable plugins, one for each integration style:

- **`docs/example-plugin/`** — "manual API setup" (the Spotify-Dev-API style, not a login): a pasted API
  key, polling a fake weather API, a `weather.hot` state key, a `weather.announce` action, and a small
  now-showing widget. Read `plugin.js` first, then `runtime.js`.
- **`docs/example-plugin-login/`** — a real account login (the Twitch/Spotify/Pear style): a device-code
  flow against a small fake backend (`fake-service.js`, clearly marked as the part you replace), a token
  kept in `ctx.secrets` that survives a restart, `connect()`/`disconnect()` the browser can call, and an
  action that fails cleanly when not signed in. Read `client.js` first — that's the reusable part; `runtime.js`
  and `plugin.js` are the thin glue around it. Press **Connect** in Settings → Plugins after copying it in and
  it "approves itself" after a few seconds, so you can watch the whole flow with no real account.

Copy either folder into `<data folder>/plugins/<name>/` to try it. For the three *real* sign-in flows this
app ships (which the login example is deliberately simplified from), read `plugins/pear/` first — it's the
smallest (a local token exchange, no redirect server or device code) — then `plugins/twitch/` (device code)
or `plugins/spotify/` (PKCE + a local redirect server).

## Testing your plugin

`createApp({ ..., pluginsDir: '/path/to/a/folder/of/plugins' })` loads plugins from anywhere, which is how
the app's own test suite exercises this loader without touching a real data folder. `pluginsDir: false`
skips loading user plugins at all (most of the app's own tests do this, so a stray folder on your machine
never changes what they see).
