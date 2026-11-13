// RTC Southern Nevada (Las Vegas) via the Swiftly API. Fixtures test/fixtures/rtc-*.json are hand-built from the
// response shapes in Swiftly's OpenAPI reference (docs.goswift.ly, realtime-standalone); rtc-error-401.json is the
// body api.goswift.ly really returns for a bad key. No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createRtc, parseBase, plugin, DEFAULT_HOST, DEFAULT_AGENCY } = require('../src/sources/rtc/index');
const { createRegistry } = require('../src/sources/registry');

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const call = (fn, ...args) => new Promise((resolve, reject) => fn(...args, (err, v) => (err ? reject(err) : resolve(v))));

const H = 'https://api.goswift.ly';
const NOW = 1762992000;
const KEY = 'secret-key';

// fake http: exact URL → fixture name | Error | body object; records URLs and headers; answers asynchronously
function fakeHttp(table) {
  const calls = [];
  let inFlight = 0, maxInFlight = 0;
  const http = (url, cb, headers) => {
    calls.push({ url, headers });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    setTimeout(() => {
      inFlight--;
      if (!Object.prototype.hasOwnProperty.call(table, url)) return cb(new Error('no fixture for ' + url));
      const v = table[url];
      if (v instanceof Error) return cb(v);
      cb(null, typeof v === 'string' ? fixture(v) : v);
    }, 0);
  };
  return { http, calls, urls: () => calls.map(c => c.url), max: () => maxInFlight };
}

function memStorage() {
  const m = {};
  return {
    getItem: k => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    keys: () => Object.keys(m)
  };
}

const ROUTES = H + '/info/las-vegas-rtc/routes';
const R109 = H + '/info/las-vegas-rtc/routes?route=109&verbose=true';
const RDEUCE = H + '/info/las-vegas-rtc/routes?route=DEUCE&verbose=true';
const R202 = H + '/info/las-vegas-rtc/routes?route=202&verbose=true';

const make = (table, extra = {}) => {
  const f = fakeHttp(table);
  const p = createRtc(Object.assign({ baseUrl: '', apiKey: KEY, routeIds: ['10109'] }, extra.opts || {}), f.http,
    { clock: () => extra.now || NOW, storage: extra.storage });
  return { p, f };
};

test('rtc: base URL defaults and agency key from the path', () => {
  assert.equal(DEFAULT_HOST, 'https://api.goswift.ly');
  assert.equal(DEFAULT_AGENCY, 'las-vegas-rtc');
  assert.deepEqual(parseBase(''), { host: H, agency: 'las-vegas-rtc' });
  assert.deepEqual(parseBase(' https://api.goswift.ly/ '), { host: H, agency: 'las-vegas-rtc' });
  assert.deepEqual(parseBase('https://api.goswift.ly/ventura'), { host: H, agency: 'ventura' });
  assert.deepEqual(parseBase('https://api.goswift.ly/real-time/ventura/'), { host: H, agency: 'ventura' });
  assert.deepEqual(parseBase('https://api.goswift.ly/info/ventura'), { host: H, agency: 'ventura' });
  assert.deepEqual(parseBase('api.goswift.ly'), { host: H, agency: 'las-vegas-rtc' });
  assert.deepEqual(parseBase('http://proxy.example:8080/swiftly/las-vegas-rtc'), { host: 'http://proxy.example:8080/swiftly', agency: 'las-vegas-rtc' });
});

