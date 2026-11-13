process.env.TZ = 'America/Chicago';
const test = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../src/common/settings');
const triggers = require('../src/common/triggers');

// local wall time -> epoch s
const local = (y, mo, d, h = 0, mi = 0) => Math.floor(new Date(y, mo - 1, d, h, mi).getTime() / 1000);
const utc = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000;

function dest(extra) {
  return settings.normalize({ destinations: [Object.assign({ id: 'work', name: 'Work', lat: 45, lon: -93, arriveBy: '08:00' }, extra || {})] })
    .destinations[0];
}
const schedule = extra => settings.normalize({ schedule: extra || {} }).schedule;

// 2026-11-13 is a Friday (weekday 5)
test('nextOccurrence: later today, else tomorrow; [] = every day', () => {
  const d = dest();
  assert.equal(triggers.nextOccurrence(d, local(2026, 11, 13, 7, 0)), local(2026, 11, 13, 8, 0));
  assert.equal(triggers.nextOccurrence(d, local(2026, 11, 13, 9, 0)), local(2026, 11, 14, 8, 0));
  assert.equal(triggers.nextOccurrence(d, local(2026, 11, 13, 7, 59)), local(2026, 11, 13, 8, 0));
});

test('nextOccurrence: arriveBy exactly now -> the next one (strictly after now)', () => {
  const d = dest();
  assert.equal(triggers.nextOccurrence(d, local(2026, 11, 13, 8, 0)), local(2026, 11, 14, 8, 0));
  assert.equal(triggers.nextOccurrence(d, local(2026, 11, 13, 8, 0) - 1), local(2026, 11, 13, 8, 0));
});

test('nextOccurrence: weekday filtering', () => {
  const weekdays = dest({ days: [1, 2, 3, 4, 5] });
  // Friday after 8 -> Monday
  assert.equal(triggers.nextOccurrence(weekdays, local(2026, 11, 13, 9, 0)), local(2026, 11, 16, 8, 0));
  // Saturday -> Monday
  assert.equal(triggers.nextOccurrence(weekdays, local(2026, 11, 14, 6, 0)), local(2026, 11, 16, 8, 0));
  // Friday before 8 -> today
  assert.equal(triggers.nextOccurrence(weekdays, local(2026, 11, 13, 6, 0)), local(2026, 11, 13, 8, 0));
  // only Friday, just after -> a week later
  const fri = dest({ days: [5] });
  assert.equal(triggers.nextOccurrence(fri, local(2026, 11, 13, 8, 0)), local(2026, 11, 20, 8, 0));
  const sun = dest({ days: [0], arriveBy: '23:59' });
  assert.equal(triggers.nextOccurrence(sun, local(2026, 11, 15, 23, 59)), local(2026, 11, 22, 23, 59));
});

test('nextOccurrence: disabled / malformed -> null', () => {
  assert.equal(triggers.nextOccurrence(dest({ enabled: false }), local(2026, 11, 13)), null);
  assert.equal(triggers.nextOccurrence(null, local(2026, 11, 13)), null);
  assert.equal(triggers.nextOccurrence({ id: 'x', arriveBy: 'nope', days: [], enabled: true }, local(2026, 11, 13)), null);
});

test('nextOccurrence: DST spring forward (2026-03-08, Chicago)', () => {
  const d = dest();
  const sat = triggers.nextOccurrence(d, local(2026, 3, 7, 7, 0));
  const sun = triggers.nextOccurrence(d, local(2026, 3, 7, 9, 0));
  assert.equal(sat, utc(2026, 3, 7, 14, 0));       // CST = UTC-6
  assert.equal(sun, utc(2026, 3, 8, 13, 0));       // CDT = UTC-5
  assert.equal(sun - sat, 23 * 3600);
  // a wall time that does not exist that day moves forward an hour
  const night = dest({ arriveBy: '02:30' });
  assert.equal(triggers.nextOccurrence(night, local(2026, 3, 7, 12, 0)), utc(2026, 3, 8, 8, 30)); // 03:30 CDT
  assert.equal(triggers.nextOccurrence(night, utc(2026, 3, 8, 8, 30)), utc(2026, 3, 9, 7, 30));  // next day 02:30 CDT
});

