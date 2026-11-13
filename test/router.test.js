process.env.TZ = 'America/Chicago';
const test = require('node:test');
const assert = require('node:assert/strict');
const geo = require('../src/common/geo');
const router = require('../src/common/router');
const { createMock } = require('../src/sources/mock/index');

const C = { lat: 44.97, lon: -93.26 };
const NOW = Date.UTC(2026, 10, 13, 14, 0, 0) / 1000; // 8:00 AM CST
const WS = 1.3;
const at = (p, north, east) => geo.offset(geo.offset(p, north, 0), east, 90);
const walkS = (a, b) => Math.ceil(geo.distance(a, b) / WS);

// route from [{id, pos, name?}] in travel order (one direction unless dirs given)
function mkRoute(id, stops, extra = {}) {
  const st = {};
  for (const s of stops) st[s.id] = { id: s.id, name: s.name || s.id, lat: s.pos.lat, lon: s.pos.lon };
  return {
    id, shortName: extra.shortName || id, color: extra.color || '',
    directions: [{ id: '0', name: extra.dirName || 'Northbound', stopIds: stops.map(s => s.id), paths: [stops.map(s => s.pos)] }],
    stops: st
  };
}

// fake provider: trips = [{route, key, times: {stopId: t}, headsign?}]; horizon = seconds after now it can see
function fakeSource({ routes, trips = [], horizon = Infinity, failRoutes = [] }) {
  const counts = { route: 0, arrivals: 0, stops: [] };
  const byId = Object.fromEntries(routes.map(r => [r.id, r]));
  return {
    counts,
    route(id, cb) {
      counts.route++;
      setImmediate(() => (byId[id] && !failRoutes.includes(id)) ? cb(null, byId[id]) : cb(new Error('unknown route ' + id)));
    },
    arrivals(stopId, before, after, cb) {
      counts.arrivals++;
      counts.stops.push(stopId);
      const lo = NOW - before * 60, hi = Math.min(NOW + after * 60, NOW + horizon);
      const out = [];
      for (const t of trips) {
        const time = t.times[stopId];
        if (time != null && time >= lo && time <= hi) {
          out.push({ stopId, routeId: t.route, tripKey: t.key, time, predicted: true, headsign: t.headsign || 'Downtown' });
        }
      }
      out.sort((a, b) => a.time - b.time);
      setImmediate(() => cb(null, out));
    }
  };
}

function plan(source, req) {
  return new Promise((resolve, reject) => {
    let calls = 0;
    router.plan(source, Object.assign({
      origin: C, now: NOW, walkSpeed: WS, maxWalk: 800, transferWalk: 250, maxTransfers: 1, minTransfer: 120
    }, req), (err, p) => {
      calls++;
      setImmediate(() => { assert.equal(calls, 1, 'cb called once'); err ? reject(err) : resolve(p); });
    });
  });
}

// ---- network 1: route R1 north from the origin to the destination ----
const DEST = Object.assign(at(C, 3000, 100), { name: 'Work' });
const A0 = { id: 'A0', name: 'First Ave', pos: at(C, 100, 0) };
const A1 = { id: 'A1', pos: at(C, 1500, 0) };
const A2 = { id: 'A2', name: 'Tower', pos: at(C, 2900, 0) };
const R1 = mkRoute('R1', [A0, A1, A2], { shortName: '2', color: 'FF0000' });
const W0 = walkS(C, A0.pos), W2 = walkS(A2.pos, DEST);
const R1_TRIPS = [
  { route: 'R1', key: 't1', times: { A0: NOW + 60, A1: NOW + 330, A2: NOW + 600 } },
  { route: 'R1', key: 't2', times: { A0: NOW + 300, A1: NOW + 570, A2: NOW + 840 } },
  { route: 'R1', key: 't3', times: { A0: NOW + 900, A1: NOW + 1170, A2: NOW + 1440 } },
  { route: 'R1', key: 't4', times: { A0: NOW + 1500, A1: NOW + 1770, A2: NOW + 2040 } }
];

