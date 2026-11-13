process.env.TZ = 'America/Chicago';
const test = require('node:test');
const assert = require('node:assert/strict');
const geo = require('../src/common/geo');
const directions = require('../src/common/directions');
const format = require('../src/common/format');

test('geo.bearing', () => {
  const p = { lat: 44.97, lon: -93.26 };
  for (const b of [0, 45, 90, 180, 270, 315]) {
    const got = geo.bearing(p, geo.offset(p, 500, b));
    assert.ok(Math.abs(((got - b + 540) % 360) - 180) < 0.5, `${b} → ${got}`);
  }
  assert.equal(geo.bearing(p, p), 0);
});

test('directions.abbreviate / fromBearing', () => {
  assert.equal(directions.abbreviate('Northbound'), 'NB');
  assert.equal(directions.abbreviate(' southbound'), 'SB');
  assert.equal(directions.abbreviate('EB'), 'EB');
  assert.equal(directions.abbreviate('W'), 'WB');
  assert.equal(directions.abbreviate('Westgate Transit Center'), '');
  assert.equal(directions.abbreviate('Downtown'), '');
  assert.equal(directions.abbreviate(null), '');
  assert.deepEqual([0, 44.9, 45, 134, 135, 224, 225, 314, 315, 359, -10].map(directions.fromBearing),
    ['NB', 'NB', 'EB', 'EB', 'SB', 'SB', 'WB', 'WB', 'NB', 'NB', 'NB']);
});

test('directions.label from the name, else geometry; stopLabel needs exactly one direction', () => {
  const c = { lat: 44.97, lon: -93.26 };
  const east = geo.offset(c, 400, 90), west = geo.offset(c, 400, 270);
  const route = {
    id: 'X',
    directions: [
      { id: '0', name: 'Downtown', stopIds: ['a', 'b', 'c'] },     // a → b → c heads east
      { id: '1', name: 'Southbound', stopIds: ['c', 'x'] },
      { id: '2', name: 'Loop', stopIds: ['a'] },
    ],
    stops: { a: { id: 'a', ...west }, b: { id: 'b', ...c }, c: { id: 'c', ...east }, x: { id: 'x', ...c } },
  };
  assert.equal(directions.label(route, '0', 'a'), 'EB');
  assert.equal(directions.label(route, '0', 'c'), 'EB');   // last stop: heading from the previous one
  assert.equal(directions.label(route, '1', 'c'), 'SB');   // named
  assert.equal(directions.label(route, route.directions[2], 'a'), '');
  assert.equal(directions.label(route, '9', 'a'), '');
  assert.equal(directions.stopLabel(route, 'b'), 'EB');
  assert.equal(directions.stopLabel(route, 'a'), '');      // served by directions 0 and 2
  assert.deepEqual(directions.directionsAt(route, 'c').map(d => d.id), ['0', '1']);
});

test('format.distance', () => {
  assert.deepEqual([0, 35.4, 99.6, 354, 996, 1234, 9960, 12345].map(m => format.distance(m, 'metric')),
    ['0m', '35m', '100m', '350m', '1.0km', '1.2km', '10km', '12km']);
  assert.deepEqual([10, 40, 170, 644, 1609.344, 20000].map(m => format.distance(m, 'imperial')),
    ['33ft', '130ft', '0.1mi', '0.4mi', '1.0mi', '12mi']);
  assert.equal(format.distance(-1, 'metric'), '');
  assert.equal(format.distance(NaN), '');
  for (const m of [0, 99, 999, 9999, 99999, 999999]) for (const u of ['metric', 'imperial'])
    assert.ok(Buffer.byteLength(format.distance(m, u)) <= 7, `${m} ${u}`);
});

test('format.duration / clock', () => {
  assert.deepEqual([-5, 30, 31, 89, 600, 3599, 3720].map(format.duration), ['now', 'now', '1 min', '1 min', '10 min', '1 h 00', '1 h 02']);
  const t = Date.UTC(2026, 10, 13, 14, 5) / 1000; // 08:05 in Chicago (CST)
  assert.equal(format.clock(t, false), '8:05 AM');
  assert.equal(format.clock(t, true), '08:05');
  assert.equal(format.clock(t + 4 * 3600, false), '12:05 PM');
  assert.equal(format.clock(t - 8 * 3600, false), '12:05 AM');
});
