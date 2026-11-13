const test = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../src/common/settings');

test('defaults match the contract', () => {
  const d = settings.defaults();
  assert.equal(d.version, 1);
  assert.deepEqual(d.provider, { type: '', baseUrl: '', apiKey: '' }); // '' = the registry's default source
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
  assert.equal(d.defaultStopScale, -1);
  assert.equal(d.defaultRouteScale, -1);
  assert.equal(d.defaultConnectionScale, -1);
  assert.deepEqual(d.routes, []);
  assert.deepEqual(d.connections, []);
  assert.deepEqual(d.stopScales, {});
  assert.deepEqual(d.training, { autoTrain: true, learningRate: 0.05, iterations: 300, temperature: 60, regularization: 0.01, maxSamples: 200 });
});

test('defaults() returns independent copies', () => {
  const a = settings.defaults();
  a.routes.push({ id: 'x' });
  a.provider.apiKey = 'changed';
  const b = settings.defaults();
  assert.deepEqual(b.routes, []);
  assert.equal(b.provider.apiKey, '');
});

test('normalize never throws and fills defaults', () => {
  for (const raw of [undefined, null, 0, 'str', [], [1, 2], { routes: 'nope' }, { provider: 5 }, { training: [] },
    { connections: [null, 3, 'x'] }, { stopScales: [1] }, { location: 'here' }]) {
    const c = settings.normalize(raw);
    assert.deepEqual(Object.keys(c).sort(), Object.keys(settings.defaults()).sort(), JSON.stringify(raw));
    assert.ok(Array.isArray(c.routes) && Array.isArray(c.connections));
  }
});

test('normalize is idempotent and drops unknown fields', () => {
  const raw = { stopRadius: '250', foo: 1, routes: [{ id: ' 44 ', name: 'Forty four', scale: '-2', extra: true }] };
  const once = settings.normalize(raw);
  assert.deepEqual(settings.normalize(once), once);
  assert.equal(once.foo, undefined);
  assert.deepEqual(once.routes, [{ id: '44', name: 'Forty four', scale: -2, color: '' }]);
  assert.equal(once.stopRadius, 250);
});

test('numbers: strings coerced, garbage -> default, clamped, integers rounded', () => {
  const c = settings.normalize({ stopRadius: 'abc', routeRadius: 1e9, recentWindow: -5, lookahead: '30.6',
    maxItems: 99, pickupsPerItem: 0, defaultStopScale: '-0.5', refreshInterval: NaN, dropoffHorizon: Infinity });
  assert.equal(c.stopRadius, 300);
  assert.equal(c.routeRadius, 2000);
  assert.equal(c.recentWindow, 0);
  assert.equal(c.lookahead, 31);
  assert.equal(c.maxItems, 12);
  assert.equal(c.pickupsPerItem, 1);
  assert.equal(c.defaultStopScale, -0.5);
  assert.equal(c.refreshInterval, 60);
  assert.equal(c.dropoffHorizon, 120);
});

test('RANGES describes every numeric top-level field', () => {
  for (const f of ['stopRadius', 'routeRadius', 'recentWindow', 'lookahead', 'dropoffHorizon', 'maxStops',
    'pickupsPerItem', 'maxItems', 'refreshInterval', 'vehicleRadius', 'defaultStopScale', 'defaultRouteScale', 'defaultConnectionScale']) {
    const r = settings.RANGES[f];
    assert.ok(r && typeof r.min === 'number' && typeof r.max === 'number', f);
  }
  assert.deepEqual(settings.RANGES.stopRadius, { min: 10, max: 5000, integer: true });
});

test('training fields validated', () => {
  const c = settings.normalize({ training: { autoTrain: 'false', learningRate: 0, iterations: '20.2', temperature: -1, regularization: 500, maxSamples: 'x' } });
  assert.deepEqual(c.training, { autoTrain: false, learningRate: 0.0001, iterations: 20, temperature: 0.01, regularization: 100, maxSamples: 200 });
  assert.equal(settings.normalize({ training: { autoTrain: 0 } }).training.autoTrain, false);
  assert.equal(settings.normalize({ training: { autoTrain: 1 } }).training.autoTrain, true);
  assert.equal(settings.normalize({ training: { autoTrain: 'true' } }).training.autoTrain, true);
});