test('direct: latest feasible departure', async () => {
  const src = fakeSource({ routes: [R1], trips: R1_TRIPS });
  const p = await plan(src, { destination: DEST, arriveBy: NOW + 2000, routeIds: ['R1'] });
  assert.equal(p.estimated, false);
  const bus = p.legs.find(l => l.mode === 'bus');
  assert.equal(bus.tripKey, 't3');
  assert.equal(p.leaveAt, NOW + 900 - W0);
  assert.equal(p.arriveAt, NOW + 1440 + W2);
  assert.equal(p.arriveBy, NOW + 2000);
  assert.deepEqual(p.legs.map(l => l.mode), ['walk', 'bus', 'walk']);
  assert.deepEqual(p.legs[0], { mode: 'walk', meters: Math.round(geo.distance(C, A0.pos)), seconds: W0, toName: 'First Ave' });
  assert.equal(p.legs[2].toName, 'Work');
  assert.equal(p.legs[2].seconds, W2);
  assert.deepEqual(
    { routeId: bus.routeId, routeName: bus.routeName, color: bus.color, dir: bus.dir, headsign: bus.headsign, b: bus.boardStopId,
      bn: bus.boardStopName, a: bus.alightStopId, an: bus.alightStopName, d: bus.departAt, ar: bus.arriveAt },
    { routeId: 'R1', routeName: '2', color: 'FF0000', dir: 'NB', headsign: 'Downtown', b: 'A0', bn: 'First Ave', a: 'A2', an: 'Tower',
      d: NOW + 900, ar: NOW + 1440 });
  assert.equal(src.counts.arrivals, 2);
});

test('direct: routeNames / routeColors override the route', async () => {
  const src = fakeSource({ routes: [R1], trips: R1_TRIPS });
  const p = await plan(src, { destination: DEST, arriveBy: NOW + 2000, routeIds: ['R1'], routeNames: { R1: 'Two' }, routeColors: { R1: '00FF00' } });
  const bus = p.legs.find(l => l.mode === 'bus');
  assert.equal(bus.routeName, 'Two');
  assert.equal(bus.color, '00FF00');
});

test('direct: arriveBy includes the final walk', async () => {
  const src = fakeSource({ routes: [R1], trips: R1_TRIPS });
  // t3 reaches A2 at +1440 but the walk makes it +1440+W2 > +1500
  const p = await plan(src, { destination: DEST, arriveBy: NOW + 1500, routeIds: ['R1'] });
  assert.equal(p.legs[1].tripKey, 't2');
  const p2 = await plan(src, { destination: DEST, arriveBy: NOW + 1440 + W2, routeIds: ['R1'] });
  assert.equal(p2.legs[1].tripKey, 't3');
});

test('direct: cannot catch a bus leaving before you can walk to the stop → null', async () => {
  assert.ok(W0 > 60);
  const src = fakeSource({ routes: [R1], trips: R1_TRIPS });
  // only t1 arrives in time, but it leaves A0 60 s from now and the walk takes W0
  const p = await plan(src, { destination: DEST, arriveBy: NOW + 750, routeIds: ['R1'] });
  assert.equal(p, null);
  // with t1 at A0 exactly when we can get there it works
  const trips = [{ route: 'R1', key: 't1', times: { A0: NOW + W0, A2: NOW + 600 } }, R1_TRIPS[1]];
  const p2 = await plan(fakeSource({ routes: [R1], trips }), { destination: DEST, arriveBy: NOW + 750, routeIds: ['R1'] });
  assert.equal(p2.legs[1].tripKey, 't1');
  assert.equal(p2.leaveAt, NOW);
});

