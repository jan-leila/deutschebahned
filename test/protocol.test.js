const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../src/common/protocol');

const bytes = s => Buffer.byteLength(s, 'utf8');

test('constants', () => {
  assert.deepEqual(protocol.KIND, { pickup: 0, dropoff: 1, trip: 2 });
  assert.equal(protocol.TITLE_MAX_BYTES, 63);
  assert.equal(protocol.ROUTE_MAX_BYTES, 63);
  assert.equal(protocol.NOTIFY_TITLE_MAX_BYTES, 31);
  assert.equal(protocol.STATUS_MAX_BYTES, 47);
  assert.equal(protocol.MAX_ITEMS, 12);
  assert.equal(protocol.BADGE_MAX_BYTES, 7);
});

test('truncateUtf8 never splits a code point', () => {
  assert.equal(protocol.truncateUtf8('hello', 10), 'hello');
  assert.equal(protocol.truncateUtf8('hello', 3), 'hel');
  assert.equal(protocol.truncateUtf8('', 3), '');
  assert.equal(protocol.truncateUtf8('aé', 2), 'a');      // é is 2 bytes
  assert.equal(protocol.truncateUtf8('aé', 3), 'aé');
  assert.equal(protocol.truncateUtf8('€€', 5), '€');      // € is 3 bytes
  assert.equal(protocol.truncateUtf8('a🚌b', 4), 'a');    // 🚌 is 4 bytes (surrogate pair)
  assert.equal(protocol.truncateUtf8('a🚌b', 5), 'a🚌');
  for (let n = 0; n < 12; n++) assert.ok(bytes(protocol.truncateUtf8('Ünïcødé 🚌 stop', n)) <= n);
});

test('encodeList: header then one message per item', () => {
  const items = [
    { kind: 'pickup', badge: '44', title: 'Pine St', color: '771473', times: [100, 200, 300] },
    { kind: 'dropoff', badge: 'B Line Express', title: 'Home', color: '', times: [0, 500, 50] },
    { kind: 'pickup', title: 'x'.repeat(80), times: [7] },
  ];
  const m = protocol.encodeList(5, items, 'Updated 12:00');
  assert.equal(m.length, 4);
  assert.deepEqual(m[0], { LIST_ID: 5, ITEM_COUNT: 3, STATUS: 'Updated 12:00' });
  assert.deepEqual(m[1], { LIST_ID: 5, ITEM_INDEX: 0, ITEM_KIND: 0, ITEM_BADGE: '44', ITEM_TITLE: 'Pine St', ITEM_COLOR: 0x771473, ITEM_T0: 100, ITEM_T1: 200, ITEM_T2: 300, ITEM_BEARING: -1, ITEM_DIST: '', ITEM_DIR: '', ITEM_LANES: 1, ITEM_ROUTE: '' });
  assert.deepEqual(m[2], { LIST_ID: 5, ITEM_INDEX: 1, ITEM_KIND: 1, ITEM_BADGE: 'B Line', ITEM_TITLE: 'Home', ITEM_COLOR: -1, ITEM_T0: 0, ITEM_T1: 500, ITEM_T2: 50, ITEM_BEARING: -1, ITEM_DIST: '', ITEM_DIR: '', ITEM_LANES: 1, ITEM_ROUTE: '' });
  assert.equal(m[3].ITEM_TITLE, 'x'.repeat(63));
  assert.equal(m[3].ITEM_T1, 0);
  assert.equal(m[3].ITEM_T2, 0);
  assert.equal(m[3].ITEM_BADGE, '', 'missing badge -> empty');
  assert.equal(m[3].ITEM_COLOR, -1, 'missing color -> -1');
});

test('encodeList: caps at MAX_ITEMS and truncates status', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ kind: 'pickup', title: 't' + i, times: [i] }));
  const m = protocol.encodeList(1, items, 's'.repeat(100));
  assert.equal(m.length, 13);
  assert.equal(m[0].ITEM_COUNT, 12);
  assert.equal(m[0].STATUS.length, 47);
  assert.deepEqual(protocol.encodeList(2, [], 'none'), [{ LIST_ID: 2, ITEM_COUNT: 0, STATUS: 'none' }]);
});

test('encodeStatus', () => {
  assert.deepEqual(protocol.encodeStatus('Loading...'), { STATUS: 'Loading...' });
  assert.equal(protocol.encodeStatus('é'.repeat(40)).STATUS, 'é'.repeat(23));
});

