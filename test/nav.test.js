const test = require('node:test');
const assert = require('node:assert/strict');
const nav = require('../src/common/nav');
const geo = require('../src/common/geo');
const format = require('../src/common/format');
const c24 = t => format.clock(t, true);

const HOME = { lat: 44.97, lon: -93.26 };
const STOP = geo.offset(HOME, 400, 90);          // 400 m east
const STOP2 = geo.offset(STOP, 3000, 90);        // 3 km further
const DEST = geo.offset(STOP2, 200, 0);          // 200 m north of STOP2
const NOW = 1768464000;

const data = { routes: { r1: { stops: { s1: Object.assign({ id: 's1', name: 'First' }, STOP), s2: Object.assign({ id: 's2', name: 'Second' }, STOP2) } } },
  stops: [] };

const pickup = { kind: 'pickup', key: 'pickup:s1:r1', badge: '44', title: 'First Ave', color: 'ff0000', routeId: 'r1', stopId: 's1', times: [NOW + 300, NOW + 900, 0] };
const dropoff = { kind: 'dropoff', key: 'dropoff:c', badge: '44', title: 'Second St', color: '00ff00', routeId: 'r1', stopId: 's2', times: [NOW + 100, 0, 0] };
const trip = { kind: 'trip', key: 'trip:work:0', destinationId: 'work', badge: '44', title: 'First', color: 'ff0000', routeId: 'r1', stopId: 's1', times: [NOW + 600, NOW + 1200, 0] };
const plan = { legs: [
  { mode: 'walk', meters: 400, seconds: 300, toName: 'First' },
  { mode: 'bus', routeId: 'r1', routeName: '44', color: 'ff0000', dir: 'EB', boardStopId: 's1', boardStopName: 'First', alightStopId: 's2', alightStopName: 'Second',
    departAt: NOW + 600, arriveAt: NOW + 1200 },
  { mode: 'walk', meters: 200, seconds: 150, toName: 'Work' }] };

function harness(over) {
  over = over || {};
  const sent = [], logs = [];
  let pos = HOME, now = NOW, iv = null;
  const cfg = Object.assign({ schedule: { walkSpeed: 1.3 }, clock24: true, routingUrl: '', destinations: [{ id: 'work', name: 'Work', lat: DEST.lat, lon: DEST.lon }] }, over.config);
  const n = nav.createNav({
    send: m => sent.push(...m), locate: cb => cb(null, pos), clock: () => now,
    getList: () => ({ listId: 5, items: over.items || [pickup, dropoff, trip], data }),
    getConfig: () => cfg, getUnits: () => 'metric', getPlan: id => (id === 'work' ? plan : null),
    route: over.route, setInterval: fn => { iv = fn; return 1; }, clearInterval: () => { iv = null; }, log: m => logs.push(m)
  });
  return { n, sent, logs, cfg, move: p => { pos = p; }, at: t => { now = t; }, tick: () => iv && iv(), running: () => iv !== null };
}

test('pickup: an arrow to the stop, then "wait" once you are there', () => {
  const h = harness();
  assert.equal(h.n.start(5, 0), true);
  const m = h.sent[0];
  assert.equal(m.NAV_STATE, 1);
  assert.equal(m.NAV_TEXT, 'Walk to First Ave');
  assert.equal(m.NAV_BEARING, 90);
  assert.equal(m.NAV_DIST, '400m');
  assert.equal(m.NAV_COLOR, 0xff0000);
  assert.match(m.NAV_SUB, /walk/);
  h.move(geo.offset(STOP, 10, 270));
  h.tick();
  const w = h.sent[h.sent.length - 1];
  assert.equal(w.NAV_STATE, 2);
  assert.equal(w.NAV_TEXT, 'Wait for the 44');
  assert.equal(w.NAV_SUB, 'Next 5 min');
});

test('identical guidance is not sent twice; a changed bearing / distance is', () => {
  const h = harness();
  h.n.start(5, 0);
  h.tick(); h.tick();
  assert.equal(h.sent.length, 1);
  h.move(geo.offset(HOME, 100, 90));
  h.tick();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].NAV_DIST, '300m');
});

test('dropoff: ride to the stop, then "get off here"', () => {
  const h = harness();
  h.n.start(5, 1);
  assert.equal(h.sent[0].NAV_TEXT, 'Ride to Second St');
  assert.equal(h.sent[0].NAV_DIST, '3.4km');
  h.move(geo.offset(STOP2, 30, 180));
  h.tick();
  assert.equal(h.sent[1].NAV_STATE, 2);
  assert.equal(h.sent[1].NAV_TEXT, 'Get off here');
});