test('direct: ties in leave time → less walking; later leave wins over less walking', async () => {
  // R2 boards 400 m south of the origin, alights at the same place as R1
  const B0 = { id: 'B0', pos: at(C, -400, 0) }, B1 = { id: 'B1', pos: A2.pos };
  const R2 = mkRoute('R2', [B0, B1]);
  const WB = walkS(C, B0.pos);
  const leave = NOW + 900 - W0; // R1 t3
  for (const [delta, want] of [[0, 'R1'], [1, 'R2']]) {
    const trips = R1_TRIPS.concat([{ route: 'R2', key: 'u1', times: { B0: leave + WB + delta, B1: NOW + 1400 } }]);
    const src = fakeSource({ routes: [R1, R2], trips });
    const p = await plan(src, { destination: DEST, arriveBy: NOW + 2000, routeIds: ['R1', 'R2'] });
    assert.equal(p.legs.find(l => l.mode === 'bus').routeId, want, 'delta ' + delta);
    assert.equal(p.leaveAt, leave + delta);
  }
});

test('direction order: no riding backwards', async () => {
  const back = mkRoute('RB', [A2, A1, A0]);
  const trips = [{ route: 'RB', key: 'x', times: { A2: NOW + 100, A1: NOW + 300, A0: NOW + 500 } },
                 { route: 'RB', key: 'y', times: { A0: NOW + 100, A2: NOW + 500 } }];
  const src = fakeSource({ routes: [back], trips });
  const p = await plan(src, { destination: DEST, arriveBy: NOW + 3000, routeIds: ['RB'] });
  assert.equal(p, null);
  assert.equal(src.counts.arrivals, 0);
});

test('maxWalk limits the walks to the first and from the last stop', async () => {
  const d0 = geo.distance(C, A0.pos), d2 = geo.distance(A2.pos, DEST);
  for (const maxWalk of [d0 - 1, d2 - 1]) {
    const src = fakeSource({ routes: [R1], trips: R1_TRIPS });
    assert.equal(await plan(src, { destination: DEST, arriveBy: NOW + 2000, routeIds: ['R1'], maxWalk, maxTransfers: 0 }), null);
  }
  const p = await plan(fakeSource({ routes: [R1], trips: R1_TRIPS }),
    { destination: DEST, arriveBy: NOW + 2000, routeIds: ['R1'], maxWalk: Math.max(d0, d2) + 1 });
  assert.ok(p);
});

// ---- network 2: T1 east, then T2 north ----
const TDEST = Object.assign(at(C, 2050, 2000), { name: 'Gym' });
const E0 = { id: 'E0', pos: at(C, 0, 50) }, E1 = { id: 'E1', pos: at(C, 0, 1000) }, E2 = { id: 'E2', name: 'Transfer East', pos: at(C, 0, 2000) };
const N0 = { id: 'N0', name: 'Transfer North', pos: at(C, 100, 2000) }, N1 = { id: 'N1', pos: at(C, 1000, 2000) }, N2 = { id: 'N2', pos: at(C, 2000, 2000) };
const T1 = mkRoute('T1', [E0, E1, E2], { dirName: 'Eastbound' });
const T2 = mkRoute('T2', [N0, N1, N2]);
const WX = walkS(E2.pos, N0.pos);
const T_TRIPS = [
  { route: 'T1', key: 'a1', times: { E0: NOW + 300, E2: NOW + 700 } },
  { route: 'T1', key: 'a2', times: { E0: NOW + 900, E2: NOW + 1300 } },
  { route: 'T2', key: 'b1', times: { N0: NOW + 800, N2: NOW + 1200 } },
  { route: 'T2', key: 'b2', times: { N0: NOW + 1000, N2: NOW + 1400 } },
  { route: 'T2', key: 'b3', times: { N0: NOW + 1500, N2: NOW + 1900 } }
];