test('decodeWatchMessage', () => {
  assert.deepEqual(protocol.decodeWatchMessage({ SELECT_INDEX: 2, LIST_ID: 9 }), { type: 'select', listId: 9, index: 2 });
  assert.deepEqual(protocol.decodeWatchMessage({ SELECT_INDEX: 0, LIST_ID: 1 }), { type: 'select', listId: 1, index: 0 });
  assert.deepEqual(protocol.decodeWatchMessage({ REFRESH: 1 }), { type: 'refresh' });
  assert.equal(protocol.decodeWatchMessage({ SELECT_INDEX: 2 }), null);
  assert.equal(protocol.decodeWatchMessage({}), null);
  assert.equal(protocol.decodeWatchMessage(null), null);
});

// a fake Pebble.sendAppMessage whose acks we control
function fakeSend() {
  const log = [];
  const pending = [];
  const fn = (dict, ok, err) => { log.push(dict); pending.push({ dict, ok, err }); };
  return { fn, log, pending, ack: () => pending.shift().ok({}), nack: () => pending.shift().err({}) };
}

test('sender: one at a time, in order', () => {
  const f = fakeSend();
  const s = protocol.createSender(f.fn);
  s.sendAll([{ a: 1 }, { a: 2 }, { a: 3 }]);
  assert.deepEqual(f.log, [{ a: 1 }]);
  assert.equal(s.pending(), 3);
  f.ack();
  assert.deepEqual(f.log, [{ a: 1 }, { a: 2 }]);
  f.ack(); f.ack();
  assert.equal(f.log.length, 3);
  assert.equal(s.pending(), 0);
});

test('sender: a new batch replaces the queued rest of the old one', () => {
  const f = fakeSend();
  const s = protocol.createSender(f.fn);
  s.sendAll([{ ITEM_COUNT: 2, a: 1 }, { a: 2 }, { a: 3 }]);
  s.sendAll([{ ITEM_COUNT: 1, b: 1 }, { b: 2 }]);
  assert.deepEqual(f.log, [{ ITEM_COUNT: 2, a: 1 }], "in-flight message is not duplicated or interrupted");
  f.ack();
  f.ack();
  f.ack();
  assert.deepEqual(f.log, [{ ITEM_COUNT: 2, a: 1 }, { ITEM_COUNT: 1, b: 1 }, { b: 2 }]);
  assert.equal(s.pending(), 0);
});

test('sender: status-only batches are appended and never truncate a list in transmission', () => {
  const f = fakeSend();
  const s = protocol.createSender(f.fn);
  s.sendAll(protocol.encodeList(1, [{ kind: 'pickup', title: 'a', times: [1] }, { kind: 'pickup', title: 'b', times: [2] }], 'x'));
  s.sendAll([protocol.encodeStatus('Locating...')]);
  for (let i = 0; i < 4; i++) f.ack();
  assert.deepEqual(f.log.map(m => m.ITEM_TITLE || m.STATUS), ['x', 'a', 'b', 'Locating...']);
  // a newer list replaces the queued rest of older lists; queued statuses stay, in order
  s.sendAll(protocol.encodeList(2, [{ kind: 'pickup', title: 'c', times: [1] }], 'y'));
  s.sendAll([protocol.encodeStatus('s1')]);
  s.sendAll(protocol.encodeList(3, [{ kind: 'pickup', title: 'd', times: [1] }], 'z'));
  while (f.pending.length) f.ack();
  assert.deepEqual(f.log.slice(4).map(m => m.ITEM_TITLE || m.STATUS), ['y', 's1', 'z', 'd']);
});

test('sender: retries, then drops the rest of the batch', () => {
  const f = fakeSend();
  const s = protocol.createSender(f.fn, { retries: 2 });
  s.sendAll([{ a: 1 }, { a: 2 }]);
  f.nack(); f.nack();
  assert.deepEqual(f.log, [{ a: 1 }, { a: 1 }, { a: 1 }]);
  f.ack();
  assert.deepEqual(f.log.slice(-1), [{ a: 2 }]);
  f.nack(); f.nack(); f.nack();         // a:2 fails 3 times (> retries)
  assert.equal(s.pending(), 0);
  s.sendAll([{ c: 1 }]);                 // sender still usable
  assert.deepEqual(f.log.slice(-1), [{ c: 1 }]);
});

// ---- phase 3 additions ---------------------------------------------------------------------------

test('constants (phase 3)', () => {
  assert.equal(protocol.DIST_MAX_BYTES, 7);
  assert.equal(protocol.DIR_MAX_BYTES, 3);
  assert.equal(protocol.MAX_WAKEUPS, 8);
  assert.equal(protocol.NOTIFY_BODY_MAX_BYTES, 159);
});

