// Scheduled trip in progress → pinned, labelled tiles at the top of the list.
process.env.TZ = 'America/Chicago';
const test = require('node:test');
const assert = require('node:assert/strict');
const geo = require('../src/common/geo');
const triggers = require('../src/common/triggers');
const tripItems = require('../src/common/trip-items');
const protocol = require('../src/common/protocol');
const settings = require('../src/common/settings');
const { createSession } = require('../src/common/session');
const { createScheduler } = require('../src/common/scheduler');

const T = Math.floor(new Date(2026, 10, 13, 8, 0, 0).getTime() / 1000);  // 08:00 local
const P = { lat: 44.97, lon: -93.26 };
const A = geo.offset(P, 150, 90), B = geo.offset(P, 2000, 0), C = geo.offset(B, 100, 90), D = geo.offset(C, 3000, 0);
const plan = {
  arriveBy: T + 3600, leaveAt: T + 600, arriveAt: T + 3300, estimated: false,
  legs: [
    { mode: 'walk', meters: 150, seconds: 120 },
    { mode: 'bus', routeId: '2', routeName: '2', color: '771473', dir: 'NB', headsign: 'Marcy-Holmes', boardStopId: 'a', boardStopName: 'Franklin & Lyndale',
      alightStopId: 'b', alightStopName: 'Hennepin & 4th', departAt: T + 720, arriveAt: T + 1800, tripKey: 'k1' },
    { mode: 'walk', meters: 100, seconds: 80 },
    { mode: 'bus', routeId: '922', routeName: 'B Line', color: 'ED1B2E', dir: 'EB', headsign: 'Union Depot', boardStopId: 'c', boardStopName: 'Lake & Hennepin',
      alightStopId: 'd', alightStopName: 'Union Depot', departAt: T + 2100, arriveAt: T + 3200, tripKey: 'k2' },
  ],
};
const dest = { id: 'work', name: 'Work', lat: D.lat, lon: D.lon, arriveBy: '09:00', days: [], enabled: true };
const data = { routes: { 2: { stops: { a: { id: 'a', ...A }, b: { id: 'b', ...B } } }, 922: { stops: { c: { id: 'c', ...C } } } } };

test('activeTrips: from leave − lead until arrival + grace, enabled destinations with a plan only', () => {
  const plans = { work: { occurrence: T + 3600, plan } };
  const at = now => triggers.activeTrips([dest], plans, now, { leadMinutes: 15 }).map(t => t.destination.id);
  assert.deepEqual(at(T + 600 - 901), []);
  assert.deepEqual(at(T + 600 - 900), ['work']);
  assert.deepEqual(at(T + 3300 + triggers.TRIP_GRACE), ['work']);
  assert.deepEqual(at(T + 3300 + triggers.TRIP_GRACE + 1), []);
  assert.deepEqual(triggers.activeTrips([{ ...dest, enabled: false }], plans, T + 700, {}), []);
  assert.deepEqual(triggers.activeTrips([dest], { work: { occurrence: T, plan: null } }, T + 700, {}), []);
  const early = { ...plan, leaveAt: T + 100 };
  const two = triggers.activeTrips([dest, { ...dest, id: 'gym', name: 'Gym' }],
    { work: { occurrence: 1, plan }, gym: { occurrence: 1, plan: early } }, T + 700, {});
  assert.deepEqual(two.map(t => t.destination.id), ['gym', 'work'], 'sorted by leave time');
});

test('build: one labelled tile per remaining bus leg; board stop before departure, alight stop while riding', () => {
  const active = triggers.activeTrips([dest], { work: { occurrence: T + 3600, plan } }, T + 300, {});
  const before = tripItems.build(active, data, P, T + 300, { clock24: false });
  assert.equal(before.length, 2);
  assert.deepEqual(before.map(i => [i.kind, i.pinned, i.badge, i.title, i.dir, i.color]), [
    ['trip', true, '2', 'Franklin & Lyndale', 'NB', '771473'], ['trip', true, 'B Line', 'Lake & Hennepin', 'EB', 'ED1B2E']]);
  assert.equal(before[0].routeLongName, 'Planned trip: Work · by 9:00 AM');
  assert.deepEqual(before[0].times, [T + 720, T + 1800, 0]);
  assert.ok(Math.abs(before[0].distance - 150) < 2);
  assert.ok(Math.abs(before[0].bearing - 90) < 1);
  assert.equal(before[1].bearing !== null, true);
  assert.equal(before[0].walk, Math.ceil(before[0].distance / 1.3), 'walking time to the boarding stop (default speed)');
  assert.equal(tripItems.build(active, data, P, T + 300, { walkSpeed: 1.5 })[0].walk, Math.ceil(before[0].distance / 1.5));

  const riding = tripItems.build(active, data, P, T + 900, {});
  assert.equal(riding[0].title, 'Hennepin & 4th');
  assert.equal(riding[0].times[2], 1, 'riding flag');
  assert.equal(riding[0].stopId, 'b');
  assert.equal(riding[0].walk, null, 'no walking time once on the bus');

  const second = tripItems.build(active, data, P, T + 1800 + tripItems.LEG_GRACE + 1, {});
  assert.deepEqual(second.map(i => i.badge), ['B Line'], 'finished legs drop off');
  assert.equal(tripItems.build(active, data, P, T + 2500, {})[0].bearing, null, 'no coordinates for the alight stop → no arrow');
  assert.equal(tripItems.build(active, data, P, T + 300, { clock24: true })[0].routeLongName, 'Planned trip: Work · by 09:00');
});

