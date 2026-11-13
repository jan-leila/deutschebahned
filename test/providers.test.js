const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const geo = require('../src/common/geo');
const settings = require('../src/common/settings');
const { createOneBusAway } = require('../src/sources/onebusaway/index');
const { createMock } = require('../src/sources/mock/index');
const { createRegistry } = require('../src/sources/registry');
const createProvider = (config, deps) => createRegistry(require('../src/sources/all')).create(config, deps);

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const call = (fn, ...args) => new Promise((resolve, reject) => fn(...args, (err, v) => (err ? reject(err) : resolve(v))));

// fake http: records URLs, answers from a route table {substring: fixtureName | Error}
function fakeHttp(routes) {
  const urls = [];
  const http = (url, cb) => {
    urls.push(url);
    const key = Object.keys(routes).find(k => url.includes(k));
    setTimeout(() => {
      if (!key) return cb(new Error('no fixture for ' + url));
      const v = routes[key];
      if (v instanceof Error) return cb(v);
      cb(null, fixture(v));
    }, 0);
  };
  return { http, urls };
}

// ---------------------------------------------------------------- OneBusAway

test('oba: stopsNear builds the URL and maps stops', async () => {
  const { http, urls } = fakeHttp({ 'stops-for-location': 'oba-stops-for-location.json' });
  const p = createOneBusAway({ baseUrl: 'https://oba.example/api/where', apiKey: 'K&1' }, http);
  const stops = await call(p.stopsNear, { lat: 47.6564, lon: -122.3121 }, 250);
  assert.equal(urls[0], 'https://oba.example/api/where/stops-for-location.json?key=K%261&lat=47.6564&lon=-122.3121&radius=250');
  assert.deepEqual(stops[0], { id: '1_10914', name: '15th Ave NE & NE Campus Pkwy', lat: 47.656426, lon: -122.312164, routeIds: ['1_100223', '1_100225'] });
  assert.equal(stops.length, 2);
  // sorted by distance from pos
  const pos = { lat: 47.6564, lon: -122.3121 };
  assert.ok(geo.distance(pos, stops[0]) <= geo.distance(pos, stops[1]));
});

test('oba: stopsNear sorts by distance even if the API does not', async () => {
  const { http } = fakeHttp({ 'stops-for-location': 'oba-stops-for-location.json' });
  const p = createOneBusAway({ baseUrl: 'https://oba.example/api/where', apiKey: 'K' }, http);
  const stops = await call(p.stopsNear, { lat: 47.65512, lon: -122.31261 }, 250);
  assert.deepEqual(stops.map(s => s.id), ['1_10917', '1_10914']);
});

test('oba: arrivals URL, predicted vs scheduled, tripKey, sorted', async () => {
  const { http, urls } = fakeHttp({ 'arrivals-and-departures-for-stop': 'oba-arrivals.json' });
  const p = createOneBusAway({ baseUrl: 'https://oba.example/api/where', apiKey: 'K' }, http);
  const arr = await call(p.arrivals, '1_10914', 3, 60);
  assert.equal(urls[0], 'https://oba.example/api/where/arrivals-and-departures-for-stop/1_10914.json?key=K&minutesBefore=3&minutesAfter=60');
  assert.deepEqual(arr, [
    { stopId: '1_10914', routeId: '1_100225', tripKey: '1_604670999@1762934400000', time: 1762992240, predicted: true, headsign: '' },
    { stopId: '1_10914', routeId: '1_100223', tripKey: '1_604670535@1762934400000', time: 1762992600, predicted: false, headsign: 'Downtown' }]);
});

test('oba: ids are URL-encoded in paths', async () => {
  const { http, urls } = fakeHttp({ 'arrivals-and-departures-for-stop': 'oba-arrivals.json', 'stops-for-route': 'oba-stops-for-route.json' });
  const p = createOneBusAway({ baseUrl: 'https://oba.example/api/where', apiKey: 'K' }, http);
  await call(p.arrivals, 'a b/c', 0, 10);
  await call(p.route, '1_100225', );
  assert.ok(urls[0].includes('/arrivals-and-departures-for-stop/a%20b%2Fc.json?'));
  assert.equal(urls[1], 'https://oba.example/api/where/stops-for-route/1_100225.json?key=K&includePolylines=true&version=2');
});

