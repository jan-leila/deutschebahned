// MBTA V3 API source (src/sources/mbta). Fixtures test/fixtures/mbta-*.json are real responses (2026-11-13, ~16:51 EST),
// recorded with the exact query strings the source sends; a fake http answers from them (no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const geo = require('../src/common/geo');
const catalogLib = require('../src/common/catalog');
const mbta = require('../src/sources/mbta/index');
const { createRegistry } = require('../src/sources/registry');

const { createMbta, plugin, parseIso, easternOffset, serviceWindow } = mbta;
const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const call = (fn, ...args) => new Promise((resolve, reject) => fn(...args, (err, v) => (err ? reject(err) : resolve(v))));
const NOW = Date.parse('2026-11-13T16:51:00-05:00') / 1000; // 1794606660
const clock = () => NOW;

// fake http: records URLs; routes = {pathPrefix: fixtureName | body object | Error | fn(url) → body}; async answers
function fakeHttp(routes, opts = {}) {
  const urls = [];
  const http = (url, cb) => {
    urls.push(url);
    const p = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const key = Object.keys(routes).find(k => p.endsWith(k) || p.includes(k + '/'));
    const answer = () => {
      if (!key) return cb(new Error('no fixture for ' + url));
      let v = routes[key];
      if (typeof v === 'function') v = v(url);
      if (v instanceof Error) return cb(v);
      cb(null, typeof v === 'string' ? fixture(v) : v);
    };
    if (opts.sync) answer(); else setTimeout(answer, 0);
  };
  return { http, urls };
}

const LIVE = {
  '/predictions': 'mbta-predictions.json',
  '/schedules': 'mbta-schedules.json',
  '/route_patterns': 'mbta-route-patterns.json',
  '/vehicles': 'mbta-vehicles.json',
  '/stops': 'mbta-stop-70042.json',
  '/routes': 'mbta-routes.json'
};

function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m };
}

const hhmm = t => new Date((t - 5 * 3600) * 1000).toISOString().slice(11, 19); // EST wall clock of epoch s

// ---------------------------------------------------------------- time helpers

test('mbta: parseIso handles offsets, Z, fractions and agrees with Date.parse', () => {
  assert.equal(parseIso('2026-11-13T16:51:00-05:00'), NOW);
  assert.equal(parseIso('2026-11-13T21:51:00Z'), NOW);
  assert.equal(parseIso('2026-11-13T21:51:00.250Z'), NOW);
  assert.equal(parseIso('2026-11-13T17:51:00-0400'), NOW);
  assert.equal(parseIso('2026-07-01T12:00:00-04:00'), Date.UTC(2026, 6, 1, 16) / 1000);
  for (const s of ['2026-11-13T16:52:46-05:00', '2026-03-08T03:30:00-04:00', '2027-01-01T00:00:00-05:00']) {
    assert.equal(parseIso(s), Date.parse(s) / 1000, s);
  }
  // no offset: Boston local time
  assert.equal(parseIso('2026-11-13T16:51'), NOW);
  for (const bad of [null, undefined, '', 'soon', '2026-11-13', 1794606660]) assert.ok(Number.isNaN(parseIso(bad)), String(bad));
});

test('mbta: easternOffset follows US daylight saving time', () => {
  const at = s => easternOffset(Date.parse(s) / 1000);
  assert.equal(at('2026-01-15T12:00:00Z'), -5);
  assert.equal(at('2026-03-08T06:59:59Z'), -5); // 01:59:59 EST, second Sunday of March
  assert.equal(at('2026-03-08T07:00:00Z'), -4); // 03:00 EDT
  assert.equal(at('2026-07-04T12:00:00Z'), -4);
  assert.equal(at('2026-11-01T05:59:59Z'), -4); // 01:59:59 EDT, first Sunday of November
  assert.equal(at('2026-11-01T06:00:00Z'), -5); // 01:00 EST
  assert.equal(at('2027-03-14T07:00:00Z'), -4);
});

