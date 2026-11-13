const test = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../src/common/settings');
const ranking = require('../src/common/ranking');
const view = require('../src/common/view');

// a saved config and its runtime view (refs 'p/…'): ranking works on the view
const saved = () => settings.normalize({
  providers: [{ id: 'p', type: 'mock' }],
  routes: [{ providerId: 'p', id: 'R1', scale: -0.5 }, { providerId: 'p', id: 'R2', scale: -2 }, { providerId: 'p', id: 'R3' }],
  stops: [{ providerId: 'p', id: 'S1', walkScale: -4, rideScale: -7 }, { providerId: 'p', id: 'S2', walkScale: -1 }],
  maxItems: 3,
});
const cfg = () => view.build(saved(), null, null);

test('weightFor: route scale, stop walk / ride scales; anything unsaved or unknown → 0', () => {
  const c = cfg();
  assert.equal(ranking.weightFor('stop:p/S1', c), -4);
  assert.equal(ranking.weightFor('ride:p/S1', c), -7);
  assert.equal(ranking.weightFor('stop:p/S2', c), -1);
  assert.equal(ranking.weightFor('ride:p/S2', c), 0, 'saved without a ride scale');
  assert.equal(ranking.weightFor('stop:p/S9', c), 0, 'not saved');
  assert.equal(ranking.weightFor('route:p/R1', c), -0.5);
  assert.equal(ranking.weightFor('route:p/R3', c), 0, 'saved without a scale');
  assert.equal(ranking.weightFor('route:p/R9', c), 0);
  assert.equal(ranking.weightFor('conn:p/R1|p/S1', c), 0, 'version 1 keys mean nothing');
  assert.equal(ranking.weightFor('mystery', c), 0);
  assert.equal(ranking.weightFor('stop:S1', c), 0, 'keys name the system');
});

test('weightFor: learned weights override when finite', () => {
  const c = cfg();
  const learned = { 'stop:p/S1': -0.25, 'route:p/R1': NaN, 'ride:p/S1': 2 };
  assert.equal(ranking.weightFor('stop:p/S1', c, learned), -0.25);
  assert.equal(ranking.weightFor('route:p/R1', c, learned), -0.5);
  assert.equal(ranking.weightFor('ride:p/S1', c, learned), 2);
  assert.equal(ranking.weightFor('stop:p/S1', c, null), -4);
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
    item('far', { 'stop:p/S2': 400, 'route:p/R2': 60 }),    // -400 - 120 = -520
    item('near', { 'stop:p/S2': 50, 'route:p/R2': 600 }),   // -50 - 1200 = -1250
    item('tieA', { 'stop:p/S2': 100 }),                    // -100
    item('tieB', { 'stop:p/S2': 100 }),                    // -100
    item('fav', { 'stop:p/S1': 10, 'route:p/R1': 30 }),     // -40 - 15 = -55
  ];
  const before = JSON.stringify(items);
  const r = ranking.rank(items, c);
  assert.deepEqual(r.map(i => i.key), ['fav', 'tieA', 'tieB']);
  assert.deepEqual(r.map(i => i.score), [-55, -100, -100]);
  assert.equal(JSON.stringify(items), before);
  assert.notEqual(r[0], items[4]);
  assert.equal(r[0].title, 'fav');
});

test('rank: with every scale 0 (the default) the planner order stays', () => {
  const c = view.build(settings.normalize({ providers: [{ id: 'p', type: 'mock' }], routes: [{ providerId: 'p', id: 'R1' }] }), null, null);
  const items = [item('b', { 'stop:p/S2': 400, 'route:p/R1': 60 }), item('a', { 'stop:p/S2': 10, 'route:p/R1': 5 })];
  assert.deepEqual(ranking.rank(items, c).map(i => [i.key, i.score]), [['b', 0], ['a', 0]]);
});

test('rank: learned weights change the order', () => {
  const c = Object.assign(cfg(), { maxItems: 10 });
  const items = [item('stopHeavy', { 'stop:p/S2': 300, 'route:p/R2': 60 }), item('timeHeavy', { 'stop:p/S2': 20, 'route:p/R2': 400 })];
  assert.deepEqual(ranking.rank(items, c).map(i => i.key), ['stopHeavy', 'timeHeavy']); // -420 vs -820
  const learned = { 'route:p/R2': -0.1 };
  assert.deepEqual(ranking.rank(items, c, learned).map(i => i.key), ['timeHeavy', 'stopHeavy']); // -306 vs -60
});

test('view.bake: a baked config without learned weights ranks like config + learned', () => {
  const items = [item('a', { 'stop:p/S1': 10, 'route:p/R2': 5 }), item('b', { 'stop:p/S2': 100, 'ride:p/S1': 50 })];
  const learned = { 'stop:p/S1': -0.1, 'stop:p/S2': -0.2, 'route:p/R2': -9, 'ride:p/S1': -0.3 };
  const baked = view.build(view.bake(saved(), learned), null, null);
  assert.deepEqual(ranking.rank(items, baked).map(i => i.score), ranking.rank(items, cfg(), learned).map(i => i.score));
  assert.equal(saved().stops[0].walkScale, -4, 'input untouched');
});
