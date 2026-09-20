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
  app: { version: '', about: { author: '', website: '', github: '' }, devMode: false, platform: '', hasHost: false, twitchBuiltIn: false },
  running: new Set(),
};

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
