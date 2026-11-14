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

// the guidance the watch has now: its step list and live state
function state(h) {
  const live = h.sent.filter(m => 'NAV_STATE' in m).pop();
  const at = h.sent.map(m => 'NAV_COUNT' in m).lastIndexOf(true);
  const steps = [];
  for (let i = at + 1; i < h.sent.length && 'NAV_INDEX' in h.sent[i]; i++) steps.push(h.sent[i]);
  return { live, steps, current: live && steps[live.NAV_CURRENT] };
}
const KIND = { walk: 0, board: 1, ride: 2, wait: 3, arrive: 4, info: 5, turn: 6 };

test('pickup: a list of two steps, an arrow to the stop, then "wait" once you are there', () => {
  const h = harness();
  assert.equal(h.n.start(5, 0), true);
  assert.equal(h.sent[0].NAV_COUNT, 2);
  let s = state(h);
  assert.deepEqual(s.steps.map(x => x.NAV_TEXT), ['Walk to First Ave', 'Wait for the 44']);
  assert.deepEqual(s.steps.map(x => x.NAV_KIND), [KIND.walk, KIND.wait]);
  assert.equal(s.steps[0].NAV_DIR, 'EB');
  assert.equal(s.steps[0].NAV_DIST, '400m');
  assert.equal(s.steps[0].NAV_COLOR, 0xff0000);
  assert.equal(s.live.NAV_STATE, 1);
  assert.equal(s.live.NAV_CURRENT, 0);
  assert.equal(s.live.NAV_BEARING, 90);
  assert.equal(s.live.NAV_LDIST, '400m');
  assert.match(s.live.NAV_LSUB, /left/);
  h.move(geo.offset(STOP, 10, 270));
  h.tick();
  s = state(h);
  assert.equal(s.live.NAV_STATE, 2);
  assert.equal(s.live.NAV_CURRENT, 1);
  assert.equal(s.live.NAV_LSUB, 'Next 5 min');
});

test('only what changed is sent: the list once, the live message when it differs', () => {
  const h = harness();
  h.n.start(5, 0);
  const n = h.sent.length;
  h.tick(); h.tick();
  assert.equal(h.sent.length, n);
  h.move(geo.offset(HOME, 100, 90));
  h.tick();
  assert.equal(h.sent.length, n + 1);
  assert.equal(h.sent[n].NAV_LDIST, '300m');
  assert.equal(h.sent.filter(m => 'NAV_COUNT' in m).length, 1);
});

test('dropoff: ride to the stop, then "get off here"', () => {
  const h = harness();
  h.n.start(5, 1);
  let s = state(h);
  assert.deepEqual(s.steps.map(x => x.NAV_TEXT), ['Ride to Second St', 'Get off here']);
  assert.equal(s.live.NAV_LDIST, '3.4km');
  h.move(geo.offset(STOP2, 30, 180));
  h.tick();
  s = state(h);
  assert.equal(s.live.NAV_CURRENT, 1);
  assert.equal(s.live.NAV_STATE, 2);
});

test('trip: walk → board → ride → walk → arrive, with each step\'s detail and direction', () => {
  const h = harness();
  h.n.start(5, 2);
  let s = state(h);
  assert.deepEqual(s.steps.map(x => x.NAV_TEXT), ['Walk to First', 'Board 44 EB', 'Ride to Second', 'Walk to Work', 'Arrive at Work']);
  assert.deepEqual(s.steps.map(x => x.NAV_KIND), [KIND.walk, KIND.board, KIND.ride, KIND.walk, KIND.arrive]);
  assert.match(s.steps[0].NAV_SUB, new RegExp('44 at ' + c24(NOW + 600)));
  assert.equal(s.steps[1].NAV_SUB, 'First · ' + c24(NOW + 600));
  assert.equal(s.steps[1].NAV_DIR, 'EB');
  assert.equal(s.steps[2].NAV_SUB, 'Arrive ' + c24(NOW + 1200));
  assert.equal(s.steps[2].NAV_DIST, '3.0km');                  // First → Second
  assert.equal(s.steps[3].NAV_DIR, 'NB');
  assert.equal(s.steps[3].NAV_DIST, '200m');
  h.move(STOP); h.tick();
  s = state(h);
  assert.equal(s.live.NAV_CURRENT, 1);
  assert.equal(s.live.NAV_LSUB, 'Departs 10 min');
  h.at(NOW + 700); h.tick();
  s = state(h);
  assert.equal(s.live.NAV_CURRENT, 2);
  assert.match(s.live.NAV_LSUB, /^Arrive \d+ min$/);
  h.move(geo.offset(STOP2, 20, 0)); h.at(NOW + 1180); h.tick();
  s = state(h);
  assert.equal(s.live.NAV_CURRENT, 3);
  assert.equal(s.live.NAV_BEARING, 0);
  h.move(geo.offset(DEST, 10, 180)); h.tick();
  s = state(h);
  assert.equal(s.live.NAV_CURRENT, 4);
  assert.equal(s.live.NAV_STATE, 2);
});

