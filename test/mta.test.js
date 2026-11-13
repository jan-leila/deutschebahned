// MTA Bus Time (New York) plug-in: OBA "where" (static) + SIRI (real time). Hand-built fixtures, fake http, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const geo = require('../src/common/geo');
const { createMta, plugin, parseIso, monitoringRef, DEFAULT_BASE_URL, KEY_URL } = require('../src/sources/mta/index');

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const call = (fn, ...args) => new Promise((resolve, reject) => fn(...args, (err, v) => (err ? reject(err) : resolve(v))));

// 2025-11-12 19:00:00 -05:00
const NOW = 1762992000;
const BASE = 'https://mta.example';

// fake http: records URLs, answers from a route table {substring: fixtureName | Error | {body}}; tracks concurrency
function fakeHttp(routes) {
  const urls = [];
  const stats = { inFlight: 0, max: 0 };
  const http = (url, cb) => {
    urls.push(url);
    stats.inFlight++;
    stats.max = Math.max(stats.max, stats.inFlight);
    const key = Object.keys(routes).find(k => url.includes(k));
    setTimeout(() => {
      stats.inFlight--;
      if (!key) return cb(new Error('no fixture for ' + url));
      const v = routes[key];
      if (v instanceof Error) return cb(v);
      if (v && typeof v === 'object' && 'body' in v) return cb(null, v.body);
      cb(null, fixture(v));
    }, 0);
  };
  return { http, urls, stats };
}

function memStorage() {
  const m = {};
  return {
    getItem: k => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: k => { delete m[k]; },
    keys: () => Object.keys(m)
  };
}

const make = (routes, extra = {}) => {
  const f = fakeHttp(routes);
  const p = createMta({ baseUrl: BASE + '/', apiKey: ' K&1 ', ...extra.opts }, f.http,
    { clock: () => NOW, storage: extra.storage });
  return { p, ...f };
};

// ---------------------------------------------------------------- plug-in, ids, times

test('mta: plug-in shape and defaults', () => {
  assert.equal(plugin.type, 'mta');
  assert.equal(plugin.label, 'MTA Bus Time (New York)');
  assert.equal(DEFAULT_BASE_URL, 'https://bustime-classic.mta.info');
  const urls = [];
  const p = plugin.create({ baseUrl: '', apiKey: 'K' }, { http: (u, cb) => { urls.push(u); setTimeout(() => cb(null, fixture('mta-stop.json')), 0); },
    clock: () => NOW, storage: null, routeIds: [], routes: [], center: { lat: 40.7, lon: -74 } });
  for (const m of ['stopsNear', 'arrivals', 'route', 'vehicles', 'listRoutes', 'routeInfo', 'stopInfo', 'catalog']) {
    assert.equal(typeof p[m], 'function', m);
  }
  return call(p.stopInfo, 'MTA_308209').then(() => {
    assert.equal(urls[0], 'https://bustime-classic.mta.info/api/where/stop/MTA_308209.json?key=K');
  });
});

test('mta: stop ids — app keeps MTA_…, SIRI MonitoringRef is bare', () => {
  assert.equal(monitoringRef('MTA_308209'), '308209');
  assert.equal(monitoringRef('308209'), '308209');
});

test('mta: ISO 8601 times with offsets → epoch seconds', () => {
  assert.equal(parseIso('2025-11-12T19:00:00.000-05:00'), NOW);
  assert.equal(parseIso('2025-11-12T19:00:00-0500'), NOW);
  assert.equal(parseIso('2025-11-13T00:00:00Z'), NOW);
  assert.equal(parseIso('2025-11-13T05:30:00+05:30'), NOW);
  assert.equal(parseIso('2025-11-12T19:00:00.600-05:00'), NOW + 1);
  assert.equal(parseIso(['2025-11-13T00:00:00Z']), NOW);
  assert.ok(Number.isNaN(parseIso('')));
  assert.ok(Number.isNaN(parseIso(undefined)));
  assert.ok(Number.isNaN(parseIso('soon')));
});

// ---------------------------------------------------------------- missing key

