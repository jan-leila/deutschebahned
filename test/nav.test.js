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

// the guidance the watch has now: its rows (the last list's window, in order) and live state
function state(h) {
  const live = h.sent.filter(m => 'NAV_STATE' in m).pop();
  const at = h.sent.map(m => 'NAV_COUNT' in m).lastIndexOf(true);
  const steps = [];
  for (let i = at + 1; i < h.sent.length && 'NAV_INDEX' in h.sent[i]; i++) steps[h.sent[i].NAV_INDEX] = h.sent[i];
  return { live, steps, count: h.sent[at] && h.sent[at].NAV_COUNT, current: live && steps[live.NAV_CURRENT] };
}
const KIND = { walk: 0, board: 1, ride: 2, wait: 3, arrive: 4, info: 5, turn: 6, stop: 7, fold: 8 };
// NAV_RAIL → [marker, top, bottom] as names
function rail(m) {
  const line = ['none', 'line', 'dash'];
  return [['none', 'stop', 'here'][m.NAV_RAIL & 3], line[(m.NAV_RAIL >> 2) & 3], line[(m.NAV_RAIL >> 4) & 3]];
}

// a route with nine stops 400 m apart heading east, s0 at STOP
const LINE = Array.from({ length: 9 }, (_, i) => Object.assign({ id: 'L' + i, name: 'Stop ' + i }, geo.offset(STOP, i * 400, 90)));
const lineData = { routes: { r9: { stops: Object.fromEntries(LINE.map(s => [s.id, s])),
  directions: [{ id: 'w', stopIds: LINE.map(s => s.id).reverse() }, { id: 'e', stopIds: LINE.map(s => s.id) }] } }, stops: [] };

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

test('routing source: every turn is kept; the rows show the next few, the rest folded, the last turn', () => {
  const pts = [];
  for (let i = 1; i <= 40; i++) pts.push({ ...geo.offset(HOME, i * 80, 90), text: 'Turn ' + i });
  const h = harness({ config: { routingUrl: 'https://r/{to}' }, route: (tpl, f, t, cb) => cb(null, pts) });
  h.n.start(5, 0);
  h.tick();
  let s = state(h);
  assert.deepEqual(s.steps.map(x => x.NAV_TEXT), ['Turn 1', 'Turn 2', 'Turn 3', 'Turn 4', '35 more turns', 'Turn 40', 'Wait for the 44']);
  assert.equal(s.steps[4].NAV_KIND, KIND.fold);
  assert.deepEqual(s.steps.slice(0, 6).map(r => rail(r)[0]), ['none', 'none', 'none', 'none', 'none', 'none']);
  assert.deepEqual(rail(s.steps[1]).slice(1), ['dash', 'dash'], 'walking: a dashed line through every row');
  assert.deepEqual(rail(s.steps[6]), ['stop', 'dash', 'none'], 'the stop you wait at: a circle');
  // half way: the turns behind are folded too
  for (let i = 0; i < 19; i++) { h.move(pts[i]); h.tick(); }
  s = state(h);
  assert.deepEqual(s.steps.map(x => x.NAV_TEXT),
    ['17 earlier turns', 'Turn 18', 'Turn 19', 'Turn 20', 'Turn 21', 'Turn 22', 'Turn 23', '16 more turns', 'Turn 40', 'Wait for the 44']);
  assert.equal(s.current.NAV_TEXT, 'Turn 20');
});