test('mbta: serviceWindow uses the service day (after midnight = 24:xx of the day before)', () => {
  assert.deepEqual(serviceWindow(NOW, NOW + 90 * 60), { date: '2026-11-13', min: '16:51', max: '18:21' });
  assert.deepEqual(serviceWindow(NOW - 30, NOW + 30), { date: '2026-11-13', min: '16:50', max: '16:52' });
  const late = Date.parse('2026-11-13T23:30:00-05:00') / 1000;
  assert.deepEqual(serviceWindow(late, late + 3600), { date: '2026-11-13', min: '23:30', max: '24:30' });
  const night = Date.parse('2026-11-14T01:15:00-05:00') / 1000;
  assert.deepEqual(serviceWindow(night, night + 600), { date: '2026-11-13', min: '25:15', max: '25:25' });
  const summer = Date.parse('2026-07-01T08:00:00-04:00') / 1000;
  assert.deepEqual(serviceWindow(summer, summer + 60), { date: '2026-07-01', min: '08:00', max: '08:01' });
});

// ---------------------------------------------------------------- plug-in, URLs, errors

test('mbta: plug-in shape and options (default base URL, optional key as api_key)', async () => {
  assert.equal(plugin.type, 'mbta');
  assert.equal(plugin.label, 'MBTA (Boston)');
  assert.equal(mbta.DEFAULT_BASE_URL, 'https://api-v3.mbta.com');
  const a = fakeHttp(LIVE);
  const p = plugin.create({ baseUrl: '', apiKey: '' }, { http: a.http, clock, storage: null, routeIds: [], routes: [], center: { lat: 42.36, lon: -71.06 } });
  for (const m of ['stopsNear', 'arrivals', 'route', 'vehicles', 'listRoutes', 'routeInfo', 'stopInfo', 'catalog']) {
    assert.equal(typeof p[m], 'function', m);
  }
  await call(p.stopInfo, '70042');
  assert.equal(a.urls[0], 'https://api-v3.mbta.com/stops/70042?fields[stop]=name,latitude,longitude,platform_name');

  const b = fakeHttp(LIVE);
  const q = plugin.create({ baseUrl: 'https://mbta.example/v3/', apiKey: ' k&1 ' }, { http: b.http, clock, routeIds: [] });
  await call(q.stopInfo, 'place-state');
  assert.equal(b.urls[0], 'https://mbta.example/v3/stops/place-state?fields[stop]=name,latitude,longitude,platform_name&api_key=k%261');
});

test('mbta: the registry builds it from a system entry', async () => {
  const { http, urls } = fakeHttp(LIVE);
  const reg = createRegistry([plugin]);
  const config = { location: { lat: 42.36, lon: -71.06 }, routes: [{ id: 'Blue', name: 'Blue', providerId: 'b' }], providers: [] };
  const p = reg.createFor({ id: 'b', type: 'mbta', baseUrl: '', apiKey: 'KEY' }, config, { http, clock, storage: null });
  await call(p.vehicles, 'Blue');
  assert.match(urls[0], /^https:\/\/api-v3\.mbta\.com\/vehicles\?filter\[route\]=Blue&.*&api_key=KEY$/);
});

test('mbta: JSON:API errors, transport errors and bad bodies reach cb(err)', async () => {
  const p404 = createMbta({}, fakeHttp({ '/stops': 'mbta-error-404.json' }).http, { clock });
  await assert.rejects(call(p404.stopInfo, 'nope'), /MBTA: Resource Not Found \(HTTP 404\)/);
  const p429 = createMbta({}, fakeHttp({ '/vehicles': 'mbta-error-429.json' }).http, { clock });
  await assert.rejects(call(p429.vehicles, 'Red'), /exceeded your allowed usage rate.*\(HTTP 429\)/);
  const p403 = createMbta({ apiKey: 'bad' }, fakeHttp({ '/routes': { errors: [{ code: 'forbidden', status: '403' }] } }).http, { clock });
  await assert.rejects(call(p403.listRoutes), /API key rejected/);
  const pNet = createMbta({}, fakeHttp({ '/routes': new Error('Network error') }).http, { clock });
  await assert.rejects(call(pNet.listRoutes), /Network error/);
  const pBad = createMbta({}, fakeHttp({ '/routes': { jsonapi: {} } }).http, { clock });
  await assert.rejects(call(pBad.listRoutes), /bad response/);
  const pThrow = createMbta({}, () => { throw new Error('boom'); }, { clock });
  await assert.rejects(call(pThrow.listRoutes), /boom/);
});

test('mbta: callbacks are asynchronous even when http answers synchronously', async () => {
  const { http } = fakeHttp(LIVE, { sync: true });
  const p = createMbta({}, http, { clock });
  let sync = true;
  const got = new Promise(resolve => p.stopInfo('70042', (err, s) => resolve({ err, s, sync })));
  sync = false;
  const r = await got;
  assert.equal(r.sync, false);
  assert.deepEqual(r.s, { id: '70042', name: 'State - Wonderland', lat: 42.358978, lon: -71.057598 });
});

