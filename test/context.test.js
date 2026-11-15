// context.js (§19): the moment as features crossed with each item's key, and places.js tiles.
const test = require('node:test');
const assert = require('node:assert/strict');
const context = require('../src/common/context');
const places = require('../src/common/places');
const ranking = require('../src/common/ranking');
const optimize = require('../src/common/optimize');
const geo = require('../src/common/geo');

const local = (y, mo, d, h, mi) => Math.floor(new Date(y, mo, d, h, mi).getTime() / 1000);

test('at: local weekday, minute of the day, month and day; weather from a weather.slice result', () => {
  const t = local(2026, 10, 16, 8, 30);   // Monday 16 November 2026, 08:30 local
  assert.deepEqual(context.at(t, null), { t, dow: 1, minute: 510, month: 10, day: 16, temp: null, rain: null });
  const c = context.at(t, { now: 4.26, rain: [130, 5] });
  assert.equal(c.temp, 4.3);
  assert.equal(c.rain, 100);
  assert.equal(context.at(t, { now: null, rain: [] }).temp, null);
});

test('features: one-hot weekday, time of day and of year on the circle, weather scaled; all keyed by the item', () => {
  const ctx = { dow: 3, minute: 360, month: 0, day: 1, temp: 25, rain: 50 };
  const f = context.features('pickup:a/1:a/2', ctx);
  assert.deepEqual(Object.keys(f).sort(), ['dow3', 'rain', 'temp', 'tod1c', 'tod1s', 'tod2c', 'tod2s', 'yrc', 'yrs']
    .map(k => 'pickup:a/1:a/2@' + k).sort());
  assert.equal(f['pickup:a/1:a/2@dow3'], context.UNIT);
  assert.equal(f['pickup:a/1:a/2@tod1s'], context.UNIT);     // 06:00 = a quarter of the day round
  assert.equal(f['pickup:a/1:a/2@tod1c'], 0);
  assert.equal(f['pickup:a/1:a/2@tod2c'], -context.UNIT);
  assert.equal(f['pickup:a/1:a/2@yrc'], context.UNIT);       // 1 January
  assert.equal(f['pickup:a/1:a/2@temp'], 150);
  assert.equal(f['pickup:a/1:a/2@rain'], 30);
  const noWeather = context.features('k', { dow: 0, minute: 0, month: 5, day: 1, temp: null, rain: null });
  assert.equal('k@temp' in noWeather || 'k@rain' in noWeather, false);
  assert.deepEqual(context.features('', ctx), {});
});

test('augment: new copies with the context features added; split recovers the item key', () => {
  const items = [{ key: 'place:home', title: 'Home', features: { 'place:home': 300 } }, { title: 'no key' }];
  const out = context.augment(items, { dow: 2, minute: 0, month: 0, day: 1, temp: null, rain: null });
  assert.equal(items[0].features['place:home@dow2'], undefined, 'input untouched');
  assert.equal(out[0].features['place:home'], 300);
  assert.equal(out[0].features['place:home@dow2'], context.UNIT);
  assert.deepEqual(out[1].features, {});
  assert.deepEqual(context.split('pickup:p/s@x:p/r@dow2'), { base: 'pickup:p/s@x:p/r', part: 'dow2' });
  assert.deepEqual(context.split('route:p/r'), { base: 'route:p/r', part: '' });
});

test('learning picks up a weekday habit the distances alone cannot explain', () => {
  // two places; on Mondays the farther one is always picked, other days the nearer one
  const cfg = { places: [{ id: 'near', name: 'Near', lat: 0, lon: 0.001, scale: 0 }, { id: 'far', name: 'Far', lat: 0, lon: 0.01, scale: 0 }],
    schedule: { walkSpeed: 1.3 }, maxItems: 8 };
  const pos = { lat: 0, lon: 0 };
  const samples = [];
  for (let day = 0; day < 28; day++) {
    const t = local(2026, 10, 1 + day, 9, 0);
    const ctx = context.at(t, null);
    const items = context.augment(places.buildItems(cfg, pos), ctx);
    samples.push(optimize.makeSample(items, ctx.dow === 1 ? 1 : 0, pos, t, ctx));
  }
  const opts = { learningRate: 0.05, iterations: 300, temperature: 60, regularization: 0.01 };
  const res = optimize.train(samples, k => ranking.weightFor(k, cfg, null), opts);
  assert.equal(res.after.accuracy, 1);
  const order = t => ranking.rank(context.augment(places.buildItems(cfg, pos), context.at(t, null)), cfg, res.weights).map(i => i.placeId);
  assert.deepEqual(order(local(2026, 11, 7, 9, 0)), ['far', 'near'], 'a Monday');
  assert.deepEqual(order(local(2026, 11, 8, 9, 0)), ['near', 'far'], 'a Tuesday');
  assert.equal(samples[0].ctx.minute, 540);
});

test('places.buildItems: tiles in config order with distance, bearing, walk and their feature; place scale prior', () => {
  const cfg = { places: [{ id: 'home', name: 'Home', lat: 0, lon: 0.01, address: '1 Main', scale: -2 }], schedule: { walkSpeed: 1.25 } };
  const [it] = places.buildItems(cfg, { lat: 0, lon: 0 });
  const d = geo.distance({ lat: 0, lon: 0 }, { lat: 0, lon: 0.01 });
  assert.equal(it.kind, 'place');
  assert.equal(it.key, 'place:home');
  assert.equal(it.title, 'Home');
  assert.equal(it.address, '1 Main');
  assert.equal(Math.round(it.bearing), 90);
  assert.equal(it.walk, Math.ceil(d / 1.25));
  assert.deepEqual(it.features, { 'place:home': Math.round(d) });
  assert.equal(ranking.weightFor('place:home', cfg, null), -2);
  assert.equal(ranking.weightFor('place:nope', cfg, null), 0);
  const [blind] = places.buildItems(cfg, null);
  assert.equal(blind.distance, null);
  assert.equal(blind.features['place:home'], 0);
});