test('encodeList: bearing, distance (units), dir, single lane', () => {
  const item = { kind: 'pickup', badge: '4', title: 'Pine', color: '00AA55', times: [1, 2, 3],
    bearing: 359.6, distance: 350, dir: 'SB', lanes: [{ stopId: 'a', dir: 'NB', times: [1, 2, 3] }] };
  const [, imp] = protocol.encodeList(1, [item], 's');
  assert.equal(imp.ITEM_BEARING, 0, 'round(359.6) = 360 -> 0');
  assert.equal(imp.ITEM_DIST, '0.2mi', 'imperial is the default');
  assert.equal(imp.ITEM_DIR, 'NB', 'lanes[0].dir wins over dir');
  assert.equal(imp.ITEM_LANES, 1);
  for (const k of ['ITEM_DIR2', 'ITEM_U0', 'ITEM_U1', 'ITEM_U2']) assert.ok(!(k in imp), k + ' only with two lanes');
  const [, met] = protocol.encodeList(1, [item], 's', { units: 'metric' });
  assert.equal(met.ITEM_DIST, '350m');
  assert.equal(protocol.encodeList(1, [item], 's', { units: 'imperial' })[1].ITEM_DIST, '0.2mi');
  assert.equal(protocol.encodeList(1, [{ ...item, bearing: 90.4 }], 's')[1].ITEM_BEARING, 90);
  assert.equal(protocol.encodeList(1, [{ ...item, bearing: 12 }], 's')[1].ITEM_BEARING, 12);
});

test('encodeList: unknown bearing -> -1, unknown distance -> "", dir falls back to item.dir', () => {
  const base = { kind: 'dropoff', title: 'Home', times: [0, 5, 3] };
  for (const bearing of [null, undefined, NaN, Infinity, '90']) {
    assert.equal(protocol.encodeList(1, [{ ...base, bearing }], 's')[1].ITEM_BEARING, -1, String(bearing));
  }
  const m = protocol.encodeList(1, [{ ...base, distance: null, dir: 'EB', lanes: [] }], 's', { units: 'metric' })[1];
  assert.equal(m.ITEM_DIST, '');
  assert.equal(m.ITEM_DIR, 'EB');
  assert.equal(m.ITEM_LANES, 1, 'drop-offs (no lanes) are one lane');
  assert.equal(protocol.encodeList(1, [{ ...base, distance: 0 }], 's', { units: 'metric' })[1].ITEM_DIST, '0m');
});

test('encodeList: byte limits for dist and dir', () => {
  const m = protocol.encodeList(1, [{ kind: 'pickup', title: 't', times: [1], distance: 123456789, dir: 'NBSB', lanes: [
    { dir: 'Northbound', times: [1] }, { dir: 'Southbound', times: [2] }] }], 's', { units: 'metric' })[1];
  assert.ok(bytes(m.ITEM_DIST) <= protocol.DIST_MAX_BYTES, m.ITEM_DIST);
  assert.equal(m.ITEM_DIR, 'Nor');
  assert.equal(m.ITEM_DIR2, 'Sou');
  for (const d of [0, 5, 99, 999, 1234, 9999, 99999, 1e7]) {
    for (const units of ['metric', 'imperial']) {
      assert.ok(bytes(protocol.encodeList(1, [{ title: 't', distance: d }], 's', { units })[1].ITEM_DIST) <= 7);
    }
  }
});

test('encodeList: two lanes carry the second lane dir and times', () => {
  const item = { kind: 'pickup', title: 'Franklin', times: [10, 20, 30], dir: 'NB', bearing: 45, distance: 30,
    lanes: [{ stopId: 'n', dir: 'NB', times: [10, 20, 30] }, { stopId: 's', dir: 'SB', times: [15] }] };
  const m = protocol.encodeList(3, [item], 's', { units: 'metric' })[1];
  assert.deepEqual(m, { LIST_ID: 3, ITEM_INDEX: 0, ITEM_KIND: 0, ITEM_BADGE: '', ITEM_TITLE: 'Franklin', ITEM_COLOR: -1,
    ITEM_T0: 10, ITEM_T1: 20, ITEM_T2: 30, ITEM_BEARING: 45, ITEM_DIST: '30m', ITEM_DIR: 'NB', ITEM_LANES: 2, ITEM_ROUTE: '',
    ITEM_DIR2: 'SB', ITEM_U0: 15, ITEM_U1: 0, ITEM_U2: 0 });
  const three = { ...item, lanes: [...item.lanes, { dir: 'EB', times: [1] }] };
  assert.equal(protocol.encodeList(3, [three], 's')[1].ITEM_LANES, 2, '>= 2 lanes -> 2');
  const noDir2 = { ...item, lanes: [item.lanes[0], { times: [7, 8] }] };
  const m2 = protocol.encodeList(3, [noDir2], 's')[1];
  assert.equal(m2.ITEM_DIR2, '');
  assert.deepEqual([m2.ITEM_U0, m2.ITEM_U1, m2.ITEM_U2], [7, 8, 0]);
});

