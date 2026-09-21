// Client-side copy of what the core told us, plus a tiny change notifier.
export const state = {
  ready: false,
  config: null,
  catalog: { actions: [], stateKeys: [] },
  buttonStates: {},
  widgetData: {},
  clockOffset: 0, // core time minus this page's time, so timers stay right if the clocks differ
  activePage: null,
  edit: { on: false, relockAt: 0, unlockMethod: 'hold' },
  status: {},
  log: [],
  app: { version: '', overlayDefaults: {}, about: { author: '', website: '', github: '' }, devMode: false, platform: '', hasHost: false, twitchBuiltIn: false },
  running: new Set(),
};

// The SteamVR overlay shows this same page, loaded off-screen with ?view=overlay (see overlay-view.js).
const viewName = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('view') : '';
// dashboard: the control panel opened from the bar at the bottom of SteamVR's menu (see dashboard-view.js).
// editor: the full app, drawn inside the dashboard panel (see vr-input.js for what makes it usable with a laser).
export const view = { overlay: viewName === 'overlay', dashboard: viewName === 'dashboard', editor: viewName === 'editor' };

// The pages the overlay may show: the ones ticked in Settings, or all of them.
export function overlayPages() {
  const all = state.config ? state.config.pages : [];
  const pick = (state.config && state.config.settings.overlay && state.config.settings.overlay.pages) || [];
  const list = pick.length ? all.filter((p) => pick.includes(p.id)) : all;
  return list.length ? list : all;
}

const subs = new Set();

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function notify() {
  for (const fn of subs) fn();
}

export function actionDef(id) {
  return state.catalog.actions.find((a) => a.id === id) || null;
}

export function currentPage() {
  if (!state.config) return null;
  return state.config.pages.find((p) => p.id === state.activePage) || state.config.pages[0];
}