test('trip: the ride lists its stops while you are on it; other legs fold to one or two rows', () => {
  const tplan = { legs: [
    { mode: 'walk', meters: 400, seconds: 300, toName: 'Stop 0' },
    { mode: 'bus', routeId: 'r9', routeName: '9', color: '0000ff', dir: 'EB', dirId: 'e', boardStopId: 'L0', boardStopName: 'Stop 0',
      alightStopId: 'L8', alightStopName: 'Stop 8', departAt: NOW + 600, arriveAt: NOW + 1800 },
    { mode: 'walk', meters: 200, seconds: 150, toName: 'Work' }] };
  const sent = [];
  let pos = HOME, now = NOW, iv = null;
  const n = nav.createNav({
    send: m => sent.push(...m), locate: cb => cb(null, pos), clock: () => now,
    getList: () => ({ listId: 5, items: [trip], data: lineData }),
    getConfig: () => ({ schedule: { walkSpeed: 1.3 }, clock24: true, routingUrl: '',
                        destinations: [{ id: 'work', name: 'Work', ...geo.offset(LINE[8], 200, 0) }] }),
    getUnits: () => 'metric', getPlan: () => tplan, setInterval: fn => { iv = fn; return 1; }, clearInterval: () => {}
  });
  const h = { sent };
  n.start(5, 0);
  let s = state(h);
  assert.deepEqual(s.steps.map(x => x.NAV_TEXT), ['Walk to Stop 0', 'Board 9 EB', 'Get off at Stop 8', 'Walk to Work', 'Arrive at Work']);
  assert.equal(s.steps[2].NAV_SUB, '8 stops · Arrive ' + c24(NOW + 1800));
  assert.deepEqual(s.steps.map(rail), [['none', 'none', 'dash'], ['stop', 'dash', 'line'], ['stop', 'line', 'dash'],
                                       ['none', 'dash', 'dash'], ['stop', 'dash', 'none']]);
  assert.equal(s.steps[1].NAV_COLOR, 0x0000ff);
  // at the stop: boarding opens the ride
  pos = LINE[0]; iv();
  s = state(h);
  assert.deepEqual(s.steps.map(x => x.NAV_TEXT),
    ['Walk to Stop 0', 'Board 9 EB', 'Stop 1', 'Stop 2', 'Stop 3', '4 more stops', 'Get off at Stop 8', 'Walk to Work', 'Arrive at Work']);
  assert.equal(s.current.NAV_TEXT, 'Board 9 EB');
  assert.equal(s.steps[5].NAV_KIND, KIND.fold);
  assert.deepEqual(rail(s.steps[5]), ['none', 'line', 'line']);
  // riding, a little past Stop 4: it is the stop you are at (filled), the ones behind and ahead around it
  now = NOW + 700; pos = geo.offset(LINE[4], 100, 90); iv();
  s = state(h);
  assert.deepEqual(s.steps.map(x => x.NAV_TEXT),
    ['Walk to Stop 0', '2 earlier stops', 'Stop 2', 'Stop 3', 'Stop 4', 'Stop 5', 'Stop 6', 'Stop 7', 'Get off at Stop 8', 'Walk to Work', 'Arrive at Work']);
  assert.equal(s.current.NAV_TEXT, 'Stop 4');
  assert.equal(s.current.NAV_SUB, '4 stops to Stop 8');
  assert.deepEqual(rail(s.current), ['here', 'line', 'line']);
  assert.equal(rail(s.steps[3])[0], 'stop');
  assert.match(s.live.NAV_LSUB, /^Arrive/);
  // just before Stop 5 it is still Stop 4; at it, Stop 5
  pos = geo.offset(LINE[5], 100, 270); iv();
  assert.equal(state(h).current.NAV_TEXT, 'Stop 4');
  pos = LINE[5]; iv();
  assert.equal(state(h).current.NAV_TEXT, 'Stop 5');
  // back towards Stop 4 (GPS noise): it never goes back
  pos = geo.offset(LINE[4], 50, 90); iv();
  assert.equal(state(h).current.NAV_TEXT, 'Stop 5');
});

