// Integration: destinations → real router (on the mock source) → real triggers → scheduler → protocol messages,
// with only storage, clock and location faked. Then time is advanced to the re-check trigger.
process.env.TZ = 'America/Chicago';
const test = require('node:test');
const assert = require('node:assert/strict');
const geo = require('../src/common/geo');
const settings = require('../src/common/settings');
const protocol = require('../src/common/protocol');
const { createScheduler } = require('../src/common/scheduler');
const { createRegistry } = require('../src/sources/registry');

const CENTER = { lat: 44.97, lon: -93.26 };
const pad = n => String(n).padStart(2, '0');
const hhmm = t => { const d = new Date(t * 1000); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };

function memoryStorage() {
  const m = new Map();
  return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}

function world() {
  // 2026-11-13 07:00:00 local; a whole minute so arriveBy lands on the clock
  let now = Math.floor(new Date(2026, 10, 13, 7, 0, 0).getTime() / 1000);
  // route R1 runs north through the centre (mock: bearing 0); stop 12 is 1800 m north of the start → 1800 m - 3000 m... use its coords
  const registry = createRegistry(require('../src/sources/all'));
  const base = settings.normalize({ provider: { type: 'mock' }, location: { mode: 'gps', lat: CENTER.lat, lon: CENTER.lon },
    routes: [{ id: 'R1', name: 'One', color: '#E53935' }] });
  const probe = registry.create(base, { clock: () => now });
  return new Promise(resolve => probe.route('R1', (err, route) => {
    assert.ifError(err);
    const work = route.stops['R1:s14'];   // 2600 m north of the centre
    const arriveBy = now + 50 * 60;
    const config = settings.normalize(Object.assign({}, base, {
      destinations: [{ id: 'work', name: 'Work', lat: work.lat, lon: work.lon, arriveBy: hhmm(arriveBy), days: [] }],
      schedule: { leadMinutes: 15, leaveReminder: true },
    }));
    const out = [];
    const storage = memoryStorage();
    const source = registry.create(config, { clock: () => now });
    const scheduler = createScheduler({
      storage, clock: () => now, getConfig: () => config, getSource: () => source,
      locate: cb => setTimeout(() => cb(null, CENTER), 0),
      sendWakeups: w => out.push(...protocol.encodeWakeups(w)),
      notify: n => out.push(protocol.encodeNotify(n)),
    });
    scheduler.load();
    resolve({ scheduler, out, storage, arriveBy, config, setNow: t => { now = t; }, now: () => now });
  }));
}
const p = (fn, ...a) => new Promise((res, rej) => fn(...a, (e, v) => (e ? rej(e) : res(v))));

test('destination → plan on route R1 → wakeups → re-check notification at leave − 15 min', async () => {
  const w = await world();
  const plans = await p(w.scheduler.replan);
  const entry = plans.work;
  assert.ok(entry && entry.plan, 'planned');
  const plan = entry.plan;
  assert.equal(entry.occurrence, w.arriveBy);
  const bus = plan.legs.filter(l => l.mode === 'bus');
  assert.equal(bus.length, 1);
  assert.equal(bus[0].routeId, 'R1');
  assert.equal(bus[0].dir, 'NB');
  assert.equal(bus[0].color, 'E53935');
  assert.ok(plan.arriveAt <= w.arriveBy, 'arrives in time');
  assert.ok(plan.leaveAt > w.now(), 'leaves in the future');
  assert.ok(w.arriveBy - plan.arriveAt < 600, 'latest bus that still makes it (10-min headway)');
  assert.match(entry.summary, /One/);

  // wakeups went to the watch: check at leave − 15 min and leave-now at leaveAt
  const count = w.out.find(m => 'WAKEUP_COUNT' in m);
  assert.equal(count.WAKEUP_COUNT, 2);
  const times = w.out.filter(m => 'WAKEUP_TIME' in m).map(m => m.WAKEUP_TIME);
  assert.deepEqual(times, [plan.leaveAt - 900, plan.leaveAt]);

  // nothing is due yet
  assert.deepEqual(await p(w.scheduler.checkDue), []);

  // the re-check fires: fresh plan, notification with the route to take
  w.out.length = 0;
  w.setNow(plan.leaveAt - 900);
  const sent = await p(w.scheduler.checkDue);
  assert.equal(sent.length, 1);
  const note = w.out.find(m => 'NOTIFY_TITLE' in m);
  assert.match(note.NOTIFY_TITLE, /^Work: leave /);
  assert.match(note.NOTIFY_BODY, /One/);
  if (process.env.SHOW) console.log(note);
  assert.equal(note.NOTIFY_COLOR, 0xE53935);
  assert.ok(Buffer.byteLength(note.NOTIFY_BODY) <= protocol.NOTIFY_BODY_MAX_BYTES);
  // the check trigger is handled; only the leave reminder is left on the watch
  const again = w.out.filter(m => 'WAKEUP_TIME' in m).map(m => m.WAKEUP_TIME);
  assert.equal(again.length, 1);
  assert.deepEqual(await p(w.scheduler.checkDue), [], 'not notified twice');

  // the trip is now in progress: its bus leg is pinned with the planned-trip label
  const triggers = require('../src/common/triggers');
  const tripItems = require('../src/common/trip-items');
  const active = triggers.activeTrips(w.config.destinations, w.scheduler.plans(), w.now(), w.config.schedule);
  const pinned = tripItems.build(active, { routes: {} }, CENTER, w.now(), {});
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].kind, 'trip');
  assert.equal(pinned[0].badge, 'One');
  assert.match(pinned[0].routeLongName, /^Planned trip: Work · by /);

  // leave time: "Leave now"
  w.out.length = 0;
  w.setNow(w.scheduler.plans().work.plan.leaveAt);
  await p(w.scheduler.checkDue);
  assert.match(w.out.find(m => 'NOTIFY_TITLE' in m).NOTIFY_TITLE, /^Leave now: Work/);

  // after the arrival time the next day's occurrence is planned and scheduled
  w.setNow(w.arriveBy + 60);
  await p(w.scheduler.checkDue);
  assert.equal(w.scheduler.plans().work.occurrence, w.arriveBy + 86400);
});
