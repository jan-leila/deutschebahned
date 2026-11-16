'use strict';
// src/common/place-eta.js: how long getting to each saved location takes leaving now (CONTRACTS.md §19).
const test = require('node:test');
const assert = require('node:assert/strict');
const geo = require('../src/common/geo');
const { createPlaceEta, MAX_AGE, KEEP_AGE, MOVED } = require('../src/common/place-eta');

const HERE = { lat: 44.97, lon: -93.26 };
const NOW = 1768464000;

function harness(planFn) {
  const env = { now: NOW, calls: [], changes: 0, later: [] };
  env.eta = createPlaceEta({
    plan: (place, origin, cb) => { env.calls.push([place, origin]); planFn(place, origin, cb, env); },
    clock: () => env.now,
    onChange: () => { env.changes++; },
    later: fn => env.later.push(fn)
  });
  env.flush = () => { const l = env.later.splice(0); l.forEach(f => f()); };
  return env;
}
const items = () => [{ placeId: 'home', title: 'Home', lat: 44.98, lon: -93.25 }, { placeId: 'gym', title: 'Gym', lat: 44.96, lon: -93.27 }];
const bus = (arriveAt, routeName) => ({ arriveAt, legs: [{ mode: 'walk' }, { mode: 'bus', routeName, color: '00ff00' }, { mode: 'walk' }] });

test('each place is planned once, one at a time; the times show from then on, counting down', () => {
  const pending = [];
  const env = harness((place, origin, cb) => pending.push(cb));
  let out = env.eta.apply(items(), HERE);
  assert.equal(out[0].eta, undefined, 'not known yet');
  assert.equal(env.calls.length, 1, 'one at a time');
  assert.equal(env.calls[0][0].name, 'Home');
  pending.shift()(null, bus(NOW + 1500, '2'));
  assert.equal(env.calls.length, 2);
  pending.shift()(null, { arriveAt: NOW + 600, legs: [{ mode: 'walk' }] });
  assert.equal(env.changes, 0, 'not from inside a callback');
  env.flush();
  assert.equal(env.changes, 1, 'once for both');
  env.now = NOW + 60;
  out = env.eta.apply(items(), HERE);
  assert.deepEqual([out[0].eta, out[0].via, out[0].viaColor], [1440, '2', '00ff00']);
  assert.deepEqual([out[1].eta, out[1].via], [540, ''], 'on foot');
  assert.equal(env.calls.length, 2, 'fresh: not planned again');
});

test('stale times are planned again; too old or far away they are not shown', () => {
  const env = harness((place, origin, cb) => cb(null, bus(NOW + 1000, '2')));
  env.eta.apply(items(), HERE);
  assert.equal(env.calls.length, 2);
  env.now = NOW + MAX_AGE + 1;
  let out = env.eta.apply(items(), HERE);
  assert.ok(out[0].eta >= 0, 'stale but kept while it is planned again');
  assert.equal(env.calls.length, 4);
  out = env.eta.apply(items(), geo.offset(HERE, MOVED + 50, 0));
  assert.equal(env.calls.length, 6, 'moved: planned again');
  env.now += KEEP_AGE + 1;
  const env2 = harness((place, origin, cb) => {});
  env2.eta.apply(items(), HERE);
  assert.equal(env2.eta.apply(items(), null)[0].eta, undefined, 'no position: nothing shown or planned');
});

test('a failed plan / no plan: nothing shown', () => {
  const env = harness((place, origin, cb) => cb(place.name === 'Home' ? new Error('down') : null, null));
  env.eta.apply(items(), HERE);
  const out = env.eta.apply(items(), HERE);
  assert.equal(out[0].eta, undefined);
  assert.equal(out[1].eta, undefined);
});