test('nextOccurrence: DST fall back (2026-11-01, Chicago)', () => {
  const d = dest();
  const sat = triggers.nextOccurrence(d, local(2026, 10, 31, 7, 0));
  const sun = triggers.nextOccurrence(d, local(2026, 10, 31, 9, 0));
  assert.equal(sat, utc(2026, 10, 31, 13, 0));     // CDT
  assert.equal(sun, utc(2026, 11, 1, 14, 0));      // CST
  assert.equal(sun - sat, 25 * 3600);
  // the ambiguous 01:30: first instant (CDT), then the next day
  const night = dest({ arriveBy: '01:30' });
  assert.equal(triggers.nextOccurrence(night, local(2026, 10, 31, 12, 0)), utc(2026, 11, 1, 6, 30));
  assert.equal(triggers.nextOccurrence(night, utc(2026, 11, 1, 6, 30)), utc(2026, 11, 2, 7, 30));
  // Sunday-only across the change
  const sunOnly = dest({ days: [0] });
  assert.equal(triggers.nextOccurrence(sunOnly, local(2026, 10, 30, 12, 0)), utc(2026, 11, 1, 14, 0));
});

const NOW = local(2026, 11, 13, 7, 0);
const OCC = local(2026, 11, 13, 8, 0);
const plan = leaveAt => ({ arriveBy: OCC, leaveAt, arriveAt: OCC - 120, estimated: false, legs: [] });

test('build: check (leaveAt - lead) and leave (leaveAt), sorted, ids', () => {
  const d = dest();
  const t = triggers.build([d], { work: { occurrence: OCC, plan: plan(OCC - 1800) } }, NOW, schedule());
  assert.deepEqual(t, [
    { id: 'work@' + OCC + ':check', destinationId: 'work', occurrence: OCC, kind: 'check', time: OCC - 1800 - 900 },
    { id: 'work@' + OCC + ':leave', destinationId: 'work', occurrence: OCC, kind: 'leave', time: OCC - 1800 },
  ]);
  const custom = triggers.build([d], { work: { occurrence: OCC, plan: plan(OCC - 1800) } }, NOW, schedule({ leadMinutes: 5 }));
  assert.equal(custom[0].time, OCC - 1800 - 300);
});

test('build: leaveReminder off -> only check', () => {
  const t = triggers.build([dest()], { work: { occurrence: OCC, plan: plan(OCC - 1800) } }, NOW, schedule({ leaveReminder: false }));
  assert.deepEqual(t.map(x => x.kind), ['check']);
});

test('build: plan null -> fallback check at occurrence - fallback - lead, no leave', () => {
  const t = triggers.build([dest()], { work: { occurrence: OCC, plan: null } }, NOW, schedule({ fallbackMinutes: 30 }));
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, 'check');
  assert.equal(t[0].time, OCC - 30 * 60 - 15 * 60);
});

test('build: disabled, unplanned and passed destinations are skipped; past trigger times kept', () => {
  const a = dest();
  const b = dest({ id: 'b', enabled: false });
  const c = dest({ id: 'c' });
  const e = dest({ id: 'e' });
  const plans = {
    work: { occurrence: OCC, plan: plan(NOW - 600) },        // times in the past: kept (due)
    b: { occurrence: OCC, plan: plan(OCC - 600) },
    e: { occurrence: NOW, plan: plan(NOW - 1200) },           // occurrence not > now
  };
  const t = triggers.build([a, b, c, e], plans, NOW, schedule());
  assert.deepEqual(t.map(x => x.id), ['work@' + OCC + ':check', 'work@' + OCC + ':leave']);
  assert.equal(t[0].time, NOW - 600 - 900);
  assert.deepEqual(triggers.build(null, plans, NOW, schedule()), []);
  assert.deepEqual(triggers.build([a], null, NOW, schedule()), []);
});

