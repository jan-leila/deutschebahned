// 511 SF Bay plug-in (src/sources/bay511): URLs, mapping, errors, the request budget and caching, catalog.
// Fixtures test/fixtures/bay511-*.json are hand-built from the shapes in the 511 SF Bay Open Data Specification (Transit).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createBay511, parseIso, parseOptions, plugin, DEFAULT_BASE_URL } = require('../src/sources/bay511/index');

const NOW = Date.UTC(2026, 10, 13, 21, 0, 0) / 1000;  // 2026-11-13 13:00 PST
const pst = (h, m, s) => Date.UTC(2026, 10, 13, h + 8, m, s || 0) / 1000;
const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const call = (fn, ...args) => new Promise((resolve, reject) => fn(...args, (err, v) => (err ? reject(err) : resolve(v))));

// routes: {'part1|part2': fixtureName | Error | object | string}; the first key whose parts all occur in the URL answers
function fakeHttp(routes) {
  const urls = [];
  const http = (url, cb) => {
    urls.push(url);
    const key = Object.keys(routes).find(k => k.split('|').every(p => url.includes(p)));
    setTimeout(() => {
      if (!key) return cb(new Error('no fixture for ' + url));
      const v = routes[key];
      if (v instanceof Error) return cb(v);
      if (typeof v === 'string' && v.endsWith('.json')) return cb(null, fixture(v));
      cb(null, typeof v === 'string' ? v : JSON.parse(JSON.stringify(v)));
    }, 0);
  };
  return { http, urls };
}

function memStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), map: m };
}

const SF = {
  'lines?|operator_id=SF': 'bay511-lines-SF.json',
  'stops?|operator_id=SF': 'bay511-stops-SF.json',
  'patterns?|operator_id=SF|line_id=14': 'bay511-patterns-SF-14.json',
  'StopMonitoring?|stopCode=15565': 'bay511-sm-SF-15565.json',
  'StopMonitoring?|stopCode=15563': 'bay511-sm-SF-15563.json',
  'VehicleMonitoring?|agency=SF': 'bay511-vm-SF.json'
};

function make(routes, extra) {
  const fake = fakeHttp(routes || SF);
  const t = { now: NOW };
  const storage = (extra && extra.storage) || memStorage();
  const p = createBay511(Object.assign({ baseUrl: '', apiKey: 'K&1', routeIds: ['SF:14'] }, extra && extra.opts), fake.http,
    { clock: () => t.now, storage });
  return { p, urls: fake.urls, t, storage };
}

// ---------------------------------------------------------------- helpers

test('bay511: parseIso handles offsets, Z, fractions; bad input → 0', () => {
  assert.equal(parseIso('2026-11-13T13:00:00-08:00'), NOW);
  assert.equal(parseIso('2026-11-13T21:00:00Z'), NOW);
  assert.equal(parseIso('2026-11-13T21:00:00.250Z'), NOW);
  assert.equal(parseIso('2026-11-13T22:30:00+0130'), NOW);
  assert.equal(parseIso(''), 0);
  assert.equal(parseIso(null), 0);
  assert.equal(parseIso('soon'), 0);
});

test('bay511: the Base URL field names the server and / or the operators', () => {
  assert.deepEqual(parseOptions(''), { baseUrl: DEFAULT_BASE_URL, operators: ['SF'] });
  assert.deepEqual(parseOptions('sf, BA ac'), { baseUrl: DEFAULT_BASE_URL, operators: ['SF', 'BA', 'AC'] });
  assert.deepEqual(parseOptions('https://proxy.example/511/?operators=SF,BA'), { baseUrl: 'https://proxy.example/511', operators: ['SF', 'BA'] });
  assert.deepEqual(parseOptions('http://api.511.org/transit?agency=AC'), { baseUrl: 'http://api.511.org/transit', operators: ['AC'] });
  assert.deepEqual(parseOptions('https://x.example/transit#CT'), { baseUrl: 'https://x.example/transit', operators: ['CT'] });
  assert.deepEqual(parseOptions('https://x.example/transit/'), { baseUrl: 'https://x.example/transit', operators: ['SF'] });
});

