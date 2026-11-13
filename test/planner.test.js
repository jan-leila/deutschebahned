const test = require('node:test');
const assert = require('node:assert/strict');
const geo = require('../src/common/geo');
const settings = require('../src/common/settings');
const planner = require('../src/common/planner');

// ---- a small hand-built world -------------------------------------------------------------
// Route R runs west -> east through P (direction '0'); direction '1' runs back on a parallel street 500 m south.
// Stops along direction 0 (meters east of P): R:a -800, R:b -100, R:c +600, R:d +900 (pinned "Home").
const P = { lat: 47.6, lon: -122.3 };
const east = m => geo.offset(P, Math.abs(m), m >= 0 ? 90 : 270);
const south500 = m => geo.offset(east(m), 500, 180);
const pos = geo.offset(P, 20, 0); // 20 m north of the line, 100 m past R:b (the stop a bus would have just passed)
const NOW = 1_000_000;

const stop = (id, name, p, routeIds) => ({ id, name, lat: p.lat, lon: p.lon, routeIds });
const routeR = {
  id: 'R', shortName: '7',
  directions: [
    { id: '0', name: 'East', stopIds: ['R:a', 'R:b', 'R:c', 'R:d'], paths: [[east(-1000), east(1000)]] },
    { id: '1', name: 'West', stopIds: ['R:x', 'R:y'], paths: [[south500(1000), south500(-1000)]] },
  ],
  stops: {
    'R:a': { id: 'R:a', name: 'A St', ...east(-800) },
    'R:b': { id: 'R:b', name: 'B St', ...east(-100) },
    'R:c': { id: 'R:c', name: 'C St', ...east(600) },
    'R:d': { id: 'R:d', name: 'D St', ...east(900) },
    'R:x': { id: 'R:x', name: 'X St', ...south500(800) },
    'R:y': { id: 'R:y', name: 'Y St', ...south500(-800) },
  },
};
const routeQ = { id: 'Q', shortName: 'Q', color: '', directions: [], stops: {} };
const arr = (stopId, routeId, tripKey, dt) => ({ stopId, routeId, tripKey, time: NOW + dt, predicted: true, headsign: '' });

// the planner gets a runtime view (view.build): routes [{id, name, scale, color}], connections, scalar fields
function config(extra) {
  const d = settings.defaults();
  delete d.providers;
  delete d.stops;
  return Object.assign(d, {
    stopRadius: 300, routeRadius: 80, recentWindow: 180, lookahead: 60, dropoffHorizon: 120, maxStops: 4, pickupsPerItem: 3,
    routes: [{ id: 'R', name: 'Red' }, { id: 'Q' }],
    connections: [{ routeId: 'R', stopId: 'R:d', name: 'Home' }],
  }, extra || {}, {
    routes: ((extra && extra.routes) || [{ id: 'R', name: 'Red' }, { id: 'Q' }]).map(r => Object.assign({ name: r.id, scale: 0, color: '' }, r)),
    connections: ((extra && extra.connections) || [{ routeId: 'R', stopId: 'R:d', name: 'Home' }])
      .map(c => Object.assign({ id: c.routeId + '|' + c.stopId, name: c.stopId }, c)),
  });
}

// ---- pickHereStop --------------------------------------------------------------------------

test('pickHereStop: nearest stop strictly before the pinned stop', () => {
  assert.equal(planner.pickHereStop(routeR.directions[0], routeR, 'R:d', pos), 'R:b');
  // standing near C: C is before D, so C
  assert.equal(planner.pickHereStop(routeR.directions[0], routeR, 'R:d', east(650)), 'R:c');
  // pinned is C: D is after it and must not be picked even when nearest
  assert.equal(planner.pickHereStop(routeR.directions[0], routeR, 'R:c', east(890)), 'R:b');
  // pinned is the first stop -> nothing
  assert.equal(planner.pickHereStop(routeR.directions[0], routeR, 'R:a', pos), null);
});

test('pickHereStop ignores stop ids missing from route.stops', () => {
  const r = { ...routeR, stops: { ...routeR.stops } };
  delete r.stops['R:b'];
  assert.equal(planner.pickHereStop(r.directions[0], r, 'R:d', pos), 'R:a');
});

// ---- buildItems: pickups -----------------------------------------------------------------------