test('dropoff: the ride starts at the stop nearest you on the way to yours', () => {
  const sent = [];
  const item = { kind: 'dropoff', key: 'dropoff:x', badge: '9', title: 'Stop 6', color: '00ff00', routeId: 'r9', stopId: 'L6', times: [] };
  const n = nav.createNav({
    send: m => sent.push(...m), locate: cb => cb(null, geo.offset(LINE[2], 20, 0)), clock: () => NOW,
    getList: () => ({ listId: 5, items: [item], data: lineData }),
    getConfig: () => ({ schedule: { walkSpeed: 1.3 }, clock24: true, routingUrl: '' }), getUnits: () => 'metric',
    getPlan: () => null, setInterval: () => 1, clearInterval: () => {}
  });
  n.start(5, 0);
  const s = state({ sent });
  assert.deepEqual(s.steps.map(x => x.NAV_TEXT), ['Stop 2', 'Stop 3', 'Stop 4', 'Stop 5', 'Get off here']);
  assert.equal(s.current.NAV_TEXT, 'Stop 2');
  assert.deepEqual(s.steps.map(r => rail(r)[0]), ['here', 'stop', 'stop', 'stop', 'stop']);
  assert.deepEqual(rail(s.steps[4]), ['stop', 'line', 'none']);
  assert.deepEqual(nav.rideStops(lineData, 'r9', null, null, 'L6', LINE[7]).map(x => x.id), ['L7', 'L6'],
    'past your stop: the other direction takes you back');
  assert.deepEqual(nav.rideStops(lineData, 'r9', 'e', 'L6', 'L2', null).map(x => x.id), ['L6', 'L5', 'L4', 'L3', 'L2'],
    'the given direction does not serve them in that order: the one that does');
  assert.equal(nav.rideStops(lineData, 'r9', 'e', 'L6', 'zz', null), null);
});

test('fetch: the window of rows around the one the watch scrolled to', () => {
  const pts = [];
  for (let i = 1; i <= 40; i++) pts.push({ ...geo.offset(HOME, i * 80, 90), text: 'Turn ' + i });
  const h = harness({ config: { routingUrl: 'https://r/{to}' }, route: (tpl, f, t, cb) => cb(null, pts) });
  h.n.fetch(3);
  assert.equal(h.sent.length, 0, 'nothing running: nothing sent');
  h.n.start(5, 0);
  h.tick();
  const n = h.sent.length;
  h.n.fetch(6);
  const got = h.sent.slice(n);
  assert.equal(got[0].NAV_INDEX, 6);
  assert.equal(got[0].NAV_TEXT, 'Wait for the 44');
  assert.ok(got.every(m => 'NAV_INDEX' in m));
  h.n.fetch('x');
  assert.equal(h.sent.length, n + got.length);
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

test('place: walk to the saved location, then arrive (from the places list)', () => {
  const sent = [];
  const place = { kind: 'place', key: 'place:home', title: 'Home', color: '', lat: STOP.lat, lon: STOP.lon };
  const n = nav.createNav({
    send: m => sent.push(...m), locate: cb => cb(null, HOME), clock: () => NOW,
    getList: () => ({ listId: 5, items: [pickup], data }), getPlaces: () => ({ listId: 2, items: [place] }),
    getConfig: () => ({ schedule: { walkSpeed: 1.3 }, clock24: true, routingUrl: '' }), getUnits: () => 'metric',
    getPlan: () => null, setInterval: () => 1, clearInterval: () => {},
  });
  assert.equal(n.start(5, 0, true), false, 'the places list has its own id');
  assert.equal(n.start(2, 0, true), true);
  const steps = sent.filter(m => 'NAV_INDEX' in m);
  assert.deepEqual(steps.map(m => [m.NAV_KIND, m.NAV_TEXT]), [[KIND.walk, 'Walk to Home'], [KIND.arrive, 'Arrive at Home']]);
  assert.equal(sent.find(m => 'NAV_STATE' in m).NAV_LDIST, '400m');
  assert.deepEqual(nav.buildSteps({ kind: 'place', title: 'X' }, {}).map(st => st.type), ['info']);
});

test('startItem: navigates to a tile given directly, replacing what was running', () => {
  const h = harness();
  assert.equal(h.n.start(5, 1), true);
  h.sent.length = 0;
  assert.equal(h.n.startItem({ kind: 'pickup', routeId: 'r1', stopId: 's1', badge: '44', title: 'First', color: '', times: [] }, data), true);
  assert.deepEqual(h.sent.filter(m => 'NAV_INDEX' in m).map(m => m.NAV_TEXT), ['Walk to First', 'Wait for the 44']);
  assert.equal(h.n.startItem(null, data), false);
  assert.equal(h.running(), false, 'nothing to navigate to: the old guidance is over too');
});
