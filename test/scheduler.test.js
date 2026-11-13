process.env.TZ = 'America/Chicago';
const test = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../src/common/settings');
const triggers = require('../src/common/triggers');
const { createScheduler, STORAGE_KEYS } = require('../src/common/scheduler');

const local = (y, mo, d, h = 0, mi = 0) => Math.floor(new Date(y, mo - 1, d, h, mi).getTime() / 1000);
const NOW = local(2026, 11, 13, 7, 0);       // Friday 7:00
const OCC = local(2026, 11, 13, 8, 0);       // work arriveBy 8:00
const OCC_GYM = local(2026, 11, 13, 9, 0);

function memoryStorage(init) {
  const data = Object.assign({}, init || {});
  return {
    data,
    getItem: k => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: k => { delete data[k]; },
  };
}

// the scheduler gets a runtime view: normalized destinations / schedule / location, plus routes, connections,
// units and clock24 as given
function makeConfig(extra) {
  const merged = Object.assign({
    location: { mode: 'fixed', lat: 44.97, lon: -93.26 },
    routes: [{ id: '21', name: 'A Line', color: 'FF0000' }, { id: '6' }],
    connections: [{ routeId: '2', stopId: 's1' }, { routeId: '21', stopId: 's2' }],
    destinations: [
      { id: 'work', name: 'Work', lat: 44.98, lon: -93.27, arriveBy: '08:00' },
      { id: 'gym', name: 'Gym', lat: 44.99, lon: -93.28, arriveBy: '09:00' },
    ],
    schedule: { walkSpeed: 1.5, maxWalk: 600, transferWalk: 200, maxTransfers: 1, minTransfer: 90 },
  }, extra || {});
  return Object.assign(settings.normalize(merged), { routes: merged.routes.map(r => Object.assign({ name: r.id }, r)), connections: merged.connections,
    units: merged.units || 'imperial', clock24: !!merged.clock24 });
}

function busPlan(req, leaveOffset, color) {
  return {
    arriveBy: req.arriveBy, leaveAt: req.arriveBy - leaveOffset, arriveAt: req.arriveBy - 60, estimated: false,
    legs: [
      { mode: 'walk', meters: 200, seconds: 150 },
      { mode: 'bus', routeId: '21', routeName: 'A Line', color: color === undefined ? 'FF0000' : color, dir: 'EB', headsign: 'East',
        boardStopId: 'b', boardStopName: 'B St', alightStopId: 'a', alightStopName: 'A St',
        departAt: req.arriveBy - leaveOffset + 150, arriveAt: req.arriveBy - 120, tripKey: 't1' },
    ],
  };
}

// fake router: planFn(req, callIndex) -> {err} | plan | null
function fakeRouter(planFn) {
  const r = {
    calls: [],
    planFn: planFn || (req => busPlan(req, 1800)),
    plan(source, req, cb) {
      r.calls.push({ source, req });
      const out = r.planFn(req, r.calls.length - 1);
      setImmediate(() => (out && out.err ? cb(out.err) : cb(null, out)));
    },
    describe: (plan, opts) => 'Take ' + plan.legs.filter(l => l.mode === 'bus').map(l => l.routeName).join(', ') +
      (opts && opts.clock24 ? ' (24h)' : ''),
    summary: (plan, opts) => 'Leave at ' + plan.leaveAt,
  };
  return r;
}

function setup(opts = {}) {
  const env = {
    now: opts.now || NOW,
    config: opts.config || makeConfig(),
    storage: opts.storage || memoryStorage(),
    router: opts.router || fakeRouter(),
    source: { id: 'src' },
    wakeups: [],
    notes: [],
    locates: 0,
    locateResult: opts.locateResult || [null, { lat: 44.9, lon: -93.2 }],
  };
  env.scheduler = createScheduler({
    storage: env.storage,
    clock: () => env.now,
    locate: cb => { env.locates++; setImmediate(() => cb.apply(null, env.locateResult)); },
    getConfig: () => env.config,
    getSource: () => env.source,
    sendWakeups: w => env.wakeups.push(w),
    notify: n => env.notes.push(n),
    router: env.router,
    triggers: opts.triggers,
  });
  env.scheduler.load();
  env.replan = () => new Promise((res, rej) => env.scheduler.replan((e, v) => (e ? rej(e) : res(v))));
  env.checkDue = () => new Promise((res, rej) => env.scheduler.checkDue((e, v) => (e ? rej(e) : res(v))));
  return env;
}