test('mta: missing key → clear error naming the sign-up URL, no requests, async', async () => {
  const f = fakeHttp({});
  const p = createMta({ baseUrl: '', apiKey: '  ' }, f.http, { clock: () => NOW });
  for (const [m, args] of [['arrivals', ['MTA_308209', 0, 60]], ['stopsNear', [{ lat: 40.7, lon: -74 }, 300]],
    ['route', ['MTA NYCT_B63']], ['vehicles', ['MTA NYCT_B63']], ['stopInfo', ['MTA_1']], ['listRoutes', []]]) {
    let sync = true;
    const pr = call(p[m], ...args);
    sync = false;
    await assert.rejects(pr, err => {
      assert.ok(err.message.includes(KEY_URL), err.message);
      assert.ok(/API key/.test(err.message));
      return true;
    });
    assert.equal(sync, false);
  }
  await assert.rejects(new Promise((res, rej) => p.catalog((e, v) => (e ? rej(e) : res(v)))), /register\.developer\.obanyc\.com/);
  assert.equal(f.urls.length, 0);
});

// ---------------------------------------------------------------- stopsNear

test('mta: stopsNear uses lat/lon spans, filters to the radius, sorts by distance', async () => {
  const { p, urls } = make({ 'stops-for-location': 'mta-stops-for-location.json' });
  const pos = { lat: 40.6765, lon: -73.9832 };
  const stops = await call(p.stopsNear, pos, 400);
  assert.equal(urls[0], BASE + '/api/where/stops-for-location.json?lat=40.6765&lon=-73.9832&latSpan=0.007186&lonSpan=0.009476&key=K%261');
  assert.deepEqual(stops.map(s => s.id), ['MTA_308209', 'MTA_308214']); // corner of the box dropped
  assert.deepEqual(stops[0], { id: 'MTA_308209', name: '5 AV/UNION ST', lat: 40.67685, lon: -73.983, routeIds: ['MTA NYCT_B63', 'MTA NYCT_B103'] });
  assert.ok(geo.distance(pos, stops[0]) <= geo.distance(pos, stops[1]));
});

// ---------------------------------------------------------------- arrivals (SIRI StopMonitoring)

test('mta: arrivals URL — bare MonitoringRef, version 2, operator, all lines', async () => {
  const { p, urls } = make({ 'stop-monitoring': 'mta-sm-v2.json' });
  await call(p.arrivals, 'MTA_308209', 3, 60);
  assert.equal(urls[0], BASE + '/api/siri/stop-monitoring.json?key=K%261&version=2&OperatorRef=MTA&MonitoringRef=308209&MaximumStopVisits=30');
});

test('mta: arrivals map v2 JSON (arrays), expected vs aimed, window, sorted', async () => {
  const { p } = make({ 'stop-monitoring': 'mta-sm-v2.json' });
  const arr = await call(p.arrivals, 'MTA_308209', 3, 60);
  assert.deepEqual(arr, [
    { stopId: 'MTA_308209', routeId: 'MTA NYCT_B63', tripKey: 'MTA NYCT_JG_D5-Weekday-SDon-110800_B63_601', time: NOW + 270, predicted: true, headsign: 'BAY RIDGE 95 ST STA' },
    { stopId: 'MTA_308209', routeId: 'MTA NYCT_B63', tripKey: 'MTA NYCT_JG_D5-Weekday-SDon-111400_B63_604', time: NOW + 600, predicted: true, headsign: 'BAY RIDGE 95 ST STA' },
    { stopId: 'MTA_308209', routeId: 'MTA NYCT_B103', tripKey: 'MTA NYCT_FP_D5-Weekday-SDon-112000_B103_12', time: NOW + 1200, predicted: false, headsign: 'DOWNTOWN BKLYN' }]);
  // 21:30 is outside the 60 min window; a visit without any time is skipped
  const narrow = await call(p.arrivals, 'MTA_308209', 0, 5);
  assert.deepEqual(narrow.map(a => a.time), [NOW + 270]);
});