test('provider and location', () => {
  const c = settings.normalize({ provider: { type: 'mock', baseUrl: ' http://x/api/where/// ', apiKey: ' k ' },
    location: { mode: 'fixed', lat: 100, lon: '-200' } });
  assert.deepEqual(c.provider, { type: 'mock', baseUrl: 'http://x/api/where', apiKey: 'k' });
  assert.deepEqual(c.location, { mode: 'fixed', lat: 90, lon: -180 });
  const bad = settings.normalize({ provider: { type: 'Not An Id!' }, location: { mode: 'teleport' } });
  assert.equal(settings.normalize({ provider: { type: 'gtfs' } }).provider.type, 'gtfs'); // any plug-in id is allowed
  assert.equal(bad.provider.type, '');
  assert.equal(settings.normalize({ provider: { type: 'onebusaway' } }).provider.type, 'onebusaway');
  assert.equal(bad.location.mode, 'gps');
});

test('routes: invalid dropped, dedupe first wins, defaults filled from defaultRouteScale', () => {
  const c = settings.normalize({ defaultRouteScale: -3, routes: [
    { id: 'a', name: 'A', scale: -2 }, { id: '' }, { name: 'no id' }, null, { id: 'a', name: 'dup' },
    { id: 'b' }, { id: 'c', scale: 'bad' }] });
  assert.deepEqual(c.routes, [
    { id: 'a', name: 'A', scale: -2, color: '' }, { id: 'b', name: 'b', scale: -3, color: '' }, { id: 'c', name: 'c', scale: -3, color: '' }]);
});

test('connections: id recomputed, dedupe, defaults', () => {
  const c = settings.normalize({ connections: [
    { id: 'wrong', routeId: ' r1 ', stopId: 's1', name: 'Home', scale: -4 },
    { routeId: 'r1', stopId: 's1', name: 'dup' },
    { routeId: 'r1' }, { stopId: 's2' },
    { routeId: 'r2', stopId: 's9' }] });
  assert.deepEqual(c.connections, [
    { id: 'r1|s1', routeId: 'r1', stopId: 's1', name: 'Home', scale: -4 },
    { id: 'r2|s9', routeId: 'r2', stopId: 's9', name: 's9', scale: -1 }]);
  assert.equal(settings.connectionId('x', 'y'), 'x|y');
});

test('stopScales keep only finite numbers with non-empty keys', () => {
  const c = settings.normalize({ stopScales: { ' s1 ': '-2', s2: 'x', '': 3, s3: null, s4: 0.5 } });
  assert.deepEqual(c.stopScales, { s1: -2, s4: 0.5 });
});

test('parse handles bad JSON', () => {
  assert.deepEqual(settings.parse('not json'), settings.defaults());
  assert.deepEqual(settings.parse(''), settings.defaults());
  assert.deepEqual(settings.parse(null), settings.defaults());
  assert.equal(settings.parse('{"maxItems": 5}').maxItems, 5);
});

test('route colors: hex normalized to RRGGBB upper case, anything else -> ""', () => {
  const c = settings.normalize({ routes: [
    { id: 'a', color: '#771473' }, { id: 'b', color: '00539f' }, { id: 'c', color: ' #ABCDEF ' },
    { id: 'd', color: 'red' }, { id: 'e', color: '#abc' }, { id: 'f', color: 123456 }, { id: 'g' }] });
  assert.deepEqual(c.routes.map(r => r.color), ['771473', '00539F', 'ABCDEF', '', '', '', '']);
  assert.equal(settings.color('#00aa55'), '00AA55');
  assert.equal(settings.color(null), '');
});

test('vehicleRadius validated', () => {
  assert.equal(settings.normalize({ vehicleRadius: '5' }).vehicleRadius, 10);
  assert.equal(settings.normalize({ vehicleRadius: 400.4 }).vehicleRadius, 400);
});

test('units, schedule defaults and ranges', () => {
  const d = settings.defaults();
  assert.equal(d.units, 'imperial');
  assert.deepEqual(d.destinations, []);
  assert.deepEqual(d.schedule, { leadMinutes: 15, walkSpeed: 1.3, maxWalk: 800, transferWalk: 250, maxTransfers: 1,
    minTransfer: 120, leaveReminder: true, fallbackMinutes: 60 });
  const c = settings.normalize({ units: 'metric', schedule: { leadMinutes: '500', walkSpeed: 0, maxTransfers: 3.7, leaveReminder: 'false' } });
  assert.equal(c.units, 'metric');
  assert.equal(c.schedule.leadMinutes, 120);
  assert.equal(c.schedule.walkSpeed, 0.3);
  assert.equal(c.schedule.maxTransfers, 1);
  assert.equal(c.schedule.leaveReminder, false);
  assert.equal(settings.normalize({ units: 'furlongs' }).units, 'imperial');
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