test('pickups: one item per nearby stop x configured route, first N times, features', () => {
  const sB = stop('R:b', 'B St', east(-100), ['R', 'Q', 'Z']);
  const data = {
    stops: [sB], routes: {}, errors: [],
    arrivals: { 'R:b': [arr('R:b', 'R', 't0', -40), arr('R:b', 'R', 't1', -20), arr('R:b', 'Q', 'q1', 100),
      arr('R:b', 'R', 't2', 200), arr('R:b', 'Z', 'z1', 250), arr('R:b', 'R', 't3', 800), arr('R:b', 'R', 't4', 1400)] },
  };
  const items = planner.buildItems(config(), data, pos, NOW);
  assert.equal(items.length, 2);
  const [r, q] = items;
  assert.deepEqual(r, {
    kind: 'pickup', key: 'pickup:R:b:R', badge: 'Red', title: 'B St', color: '0055AA', times: [NOW - 20, NOW + 200, NOW + 800],
    routeId: 'R', stopId: 'R:b', routeLongName: '',
    features: { 'stop:R:b': Math.round(geo.distance(pos, sB)), 'route:R': 0 },
    bearing: geo.bearing(pos, sB), distance: geo.distance(pos, sB),
    walk: Math.ceil(geo.distance(pos, sB) / 1.3),   // seconds at the default 1.3 m/s
    dir: '', // route R not in data.routes -> no direction label
    lanes: [{ stopId: 'R:b', dir: '', times: [NOW - 20, NOW + 200, NOW + 800] }],
  });
  assert.equal(q.title, 'B St');
  assert.equal(q.badge, 'Q');
  assert.equal(q.color, 'AA0000', 'second configured route -> second default color');
  assert.deepEqual(q.times, [NOW + 100]);
  assert.deepEqual(q.features, { 'stop:R:b': Math.round(geo.distance(pos, sB)), 'route:Q': 100 });
});

test('pickups: respects pickupsPerItem, skips routes with no times, follows config.routes order', () => {
  const s1 = stop('S1', 'One', east(50), ['Q', 'R']);
  const s2 = stop('S2', 'Two', east(150), ['R']);
  const data = { stops: [s1, s2], routes: {}, errors: [], arrivals: {
    S1: [arr('S1', 'Q', 'a', 60), arr('S1', 'R', 'b', 30), arr('S1', 'R', 'c', 90)],
    S2: [] } };
  const items = planner.buildItems(config({ pickupsPerItem: 1, connections: [] }), data, pos, NOW);
  assert.deepEqual(items.map(i => i.key), ['pickup:S1:R', 'pickup:S1:Q']);
  assert.deepEqual(items[0].times, [NOW + 30]);
});

test('pickups: stops whose arrivals failed are skipped', () => {
  const data = { stops: [stop('S1', 'One', east(50), ['R'])], routes: {}, errors: ['boom'], arrivals: {} };
  assert.deepEqual(planner.buildItems(config({ connections: [] }), data, pos, NOW), []);
});

// ---- buildItems: drop-offs ------------------------------------------------------------------

function dropoffData(hereArr, pinnedArr) {
  return { stops: [], routes: { R: routeR }, errors: [], arrivals: { 'R:b': hereArr, 'R:d': pinnedArr } };
}

test('dropoff: on-bus (recent) and next bus, matched by tripKey', () => {
  const data = dropoffData(
    [arr('R:b', 'R', 't1', -200), arr('R:b', 'R', 't2', -60), arr('R:b', 'R', 't3', 300), arr('R:b', 'R', 't4', 900)],
    [arr('R:d', 'R', 't1', -10), arr('R:d', 'R', 't2', 120), arr('R:d', 'R', 't3', 480), arr('R:d', 'R', 't4', 1080)]);
  const items = planner.buildItems(config(), data, pos, NOW);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    kind: 'dropoff', key: 'dropoff:R|R:d', badge: 'Red', title: 'Home', color: '0055AA', times: [NOW + 120, NOW + 480, NOW + 300],
    routeId: 'R', stopId: 'R:d', hereStopId: 'R:b', routeLongName: '',
    features: { 'ride:R:d': 20, 'route:R': 120 },
    bearing: geo.bearing(pos, routeR.stops['R:d']),
    distance: items[0].distance, // checked below
    dir: 'EB', lanes: [],
  });
  assert.ok(Math.abs(items[0].distance - 900) < 2, 'left to ride: along the path from pos (P) to D (+900 m)');
});

test('dropoff: latest recent bus wins; buses outside the window are not "on"', () => {
  const data = dropoffData(
    [arr('R:b', 'R', 'old', -170), arr('R:b', 'R', 'new', -30), arr('R:b', 'R', 'nx', 400)],
    [arr('R:d', 'R', 'old', 200), arr('R:d', 'R', 'new', 300), arr('R:d', 'R', 'nx', 900)]);
  assert.deepEqual(planner.buildItems(config(), data, pos, NOW)[0].times, [NOW + 300, NOW + 900, NOW + 400]);
  const narrow = planner.buildItems(config({ recentWindow: 20 }), data, pos, NOW)[0];
  assert.deepEqual(narrow.times, [0, NOW + 900, NOW + 400]);
  assert.equal(narrow.features['route:R'], 900);
});

