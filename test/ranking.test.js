const test = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../src/common/settings');
const ranking = require('../src/common/ranking');

const cfg = () => settings.normalize({
  defaultStopScale: -1, defaultRouteScale: -2, defaultConnectionScale: -3,
  routes: [{ id: 'R1', scale: -0.5 }, { id: 'R2' }],
  connections: [{ routeId: 'R1', stopId: 'S9', scale: -7 }, { routeId: 'R2', stopId: 'S8' }],
  stopScales: { S1: -4 },
  maxItems: 3,
});

test('weightFor: prefixes, configured values, defaults, unknown keys', () => {
  const c = cfg();
  assert.equal(ranking.weightFor('stop:S1', c), -4);
  assert.equal(ranking.weightFor('stop:S2', c), -1);
  assert.equal(ranking.weightFor('route:R1', c), -0.5);
  assert.equal(ranking.weightFor('route:R2', c), -2);       // configured without scale -> normalize filled default
  assert.equal(ranking.weightFor('route:R3', c), -2);       // unconfigured -> default
  assert.equal(ranking.weightFor('conn:R1|S9', c), -7);
  assert.equal(ranking.weightFor('conn:R2|S8', c), -3);
  assert.equal(ranking.weightFor('conn:zz|S8', c), -3);
  assert.equal(ranking.weightFor('mystery', c), 0);
  assert.equal(ranking.weightFor('stop:S1:with:colons', c), -1);
});

test('weightFor: learned weights override when finite', () => {
  const c = cfg();
  const learned = { 'stop:S1': -0.25, 'route:R1': NaN, 'conn:R1|S9': 2 };
  assert.equal(ranking.weightFor('stop:S1', c, learned), -0.25);
  assert.equal(ranking.weightFor('route:R1', c, learned), -0.5);
  assert.equal(ranking.weightFor('conn:R1|S9', c, learned), 2);
  assert.equal(ranking.weightFor('stop:S1', c, null), -4);
});

test('score is the weighted sum', () => {
  const w = { a: 2, b: -1 };
  assert.equal(ranking.score({ a: 3, b: 10 }, k => w[k] || 0), -4);
  assert.equal(ranking.score({}, () => 1), 0);
});

const item = (key, features) => ({ key, kind: 'pickup', title: key, times: [], features });

test('rank: sorts by score desc, stable on ties, truncates, does not mutate', () => {
  const c = cfg();
  const items = [
    item('far', { 'stop:S2': 400, 'route:R2': 60 }),    // -400 - 120 = -520
    item('near', { 'stop:S2': 50, 'route:R2': 600 }),   // -50 - 1200 = -1250
    item('tieA', { 'stop:S2': 100 }),                  // -100
    item('tieB', { 'stop:S2': 100 }),                  // -100
    item('fav', { 'stop:S1': 10, 'route:R1': 30 }),     // -40 - 15 = -55
  ];
  const before = JSON.stringify(items);
  const r = ranking.rank(items, c);
  assert.deepEqual(r.map(i => i.key), ['fav', 'tieA', 'tieB']);
  assert.deepEqual(r.map(i => i.score), [-55, -100, -100]);
  assert.equal(JSON.stringify(items), before);
  assert.notEqual(r[0], items[4]);
  assert.equal(r[0].title, 'fav');
});

test('rank: learned weights change the order', () => {
  const c = Object.assign(cfg(), { maxItems: 10 });
  const items = [item('stopHeavy', { 'stop:S2': 300, 'route:R2': 60 }), item('timeHeavy', { 'stop:S2': 20, 'route:R2': 400 })];
  assert.deepEqual(ranking.rank(items, c).map(i => i.key), ['stopHeavy', 'timeHeavy']); // -420 vs -820
  const learned = { 'route:R2': -0.1 };
  assert.deepEqual(ranking.rank(items, c, learned).map(i => i.key), ['timeHeavy', 'stopHeavy']); // -306 vs -60
});

test('bake: learned weights written into the matching config scales', () => {
  const c = cfg();
  const baked = ranking.bake(c, { 'stop:S1': -0.1, 'stop:NEW': -0.2, 'route:R2': -9, 'route:UNKNOWN': 5,
    'conn:R1|S9': -0.3, 'conn:nope|x': 1, junk: 4 });
  assert.equal(baked.stopScales.S1, -0.1);
  assert.equal(baked.stopScales.NEW, -0.2);
  assert.equal(baked.routes.find(r => r.id === 'R2').scale, -9);
  assert.equal(baked.routes.length, 2);
  assert.equal(baked.connections.find(x => x.id === 'R1|S9').scale, -0.3);
  assert.equal(baked.connections.length, 2);
  assert.equal(c.stopScales.S1, -4, 'input untouched');
  assert.equal(c.routes[1].scale, -2, 'input untouched');
  // baked config with no learned weights ranks like config + learned
  const items = [item('a', { 'stop:S1': 10, 'route:R2': 5 }), item('b', { 'stop:NEW': 100, 'conn:R1|S9': 50 })];
  const learned = { 'stop:S1': -0.1, 'stop:NEW': -0.2, 'route:R2': -9, 'conn:R1|S9': -0.3 };
  assert.deepEqual(ranking.rank(items, ranking.bake(c, learned)).map(i => i.score), ranking.rank(items, c, learned).map(i => i.score));
});
