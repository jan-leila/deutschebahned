// Several transit systems behind one provider (CONTRACTS.md §3a).
const test = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../src/common/settings');
const { createFederation, fromConfig } = require('../src/common/federation');
const { createRegistry } = require('../src/sources/registry');

const call = (fn, ...args) => new Promise((resolve, reject) => fn(...args, (err, v) => (err ? reject(err) : resolve(v))));
const later = (cb, err, v) => setTimeout(() => cb(err, v), 0);

// a fake system: one route 'R' with stops 'a', 'b' at its own position
function fake(at, opts = {}) {
  const calls = [];
  const p = {
    calls,
    stopsNear(pos, r, cb) {
      calls.push('stopsNear');
      if (opts.fail) return later(cb, new Error('down'));
      later(cb, null, [{ id: 'a', name: 'A', lat: at.lat, lon: at.lon, routeIds: ['R'] }]);
    },
    arrivals(stopId, b, a, cb) {
      calls.push('arrivals ' + stopId + ' ' + b + ' ' + a);
      later(cb, null, [{ stopId, routeId: 'R', tripKey: 't1', time: 100, predicted: true, headsign: 'Out' }]);
    },
    route(id, cb) {
      calls.push('route ' + id);
      later(cb, null, { id, shortName: 'R', color: 'FF0000', directions: [{ id: '0', name: 'Out', stopIds: ['a', 'b'], paths: [[at]] }],
        stops: { a: { id: 'a', name: 'A', lat: at.lat, lon: at.lon }, b: { id: 'b', name: 'B', lat: at.lat, lon: at.lon } } });
    },
    stopInfo(id, cb) { later(cb, null, { id, name: 'A', lat: at.lat, lon: at.lon }); },
  };
  if (opts.vehicles) p.vehicles = (id, cb) => later(cb, null, [{ tripKey: 't1', routeId: id, directionId: '0', lat: at.lat, lon: at.lon, time: 90 }]);
  return p;
}

const HERE = { lat: 45, lon: -93 };
const FAR = { lat: 47, lon: -122 };

test('stopsNear asks only covering systems, prefixes ids, merges nearest first', async () => {
  const near = fake({ lat: 45.001, lon: -93 }), near2 = fake({ lat: 45.0005, lon: -93 }), far = fake(FAR);
  const f = createFederation([
    { id: 'n', provider: near, covers: () => true },
    { id: 'm', provider: near2 },
    { id: 'f', provider: far, covers: pos => pos.lat > 46 },
  ]);
  const stops = await call(f.stopsNear, HERE, 500);
  assert.deepEqual(stops.map(s => [s.id, s.routeIds]), [['m/a', ['m/R']], ['n/a', ['n/R']]]);
  assert.deepEqual(far.calls, [], 'a system that does not cover the position is not asked');
});

test('stopsNear: some systems failing is fine, all failing is an error, none covering is []', async () => {
  const ok = fake(HERE), bad = fake(HERE, { fail: true });
  assert.equal((await call(createFederation([{ id: 'a', provider: ok }, { id: 'b', provider: bad }]).stopsNear, HERE, 100)).length, 1);
  await assert.rejects(call(createFederation([{ id: 'b', provider: bad }]).stopsNear, HERE, 100), /down/);
  assert.deepEqual(await call(createFederation([{ id: 'a', provider: ok, covers: () => false }]).stopsNear, HERE, 100), []);
  assert.deepEqual(await call(createFederation([]).stopsNear, HERE, 100), []);
});

test('arrivals / route / stopInfo go to the system the ref names; results use refs', async () => {
  const a = fake(HERE), b = fake(FAR);
  const f = createFederation([{ id: 'a', provider: a }, { id: 'b', provider: b }]);
  const arr = await call(f.arrivals, 'b/x:1', 2, 30);
  assert.deepEqual(arr, [{ stopId: 'b/x:1', routeId: 'b/R', tripKey: 'b/t1', time: 100, predicted: true, headsign: 'Out' }]);
  assert.deepEqual(b.calls, ['arrivals x:1 2 30']);
  assert.deepEqual(a.calls, []);
  const r = await call(f.route, 'a/R');
  assert.equal(r.id, 'a/R');
  assert.deepEqual(r.directions[0].stopIds, ['a/a', 'a/b']);
  assert.deepEqual(Object.keys(r.stops), ['a/a', 'a/b']);
  assert.equal(r.stops['a/b'].id, 'a/b');
  assert.deepEqual(r.directions[0].paths, [[HERE]]);
  assert.equal(r.color, 'FF0000');
  assert.deepEqual(await call(f.stopInfo, 'b/a'), { id: 'b/a', name: 'A', lat: FAR.lat, lon: FAR.lon });
  await assert.rejects(call(f.arrivals, 'zz/a', 0, 1), /unknown transit system/);
  await assert.rejects(call(f.route, 'noslash'), /unknown transit system/);
  await assert.rejects(call(f.routeInfo, 'a/R'), /can't routeInfo/);
});

test('vehicles: prefixed; a system without live positions reports none', async () => {
  const f = createFederation([{ id: 'live', provider: fake(HERE, { vehicles: true }) }, { id: 'oba', provider: fake(HERE) }]);
  assert.deepEqual(await call(f.vehicles, 'live/R'),
    [{ tripKey: 'live/t1', routeId: 'live/R', directionId: '0', lat: HERE.lat, lon: HERE.lon, time: 90 }]);
  assert.deepEqual(await call(f.vehicles, 'oba/R'), []);
});

test('fromConfig: one member per system (registry.createFor with its own routes), covers = its coverage area', async () => {
  const created = [];
  const reg = createRegistry([{ type: 'x', create(options, ctx) { created.push({ options, ctx }); return fake(HERE); } }]);
  const config = settings.normalize({
    providers: [{ id: 'one', type: 'x', baseUrl: 'https://one/' }, { id: 'two', type: 'x', apiKey: 'k',
      coverage: { mode: 'manual', lat: FAR.lat, lon: FAR.lon, radius: 10000 } }],
    routes: [{ providerId: 'one', id: '1', name: 'Uno' }, { providerId: 'two', id: '2' }],
  });
  const f = fromConfig(reg, config, { http: () => {}, clock: () => 0 });
  assert.deepEqual(created.map(c => [c.options, c.ctx.routeIds, c.ctx.routes]), [
    [{ baseUrl: 'https://one', apiKey: '' }, ['1'], [{ id: '1', name: 'Uno' }]],
    [{ baseUrl: '', apiKey: 'k' }, ['2'], [{ id: '2', name: '2' }]],
  ]);
  assert.deepEqual(f.members().map(m => [m.id, m.covers(HERE), m.covers(FAR)]), [['one', true, true], ['two', false, true]]);
  assert.deepEqual((await call(f.stopsNear, HERE, 100)).map(s => s.id), ['one/a']);
});
