// BVG / VBB source (src/sources/bvg): URL building and mapping against recorded, trimmed responses of
// https://v6.bvg.transport.rest (test/fixtures/bvg-*.json). No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const geo = require('../src/common/geo');
const { createBvg, routeKey, parseTime, plugin, DEFAULT_BASE_URL } = require('../src/sources/bvg/index');

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const call = (fn, ...args) => new Promise((resolve, reject) => fn(...args, (err, v) => (err ? reject(err) : resolve(v))));
const catalogOf = (p, onProgress) => new Promise((resolve, reject) => p.catalog((err, v) => (err ? reject(err) : resolve(v)), onProgress));

const NOW = 1794606180; // 2026-11-13 22:43 CET, two minutes before the first recorded departure
const clock = () => NOW;
const BASE = 'https://bvg.example';

const TRIP_FIXTURES = {
  '1%7C70501%7C4%7C86%7C13112026': 'bvg-trip-m4-0.json',
  '1%7C70619%7C4%7C86%7C13112026': 'bvg-trip-m4-1.json',
  '1%7C70465%7C3%7C86%7C13112026': 'bvg-trip-m4-2.json',
  '1%7C70566%7C4%7C86%7C13112026': 'bvg-trip-m4-3.json'
};

// fake http: records URLs; routes = [[test(url) | substring, fixtureName | body | Error]] (first match wins)
function fakeHttp(routes) {
  const urls = [];
  const http = (url, cb) => {
    urls.push(url);
    const hit = routes.find(([k]) => (typeof k === 'function' ? k(url) : url.includes(k)));
    setTimeout(() => {
      if (!hit) return cb(new Error('no fixture for ' + url));
      const v = hit[1];
      if (v instanceof Error) return cb(v);
      cb(null, typeof v === 'string' ? fixture(v) : JSON.parse(JSON.stringify(v)));
    }, 0);
  };
  return { http, urls };
}

function networkRoutes(extra = []) {
  const tripRoutes = Object.keys(TRIP_FIXTURES).map(id => ['/trips/' + id + '?', TRIP_FIXTURES[id]]);
  return extra.concat(tripRoutes, [
    ['/trips?', 'bvg-trips-m4.json'],
    ['/locations/nearby', 'bvg-nearby.json'],
    ['/departures', 'bvg-departures.json'],
    ['/radar', 'bvg-radar.json'],
    ['/stops/', 'bvg-stop.json']
  ]);
}

function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m };
}

// ---------------------------------------------------------------- helpers

test('bvg: routeKey scopes ids and merges HAFAS line variants', () => {
  assert.equal(routeKey({ id: 'de-vbb-11000000-tram-m4', name: 'M4', product: 'tram' }), '11000000:tram:M4');
  assert.equal(routeKey({ id: 'de-vbb-11000000-s-bahn-s3-s3-bi', name: 'S3', product: 'suburban' }), '11000000:suburban:S3');
  assert.equal(routeKey({ id: 'de-vbb-11000000-s-bahn-s3-s3-b', name: 'S3', product: 'suburban' }), '11000000:suburban:S3');
  assert.equal(routeKey({ id: 'de-vbb-11000000-tram-m8-808', name: 'M8', product: 'tram' }), '11000000:tram:M8');
  // rail replacement buses are their own route
  assert.equal(routeKey({ id: 'de-vbb-11000000-tram-m4-bus-m4-ev1', name: 'M4', product: 'bus' }), '11000000:bus:M4');
  assert.equal(routeKey({ id: 'de-vbb-12054000-tram-91', name: '91', product: 'tram' }), '12054000:tram:91');
  assert.equal(routeKey({ id: 'fft-2', name: '2', product: 'tram' }), 'fft:tram:2');
  assert.equal(routeKey({ id: 'x', name: '' }), '');
  assert.equal(routeKey(null), '');
});

test('bvg: parseTime reads ISO 8601 with offsets', () => {
  assert.equal(parseTime('2026-11-13T22:45:00+01:00'), Date.parse('2026-11-13T22:45:00+01:00') / 1000);
  assert.equal(parseTime('2026-07-01T08:00:00+02:00'), Date.parse('2026-07-01T06:00:00Z') / 1000);
  assert.equal(parseTime('2026-07-01T06:00Z'), Date.parse('2026-07-01T06:00:00Z') / 1000);
  assert.ok(Number.isNaN(parseTime(null)));
  assert.ok(Number.isNaN(parseTime('yesterday')));
});