test('dropoff: the "next" bus must also reach the pinned stop; no match -> no item', () => {
  const data = dropoffData([arr('R:b', 'R', 'a', 100), arr('R:b', 'R', 'b', 700)], [arr('R:d', 'R', 'b', 1000)]);
  assert.deepEqual(planner.buildItems(config(), data, pos, NOW)[0].times, [0, NOW + 1000, NOW + 700]);
  const none = dropoffData([arr('R:b', 'R', 'a', 100)], [arr('R:d', 'R', 'zzz', 1000)]);
  assert.deepEqual(planner.buildItems(config(), none, pos, NOW), []);
});

test('dropoff: ignores arrivals of other routes at the same stops', () => {
  const data = dropoffData([arr('R:b', 'Q', 'a', -30), arr('R:b', 'R', 'b', 60)], [arr('R:d', 'Q', 'a', 100), arr('R:d', 'R', 'b', 400)]);
  assert.deepEqual(planner.buildItems(config(), data, pos, NOW)[0].times, [0, NOW + 400, NOW + 60]);
});

test('dropoff: off-route (beyond routeRadius) or unknown route/stop -> no item', () => {
  const data = dropoffData([arr('R:b', 'R', 'b', 60)], [arr('R:d', 'R', 'b', 400)]);
  const far = geo.offset(P, 200, 0);
  assert.deepEqual(planner.buildItems(config(), data, far, NOW), []);
  assert.equal(planner.buildItems(config({ routeRadius: 250 }), data, far, NOW).length, 1);
  assert.deepEqual(planner.buildItems(config({ connections: [{ routeId: 'R', stopId: 'nowhere' }] }), data, pos, NOW), []);
  assert.deepEqual(planner.buildItems(config({ connections: [{ routeId: 'Q', stopId: 'R:d' }] }), data, pos, NOW), []);
});

test('dropoff: route name falls back to shortName; pickups come before drop-offs', () => {
  const data = dropoffData([arr('R:b', 'R', 'b', 60)], [arr('R:d', 'R', 'b', 400)]);
  data.stops = [stop('R:b', 'B St', east(-100), ['R'])];
  const cfg = config({ routes: [{ id: 'Q' }] }); // R not configured as a route -> no pickup, shortName as badge
  const items = planner.buildItems(cfg, data, pos, NOW);
  assert.deepEqual(items.map(i => i.kind), ['dropoff']);
  assert.equal(items[0].badge, '7');
  assert.equal(items[0].title, 'Home');
  assert.equal(items[0].color, planner.DEFAULT_COLORS['R'.charCodeAt(0) % 8], 'unconfigured route: color by id hash');
  const both = planner.buildItems(config(), data, pos, NOW);
  assert.deepEqual(both.map(i => i.kind), ['pickup', 'dropoff']);
});

// ---- gather ------------------------------------------------------------------------------------

function fakeProvider(opts) {
  const calls = [];
  const p = {
    calls,
    stopsNear(where, radius, cb) {
      calls.push(['stopsNear', radius]);
      setTimeout(() => (opts.stopsErr ? cb(new Error(opts.stopsErr)) : cb(null, opts.stops)), 0);
    },
    arrivals(stopId, before, after, cb) {
      calls.push(['arrivals', stopId, before, after]);
      setTimeout(() => {
        if (opts.failStops && opts.failStops.includes(stopId)) return cb(new Error('fail ' + stopId));
        cb(null, (opts.arrivals || {})[stopId] || []);
      }, 0);
    },
    route(routeId, cb) {
      calls.push(['route', routeId]);
      setTimeout(() => (opts.routes[routeId] ? cb(null, opts.routes[routeId]) : cb(new Error('no route ' + routeId))), 0);
    },
  };
  if (opts.vehicles) {
    p.vehicles = (routeId, cb) => {
      calls.push(['vehicles', routeId]);
      setTimeout(() => (opts.vehicles instanceof Error ? cb(opts.vehicles) : cb(null, opts.vehicles[routeId] || [])), 0);
    };
  }
  return p;
}
const gather = (provider, cfg, where, cache) =>
  new Promise((resolve, reject) => planner.gather(provider, cfg, where, NOW, cache, (e, d) => (e ? reject(e) : resolve(d))));