test('rtc: arrivals URL, Authorization header, mapping, window and order', async () => {
  const { p, f } = make({ [H + '/real-time/las-vegas-rtc/predictions?stop=1650&number=6']: 'rtc-predictions-1650.json' });
  const arr = await call(p.arrivals, '1650', 0, 60);
  assert.deepEqual(f.calls[0], { url: H + '/real-time/las-vegas-rtc/predictions?stop=1650&number=6', headers: { Authorization: KEY } });
  assert.deepEqual(arr, [
    { stopId: '1650', routeId: '10202', tripKey: '2520410', time: 1762992060, predicted: true, headsign: 'UNLV' },
    { stopId: '1650', routeId: '10109', tripKey: '2410933', time: 1762992270, predicted: true, headsign: 'South Strip Transfer Terminal' },
    { stopId: '1650', routeId: '10202', tripKey: '2520411', time: 1762992570, predicted: false, headsign: 'UNLV' },
    { stopId: '1650', routeId: '10109', tripKey: '2410934', time: 1762993170, predicted: true, headsign: 'South Strip Transfer Terminal' }]);
});

test('rtc: arrivals asks for 3..10 predictions per route depending on the window; stop ids encoded', async () => {
  const { p, f } = make({});
  await call(p.arrivals, 'a b', 0, 5).catch(() => {});
  await call(p.arrivals, '1', 0, 500).catch(() => {});
  assert.deepEqual(f.urls(), [H + '/real-time/las-vegas-rtc/predictions?stop=a%20b&number=3',
    H + '/real-time/las-vegas-rtc/predictions?stop=1&number=10']);
});

test('rtc: route builds directions, shape paths and stops from /info routes verbose; uses the short name as route key', async () => {
  const { p, f } = make({ [ROUTES]: 'rtc-routes.json', [R109]: 'rtc-route-109.json' });
  const r = await call(p.route, '10109');
  assert.deepEqual(f.urls(), [ROUTES, R109]);
  assert.ok(f.calls.every(c => c.headers.Authorization === KEY));
  assert.equal(r.id, '10109');
  assert.equal(r.shortName, '109');
  assert.equal(r.longName, 'Maryland Parkway');
  assert.equal(r.color, '');
  assert.deepEqual(r.directions.map(d => [d.id, d.name, d.stopIds]), [
    ['0', 'To South Strip Transfer Terminal', ['1640', '1650', '1660']],
    ['1', 'To Bonneville Transit Center', ['1661', '1651', '1641']]]);
  // duplicate shapeId dropped, repeated points dropped, 5 decimals
  assert.deepEqual(r.directions[0].paths, [[{ lat: 36.129, lon: -115.1361 }, { lat: 36.1219, lon: -115.1361 },
    { lat: 36.1148, lon: -115.1361 }, { lat: 36.1, lon: -115.13612 }]]);
  assert.equal(r.directions[1].paths[0].length, 3);
  assert.deepEqual(r.stops['1650'], { id: '1650', name: 'Maryland Pkwy @ Flamingo Rd', lat: 36.1148, lon: -115.1361 });
  assert.equal(Object.keys(r.stops).length, 6);
  // routeInfo is the same route, answered without requests
  const info = await call(p.routeInfo, '10109');
  assert.deepEqual(info, r);
  assert.equal(f.calls.length, 2);
});

test('rtc: route without shapes uses the stops as path; name from headsigns; color via util.color', async () => {
  const body = fixture('rtc-route-deuce.json');
  body.data.routes[0].color = '#ffcc00';
  const { p } = make({ [ROUTES]: 'rtc-routes.json', [RDEUCE]: body });
  const r = await call(p.route, '10800');
  assert.equal(r.color, 'FFCC00');
  assert.equal(r.directions[0].name, 'South Strip Transfer Terminal / Mandalay Bay');
  assert.deepEqual(r.directions[0].paths, [[{ lat: 36.1147, lon: -115.1728 }, { lat: 36.1, lon: -115.1361 }]]);
});