// ---------------------------------------------------------------- arrivals

test('mbta: arrivals of one tick share one /predictions and one /schedules request', async () => {
  const { http, urls } = fakeHttp(LIVE);
  const p = createMbta({ apiKey: 'k' }, http, { clock });
  const [blue, bus] = await Promise.all([call(p.arrivals, '70042', 0, 40), call(p.arrivals, '65', 0, 90)]);
  assert.deepEqual(urls, [
    'https://api-v3.mbta.com/predictions?filter[stop]=70042,65&include=trip' +
      '&fields[prediction]=arrival_time,departure_time,schedule_relationship,stop_sequence&fields[trip]=headsign&api_key=k',
    'https://api-v3.mbta.com/schedules?filter[stop]=70042,65&filter[date]=2026-11-13&filter[min_time]=16:51&filter[max_time]=18:21' +
      '&include=trip&fields[schedule]=arrival_time,departure_time,stop_sequence&fields[trip]=headsign&api_key=k'
  ]);
  // departure_time (else arrival_time) as epoch s; trip id as tripKey; trip headsign
  assert.deepEqual(blue[0], { stopId: '70042', routeId: 'Blue', tripKey: '78879293', time: parseIso('2026-11-13T16:52:46-05:00'),
    predicted: true, headsign: 'Wonderland' });
  // predictions first, then scheduled trips later than the last prediction; within [now, now + 40 min], ascending
  assert.deepEqual(blue.map(a => [hhmm(a.time), a.predicted]), [
    ['16:52:46', true], ['16:56:35', true], ['17:00:35', true], ['17:05:35', true], ['17:09:35', true], ['17:13:35', true],
    ['17:18:35', true], ['17:22:35', true], ['17:26:00', false], ['17:31:00', false]]);
  assert.ok(blue.every(a => a.stopId === '70042' && a.time >= NOW && a.time <= NOW + 40 * 60));
  // stop 65 is the first stop of outbound and the last of inbound 354 trips: arrival_time only at the end of a trip
  assert.deepEqual(bus.map(a => [a.tripKey, hhmm(a.time), a.headsign.slice(0, 10)]), [
    ['78258854', '16:55:29', 'Boston via'], ['78258741', '17:05:00', 'Burlington'], ['78258857', '17:22:37', 'Boston via'],
    ['78258855', '17:25:00', 'Burlington'], ['78258748', '17:58:50', 'Boston via']]);
});

test('mbta: scheduled times fill in; cancelled / skipped predictions remove the trip', async () => {
  const preds = fixture('mbta-predictions.json');
  // only the next two Blue Line predictions are left; the second one is cancelled
  const blue = preds.data.filter(x => x.relationships.stop.data.id === '70042').slice(0, 2);
  blue[1] = JSON.parse(JSON.stringify(blue[1]));
  blue[1].attributes.schedule_relationship = 'CANCELLED';
  blue[1].attributes.arrival_time = blue[1].attributes.departure_time = null;
  preds.data = blue;
  const { http } = fakeHttp({ ...LIVE, '/predictions': preds });
  const p = createMbta({}, http, { clock });
  const list = await call(p.arrivals, '70042', 0, 30);
  assert.deepEqual(list.map(a => [a.tripKey, hhmm(a.time), a.predicted]), [
    ['78879293', '16:52:46', true],   // predicted (its 16:52 schedule is not repeated)
    // 78879301 (scheduled 16:56) is cancelled: neither time is shown
    ['78879308', '17:00:00', false], ['78879316', '17:05:00', false], ['78879326', '17:09:00', false],
    ['78879333', '17:13:00', false], ['78879339', '17:18:00', false]]);
});

test('mbta: arrivals survive one failing half; both failing → error for every caller', async () => {
  const onlySched = createMbta({}, fakeHttp({ ...LIVE, '/predictions': new Error('down') }).http, { clock });
  const s = await call(onlySched.arrivals, '70042', 0, 10);
  assert.deepEqual(s.map(a => [hhmm(a.time), a.predicted]), [['16:52:00', false], ['16:56:00', false], ['17:00:00', false]]);
  const onlyPred = createMbta({}, fakeHttp({ ...LIVE, '/schedules': 'mbta-error-429.json' }).http, { clock });
  assert.equal((await call(onlyPred.arrivals, '70042', 0, 10)).length, 3);
  const none = createMbta({}, fakeHttp({ '/predictions': 'mbta-error-429.json', '/schedules': new Error('x') }).http, { clock });
  const results = await Promise.allSettled([call(none.arrivals, '70042', 0, 10), call(none.arrivals, '65', 0, 10)]);
  assert.deepEqual(results.map(r => r.status), ['rejected', 'rejected']);
  assert.match(results[0].reason.message, /429/);
});

