const test = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../src/common/settings');

const P = [{ id: 'p', type: 'mock' }];   // one system for list tests

test('defaults match the contract', () => {
  const d = settings.defaults();
  assert.equal(d.version, 2);
  assert.deepEqual(d.providers, [{ id: 'metrotransit', type: 'metrotransit', name: '', baseUrl: '', apiKey: '',
    coverage: { mode: 'auto', lat: 0, lon: 0, radius: 50000 } }]);
  assert.deepEqual(d.location, { mode: 'gps', lat: 0, lon: 0 });
  assert.equal(d.stopRadius, 300);
  assert.equal(d.routeRadius, 80);
  assert.equal(d.recentWindow, 180);
  assert.equal(d.lookahead, 60);
  assert.equal(d.dropoffHorizon, 120);
  assert.equal(d.maxStops, 4);
  assert.equal(d.pickupsPerItem, 3);
  assert.equal(d.maxItems, 10);
  assert.equal(d.refreshInterval, 60);
  assert.equal(d.vehicleRadius, 250);
  assert.deepEqual(d.routes, []);
  assert.deepEqual(d.stops, []);
  for (const gone of ['provider', 'connections', 'stopScales', 'defaultStopScale', 'defaultRouteScale', 'defaultConnectionScale',
    'units', 'clock24']) assert.equal(d[gone], undefined, gone);
  assert.deepEqual(d.training, { autoTrain: true, learningRate: 0.05, iterations: 300, temperature: 60, regularization: 0.01, maxSamples: 200 });
});

test('defaults() returns independent copies', () => {
  const a = settings.defaults();
  a.routes.push({ id: 'x' });
  a.providers[0].apiKey = 'changed';
  const b = settings.defaults();
  assert.deepEqual(b.routes, []);
  assert.equal(b.providers[0].apiKey, '');
});

test('normalize never throws and fills defaults', () => {
  for (const raw of [undefined, null, 0, 'str', [], [1, 2], { routes: 'nope' }, { providers: 5 }, { training: [] },
    { stops: [null, 3, 'x'] }, { providers: [null, 1, { type: 'BAD ID' }] }, { location: 'here' }, { version: 2, providers: [] }]) {
    const c = settings.normalize(raw);
    assert.deepEqual(Object.keys(c).sort(), Object.keys(settings.defaults()).sort(), JSON.stringify(raw));
    assert.ok(Array.isArray(c.routes) && Array.isArray(c.stops) && Array.isArray(c.providers));
  }
});

test('normalize is idempotent and drops unknown fields', () => {
  const raw = { version: 2, providers: P, stopRadius: '250', foo: 1,
    routes: [{ providerId: 'p', id: ' 44 ', name: 'Forty four', scale: '-2', extra: true }],
    stops: [{ providerId: 'p', id: 's', lat: '44.9', lon: -93.2, walkScale: '-1' }] };
  const once = settings.normalize(raw);
  assert.deepEqual(settings.normalize(once), once);
  assert.equal(once.foo, undefined);
  assert.deepEqual(once.routes, [{ providerId: 'p', id: '44', name: 'Forty four', scale: -2, color: '' }]);
  assert.deepEqual(once.stops, [{ providerId: 'p', id: 's', name: 's', lat: 44.9, lon: -93.2, walkScale: -1, rideScale: 0 }]);
  assert.equal(once.stopRadius, 250);
});

test('numbers: strings coerced, garbage -> default, clamped, integers rounded', () => {
  const c = settings.normalize({ version: 2, providers: P, stopRadius: 'abc', routeRadius: 1e9, recentWindow: -5, lookahead: '30.6',
    maxItems: 99, pickupsPerItem: 0, refreshInterval: NaN, dropoffHorizon: Infinity });
  assert.equal(c.stopRadius, 300);
  assert.equal(c.routeRadius, 2000);
  assert.equal(c.recentWindow, 0);
  assert.equal(c.lookahead, 31);
  assert.equal(c.maxItems, 12);
  assert.equal(c.pickupsPerItem, 1);
  assert.equal(c.refreshInterval, 60);
  assert.equal(c.dropoffHorizon, 120);
});