test('encodeWakeups: count header then one message per wakeup, at most 8; [] cancels all', () => {
  assert.deepEqual(protocol.encodeWakeups([]), [{ WAKEUP_COUNT: 0 }]);
  assert.deepEqual(protocol.encodeWakeups(undefined), [{ WAKEUP_COUNT: 0 }]);
  assert.deepEqual(protocol.encodeWakeups([{ time: 1000, cookie: 1 }, { time: 2000, cookie: 2 }]), [
    { WAKEUP_COUNT: 2 },
    { WAKEUP_INDEX: 0, WAKEUP_TIME: 1000, WAKEUP_COOKIE: 1 },
    { WAKEUP_INDEX: 1, WAKEUP_TIME: 2000, WAKEUP_COOKIE: 2 },
  ]);
  const many = Array.from({ length: 11 }, (_, i) => ({ time: 100 * (i + 1), cookie: i + 1 }));
  const m = protocol.encodeWakeups(many);
  assert.equal(m.length, 9);
  assert.deepEqual(m[0], { WAKEUP_COUNT: 8 });
  assert.deepEqual(m[8], { WAKEUP_INDEX: 7, WAKEUP_TIME: 800, WAKEUP_COOKIE: 8 });
  assert.ok(!m.some(x => 'ITEM_COUNT' in x), 'not a list batch');
});

test('encodeNotify: truncation and color', () => {
  assert.deepEqual(protocol.encodeNotify({ title: 'Work: leave 8:12 AM', body: 'Walk 3 min', color: 'E53935' }),
    { NOTIFY_TITLE: 'Work: leave 8:12 AM', NOTIFY_BODY: 'Walk 3 min', NOTIFY_COLOR: 0xE53935 });
  const long = protocol.encodeNotify({ title: 'é'.repeat(40), body: '🚌'.repeat(60), color: '' });
  assert.equal(long.NOTIFY_TITLE, 'é'.repeat(15));
  assert.ok(bytes(long.NOTIFY_TITLE) <= 31);
  assert.equal(long.NOTIFY_BODY, '🚌'.repeat(39), '39 x 4 bytes = 156 <= 159');
  assert.equal(long.NOTIFY_COLOR, -1);
  assert.deepEqual(protocol.encodeNotify({}), { NOTIFY_TITLE: '', NOTIFY_BODY: '', NOTIFY_COLOR: -1 });
  assert.equal(protocol.encodeNotify({ title: 't', body: 'x'.repeat(500), color: 'zz' }).NOTIFY_BODY.length, 159);
});

test('decodeWatchMessage: WAKEUP_FIRED', () => {
  assert.deepEqual(protocol.decodeWatchMessage({ WAKEUP_FIRED: 3 }), { type: 'wakeup', cookie: 3 });
  assert.deepEqual(protocol.decodeWatchMessage({ WAKEUP_FIRED: 0 }), { type: 'wakeup', cookie: 0 });
  assert.deepEqual(protocol.decodeWatchMessage({ WAKEUP_FIRED: '5' }), { type: 'wakeup', cookie: 5 });
  assert.equal(protocol.decodeWatchMessage({ WAKEUP_FIRED: null }), null);
});

test('sender: a list batch drops only queued messages of earlier lists; wakeups/notify/status survive in order', () => {
  const f = fakeSend();
  const s = protocol.createSender(f.fn);
  const list = (id, titles) => protocol.encodeList(id, titles.map(t => ({ kind: 'pickup', title: t, times: [1] })), 'L' + id);
  s.sendAll(list(1, ['a', 'b']));                                   // header L1 in flight; a, b queued
  s.sendAll(protocol.encodeWakeups([{ time: 10, cookie: 1 }]));       // W0, W1
  s.sendAll([protocol.encodeStatus('st')]);
  s.sendAll([protocol.encodeNotify({ title: 'N', body: 'b' })]);
  s.sendAll(list(2, ['c']));                                        // drops a, b; keeps the rest
  assert.equal(s.pending(), 1 + 2 + 1 + 1 + 2);
  while (f.pending.length) f.ack();
  const tag = m => m.ITEM_TITLE || m.STATUS || m.NOTIFY_TITLE || ('WAKEUP_COUNT' in m ? 'Wc' : 'Wi');
  assert.deepEqual(f.log.map(tag), ['L1', 'Wc', 'Wi', 'st', 'N', 'L2', 'c']);
  assert.equal(s.pending(), 0);
});