test('mta: arrivals tolerate object nesting, string DestinationName, bare StopPointRef, departure-only time', async () => {
  const { p } = make({ 'stop-monitoring': 'mta-sm-object.json' });
  const arr = await call(p.arrivals, 'MTA_308209', 0, 60);
  assert.deepEqual(arr, [
    { stopId: 'MTA_308209', routeId: 'MTA NYCT_B63', tripKey: 'MTA NYCT_JG_OBJ_1', time: NOW + 120, predicted: true, headsign: 'COBBLE HILL COLUMBIA ST' }]);
});

test('mta: arrivals — no visits → []; SIRI errors (any delivery) → Error with the text', async () => {
  let m = make({ 'stop-monitoring': 'mta-sm-empty.json' });
  assert.deepEqual(await call(m.p.arrivals, 'MTA_308209', 0, 60), []);
  m = make({ 'stop-monitoring': 'mta-sm-error-stop.json' });
  await assert.rejects(call(m.p.arrivals, 'MTA_1', 0, 60), /No such stop: MTA_1/);
  // the real answer to a bad key (comes back as a VehicleMonitoringDelivery even for StopMonitoring)
  m = make({ 'stop-monitoring': 'mta-siri-error-key.json' });
  await assert.rejects(call(m.p.arrivals, 'MTA_308209', 0, 60), err =>
    err.message.includes('API key is not authorized.') && err.message.includes(KEY_URL));
  m = make({ 'stop-monitoring': { body: { nope: 1 } } });
  await assert.rejects(call(m.p.arrivals, 'MTA_308209', 0, 60), /bad SIRI response/);
  m = make({ 'stop-monitoring': new Error('Network error') });
  await assert.rejects(call(m.p.arrivals, 'MTA_308209', 0, 60), /Network error/);
});

// ---------------------------------------------------------------- vehicles (SIRI VehicleMonitoring)

test('mta: vehicles always pass an encoded LineRef and map positions', async () => {
  const { p, urls } = make({ 'vehicle-monitoring': 'mta-vm.json' });
  const v = await call(p.vehicles, 'MTA NYCT_B63');
  assert.equal(urls[0], BASE + '/api/siri/vehicle-monitoring.json?key=K%261&version=2&LineRef=MTA%20NYCT_B63');
  assert.deepEqual(v, [
    { tripKey: 'MTA NYCT_JG_D5-Weekday-SDon-111400_B63_604', routeId: 'MTA NYCT_B63', directionId: '0', lat: 40.68, lon: -73.98, time: NOW - 10 },
    { tripKey: 'MTA NYCT_JG_D5-Weekday-SDon-110000_B63_620', routeId: 'MTA NYCT_B63', directionId: '1', lat: 40.655, lon: -73.995, time: NOW - 120 }]);
});

test('mta: vehicles without a route never poll every vehicle', async () => {
  const { p, urls } = make({ 'vehicle-monitoring': 'mta-vm.json' });
  await assert.rejects(call(p.vehicles, ''), /LineRef/);
  await assert.rejects(call(p.vehicles, null), /LineRef/);
  assert.equal(urls.length, 0);
});

test('mta: vehicles — bad key error', async () => {
  const { p } = make({ 'vehicle-monitoring': 'mta-siri-error-key.json' });
  await assert.rejects(call(p.vehicles, 'MTA NYCT_B63'), /not authorized/);
});

// ---------------------------------------------------------------- route / routeInfo

test('mta: route URL (encoded route id, polylines) and mapping', async () => {
  const { p, urls } = make({ 'stops-for-route/MTA%20NYCT_B63': 'mta-stops-for-route-b63.json' });
  const r = await call(p.route, 'MTA NYCT_B63');
  assert.equal(urls[0], BASE + '/api/where/stops-for-route/MTA%20NYCT_B63.json?key=K%261&includePolylines=true&version=2');
  assert.equal(r.id, 'MTA NYCT_B63');
  assert.equal(r.shortName, 'B63');
  assert.equal(r.longName, 'Cobble Hill - Bay Ridge');
  assert.equal(r.color, '00AEEF');
  assert.deepEqual(r.directions.map(d => [d.id, d.name, d.stopIds]), [
    ['0', 'BAY RIDGE 95 ST STA', ['MTA_308209', 'MTA_308214']],
    ['1', 'COBBLE HILL COLUMBIA ST via 5 AV', ['MTA_305423']]]);
  assert.equal(r.directions[0].paths.length, 1);
  assert.equal(r.directions[0].paths[0].length, 2);
  assert.ok(Math.abs(r.directions[0].paths[0][0].lat - 38.5) < 1e-5);
  assert.deepEqual(r.stops.MTA_308214, { id: 'MTA_308214', name: '5 AV/3 ST', lat: 40.6745, lon: -73.9858 });
});