test('one transfer: latest leave, transferWalk and minTransfer respected', async () => {
  assert.equal(1300 + WX + 120 <= 1500, true);
  const src = fakeSource({ routes: [T1, T2], trips: T_TRIPS });
  const p = await plan(src, { destination: TDEST, arriveBy: NOW + 2000, routeIds: ['T1', 'T2'] });
  assert.deepEqual(p.legs.map(l => l.mode), ['walk', 'bus', 'walk', 'bus', 'walk']);
  assert.deepEqual(p.legs.filter(l => l.mode === 'bus').map(l => l.tripKey), ['a2', 'b3']);
  assert.equal(p.legs[1].dir, 'EB');
  assert.equal(p.legs[2].toName, 'Transfer North');
  assert.equal(p.legs[2].seconds, WX);
  assert.equal(p.leaveAt, NOW + 900 - walkS(C, E0.pos));
  assert.equal(p.arriveAt, NOW + 1900 + walkS(N2.pos, TDEST));
  assert.ok(src.counts.arrivals <= 8);

  // a minTransfer that a2 → b3 can't make: a1 → the earliest connection that arrives in time (b2)
  const minTransfer = 1500 - 1300 - WX + 1;
  const p2 = await plan(fakeSource({ routes: [T1, T2], trips: T_TRIPS }), { destination: TDEST, arriveBy: NOW + 2000, routeIds: ['T1', 'T2'], minTransfer });
  assert.deepEqual(p2.legs.filter(l => l.mode === 'bus').map(l => l.tripKey), ['a1', 'b2']);

  // transfer walk too long / transfers off → no plan
  for (const extra of [{ transferWalk: geo.distance(E2.pos, N0.pos) - 1 }, { maxTransfers: 0 }]) {
    const s = fakeSource({ routes: [T1, T2], trips: T_TRIPS });
    assert.equal(await plan(s, Object.assign({ destination: TDEST, arriveBy: NOW + 2000, routeIds: ['T1', 'T2'] }, extra)), null);
  }
});

test('transfer only when there is no direct live itinerary', async () => {
  const D0 = { id: 'D0', pos: at(C, 10, 10) }, D1 = { id: 'D1', pos: at(TDEST, -10, 0) };
  const D = mkRoute('D', [D0, D1]);
  // d2 (too late) shows that the data reaches arriveBy
  const trips = T_TRIPS.concat([{ route: 'D', key: 'd1', times: { D0: NOW + 200, D1: NOW + 1000 } }, { route: 'D', key: 'd2', times: { D0: NOW + 1800, D1: NOW + 2600 } }]);
  const src = fakeSource({ routes: [T1, T2, D], trips });
  const p = await plan(src, { destination: TDEST, arriveBy: NOW + 2000, routeIds: ['T1', 'T2', 'D'] });
  assert.equal(p.legs.filter(l => l.mode === 'bus').length, 1);
  assert.equal(p.legs.find(l => l.mode === 'bus').tripKey, 'd1');
  for (const s of ['E2', 'N0']) assert.ok(!src.counts.stops.includes(s), s + ' not fetched');

  // direct trip that can't make it (but data covers arriveBy) → the transfer
  const late = T_TRIPS.concat([{ route: 'D', key: 'd1', times: { D0: NOW + 1800, D1: NOW + 2600 } }]);
  const p2 = await plan(fakeSource({ routes: [T1, T2, D], trips: late }), { destination: TDEST, arriveBy: NOW + 2000, routeIds: ['T1', 'T2', 'D'] });
  assert.deepEqual(p2.legs.filter(l => l.mode === 'bus').map(l => l.tripKey), ['a2', 'b3']);
});

// ---- walking ----
test('walk only: no bus option → walk, without fetching arrivals', async () => {
  const dest = Object.assign(at(C, 500, 0), { name: 'Cafe' });
  const src = fakeSource({ routes: [T1], trips: T_TRIPS });
  const p = await plan(src, { destination: dest, arriveBy: NOW + 1200, routeIds: ['T1'] });
  const s = walkS(C, dest);
  assert.deepEqual(p, { arriveBy: NOW + 1200, leaveAt: NOW + 1200 - s, arriveAt: NOW + 1200, estimated: false,
    legs: [{ mode: 'walk', meters: Math.round(geo.distance(C, dest)), seconds: s, toName: 'Cafe' }] });
  assert.equal(src.counts.arrivals, 0);
  // too far to walk / not enough time → null
  assert.equal(await plan(src, { destination: dest, arriveBy: NOW + 1200, routeIds: ['T1'], maxWalk: 400 }), null);
  assert.equal(await plan(src, { destination: dest, arriveBy: NOW + s - 1, routeIds: ['T1'] }), null);
});