test('build: several destinations sorted by time', () => {
  const a = dest();
  const b = dest({ id: 'gym', arriveBy: '07:45' });
  const occB = local(2026, 11, 13, 7, 45);
  const t = triggers.build([a, b], {
    work: { occurrence: OCC, plan: plan(OCC - 1200) },
    gym: { occurrence: occB, plan: { leaveAt: occB - 1500, legs: [] } },
  }, NOW, schedule());
  assert.deepEqual(t.map(x => x.time), [occB - 2400, occB - 1500, OCC - 2100, OCC - 1200]);
});

test('due: time <= now, occurrence > now, not handled', () => {
  const t = [
    { id: 'a', occurrence: NOW + 100, time: NOW - 10, kind: 'check' },
    { id: 'b', occurrence: NOW + 100, time: NOW, kind: 'leave' },
    { id: 'c', occurrence: NOW + 100, time: NOW + 1, kind: 'check' },
    { id: 'd', occurrence: NOW, time: NOW - 100, kind: 'check' },      // occurrence passed
    { id: 'e', occurrence: NOW - 5, time: NOW - 200, kind: 'check' },  // occurrence passed
    { id: 'f', occurrence: NOW + 50, time: NOW - 300, kind: 'check' },
  ];
  assert.deepEqual(triggers.due(t, NOW, []).map(x => x.id), ['f', 'a', 'b']);
  assert.deepEqual(triggers.due(t, NOW, ['a', 'f']).map(x => x.id), ['b']);
  assert.deepEqual(triggers.due(t, NOW).map(x => x.id), ['f', 'a', 'b']);
  assert.deepEqual(triggers.due([], NOW, []), []);
});

test('toWakeups: future only, sorted, spaced >= 60 s, max 8, 1-based cookies', () => {
  const mk = (time) => ({ id: 'x' + time, time, occurrence: NOW + 99999, kind: 'check' });
  assert.deepEqual(triggers.toWakeups([mk(NOW + 500), mk(NOW - 5), mk(NOW), mk(NOW + 100)], NOW), [
    { time: NOW + 100, cookie: 1 }, { time: NOW + 500, cookie: 2 },
  ]);
  // collisions get pushed later
  assert.deepEqual(triggers.toWakeups([mk(NOW + 100), mk(NOW + 100), mk(NOW + 130), mk(NOW + 300)], NOW), [
    { time: NOW + 100, cookie: 1 }, { time: NOW + 160, cookie: 2 }, { time: NOW + 220, cookie: 3 }, { time: NOW + 300, cookie: 4 },
  ]);
  const many = [];
  for (let i = 12; i >= 1; i--) many.push(mk(NOW + i * 1000));
  const w = triggers.toWakeups(many, NOW);
  assert.equal(w.length, 8);
  assert.deepEqual(w.map(x => x.cookie), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(w.map(x => x.time), [1, 2, 3, 4, 5, 6, 7, 8].map(i => NOW + i * 1000));
  assert.deepEqual(triggers.toWakeups([], NOW), []);
  assert.deepEqual(triggers.toWakeups(null, NOW), []);
});

test('end to end: build -> due -> toWakeups', () => {
  const d = dest();
  const plans = { work: { occurrence: OCC, plan: plan(OCC - 1800) } };
  const t = triggers.build([d], plans, NOW, schedule());
  assert.deepEqual(triggers.toWakeups(t, NOW), [{ time: OCC - 2700, cookie: 1 }, { time: OCC - 1800, cookie: 2 }]);
  const at = OCC - 2700;
  assert.deepEqual(triggers.due(t, at, []).map(x => x.kind), ['check']);
  assert.deepEqual(triggers.toWakeups(t, at), [{ time: OCC - 1800, cookie: 1 }]);
});