test('mta: route with no stop groups → one direction; "+" in ids is encoded', async () => {
  const { p, urls } = make({ 'stops-for-route/MTA%20NYCT_M15%2B': 'mta-stops-for-route-m15.json' });
  const r = await call(p.route, 'MTA NYCT_M15+');
  assert.ok(urls[0].includes('/stops-for-route/MTA%20NYCT_M15%2B.json?'));
  assert.equal(r.shortName, 'M15-SBS');
  assert.equal(r.longName, 'via 1st Av / 2nd Av');
  assert.deepEqual(r.directions, [{ id: '0', name: '', stopIds: ['MTA_401906', 'MTA_308209'], paths: [] }]);
});

test('mta: route is cached in storage (7 days) and shared between concurrent calls', async () => {
  const storage = memStorage();
  const a = make({ 'stops-for-route': 'mta-stops-for-route-b63.json' }, { storage });
  const [r1, r2] = await Promise.all([call(a.p.route, 'MTA NYCT_B63'), call(a.p.routeInfo, 'MTA NYCT_B63')]);
  assert.equal(a.urls.length, 1);
  assert.deepEqual(r1, r2);
  assert.deepEqual(storage.keys(), ['busWatch.mta.route.MTA NYCT_B63']);
  // a new provider (same storage) answers without requests
  const b = make({}, { storage });
  assert.deepEqual(await call(b.p.route, 'MTA NYCT_B63'), r1);
  assert.equal(b.urls.length, 0);
  // expired after 7 days
  const f = fakeHttp({ 'stops-for-route': 'mta-stops-for-route-b63.json' });
  const c = createMta({ baseUrl: BASE, apiKey: 'K' }, f.http, { clock: () => NOW + 7 * 86400, storage });
  await call(c.route, 'MTA NYCT_B63');
  assert.equal(f.urls.length, 1);
});

test('mta: OBA errors — code != 200, MTA\'s null body for a bad key', async () => {
  let m = make({ 'stops-for-route': 'mta-oba-error.json' });
  await assert.rejects(call(m.p.route, 'MTA NYCT_B63'), err => /permission denied/.test(err.message) && err.message.includes(KEY_URL));
  m = make({ 'stop/': { body: null } });
  await assert.rejects(call(m.p.stopInfo, 'MTA_308209'), err => /API key/.test(err.message) && err.message.includes(KEY_URL));
});

// ---------------------------------------------------------------- stopInfo / listRoutes

test('mta: stopInfo (OBA stop; bare ids get the MTA_ prefix)', async () => {
  const { p, urls } = make({ '/stop/': 'mta-stop.json' });
  assert.deepEqual(await call(p.stopInfo, 'MTA_308209'), { id: 'MTA_308209', name: '5 AV/UNION ST', lat: 40.67685, lon: -73.983 });
  await call(p.stopInfo, '308209');
  assert.equal(urls[0], BASE + '/api/where/stop/MTA_308209.json?key=K%261');
  assert.equal(urls[1], urls[0]);
});

test('mta: listRoutes = routes-for-agency for MTA NYCT and MTABC, fetched once', async () => {
  const { p, urls } = make({ 'routes-for-agency/MTA%20NYCT': 'mta-routes-for-agency-nyct.json', 'routes-for-agency/MTABC': 'mta-routes-for-agency-mtabc.json' });
  const l = await call(p.listRoutes);
  assert.deepEqual(urls, [BASE + '/api/where/routes-for-agency/MTA%20NYCT.json?key=K%261', BASE + '/api/where/routes-for-agency/MTABC.json?key=K%261']);
  assert.deepEqual(l, [
    { id: 'MTA NYCT_B63', label: 'B63 Cobble Hill - Bay Ridge' },
    { id: 'MTA NYCT_M15+', label: 'M15-SBS via 1st Av / 2nd Av' },
    { id: 'MTABC_Q53+', label: 'Q53-SBS Woodside - Rockaway Park' }]);
  await call(p.listRoutes);
  assert.equal(urls.length, 2);
});