test('replan: plans every enabled destination, stores them and sends wakeups', async () => {
  const env = setup();
  const plans = await env.replan();
  assert.deepEqual(Object.keys(plans).sort(), ['gym', 'work']);
  assert.equal(plans.work.occurrence, OCC);
  assert.equal(plans.work.plan.leaveAt, OCC - 1800);
  assert.equal(plans.work.summary, 'Leave at ' + (OCC - 1800));
  assert.equal(plans.work.plannedAt, NOW);
  assert.equal(plans.gym.occurrence, OCC_GYM);
  assert.deepEqual(JSON.parse(env.storage.data[STORAGE_KEYS.plans]), plans);
  assert.deepEqual(env.scheduler.plans(), plans);

  // request built from config
  const req = env.router.calls[0].req;
  assert.equal(env.router.calls[0].source, env.source);
  assert.deepEqual(req.origin, { lat: 44.97, lon: -93.26 });
  assert.equal(req.destination.lat, 44.98);
  assert.equal(req.destination.lon, -93.27);
  assert.equal(req.arriveBy, OCC);
  assert.equal(req.now, NOW);
  assert.deepEqual(req.routeIds, ['21', '6', '2']);
  assert.deepEqual(req.routeNames, { '21': 'A Line', '6': '6' });
  assert.deepEqual(req.routeColors, { '21': 'FF0000' });
  assert.equal(req.walkSpeed, 1.5);
  assert.equal(req.maxWalk, 600);
  assert.equal(req.transferWalk, 200);
  assert.equal(req.maxTransfers, 1);
  assert.equal(req.minTransfer, 90);
  assert.equal(typeof req.routeCache, 'object');
  assert.equal(env.router.calls[1].req.routeCache, req.routeCache, 'route cache shared between plans');

  // wakeups: work check 7:15, gym check 8:15, work leave 7:30, gym leave 8:30
  assert.equal(env.wakeups.length, 1);
  assert.deepEqual(env.wakeups[0], [
    { time: OCC - 2700, cookie: 1 }, { time: OCC - 1800, cookie: 2 },
    { time: OCC_GYM - 2700, cookie: 3 }, { time: OCC_GYM - 1800, cookie: 4 },
  ]);
  assert.equal(env.locates, 0, 'fixed location: locate not called');
});

test('replan: gps mode locates', async () => {
  const env = setup({ config: makeConfig({ location: { mode: 'gps' } }) });
  await env.replan();
  assert.equal(env.locates, 1);
  assert.deepEqual(env.router.calls[0].req.origin, { lat: 44.9, lon: -93.2 });
});

test('replan: locate failure -> plan null, "No route found", fallback trigger', async () => {
  const env = setup({ config: makeConfig({ location: { mode: 'gps' }, destinations: [
    { id: 'work', name: 'Work', lat: 44.98, lon: -93.27, arriveBy: '08:00' }] }), locateResult: [new Error('no gps')] });
  const plans = await env.replan();
  assert.equal(env.router.calls.length, 0);
  assert.equal(plans.work.plan, null);
  assert.equal(plans.work.occurrence, OCC);
  assert.equal(plans.work.summary, 'No route found');
  // fallback 60 + lead 15 before 8:00 = 6:45, already past at 7:00 -> no wakeup; it is due
  assert.deepEqual(env.wakeups[0], []);
  const t = triggers.build(env.config.destinations, plans, NOW, env.config.schedule);
  assert.deepEqual(triggers.due(t, NOW, []).map(x => x.id), ['work@' + OCC + ':check']);
});

test('replan: fallback wakeup is scheduled when ahead; router error or null -> plan null', async () => {
  const env = setup({ now: local(2026, 11, 13, 5, 0), router: fakeRouter((req, i) => (i === 0 ? { err: new Error('down') } : null)) });
  const plans = await env.replan();
  assert.equal(plans.work.plan, null);
  assert.equal(plans.gym.plan, null);
  assert.deepEqual(env.wakeups[0], [{ time: OCC - 4500, cookie: 1 }, { time: OCC_GYM - 4500, cookie: 2 }]);
});