test('oba: route maps directions, paths, shortName and stops', async () => {
  const { http } = fakeHttp({ 'stops-for-route': 'oba-stops-for-route.json' });
  const p = createOneBusAway({ baseUrl: 'https://oba.example/api/where', apiKey: 'K' }, http);
  const r = await call(p.route, '1_100225');
  assert.equal(r.id, '1_100225');
  assert.equal(r.shortName, '44');
  assert.equal(r.directions.length, 2);
  assert.deepEqual(r.directions[0].id, '0');
  assert.equal(r.directions[0].name, 'Ballard');
  assert.deepEqual(r.directions[0].stopIds, ['1_A', '1_B', '1_C']);
  assert.deepEqual(r.directions[0].paths, [[{ lat: 38.5, lon: -120.2 }, { lat: 40.7, lon: -120.95 }]]);
  assert.equal(r.directions[1].name, 'U District');
  assert.deepEqual(r.stops['1_B'], { id: '1_B', name: 'Stop B', lat: 40.7, lon: -120.95 });
  assert.equal(Object.keys(r.stops).length, 4);
});

test('oba: route without stop groups -> single direction; shortName falls back', async () => {
  const { http } = fakeHttp({ 'stops-for-route': 'oba-stops-for-route-nogroups.json' });
  const p = createOneBusAway({ baseUrl: 'https://oba.example/api/where', apiKey: 'K' }, http);
  const r = await call(p.route, '1_999');
  assert.equal(r.shortName, 'Night Owl');
  assert.deepEqual(r.directions, [{ id: '0', name: '', stopIds: ['1_A', '1_B'],
    paths: [[{ lat: 38.5, lon: -120.2 }, { lat: 40.7, lon: -120.95 }]] }]);
});

test('oba: API error codes and transport errors reach the callback', async () => {
  const { http } = fakeHttp({ 'stops-for-location': 'oba-error.json', 'arrivals': new Error('offline') });
  const p = createOneBusAway({ baseUrl: 'https://oba.example/api/where', apiKey: 'K' }, http);
  await assert.rejects(call(p.stopsNear, { lat: 1, lon: 1 }, 100), /permission denied/);
  await assert.rejects(call(p.arrivals, 's', 0, 10), /offline/);
});

// ---------------------------------------------------------------- mock

const center = { lat: 47.6, lon: -122.3 };
function mockConfig() {
  return settings.normalize({ provider: { type: 'mock' }, location: { mode: 'fixed', lat: center.lat, lon: center.lon },
    routes: [{ id: 'R1', name: 'One' }, { id: 'R2', name: 'Two' }] });
}
const NOW = 1762992123;

test('mock: route geometry matches the contract', async () => {
  const p = createMock(mockConfig(), () => NOW);
  const r = await call(p.route, 'R2');
  assert.equal(r.id, 'R2');
  assert.equal(r.shortName, 'Two');
  assert.equal(r.directions.length, 1);
  const dir = r.directions[0];
  assert.equal(dir.id, '0');
  assert.equal(dir.stopIds.length, 16);
  assert.equal(dir.stopIds[0], 'R2:s0');
  assert.equal(r.stops['R2:s3'].name, 'Two stop 3');
  // route i=1 runs at bearing 60 through the centre; stop k is 400k m from start (3000 m before centre)
  const start = geo.offset(center, 3000, 60 + 180);
  const s5 = r.stops['R2:s5'];
  assert.ok(Math.abs(geo.distance(start, s5) - 2000) < 5);
  assert.ok(geo.distanceToPaths(center, dir.paths) < 1);
  assert.ok(Math.abs(geo.distance(center, r.stops['R2:s7']) - 200) < 5);
});

test('mock: stopsNear returns nearby stops of all routes sorted by distance', async () => {
  const p = createMock(mockConfig(), () => NOW);
  const stops = await call(p.stopsNear, center, 250);
  const ids = stops.map(s => s.id).sort();
  // the configured routes, then the demo routes M1..M3 (all lines cross the centre)
  assert.deepEqual(ids, ['M1:s7', 'M1:s8', 'M2:s7', 'M2:s8', 'M3:s7', 'M3:s8', 'R1:s7', 'R1:s8', 'R2:s7', 'R2:s8']);
  for (let i = 1; i < stops.length; i++) assert.ok(geo.distance(center, stops[i - 1]) <= geo.distance(center, stops[i]));
  assert.deepEqual(stops.find(s => s.id === 'R1:s7').routeIds, ['R1']);
});