test('gather: filters/limits stops, fetches routes once, union windows per stop', async () => {
  const stops = [stop('R:b', 'B St', east(-100), ['R']), stop('Z:1', 'Z', east(-120), ['Z']),
    stop('Q:1', 'Q1', east(130), ['Q', 'Z']), stop('Q:2', 'Q2', east(140), ['Q']), stop('Q:3', 'Q3', east(150), ['Q'])];
  const provider = fakeProvider({ stops, routes: { R: routeR, Q: routeQ }, arrivals: { 'R:b': [arr('R:b', 'R', 'x', 5)] } });
  const cache = {};
  const data = await gather(provider, config({ maxStops: 3 }), pos, cache);
  assert.deepEqual(data.stops.map(s => s.id), ['R:b', 'Q:1', 'Q:2']);
  assert.equal(data.routes.R, routeR);
  assert.equal(data.routes.Q, routeQ, 'every configured route is loaded (for colors), not only connection routes');
  assert.equal(cache.R, routeR);
  assert.deepEqual(provider.calls.filter(c => c[0] === 'route').map(c => c[1]).sort(), ['Q', 'R']);
  assert.deepEqual(data.arrivals['R:b'], [arr('R:b', 'R', 'x', 5)]);
  assert.deepEqual(data.errors, []);
  const arrivalCalls = provider.calls.filter(c => c[0] === 'arrivals').sort();
  assert.deepEqual(arrivalCalls, [
    ['arrivals', 'Q:1', 0, 60], ['arrivals', 'Q:2', 0, 60],
    ['arrivals', 'R:b', 3, 60],   // nearby (0,60) ∪ here stop (ceil(180/60)=3, 60)
    ['arrivals', 'R:d', 0, 120]]); // pinned stop
  assert.deepEqual(provider.calls.filter(c => c[0] === 'stopsNear'), [['stopsNear', 300]]);

  // second gather uses the cache
  const p2 = fakeProvider({ stops: [], routes: {} });
  await gather(p2, config(), pos, cache);
  assert.equal(p2.calls.filter(c => c[0] === 'route').length, 0);
});

test('gather: off-route connections do not fetch here/pinned arrivals', async () => {
  const provider = fakeProvider({ stops: [], routes: { R: routeR } });
  const data = await gather(provider, config(), geo.offset(P, 300, 0), {});
  assert.deepEqual(provider.calls.filter(c => c[0] === 'arrivals'), []);
  assert.equal(data.routes.R, routeR);
});

test('gather: partial failures are collected, not fatal', async () => {
  const provider = fakeProvider({ stopsErr: 'stops down', routes: {}, failStops: ['R:d'] });
  const data = await gather(provider, config({ connections: [{ routeId: 'R', stopId: 'R:d' }, { routeId: 'NOPE', stopId: 'x' }] }), pos, {});
  assert.ok(data.errors.length >= 2, JSON.stringify(data.errors)); // stopsNear + route NOPE
  assert.deepEqual(data.stops, []);
  assert.equal(data.routes.NOPE, undefined);

  const p2 = fakeProvider({ stops: [], routes: { R: routeR }, failStops: ['R:d'] });
  const d2 = await gather(p2, config(), pos, {});
  assert.equal(d2.arrivals['R:d'], undefined);
  assert.ok(Array.isArray(d2.arrivals['R:b']));
  assert.equal(d2.errors.length, 1);
});

test('gather: stopsNear failure with no connections is fatal', async () => {
  const provider = fakeProvider({ stopsErr: 'stops down', routes: {} });
  await assert.rejects(gather(provider, config({ connections: [] }), pos, {}), /stops down/);
});

// ---- colors ------------------------------------------------------------------------------------

test('routeColor: configured color, then the provider route color, then defaults', () => {
  const cfg = config({ routes: [{ id: 'R', name: 'Red', color: '#123456' }, { id: 'Q' }, { id: 'S' }] });
  assert.equal(planner.routeColor(cfg, 'R', { color: 'ABCDEF' }), '123456');
  assert.equal(planner.routeColor(cfg, 'Q', { color: 'abcdef' }), 'ABCDEF');
  assert.equal(planner.routeColor(cfg, 'Q', { color: '' }), planner.DEFAULT_COLORS[1]);
  assert.equal(planner.routeColor(cfg, 'S', undefined), planner.DEFAULT_COLORS[2]);
  assert.equal(planner.routeColor(cfg, 'Zz', null), planner.DEFAULT_COLORS[('Z'.charCodeAt(0) + 'z'.charCodeAt(0)) % 8]);
  assert.deepEqual(planner.DEFAULT_COLORS, ['0055AA', 'AA0000', '00AA55', 'AA5500', '5500AA', '00AAAA', 'AA00AA', '555555']);
});

test('items use the provider route color when none is configured', () => {
  const data = dropoffData([arr('R:b', 'R', 'b', 60)], [arr('R:d', 'R', 'b', 400)]);
  data.routes = { R: { ...routeR, color: '771473' } };
  data.stops = [stop('R:b', 'B St', east(-100), ['R'])];
  const items = planner.buildItems(config(), data, pos, NOW);
  assert.deepEqual(items.map(i => i.color), ['771473', '771473']);
});

// ---- drop-offs from live vehicle positions -------------------------------------------------------