test('bvg: plugin type, label and default base URL', () => {
  assert.equal(plugin.type, 'bvg');
  assert.equal(plugin.label, 'BVG (Berlin)');
  assert.equal(DEFAULT_BASE_URL, 'https://v6.bvg.transport.rest');
  const { http, urls } = fakeHttp(networkRoutes());
  const p = plugin.create({ baseUrl: '', apiKey: '' }, { http, clock, storage: null, routeIds: [], routes: [], center: { lat: 52.52, lon: 13.41 } });
  return call(p.stopsNear, { lat: 52.5208, lon: 13.4095 }, 300).then(() => {
    assert.ok(urls[0].startsWith('https://v6.bvg.transport.rest/locations/nearby?'));
  });
});

// ---------------------------------------------------------------- stopsNear

test('bvg: stopsNear URL, mapping, lines → routeIds, nearest first', async () => {
  const { http, urls } = fakeHttp(networkRoutes());
  const p = createBvg({ baseUrl: BASE + '/' }, http, { clock });
  const pos = { lat: 52.5208, lon: 13.4095 };
  const stops = await call(p.stopsNear, pos, 300);
  assert.equal(urls[0], BASE + '/locations/nearby?latitude=52.5208&longitude=13.4095&distance=300&results=100&stops=true&poi=false&linesOfStops=true&pretty=false');
  assert.deepEqual(stops.map(s => s.id), ['900100026', '900100003', '900100024', '900100031']);
  assert.deepEqual(stops[0], { id: '900100026', name: 'S+U Alexanderplatz Bhf/Gontardstr.', lat: 52.52105, lon: 13.411285,
    routeIds: ['11000000:tram:M4', '11000000:tram:M5', '11000000:tram:M6'] });
  // the S-Bahn variants collapse into one route per line
  assert.deepEqual(stops[1].routeIds.filter(id => id.includes('suburban')),
    ['11000000:suburban:S3', '11000000:suburban:S5', '11000000:suburban:S7', '11000000:suburban:S9']);
  for (let i = 1; i < stops.length; i++) assert.ok(geo.distance(pos, stops[i - 1]) <= geo.distance(pos, stops[i]));
});

test('bvg: stopsNear filters by radius and reuses a recent answer for the same spot', async () => {
  const { http, urls } = fakeHttp(networkRoutes());
  const p = createBvg({ baseUrl: BASE }, http, { clock });
  const near = await call(p.stopsNear, { lat: 52.5208, lon: 13.4095 }, 150);
  assert.deepEqual(near.map(s => s.id), ['900100026', '900100003']);
  await call(p.stopsNear, { lat: 52.52081, lon: 13.40951 }, 150);
  assert.equal(urls.length, 1);
});

// ---------------------------------------------------------------- arrivals

test('bvg: arrivals URL, this stop only, times, predicted, headsign, sorted', async () => {
  const { http, urls } = fakeHttp(networkRoutes());
  const p = createBvg({ baseUrl: BASE }, http, { clock });
  const arr = await call(p.arrivals, '900100026', 2, 20);
  assert.equal(urls[0], BASE + '/stops/900100026/departures?when=' + (NOW - 120) + '&duration=22&linesOfStops=false&remarks=false&pretty=false');
  assert.equal(arr.length, 5);
  assert.ok(arr.every(a => a.stopId === '900100026'));
  assert.deepEqual(arr[0], { stopId: '900100026', routeId: '11000000:tram:M4', tripKey: '1|70465|3|86|13112026',
    time: parseTime('2026-11-13T22:45:00+01:00'), predicted: true, headsign: 'S Hackescher Markt' });
  assert.deepEqual(arr.map(a => a.routeId), ['11000000:tram:M4', '11000000:tram:M4', '11000000:tram:M6', '11000000:tram:M6', '11000000:tram:M4']);
  for (let i = 1; i < arr.length; i++) assert.ok(arr[i - 1].time <= arr[i].time);
});