test('mock: arrivals follow the 600 s headway timetable', async () => {
  const p = createMock(mockConfig(), () => NOW);
  const arr = await call(p.arrivals, 'R1:s8', 10, 30);
  const base = Math.floor(NOW / 600) * 600;
  // time at stop 8 = T_j + 400; window [NOW-600, NOW+1800]
  const expected = [];
  for (let j = -5; j <= 5; j++) {
    const t = base + j * 600 + 400;
    if (t >= NOW - 600 && t <= NOW + 1800) expected.push({ stopId: 'R1:s8', routeId: 'R1', tripKey: 'R1:t' + (base + j * 600), time: t, predicted: true, headsign: 'One' });
  }
  assert.deepEqual(arr, expected);
});

test('mock: same tripKey at different stops', async () => {
  const p = createMock(mockConfig(), () => NOW);
  const a = await call(p.arrivals, 'R1:s3', 0, 60);
  const b = await call(p.arrivals, 'R1:s10', 0, 90);
  const trip = a[0].tripKey;
  const later = b.find(x => x.tripKey === trip);
  assert.ok(later);
  assert.equal(later.time - a[0].time, 350);
});

test('mock: unknown ids error; callbacks are async', async () => {
  const p = createMock(mockConfig(), () => NOW);
  await assert.rejects(call(p.route, 'nope'));
  await assert.rejects(call(p.arrivals, 'nope', 0, 10));
  let sync = true, called = false;
  p.stopsNear(center, 100, () => { called = true; assert.equal(sync, false); });
  sync = false;
  await new Promise(r => setTimeout(r, 5));
  assert.ok(called);
});

test('createProvider picks by type', () => {
  const http = () => {};
  const m = createProvider(mockConfig(), { http, clock: () => NOW });
  const o = createProvider(settings.defaults(), { http, clock: () => NOW });
  for (const p of [m, o]) for (const f of ['stopsNear', 'arrivals', 'route']) assert.equal(typeof p[f], 'function');
  assert.notEqual(m.stopsNear, o.stopsNear);
});

// ---------------------------------------------------------------- Metro Transit (NexTrip + Schedule APIs)
// Fixtures are real (trimmed) responses from svc.metrotransit.org for route 2.
const { createMetroTransit, DEFAULT_BASE_URL } = require('../src/sources/metrotransit/index');

const MT = 'https://svc.metrotransit.org';
function mtHttp(overrides) {
  const urls = [];
  const http = (url, cb) => {
    urls.push(url);
    setTimeout(() => {
      if (overrides && url in overrides) {
        const v = overrides[url];
        return v instanceof Error ? cb(v) : cb(null, typeof v === 'string' ? fixture(v) : v);
      }
      const p = url.slice(MT.length);
      let m;
      if (p === '/schedule/routes') return cb(null, fixture('mt-schedule-routes.json'));
      if ((m = p.match(/^\/schedule\/routedetails\/(.+)$/))) return m[1] === '2' ? cb(null, fixture('mt-routedetails-2.json')) : cb(null, fixture('mt-error-400.json'));
      if ((m = p.match(/^\/schedule\/stoplist\/2\/(\d+)$/))) return cb(null, fixture(`mt-stoplist-2-${m[1]}.json`));
      if ((m = p.match(/^\/nextrip\/vehicles\/2$/))) return cb(null, fixture('mt-vehicles-2.json'));
      if ((m = p.match(/^\/nextrip\/(\d+)$/))) {
        try { return cb(null, fixture(`mt-nextrip-stop-${m[1]}.json`)); } catch (e) { return cb(null, fixture('mt-error-400.json')); }
      }
      cb(null, fixture('mt-error-400.json'));
    }, 0);
  };
  return { http, urls };
}
function memStore() {
  const m = new Map();
  return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}
// fixture departures are around this time (real capture)
const MT_NOW = 1794547900;