test('replan: plans of removed or disabled destinations are dropped', async () => {
  const env = setup();
  await env.replan();
  env.config = makeConfig({ destinations: [
    { id: 'work', name: 'Work', lat: 44.98, lon: -93.27, arriveBy: '08:00', enabled: false },
    { id: 'home', name: 'Home', lat: 44.9, lon: -93.2, arriveBy: '18:00' },
  ] });
  const plans = await env.replan();
  assert.deepEqual(Object.keys(plans), ['home']);
  assert.deepEqual(Object.keys(JSON.parse(env.storage.data[STORAGE_KEYS.plans])), ['home']);
});

test('checkDue: nothing due -> no notification, reschedules', async () => {
  const env = setup();
  await env.replan();
  const notes = await env.checkDue();
  assert.deepEqual(notes, []);
  assert.equal(env.notes.length, 0);
  assert.equal(env.wakeups.length, 2);
});

test('checkDue: check notification with a fresh plan, once per trigger (persisted)', async () => {
  const env = setup({ config: makeConfig({ location: { mode: 'gps' } }) });
  await env.replan();
  env.now = OCC - 2700;                         // work check time
  env.locateResult = [null, { lat: 44.95, lon: -93.25 }];
  env.router.planFn = req => busPlan(req, 1500, 'FF0000');   // live data: leave 5 min later
  await env.checkDue();
  assert.equal(env.notes.length, 1);
  assert.deepEqual(env.notes[0], { title: 'Work: leave 7:35 AM', body: 'Take A Line', color: 'FF0000' });
  const last = env.router.calls[env.router.calls.length - 1];
  assert.deepEqual(last.req.origin, { lat: 44.95, lon: -93.25 }, 'fresh location');
  assert.equal(last.req.now, OCC - 2700);
  assert.equal(last.req.arriveBy, OCC);
  assert.equal(env.scheduler.plans().work.plan.leaveAt, OCC - 1500, 'fresh plan stored');
  assert.deepEqual(JSON.parse(env.storage.data[STORAGE_KEYS.handled]), ['work@' + OCC + ':check']);
  // leave trigger rescheduled to the new leave time
  assert.deepEqual(env.wakeups[env.wakeups.length - 1][0], { time: OCC - 1500, cookie: 1 });

  await env.checkDue();
  assert.equal(env.notes.length, 1, 'not notified twice');

  // a new scheduler on the same storage does not notify again
  const env2 = setup({ storage: env.storage, now: env.now, config: env.config });
  await env2.checkDue();
  assert.equal(env2.notes.length, 0);
});

test('checkDue: leave notification; clock24 and colors', async () => {
  const env = setup({ config: makeConfig({ clock24: true }) });
  env.router.planFn = req => busPlan(req, 1800, '');
  await env.replan();
  env.now = OCC - 1800;                           // both work check (missed) and work leave are due
  await env.checkDue();
  assert.deepEqual(env.notes, [
    { title: 'Work: leave 07:30', body: 'Take A Line (24h)', color: '' },
    { title: 'Leave now: Work', body: 'Take A Line (24h)', color: '' },
  ]);
  assert.deepEqual(env.scheduler.handled(), ['work@' + OCC + ':check', 'work@' + OCC + ':leave']);
});

test('checkDue: no plan -> "No route found to arrive by"', async () => {
  const env = setup({ router: fakeRouter(() => null) });
  await env.replan();                              // fallback check at 6:45 for work: already due
  await env.checkDue();
  assert.deepEqual(env.notes, [{ title: 'Work', body: 'No route found to arrive by 8:00 AM', color: '' }]);
});

test('checkDue: a failing fresh re-plan keeps (and notifies with) the stored plan', async () => {
  const env = setup();
  await env.replan();
  env.now = OCC - 2700;
  env.router.planFn = () => ({ err: new Error('timeout') });
  await env.checkDue();
  assert.equal(env.notes[0].title, 'Work: leave 7:30 AM');
  assert.equal(env.scheduler.plans().work.plan.leaveAt, OCC - 1800);
});