const veh = (tripKey, p, age) => ({ tripKey, routeId: 'R', directionId: '0', lat: p.lat, lon: p.lon, time: NOW - age });

test('dropoff: a recent vehicle report near you is the bus you are on', () => {
  // no "recent" arrival at the here stop at all (NexTrip only lists future departures)
  const data = dropoffData([arr('R:b', 'R', 't3', 300)], [arr('R:d', 'R', 't2', 120), arr('R:d', 'R', 't3', 480)]);
  data.vehicles = { R: [veh('t2', east(60), 20)] };
  const item = planner.buildItems(config(), data, pos, NOW)[0];
  assert.deepEqual(item.times, [NOW + 120, NOW + 480, NOW + 300]);
  assert.equal(item.features['route:R'], 120);
});

test('dropoff: vehicles that are stale, too far, or not going to the pinned stop are ignored; nearest wins', () => {
  const pinned = [arr('R:d', 'R', 'near', 100), arr('R:d', 'R', 'far', 200), arr('R:d', 'R', 'stale', 300), arr('R:d', 'R', 'nx', 900)];
  const here = [arr('R:b', 'R', 'nx', 500)];
  const run = (vehicles, cfg) => {
    const data = dropoffData(here, pinned);
    data.vehicles = { R: vehicles };
    return planner.buildItems(config(cfg), data, pos, NOW)[0].times;
  };
  assert.deepEqual(run([veh('far', east(200), 5), veh('near', east(30), 5)]), [NOW + 100, NOW + 900, NOW + 500]);
  assert.deepEqual(run([veh('stale', east(10), 400)]), [0, NOW + 900, NOW + 500], 'older than recentWindow');
  assert.deepEqual(run([veh('far', east(600), 5)]), [0, NOW + 900, NOW + 500], 'beyond vehicleRadius (250)');
  assert.deepEqual(run([veh('far', east(600), 5)], { vehicleRadius: 700 }), [NOW + 200, NOW + 900, NOW + 500]);
  assert.deepEqual(run([veh('elsewhere', east(10), 5)]), [0, NOW + 900, NOW + 500], 'trip not reaching the pinned stop');
});

test('dropoff: with no matching vehicle, falls back to recent arrivals at the here stop', () => {
  const data = dropoffData([arr('R:b', 'R', 'old', -60), arr('R:b', 'R', 'nx', 300)], [arr('R:d', 'R', 'old', 200), arr('R:d', 'R', 'nx', 700)]);
  data.vehicles = { R: [] };
  assert.deepEqual(planner.buildItems(config(), data, pos, NOW)[0].times, [NOW + 200, NOW + 700, NOW + 300]);
});

test('gather: fetches vehicles for on-route connection routes when the provider supports it', async () => {
  const v = [veh('t', east(10), 5)];
  const provider = fakeProvider({ stops: [], routes: { R: routeR, Q: routeQ }, vehicles: { R: v } });
  const data = await gather(provider, config(), pos, {});
  assert.deepEqual(provider.calls.filter(c => c[0] === 'vehicles'), [['vehicles', 'R']]);
  assert.deepEqual(data.vehicles.R, v);

  const off = fakeProvider({ stops: [], routes: { R: routeR, Q: routeQ }, vehicles: { R: v } });
  const d2 = await gather(off, config(), geo.offset(P, 300, 0), {});
  assert.equal(off.calls.filter(c => c[0] === 'vehicles').length, 0, 'off route: no vehicle lookup');
  assert.deepEqual(d2.vehicles, {});

  const failing = fakeProvider({ stops: [], routes: { R: routeR, Q: routeQ }, vehicles: new Error('veh down') });
  const d3 = await gather(failing, config(), pos, {});
  assert.equal(d3.vehicles.R, undefined);
  assert.ok(d3.errors.some(e => /veh down/.test(e)));

  const noSupport = fakeProvider({ stops: [], routes: { R: routeR, Q: routeQ } });
  const d4 = await gather(noSupport, config(), pos, {});
  assert.deepEqual(d4.vehicles, {});
});

// ---- phase 3: bearing, distance, direction labels, same-name merging ----------------------------