test('metrotransit: default base URL', () => {
  assert.equal(DEFAULT_BASE_URL, 'https://svc.metrotransit.org');
});

test('metrotransit: arrivals from NexTrip departures', async () => {
  const { http, urls } = mtHttp();
  const p = createMetroTransit({ baseUrl: '', routeIds: ['2'] }, http, { clock: () => MT_NOW });
  const arr = await call(p.arrivals, '16058', 0, 120);
  assert.equal(urls[0], 'https://svc.metrotransit.org/nextrip/16058');
  assert.deepEqual(arr.slice(0, 2), [
    { stopId: '16058', routeId: '2', tripKey: '1361576', time: 1794548039, predicted: true, headsign: 'Hennepin/Franklin' },
    { stopId: '16058', routeId: '2', tripKey: '1361323', time: 1794549877, predicted: true, headsign: 'Hennepin/Franklin' }]);
  assert.ok(arr.some(a => a.routeId === '4' && a.headsign === 'Silver Lk Vlg via Lyndale'), 'headsign trimmed, other routes kept');
  for (let i = 1; i < arr.length; i++) assert.ok(arr[i - 1].time <= arr[i].time);
  // window filter
  const soon = await call(p.arrivals, '16058', 0, 10);
  assert.deepEqual(soon.map(a => a.tripKey), ['1361576']);
});

test('metrotransit: route builds directions from the weekday timetables, stop coords from NexTrip', async () => {
  const { http, urls } = mtHttp();
  const store = memStore();
  const p = createMetroTransit({ baseUrl: MT + '/', routeIds: ['2'] }, http, { clock: () => MT_NOW, storage: store });
  const r = await call(p.route, '2');
  assert.equal(r.id, '2');
  assert.equal(r.shortName, '2');
  assert.equal(r.color, '771473');
  assert.deepEqual(r.directions.map(d => [d.id, d.name]), [['0', 'Eastbound'], ['1', 'Westbound']]);
  assert.deepEqual(r.directions[0].stopIds, ['13337', '13334', '103', '80802']);
  assert.deepEqual(r.directions[1].stopIds, ['57618', '57302', '56302', '16058']);
  assert.deepEqual(r.stops['13334'], { id: '13334', name: 'Franklin Ave W & Lyndale Ave S', lat: 44.962651, lon: -93.288117 });
  assert.deepEqual(r.directions[0].paths, [[
    { lat: 44.96263, lon: -93.291123 }, { lat: 44.962651, lon: -93.288117 }, { lat: 44.96102, lon: -93.288137 }, { lat: 44.959071, lon: -93.287849 }]]);
  assert.ok(urls.includes(MT + '/schedule/routedetails/2'));
  assert.ok(urls.includes(MT + '/schedule/stoplist/2/1') && urls.includes(MT + '/schedule/stoplist/2/2'));
  assert.ok(!urls.some(u => u.includes('//schedule') || u.includes('//nextrip')), 'trailing slash on baseUrl handled');
  // cached in storage: a new provider with the same storage needs no requests
  const second = mtHttp();
  const p2 = createMetroTransit({ baseUrl: '', routeIds: ['2'] }, second.http, { clock: () => MT_NOW + 3600, storage: store });
  assert.deepEqual(await call(p2.route, '2'), r);
  assert.equal(second.urls.length, 0);
  // ...until the cache is a week old
  const third = mtHttp();
  const p3 = createMetroTransit({ baseUrl: '', routeIds: ['2'] }, third.http, { clock: () => MT_NOW + 8 * 86400, storage: store });
  await call(p3.route, '2');
  assert.ok(third.urls.length > 0);
});

test('metrotransit: limits concurrent requests and dedupes concurrent route() calls', async () => {
  let inFlight = 0, maxInFlight = 0;
  const base = mtHttp();
  const http = (url, cb) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); base.http(url, (e, v) => { inFlight--; cb(e, v); }); };
  const p = createMetroTransit({ baseUrl: '', routeIds: ['2'] }, http, { clock: () => MT_NOW });
  const [a, b] = await Promise.all([call(p.route, '2'), call(p.route, '2')]);
  assert.deepEqual(a, b);
  assert.ok(maxInFlight <= 4, 'max in flight ' + maxInFlight);
  assert.equal(base.urls.filter(u => u.endsWith('/schedule/routedetails/2')).length, 1);
});