test('RANGES describes every numeric top-level field', () => {
  for (const f of ['stopRadius', 'routeRadius', 'recentWindow', 'lookahead', 'dropoffHorizon', 'maxStops',
    'pickupsPerItem', 'maxItems', 'refreshInterval', 'vehicleRadius']) {
    const r = settings.RANGES[f];
    assert.ok(r && typeof r.min === 'number' && typeof r.max === 'number', f);
  }
  assert.deepEqual(settings.RANGES.stopRadius, { min: 10, max: 5000, integer: true });
  assert.deepEqual(Object.keys(settings.RANGES).length, 10);
});

test('training fields validated', () => {
  const c = settings.normalize({ training: { autoTrain: 'false', learningRate: 0, iterations: '20.2', temperature: -1, regularization: 500, maxSamples: 'x' } });
  assert.deepEqual(c.training, { autoTrain: false, learningRate: 0.0001, iterations: 20, temperature: 0.01, regularization: 100, maxSamples: 200 });
  assert.equal(settings.normalize({ training: { autoTrain: 0 } }).training.autoTrain, false);
  assert.equal(settings.normalize({ training: { autoTrain: 1 } }).training.autoTrain, true);
  assert.equal(settings.normalize({ training: { autoTrain: 'true' } }).training.autoTrain, true);
});

test('providers: type must be an id, ids kept or derived from the type, coverage validated, max 8', () => {
  const c = settings.normalize({ version: 2, providers: [
    { id: 'home', type: 'metrotransit', name: ' Twin Cities ', baseUrl: ' http://x/api/where/// ', apiKey: ' k ',
      coverage: { mode: 'manual', lat: 100, lon: '-200', radius: '20' } },
    { type: 'Not An Id!' }, null, { id: 'home', type: 'onebusaway' }, { type: 'onebusaway', coverage: { mode: 'teleport', radius: 1e9 } },
    { id: 'Bad Id', type: 'gtfs' }] });
  assert.deepEqual(c.providers, [
    { id: 'home', type: 'metrotransit', name: 'Twin Cities', baseUrl: 'http://x/api/where', apiKey: 'k',
      coverage: { mode: 'manual', lat: 90, lon: -180, radius: 1000 } },
    { id: 'onebusaway', type: 'onebusaway', name: '', baseUrl: '', apiKey: '', coverage: { mode: 'auto', lat: 0, lon: 0, radius: 50000 } },
    { id: 'onebusaway-2', type: 'onebusaway', name: '', baseUrl: '', apiKey: '', coverage: { mode: 'auto', lat: 0, lon: 0, radius: 500000 } },
    { id: 'gtfs', type: 'gtfs', name: '', baseUrl: '', apiKey: '', coverage: { mode: 'auto', lat: 0, lon: 0, radius: 50000 } },
  ]);
  assert.deepEqual(settings.normalize({ version: 2, providers: [] }).providers, [], 'no systems is allowed');
  const many = settings.normalize({ providers: Array.from({ length: 12 }, () => ({ type: 'mock' })) });
  assert.equal(many.providers.length, settings.MAX_PROVIDERS);
  assert.equal(settings.freeId('mock', { mock: true, 'mock-2': true }), 'mock-3');
});

test('location', () => {
  assert.deepEqual(settings.normalize({ location: { mode: 'fixed', lat: 100, lon: '-200' } }).location, { mode: 'fixed', lat: 90, lon: -180 });
  assert.equal(settings.normalize({ location: { mode: 'teleport' } }).location.mode, 'gps');
});