test('bay511: plug-in metadata and create() through ctx', async () => {
  assert.equal(plugin.type, 'bay511');
  assert.equal(plugin.label, '511 Bay Area');
  assert.equal(plugin.needsKey, true);
  assert.match(plugin.keyUrl, /^https:\/\/511\.org\//);
  const fake = fakeHttp(SF);
  const p = plugin.create({ baseUrl: '', apiKey: 'K' }, { http: fake.http, clock: () => NOW, storage: memStorage(), routeIds: ['SF:14'], routes: [], center: null });
  const stops = await call(p.stopsNear, { lat: 37.7617, lon: -122.4192 }, 100);
  assert.deepEqual(stops.map(s => s.id), ['SF:15565', 'SF:15554']);
});

// ---------------------------------------------------------------- missing key

test('bay511: no API key → a clear error from every method, no requests', async () => {
  const fake = fakeHttp(SF);
  const p = createBay511({ baseUrl: '', apiKey: '  ', routeIds: ['SF:14'] }, fake.http, { clock: () => NOW });
  for (const [fn, args] of [[p.stopsNear, [{ lat: 37.76, lon: -122.42 }, 300]], [p.arrivals, ['SF:15565', 0, 60]],
    [p.route, ['SF:14']], [p.vehicles, ['SF:14']], [p.listRoutes, []], [p.routeInfo, ['SF:14']],
    [p.stopInfo, ['SF:15565']], [p.catalog, []]]) {
    await assert.rejects(call(fn, ...args), /needs an API key.*511\.org/);
  }
  assert.equal(fake.urls.length, 0);
});

// ---------------------------------------------------------------- route

test('bay511: route URLs and mapping (patterns + operator stops + lines)', async () => {
  const { p, urls } = make();
  const r = await call(p.route, 'SF:14');
  assert.deepEqual(urls.slice().sort(), [
    'https://api.511.org/transit/lines?api_key=K%261&operator_id=SF&format=json',
    'https://api.511.org/transit/patterns?api_key=K%261&operator_id=SF&line_id=14&format=json',
    'https://api.511.org/transit/stops?api_key=K%261&operator_id=SF&format=json']);
  assert.equal(r.id, 'SF:14');
  assert.equal(r.shortName, '14');
  assert.equal(r.longName, 'MISSION');
  assert.equal(r.color, '');
  assert.equal(r.directions.length, 2);
  const [ib, ob] = r.directions;
  // the main inbound pattern (most trips); stop points and timing points merged by Order
  assert.deepEqual({ id: ib.id, name: ib.name }, { id: 'IB', name: 'Ferry Plaza' });
  assert.deepEqual(ib.stopIds, ['SF:15571', 'SF:15567', 'SF:15565', 'SF:15563']);
  // shapes of the inbound patterns that have one: the two links joined
  assert.deepEqual(ib.paths, [[{ lat: 37.75236, lon: -122.41827 }, { lat: 37.7588, lon: -122.41891 },
    { lat: 37.76172, lon: -122.41918 }, { lat: 37.76504, lon: -122.41963 }]]);
  // no headsign → the direction name; no shape → the stops in order; a stop and timing point at one Order counted once
  assert.deepEqual({ id: ob.id, name: ob.name }, { id: 'OB', name: 'Outbound' });
  assert.deepEqual(ob.stopIds, ['SF:15552', 'SF:15554', 'SF:15556', 'SF:15558']);
  assert.deepEqual(ob.paths, [[{ lat: 37.76489, lon: -122.41977 }, { lat: 37.76151, lon: -122.41946 },
    { lat: 37.7586, lon: -122.4192 }, { lat: 37.75213, lon: -122.41858 }]]);
  assert.deepEqual(r.stops['SF:15565'], { id: 'SF:15565', name: 'Mission St & 18th St', lat: 37.76172, lon: -122.41918 });
  assert.equal(Object.keys(r.stops).length, 8);
});

test('bay511: routes and operator data are cached in storage (no requests from a new provider)', async () => {
  const storage = memStorage();
  const a = make(SF, { storage });
  await call(a.p.route, 'SF:14');
  assert.ok([...storage.map.keys()].every(k => k.startsWith('busWatch.511.')));
  const b = make(SF, { storage });
  const r = await call(b.p.route, 'SF:14');
  await call(b.p.stopInfo, 'SF:13008');
  await call(b.p.listRoutes);
  assert.equal(r.directions.length, 2);
  assert.equal(b.urls.length, 0);
  // older than 7 days → fetched again
  const c = make(SF, { storage });
  c.t.now = NOW + 7 * 86400;
  await call(c.p.route, 'SF:14');
  assert.equal(c.urls.length, 3);
});

test('bay511: two routes of one operator share one stops / lines request; concurrent calls share a build', async () => {
  const routes = Object.assign({}, SF, { 'patterns?|line_id=49': { directions: [{ DirectionId: 'IB', Name: 'Inbound' }], journeyPatterns: [
    { LineRef: '49', DirectionRef: 'IB', PointsInSequence: { StopPointInJourneyPattern: { Order: '1', ScheduledStopPointRef: '15565', Name: 'x' } } }] } });
  const { p, urls } = make(routes);
  const [r14, r14b, r49] = await Promise.all([call(p.route, 'SF:14'), call(p.route, 'SF:14'), call(p.route, 'SF:49')]);
  assert.equal(r14, r14b);
  assert.deepEqual(r49.directions[0].stopIds, ['SF:15565']);
  assert.equal(r49.shortName, '49');
  assert.equal(urls.filter(u => u.includes('/stops?')).length, 1);
  assert.equal(urls.filter(u => u.includes('/lines?')).length, 1);
  assert.equal(urls.filter(u => u.includes('/patterns?')).length, 2);
});

test('bay511: a stop without coordinates is left out and the route is not cached', async () => {
  const pat = fixture('bay511-patterns-SF-14.json');
  pat.journeyPatterns[2].PointsInSequence.StopPointInJourneyPattern.push({ Order: '5', ScheduledStopPointRef: '17777', Name: 'No Position' });
  const storage = memStorage();
  const { p } = make(Object.assign({}, SF, { 'patterns?|operator_id=SF|line_id=14': pat }), { storage });
  const r = await call(p.route, 'SF:14');
  assert.deepEqual(r.directions[1].stopIds, ['SF:15552', 'SF:15554', 'SF:15556', 'SF:15558']);
  assert.equal(storage.getItem('busWatch.511.route.SF:14'), null);
});

test('bay511: BART line colors from the line name; line wrapper {content: [...]}', async () => {
  const routes = { 'lines?|operator_id=BA': 'bay511-lines-BA.json', 'stops?|operator_id=BA': { Contents: { dataObjects: { ScheduledStopPoint: [
    { id: '901401', Name: '16th St / Mission', Location: { Latitude: '37.765062', Longitude: '-122.419694' } }] } } },
    'patterns?|operator_id=BA': { directions: [], journeyPatterns: [{ DirectionRef: 'S', DestinationDisplayView: { FrontText: 'SF Airport' },
      PointsInSequence: { TimingPointInJourneyPattern: [{ Order: '1', ScheduledStopPointRef: { ref: '901401' } }] } }] } };
  const { p } = make(routes, { opts: { baseUrl: 'BA' } });
  const r = await call(p.route, 'BA:Yellow-S');
  assert.equal(r.color, 'FFFF33');
  assert.equal(r.longName, 'Antioch to SFIA/Millbrae');
  assert.deepEqual(r.directions[0], { id: 'S', name: 'SF Airport', stopIds: ['BA:901401'], paths: [[{ lat: 37.765062, lon: -122.419694 }]] });
});

test('bay511: unknown route / failing patterns → error; ids without operator use the first operator', async () => {
  const { p, urls } = make(Object.assign({}, SF, { 'patterns?|line_id=99': new Error('HTTP 404') }));
  await assert.rejects(call(p.route, 'SF:99'), /HTTP 404/);
  await call(p.route, '14');
  assert.ok(urls.some(u => u.includes('line_id=14')));
});

// ---------------------------------------------------------------- stopsNear

test('bay511: stopsNear = stops of the configured routes within the radius, nearest first', async () => {
  const { p } = make();
  const stops = await call(p.stopsNear, { lat: 37.7617, lon: -122.4192 }, 400);
  assert.deepEqual(stops.map(s => s.id), ['SF:15565', 'SF:15554', 'SF:15567', 'SF:15556', 'SF:15552', 'SF:15563']);
  assert.deepEqual(stops[0], { id: 'SF:15565', name: 'Mission St & 18th St', lat: 37.76172, lon: -122.41918, routeIds: ['SF:14'] });
  const none = make(SF, { opts: { routeIds: [] } });
  assert.deepEqual(await call(none.p.stopsNear, { lat: 37.76, lon: -122.42 }, 400), []);
  assert.equal(none.urls.length, 0);
});

// ---------------------------------------------------------------- arrivals

test('bay511: arrivals URL and mapping: predicted vs aimed, headsign, window, sorted', async () => {
  const { p, urls } = make();
  const arr = await call(p.arrivals, 'SF:15565', 0, 60);
  assert.deepEqual(urls, ['https://api.511.org/transit/StopMonitoring?api_key=K%261&agency=SF&stopCode=15565&format=json']);
  assert.deepEqual(arr, [
    { stopId: 'SF:15565', routeId: 'SF:49', tripKey: 'SF:11471001_M13@2026-11-13', time: pst(13, 2), predicted: false, headsign: 'North Point + Van Ness' },
    { stopId: 'SF:15565', routeId: 'SF:14', tripKey: 'SF:11466178_M13@2026-11-13', time: pst(13, 4, 30), predicted: true, headsign: 'Ferry Plaza' }]);
});

test('bay511: one run has the same tripKey at every stop and in vehicles', async () => {
  const { p } = make();
  const [a, b, v] = await Promise.all([call(p.arrivals, 'SF:15565', 0, 60), call(p.arrivals, 'SF:15563', 0, 60), call(p.vehicles, 'SF:14')]);
  const run = a.find(x => x.routeId === 'SF:14').tripKey;
  assert.equal(b[0].tripKey, run);
  assert.equal(b[0].time, pst(13, 6));
  assert.equal(v[0].tripKey, run);
});

test('bay511: predictions younger than 55 s are reused; the same stop twice in one refresh is one request', async () => {
  const { p, urls, t } = make();
  await Promise.all([call(p.arrivals, 'SF:15565', 0, 60), call(p.arrivals, 'SF:15565', 5, 30)]);
  assert.equal(urls.length, 1);
  t.now = NOW + 50;
  await call(p.arrivals, 'SF:15565', 0, 60);
  assert.equal(urls.length, 1);
  t.now = NOW + 60;
  const again = await call(p.arrivals, 'SF:15565', 0, 60);
  assert.equal(urls.length, 2);
  assert.equal(again.length, 2);
});

test('bay511: the request budget: at most 10 at once, then ~55 per hour; the stalest stops go first', async () => {
  const stopIds = Array.from({ length: 14 }, (_, i) => String(20000 + i));
  const routes = { 'StopMonitoring?': 'bay511-sm-SF-15565.json' };
  const { p, urls, t } = make(routes);
  const first = await Promise.allSettled(stopIds.map(id => call(p.arrivals, 'SF:' + id, 0, 60)));
  assert.equal(urls.length, 10);
  assert.equal(first.filter(r => r.status === 'rejected').length, 4);
  assert.match(first[13].reason.message, /511\.org request limit/);
  // 2 minutes later: ~1.8 tokens refilled → the two never-fetched stops get them
  t.now = NOW + 120;
  const second = await Promise.allSettled(stopIds.map(id => call(p.arrivals, 'SF:' + id, 0, 60)));
  assert.equal(urls.length, 11);
  assert.ok(urls[10].includes('stopCode=200'));
  // stops fetched before are answered from their (stale) predictions, not with an error
  assert.equal(second.filter(r => r.status === 'rejected').length, 3);
  assert.equal(second[0].status, 'fulfilled');
  // over an hour: never more than ~55 + 10 requests
  for (let k = 1; k <= 60; k++) {
    t.now = NOW + 120 + k * 60;
    await Promise.allSettled(stopIds.map(id => call(p.arrivals, 'SF:' + id, 0, 60)));
  }
  assert.ok(urls.length <= 10 + 56 + 2, String(urls.length));
  assert.ok(urls.length >= 60, String(urls.length));
});

test('bay511: the budget is kept in storage per key (a new provider does not get a fresh one)', async () => {
  const storage = memStorage();
  const routes = { 'StopMonitoring?': 'bay511-sm-SF-15565.json' };
  const a = make(routes, { storage });
  await Promise.allSettled(Array.from({ length: 10 }, (_, i) => call(a.p.arrivals, 'SF:' + (30000 + i), 0, 60)));
  assert.equal(a.urls.length, 10);
  const b = make(routes, { storage });
  await assert.rejects(call(b.p.arrivals, 'SF:15565', 0, 60), /request limit/);
  assert.equal(b.urls.length, 0);
  const other = make(routes, { storage, opts: { apiKey: 'OTHER' } });
  await call(other.p.arrivals, 'SF:15565', 0, 60);
  assert.equal(other.urls.length, 1);
});

test('bay511: rail / ferry operators: several stops in one refresh = one StopMonitoring for the operator', async () => {
  const { p, urls } = make({ 'StopMonitoring?|agency=BA': 'bay511-sm-BA.json' }, { opts: { baseUrl: 'BA' } });
  const [a, b, c] = await Promise.all([call(p.arrivals, 'BA:901401', 0, 60), call(p.arrivals, 'BA:901402', 0, 60), call(p.arrivals, 'BA:901999', 0, 60)]);
  assert.deepEqual(urls, ['https://api.511.org/transit/StopMonitoring?api_key=K%261&agency=BA&format=json']);
  assert.deepEqual(a, [{ stopId: 'BA:901401', routeId: 'BA:Yellow-S', tripKey: 'BA:1561446WKDY@2026-11-13', time: pst(13, 6), predicted: true, headsign: 'SF Airport' }]);
  assert.equal(b[0].tripKey, a[0].tripKey);
  assert.deepEqual(c, []);
  // a single stop later on is answered from that response while it is fresh
  assert.equal((await call(p.arrivals, 'BA:901202', 0, 60))[0].routeId, 'BA:Red-N');
  assert.equal(urls.length, 1);
});

test('bay511: errors: SIRI ErrorCondition, http errors, bad bodies; a 429 drains the budget', async () => {
  const { p, urls } = make({ 'agency=XX': 'bay511-sm-error.json', 'stopCode=1|agency=SF': new Error('HTTP 429'),
    'stopCode=2|agency=SF': { Message: 'The API key provided is invalid.' }, 'stopCode=3': [] }, { opts: { baseUrl: 'SF XX' } });
  await assert.rejects(call(p.arrivals, 'XX:5', 0, 60), /Agency XX is not a valid agency/);
  await assert.rejects(call(p.arrivals, 'SF:2', 0, 60), /API key provided is invalid/);
  await assert.rejects(call(p.arrivals, 'SF:3', 0, 60), /unexpected response/);
  await assert.rejects(call(p.arrivals, 'SF:1', 0, 60), /HTTP 429/);
  const n = urls.length;
  await assert.rejects(call(p.arrivals, 'SF:4', 0, 60), /request limit/);
  assert.equal(urls.length, n);
});

test('bay511: a text body (with a UTF-8 BOM) is parsed', async () => {
  const text = '﻿' + fs.readFileSync(path.join(__dirname, 'fixtures', 'bay511-sm-SF-15563.json'), 'utf8');
  const { p } = make({ 'StopMonitoring?': text });
  const arr = await call(p.arrivals, 'SF:15563', 0, 60);
  assert.equal(arr[0].time, pst(13, 6));
  const bad = make({ 'StopMonitoring?': '﻿<html>' });
  await assert.rejects(call(bad.p.arrivals, 'SF:15563', 0, 60), /bad JSON/);
});

test('bay511: a failed refresh falls back to the last predictions', async () => {
  let fail = false;
  const routes = { 'StopMonitoring?': 'bay511-sm-SF-15565.json' };
  const fake = fakeHttp(routes);
  const t = { now: NOW };
  const p = createBay511({ apiKey: 'K' }, (url, cb) => (fail ? setTimeout(() => cb(new Error('Network error')), 0) : fake.http(url, cb)), { clock: () => t.now });
  await call(p.arrivals, 'SF:15565', 0, 60);
  fail = true;
  t.now = NOW + 150;
  const arr = await call(p.arrivals, 'SF:15565', 0, 60);
  assert.deepEqual(arr.map(a => a.routeId), ['SF:14']);  // the 13:02 bus has gone by
  t.now = NOW + 1900;
  await assert.rejects(call(p.arrivals, 'SF:15565', 0, 60), /Network error/);
});

// ---------------------------------------------------------------- vehicles

test('bay511: vehicles: one VehicleMonitoring per operator, filtered by line, at most every 2 minutes', async () => {
  const { p, urls, t } = make();
  const [v14, v49] = await Promise.all([call(p.vehicles, 'SF:14'), call(p.vehicles, 'SF:49')]);
  assert.deepEqual(urls, ['https://api.511.org/transit/VehicleMonitoring?api_key=K%261&agency=SF&format=json']);
  assert.deepEqual(v14, [{ tripKey: 'SF:11466178_M13@2026-11-13', routeId: 'SF:14', directionId: 'IB', lat: 37.7563, lon: -122.41879, time: pst(12, 59, 40) }]);
  assert.equal(v49.length, 1);
  t.now = NOW + 100;
  await call(p.vehicles, 'SF:14');
  assert.equal(urls.length, 1);
  t.now = NOW + 130;
  await call(p.vehicles, 'SF:14');
  assert.equal(urls.length, 2);
});

test('bay511: vehicles yield to arrivals when the budget is low', async () => {
  const { p, urls } = make({ 'StopMonitoring?': 'bay511-sm-SF-15565.json', 'VehicleMonitoring?': 'bay511-vm-SF.json' });
  await Promise.allSettled(Array.from({ length: 6 }, (_, i) => call(p.arrivals, 'SF:' + (40000 + i), 0, 60)));
  assert.deepEqual(await call(p.vehicles, 'SF:14'), []);
  assert.equal(urls.filter(u => u.includes('VehicleMonitoring')).length, 0);
});

// ---------------------------------------------------------------- catalog

test('bay511: stopInfo from the operator stop list; unknown → error', async () => {
  const { p, urls } = make();
  assert.deepEqual(await call(p.stopInfo, 'SF:13008'), { id: 'SF:13008', name: 'Bacon St & San Bruno Ave', lat: 37.72777, lon: -122.40415 });
  await assert.rejects(call(p.stopInfo, 'SF:17777'), /unknown stop SF:17777/);
  assert.equal(urls.length, 1);
});

test('bay511: listRoutes and routeInfo (patterns only, no stop list)', async () => {
  const { p, urls } = make();
  assert.deepEqual(await call(p.listRoutes), [
    { id: 'SF:14', label: '14 MISSION' }, { id: 'SF:49', label: '49 VAN NESS-MISSION' }, { id: 'SF:KBUS', label: 'K Bus INGLESIDE BUS' }]);
  const info = await call(p.routeInfo, 'SF:14');
  assert.equal(urls.filter(u => u.includes('/stops?')).length, 0);
  assert.equal(info.shortName, '14');
  assert.deepEqual(info.directions[0], { id: 'IB', name: 'Ferry Plaza', stopIds: ['SF:15571', 'SF:15567', 'SF:15565', 'SF:15563'] });
  assert.deepEqual(info.stops['SF:15571'], { id: 'SF:15571', name: 'Mission St & 24th St' });
});

test('bay511: listRoutes with several operators labels them; one failing operator is skipped', async () => {
  const { p } = make({ 'lines?|operator_id=SF': 'bay511-lines-SF.json', 'lines?|operator_id=BA': 'bay511-lines-BA.json',
    'lines?|operator_id=ZZ': new Error('HTTP 500') }, { opts: { baseUrl: 'SF,BA,ZZ' } });
  const list = await call(p.listRoutes);
  assert.equal(list.length, 5);
  assert.deepEqual(list[3], { id: 'BA:Yellow-S', label: 'BA Yellow-S Antioch to SFIA/Millbrae' });
});

test('bay511: catalog = lines + stops per operator (2 requests); stops of built routes get routeIds', async () => {
  const { p, urls } = make();
  await call(p.route, 'SF:14');
  const n = urls.length;
  const progress = [];
  const cat = await new Promise((resolve, reject) => p.catalog((err, v) => (err ? reject(err) : resolve(v)), (d, total) => progress.push([d, total])));
  assert.equal(urls.length, n);  // all cached
  assert.deepEqual(progress, [[1, 1]]);
  assert.deepEqual(cat.routes[0], { id: 'SF:14', shortName: '14', longName: 'MISSION' });
  assert.equal(cat.routes.length, 3);
  assert.equal(cat.stops.length, 9);
  assert.deepEqual(cat.stops.find(s => s.id === 'SF:15565'), { id: 'SF:15565', name: 'Mission St & 18th St', routeIds: ['SF:14'], lat: 37.76172, lon: -122.41918 });
  assert.deepEqual(cat.stops.find(s => s.id === 'SF:13008').routeIds, []);
  const fresh = make();
  await call(fresh.p.catalog);
  assert.equal(fresh.urls.length, 2);
});

test('bay511: catalog: every operator failing → error', async () => {
  const { p } = make({ 'lines?': new Error('HTTP 401'), 'stops?': new Error('HTTP 401') });
  await assert.rejects(call(p.catalog), /HTTP 401/);
});

test('bay511: callbacks are asynchronous', async () => {
  const { p } = make();
  await call(p.route, 'SF:14');
  let sync = true;
  const done = new Promise(resolve => p.route('SF:14', () => resolve(sync)));
  sync = false;
  assert.equal(await done, false);
});