test('mbta: a parent station is asked on its own and its platforms\' times are reported under its id', async () => {
  const { http, urls } = fakeHttp(LIVE);
  const p = createMbta({}, http, { clock });
  const [station, platform] = await Promise.all([call(p.arrivals, 'place-state', 0, 20), call(p.arrivals, '70042', 0, 20)]);
  assert.equal(urls.length, 4);
  assert.ok(urls.some(u => u.includes('/predictions?filter[stop]=place-state&')));
  assert.ok(urls.some(u => u.includes('/predictions?filter[stop]=70042&')));
  assert.ok(station.length > 0 && station.every(a => a.stopId === 'place-state'));
  assert.ok(platform.every(a => a.stopId === '70042'));
});

test('mbta: duplicate predictions (a station and its platform in one request) are counted once', async () => {
  const preds = fixture('mbta-predictions.json');
  preds.data = preds.data.concat(preds.data.filter(x => x.relationships.stop.data.id === '70042'));
  const p = createMbta({}, fakeHttp({ ...LIVE, '/predictions': preds }).http, { clock });
  const list = await call(p.arrivals, '70042', 0, 20);
  assert.deepEqual(list.map(a => a.tripKey), ['78879293', '78879301', '78879308', '78879316', '78879326']);
});

// ---------------------------------------------------------------- route, stopsNear, vehicles

test('mbta: route builds directions from the typical route patterns (one batched request)', async () => {
  const { http, urls } = fakeHttp(LIVE);
  const p = createMbta({}, http, { clock });
  const [blue, bus, red] = await Promise.all([call(p.route, 'Blue'), call(p.route, '354'), call(p.route, 'Red')]);
  assert.deepEqual(urls, ['https://api-v3.mbta.com/route_patterns?filter[route]=Blue,354,Red' +
    '&include=route,representative_trip.shape,representative_trip.stops' +
    '&fields[route]=short_name,long_name,color,direction_names,direction_destinations' +
    '&fields[route_pattern]=direction_id,typicality,sort_order&fields[stop]=name,latitude,longitude']);

  assert.equal(blue.id, 'Blue');
  assert.equal(blue.shortName, 'Blue Line');
  assert.equal(blue.longName, '');
  assert.equal(blue.color, '003DA5');
  // compass direction names become 'Westbound' / 'Eastbound'; the typicality-3 patterns are left out
  assert.deepEqual(blue.directions.map(d => [d.id, d.name, d.paths.length]), [['0', 'Westbound', 1], ['1', 'Eastbound', 1]]);
  assert.deepEqual(blue.directions[1].stopIds, ['70038', '70040', '70042', '70044', '70046', '70048', '70050', '70052',
    '70054', '70056', '70058', '70060']);
  assert.deepEqual(blue.stops['70042'], { id: '70042', name: 'State', lat: 42.358978, lon: -71.057598 });
  assert.ok(blue.directions[1].paths[0].length > 100);   // the decoded shape, not just the stops
  assert.ok(geo.distanceToPaths(blue.stops['70042'], blue.directions[1].paths) < 30);

  // other direction names are destinations; two typical patterns in direction 0 → two paths, stops merged
  assert.equal(bus.shortName, '354');
  assert.equal(bus.longName, 'North Burlington - State Street, Boston');
  assert.equal(bus.color, 'FFC72C');
  assert.deepEqual(bus.directions.map(d => [d.id, d.name, d.paths.length]), [['0', 'North Burlington', 2], ['1', 'State Street, Boston', 1]]);
  assert.equal(bus.directions[0].stopIds[0], '65');
  for (const d of bus.directions) for (const id of d.stopIds) assert.ok(bus.stops[id], id);

  // branches: Alewife … JFK/UMass, the Ashmont branch, then the Braintree branch
  const south = red.directions[0];
  assert.equal(south.name, 'Southbound');
  assert.equal(south.paths.length, 2);
  assert.equal(south.stopIds[0], '70061');
  assert.ok(south.stopIds.indexOf('70093') > south.stopIds.indexOf('70083'));   // Ashmont after Andrew
  assert.equal(south.stopIds[south.stopIds.length - 1], '70105');                // Braintree
  assert.equal(new Set(south.stopIds).size, south.stopIds.length);
});