test('trip: legs that are over are not listed', () => {
  const h = harness();
  h.at(NOW + 1300);
  h.move(STOP2);
  h.n.start(5, 2);
  assert.deepEqual(state(h).steps.map(x => x.NAV_TEXT), ['Walk to Work', 'Arrive at Work']);
});

test('trip without a stored plan: an info step, no arrow', () => {
  const h = harness({ items: [Object.assign({}, trip, { destinationId: 'other' })] });
  h.n.start(5, 0);
  const s = state(h);
  assert.equal(s.steps[0].NAV_TEXT, 'No trip plan');
  assert.equal(s.steps[0].NAV_KIND, KIND.info);
  assert.equal(s.live.NAV_BEARING, -1);
  assert.equal(s.live.NAV_STATE, 2);
});

test('a stop without coordinates: an info step', () => {
  const h = harness({ items: [Object.assign({}, pickup, { stopId: 'zz' })] });
  h.n.start(5, 0);
  assert.equal(state(h).steps[0].NAV_TEXT, 'No location for First Ave');
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

test('routing source: the walking step becomes its turns', () => {
  const mid = geo.offset(HOME, 200, 90);
  const calls = [];
  const h = harness({ config: { routingUrl: 'https://r/{to}' }, route: (tpl, from, to, cb) => {
    calls.push([tpl, from, to]);
    cb(null, [{ lat: mid.lat, lon: mid.lon, text: 'Turn left' }, { lat: STOP.lat, lon: STOP.lon, text: 'Arrive' }]);
  } });
  h.n.start(5, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://r/{to}');
  h.tick();                                           // the route is in: the walk is now two turns, then "wait"
  let s = state(h);
  assert.deepEqual(s.steps.map(x => x.NAV_TEXT), ['Turn left', 'Arrive', 'Wait for the 44']);
  assert.deepEqual(s.steps.map(x => x.NAV_KIND), [KIND.turn, KIND.turn, KIND.wait]);
  assert.equal(s.steps[0].NAV_DIST, '200m');
  assert.equal(s.steps[0].NAV_DIR, 'EB');
  assert.equal(s.live.NAV_CURRENT, 0);
  assert.equal(s.live.NAV_LDIST, '200m');
  h.move(geo.offset(mid, 5, 270)); h.tick();
  s = state(h);
  assert.equal(s.live.NAV_CURRENT, 1);
  assert.equal(s.live.NAV_LDIST, '200m');
  assert.equal(calls.length, 1, 'fetched once per step');
});

test('routing source: more turns than the list has room for are thinned', () => {
  const pts = [];
  for (let i = 1; i <= 40; i++) pts.push({ lat: HOME.lat, lon: HOME.lon + i * 0.0001, text: 'Turn ' + i });
  const h = harness({ config: { routingUrl: 'https://r/{to}' }, route: (tpl, f, t, cb) => cb(null, pts) });
  h.n.start(5, 0);
  h.tick();
  const s = state(h);
  assert.equal(s.steps.length, 16);
  assert.equal(s.steps[14].NAV_TEXT, 'Turn 40');
  assert.equal(s.steps[15].NAV_TEXT, 'Wait for the 44');
});

test('routing source failing: the straight arrow stays', () => {
  const h = harness({ config: { routingUrl: 'https://r/{to}' }, route: (tpl, from, to, cb) => cb(new Error('Network error')) });
  h.n.start(5, 0);
  h.tick();
  assert.equal(state(h).steps[0].NAV_TEXT, 'Walk to First Ave');
  assert.ok(h.logs.some(l => /routing failed: Network error/.test(l)));
});

test('no routing source configured: the fetcher is never called', () => {
  let called = 0;
  const h = harness({ route: () => { called++; } });
  h.n.start(5, 0);
  assert.equal(called, 0);
});