test('metrotransit: stops whose coordinates cannot be loaded are left out', async () => {
  const { http } = mtHttp({ [MT + '/nextrip/103']: new Error('timeout') });
  const p = createMetroTransit({ baseUrl: '', routeIds: ['2'] }, http, { clock: () => MT_NOW });
  const r = await call(p.route, '2');
  assert.deepEqual(r.directions[0].stopIds, ['13337', '13334', '80802']);
  assert.equal(r.stops['103'], undefined);
  assert.equal(r.directions[0].paths[0].length, 3);
});

test('metrotransit: stopsNear searches the stops of the configured routes', async () => {
  const { http } = mtHttp();
  const p = createMetroTransit({ baseUrl: '', routeIds: ['2'] }, http, { clock: () => MT_NOW });
  const here = { lat: 44.96265, lon: -93.2895 }; // between Hennepin and Lyndale on Franklin
  const stops = await call(p.stopsNear, here, 200);
  assert.deepEqual(stops.map(s => s.id).sort(), ['13334', '13337']);
  assert.deepEqual(stops[0].routeIds, ['2']);
  for (let i = 1; i < stops.length; i++) assert.ok(geo.distance(here, stops[i - 1]) <= geo.distance(here, stops[i]));
  const none = createMetroTransit({ baseUrl: '', routeIds: [] }, http, { clock: () => MT_NOW });
  assert.deepEqual(await call(none.stopsNear, here, 200), []);
});

test('metrotransit: vehicles with a position fix', async () => {
  const { http, urls } = mtHttp();
  const p = createMetroTransit({ baseUrl: '', routeIds: ['2'] }, http, { clock: () => MT_NOW });
  const v = await call(p.vehicles, '2');
  assert.equal(urls[0], MT + '/nextrip/vehicles/2');
  assert.ok(v.length >= 3);
  assert.ok(v.every(x => x.time > 0 && x.lat !== 0));
  assert.deepEqual(v.find(x => x.tripKey === '1333026'),
    { tripKey: '1333026', routeId: '2', directionId: '0', lat: 44.94994, lon: -93.29764, time: 1794547859 });
});

test('metrotransit: API problem responses become errors', async () => {
  const { http } = mtHttp();
  const p = createMetroTransit({ baseUrl: '', routeIds: ['21'] }, http, { clock: () => MT_NOW });
  await assert.rejects(call(p.arrivals, '999999', 0, 60), /Invalid route_id|Bad Request/);
  await assert.rejects(call(p.route, '21'), /unknown route|Invalid|Bad Request/);
});

test('oba: route color and default base URL / key', async () => {
  const { http, urls } = fakeHttp({ 'stops-for-route': 'oba-stops-for-route.json' });
  const p = createOneBusAway({ baseUrl: '', apiKey: '' }, http);
  const r = await call(p.route, '1_100225');
  assert.equal(urls[0], 'https://api.pugetsound.onebusaway.org/api/where/stops-for-route/1_100225.json?key=TEST&includePolylines=true&version=2');
  assert.equal(r.color, '');
  assert.equal(typeof p.vehicles, 'undefined', 'OBA has no vehicles call');
});

test('mock: route colors and vehicles', async () => {
  const p = createMock(mockConfig(), () => NOW);
  assert.equal((await call(p.route, 'R1')).color, 'E53935');
  assert.equal((await call(p.route, 'R2')).color, '1E88E5');
  const v = await call(p.vehicles, 'R1');
  const base = Math.floor(NOW / 600) * 600;
  // trips on the road: 0 <= now - T_j <= 750 s; position = 8 m/s * elapsed from the line start
  const expected = [base - 600, base].filter(t => NOW - t >= 0 && NOW - t <= 750);
  assert.deepEqual(v.map(x => x.tripKey).sort(), expected.map(t => 'R1:t' + t).sort());
  const r1 = await call(p.route, 'R1');
  const start = r1.directions[0].paths[0][0];
  for (const x of v) {
    const T = Number(x.tripKey.split(':t')[1]);
    assert.ok(Math.abs(geo.distance(start, x) - 8 * (NOW - T)) < 5);
    assert.equal(x.time, NOW);
    assert.equal(x.directionId, '0');
    assert.equal(x.routeId, 'R1');
  }
});