test('mbta: concurrent and repeated route calls share one request; unknown routes fail', async () => {
  const { http, urls } = fakeHttp(LIVE);
  const p = createMbta({}, http, { clock });
  const [a, b] = await Promise.all([call(p.route, 'Blue'), call(p.routeInfo, 'Blue')]);
  assert.equal(a, b);
  await call(p.route, 'Blue');
  assert.equal(urls.length, 1);
  await assert.rejects(call(p.route, 'Purple'), /unknown route Purple/);
});

test('mbta: built routes are kept in storage (7 days, paths as encoded polylines)', async () => {
  const storage = memoryStorage();
  let t = NOW;
  const first = fakeHttp(LIVE);
  const built = await call(createMbta({}, first.http, { clock: () => t, storage }).route, 'Blue');
  const raw = storage.getItem('busWatch.mbta.route.Blue');
  assert.ok(raw);
  assert.equal(typeof JSON.parse(raw).v.directions[0].paths[0], 'string');

  const second = fakeHttp({});
  const cached = await call(createMbta({}, second.http, { clock: () => t, storage }).route, 'Blue');
  assert.equal(second.urls.length, 0);
  assert.deepEqual(cached.stops, built.stops);
  assert.deepEqual(cached.directions.map(d => [d.id, d.name, d.stopIds]), built.directions.map(d => [d.id, d.name, d.stopIds]));
  const pa = cached.directions[0].paths[0], pb = built.directions[0].paths[0];
  assert.equal(pa.length, pb.length);
  assert.ok(pa.every((pt, i) => Math.abs(pt.lat - pb[i].lat) < 1e-5 && Math.abs(pt.lon - pb[i].lon) < 1e-5));

  t = NOW + 7 * 86400;
  const third = fakeHttp(LIVE);
  await call(createMbta({}, third.http, { clock: () => t, storage }).route, 'Blue');
  assert.equal(third.urls.length, 1);
});

test('mbta: stopsNear = stops of the configured routes within the radius, nearest first', async () => {
  const { http, urls } = fakeHttp(LIVE);
  const p = createMbta({ routeIds: ['Blue', '354', 'Red', 'Blue'] }, http, { clock });
  const pos = { lat: 42.3588, lon: -71.0575 };
  const stops = await call(p.stopsNear, pos, 150);
  assert.equal(urls.length, 1);
  assert.deepEqual(stops.map(s => [s.id, s.name, s.routeIds]), [
    ['65', 'State St @ Washington Mall - State St Sta', ['354']], ['70041', 'State', ['Blue']], ['70042', 'State', ['Blue']]]);
  for (let i = 1; i < stops.length; i++) assert.ok(geo.distance(pos, stops[i - 1]) <= geo.distance(pos, stops[i]));
  assert.equal(typeof stops[0].lat, 'number');

  // a stop two configured routes serve lists both
  const q = createMbta({ routeIds: ['Blue', 'Red'] }, fakeHttp({ '/route_patterns': () => {
    const body = fixture('mbta-route-patterns.json');
    const trip = body.included.find(x => x.type === 'trip' && x.relationships.route.data.id === 'Red');
    trip.relationships.stops.data.push({ id: '70042', type: 'stop' });
    return body;
  } }).http, { clock });
  const both = await call(q.stopsNear, { lat: 42.358978, lon: -71.057598 }, 5);
  assert.deepEqual(both.map(s => [s.id, s.routeIds]), [['70041', ['Blue']], ['70042', ['Blue', 'Red']]]); // same position

  assert.deepEqual(await call(createMbta({}, http, { clock }).stopsNear, pos, 200), []);
  await assert.rejects(call(createMbta({ routeIds: ['Blue'] }, fakeHttp({ '/route_patterns': 'mbta-error-429.json' }).http, { clock }).stopsNear, pos, 200), /429/);
});