test('bvg: arrivals — scheduled only, cancelled, outside the window, ids encoded', async () => {
  const body = fixture('bvg-departures.json');
  body.departures[0].delay = null;            // no realtime → scheduled
  body.departures[1].cancelled = true;        // cancelled → dropped
  body.departures[1].when = null;
  body.departures[4].when = '2026-11-14T03:00:00+01:00'; // past the window
  const { http, urls } = fakeHttp([['/departures', body]]);
  const p = createBvg({ baseUrl: BASE }, http, { clock });
  const arr = await call(p.arrivals, '900100026', 2, 20);
  assert.deepEqual(arr.map(a => [a.tripKey, a.predicted]), [
    ['1|70465|3|86|13112026', false], ['1|71451|3|86|13112026', true], ['1|71497|4|86|13112026', true]]);
  await call(p.arrivals, 'a b/c', 0, 10).catch(() => {});
  assert.ok(urls[1].startsWith(BASE + '/stops/a%20b%2Fc/departures?'));
});

// ---------------------------------------------------------------- errors

test('bvg: HTTP errors, error bodies and bad bodies → cb(err)', async () => {
  const cases = [
    [new Error('HTTP 503'), /HTTP 503/],
    ['bvg-error-404.json', /location\/stop not found/],
    [{ unexpected: true }, /bad response/]
  ];
  for (const [answer, re] of cases) {
    const { http } = fakeHttp([[() => true, answer]]);
    const p = createBvg({ baseUrl: BASE }, http, { clock });
    await assert.rejects(call(p.arrivals, '123', 0, 10), re);
    await assert.rejects(call(p.route, '11000000:tram:M4'), re);
    await assert.rejects(call(p.stopInfo, '123'), answer instanceof Error ? re : /./);
  }
  const { http } = fakeHttp([[() => true, null]]);
  const p = createBvg({ baseUrl: BASE }, http, { clock });
  await assert.rejects(call(p.stopsNear, { lat: 52.5, lon: 13.4 }, 100), /empty response/);
  await assert.rejects(call(p.route, 'nonsense'), /unknown route/);
});

test('bvg: a throwing http is reported asynchronously', async () => {
  const p = createBvg({ baseUrl: BASE }, () => { throw new Error('boom'); }, { clock });
  let sync = true;
  const done = call(p.arrivals, '1', 0, 10);
  sync = false;
  await assert.rejects(done, /boom/);
  assert.equal(sync, false);
});

// ---------------------------------------------------------------- route

test('bvg: route finds the line trips, one direction per origin→destination pattern, with paths and stops', async () => {
  const { http, urls } = fakeHttp(networkRoutes());
  const p = createBvg({ baseUrl: BASE }, http, { clock });
  const r = await call(p.route, '11000000:tram:M4');
  assert.equal(urls[0], BASE + '/trips?lineName=M4&fromWhen=' + NOW + '&untilWhen=' + (NOW + 1800) +
    '&stopovers=false&remarks=false&subStops=false&entrances=false&pretty=false');
  assert.equal(urls[1], BASE + '/trips/1%7C70501%7C4%7C86%7C13112026?stopovers=true&polyline=true&remarks=false&pretty=false');
  assert.equal(urls.length, 5);
  assert.equal(r.id, '11000000:tram:M4');
  assert.equal(r.shortName, 'M4');
  assert.equal(r.longName, 'Tram: Zingster Str. - S Hackescher Markt');
  assert.equal(r.color, 'BE1414');
  // most frequent pattern first; direction names drop the 'S ' station prefix
  assert.deepEqual(r.directions.map(d => [d.id, d.name, d.stopIds.length]), [
    ['900151003>900100002', 'Hackescher Markt', 24],
    ['900100002>900151003', 'Hohenschönhausen, Zingster Str.', 24],
    ['900152007>900100002', 'Hackescher Markt', 25],
    ['900100002>900152007', 'Falkenberg', 25]]);
  const d = r.directions[3];
  assert.equal(d.stopIds[0], '900100002');
  assert.equal(d.stopIds[2], '900100026');
  assert.equal(d.paths.length, 1);
  assert.ok(d.paths[0].length >= 20);
  assert.deepEqual(Object.keys(d.paths[0][0]).sort(), ['lat', 'lon']);
  // the path follows the stops
  for (const id of d.stopIds) assert.ok(geo.distanceToPaths(r.stops[id], d.paths) < 100, id);
  assert.deepEqual(r.stops['900100026'], { id: '900100026', name: 'S+U Alexanderplatz Bhf/Gontardstr.', lat: 52.52105, lon: 13.411285 });
  for (const dir of r.directions) for (const id of dir.stopIds) assert.ok(r.stops[id], id);
});

