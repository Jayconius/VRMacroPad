const test = require('node:test');
const assert = require('node:assert/strict');
const Grid = require('../src/shared/grid');
const { normalizeConfig, defaultConfig } = require('../src/core/schema');

const page = (buttons, cols = 4, rows = 3) => ({ cols, rows, buttons });
const b = (id, x, y, w = 1, h = 1) => ({ id, x, y, w, h });

test('grid: overlap and bounds', () => {
  const p = page([b('a', 0, 0, 2, 2)]);
  assert.equal(Grid.fits(p, { x: 1, y: 1, w: 1, h: 1 }), false, 'overlaps a');
  assert.equal(Grid.fits(p, { x: 2, y: 0, w: 1, h: 1 }), true);
  assert.equal(Grid.fits(p, { x: 3, y: 0, w: 2, h: 1 }), false, 'leaves the page');
  assert.equal(Grid.fits(p, { x: 0, y: 0, w: 2, h: 2 }, 'a'), true, 'ignores itself');
});

test('grid: findFreeSpot scans row by row and returns null when full', () => {
  const p = page([b('a', 0, 0, 2, 1)], 2, 2);
  assert.deepEqual(Grid.findFreeSpot(p, 1, 1), { x: 0, y: 1 });
  assert.equal(Grid.findFreeSpot(p, 2, 2), null);
});

test('grid: minPageSize keeps every button inside', () => {
  const p = page([b('a', 3, 1, 2, 2)]);
  assert.deepEqual(Grid.minPageSize(p), { cols: 5, rows: 3 });
});

test('schema: default config is already valid and unchanged by normalizing', () => {
  const cfg = defaultConfig();
  const { config, warnings } = normalizeConfig(cfg);
  assert.deepEqual(warnings, []);
  assert.deepEqual(config, cfg);
  assert.ok(cfg.pages[0].buttons.length >= 5);
});

test('schema: garbage input yields a usable config', () => {
  for (const junk of [null, undefined, 5, 'x', [], { pages: 'no' }]) {
    const { config } = normalizeConfig(junk);
    assert.equal(config.pages.length, 1);
    assert.equal(config.settings.obs.port, 4455);
  }
});

test('schema: clamps values and rejects bad colors, triggers and confirm modes', () => {
  const { config } = normalizeConfig({
    settings: { gap: 999, lock: { holdMs: 1, unlockMethod: 'nonsense' }, obs: { port: 'abc' } },
    pages: [{ cols: 999, rows: 0, buttons: [{ id: 'x', x: -5, y: 0, w: 999, h: 1, color: 'red', colorOn: '#ABCDEF', confirm: 'wat',
      triggers: [{ type: 'hotkey', accelerator: 'F13' }, { type: 'bogus' }, { type: 'time', at: '25:99' }, { type: 'state', key: 'obs.recording', becomes: 'x' }] }] }],
  });
  assert.equal(config.settings.gap, 40);
  assert.equal(config.settings.lock.holdMs, 300);
  assert.equal(config.settings.lock.unlockMethod, 'hold');
  assert.equal(config.settings.obs.port, 4455);
  const pg = config.pages[0];
  assert.equal(pg.cols, 24);
  assert.equal(pg.rows, 1);
  const btn = pg.buttons[0];
  assert.equal(btn.x, 0);
  assert.equal(btn.w, 24, 'width clamped to page');
  assert.equal(btn.color, '#3b4a63');
  assert.equal(btn.colorOn, '#abcdef');
  assert.equal(btn.confirm, 'none');
  assert.deepEqual(btn.triggers.map((t) => t.type), ['hotkey', 'time', 'state']);
  assert.equal(btn.triggers[1].at, '00:00');
  assert.equal(btn.triggers[2].becomes, true);
});

test('schema: overlapping buttons are relocated, or dropped when there is no room', () => {
  const { config, warnings } = normalizeConfig({
    pages: [{ cols: 2, rows: 1, buttons: [b('a', 0, 0), b('b', 0, 0), b('c', 0, 0)] }],
  });
  assert.equal(config.pages[0].buttons.length, 2);
  assert.deepEqual(config.pages[0].buttons.map((x) => [x.x, x.y]), [[0, 0], [1, 0]]);
  assert.equal(warnings.length, 2);
});

test('schema: duplicate ids are made unique', () => {
  const { config } = normalizeConfig({ pages: [{ id: 'p', buttons: [b('same', 0, 0), b('same', 1, 0)] }, { id: 'p', buttons: [] }] });
  const ids = config.pages[0].buttons.map((x) => x.id);
  assert.notEqual(ids[0], ids[1]);
  assert.notEqual(config.pages[0].id, config.pages[1].id);
});