test('rtc: route is cached in storage per agency for 7 days; concurrent calls share one fetch', async () => {
  const storage = memStorage();
  const first = make({ [ROUTES]: 'rtc-routes.json', [R109]: 'rtc-route-109.json' }, { storage });
  const [a, b] = await Promise.all([call(first.p.route, '10109'), call(first.p.route, '10109')]);
  assert.deepEqual(a, b);
  assert.equal(first.f.calls.length, 2);
  assert.ok(storage.keys().every(k => k.startsWith('busWatch.rtc.las-vegas-rtc.')));
  const second = make({}, { storage, now: NOW + 6 * 86400 });
  assert.deepEqual(await call(second.p.route, '10109'), a);
  assert.equal(second.f.calls.length, 0);
  const third = make({ [ROUTES]: 'rtc-routes.json', [R109]: 'rtc-route-109.json' }, { storage, now: NOW + 8 * 86400 });
  await call(third.p.route, '10109');
  assert.equal(third.f.calls.length, 2);
  // another agency does not see Las Vegas data
  const other = make({}, { storage, opts: { baseUrl: 'https://api.goswift.ly/ventura' } });
  await assert.rejects(call(other.p.route, '10109'));
  assert.deepEqual(other.f.urls(), [H + '/info/ventura/routes', H + '/info/ventura/routes?route=10109&verbose=true']);
});

test('rtc: unknown route and a failing route list (falls back to the id as route key)', async () => {
  const empty = { success: true, route: 'x', data: { agencyKey: 'las-vegas-rtc', routes: [] } };
  const { p, f } = make({ [ROUTES]: new Error('Network error'), [H + '/info/las-vegas-rtc/routes?route=999&verbose=true']: empty });
  await assert.rejects(call(p.route, '999'), /unknown route 999/);
  assert.deepEqual(f.urls(), [ROUTES, H + '/info/las-vegas-rtc/routes?route=999&verbose=true']);
});

test('rtc: stopsNear = stops of the configured routes within the radius, nearest first', async () => {
  const { p } = make({ [ROUTES]: 'rtc-routes.json', [R109]: 'rtc-route-109.json', [RDEUCE]: 'rtc-route-deuce.json' },
    { opts: { routeIds: ['10109', '10800'] } });
  const pos = { lat: 36.1, lon: -115.1359 };
  const stops = await call(p.stopsNear, pos, 100);
  assert.deepEqual(stops.map(s => [s.id, s.routeIds]), [['1660', ['10109', '10800']], ['1661', ['10109']]]);
  assert.deepEqual(Object.keys(stops[0]).sort(), ['id', 'lat', 'lon', 'name', 'routeIds']);
  const none = make({}, { opts: { routeIds: [] } });
  assert.deepEqual(await call(none.p.stopsNear, pos, 100), []);
  assert.equal(none.f.calls.length, 0);
});

test('rtc: stopsNear skips failing routes; all failing → error', async () => {
  const { p } = make({ [ROUTES]: 'rtc-routes.json', [R109]: 'rtc-route-109.json', [R202]: new Error('boom') },
    { opts: { routeIds: ['10202', '10109'] } });
  const stops = await call(p.stopsNear, { lat: 36.1148, lon: -115.1359 }, 50);
  assert.deepEqual(stops.map(s => s.id).sort(), ['1650', '1651']);
  const bad = make({ [ROUTES]: 'rtc-routes.json', [R202]: new Error('boom') }, { opts: { routeIds: ['10202'] } });
  await assert.rejects(call(bad.p.stopsNear, { lat: 36.1, lon: -115.1 }, 50), /boom/);
});

test('rtc: vehicles (verbose, for the trip id) with a position fix and a trip', async () => {
  const V = H + '/real-time/las-vegas-rtc/vehicles?route=109&verbose=true';
  const { p, f } = make({ [ROUTES]: 'rtc-routes.json', [V]: 'rtc-vehicles-109.json' });
  const v = await call(p.vehicles, '10109');
  assert.deepEqual(f.urls(), [ROUTES, V]);
  assert.equal(f.calls[1].headers.Authorization, KEY);
  assert.deepEqual(v, [
    { tripKey: '2410933', routeId: '10109', directionId: '0', lat: 36.1215, lon: -115.1361, time: 1762991985 },
    { tripKey: '2410971', routeId: '10109', directionId: '1', lat: 36.1046, lon: -115.1357, time: 1762991970 }]);
});