test('checkDue: passed occurrences are re-planned for the next one', async () => {
  const env = setup({ config: makeConfig({ schedule: { leaveReminder: false } }) });
  await env.replan();
  env.now = local(2026, 11, 13, 10, 0);           // both 8:00 and 9:00 have passed, nothing was handled
  const before = env.router.calls.length;
  await env.checkDue();
  assert.equal(env.notes.length, 0, 'passed occurrences are not notified');
  assert.equal(env.router.calls.length - before, 2);
  const plans = env.scheduler.plans();
  assert.equal(plans.work.occurrence, local(2026, 11, 14, 8, 0));
  assert.equal(plans.gym.occurrence, local(2026, 11, 14, 9, 0));
  assert.deepEqual(env.wakeups[env.wakeups.length - 1], [
    { time: local(2026, 11, 14, 7, 15), cookie: 1 }, { time: local(2026, 11, 14, 8, 15), cookie: 2 },
  ]);
});

test('checkDue: a newly added destination without a plan gets planned', async () => {
  const env = setup();
  await env.replan();
  env.config = makeConfig({ destinations: env.config.destinations.concat([
    { id: 'home', name: 'Home', lat: 44.9, lon: -93.2, arriveBy: '18:00' }]) });
  await env.checkDue();
  assert.equal(env.scheduler.plans().home.occurrence, local(2026, 11, 13, 18, 0));
});

test('handleWakeup runs checkDue', async () => {
  const env = setup();
  await env.replan();
  env.now = OCC - 2700;
  await new Promise(res => env.scheduler.handleWakeup(1, res));
  assert.equal(env.notes.length, 1);
});

test('concurrent replan / checkDue calls are skipped', async () => {
  const env = setup();
  const results = [];
  const p1 = env.replan();
  env.scheduler.replan((e, v) => results.push(['replan', e, v]));
  env.scheduler.checkDue((e, v) => results.push(['checkDue', e, v]));
  assert.deepEqual(results, [['replan', null, null], ['checkDue', null, null]]);
  await p1;
  assert.equal(env.router.calls.length, 2);
  const again = await env.replan();
  assert.ok(again && again.work, 'runs again once the first finished');
});

test('handled list keeps the newest 100 ids', async () => {
  const old = [];
  for (let i = 0; i < 150; i++) old.push('old' + i);
  const storage = memoryStorage({ [STORAGE_KEYS.handled]: JSON.stringify(old) });
  const env = setup({ storage });
  assert.equal(env.scheduler.handled().length, 100);
  await env.replan();
  env.now = OCC - 1800;
  await env.checkDue();
  const h = JSON.parse(storage.data[STORAGE_KEYS.handled]);
  assert.equal(h.length, 100);
  assert.deepEqual(h.slice(-2), ['work@' + OCC + ':check', 'work@' + OCC + ':leave']);
  assert.equal(h[0], 'old52');
});

test('load: bad JSON in storage -> empty state', () => {
  const storage = memoryStorage({ [STORAGE_KEYS.plans]: '{nope', [STORAGE_KEYS.handled]: '"x"' });
  const env = setup({ storage });
  assert.deepEqual(env.scheduler.plans(), {});
  assert.deepEqual(env.scheduler.handled(), []);
});

test('cb exactly once even when the router calls back twice or throws', async () => {
  let calls = 0;
  const router = fakeRouter();
  router.plan = (src, req, cb) => { calls++; if (calls === 1) throw new Error('boom'); cb(null, busPlan(req, 1800)); cb(null, null); };
  const env = setup({ router });
  let n = 0;
  await new Promise(res => env.scheduler.replan(() => { n++; setImmediate(res); }));
  await new Promise(res => setImmediate(res));
  assert.equal(n, 1);
  assert.equal(env.scheduler.plans().work.plan, null);
  assert.equal(env.scheduler.plans().gym.plan.leaveAt, OCC_GYM - 1800);
});

test('replan: with a runtime view, only routes of systems covering the origin or the destination are used', async () => {
  const cfg = makeConfig({
    routes: [{ id: 'near/21', providerId: 'near', name: 'A Line' }, { id: 'far/9', providerId: 'far' }, { id: 'any/3', providerId: 'any' }],
    connections: [{ id: 'far/9|far/s', routeId: 'far/9', stopId: 'far/s' }] });
  cfg.coverage = { near: { lat: 44.97, lon: -93.26, radius: 20000 }, far: { lat: 47.6, lon: -122.3, radius: 20000 }, any: null };
  const env = setup({ config: cfg });
  await env.replan();
  assert.deepEqual(env.router.calls[0].req.routeIds, ['near/21', 'any/3']);
});