test('sender: a newer list does not drop a queued newer list', () => {
  const f = fakeSend();
  const s = protocol.createSender(f.fn);
  s.sendAll([{ x: 0 }]);                                  // in flight
  s.sendAll([{ ITEM_COUNT: 1, l: 1 }, { l: 1.1 }]);
  s.sendAll([{ n: 1 }]);
  s.sendAll([{ ITEM_COUNT: 1, l: 2 }, { l: 2.1 }]);
  while (f.pending.length) f.ack();
  assert.deepEqual(f.log, [{ x: 0 }, { n: 1 }, { ITEM_COUNT: 1, l: 2 }, { l: 2.1 }]);
});

test('sender: a failing message drops only the rest of its own batch', () => {
  const f = fakeSend();
  const s = protocol.createSender(f.fn, { retries: 0 });
  s.sendAll(protocol.encodeWakeups([{ time: 1, cookie: 1 }, { time: 2, cookie: 2 }]));
  s.sendAll([protocol.encodeStatus('after')]);
  f.nack();                                               // WAKEUP_COUNT fails, no retries
  assert.deepEqual(f.log.slice(-1), [{ STATUS: 'after' }], 'the wakeup batch is dropped, the status batch is not');
  f.ack();
  assert.equal(s.pending(), 0);
});

test('sender: a superseded in-flight list message is not retried', () => {
  const f = fakeSend();
  const s = protocol.createSender(f.fn, { retries: 2 });
  s.sendAll([{ ITEM_COUNT: 1, l: 1 }, { l: 1.1 }]);
  s.sendAll([{ ITEM_COUNT: 1, l: 2 }]);
  f.nack();
  assert.deepEqual(f.log, [{ ITEM_COUNT: 1, l: 1 }, { ITEM_COUNT: 1, l: 2 }]);
  f.ack();
  assert.equal(s.pending(), 0);
});

test('encodeList: ITEM_ROUTE carries the route full name, long titles kept up to 63 bytes', () => {
  const long = 'Franklin Ave W & Lyndale Ave S (far side, near the Wedge Co-op)';
  const [, m] = protocol.encodeList(1, [{ kind: 'pickup', title: long, routeLongName: 'Franklin Av - Riverside Av - U of M - 8th St SE' }], '');
  assert.equal(m.ITEM_ROUTE, 'Franklin Av - Riverside Av - U of M - 8th St SE');
  assert.equal(m.ITEM_TITLE, protocol.truncateUtf8(long, 63));
  assert.ok(Buffer.byteLength(m.ITEM_TITLE) <= 63 && m.ITEM_TITLE.length > 31);
  const n = protocol.encodeNotify({ title: 'x'.repeat(50), body: 'b' });
  assert.equal(Buffer.byteLength(n.NOTIFY_TITLE), 31);
});

test('encodeList: ITEM_WALK carries the walking time; showWalk / showArrow false leave out the time / the arrow', () => {
  const base = { kind: 'pickup', key: 'p', badge: '2', title: 'Pine', times: [100], distance: 350, bearing: 10, lanes: [] };
  const [, walk] = protocol.encodeList(1, [Object.assign({ walk: 249.6 }, base)], 's', { units: 'metric' });
  assert.equal(walk.ITEM_WALK, 250);
  assert.equal(walk.ITEM_DIST, '350m', 'the distance stays under the arrow');
  assert.equal(walk.ITEM_BEARING, 10);
  for (const w of [null, undefined, NaN, -5]) {
    const [, m] = protocol.encodeList(1, [Object.assign({ walk: w }, base)], 's');
    assert.equal('ITEM_WALK' in m, false, String(w));
  }
  const [, off] = protocol.encodeList(1, [Object.assign({ walk: 250 }, base)], 's', { showWalk: false, showArrow: false });
  assert.equal('ITEM_WALK' in off, false);
  assert.equal(off.ITEM_BEARING, -1, 'no arrow');
  assert.equal(off.ITEM_DIST, '0.2mi', 'the distance is still shown');
});
