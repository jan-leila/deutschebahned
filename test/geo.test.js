const test = require('node:test');
const assert = require('node:assert/strict');
const geo = require('../src/common/geo');

test('distance: one degree of latitude is ~111 km', () => {
  const d = geo.distance({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
  assert.ok(Math.abs(d - 111195) < 50, String(d));
});

test('offset moves the requested distance', () => {
  const p = { lat: 47.6, lon: -122.3 };
  for (const bearing of [0, 45, 90, 180, 270]) {
    const q = geo.offset(p, 500, bearing);
    assert.ok(Math.abs(geo.distance(p, q) - 500) < 2, `bearing ${bearing}`);
  }
});

test('polyline: decodes the Google reference example', () => {
  const pts = geo.decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.deepEqual(pts, [{ lat: 38.5, lon: -120.2 }, { lat: 40.7, lon: -120.95 }, { lat: 43.252, lon: -126.453 }]);
});

test('polyline: encode/decode round trip', () => {
  const pts = [{ lat: 47.61234, lon: -122.33211 }, { lat: 47.60001, lon: -122.3 }, { lat: -1.5, lon: 3.25 }];
  assert.deepEqual(geo.decodePolyline(geo.encodePolyline(pts)), pts);
  assert.deepEqual(geo.decodePolyline(''), []);
});

test('nearestOnPath: perpendicular distance and distance along', () => {
  const a = { lat: 47.6, lon: -122.3 };
  const b = geo.offset(a, 1000, 90);          // 1 km east
  const p = geo.offset(geo.offset(a, 400, 90), 50, 0); // 400 m along, 50 m north of the line
  const r = geo.nearestOnPath(p, [a, b]);
  assert.ok(Math.abs(r.distance - 50) < 1, String(r.distance));
  assert.ok(Math.abs(r.along - 400) < 2, String(r.along));
  assert.equal(r.index, 0);
});

test('nearestOnPath: degenerate paths', () => {
  const p = { lat: 1, lon: 1 };
  assert.equal(geo.nearestOnPath(p, []).distance, Infinity);
  assert.equal(geo.nearestOnPath(p, [p]).distance, 0);
  assert.equal(geo.distanceToPaths(p, []), Infinity);
});

test('distanceToPaths picks the closest path', () => {
  const o = { lat: 10, lon: 10 };
  const near = [geo.offset(o, 30, 0), geo.offset(geo.offset(o, 30, 0), 500, 90)];
  const far = [geo.offset(o, 300, 180), geo.offset(geo.offset(o, 300, 180), 500, 90)];
  assert.ok(Math.abs(geo.distanceToPaths(o, [far, near]) - 30) < 1);
});