test('routes: need a known system and an id, dedupe per system, scale defaults to 0', () => {
  const c = settings.normalize({ version: 2, providers: [{ id: 'p', type: 'mock' }, { id: 'q', type: 'mock' }], routes: [
    { providerId: 'p', id: 'a', name: 'A', scale: -2 }, { providerId: 'p', id: '' }, { providerId: 'p', name: 'no id' }, null,
    { providerId: 'p', id: 'a', name: 'dup' }, { providerId: 'q', id: 'a' }, { providerId: 'zz', id: 'b' }, { id: 'c' },
    { providerId: 'p', id: 'c', scale: 'bad' }, { providerId: 'p', id: 'd', scale: -5000 }] });
  assert.deepEqual(c.routes, [
    { providerId: 'p', id: 'a', name: 'A', scale: -2, color: '' }, { providerId: 'q', id: 'a', name: 'a', scale: 0, color: '' },
    { providerId: 'p', id: 'c', name: 'c', scale: 0, color: '' }, { providerId: 'p', id: 'd', name: 'd', scale: -1000, color: '' }]);
});

test('stops: need a known system and an id, optional position (both or neither), walk and ride scales default to 0', () => {
  const c = settings.normalize({ version: 2, providers: P, stops: [
    { providerId: 'p', id: ' s1 ', name: ' Home ', lat: '44.9', lon: '-93.2', walkScale: '-0.5', rideScale: -2 },
    { providerId: 'p', id: 's1', name: 'dup' }, { providerId: 'p' }, { providerId: 'x', id: 's2' },
    { providerId: 'p', id: 's3', lat: 44.9 }, { providerId: 'p', id: 's4', lat: 'x', lon: 3, walkScale: 'no' }] });
  assert.deepEqual(c.stops, [
    { providerId: 'p', id: 's1', name: 'Home', lat: 44.9, lon: -93.2, walkScale: -0.5, rideScale: -2 },
    { providerId: 'p', id: 's3', name: 's3', lat: null, lon: null, walkScale: 0, rideScale: 0 },
    { providerId: 'p', id: 's4', name: 's4', lat: null, lon: null, walkScale: 0, rideScale: 0 }]);
  assert.equal(settings.connectionId('x', 'y'), 'x|y');
});

test('version 1 configs migrate: one system, pinned stops and stop scales become stops, their routes saved', () => {
  const v1 = { version: 1, provider: { type: 'onebusaway', baseUrl: 'https://oba/', apiKey: 'k' },
    defaultRouteScale: -1, defaultConnectionScale: -1.5, units: 'metric', clock24: true, maxItems: 7,
    routes: [{ id: '44', name: 'Forty four', color: '1e88e5' }, { id: '43', scale: -2 }],
    connections: [{ routeId: '44', stopId: 'home', name: 'Home', scale: -3 }, { routeId: '45', stopId: 'work', name: 'Work' },
                  { routeId: '43', stopId: 'home' }],
    stopScales: { home: -0.5, corner: -2 } };
  assert.ok(settings.isV1(v1) && settings.isV1({}) && !settings.isV1({ version: 2 }) && !settings.isV1({ providers: [] }));
  const c = settings.normalize(v1);
  assert.equal(c.version, 2);
  assert.deepEqual(c.providers.map(p => [p.id, p.type, p.baseUrl, p.apiKey]), [['onebusaway', 'onebusaway', 'https://oba', 'k']]);
  assert.deepEqual(c.routes, [
    { providerId: 'onebusaway', id: '44', name: 'Forty four', scale: -1, color: '1E88E5' },
    { providerId: 'onebusaway', id: '43', name: '43', scale: -2, color: '' },
    { providerId: 'onebusaway', id: '45', name: '45', scale: 0, color: '' }]);
  assert.deepEqual(c.stops.map(s => [s.id, s.name, s.walkScale, s.rideScale]),
    [['home', 'Home', -0.5, -3], ['work', 'Work', 0, -1.5], ['corner', 'corner', -2, 0]]);
  assert.equal(c.maxItems, 7);
  assert.equal(c.units, undefined);
  assert.equal(settings.normalize({ provider: { type: '' } }).providers[0].type, 'metrotransit', "'' was the default source");
  assert.deepEqual(settings.normalize(c), c);
});

test('migrateKey: version 1 feature keys name the system', () => {
  assert.equal(settings.migrateKey('stop:16058', 'mt'), 'stop:mt/16058');
  assert.equal(settings.migrateKey('route:2', 'mt'), 'route:mt/2');
  assert.equal(settings.migrateKey('conn:2|16058', 'mt'), 'ride:mt/16058');
  assert.equal(settings.migrateKey('stop:mt/16058', 'mt'), 'stop:mt/16058', 'already migrated');
  assert.equal(settings.migrateKey('flip', 'mt'), 'flip');
  assert.equal(settings.migrateKey('conn:nobar', 'mt'), 'conn:nobar');
});