test('createProvider: metrotransit is the default and gets storage + configured routes', async () => {
  const { http, urls } = mtHttp();
  const store = memStore();
  const cfg = settings.normalize({ routes: [{ id: '2' }], connections: [{ routeId: '2', stopId: '16058' }] });
  const p = createProvider(cfg, { http, clock: () => MT_NOW, storage: store });
  const stops = await call(p.stopsNear, { lat: 44.96265, lon: -93.2895 }, 200);
  assert.equal(stops.length, 2);
  assert.ok(urls[0].startsWith(MT));
  assert.ok([...store.m.keys()].some(k => k.startsWith('busWatch.mt.')), 'route geometry cached in storage');
});

// ---------------------------------------------------------------- catalog methods (settings page helpers, CONTRACTS.md §3)

test('metrotransit catalog: listRoutes from /nextrip/routes (fetched once)', async () => {
  const { http, urls } = mtHttp({ [MT + '/nextrip/routes']: 'mt-nextrip-routes.json' });
  const p = createMetroTransit({ baseUrl: '', routeIds: [] }, http, { clock: () => MT_NOW });
  const list = await call(p.listRoutes);
  assert.deepEqual(list, [{ id: '901', label: 'METRO Blue Line' }, { id: '922', label: 'METRO B Line' }, { id: '2', label: 'Route 2' }]);
  await call(p.listRoutes);
  assert.deepEqual(urls, [MT + '/nextrip/routes']);
});

test('metrotransit catalog: routeInfo needs no stop coordinate lookups and shares the schedule fetch', async () => {
  const { http, urls } = mtHttp();
  const p = createMetroTransit({ baseUrl: '', routeIds: ['2'] }, http, { clock: () => MT_NOW });
  const info = await call(p.routeInfo, '2');
  assert.equal(info.id, '2');
  assert.equal(info.shortName, '2');
  assert.equal(info.color, '771473');
  assert.deepEqual(info.directions, [
    { id: '0', name: 'Eastbound', stopIds: ['13337', '13334', '103', '80802'] },
    { id: '1', name: 'Westbound', stopIds: ['57618', '57302', '56302', '16058'] }]);
  assert.deepEqual(info.stops['16058'], { id: '16058', name: '8th St SE & 5th Ave SE' });
  assert.ok(!urls.some(u => /\/nextrip\/\d+$/.test(u)), 'no per-stop requests');
  assert.deepEqual(urls.slice().sort(), [MT + '/schedule/routedetails/2', MT + '/schedule/routes', MT + '/schedule/stoplist/2/1', MT + '/schedule/stoplist/2/2']);
  // route() afterwards reuses the details: only the coordinate lookups are new
  const n = urls.length;
  const r = await call(p.route, '2');
  assert.equal(r.directions[1].stopIds.length, 4);
  assert.ok(urls.slice(n).every(u => /\/nextrip\/\d+$/.test(u)), urls.slice(n).join(' '));
  await assert.rejects(call(p.routeInfo, '21'), /unknown route/);
});

test('metrotransit catalog: routeInfo answers from a stored route without requests', async () => {
  const store = memStore();
  const first = mtHttp();
  await call(createMetroTransit({ baseUrl: '', routeIds: ['2'] }, first.http, { clock: () => MT_NOW, storage: store }).route, '2');
  const second = mtHttp();
  const p = createMetroTransit({ baseUrl: '', routeIds: ['2'] }, second.http, { clock: () => MT_NOW, storage: store });
  const info = await call(p.routeInfo, '2');
  assert.equal(info.directions[0].stopIds[0], '13337');
  assert.equal(second.urls.length, 0);
});

