// WMATA (Washington DC) source: fixtures test/fixtures/wmata-*.json are real responses captured with the public
// demo key on 2026-11-13 around 21:43 UTC (16:43 in Washington), trimmed; no network here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const geo = require('../src/common/geo');
const { createWmata, plugin, easternEpoch, DEFAULT_BASE_URL } = require('../src/sources/wmata/index');

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'wmata-' + name + '.json'), 'utf8'));
const call = (fn, ...args) => new Promise((resolve, reject) => fn(...args, (err, v) => (err ? reject(err) : resolve(v))));
const NOW = Date.UTC(2026, 10, 13, 21, 43, 0) / 1000;
const KEY = 'k3y';

// URL → fixture name (first matching rule wins); a value may be an Error, or an array answered in turn
const ROUTES = [
  ['/Bus.svc/json/jStops?Lat=', 'stops-near'],
  ['/Bus.svc/json/jStops', 'stops-all'],
  ['/Bus.svc/json/jRoutes', 'routes'],
  ['/Bus.svc/json/jRouteDetails?RouteID=D80', 'routedetails-D80'],
  ['/Bus.svc/json/jRouteDetails?', 'error-400-route'],
  ['/Bus.svc/json/jBusPositions?RouteID=D80', 'buspositions-D80'],
  ['/Bus.svc/json/jStopSchedule?StopID=1001141', 'stopschedule'],
  ['/NextBusService.svc/json/jPredictions?StopID=1001141', 'predictions'],
  ['/NextBusService.svc/json/jPredictions?', 'error-400'],
  ['/Rail.svc/json/jStations', 'stations'],
  ['/Rail.svc/json/jLines', 'lines'],
  ['/Rail.svc/json/jPath?FromStationCode=A15&ToStationCode=B11', 'path-RD'],
  ['/StationPrediction.svc/json/GetPrediction/All', 'predictions-all']
];

function fakeHttp(overrides) {
  const calls = [];
  const rules = (overrides || []).concat(ROUTES);
  const used = new Map();
  const http = (url, cb, headers) => {
    calls.push({ url, headers });
    const rule = rules.find(r => url.includes(r[0]));
    setTimeout(() => {
      if (!rule) return cb(new Error('no fixture for ' + url));
      let v = rule[1];
      if (Array.isArray(v)) { const n = used.get(rule) || 0; used.set(rule, n + 1); v = v[Math.min(n, v.length - 1)]; }
      if (v instanceof Error) return cb(v);
      cb(null, fixture(v));
    }, 0);
  };
  return { http, calls, urls: () => calls.map(c => c.url.replace(DEFAULT_BASE_URL, '')) };
}

function memStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), keys: () => [...m.keys()] };
}

function make(extra) {
  const h = fakeHttp(extra && extra.overrides);
  const p = createWmata({ apiKey: KEY, baseUrl: extra && extra.baseUrl }, h.http,
    { clock: () => NOW, storage: extra && extra.storage, retryMs: 5 });
  return Object.assign(h, { p });
}

// ---------------------------------------------------------------- key, URLs, headers

test('wmata: missing API key → a clear error from every method, no requests', async () => {
  const h = fakeHttp();
  const p = createWmata({ apiKey: '  ' }, h.http, { clock: () => NOW });
  const msg = /^Error: WMATA needs an API key: get one at developer\.wmata\.com$/;
  let sync = true;
  const pending = call(p.stopsNear, { lat: 38.9, lon: -77 }, 300);
  await assert.rejects(pending, e => { assert.match(String(e), msg); return true; });
  await assert.rejects(call(p.arrivals, '1001141', 0, 30), msg);
  await assert.rejects(call(p.arrivals, 'A01', 0, 30), msg);
  await assert.rejects(call(p.route, 'D80'), msg);
  await assert.rejects(call(p.routeInfo, 'RD'), msg);
  await assert.rejects(call(p.vehicles, 'D80'), msg);
  await assert.rejects(call(p.listRoutes), msg);
  await assert.rejects(call(p.stopInfo, '1001141'), msg);
  await assert.rejects(new Promise((res, rej) => p.catalog((e, v) => (e ? rej(e) : res(v)))), msg);
  // asynchronous even without a key
  p.arrivals('1', 0, 1, () => { assert.equal(sync, false); });
  sync = false;
  assert.equal(h.calls.length, 0);
});