test('parse handles bad JSON', () => {
  assert.deepEqual(settings.parse('not json'), settings.defaults());
  assert.deepEqual(settings.parse(''), settings.defaults());
  assert.deepEqual(settings.parse(null), settings.defaults());
  assert.equal(settings.parse('{"maxItems": 5}').maxItems, 5);
  assert.equal(settings.parse('{"version": 2, "providers": []}').providers.length, 0);
});

test('route colors: hex normalized to RRGGBB upper case, anything else -> ""', () => {
  const c = settings.normalize({ version: 2, providers: P, routes: [
    { id: 'a', color: '#771473' }, { id: 'b', color: '00539f' }, { id: 'c', color: ' #ABCDEF ' },
    { id: 'd', color: 'red' }, { id: 'e', color: '#abc' }, { id: 'f', color: 123456 }, { id: 'g' }].map(r => Object.assign({ providerId: 'p' }, r)) });
  assert.deepEqual(c.routes.map(r => r.color), ['771473', '00539F', 'ABCDEF', '', '', '', '']);
  assert.equal(settings.color('#00aa55'), '00AA55');
  assert.equal(settings.color(null), '');
});

test('vehicleRadius validated', () => {
  assert.equal(settings.normalize({ vehicleRadius: '5' }).vehicleRadius, 10);
  assert.equal(settings.normalize({ vehicleRadius: 400.4 }).vehicleRadius, 400);
});

test('schedule defaults and ranges', () => {
  const d = settings.defaults();
  assert.deepEqual(d.destinations, []);
  assert.deepEqual(d.schedule, { leadMinutes: 15, walkSpeed: 1.3, maxWalk: 800, transferWalk: 250, maxTransfers: 1,
    minTransfer: 120, leaveReminder: true, fallbackMinutes: 60 });
  const c = settings.normalize({ schedule: { leadMinutes: '500', walkSpeed: 0, maxTransfers: 3.7, leaveReminder: 'false' } });
  assert.equal(c.schedule.leadMinutes, 120);
  assert.equal(c.schedule.walkSpeed, 0.3);
  assert.equal(c.schedule.maxTransfers, 1);
  assert.equal(c.schedule.leaveReminder, false);
});

test('destinations: validated, ids kept or generated, max 8', () => {
  const c = settings.normalize({ destinations: [
    { id: 'work', name: ' Work ', lat: '44.97', lon: -93.26, arriveBy: '9:05', days: [5, 1, '2', 1, 7, 'x'], enabled: 0 },
    { name: 'No coords', arriveBy: '10:00' },
    { lat: 44.9, lon: -93.2, arriveBy: '25:00' },
    { lat: 44.9, lon: -93.2, arriveBy: '17:30' },
    { id: 'work', lat: 1, lon: 2, arriveBy: '08:00' },
    { id: 'dest1', name: 'Gym', lat: 1, lon: 2, arriveBy: '18:00' },
  ] });
  assert.deepEqual(c.destinations, [
    { id: 'work', name: 'Work', lat: 44.97, lon: -93.26, arriveBy: '09:05', days: [1, 2, 5], enabled: false },
    { id: 'dest2', name: 'Destination 2', lat: 44.9, lon: -93.2, arriveBy: '17:30', days: [], enabled: true },
    { id: 'dest1', name: 'Gym', lat: 1, lon: 2, arriveBy: '18:00', days: [], enabled: true },
  ]);
  const many = settings.normalize({ destinations: Array.from({ length: 12 }, (_, i) => ({ lat: 1, lon: 1, arriveBy: '08:' + String(i).padStart(2, '0') })) });
  assert.equal(many.destinations.length, settings.MAX_DESTINATIONS);
  assert.equal(new Set(many.destinations.map(d => d.id)).size, 8);
});