test('metrotransit catalog: stopInfo from /nextrip/{stop}, shared with the coordinate cache', async () => {
  const { http, urls } = mtHttp();
  const p = createMetroTransit({ baseUrl: '', routeIds: ['2'] }, http, { clock: () => MT_NOW });
  assert.deepEqual(await call(p.stopInfo, '16058'), { id: '16058', name: '8th St SE & 5th Ave SE', lat: 44.989411, lon: -93.245348 });
  await call(p.stopInfo, '16058');
  assert.deepEqual(urls, [MT + '/nextrip/16058']);
  await call(p.route, '2');
  assert.equal(urls.filter(u => u === MT + '/nextrip/16058').length, 1, 'route() reused the stop lookup');
  await assert.rejects(call(p.stopInfo, '999999'), /Invalid|Bad Request/);
});

test('oba catalog: no listRoutes; routeInfo = route; stopInfo from /stop/{id}.json', async () => {
  const { http, urls } = fakeHttp({ '/stop/': 'oba-stop.json', 'stops-for-route': 'oba-stops-for-route.json' });
  const p = createOneBusAway({ baseUrl: 'https://oba.example/api/where', apiKey: 'K&1' }, http);
  assert.equal(typeof p.listRoutes, 'undefined');
  assert.deepEqual(await call(p.stopInfo, '1_10914'), { id: '1_10914', name: '15th Ave NE & NE Campus Pkwy', lat: 47.656426, lon: -122.312164 });
  assert.equal(urls[0], 'https://oba.example/api/where/stop/1_10914.json?key=K%261');
  assert.deepEqual(await call(p.routeInfo, '1_100225'), await call(p.route, '1_100225'));
  const bad = createOneBusAway({ baseUrl: '', apiKey: '' }, fakeHttp({ '/stop/': 'oba-error.json' }).http);
  await assert.rejects(call(bad.stopInfo, 'x'));
});

test('mock catalog: listRoutes, routeInfo, stopInfo from the generated network', async () => {
  const p = createMock(mockConfig(), () => NOW);
  const list = await call(p.listRoutes);
  const cfg = mockConfig();
  assert.deepEqual(list, cfg.routes.map(r => ({ id: r.id, label: r.id + ' ' + (r.name || r.id) }))
    .concat([1, 2, 3].map(n => ({ id: 'M' + n, label: 'M' + n + ' Mock ' + n }))));
  assert.deepEqual(await call(p.routeInfo, 'R1'), await call(p.route, 'R1'));
  const r1 = await call(p.route, 'R1');
  assert.deepEqual(await call(p.stopInfo, 'R1:s3'), r1.stops['R1:s3']);
  await assert.rejects(call(p.stopInfo, 'nope'), /unknown/);
  let sync = true;
  p.stopInfo('R1:s0', () => assert.equal(sync, false, 'async'));
  sync = false;
});

test('route longName: Metro Transit route_desc, OBA longName, mock generated', async () => {
  const { http } = mtHttp();
  const mt = createMetroTransit({ routeIds: ['2'] }, http, { clock: () => MT_NOW });
  const info = await call(mt.routeInfo, '2');
  assert.equal(info.longName, 'Franklin Av - Riverside Av - U of M - 8th St SE');
  const mock = createMock(mockConfig(), () => NOW);
  const r = await call(mock.route, mockConfig().routes[0].id);
  assert.ok(r.longName.length > r.shortName.length);
});

// ---------------------------------------------------------------- catalog (search index)

test('mock catalog(): every route and stop of the network, with positions', async () => {
  const p = createMock(mockConfig(), () => NOW);
  const progress = [];
  const cat = await new Promise((resolve, reject) => p.catalog((e, v) => (e ? reject(e) : resolve(v)), (n, t) => progress.push([n, t])));
  assert.deepEqual(cat.routes.map(r => r.id), ['R1', 'R2', 'M1', 'M2', 'M3']);
  assert.deepEqual(cat.routes[0], { id: 'R1', shortName: 'One', longName: 'One via Mock Av - Centre - Station R1' });
  assert.equal(cat.stops.length, 5 * 16);
  const r1 = await call(p.route, 'R1');
  assert.deepEqual(cat.stops[3], Object.assign({}, r1.stops['R1:s3'], { routeIds: ['R1'] }));
  assert.deepEqual(progress, [[5, 5]]);
});