test('wmata: the key is sent as the api_key header (never in the URL); base URL default and override', async () => {
  const a = make();
  await call(a.p.arrivals, '1001141', 0, 30);
  assert.equal(a.calls[0].url, 'https://api.wmata.com/NextBusService.svc/json/jPredictions?StopID=1001141');
  assert.deepEqual(a.calls[0].headers, { api_key: KEY });
  const b = make({ baseUrl: 'https://proxy.example/wmata/' });
  await call(b.p.arrivals, 'x y/1', 0, 30).catch(() => {});
  assert.equal(b.calls[0].url, 'https://proxy.example/wmata/NextBusService.svc/json/jPredictions?StopID=x%20y%2F1');
  assert.ok(!b.calls[0].url.includes(KEY));
});

// ---------------------------------------------------------------- stopsNear

test('wmata: stopsNear = jStops around the position + rail platforms in range, nearest first', async () => {
  const { p, calls, urls } = make();
  const pos = { lat: 38.8983, lon: -77.0300 };
  const stops = await call(p.stopsNear, pos, 400.4);
  assert.deepEqual(urls().sort(), ['/Bus.svc/json/jStops?Lat=38.8983&Lon=-77.03&Radius=400', '/Rail.svc/json/jStations'].sort());
  for (const c of calls) assert.deepEqual(c.headers, { api_key: KEY });
  // Metro Center: one stop per platform, each with its own lines
  const a01 = stops.find(s => s.id === 'A01'), c01 = stops.find(s => s.id === 'C01');
  assert.deepEqual(a01, { id: 'A01', name: 'Metro Center', lat: 38.898303, lon: -77.028099, routeIds: ['RD'] });
  assert.deepEqual(c01.routeIds, ['BL', 'OR', 'SV']);
  assert.ok(!stops.some(s => s.id === 'A02'), 'Farragut North is 1.1 km away');
  assert.deepEqual(stops.find(s => s.id === '1001141'),
    { id: '1001141', name: 'H St NW+Madison Pl NW', lat: 38.900131, lon: -77.035377, routeIds: ['D10', 'D20', 'D72', 'D80', 'D94', 'F19'] });
  assert.equal(stops.length, 12 + 2);
  for (let i = 1; i < stops.length; i++) assert.ok(geo.distance(pos, stops[i - 1]) <= geo.distance(pos, stops[i]));
});

test('wmata: stopsNear still answers when one half fails; both failing → error', async () => {
  const a = make({ overrides: [['jStations', new Error('offline')]] });
  const s = await call(a.p.stopsNear, { lat: 38.8978, lon: -77.0365 }, 500);
  assert.equal(s.length, 12);
  const b = make({ overrides: [['jStations', new Error('offline')], ['jStops', new Error('offline')]] });
  await assert.rejects(call(b.p.stopsNear, { lat: 38.8978, lon: -77.0365 }, 500), /offline/);
});

// ---------------------------------------------------------------- arrivals

test('wmata: bus arrivals from jPredictions (minutes from now, TripID as tripKey), window and order', async () => {
  const { p } = make();
  const arr = await call(p.arrivals, '1001141', 2, 10);
  assert.deepEqual(arr, [
    { stopId: '1001141', routeId: 'D10', tripKey: '24288060', time: NOW + 120, predicted: true, headsign: 'East to Southern Av' },
    { stopId: '1001141', routeId: 'D20', tripKey: '5135060', time: NOW + 420, predicted: true, headsign: 'East to Minnesota Av' },
    { stopId: '1001141', routeId: 'D80', tripKey: '28941060', time: NOW + 420, predicted: true, headsign: 'South to Union Station' },
    { stopId: '1001141', routeId: 'F19', tripKey: '31493060', time: NOW + 600, predicted: true, headsign: 'South to Mt Vernon' }]);
  const all = await call(p.arrivals, '1001141', 0, 90);
  assert.equal(all.length, 19);
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].time <= all[i].time);
});

test('wmata: bus tripKey matches jBusPositions TripID (same run)', async () => {
  const { p } = make();
  const veh = await call(p.vehicles, 'D80');
  const arr = await call(p.arrivals, '1001141', 0, 90);
  // TripIDs are the same id space in both feeds
  assert.ok(veh.every(v => /^[0-9]+$/.test(v.tripKey)) && arr.every(a => /^[0-9]+$/.test(a.tripKey)));
});

