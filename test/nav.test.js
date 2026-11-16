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
const KIND = { walk: 0, board: 1, ride: 2, wait: 3, arrive: 4, info: 5, turn: 6, stop: 7, fold: 8, head: 9 };
const texts = s => s.steps.map(x => x.NAV_TEXT);
const header = h => h.sent.filter(m => 'NAV_COUNT' in m).pop();
// NAV_RAIL → [marker, top, bottom] as names
function rail(m) {
  const line = ['none', 'line', 'dash'];
  return [['none', 'stop', 'here'][m.NAV_RAIL & 3], line[(m.NAV_RAIL >> 2) & 3], line[(m.NAV_RAIL >> 4) & 3]];
}

// a route with nine stops 400 m apart heading east, s0 at STOP
const LINE = Array.from({ length: 9 }, (_, i) => Object.assign({ id: 'L' + i, name: 'Stop ' + i }, geo.offset(STOP, i * 400, 90)));
const lineData = { routes: { r9: { stops: Object.fromEntries(LINE.map(s => [s.id, s])),
  directions: [{ id: 'w', stopIds: LINE.map(s => s.id).reverse() }, { id: 'e', stopIds: LINE.map(s => s.id) }] } }, stops: [] };

test('pickup: the walk (its header, then the step) and the stop to wait at; an arrow to the stop, then "wait"', () => {
  const h = harness();
  assert.equal(h.n.start(5, 0), true);
  assert.equal(h.sent[0].NAV_COUNT, 3);
  let s = state(h);
  assert.deepEqual(texts(s), ['First Ave', 'Walk to First Ave', 'Wait for the 44']);
  assert.deepEqual(s.steps.map(x => x.NAV_KIND), [KIND.head, KIND.walk, KIND.wait]);
  assert.equal(s.steps[0].NAV_ROUTE, 'Walk');
  assert.equal(s.steps[0].NAV_SUB, 'arr ' + c24(NOW + 308));
  assert.equal(s.steps[1].NAV_DIR, 'EB');
  assert.equal(s.steps[1].NAV_DIST, '400m');
  assert.equal(s.steps[1].NAV_COLOR, 0xff0000);
  assert.equal(s.steps[2].NAV_SUB, c24(NOW + 900), 'the bus you can catch (not the one in 5 min: the walk takes longer)');
  assert.deepEqual([header(h).NAV_HEAD, header(h).NAV_HEAD_END], [0, 1]);
  assert.equal(s.live.NAV_STATE, 1);
  assert.equal(s.live.NAV_SHOW, 1, 'a new trip opens the trip view');
  assert.equal(s.live.NAV_CURRENT, 1);
  assert.equal(s.live.NAV_BEARING, 90);
  assert.equal(s.live.NAV_LDIST, '400m');
  assert.match(s.live.NAV_LSUB, /left/);
  h.move(geo.offset(STOP, 10, 270));
  h.tick();
  s = state(h);
  assert.deepEqual(texts(s), ['First Ave', 'Wait for the 44'], 'the walk is done: its header only');
  assert.equal(s.live.NAV_STATE, 2);
  assert.equal(s.live.NAV_CURRENT, 1);
  assert.equal(s.live.NAV_LSUB, 'Next 5 min');
  assert.equal('NAV_SHOW' in s.live, false);
  assert.deepEqual([header(h).NAV_HEAD, header(h).NAV_HEAD_END], [-1, -1]);
});

test('only what changed is sent: the list once, the live message when it differs', () => {
  const h = harness();
  h.n.start(5, 0);
  const n = h.sent.length;
  h.tick(); h.tick();
  assert.equal(h.sent.length, n);
  h.move(geo.offset(HOME, 10, 270));
  h.tick();
  assert.equal(h.sent.length, n + 1);
  assert.equal(h.sent[n].NAV_LDIST, '410m');
  assert.equal(h.sent.filter(m => 'NAV_COUNT' in m).length, 1);
});