test('protocol: trip tiles are ITEM_KIND 2 with the planned-trip label in ITEM_ROUTE', () => {
  const active = triggers.activeTrips([dest], { work: { occurrence: T + 3600, plan } }, T + 300, {});
  const [, m] = protocol.encodeList(1, tripItems.build(active, data, P, T + 300, {}), '');
  assert.equal(m.ITEM_KIND, 2);
  assert.equal(m.ITEM_ROUTE, 'Planned trip: Work · by 9:00 AM');
  assert.deepEqual([m.ITEM_T0, m.ITEM_T1, m.ITEM_T2], [T + 720, T + 1800, 0]);
});

function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}

test('session: pinned tiles first, never ranked or trained on, total ≤ MAX_ITEMS', async () => {
  const storage = memoryStorage();
  storage.setItem('busWatch.config', JSON.stringify({ location: { mode: 'fixed', lat: P.lat, lon: P.lon }, maxItems: 12 }));
  const sent = [];
  const ranked = Array.from({ length: 12 }, (_, i) => ({ kind: 'pickup', key: 'p' + i, title: 'P' + i, times: [T + i], features: { ['route:r' + i]: i } }));
  const pin = [{ kind: 'trip', pinned: true, key: 'trip:work:1', title: 'Pinned', times: [T, T + 1, 0], features: {} }];
  const session = createSession({
    storage, clock: () => T, locate: () => assert.fail('fixed'), createProvider: () => ({}), send: m => sent.push(...m),
    planner: { gather: (p, c, pos, now, cache, cb) => cb(null, { routes: {} }), buildItems: () => ranked.slice() },
    pinnedItems: () => pin,
  });
  session.load();
  const items = await new Promise((res, rej) => session.refresh((e, v) => (e ? rej(e) : res(v))));
  assert.equal(items.length, 12);
  assert.equal(items[0].title, 'Pinned');
  const listId = sent.filter(m => 'ITEM_COUNT' in m).pop().LIST_ID;
  assert.equal(session.select(listId, 0), false, 'SELECT on the pinned tile is not a sample');
  assert.equal(session.getSamples().length, 0);
  assert.equal(session.select(listId, 1), true);
  const s = session.getSamples()[0];
  assert.equal(s.chosen, 0, 'index shifted past the pinned tiles');
  assert.ok(s.candidates.every(c => !c.key.startsWith('trip:')));
  const relisted = sent.filter(m => 'ITEM_INDEX' in m && m.ITEM_INDEX === 0).pop();
  assert.equal(relisted.ITEM_TITLE, 'Pinned', 'still pinned after re-ranking');
});

test('scheduler.refreshActive re-plans a trip in progress until the first bus departs', async () => {
  const storage = memoryStorage();
  let now = T + 300;
  let calls = 0;
  const config = settings.normalize({ location: { mode: 'fixed', lat: P.lat, lon: P.lon }, destinations: [dest] });
  const fakeRouter = {
    plan: (src, req, cb) => { calls++; setTimeout(() => cb(null, { ...plan, leaveAt: plan.leaveAt + calls }), 0); },
    describe: () => 'body', summary: () => 'summary',
  };
  storage.setItem('busWatch.plans', JSON.stringify({ work: { occurrence: T + 3600, plan, summary: 's', plannedAt: T } }));
  const sch = createScheduler({ storage, clock: () => now, locate: () => assert.fail('fixed'), getConfig: () => config,
    getSource: () => ({}), sendWakeups: () => {}, notify: () => {}, router: fakeRouter });
  sch.load();
  const run = () => new Promise((res, rej) => sch.refreshActive((e, v) => (e ? rej(e) : res(v))));
  assert.deepEqual(await run(), ['work']);
  assert.equal(sch.plans().work.plan.leaveAt, plan.leaveAt + 1);
  assert.equal(sch.plans().work.occurrence, T + 3600, 'same occurrence');
  assert.deepEqual(await run(), [], 'fresh enough');
  now += 120;
  assert.deepEqual(await run(), ['work']);
  now = plan.legs[1].departAt - 30;   // about to board / on the bus: keep the plan
  assert.deepEqual(await run(), []);
  assert.equal(calls, 2);
});