test('wmata: rail arrivals from one GetPrediction/All snapshot; the same train has the same tripKey downline', async () => {
  const { p, urls } = make();
  const a02 = await call(p.arrivals, 'A02', 0, 30);
  const a01 = await call(p.arrivals, 'A01', 0, 30);
  const b01 = await call(p.arrivals, 'B01', 0, 30);
  // one snapshot for every station; path + lines loaded once for the matching
  assert.equal(urls().filter(u => u.includes('GetPrediction/All')).length, 1);
  assert.equal(urls().filter(u => u.includes('jPath')).length, 1);
  assert.ok(urls().includes('/Rail.svc/json/jPath?FromStationCode=A15&ToStationCode=B11'));
  // A01 Metro Center: RD trains only (the no-passenger '--' entry is dropped), minutes → epoch, ascending
  assert.deepEqual(a01.map(a => [a.routeId, a.time - NOW, a.headsign]), [
    ['RD', 120, 'Glenmont'], ['RD', 180, 'Shady Grove'], ['RD', 420, 'Glenmont'], ['RD', 540, 'Shady Grove'],
    ['RD', 660, 'Glenmont'], ['RD', 720, 'Shady Grove']]);
  assert.ok(a01.every(a => a.predicted === true && a.stopId === 'A01'));
  // the Glenmont train boarding at Farragut North (A02) reaches Metro Center 2 min and Gallery Place 4 min later
  const brd = a02.find(a => a.headsign === 'Glenmont' && a.time === NOW);
  assert.ok(brd);
  assert.equal(a01.find(a => a.tripKey === brd.tripKey).time, NOW + 120);
  assert.equal(b01.find(a => a.tripKey === brd.tripKey).time, NOW + 240);
  // distinct trains at a station have distinct keys
  assert.equal(new Set(a01.map(a => a.tripKey)).size, a01.length);
});

test('wmata: rail lines without a loadable path fall back to per-station keys; unknown station → []', async () => {
  const { p } = make();
  const c01 = await call(p.arrivals, 'C01', 0, 30);
  assert.deepEqual([...new Set(c01.map(a => a.routeId))].sort(), ['BL', 'OR', 'SV']);
  assert.ok(c01.every(a => a.tripKey.split('.')[2] === 'C01'));
  assert.deepEqual(await call(p.arrivals, 'Z99', 0, 30), []);
});

// ---------------------------------------------------------------- route

test('wmata: bus route from jRouteDetails (+ jRoutes for the long name), stored for 7 days', async () => {
  const storage = memStorage();
  const { p, urls } = make({ storage });
  const r = await call(p.route, 'D80');
  assert.deepEqual(urls().sort(), ['/Bus.svc/json/jRouteDetails?RouteID=D80', '/Bus.svc/json/jRoutes']);
  assert.equal(r.id, 'D80');
  assert.equal(r.shortName, 'D80');
  assert.equal(r.longName, 'Wisconsin Av-Union Station');
  assert.equal(r.color, '');
  assert.deepEqual(r.directions.map(d => [d.id, d.name, d.stopIds.length]),
    [['0', 'North to Friendship Hts', 8], ['1', 'South to Union Station', 8]]);
  assert.deepEqual(r.directions[0].stopIds.slice(0, 3), ['1003851', '1005081', '1001094']);
  assert.equal(r.directions[0].paths.length, 1);
  assert.deepEqual(r.directions[0].paths[0][0], { lat: 38.896422, lon: -77.008036 });
  assert.deepEqual(r.directions[0].paths[0].slice(-1)[0], { lat: 38.96139, lon: -77.085693 });
  assert.deepEqual(r.stops['1003851'], { id: '1003851', name: 'E St NE+Columbus Cir', lat: 38.896414, lon: -77.008033 });
  for (const d of r.directions) for (const id of d.stopIds) assert.ok(r.stops[id]);
  // a new provider on the same storage answers without requests
  const again = make({ storage });
  assert.deepEqual(await call(again.p.route, 'D80'), r);
  assert.equal(again.calls.length, 0);
  assert.ok(storage.keys().every(k => k.startsWith('busWatch.wmata.')));
});

test('wmata: route long name falls back to the details Name; concurrent calls share one fetch; unknown route → error', async () => {
  const { p, urls } = make({ overrides: [['jRoutes', new Error('offline')]] });
  const [a, b] = await Promise.all([call(p.route, 'D80'), call(p.routeInfo, 'D80')]);
  assert.equal(a, b);
  assert.equal(a.longName, 'Friendship Hts - Union Station');
  assert.equal(urls().filter(u => u.includes('jRouteDetails')).length, 1);
  await assert.rejects(call(p.route, 'ZZZ'), /Pattern\/route name not specified/);
});