// Route M runs north-south through P on a two-way street: direction N (northbound, east curb) and S (southbound, west curb).
// Stops at the Franklin intersection exist on both curbs with the same name; there is another pair 400 m north.
const curb = (m, side) => geo.offset(geo.offset(P, Math.abs(m), m >= 0 ? 0 : 180), 10, side === 'E' ? 90 : 270);
function routeM(named) {
  return {
    id: 'M', shortName: 'M',
    directions: [
      { id: 'N', name: named ? 'Northbound' : '', stopIds: ['M:n0', 'M:n4'], paths: [[curb(-1000, 'E'), curb(1000, 'E')]] },
      { id: 'S', name: named ? 'Southbound' : '', stopIds: ['M:s4', 'M:s0'], paths: [[curb(1000, 'W'), curb(-1000, 'W')]] },
    ],
    stops: {
      'M:n0': { id: 'M:n0', name: 'Franklin Ave W & Lyndale Ave S', ...curb(0, 'E') },
      'M:s0': { id: 'M:s0', name: 'Franklin Ave W & Lyndale Ave S', ...curb(0, 'W') },
      'M:n4': { id: 'M:n4', name: '26th St', ...curb(400, 'E') },
      'M:s4': { id: 'M:s4', name: '26th St', ...curb(400, 'W') },
    },
  };
}
const cfgM = extra => config(Object.assign({ routes: [{ id: 'M', name: 'Mm' }, { id: 'R', name: 'Red' }], connections: [] }, extra || {}));
// the user stands 3 m east of P: n0 (east curb) is nearer than s0
const here = geo.offset(P, 3, 90);
function mData(named, stopsList, arrivals) {
  return { stops: stopsList, routes: { M: routeM(named) }, errors: [], arrivals };
}
const mStop = (id, routeIds, name) => {
  const s = routeM(true).stops[id];
  return stop(id, name || s.name, s, routeIds || ['M']);
};

test('merge: same-name pickup stops of a route become one tile with two lanes, nearest first', () => {
  const data = mData(true, [mStop('M:s0'), mStop('M:n0')], {
    'M:s0': [arr('M:s0', 'M', 's1', 120), arr('M:s0', 'M', 's2', 700)],
    'M:n0': [arr('M:n0', 'M', 'n1', 300), arr('M:n0', 'M', 'n2', 900), arr('M:n0', 'M', 'n3', 1500)],
  });
  const items = planner.buildItems(cfgM(), data, here, NOW);
  assert.equal(items.length, 1);
  const it = items[0];
  const n0 = data.stops[1];
  assert.deepEqual(it.lanes, [
    { stopId: 'M:n0', dir: 'NB', times: [NOW + 300, NOW + 900, NOW + 1500] },
    { stopId: 'M:s0', dir: 'SB', times: [NOW + 120, NOW + 700] },
  ], 'lane 0 is the nearer stop even though the farther one is listed first');
  assert.equal(it.key, 'pickup:M:n0:M');
  assert.equal(it.stopId, 'M:n0');
  assert.equal(it.dir, 'NB');
  assert.deepEqual(it.times, [NOW + 300, NOW + 900, NOW + 1500]);
  assert.equal(it.title, 'Franklin Ave W & Lyndale Ave S');
  assert.equal(it.distance, geo.distance(here, n0));
  assert.equal(it.bearing, geo.bearing(here, n0));
  assert.deepEqual(it.features, { 'stop:M:n0': Math.round(geo.distance(here, n0)), 'route:M': 120 },
    'route feature = soonest first time of either lane');
});

test('merge: name normalization (case, surrounding and inner whitespace)', () => {
  const data = mData(true, [mStop('M:n0'), mStop('M:s0', ['M'], '  franklin ave w   &  LYNDALE AVE S ')], {
    'M:n0': [arr('M:n0', 'M', 'n1', 300)], 'M:s0': [arr('M:s0', 'M', 's1', 100)] });
  const items = planner.buildItems(cfgM(), data, here, NOW);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Franklin Ave W & Lyndale Ave S', 'title of lane 0');
  assert.equal(items[0].lanes.length, 2);
  const other = mData(true, [mStop('M:n0'), mStop('M:s0', ['M'], 'Franklin Ave E & Lyndale Ave S')], data.arrivals);
  assert.equal(planner.buildItems(cfgM(), other, here, NOW).length, 2, 'different names never merge');
});

test('merge: different routes at same-name stops do not merge; each route merges on its own', () => {
  const sN = mStop('M:n0', ['M', 'R']), sS = mStop('M:s0', ['M', 'R']);
  const data = mData(true, [sN, sS], {
    'M:n0': [arr('M:n0', 'M', 'a', 60), arr('M:n0', 'R', 'b', 200)],
    'M:s0': [arr('M:s0', 'R', 'c', 90)],
  });
  const items = planner.buildItems(cfgM(), data, here, NOW);
  assert.deepEqual(items.map(i => [i.key, i.lanes.map(l => l.stopId)]), [
    ['pickup:M:n0:M', ['M:n0']],
    ['pickup:M:n0:R', ['M:n0', 'M:s0']],
  ]);
  assert.equal(items[1].features['route:R'], 90);
  assert.deepEqual(items[1].lanes.map(l => l.dir), ['', ''], 'route R not loaded -> no labels');
});