test('metrotransit catalog(): route list, then each route\'s stop lists; failing routes listed without stops', async () => {
  const { http, urls } = mtHttp({ [MT + '/nextrip/routes']: 'mt-nextrip-routes.json' });
  const mt = createMetroTransit({ routeIds: [] }, http, { clock: () => MT_NOW });
  const progress = [];
  const cat = await new Promise((resolve, reject) => mt.catalog((e, v) => (e ? reject(e) : resolve(v)), (n, t) => progress.push([n, t])));
  assert.deepEqual(cat.routes, [
    { id: '901', shortName: '901', longName: 'METRO Blue Line' },
    { id: '922', shortName: '922', longName: 'METRO B Line' },
    { id: '2', shortName: '2', longName: 'Franklin Av - Riverside Av - U of M - 8th St SE' },
  ]);
  const listed = new Set([...fixture('mt-stoplist-2-1.json'), ...fixture('mt-stoplist-2-2.json')].map(s => String(s.stop_id)));
  assert.deepEqual(new Set(cat.stops.map(s => s.id)), listed);
  const franklin = cat.stops.find(s => s.id === '13337');
  assert.deepEqual(franklin, { id: '13337', name: 'Franklin Ave and Hennepin Ave', routeIds: ['2'] });
  assert.deepEqual(progress.map(p => p[1]), [3, 3, 3]);
  assert.ok(!urls.some(u => /\/nextrip\/\d+$/.test(u)), 'no per-stop coordinate lookups');
});

test('metrotransit catalog(): a route already built gives its stop positions', async () => {
  const { http } = mtHttp({ [MT + '/nextrip/routes']: [{ route_id: '2', route_label: 'Route 2' }] });
  const mem = {};
  const storage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = v; }, removeItem: k => { delete mem[k]; } };
  const mt = createMetroTransit({ routeIds: ['2'] }, http, { clock: () => MT_NOW, storage });
  const r = await call(mt.route, '2');
  const cat = await new Promise((resolve, reject) => mt.catalog((e, v) => (e ? reject(e) : resolve(v))));
  const any = Object.keys(r.stops)[0];
  const s = cat.stops.find(x => x.id === any);
  assert.deepEqual([s.lat, s.lon], [r.stops[any].lat, r.stops[any].lon]);
  await assert.rejects(new Promise((resolve, reject) =>
    createMetroTransit({}, mtHttp().http, { clock: () => MT_NOW }).catalog((e, v) => (e ? reject(e) : resolve(v)))));
});

test('onebusaway catalog(): agencies → routes → stops-for-route without polylines', async () => {
  const { http, urls } = fakeHttp({ 'agencies-with-coverage': 'oba-agencies-with-coverage.json', 'routes-for-agency/1': 'oba-routes-for-agency-1.json',
    'stops-for-route/1_100225': 'oba-stops-for-route.json', 'stops-for-route/1_100223': new Error('timeout') });
  const p = createOneBusAway({ baseUrl: 'https://oba.example/api/where', apiKey: 'K' }, http);
  const progress = [];
  const cat = await new Promise((resolve, reject) => p.catalog((e, v) => (e ? reject(e) : resolve(v)), (n, t) => progress.push([n, t])));
  assert.equal(urls[0], 'https://oba.example/api/where/agencies-with-coverage.json?key=K');
  assert.equal(urls[1], 'https://oba.example/api/where/routes-for-agency/1.json?key=K');
  assert.ok(urls.includes('https://oba.example/api/where/stops-for-route/1_100225.json?key=K&includePolylines=false&version=2'));
  assert.deepEqual(cat.routes, [{ id: '1_100225', shortName: '44', longName: 'Ballard - U District' },
                                { id: '1_100223', shortName: '43', longName: 'University District - Downtown' }]);
  const refs = fixture('oba-stops-for-route.json').data.references.stops;
  assert.equal(cat.stops.length, refs.length);
  assert.deepEqual(cat.stops[0], { id: refs[0].id, name: refs[0].name, lat: refs[0].lat, lon: refs[0].lon, routeIds: ['1_100225'] });
  assert.deepEqual(progress.map(x => x[1]), [2, 2]);
  const bad = createOneBusAway({}, fakeHttp({ 'agencies-with-coverage': 'oba-error.json' }).http);
  await assert.rejects(new Promise((resolve, reject) => bad.catalog((e, v) => (e ? reject(e) : resolve(v)))));
});