test('bvg: route drops patterns contained in a longer one (short turns)', async () => {
  const list = fixture('bvg-trips-m4.json');
  const short = JSON.parse(JSON.stringify(list.trips[0]));
  short.id = 'short'; short.origin.id = '900110003'; short.destination.id = '900100002';
  list.trips.push(short);
  const shortTrip = fixture('bvg-trip-m4-2.json');
  shortTrip.trip.id = 'short';
  shortTrip.trip.origin = shortTrip.trip.stopovers[10].stop;
  shortTrip.trip.stopovers = shortTrip.trip.stopovers.slice(10);
  const { http } = fakeHttp(networkRoutes([['/trips/short?', shortTrip], ['/trips?', list]]));
  const p = createBvg({ baseUrl: BASE }, http, { clock });
  const r = await call(p.route, '11000000:tram:M4');
  assert.equal(r.directions.length, 4);
  assert.ok(!r.directions.some(d => d.id.startsWith('900110003>')));
});

test('bvg: route retries around noon when the line is not running now; no trips → error', async () => {
  const empty = { trips: [], realtimeDataUpdatedAt: NOW };
  const noon = Math.floor(NOW / 86400) * 86400 + 86400 + 11 * 3600;
  const { http, urls } = fakeHttp(networkRoutes([['fromWhen=' + NOW, empty]]));
  const p = createBvg({ baseUrl: BASE }, http, { clock });
  const r = await call(p.route, '11000000:tram:M4');
  assert.equal(r.directions.length, 4);
  assert.ok(urls[1].includes('&fromWhen=' + noon + '&untilWhen=' + (noon + 1800)));

  const none = fakeHttp([['/trips?', empty]]);
  const q = createBvg({ baseUrl: BASE }, none.http, { clock });
  await assert.rejects(call(q.route, '11000000:tram:M4'), /no trips found/);
  // trips of other lines with the same name (another town's M4) are ignored
  const other = fixture('bvg-trips-m4.json');
  for (const t of other.trips) t.line.id = 'de-vbb-12054000-tram-m4';
  const o = fakeHttp([['/trips?', other]]);
  await assert.rejects(call(createBvg({ baseUrl: BASE }, o.http, { clock }).route, '11000000:tram:M4'), /no trips found/);
});

test('bvg: route is cached in storage and shared by concurrent callers', async () => {
  const storage = memoryStorage();
  const a = fakeHttp(networkRoutes());
  const p = createBvg({ baseUrl: BASE }, a.http, { clock, storage });
  const [r1, r2] = await Promise.all([call(p.route, '11000000:tram:M4'), call(p.route, '11000000:tram:M4')]);
  assert.equal(a.urls.length, 5);
  assert.deepEqual(r1, r2);
  assert.ok(storage.m.has('busWatch.bvg.route.11000000:tram:M4'));
  const b = fakeHttp([]);
  const q = createBvg({ baseUrl: BASE }, b.http, { clock, storage });
  assert.deepEqual(await call(q.route, '11000000:tram:M4'), JSON.parse(JSON.stringify(r1)));
  assert.equal(b.urls.length, 0);
  // expired after 7 days
  const c = fakeHttp(networkRoutes());
  const late = createBvg({ baseUrl: BASE }, c.http, { clock: () => NOW + 7 * 86400, storage });
  await call(late.route, '11000000:tram:M4');
  assert.ok(c.urls.length > 0);
});