test('dropoff: ride to the stop, then "get off here"', () => {
  const h = harness();
  h.n.start(5, 1);
  let s = state(h);
  assert.deepEqual(texts(s), ['Second St', 'Ride to Second St', 'Get off here']);
  assert.equal(s.steps[0].NAV_BADGE, '44');
  assert.equal(s.live.NAV_LDIST, '3.4km');
  h.move(geo.offset(STOP2, 30, 180));
  h.tick();
  s = state(h);
  assert.equal(s.current.NAV_TEXT, 'Get off here');
  assert.equal(s.live.NAV_STATE, 2);
});

test('trip: one leg open at a time, each a header with its route, direction, length and arrival', () => {
  const h = harness();
  h.n.start(5, 2);
  let s = state(h);
  assert.deepEqual(texts(s), ['First', 'Walk to First', 'Second', 'Work', 'Arrive at Work']);
  assert.deepEqual(s.steps.map(x => x.NAV_KIND), [KIND.head, KIND.walk, KIND.head, KIND.head, KIND.arrive]);
  assert.match(s.steps[0].NAV_ROUTE, new RegExp('44 at ' + c24(NOW + 600)));
  assert.equal(s.steps[2].NAV_BADGE, '44');
  assert.equal(s.steps[2].NAV_DIR, 'EB');
  assert.equal(s.steps[2].NAV_SUB, 'East · arr ' + c24(NOW + 1200));
  assert.equal(s.steps[2].NAV_DIST, '3.0km');                  // First → Second
  assert.equal(s.steps[2].NAV_RAIL & 64, 64, 'closed: a long SELECT opens it');
  assert.equal(s.steps[3].NAV_DIR, 'NB');
  assert.equal(s.steps[3].NAV_DIST, '200m');
  h.move(STOP); h.tick();
  s = state(h);
  assert.deepEqual(texts(s), ['First', 'Second', 'Board 44 EB', 'Ride to Second', 'Work', 'Arrive at Work']);
  assert.equal(s.current.NAV_TEXT, 'Board 44 EB');
  assert.equal(s.steps[2].NAV_SUB, 'First · ' + c24(NOW + 600));
  assert.equal(s.live.NAV_LSUB, 'Departs 10 min');
  h.at(NOW + 700); h.tick();
  s = state(h);
  assert.equal(s.current.NAV_TEXT, 'Ride to Second');
  assert.match(s.live.NAV_LSUB, /^Arrive \d+ min$/);
  h.move(geo.offset(STOP2, 20, 0)); h.at(NOW + 1180); h.tick();
  s = state(h);
  assert.deepEqual(texts(s), ['First', 'Second', 'Work', 'Walk to Work', 'Arrive at Work']);
  assert.equal(s.current.NAV_TEXT, 'Walk to Work');
  assert.equal(s.live.NAV_BEARING, 0);
  h.move(geo.offset(DEST, 10, 180)); h.tick();
  s = state(h);
  assert.equal(s.current.NAV_TEXT, 'Arrive at Work');
  assert.equal(s.live.NAV_STATE, 2);
});