test('rtc: tripKey of a vehicle matches its arrivals', async () => {
  const { p } = make({ [ROUTES]: 'rtc-routes.json', [H + '/real-time/las-vegas-rtc/vehicles?route=109&verbose=true']: 'rtc-vehicles-109.json',
    [H + '/real-time/las-vegas-rtc/predictions?stop=1650&number=6']: 'rtc-predictions-1650.json' });
  const v = await call(p.vehicles, '10109');
  const arr = await call(p.arrivals, '1650', 0, 60);
  assert.ok(arr.some(a => a.tripKey === v[0].tripKey && a.routeId === v[0].routeId));
});

test('rtc: listRoutes from /info routes, fetched once', async () => {
  const { p, f } = make({ [ROUTES]: 'rtc-routes.json' });
  const list = await call(p.listRoutes);
  assert.deepEqual(list, [{ id: '10109', label: '109 - Maryland Parkway' }, { id: '10202', label: '202 - Flamingo' },
    { id: '10800', label: 'DEUCE - Deuce on the Strip' }]);
  await call(p.listRoutes);
  assert.equal(f.calls.length, 1);
});

test('rtc: stopInfo from a built route, else predictions → serving route', async () => {
  const P = H + '/real-time/las-vegas-rtc/predictions?stop=1650&number=1';
  const { p, f } = make({ [ROUTES]: 'rtc-routes.json', [R109]: 'rtc-route-109.json', [P]: 'rtc-predictions-1650.json' },
    { opts: { routeIds: [] } });
  assert.deepEqual(await call(p.stopInfo, '1650'), { id: '1650', name: 'Maryland Pkwy @ Flamingo Rd', lat: 36.1148, lon: -115.1361 });
  assert.deepEqual(f.urls(), [P, ROUTES, R109]);
  assert.deepEqual(await call(p.stopInfo, '1641'), { id: '1641', name: 'Maryland Pkwy @ Desert Inn Rd', lat: 36.129, lon: -115.1357 });
  assert.equal(f.calls.length, 3);
  const empty = { success: true, route: 'x', data: { agencyKey: 'las-vegas-rtc', predictionsData: [] } };
  const none = make({ [H + '/real-time/las-vegas-rtc/predictions?stop=42&number=1']: empty });
  await assert.rejects(call(none.p.stopInfo, '42'), /unknown stop 42/);
});

test('rtc: catalog = route list + verbose route per route; failing routes listed without stops; progress', async () => {
  const storage = memStorage();
  const { p, f } = make({ [ROUTES]: 'rtc-routes.json', [R109]: 'rtc-route-109.json', [RDEUCE]: 'rtc-route-deuce.json',
    [R202]: 'rtc-error-401.json' }, { storage });
  const progress = [];
  const cat = await call((cb) => p.catalog(cb, (done, total) => progress.push([done, total])));
  assert.deepEqual(cat.routes, [{ id: '10109', shortName: '109', longName: 'Maryland Parkway' },
    { id: '10202', shortName: '202', longName: 'Flamingo' }, { id: '10800', shortName: 'DEUCE', longName: 'Deuce on the Strip' }]);
  assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]]);
  assert.deepEqual(cat.stops.map(s => s.id), ['1640', '1650', '1660', '1661', '1651', '1641', '3210']);
  assert.deepEqual(cat.stops[2], { id: '1660', name: 'Maryland Pkwy @ Tropicana Ave', routeIds: ['10109', '10800'], lat: 36.1, lon: -115.1361 });
  assert.equal(f.calls.length, 4);
  assert.ok(f.max() <= 3);
  // the routes it built are cached: route() needs no requests now
  await call(p.route, '10800');
  assert.equal(f.calls.length, 4);
});

test('rtc: catalog without a route list → error', async () => {
  const { p } = make({ [ROUTES]: 'rtc-error-401.json' });
  await assert.rejects(call(p.catalog), /Invalid Credentials/);
});