test('walk only vs a faster bus: whichever leaves later', async () => {
  const dest = at(C, 700, 0);
  const S0 = { id: 'S0', pos: C }, S1 = { id: 'S1', pos: dest };
  const R = mkRoute('S', [S0, S1]);
  const trips = [{ route: 'S', key: 'k', times: { S0: NOW + 600, S1: NOW + 700 } }, { route: 'S', key: 'k2', times: { S0: NOW + 1200, S1: NOW + 1300 } }];
  const p = await plan(fakeSource({ routes: [R], trips }), { destination: dest, arriveBy: NOW + 800, routeIds: ['S'] });
  assert.equal(p.legs.length, 1);
  assert.equal(p.legs[0].mode, 'bus');
  assert.equal(p.leaveAt, NOW + 600);
  const p2 = await plan(fakeSource({ routes: [R], trips }), { destination: dest, arriveBy: NOW + 650, routeIds: ['S'] });
  assert.deepEqual(p2.legs.map(l => l.mode), ['walk']);
});

// ---- estimated ----
test('estimated: arrivals do not reach arriveBy → median ride + headway slack', async () => {
  const trips = [];
  for (let k = 0; k < 6; k++) trips.push({ route: 'R1', key: 'e' + k, times: { A0: NOW + 100 + 600 * k, A2: NOW + 100 + 600 * k + 500 + (k % 2) * 80 } });
  // rides: 500, 580, 500, 580, 500, 580 → median 540; headway 600
  const src = fakeSource({ routes: [R1], trips, horizon: 4000 });
  const arriveBy = NOW + 4 * 3600;
  const p = await plan(src, { destination: DEST, arriveBy, routeIds: ['R1'] });
  assert.equal(p.estimated, true);
  const bus = p.legs.find(l => l.mode === 'bus');
  assert.equal(bus.tripKey, null);
  assert.equal(bus.arriveAt, arriveBy - W2);
  assert.equal(bus.departAt, arriveBy - W2 - 540);
  assert.equal(p.leaveAt, arriveBy - W2 - 540 - 600 - W0);
  assert.equal(p.arriveAt, arriveBy);
  assert.ok(src.counts.arrivals <= 8);
});

test('estimated: no observations → along-route distance / ESTIMATED_SPEED and 900 s slack', async () => {
  const src = fakeSource({ routes: [R1], trips: [] });
  const arriveBy = NOW + 3600;
  const p = await plan(src, { destination: DEST, arriveBy, routeIds: ['R1'], maxTransfers: 0 });
  const along = geo.distance(A0.pos, A1.pos) + geo.distance(A1.pos, A2.pos);
  const ride = Math.round(along / router.ESTIMATED_SPEED);
  assert.equal(p.estimated, true);
  assert.equal(p.leaveAt, arriveBy - W2 - ride - 900 - W0);
});

test('estimated transfer when nothing is live', async () => {
  const src = fakeSource({ routes: [T1, T2], trips: [] });
  const arriveBy = NOW + 3 * 3600;
  const p = await plan(src, { destination: TDEST, arriveBy, routeIds: ['T1', 'T2'] });
  assert.equal(p.estimated, true);
  const buses = p.legs.filter(l => l.mode === 'bus');
  assert.deepEqual(buses.map(l => l.routeId), ['T1', 'T2']);
  assert.ok(buses[0].arriveAt + WX + 120 <= buses[1].departAt);
  assert.ok(p.leaveAt < buses[0].departAt);
});