test('trip: legs that are over are not listed', () => {
  const h = harness();
  h.at(NOW + 1300);
  h.move(STOP2);
  h.n.start(5, 2);
  assert.deepEqual(texts(state(h)), ['Work', 'Walk to Work', 'Arrive at Work']);
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

test('start: a stale list id / bad index does nothing (and leaves a trip running)', () => {
  const h = harness();
  assert.equal(h.n.start(4, 0), false);
  assert.equal(h.n.start(5, -1), false);
  assert.equal(h.n.start(5, 3), false);
  assert.equal(h.sent.length, 0);
  assert.equal(h.running(), false);
  h.n.start(5, 0);
  assert.equal(h.n.start(5, 9), false);
  assert.equal(h.n.guiding(), true);
});

test('stop: tells the watch the trip is over; silent stop does not; the poll timer is cleared', () => {
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

test('a trip ends by itself after two hours', () => {
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
  assert.deepEqual(texts(s), ['First Ave', 'Turn left', 'Arrive', 'Wait for the 44']);
  assert.deepEqual(s.steps.map(x => x.NAV_KIND), [KIND.head, KIND.turn, KIND.turn, KIND.wait]);
  assert.equal(s.steps[0].NAV_SUB, 'arr ' + c24(NOW + 308) + ' · 1 turn');
  assert.equal(s.steps[1].NAV_DIST, '200m');
  assert.equal(s.steps[1].NAV_DIR, 'EB');
  assert.equal(s.steps[2].NAV_SUB, c24(NOW + 308), 'the turn still ahead: when you get there');
  assert.equal(s.live.NAV_CURRENT, 1);
  assert.equal(s.live.NAV_LDIST, '200m');
  h.move(geo.offset(mid, 5, 270)); h.tick();
  s = state(h);
  assert.equal(s.live.NAV_CURRENT, 2);
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
  assert.deepEqual(texts(s), ['First Ave', 'Turn 1', 'Turn 2', 'Turn 3', 'Turn 4', '35 more turns', 'Turn 40', 'Wait for the 44']);
  assert.equal(s.steps[5].NAV_KIND, KIND.fold);
  assert.equal(s.steps[5].NAV_RAIL & 64, 64, 'a long SELECT shows them');
  assert.deepEqual(s.steps.slice(1, 7).map(r => rail(r)[0]), ['none', 'none', 'none', 'none', 'none', 'none']);
  assert.deepEqual(rail(s.steps[2]).slice(1), ['dash', 'dash'], 'walking: a dashed line through every row');
  assert.deepEqual(rail(s.steps[7]), ['stop', 'dash', 'none'], 'the stop you wait at: a circle');
  // half way: the turns behind are folded too
  for (let i = 0; i < 19; i++) { h.move(pts[i]); h.tick(); }
  s = state(h);
  assert.deepEqual(texts(s),
    ['First Ave', '17 earlier turns', 'Turn 18', 'Turn 19', 'Turn 20', 'Turn 21', 'Turn 22', 'Turn 23', '16 more turns', 'Turn 40', 'Wait for the 44']);
  assert.equal(s.current.NAV_TEXT, 'Turn 20');
  assert.equal(s.steps[0].NAV_SUB.split(' · ')[1], '20 turns');
  // a long SELECT on the fold: every turn of the walk
  assert.equal(h.n.unfold(8), true);
  s = state(h);
  assert.equal(s.count, 1 + 40 + 1);
});

function lineTrip(over) {
  const tplan = { legs: [
    { mode: 'walk', meters: 400, seconds: 300, toName: 'Stop 0' },
    { mode: 'bus', routeId: 'r9', routeName: '9', color: '0000ff', dir: 'EB', dirId: 'e', headsign: 'Downtown', boardStopId: 'L0',
      boardStopName: 'Stop 0', alightStopId: 'L8', alightStopName: 'Stop 8', departAt: NOW + 600, arriveAt: NOW + 1800 },
    { mode: 'walk', meters: 200, seconds: 150, toName: 'Work' }], leaveAt: NOW + 300 };
  const sent = [];
  const env = { pos: HOME, now: NOW, iv: null, sent };
  env.n = nav.createNav(Object.assign({
    send: m => sent.push(...m), locate: cb => cb(null, env.pos), clock: () => env.now,
    getList: () => ({ listId: 5, items: [trip], data: lineData }),
    getConfig: () => ({ schedule: { walkSpeed: 1.3 }, clock24: true, routingUrl: '',
                        destinations: [{ id: 'work', name: 'Work', ...geo.offset(LINE[8], 200, 0) }] }),
    getUnits: () => 'metric', getPlan: id => (id === 'work' ? tplan : null),
    setInterval: fn => { env.iv = fn; return 1; }, clearInterval: () => { env.iv = null; }
  }, over));
  return env;
}

test('trip: the ride lists its stops with their times while you are on it; its header counts the stops left', () => {
  const env = lineTrip();
  const h = { sent: env.sent };
  env.n.start(5, 0);
  let s = state(h);
  assert.deepEqual(texts(s), ['Stop 0', 'Walk to Stop 0', 'Stop 8', 'Work', 'Arrive at Work']);
  assert.equal(s.steps[2].NAV_SUB, 'East · arr ' + c24(NOW + 1800) + ' · 8 stops');
  assert.equal(s.steps[2].NAV_ROUTE, 'to Downtown', 'no full name for the route: where it goes');
  assert.equal(s.steps[2].NAV_COLOR, 0x0000ff);
  // at the stop: boarding opens the ride
  env.pos = LINE[0]; env.iv();
  s = state(h);
  assert.deepEqual(texts(s),
    ['Stop 0', 'Stop 8', 'Board 9 EB', 'Stop 1', 'Stop 2', 'Stop 3', '4 more stops', 'Get off at Stop 8', 'Work', 'Arrive at Work']);
  assert.equal(s.current.NAV_TEXT, 'Board 9 EB');
  assert.equal(s.steps[3].NAV_SUB, c24(NOW + 750), 'an eighth of the ride further');
  assert.equal(s.steps[6].NAV_KIND, KIND.fold);
  assert.deepEqual(rail(s.steps[6]), ['none', 'line', 'line']);
  assert.deepEqual(rail(s.steps[2]), ['stop', 'none', 'line'], 'under its header');
  assert.deepEqual([header(h).NAV_HEAD, header(h).NAV_HEAD_END], [1, 7]);
  // riding, a little past Stop 4: it is the stop you are at (filled), the ones behind and ahead around it
  env.now = NOW + 700; env.pos = geo.offset(LINE[4], 100, 90); env.iv();
  s = state(h);
  assert.deepEqual(texts(s),
    ['Stop 0', 'Stop 8', '2 earlier stops', 'Stop 2', 'Stop 3', 'Stop 4', 'Stop 5', 'Stop 6', 'Stop 7', 'Get off at Stop 8', 'Work', 'Arrive at Work']);
  assert.equal(s.current.NAV_TEXT, 'Stop 4');
  assert.equal(s.steps[1].NAV_SUB, 'East · arr ' + c24(NOW + 1800) + ' · 4 stops');
  assert.deepEqual(rail(s.current), ['here', 'line', 'line']);
  assert.equal(rail(s.steps[4])[0], 'stop');
  assert.match(s.live.NAV_LSUB, /^Arrive/);
  // just before Stop 5 it is still Stop 4; at it, Stop 5
  env.pos = geo.offset(LINE[5], 100, 270); env.iv();
  assert.equal(state(h).current.NAV_TEXT, 'Stop 4');
  env.pos = LINE[5]; env.iv();
  assert.equal(state(h).current.NAV_TEXT, 'Stop 5');
  // back towards Stop 4 (GPS noise): it never goes back
  env.pos = geo.offset(LINE[4], 50, 90); env.iv();
  assert.equal(state(h).current.NAV_TEXT, 'Stop 5');
});

test('unfold: a long SELECT on a leg header opens / closes it; the leg you move on to opens again', () => {
  const env = lineTrip();
  const h = { sent: env.sent };
  env.n.start(5, 0);
  assert.equal(env.n.unfold(2), true);                 // the ride's header
  let s = state(h);
  assert.deepEqual(texts(s).slice(0, 4), ['Stop 0', 'Walk to Stop 0', 'Stop 8', 'Board 9 EB']);
  assert.equal(s.steps[2].NAV_RAIL & 128, 128, 'open: a long SELECT closes it');
  assert.equal(env.n.unfold(0), true);                 // the walk you are on: closed
  s = state(h);
  assert.equal(texts(s)[1], 'Stop 8');
  assert.equal(s.live.NAV_CURRENT, 0, 'the leg you are on is closed: its header is the current row');
  assert.deepEqual([header(h).NAV_HEAD, header(h).NAV_HEAD_END], [-1, -1]);
  assert.equal(env.n.unfold(2), false, 'a step row');
  assert.equal(env.n.unfold(99), false);
  env.pos = LINE[0]; env.iv();                         // boarding: the ride is the leg you are on, open as it was
  s = state(h);
  assert.equal(s.current.NAV_TEXT, 'Board 9 EB');
});

test('preview: a scheduled trip\'s legs, closed, timed from when to leave; nothing followed until it is started', () => {
  const env = lineTrip();
  const h = { sent: env.sent };
  assert.equal(env.n.preview('work', 'Work: leave 8:05 AM', null), true);
  let s = state(h);
  assert.deepEqual(texts(s), ['Stop 0', 'Stop 8', 'Work', 'Arrive at Work']);
  assert.equal(s.steps[0].NAV_SUB, 'arr ' + c24(NOW + 300 + 308));
  assert.equal(s.live.NAV_STATE, 3);
  assert.equal(h.sent.find(m => 'NAV_STATE' in m).NAV_SHOW, 1, 'shown at once');
  assert.equal(s.live.NAV_TITLE, 'Work: leave 8:05 AM');
  assert.equal(s.live.NAV_BEARING, -1);
  assert.equal(env.iv, null, 'no position polling');
  assert.equal(env.n.guiding(), false);
  assert.equal(env.n.active(), true);
  assert.equal(env.n.unfold(1), true, 'legs open in a preview too');
  assert.equal(texts(state(h))[2], 'Board 9 EB');
  // started: followed from here, the first leg open
  assert.equal(env.n.go(), true);
  s = state(h);
  assert.equal(s.live.NAV_STATE, 1);
  assert.equal(s.live.NAV_TITLE, '');
  assert.equal(s.current.NAV_TEXT, 'Walk to Stop 0');
  assert.equal(env.n.guiding(), true);
  assert.notEqual(env.iv, null);
  assert.equal(env.n.go(), false, 'already going');
  assert.equal(env.n.preview('work', 'Work again', null), false, 'a trip is running: no preview');
});

test('preview: no plan → one row saying so', () => {
  const env = lineTrip({ getPlan: () => null });
  env.n.preview('work', 'Work', 'No route found to arrive by 8:00 AM');
  const s = state({ sent: env.sent });
  assert.deepEqual(texts(s), ['No route found to arrive by 8:00 AM']);
  assert.equal(s.live.NAV_STATE, 3);
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
  assert.deepEqual(texts(s), ['Stop 6', 'Stop 2', 'Stop 3', 'Stop 4', 'Stop 5', 'Get off here']);
  assert.equal(s.steps[0].NAV_SUB, 'East · arr ' + c24(NOW + Math.round(1600 / 6)) + ' · 4 stops', 'no times: at bus speed');
  assert.equal(s.current.NAV_TEXT, 'Stop 2');
  assert.deepEqual(s.steps.slice(1).map(r => rail(r)[0]), ['here', 'stop', 'stop', 'stop', 'stop']);
  assert.deepEqual(rail(s.steps[5]), ['stop', 'line', 'none']);
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
  h.n.fetch(7);
  const got = h.sent.slice(n);
  assert.equal(got[0].NAV_INDEX, 7);
  assert.equal(got[0].NAV_TEXT, 'Wait for the 44');
  assert.ok(got.every(m => 'NAV_INDEX' in m));
  h.n.fetch('x');
  assert.equal(h.sent.length, n + got.length);
});

test('routing source failing: the straight arrow stays', () => {
  const h = harness({ config: { routingUrl: 'https://r/{to}' }, route: (tpl, from, to, cb) => cb(new Error('Network error')) });
  h.n.start(5, 0);
  h.tick();
  assert.equal(state(h).steps[1].NAV_TEXT, 'Walk to First Ave');
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
  const steps = state({ sent }).steps;
  assert.deepEqual(steps.map(m => [m.NAV_KIND, m.NAV_TEXT]), [[KIND.head, 'Home'], [KIND.walk, 'Walk to Home'], [KIND.arrive, 'Arrive at Home']]);
  assert.equal(sent.find(m => 'NAV_STATE' in m).NAV_LDIST, '400m');
  assert.deepEqual(nav.buildSteps({ kind: 'place', title: 'X' }, {}).map(st => st.type), ['info']);
});

test('startItem: navigates to a tile given directly, replacing what was running', () => {
  const h = harness();
  assert.equal(h.n.start(5, 1), true);
  h.sent.length = 0;
  assert.equal(h.n.startItem({ kind: 'pickup', routeId: 'r1', stopId: 's1', badge: '44', title: 'First', color: '', times: [] }, data), true);
  assert.deepEqual(texts(state(h)), ['First', 'Walk to First', 'Wait for the 44']);
  assert.equal(h.n.startItem(null, data), false);
  assert.equal(h.running(), true, 'nothing to navigate to: the trip running goes on');
});