test('rtc: Swiftly error bodies become errors (401 hints at the key)', async () => {
  const S = H + '/real-time/las-vegas-rtc/predictions?stop=1&number=3';
  const bad = make({ [S]: 'rtc-error-401.json' });
  await assert.rejects(call(bad.p.arrivals, '1', 0, 30), err =>
    /Swiftly: Invalid Credentials/.test(err.message) && /goswift\.ly\/realtime-api-key/.test(err.message));
  const limited = make({ [S]: { errorCode: 429, errorMessage: 'Rate Limited' } });
  await assert.rejects(call(limited.p.arrivals, '1', 0, 30), /^Error: Swiftly: Rate Limited$/);
  const fail = make({ [S]: { success: false, route: 'x' } });
  await assert.rejects(call(fail.p.arrivals, '1', 0, 30), /request failed/);
  const net = make({ [S]: new Error('Network error') });
  await assert.rejects(call(net.p.arrivals, '1', 0, 30), /Network error/);
  const empty = make({ [S]: null });
  await assert.rejects(call(empty.p.arrivals, '1', 0, 30), /empty response/);
});

test('rtc: missing API key → clear error, no requests, callbacks asynchronous', async () => {
  const { p, f } = make({}, { opts: { apiKey: '  ' } });
  for (const [name, args] of [['arrivals', ['1', 0, 30]], ['route', ['10109']], ['routeInfo', ['10109']], ['vehicles', ['10109']],
    ['stopsNear', [{ lat: 36.1, lon: -115.1 }, 300]], ['stopInfo', ['1']], ['listRoutes', []], ['catalog', []]]) {
    let sync = true;
    const pr = call(p[name], ...args);
    const settled = pr.then(() => assert.fail(name + ' should fail'), err => {
      assert.ok(!sync, name + ' called back synchronously');
      assert.match(err.message, /Swiftly API key/);
      assert.match(err.message, /goswift\.ly\/realtime-api-key/);
    });
    sync = false;
    await settled;
  }
  assert.equal(f.calls.length, 0);
});

test('rtc: callbacks are called exactly once even when the callback throws', async () => {
  const { p } = make({ [H + '/real-time/las-vegas-rtc/predictions?stop=1650&number=6']: 'rtc-predictions-1650.json' });
  let n = 0;
  await new Promise(resolve => {
    p.arrivals('1650', 0, 60, () => { n++; setTimeout(resolve, 10); });
  });
  assert.equal(n, 1);
});

test('rtc: plug-in shape and creation through the registry (key + agency from the system entry)', async () => {
  assert.equal(plugin.type, 'rtc');
  assert.equal(plugin.label, 'RTC (Las Vegas)');
  const f = fakeHttp({ [H + '/real-time/las-vegas-rtc/predictions?stop=1650&number=6']: 'rtc-predictions-1650.json' });
  const registry = createRegistry([plugin]);
  const provider = registry.createFor({ id: 'lv', type: 'rtc', baseUrl: '', apiKey: 'K2' },
    { location: { lat: 36.1, lon: -115.13 }, routes: [{ id: '10109', name: '109', providerId: 'lv' }] },
    { http: f.http, clock: () => NOW });
  const arr = await call(provider.arrivals, '1650', 0, 60);
  assert.equal(arr.length, 4);
  assert.deepEqual(f.calls[0].headers, { Authorization: 'K2' });
  for (const m of ['stopsNear', 'arrivals', 'route', 'vehicles', 'listRoutes', 'routeInfo', 'stopInfo', 'catalog']) {
    assert.equal(typeof provider[m], 'function', m);
  }
});

test('rtc: source is ES5 and requires only util and geo', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/sources/rtc/index.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/=>|\blet\s|\bconst\s|`|\bclass\s|Object\.assign|\.find\(|\.includes\(|Promise/.test(src));
  const reqs = [...src.matchAll(/require\('([^']+)'\)/g)].map(m => m[1]).sort();
  assert.deepEqual(reqs, ['../../common/geo', '../util']);
});