// ---- failures / limits ----
test('failing routes are skipped; all failing → error; no routes at all → null', async () => {
  const src = fakeSource({ routes: [R1], trips: R1_TRIPS, failRoutes: ['BAD'] });
  const p = await plan(src, { destination: DEST, arriveBy: NOW + 2000, routeIds: ['BAD', 'R1'] });
  assert.equal(p.legs[1].tripKey, 't3');
  await assert.rejects(plan(fakeSource({ routes: [R1], failRoutes: ['R1'] }), { destination: DEST, arriveBy: NOW + 2000, routeIds: ['R1', 'X'] }), /unknown route/);
  assert.equal(await plan(fakeSource({ routes: [] }), { destination: DEST, arriveBy: NOW + 2000, routeIds: [] }), null);
  await assert.rejects(plan(fakeSource({ routes: [] }), { arriveBy: NOW + 2000, routeIds: [] }), /bad request/);
});

test('failing arrivals requests do not break the plan', async () => {
  const src = fakeSource({ routes: [R1], trips: R1_TRIPS });
  src.arrivals = (stopId, b, a, cb) => setImmediate(() => cb(new Error('boom')));
  const p = await plan(src, { destination: DEST, arriveBy: NOW + 2000, routeIds: ['R1'], maxTransfers: 0 });
  assert.equal(p.estimated, true);
});

test('request cap: at most 8 arrivals requests per plan', async () => {
  // 6 parallel lines from the origin to the destination, all with buses that are too late
  const routes = [], trips = [];
  for (let i = 0; i < 6; i++) {
    const s0 = { id: 'P' + i + 'a', pos: at(C, 20, i * 40) }, s1 = { id: 'P' + i + 'm', pos: at(C, 1500, i * 40) }, s2 = { id: 'P' + i + 'b', pos: at(DEST, -20, i * 40 - 100) };
    routes.push(mkRoute('P' + i, [s0, s1, s2]));
    trips.push({ route: 'P' + i, key: 'p' + i, times: { [s0.id]: NOW + 3100, [s1.id]: NOW + 3300, [s2.id]: NOW + 3600 } });
  }
  const src = fakeSource({ routes, trips });
  const p = await plan(src, { destination: DEST, arriveBy: NOW + 3000, routeIds: routes.map(r => r.id) });
  assert.equal(p, null);
  assert.ok(src.counts.arrivals > 0 && src.counts.arrivals <= 8, String(src.counts.arrivals));
  assert.equal(new Set(src.counts.stops).size, src.counts.stops.length, 'each stop fetched once');
});

test('routeCache: cached routes are not fetched again', async () => {
  const src = fakeSource({ routes: [R1], trips: R1_TRIPS });
  const routeCache = {};
  await plan(src, { destination: DEST, arriveBy: NOW + 2000, routeIds: ['R1'], routeCache });
  assert.equal(src.counts.route, 1);
  assert.equal(routeCache.R1, R1);
  const p = await plan(src, { destination: DEST, arriveBy: NOW + 2000, routeIds: ['R1'], routeCache });
  assert.equal(src.counts.route, 1);
  assert.equal(p.legs[1].tripKey, 't3');
});

test('throwing / double-calling sources: cb exactly once', async () => {
  const src = fakeSource({ routes: [R1], trips: R1_TRIPS });
  const inner = src.arrivals;
  src.arrivals = (s, b, a, cb) => { inner(s, b, a, cb); inner(s, b, a, cb); };
  const p = await plan(src, { destination: DEST, arriveBy: NOW + 2000, routeIds: ['R1'] });
  assert.equal(p.legs[1].tripKey, 't3');
  const bad = { route() { throw new Error('sync'); }, arrivals() {} };
  await assert.rejects(plan(bad, { destination: DEST, arriveBy: NOW + 2000, routeIds: ['R1'] }), /sync/);
});

