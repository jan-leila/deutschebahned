// Runtime view of a config: refs, coverage areas, watch preferences, bake (CONTRACTS.md §2a).
const test = require('node:test');
const assert = require('node:assert/strict');
const geo = require('../src/common/geo');
const settings = require('../src/common/settings');
const view = require('../src/common/view');

const MPLS = { lat: 44.9778, lon: -93.2650 };
const SEATTLE = { lat: 47.6062, lon: -122.3321 };

function twoCities() {
  return settings.normalize({
    providers: [{ id: 'mt', type: 'metrotransit' }, { id: 'sea', type: 'onebusaway', apiKey: 'k' }, { id: 'demo', type: 'mock' }],
    routes: [{ providerId: 'mt', id: '2', name: 'Two', scale: -1, color: '771473' }, { providerId: 'sea', id: '1_100225', name: '44' },
             { providerId: 'demo', id: 'R1' }],
    stops: [{ providerId: 'mt', id: '16058', name: 'Home', lat: 44.98, lon: -93.23, walkScale: -0.5, rideScale: -2 },
            { providerId: 'mt', id: '13337', name: 'Work', lat: 44.96, lon: -93.29 },
            { providerId: 'sea', id: '1_10914', name: 'Campus', lat: 47.6564, lon: -122.3122 }],
  });
}

test('ref / splitRef: provider ids never contain "/", source ids may', () => {
  assert.equal(view.ref('mt', '2'), 'mt/2');
  assert.deepEqual(view.splitRef('mock/R1:s3'), { providerId: 'mock', id: 'R1:s3' });
  assert.deepEqual(view.splitRef('a/b/c'), { providerId: 'a', id: 'b/c' });
  for (const bad of ['', 'nope', '/x', null, 3]) assert.equal(view.splitRef(bad), null, String(bad));
});

test('coverage: auto = around the saved stops with a position (+ margin); none → everywhere; manual as set', () => {
  const c = twoCities();
  const mt = view.coverage(c, 'mt');
  assert.ok(Math.abs(mt.lat - 44.97) < 1e-9 && Math.abs(mt.lon - -93.26) < 1e-9, JSON.stringify(mt));
  const far = Math.max(geo.distance(mt, { lat: 44.98, lon: -93.23 }), geo.distance(mt, { lat: 44.96, lon: -93.29 }));
  assert.equal(mt.radius, Math.round(far + view.AUTO_MARGIN));
  assert.equal(view.coverage(c, 'demo'), null, 'no saved stop → everywhere');
  assert.equal(view.coverage(c, 'nope'), null);
  c.providers[1].coverage = { mode: 'manual', lat: 47.6, lon: -122.3, radius: 20000 };
  assert.deepEqual(view.coverage(c, 'sea'), { lat: 47.6, lon: -122.3, radius: 20000 });
  assert.ok(view.covers(c, 'mt', MPLS) && !view.covers(c, 'mt', SEATTLE));
  assert.ok(view.covers(c, 'sea', SEATTLE) && !view.covers(c, 'sea', MPLS));
  assert.ok(view.covers(c, 'demo', MPLS) && view.covers(c, 'demo', SEATTLE) && view.covers(c, 'mt', null));
  assert.deepEqual(view.activeProviders(c, MPLS), ['mt', 'demo']);
  assert.deepEqual(view.activeProviders(c, SEATTLE), ['sea', 'demo']);
});

test('build: only systems covering the position; refs; connections pair routes and stops of one system', () => {
  const v = view.build(twoCities(), { units: 'metric', clock24: true, known: true }, MPLS);
  assert.deepEqual(v.providers, ['mt', 'demo']);
  assert.deepEqual(v.routes.map(r => r.id), ['mt/2', 'demo/R1']);
  assert.deepEqual(v.routes[0], { id: 'mt/2', providerId: 'mt', sourceId: '2', name: 'Two', scale: -1, color: '771473' });
  assert.deepEqual(v.stops.map(s => [s.id, s.walkScale, s.rideScale]), [['mt/16058', -0.5, -2], ['mt/13337', 0, 0]]);
  assert.deepEqual(v.connections, [
    { id: 'mt/2|mt/16058', routeId: 'mt/2', stopId: 'mt/16058', name: 'Home' },
    { id: 'mt/2|mt/13337', routeId: 'mt/2', stopId: 'mt/13337', name: 'Work' },
  ]);
  assert.equal(v.units, 'metric');
  assert.equal(v.clock24, true);
  assert.equal(v.stopRadius, 300);
  assert.deepEqual(Object.keys(v.coverage), ['mt', 'sea', 'demo']);
  assert.equal(v.coverage.demo, null);
  const all = view.build(twoCities(), null, null);
  assert.deepEqual(all.providers, ['mt', 'sea', 'demo'], 'no position → every system');
  assert.equal(all.routes.length, 3);
});

test('prefs: watch values when given, else the locale guess and a 12 h clock', () => {
  assert.deepEqual(view.prefs({ units: 'metric', clock24: true, known: true }), { units: 'metric', clock24: true, known: true });
  assert.deepEqual(view.prefs(null, 'en-US'), { units: 'imperial', clock24: false, known: false });
  assert.deepEqual(view.prefs({}, 'de-DE'), { units: 'metric', clock24: false, known: false });
  assert.equal(view.guessUnits('en'), 'imperial');
  assert.equal(view.guessUnits('en_GB'), 'metric');
  assert.equal(view.guessUnits('my-MM'), 'imperial');
  assert.equal(view.guessUnits(''), 'metric');
});

test('bake: learned route / walk / ride weights into the saved scales; unknown keys ignored', () => {
  const baked = view.bake(twoCities(), { 'route:mt/2': -3, 'stop:mt/13337': -0.7, 'ride:mt/16058': -4, 'ride:sea/1_10914': -1.5,
    'route:mt/999': 5, 'conn:x|y': 1, 'stop:nope': 2, junk: 1 });
  assert.equal(baked.routes[0].scale, -3);
  assert.equal(baked.stops[1].walkScale, -0.7);
  assert.equal(baked.stops[0].rideScale, -4);
  assert.equal(baked.stops[0].walkScale, -0.5);
  assert.equal(baked.stops[2].rideScale, -1.5);
  assert.equal(baked.routes.length, 3);
  assert.deepEqual(view.bake(twoCities(), null), twoCities());
});

test('coverage auto: no positioned stop → the stored home area when it has a centre, else everywhere', () => {
  const c = settings.normalize({ providers: [{ id: 'a', type: 'mock', coverage: { mode: 'auto', lat: 44.97, lon: -93.26, radius: 60000 } },
    { id: 'b', type: 'mock' }], stops: [{ providerId: 'a', id: 's' }] });
  assert.deepEqual(view.coverage(c, 'a'), { lat: 44.97, lon: -93.26, radius: 60000 });
  assert.equal(view.coverage(c, 'b'), null);
  c.stops.push({ providerId: 'a', id: 't', lat: 45.1, lon: -93.1, walkScale: 0, rideScale: 0 });
  assert.deepEqual(view.coverage(c, 'a'), { lat: 45.1, lon: -93.1, radius: view.AUTO_MARGIN }, 'saved stops win');
});