test('mta: listRoutes — one agency failing is fine, both failing is an error', async () => {
  let m = make({ 'routes-for-agency/MTABC': 'mta-routes-for-agency-mtabc.json' });
  assert.deepEqual((await call(m.p.listRoutes)).map(r => r.id), ['MTABC_Q53+']);
  m = make({ 'routes-for-agency': 'mta-oba-error.json' });
  await assert.rejects(call(m.p.listRoutes), /permission denied/);
});

// ---------------------------------------------------------------- catalog

test('mta: catalog = agencies → routes-for-agency → stops-for-route (no polylines), ≤3 in flight, progress', async () => {
  const { p, urls, stats } = make({
    'agencies-with-coverage': 'mta-agencies-with-coverage.json',
    'routes-for-agency/MTA%20NYCT': 'mta-routes-for-agency-nyct.json',
    'routes-for-agency/MTABC': 'mta-routes-for-agency-mtabc.json',
    'stops-for-route/MTA%20NYCT_B63': 'mta-stops-for-route-b63.json',
    'stops-for-route/MTA%20NYCT_M15%2B': 'mta-stops-for-route-m15.json'
    // MTABC_Q53+ fails (no fixture): listed without stops
  });
  const progress = [];
  const cat = await new Promise((res, rej) => p.catalog((e, v) => (e ? rej(e) : res(v)), (d, t) => progress.push([d, t])));
  assert.equal(urls[0], BASE + '/api/where/agencies-with-coverage.json?key=K%261');
  assert.ok(urls.includes(BASE + '/api/where/stops-for-route/MTA%20NYCT_B63.json?key=K%261&includePolylines=false&version=2'));
  assert.ok(stats.max <= 3);
  assert.deepEqual(cat.routes, [
    { id: 'MTA NYCT_B63', shortName: 'B63', longName: 'Cobble Hill - Bay Ridge' },
    { id: 'MTA NYCT_M15+', shortName: 'M15-SBS', longName: 'via 1st Av / 2nd Av' },
    { id: 'MTABC_Q53+', shortName: 'Q53-SBS', longName: 'Woodside - Rockaway Park' }]);
  const s = cat.stops.find(x => x.id === 'MTA_308209');
  assert.deepEqual(s, { id: 'MTA_308209', name: '5 AV/UNION ST', lat: 40.67685, lon: -73.983, routeIds: ['MTA NYCT_B63', 'MTA NYCT_M15+'], dir: 'S' });
  assert.equal(cat.stops.length, 4);
  assert.deepEqual(progress[progress.length - 1], [3, 3]);
  assert.equal(progress.length, 3);
});

test('mta: catalog uses stored routes; no agency list → error', async () => {
  const storage = memStorage();
  const a = make({ 'stops-for-route': 'mta-stops-for-route-b63.json' }, { storage });
  await call(a.p.route, 'MTA NYCT_B63');
  const b = make({
    'agencies-with-coverage': 'mta-agencies-with-coverage.json',
    'routes-for-agency/MTA%20NYCT': 'mta-routes-for-agency-nyct.json',
    'stops-for-route/MTA%20NYCT_M15%2B': 'mta-stops-for-route-m15.json'
  }, { storage });
  const cat = await new Promise((res, rej) => b.p.catalog((e, v) => (e ? rej(e) : res(v))));
  assert.ok(!b.urls.some(u => u.includes('stops-for-route/MTA%20NYCT_B63')));
  assert.equal(cat.stops.find(x => x.id === 'MTA_308214').routeIds[0], 'MTA NYCT_B63');
  const c = make({ 'agencies-with-coverage': 'mta-oba-error.json' });
  await assert.rejects(new Promise((res, rej) => c.p.catalog((e, v) => (e ? rej(e) : res(v)))), /permission denied/);
});