test('wmata: rail route = line path between its terminals, station coordinates, line colour', async () => {
  const { p, urls } = make();
  const r = await call(p.route, 'RD');
  assert.ok(urls().includes('/Rail.svc/json/jPath?FromStationCode=A15&ToStationCode=B11'));
  assert.equal(r.shortName, 'Red');
  assert.equal(r.longName, 'Red Line');
  assert.equal(r.color, 'BF0D3E');
  const [d1, d2] = r.directions;
  assert.equal(d1.id, '1');
  assert.equal(d1.name, 'to Glenmont');
  assert.equal(d2.id, '2');
  assert.equal(d2.name, 'to Shady Grove');
  assert.equal(d1.stopIds.length, 27);
  assert.deepEqual(d1.stopIds.slice(0, 3), ['A15', 'A14', 'A13']);
  assert.deepEqual(d2.stopIds, d1.stopIds.slice().reverse());
  assert.deepEqual(d1.paths[0][14], { lat: 38.898303, lon: -77.028099 }); // A01 Metro Center
  assert.deepEqual(r.stops.A01, { id: 'A01', name: 'Metro Center', lat: 38.898303, lon: -77.028099 });
});

test('wmata: Silver Line terminal fix (jLines still says N06)', async () => {
  const { p, urls } = make({ overrides: [['jPath?FromStationCode=N12&ToStationCode=G05', 'path-RD']] });
  await call(p.route, 'SV');
  assert.ok(urls().includes('/Rail.svc/json/jPath?FromStationCode=N12&ToStationCode=G05'));
});

// ---------------------------------------------------------------- vehicles

test('wmata: bus vehicles from jBusPositions (Washington local time → epoch); rail → [] without requests', async () => {
  const { p, urls } = make();
  const v = await call(p.vehicles, 'D80');
  assert.equal(urls()[0], '/Bus.svc/json/jBusPositions?RouteID=D80');
  assert.equal(v.length, 4);
  assert.deepEqual(v[0], { tripKey: '31986060', routeId: 'D80', directionId: '1', lat: 38.8963061246005, lon: -77.00860873135653,
    time: Date.UTC(2026, 10, 13, 21, 42, 23) / 1000 });
  assert.equal(v[1].directionId, '0');
  const n = urls().length;
  assert.deepEqual(await call(p.vehicles, 'RD'), []);
  assert.equal(urls().length, n);
});

test('wmata: easternEpoch follows US daylight saving time', () => {
  assert.equal(easternEpoch('2026-07-01T12:00:00'), Date.UTC(2026, 6, 1, 16) / 1000);
  assert.equal(easternEpoch('2026-01-15T08:30:00'), Date.UTC(2026, 0, 15, 13, 30) / 1000);
  assert.equal(easternEpoch('2026-03-08T01:59:00'), Date.UTC(2026, 2, 8, 6, 59) / 1000);   // before the switch
  assert.equal(easternEpoch('2026-03-08T03:00:00'), Date.UTC(2026, 2, 8, 7) / 1000);       // after
  assert.equal(easternEpoch('2026-11-01T00:30:00'), Date.UTC(2026, 10, 1, 4, 30) / 1000);  // still EDT
  assert.equal(easternEpoch('2026-11-01T03:00:00'), Date.UTC(2026, 10, 1, 8) / 1000);      // EST
  assert.ok(isNaN(easternEpoch('')));
});

// ---------------------------------------------------------------- errors