test('bvg: a failing trip fetch is skipped but the route is not stored', async () => {
  const storage = memoryStorage();
  const { http } = fakeHttp(networkRoutes([['/trips/1%7C70619', new Error('HTTP 500')]]));
  const p = createBvg({ baseUrl: BASE }, http, { clock, storage });
  const r = await call(p.route, '11000000:tram:M4');
  assert.equal(r.directions.length, 3);
  assert.equal(storage.m.size, 0);
});

test('bvg: routeInfo is the route; U-Bahn / S-Bahn get their line colours', async () => {
  const { http } = fakeHttp(networkRoutes());
  const p = createBvg({ baseUrl: BASE }, http, { clock });
  const info = await call(p.routeInfo, '11000000:tram:M4');
  assert.equal(info.shortName, 'M4');
  assert.equal(info.directions.length, 4);
  // colours: line table, product default, none outside Berlin
  const list = fixture('bvg-trips-m4.json');
  for (const t of list.trips) t.line = { id: 'de-vbb-11000000-u-bahn-u2', name: 'U2', product: 'subway' };
  const trips = Object.keys(TRIP_FIXTURES).map(id => {
    const f = fixture(TRIP_FIXTURES[id]);
    f.trip.line = { id: 'de-vbb-11000000-u-bahn-u2', name: 'U2', product: 'subway' };
    return ['/trips/' + id + '?', f];
  });
  const u = fakeHttp(trips.concat([['/trips?', list]]));
  const r = await call(createBvg({ baseUrl: BASE }, u.http, { clock }).route, '11000000:subway:U2');
  assert.equal(r.color, 'DA421E');
  assert.equal(r.longName, 'U-Bahn: Zingster Str. - S Hackescher Markt');
});

// ---------------------------------------------------------------- vehicles

test('bvg: vehicles = radar over the route bounding box, this line only, direction by headsign / path', async () => {
  const { http, urls } = fakeHttp(networkRoutes());
  const p = createBvg({ baseUrl: BASE }, http, { clock });
  const r = await call(p.route, '11000000:tram:M4');
  const v = await call(p.vehicles, '11000000:tram:M4');
  const radarUrl = urls[urls.length - 1];
  assert.match(radarUrl, /^https:\/\/bvg\.example\/radar\?north=[\d.]+&west=[\d.]+&south=[\d.]+&east=[\d.]+&results=256&duration=30&frames=1&polylines=false&pretty=false$/);
  const q = new URL(radarUrl).searchParams;
  for (const s of Object.values(r.stops)) {
    assert.ok(s.lat < +q.get('north') && s.lat > +q.get('south') && s.lon < +q.get('east') && s.lon > +q.get('west'));
  }
  const radar = fixture('bvg-radar.json');
  assert.equal(v.length, 3);
  assert.deepEqual(v[0], { tripKey: '1|70566|5|86|13112026', routeId: '11000000:tram:M4', directionId: '900100002>900152007',
    lat: 52.522371, lon: 13.41498, time: radar.realtimeDataUpdatedAt });
  // two directions are named 'Hackescher Markt': the nearer path decides
  for (const x of v.slice(1)) assert.ok(['900151003>900100002', '900152007>900100002'].includes(x.directionId));
});

// ---------------------------------------------------------------- stopInfo / listRoutes / catalog

test('bvg: stopInfo from /stops/:id, or from a stop already seen', async () => {
  const { http, urls } = fakeHttp(networkRoutes());
  const p = createBvg({ baseUrl: BASE }, http, { clock });
  assert.deepEqual(await call(p.stopInfo, '900100026'), { id: '900100026', name: 'S+U Alexanderplatz Bhf/Gontardstr.', lat: 52.52105, lon: 13.411285 });
  assert.equal(urls[0], BASE + '/stops/900100026?linesOfStops=false&pretty=false');
  await call(p.stopsNear, { lat: 52.5208, lon: 13.4095 }, 300);
  assert.deepEqual(await call(p.stopInfo, '900100031'), { id: '900100031', name: 'S+U Alexanderplatz Bhf/Memhardstr.', lat: 52.522937, lon: 13.410755 });
  assert.equal(urls.length, 2);
});