test('merge: a stop without times does not take a lane', () => {
  const data = mData(true, [mStop('M:n0'), mStop('M:s0')], { 'M:n0': [arr('M:n0', 'M', 'a', 60)], 'M:s0': [] });
  const items = planner.buildItems(cfgM(), data, here, NOW);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].lanes, [{ stopId: 'M:n0', dir: 'NB', times: [NOW + 60] }]);
});

test('merge: more than two same-name stops pair up in distance order; tiles keep the position of their first candidate', () => {
  const name = 'Main St';
  const mk = (id, m) => stop(id, name, geo.offset(here, m, 0), ['M']);
  const other = stop('O', 'Other', geo.offset(here, 15, 0), ['M']);
  // listed order (as stopsNear would return them, roughly): d=20, other, d=10, d=40, d=30, d=50
  const list = [mk('A', 20), other, mk('B', 10), mk('C', 40), mk('D', 30), mk('E', 50)];
  const arrivals = {};
  for (const s of list) arrivals[s.id] = [arr(s.id, 'M', s.id, 60)];
  const items = planner.buildItems(cfgM(), { stops: list, routes: {}, errors: [], arrivals }, here, NOW);
  assert.deepEqual(items.map(i => i.lanes.map(l => l.stopId)), [
    ['B', 'A'],   // nearest pair (10, 20); first candidate A is at position 0
    ['O'],
    ['D', 'C'],   // next pair (30, 40); first candidate C at position 3
    ['E'],        // the odd one out stays alone
  ]);
  assert.deepEqual(items.map(i => i.key), ['pickup:B:M', 'pickup:O:M', 'pickup:D:M', 'pickup:E:M']);
});

test('dir labels: named directions, unnamed (heading to the next stop), stops served in both directions', () => {
  const arrivals = { 'M:n0': [arr('M:n0', 'M', 'a', 60)], 'M:s0': [arr('M:s0', 'M', 'b', 60)] };
  const unnamed = planner.buildItems(cfgM(), mData(false, [mStop('M:n0'), mStop('M:s0')], arrivals), here, NOW)[0];
  assert.deepEqual(unnamed.lanes.map(l => l.dir), ['NB', 'SB'], 'n0 -> n4 heads north; s0 is the last stop: heading from s4');
  // a stop served by both directions has no single label
  const both = routeM(true);
  both.directions[1].stopIds = ['M:s4', 'M:n0', 'M:s0'];
  const data = { stops: [mStop('M:n0')], routes: { M: both }, errors: [], arrivals };
  assert.equal(planner.buildItems(cfgM(), data, here, NOW)[0].dir, '');
});

test('pickup: bearing and distance are null when the stop has no coordinates', () => {
  const s = { id: 'M:n0', name: 'Nowhere', routeIds: ['M'] };
  const it = planner.buildItems(cfgM(), mData(true, [s], { 'M:n0': [arr('M:n0', 'M', 'a', 60)] }), here, NOW)[0];
  assert.equal(it.bearing, null);
  assert.equal(it.distance, null);
  assert.equal(it.lanes.length, 1);
});

test('pickup: bearing points from pos to the stop', () => {
  const north = stop('N1', 'North', geo.offset(here, 100, 0), ['M']);
  const east = stop('E1', 'East', geo.offset(here, 100, 90), ['M']);
  const items = planner.buildItems(cfgM(), { stops: [north, east], routes: {}, errors: [],
    arrivals: { N1: [arr('N1', 'M', 'a', 60)], E1: [arr('E1', 'M', 'b', 60)] } }, here, NOW);
  assert.ok(Math.min(items[0].bearing, 360 - items[0].bearing) < 0.5, String(items[0].bearing));
  assert.ok(Math.abs(items[1].bearing - 90) < 0.5);
  assert.ok(Math.abs(items[0].distance - 100) < 1);
});

// drop-offs on route M: one tile per connection even when the pinned stops share a name
test('dropoff: never merged; dir tells same-name pinned stops apart; distance left to ride along the path', () => {
  for (const named of [true, false]) {
    const r = routeM(named);
    r.stops['M:s8'] = { id: 'M:s8', name: '30th St', ...curb(800, 'W') };
    r.directions[1].stopIds = ['M:s8', 'M:s4', 'M:s0'];
    const cfg = cfgM({ connections: [{ routeId: 'M', stopId: 'M:n4', name: '26th NB' }, { routeId: 'M', stopId: 'M:s4', name: '26th SB' }] });
    const onN = curb(50, 'E');
    const data = { stops: [], routes: { M: r }, errors: [], arrivals: {
      'M:n0': [arr('M:n0', 'M', 'n', 60)], 'M:n4': [arr('M:n4', 'M', 'n', 600)],
      'M:s8': [arr('M:s8', 'M', 's', 60)], 'M:s4': [arr('M:s4', 'M', 's', 600)] } };
    const items = planner.buildItems(cfg, data, onN, NOW);
    assert.deepEqual(items.map(i => [i.kind, i.stopId, i.dir]), [['dropoff', 'M:n4', 'NB'], ['dropoff', 'M:s4', 'SB']], 'named=' + named);
    const [n, so] = items;
    assert.deepEqual(n.lanes, []);
    const path = r.directions[0].paths[0];
    const expected = geo.nearestOnPath(r.stops['M:n4'], path).along - geo.nearestOnPath(onN, path).along;
    assert.ok(Math.abs(n.distance - expected) < 1e-6 && Math.abs(n.distance - 350) < 5, String(n.distance));
    assert.ok(Math.min(n.bearing, 360 - n.bearing) < 1, 'pinned stop is due north');
    // southbound: s4 is behind pos along the southbound path -> straight line
    assert.equal(so.distance, geo.distance(onN, r.stops['M:s4']));
    assert.equal(so.bearing, geo.bearing(onN, r.stops['M:s4']));
  }
});