// ---- text ----
test('describe / summary', async () => {
  const p = await plan(fakeSource({ routes: [R1], trips: R1_TRIPS }), { destination: DEST, arriveBy: NOW + 2000, routeIds: ['R1'] });
  // leave 8:15 - W0 (77 s) → 8:13 AM, bus 8:15, off 8:24, arrive 8:25:49 → 8:25
  assert.equal(router.describe(p, { units: 'imperial', clock24: false }), [
    'Leave 8:13 AM',
    'Walk 330ft to First Ave (2 min)',
    'Take 2 North to Downtown at 8:15 AM from First Ave',
    'Get off at Tower 8:24 AM',
    'Walk 460ft to Work (2 min)',
    'Arrive 8:25 AM (by 8:33 AM)'
  ].join('\n'));
  assert.equal(router.describe(p, { units: 'metric', clock24: true }), [
    'Leave 08:13',
    'Walk 100m to First Ave (2 min)',
    'Take 2 North to Downtown at 08:15 from First Ave',
    'Get off at Tower 08:24',
    'Walk 140m to Work (2 min)',
    'Arrive 08:25 (by 08:33)'
  ].join('\n'));
  assert.equal(router.summary(p, {}), 'Leave 8:13 AM · 2 at 8:15 AM');
  assert.equal(router.summary(p, { clock24: true }), 'Leave 08:13 · 2 at 08:15');

  const est = Object.assign({}, p, { estimated: true });
  assert.match(router.describe(est, {}), /^Leave ~8:13 AM\n[\s\S]*\nEstimated: no live times yet$/);
  assert.equal(router.summary(est, {}), 'Leave ~8:13 AM · 2 at ~8:15 AM');

  const walk = { arriveBy: NOW + 1200, leaveAt: NOW + 600, arriveAt: NOW + 1200, estimated: false, legs: [{ mode: 'walk', meters: 1200, seconds: 600, toName: 'Cafe' }] };
  assert.equal(router.summary(walk, { units: 'metric' }), 'Leave 8:10 AM · walk 1.2km');
  assert.equal(router.summary(walk, { units: 'imperial' }), 'Leave 8:10 AM · walk 0.7mi');
  assert.equal(router.describe(walk, { units: 'metric' }), 'Leave 8:10 AM\nWalk 1.2km to Cafe (10 min)\nArrive 8:20 AM (by 8:20 AM)');

  const tp = await plan(fakeSource({ routes: [T1, T2], trips: T_TRIPS }), { destination: TDEST, arriveBy: NOW + 2000, routeIds: ['T1', 'T2'] });
  assert.equal(router.summary(tp, {}), 'Leave 8:14 AM · T1 at 8:15 AM, then T2');
  const long = JSON.parse(JSON.stringify(tp));
  long.legs[1].routeName = 'A Very Long Route Name Indeed';
  const s = router.summary(long, {});
  assert.ok(s.length <= 40, s);
  assert.ok(s.startsWith('Leave 8:14 AM · A Very Long'));

  assert.equal(router.describe(null, {}), 'No route found');
  assert.equal(router.summary(null, {}), 'No route found');
});

// ---- the mock source ----
test('sanity against the mock source', async () => {
  let now = NOW;
  const mock = createMock({ location: C, routes: [{ id: 'A', name: 'Alpha' }, { id: 'B', name: 'Beta' }] }, () => now);
  const origin = geo.offset(C, 2200, 180), dest = geo.offset(C, 2200, 0);
  const p = await new Promise((res, rej) => router.plan(mock, {
    origin, destination: dest, arriveBy: NOW + 3600, now: NOW, routeIds: ['A', 'B'], walkSpeed: 1.3, maxWalk: 800, transferWalk: 250,
    maxTransfers: 1, minTransfer: 120
  }, (e, v) => e ? rej(e) : res(v)));
  assert.equal(p.estimated, false);
  const bus = p.legs.find(l => l.mode === 'bus');
  assert.equal(bus.routeId, 'A');
  assert.match(bus.tripKey, /^A:t\d+$/);
  const kb = +bus.boardStopId.split(':s')[1], ka = +bus.alightStopId.split(':s')[1];
  assert.ok(ka > kb);
  assert.equal(bus.arriveAt - bus.departAt, 50 * (ka - kb));
  assert.ok(p.leaveAt >= NOW && p.arriveAt <= NOW + 3600);
  // the next run (600 s later) would be too late
  assert.ok(p.arriveAt + 600 > NOW + 3600);
  assert.equal(bus.color, 'E53935');
  assert.match(router.summary(p, {}), /^Leave \d+:\d\d [AP]M · Alpha at /);
});