test('bvg: listRoutes = lines around the map centre', async () => {
  const { http, urls } = fakeHttp(networkRoutes());
  const p = createBvg({ baseUrl: BASE, center: { lat: 52.5208, lon: 13.4095 } }, http, { clock });
  const list = await call(p.listRoutes);
  assert.equal(urls[0], BASE + '/locations/nearby?latitude=52.5208&longitude=13.4095&distance=15000&results=1000&stops=true&poi=false&linesOfStops=true&pretty=false');
  assert.deepEqual(list.slice(0, 3), [
    { id: '11000000:tram:M4', label: 'M4 Tram' }, { id: '11000000:tram:M5', label: 'M5 Tram' }, { id: '11000000:tram:M6', label: 'M6 Tram' }]);
  assert.ok(list.some(r => r.id === '11000000:subway:U2' && r.label === 'U2 U-Bahn'));
  assert.equal(new Set(list.map(r => r.id)).size, list.length);
  const none = createBvg({ baseUrl: BASE }, http, { clock });
  await assert.rejects(call(none.listRoutes), /no map centre/);
});

test('bvg: catalog = 7 nearby tiles around the centre, merged, with progress', async () => {
  const { http, urls } = fakeHttp(networkRoutes());
  const p = createBvg({ baseUrl: BASE, center: { lat: 52.5208, lon: 13.4095 } }, http, { clock });
  const progress = [];
  const c = await catalogOf(p, (done, total) => progress.push([done, total]));
  assert.equal(urls.length, 7);
  assert.ok(urls.every(u => u.includes('/locations/nearby?') && u.includes('&distance=15000&results=1000&') && u.includes('linesOfStops=true')));
  assert.deepEqual(progress.map(x => x[1]), [7, 7, 7, 7, 7, 7, 7]);
  assert.deepEqual(progress[6], [7, 7]);
  // the outer tiles are 12 km from the centre
  const q = new URL(urls[1]).searchParams;
  assert.ok(Math.abs(geo.distance({ lat: 52.5208, lon: 13.4095 }, { lat: +q.get('latitude'), lon: +q.get('longitude') }) - 12000) < 50);
  // every tile answered with the same stops here: merged by id
  assert.equal(c.stops.length, 4);
  assert.deepEqual(c.stops[0], { id: '900100026', name: 'S+U Alexanderplatz Bhf/Gontardstr.', routeIds: ['11000000:tram:M4', '11000000:tram:M5', '11000000:tram:M6'],
    lat: 52.52105, lon: 13.411285 });
  assert.deepEqual(c.routes[0], { id: '11000000:tram:M4', shortName: 'M4', longName: 'Tram' });
  assert.ok(c.routes.some(r => r.id === '11000000:suburban:S3' && r.longName === 'S-Bahn'));
  const ids = new Set(c.routes.map(r => r.id));
  assert.equal(ids.size, c.routes.length);
  for (const s of c.stops) for (const id of s.routeIds) assert.ok(ids.has(id), id);
});

test('bvg: catalog skips failing tiles; all failing or no centre → error', async () => {
  let n = 0;
  const some = fakeHttp([[() => n++ % 2 === 0, new Error('HTTP 429')], ['/locations/nearby', 'bvg-nearby.json']]);
  const c = await catalogOf(createBvg({ baseUrl: BASE, center: { lat: 52.52, lon: 13.41 } }, some.http, { clock }));
  assert.equal(c.stops.length, 4);
  const all = fakeHttp([[() => true, new Error('HTTP 429')]]);
  await assert.rejects(catalogOf(createBvg({ baseUrl: BASE, center: { lat: 52.52, lon: 13.41 } }, all.http, { clock })), /HTTP 429/);
  await assert.rejects(catalogOf(createBvg({ baseUrl: BASE }, all.http, { clock })), /no map centre/);
});

test('bvg: at most 3 requests in flight', async () => {
  let inFlight = 0, max = 0;
  const base = fakeHttp(networkRoutes());
  const http = (url, cb) => {
    inFlight++; max = Math.max(max, inFlight);
    base.http(url, (e, v) => { inFlight--; cb(e, v); });
  };
  await catalogOf(createBvg({ baseUrl: BASE, center: { lat: 52.52, lon: 13.41 } }, http, { clock }));
  assert.equal(max, 3);
});