test('dropoff: pinned stop behind pos along the path -> straight-line distance; no paths -> straight line', () => {
  // the pinned stop lies behind pos along the direction's path (e.g. odd geometry / a loop)
  const r = routeM(true);
  r.directions[0].paths = [[curb(-1000, 'E'), curb(1000, 'E')]];
  const pos2 = curb(-50, 'E');
  r.directions[0].stopIds = ['M:n4x', 'M:n0'];        // here stop n4x is before pinned n0 in stop order
  r.stops['M:n4x'] = { id: 'M:n4x', name: 'Far', ...curb(-400, 'E') };
  r.stops['M:n0'] = { ...r.stops['M:n0'], ...curb(-200, 'E') }; // pinned stop 150 m behind pos along the path
  const cfg = cfgM({ connections: [{ routeId: 'M', stopId: 'M:n0', name: 'Back' }] });
  const data = { stops: [], routes: { M: r }, errors: [], arrivals: {
    'M:n4x': [arr('M:n4x', 'M', 'x', 60)], 'M:n0': [arr('M:n0', 'M', 'x', 600)] } };
  const it = planner.buildItems(cfg, data, pos2, NOW)[0];
  assert.ok(it, 'item built');
  assert.equal(it.distance, geo.distance(pos2, r.stops['M:n0']), 'negative along-distance -> straight line');
  assert.ok(it.distance > 0);

  // a direction without paths (distanceToPaths = Infinity, so only on-route with an infinite routeRadius)
  const r2 = routeM(true);
  r2.directions[0].paths = [];
  const data2 = { stops: [], routes: { M: r2 }, errors: [], arrivals: { 'M:n0': [arr('M:n0', 'M', 'x', 60)], 'M:n4': [arr('M:n4', 'M', 'x', 600)] } };
  const cfg2 = cfgM({ connections: [{ routeId: 'M', stopId: 'M:n4', name: 'N4' }] });
  cfg2.routeRadius = Infinity;
  const it2 = planner.buildItems(cfg2, data2, here, NOW)[0];
  assert.ok(it2);
  assert.equal(it2.distance, geo.distance(here, r2.stops['M:n4']));
});

test('dropoff: bearing/distance null when the pinned stop has no coordinates', () => {
  const r = routeM(true);
  r.stops['M:n4'] = { id: 'M:n4', name: '26th St' };
  const cfg = cfgM({ connections: [{ routeId: 'M', stopId: 'M:n4', name: 'N4' }] });
  const data = { stops: [], routes: { M: r }, errors: [], arrivals: { 'M:n0': [arr('M:n0', 'M', 'x', 60)], 'M:n4': [arr('M:n4', 'M', 'x', 600)] } };
  const it = planner.buildItems(cfg, data, curb(-50, 'E'), NOW)[0];
  assert.ok(it);
  assert.equal(it.bearing, null);
  assert.equal(it.distance, null);
  assert.equal(it.dir, 'NB', 'named direction still labels it');
});

test('pickups: walking time to the stop at the configured walking speed; unknown distance → null', () => {
  const sB = stop('R:b', 'B St', east(-260), ['R']);
  const data = { stops: [sB], routes: {}, errors: [], arrivals: { 'R:b': [arr('R:b', 'R', 't1', 300)] } };
  const d = geo.distance(pos, sB);
  const fast = planner.buildItems(config({ schedule: Object.assign(settings.defaults().schedule, { walkSpeed: 2 }) }), data, pos, NOW);
  assert.equal(fast[0].walk, Math.ceil(d / 2));
  const noPos = Object.assign({}, sB, { lat: undefined, lon: undefined });
  const items = planner.buildItems(config(), Object.assign({}, data, { stops: [noPos] }), pos, NOW);
  assert.equal(items[0].distance, null);
  assert.equal(items[0].walk, null);
});