test('trip: walk → board → ride → arrive, each advancing on its own rule', () => {
  const h = harness();
  h.n.start(5, 2);
  assert.equal(h.sent[0].NAV_TEXT, 'Walk to First');
  assert.match(h.sent[0].NAV_SUB, new RegExp('44 at ' + c24(NOW + 600)));
  h.move(STOP); h.tick();
  const board = h.sent[h.sent.length - 1];
  assert.equal(board.NAV_TEXT, 'Board 44 EB');
  assert.equal(board.NAV_SUB, 'First · ' + c24(NOW + 600) + ' · 10 min');
  h.at(NOW + 700); h.tick();                      // the bus has left
  const ride = h.sent[h.sent.length - 1];
  assert.equal(ride.NAV_TEXT, 'Ride to Second');
  assert.match(ride.NAV_SUB, new RegExp('^Arrive ' + c24(NOW + 1200)));
  h.move(geo.offset(STOP2, 20, 0)); h.at(NOW + 1180); h.tick();
  const walk = h.sent[h.sent.length - 1];
  assert.equal(walk.NAV_TEXT, 'Walk to Work');
  assert.equal(walk.NAV_BEARING, 0);
  h.move(geo.offset(DEST, 10, 180)); h.tick();
  const last = h.sent[h.sent.length - 1];
  assert.equal(last.NAV_STATE, 2);
  assert.equal(last.NAV_TEXT, 'Arrive at Work');
});

test('trip: legs that are over are skipped', () => {
  const h = harness();
  h.at(NOW + 1300);
  h.move(STOP2);
  h.n.start(5, 2);
  assert.equal(h.sent[0].NAV_TEXT, 'Walk to Work');
});

test('trip without a stored plan: an info line, no arrow', () => {
  const h = harness({ items: [Object.assign({}, trip, { destinationId: 'other' })] });
  h.n.start(5, 0);
  assert.equal(h.sent[0].NAV_TEXT, 'No trip plan');
  assert.equal(h.sent[0].NAV_BEARING, -1);
  assert.equal(h.sent[0].NAV_STATE, 2);
});

test('a stop without coordinates: an info line', () => {
  const h = harness({ items: [Object.assign({}, pickup, { stopId: 'zz' })] });
  h.n.start(5, 0);
  assert.equal(h.sent[0].NAV_TEXT, 'No location for First Ave');
});

test('start: a stale list id / bad index does nothing', () => {
  const h = harness();
  assert.equal(h.n.start(4, 0), false);
  assert.equal(h.n.start(5, -1), false);
  assert.equal(h.n.start(5, 3), false);
  assert.equal(h.sent.length, 0);
  assert.equal(h.running(), false);
});

test('stop: tells the watch to close; silent stop does not; the poll timer is cleared', () => {
  const h = harness();
  h.n.start(5, 0);
  assert.equal(h.running(), true);
  h.n.stop();
  assert.deepEqual(h.sent[h.sent.length - 1], { NAV_STATE: 0 });
  assert.equal(h.running(), false);
  h.n.start(5, 0);
  const n = h.sent.length;
  h.n.stop(true);
  assert.equal(h.sent.length, n);
});

test('navigation ends by itself after two hours', () => {
  const h = harness();
  h.n.start(5, 0);
  h.at(NOW + 7300);
  h.tick();
  assert.deepEqual(h.sent[h.sent.length - 1], { NAV_STATE: 0 });
  assert.equal(h.n.active(), false);
});

test('routing source: a walk follows the waypoints and their instructions', () => {
  const mid = geo.offset(HOME, 200, 90);
  const calls = [];
  const h = harness({ config: { routingUrl: 'https://r/{to}' }, route: (tpl, from, to, cb) => {
    calls.push([tpl, from, to]);
    cb(null, [{ lat: HOME.lat, lon: HOME.lon, text: 'Head east' }, { lat: mid.lat, lon: mid.lon, text: 'Turn left' }, { lat: STOP.lat, lon: STOP.lon, text: 'Arrive' }]);
  } });
  h.n.start(5, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://r/{to}');
  h.tick();                                           // the route is in: the first waypoint is where you stand
  assert.equal(h.sent[h.sent.length - 1].NAV_TEXT, 'Turn left');
  assert.equal(h.sent[h.sent.length - 1].NAV_DIST, '200m');
  assert.match(h.sent[h.sent.length - 1].NAV_SUB, /walk/);
  h.move(geo.offset(mid, 5, 270)); h.tick();
  assert.equal(h.sent[h.sent.length - 1].NAV_TEXT, 'Arrive');
  assert.equal(calls.length, 1, 'fetched once per step');
});

test('routing source failing: the straight arrow stays', () => {
  const h = harness({ config: { routingUrl: 'https://r/{to}' }, route: (tpl, from, to, cb) => cb(new Error('Network error')) });
  h.n.start(5, 0);
  h.tick();
  assert.equal(h.sent[0].NAV_TEXT, 'Walk to First Ave');
  assert.ok(h.logs.some(l => /routing failed: Network error/.test(l)));
});

test('no routing source configured: the fetcher is never called', () => {
  let called = 0;
  const h = harness({ route: () => { called++; } });
  h.n.start(5, 0);
  assert.equal(called, 0);
});