test('mbta: vehicles of one tick share one request', async () => {
  const { http, urls } = fakeHttp(LIVE);
  const p = createMbta({}, http, { clock });
  const [red, blue, none] = await Promise.all([call(p.vehicles, 'Red'), call(p.vehicles, 'Blue'), call(p.vehicles, 'Orange')]);
  assert.deepEqual(urls, ['https://api-v3.mbta.com/vehicles?filter[route]=Red,Blue,Orange&fields[vehicle]=latitude,longitude,updated_at,direction_id']);
  assert.deepEqual(red[0], { tripKey: '77885848', routeId: 'Red', directionId: '0', lat: 42.35827, lon: -71.06605,
    time: parseIso('2026-11-13T16:50:34-05:00') });
  assert.equal(red.length, 3);
  assert.equal(red[1].tripKey, 'ADDED-1585066972');   // added trips keep the id their predictions use
  assert.deepEqual(blue.map(v => [v.tripKey, v.directionId]), [['78879301', '1'], ['78879350', '0']]);
  assert.deepEqual(none, []);
});

// ---------------------------------------------------------------- catalog

test('mbta: listRoutes, stopInfo', async () => {
  const { http, urls } = fakeHttp(LIVE);
  const p = createMbta({}, http, { clock });
  assert.deepEqual(await call(p.listRoutes), [
    { id: 'Red', label: 'Red Line' }, { id: 'Green-B', label: 'Green Line B' }, { id: 'CR-Fairmount', label: 'Fairmount Line' },
    { id: 'Boat-F1', label: 'Hingham Ferry' }, { id: '1', label: '1 Harvard Square - Nubian Station' }]);
  await call(p.listRoutes);
  assert.deepEqual(urls, ['https://api-v3.mbta.com/routes?fields[route]=short_name,long_name']);
  assert.deepEqual(await call(p.stopInfo, '70042'), { id: '70042', name: 'State - Wonderland', lat: 42.358978, lon: -71.057598 });
});

test('mbta: catalog crawls the whole network in two requests', async () => {
  const { http, urls } = fakeHttp({ '/routes': 'mbta-routes.json', '/route_patterns': 'mbta-catalog-route-patterns.json' });
  const p = createMbta({}, http, { clock });
  const progress = [];
  const data = await call((cb) => p.catalog(cb, (d, t) => progress.push([d, t])));
  assert.deepEqual(urls, ['https://api-v3.mbta.com/routes?fields[route]=short_name,long_name',
    'https://api-v3.mbta.com/route_patterns?include=representative_trip.stops&fields[route_pattern]=direction_id' +
      '&fields[trip]=headsign&fields[stop]=name,latitude,longitude,platform_name']);
  assert.deepEqual(progress, [[1, 2], [2, 2]]);
  assert.deepEqual(data.routes, [
    { id: 'Red', shortName: 'Red Line', longName: '' }, { id: 'Green-B', shortName: 'B', longName: 'Green Line B' },
    { id: 'CR-Fairmount', shortName: 'Fairmount Line', longName: '' }, { id: 'Boat-F1', shortName: 'Hingham Ferry', longName: '' },
    { id: '1', shortName: '1', longName: 'Harvard Square - Nubian Station' }]);
  const byId = Object.fromEntries(data.stops.map(s => [s.id, s]));
  assert.deepEqual(byId['70096'], { id: '70096', name: 'JFK/UMass - Alewife (from Braintree)', routeIds: ['Red'], lat: 42.320434, lon: -71.052215 });
  assert.ok(data.stops.some(s => s.routeIds.includes('1')));
  assert.equal(new Set(data.stops.map(s => s.id)).size, data.stops.length);
  // packs into a search index
  const packed = catalogLib.pack(data, { t: NOW, sig: 'mbta||' });
  const hits = catalogLib.search(catalogLib.unpack(packed), 'jfk alewife', { kind: 'stop' });
  assert.ok(hits.slice(0, 2).some(h => h.id === '70096'));

  const failing = createMbta({}, fakeHttp({ '/routes': 'mbta-routes.json', '/route_patterns': 'mbta-error-429.json' }).http, { clock });
  await assert.rejects(call(failing.catalog), /429/);
});

test('mbta: source is ES5 and requires only util and geo', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/sources/mbta/index.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/=>|\blet\s|\bconst\s|`|\bclass\s|Object\.assign|\.find\(|\.includes\(|Promise|\.\.\./.test(src));
  const reqs = [...src.matchAll(/require\('([^']+)'\)/g)].map(m => m[1]).sort();
  assert.deepEqual(reqs, ['../../common/geo', '../util']);
});