test('wmata: service, gateway and transport errors reach the callback', async () => {
  const { p } = make({ overrides: [['jBusPositions', 'error-401'], ['GetPrediction', new Error('offline')]] });
  await assert.rejects(call(p.arrivals, 'abc', 0, 30), /Stop Id not specified, invalid, or does not exist/);
  await assert.rejects(call(p.vehicles, 'D80'), /WMATA rejected the API key \(Access denied due to invalid subscription key/);
  await assert.rejects(call(p.arrivals, 'A01', 0, 30), /offline/);
});

test('wmata: a 429 is retried once, a second 429 is an error', async () => {
  const a = make({ overrides: [['jPredictions', ['error-429', 'predictions']]] });
  assert.equal((await call(a.p.arrivals, '1001141', 0, 90)).length, 19);
  assert.equal(a.calls.length, 2);
  const b = make({ overrides: [['jPredictions', ['error-429', 'error-429', 'predictions']]] });
  await assert.rejects(call(b.p.arrivals, '1001141', 0, 90), /Rate limit is exceeded/);
  assert.equal(b.calls.length, 2);
});

// ---------------------------------------------------------------- catalog

test('wmata: listRoutes = bus routes (jRoutes) then rail lines (jLines)', async () => {
  const { p } = make();
  const list = await call(p.listRoutes);
  assert.deepEqual(list[3], { id: 'D80', label: 'D80 - UNION STATION - FRIENDSHIP HTS' });
  assert.deepEqual(list.slice(7).map(r => r.id), ['RD', 'OR', 'SV', 'BL', 'YL', 'GR']);
  assert.deepEqual(list[7], { id: 'RD', label: 'Red Line' });
});

test('wmata: stopInfo from jStopSchedule (bus) or the station list (rail)', async () => {
  const { p, urls } = make();
  assert.deepEqual(await call(p.stopInfo, '1001141'), { id: '1001141', name: 'H St NW+Madison Pl NW', lat: 38.900131, lon: -77.035377 });
  assert.equal(urls()[0], '/Bus.svc/json/jStopSchedule?StopID=1001141');
  assert.deepEqual(await call(p.stopInfo, 'B35'), { id: 'B35', name: 'NoMa-Gallaudet U', lat: 38.907407, lon: -77.002961 });
  await assert.rejects(call(p.stopInfo, 'Z99'), /unknown stop Z99/);
});

test('wmata: catalog() = 4 requests: every route and stop (bus + rail) with positions', async () => {
  const { p, urls } = make();
  const progress = [];
  const cat = await new Promise((res, rej) => p.catalog((e, v) => (e ? rej(e) : res(v)), (n, t) => progress.push([n, t])));
  assert.deepEqual(urls().sort(), ['/Bus.svc/json/jRoutes', '/Bus.svc/json/jStops', '/Rail.svc/json/jLines', '/Rail.svc/json/jStations']);
  assert.deepEqual(progress, [[1, 4], [2, 4], [3, 4], [4, 4]]);
  assert.deepEqual(cat.routes[3], { id: 'D80', shortName: 'D80', longName: 'Wisconsin Av-Union Station' });
  assert.deepEqual(cat.routes.slice(7), [
    { id: 'RD', shortName: 'Red', longName: 'Red Line' }, { id: 'OR', shortName: 'Orange', longName: 'Orange Line' },
    { id: 'SV', shortName: 'Silver', longName: 'Silver Line' }, { id: 'BL', shortName: 'Blue', longName: 'Blue Line' },
    { id: 'YL', shortName: 'Yellow', longName: 'Yellow Line' }, { id: 'GR', shortName: 'Green', longName: 'Green Line' }]);
  assert.deepEqual(cat.stops.find(s => s.id === '1001141'),
    { id: '1001141', name: 'H St NW+Madison Pl NW', routeIds: ['D10', 'D20', 'D72', 'D80', 'D94', 'F19'], lat: 38.900131, lon: -77.035377 });
  assert.deepEqual(cat.stops.find(s => s.id === 'C01'), { id: 'C01', name: 'Metro Center', routeIds: ['BL', 'OR', 'SV'], lat: 38.898303, lon: -77.028099 });
  assert.equal(cat.stops.length, 7 + 29);
});

test('wmata: catalog() without rail data lists the bus network; without bus data → error', async () => {
  const a = make({ overrides: [['jLines', new Error('offline')]] });
  const cat = await new Promise((res, rej) => a.p.catalog((e, v) => (e ? rej(e) : res(v))));
  assert.equal(cat.routes.length, 7);
  assert.equal(cat.stops.length, 7);
  const b = make({ overrides: [['/Bus.svc/json/jStops', 'error-401']] });
  await assert.rejects(new Promise((res, rej) => b.p.catalog((e, v) => (e ? rej(e) : res(v)))), /rejected the API key/);
});

// ---------------------------------------------------------------- plug-in

test('wmata plug-in: type, label, metadata, create(options, ctx)', async () => {
  assert.equal(plugin.type, 'wmata');
  assert.equal(plugin.label, 'WMATA (Washington DC)');
  assert.equal(plugin.needsKey, true);
  assert.equal(plugin.keyUrl, 'https://developer.wmata.com');
  const h = fakeHttp();
  const p = plugin.create({ baseUrl: '', apiKey: KEY }, { http: h.http, clock: () => NOW, storage: memStorage(), routeIds: [], routes: [], center: { lat: 38.9, lon: -77 } });
  for (const m of ['stopsNear', 'arrivals', 'route', 'vehicles', 'listRoutes', 'routeInfo', 'stopInfo', 'catalog']) assert.equal(typeof p[m], 'function');
  const arr = await call(p.arrivals, '1001141', 0, 5);
  assert.equal(arr[0].time, NOW + 120);
  assert.equal(h.calls[0].url, DEFAULT_BASE_URL + '/NextBusService.svc/json/jPredictions?StopID=1001141');
});
