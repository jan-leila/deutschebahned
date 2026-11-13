// CTA Bus Tracker v3 source (src/sources/cta). Fixtures test/fixtures/cta-*.json are hand-built from the documented
// JSON shapes (Bus Tracker API documentation v3, rev. 2025-04-21); no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createCta, chicagoTime, plugin, DEFAULT_BASE_URL } = require('../src/sources/cta/index');
const { createRegistry } = require('../src/sources/registry');

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const call = (fn, ...args) => new Promise((resolve, reject) => fn(...args, (err, v) => (err ? reject(err) : resolve(v))));

const BASE = 'https://bt.example/bustime/api/v3';
const NOW = 1768334400; // 2026-01-13 14:00 CST (20:00 UTC)

// fake http: records URLs; answer(url) → fixture name | Error | object | undefined (→ "no fixture")
function fakeHttp(answer) {
  const urls = [];
  const http = (url, cb) => {
    urls.push(url);
    const v = answer(url);
    setTimeout(() => {
      if (v === undefined) return cb(new Error('no fixture for ' + url));
      if (v instanceof Error) return cb(v);
      cb(null, typeof v === 'string' ? fixture(v) : v);
    }, 0);
  };
  return { http, urls };
}

function standard(url) {
  if (url.includes('/getroutes?')) return 'cta-getroutes.json';
  if (url.includes('/getpatterns?') && url.endsWith('&rt=20')) return 'cta-getpatterns-20.json';
  if (url.includes('/getpatterns?') && url.endsWith('&rt=9')) return 'cta-getpatterns-9.json';
  if (url.includes('/getpredictions?')) return 'cta-getpredictions.json';
  if (url.includes('/getvehicles?')) return 'cta-getvehicles.json';
  if (url.includes('/getstops?')) return 'cta-getstops-stpid.json';
  return undefined;
}

function memStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), map: m };
}

function make(opts = {}, answer = standard) {
  const f = fakeHttp(answer);
  let now = opts.now || NOW;
  const p = createCta({ baseUrl: BASE, apiKey: 'K&1', routeIds: opts.routeIds || ['20', '9'] }, f.http,
    { clock: () => now, storage: opts.storage });
  return { p, urls: f.urls, setNow: t => { now = t; } };
}

// ---------------------------------------------------------------- time conversion

test('cta: Chicago wall time → epoch seconds, DST aware, independent of the process time zone', () => {
  const saved = process.env.TZ;
  try {
    for (const tz of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles']) {
      process.env.TZ = tz;
      assert.equal(chicagoTime('20260113 14:00'), NOW);                           // CST = UTC-6
      assert.equal(chicagoTime('20260113 14:05:30'), NOW + 330);                  // seconds (tmres=s)
      assert.equal(chicagoTime('20260715 12:00'), Date.UTC(2026, 6, 15, 17) / 1000); // CDT = UTC-5
      // DST starts Sunday 2026-03-08 02:00 CST: 01:59 CST and 03:00 CDT are one minute apart
      assert.equal(chicagoTime('20260308 01:59'), Date.UTC(2026, 2, 8, 7, 59) / 1000);
      assert.equal(chicagoTime('20260308 03:00'), Date.UTC(2026, 2, 8, 8, 0) / 1000);
      assert.equal(chicagoTime('20260308 02:30'), Date.UTC(2026, 2, 8, 8, 30) / 1000); // skipped hour: read as CST
      // DST ends Sunday 2026-11-01 02:00 CDT: 01:30 happens twice — nearest to the reference wins
      const first = Date.UTC(2026, 10, 1, 6, 30) / 1000;
      assert.equal(chicagoTime('20261101 01:30'), first);
      assert.equal(chicagoTime('20261101 01:30', first - 600), first);
      assert.equal(chicagoTime('20261101 01:30', first + 3600), first + 3600);
      assert.equal(chicagoTime('20261101 02:00'), Date.UTC(2026, 10, 1, 8) / 1000);
      assert.equal(chicagoTime('20261101 00:59'), Date.UTC(2026, 10, 1, 5, 59) / 1000);
      // 2027: second Sunday of March is the 14th, first Sunday of November the 7th
      assert.equal(chicagoTime('20270313 12:00'), Date.UTC(2027, 2, 13, 18) / 1000);
      assert.equal(chicagoTime('20270314 12:00'), Date.UTC(2027, 2, 14, 17) / 1000);
      assert.equal(chicagoTime('20271106 12:00'), Date.UTC(2027, 10, 6, 17) / 1000);
      assert.equal(chicagoTime('20271107 12:00'), Date.UTC(2027, 10, 7, 18) / 1000);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
  assert.equal(chicagoTime('1768334400000'), NOW); // unixTime=true form (ms)
  assert.ok(Number.isNaN(chicagoTime('soon')));
});

// ---------------------------------------------------------------- key / errors

test('cta: missing API key → clear error from every method, asynchronously, no requests', async () => {
  const f = fakeHttp(standard);
  const p = createCta({ baseUrl: '', apiKey: '  ', routeIds: ['20'] }, f.http, { clock: () => NOW });
  let sync = true;
  p.arrivals('457', 0, 60, () => assert.equal(sync, false));
  sync = false;
  const calls = [
    call(p.arrivals, '457', 0, 60), call(p.route, '20'), call(p.stopsNear, { lat: 41.88, lon: -87.66 }, 300),
    call(p.vehicles, '20'), call(p.listRoutes), call(p.routeInfo, '20'), call(p.stopInfo, '457'), call(p.catalog)];
  for (const c of calls) await assert.rejects(c, /API key/);
  assert.equal(f.urls.length, 0);
});

test('cta: a bustime-response error without an item id fails the call (bad key, daily limit)', async () => {
  const { p } = make({}, () => 'cta-error-key.json');
  await assert.rejects(call(p.arrivals, '457', 0, 60), /Invalid API access key supplied/);
  await assert.rejects(call(p.route, '20'), /Invalid API access key supplied/);
  await assert.rejects(call(p.vehicles, '20'), /Invalid API access key supplied/);
  await assert.rejects(call(p.listRoutes), /Invalid API access key supplied/);
  const limit = make({}, () => ({ 'bustime-response': { error: [{ msg: 'Transaction limit for current day has been exceeded.' }] } }));
  await assert.rejects(call(limit.p.arrivals, '1', 0, 60), /Transaction limit/);
  const bad = make({}, () => ({ hello: 1 }));
  await assert.rejects(call(bad.p.arrivals, '1', 0, 60), /bad response/);
  const offline = make({}, () => new Error('offline'));
  await assert.rejects(call(offline.p.arrivals, '1', 0, 60), /offline/);
});

// ---------------------------------------------------------------- arrivals

test('cta: arrivals of one tick share one getpredictions request; mapping, window, canceled trips', async () => {
  const { p, urls } = make();
  const [a457, a458, a4590] = await Promise.all([
    call(p.arrivals, '457', 0, 60), call(p.arrivals, '458', 0, 60), call(p.arrivals, '4590', 0, 60)]);
  assert.deepEqual(urls, [BASE + '/getpredictions?key=K%261&format=json&stpid=457,458,4590&tmres=s']);
  assert.deepEqual(a457, [
    { stopId: '457', routeId: '9', tripKey: '9/88001@2026-01-13', time: NOW + 150, predicted: true, headsign: '95th Street' },
    { stopId: '457', routeId: '20', tripKey: '20/1040713@2026-01-13', time: NOW + 300, predicted: true, headsign: 'Austin' }]);
  // the same run has the same tripKey at the next stop; 15:20 is outside the 60 min window
  assert.deepEqual(a458, [
    { stopId: '458', routeId: '20', tripKey: '20/1040713@2026-01-13', time: NOW + 540, predicted: true, headsign: 'Austin' }]);
  assert.deepEqual(a4590, []); // "No service scheduled" = nothing coming
});

test('cta: more than 10 stops → requests of at most 10 stop ids; ids are URL-encoded', async () => {
  const { p, urls } = make();
  const ids = ['a b', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
  await Promise.all(ids.map(id => call(p.arrivals, id, 0, 60)));
  assert.equal(urls.length, 2);
  assert.ok(urls[0].endsWith('&stpid=a%20b,2,3,4,5,6,7,8,9,10&tmres=s'));
  assert.ok(urls[1].endsWith('&stpid=11,12&tmres=s'));
});

test('cta: a stop-specific error other than "no service" fails only that stop', async () => {
  const { p, urls } = make();
  const [bad, good] = await Promise.allSettled([call(p.arrivals, '99999', 0, 60), call(p.arrivals, '457', 0, 60)]);
  assert.equal(urls.length, 1);
  assert.match(bad.reason.message, /No data found for parameter/);
  assert.equal(good.value.length, 2);
});

test('cta: predictions are reused for 20 s, concurrent calls for one stop share the request', async () => {
  const { p, urls, setNow } = make();
  await Promise.all([call(p.arrivals, '457', 0, 60), call(p.arrivals, '457', 5, 30)]);
  assert.equal(urls.length, 1);
  setNow(NOW + 19);
  await call(p.arrivals, '457', 0, 60);
  assert.equal(urls.length, 1);
  setNow(NOW + 20);
  const later = await call(p.arrivals, '457', 0, 60);
  assert.equal(urls.length, 2);
  assert.equal(later.length, 2);
});

// ---------------------------------------------------------------- route

test('cta: route = getroutes + getpatterns?rt=; directions, merged stop order, paths, color, longName', async () => {
  const storage = memStorage();
  const { p, urls } = make({ storage });
  const r = await call(p.route, '20');
  assert.deepEqual(urls.slice().sort(), [BASE + '/getpatterns?key=K%261&format=json&rt=20', BASE + '/getroutes?key=K%261&format=json']);
  assert.equal(r.id, '20');
  assert.equal(r.shortName, '20');
  assert.equal(r.longName, 'Madison');
  assert.equal(r.color, 'FF3399');
  assert.deepEqual(r.directions.map(d => [d.id, d.name]), [['Eastbound', 'Eastbound'], ['Westbound', 'Westbound']]);
  assert.deepEqual(r.directions[0].stopIds, ['4720', '4724', '4728']);
  assert.deepEqual(r.directions[0].paths, [[
    { lat: 41.88181, lon: -87.6768 }, { lat: 41.8818, lon: -87.672 }, { lat: 41.88175, lon: -87.6668 }, { lat: 41.8817, lon: -87.6569 }]]);
  // points sorted by seq; the short-turn pattern adds Halsted before Racine
  assert.deepEqual(r.directions[1].stopIds, ['4590', '456', '457', '458']);
  assert.equal(r.directions[1].paths.length, 2);
  assert.deepEqual(r.stops['457'], { id: '457', name: 'Madison & Ashland', lat: 41.8819, lon: -87.6669 });
  assert.equal(Object.keys(r.stops).length, 7);

  // stored: a new provider on the same storage answers without requests
  const again = make({ storage });
  assert.deepEqual(await call(again.p.route, '20'), r);
  assert.equal(again.urls.length, 0);
  // expired after 3 days
  const old = make({ storage, now: NOW + 3 * 86400 });
  await call(old.p.route, '20');
  assert.ok(old.urls.some(u => u.includes('/getpatterns?')));
});

test('cta: detour patterns count; unknown route → API message; getroutes failure still builds', async () => {
  const { p } = make();
  const r9 = await call(p.route, '9');
  assert.equal(r9.color, 'CC3300');
  assert.deepEqual(r9.directions.map(d => d.stopIds), [['1700', '1702', '1704'], ['1705', '457']]);
  const nodata = make({}, url => (url.includes('getpatterns') ? { 'bustime-response': { error: [{ msg: 'No data found for parameter' }] } } : standard(url)));
  await assert.rejects(call(nodata.p.route, 'X99'), /No data found/);
  const noList = make({}, url => (url.includes('getroutes') ? new Error('down') : standard(url)));
  const r = await call(noList.p.route, '20');
  assert.equal(r.shortName, '20');
  assert.equal(r.color, '');
  assert.equal(r.directions.length, 2);
});

test('cta: stopsNear = stops of the saved routes within the radius, merged, nearest first', async () => {
  const { p, urls } = make();
  const pos = { lat: 41.8818, lon: -87.6668 }; // Madison & Ashland
  const stops = await call(p.stopsNear, pos, 120);
  assert.deepEqual(stops.map(s => s.id), ['4724', '457', '1702']);
  assert.deepEqual(stops.find(s => s.id === '457').routeIds, ['20', '9']);
  assert.deepEqual(stops[0], { id: '4724', name: 'Madison & Ashland', lat: 41.88175, lon: -87.6668, routeIds: ['20'] });
  assert.equal(urls.filter(u => u.includes('getroutes')).length, 1); // the route list is shared
  const none = make({ routeIds: [] });
  assert.deepEqual(await call(none.p.stopsNear, pos, 120), []);
  const failing = make({}, () => new Error('down'));
  await assert.rejects(call(failing.p.stopsNear, pos, 120), /down/);
});

// ---------------------------------------------------------------- vehicles

test('cta: vehicles of one tick share one getvehicles request; tripKey matches arrivals; direction from patterns', async () => {
  const { p, urls } = make();
  await call(p.route, '20');
  await call(p.route, '9');
  urls.length = 0;
  const [v20, v9] = await Promise.all([call(p.vehicles, '20'), call(p.vehicles, '9')]);
  assert.deepEqual(urls, [BASE + '/getvehicles?key=K%261&format=json&rt=20,9&tmres=s']);
  assert.deepEqual(v20, [{ tripKey: '20/1040713@2026-01-13', routeId: '20', directionId: 'Westbound', lat: 41.88193, lon: -87.66032, time: NOW - 18 }]);
  assert.deepEqual(v9, [{ tripKey: '9/88001@2026-01-13', routeId: '9', directionId: 'Southbound', lat: 41.8829, lon: -87.66689, time: NOW - 10 }]);
  const arr = await call(p.arrivals, '457', 0, 60);
  assert.equal(arr[1].tripKey, v20[0].tripKey);
});

test('cta: vehicles without known patterns have directionId ""; a route without buses → []', async () => {
  const { p } = make();
  const v = await call(p.vehicles, '20');
  assert.equal(v[0].directionId, '');
  const empty = make({}, () => 'cta-error-nodata-rt.json');
  assert.deepEqual(await call(empty.p.vehicles, 'X99'), []);
});

// ---------------------------------------------------------------- catalog helpers

test('cta: listRoutes, routeInfo, stopInfo (known stop without a request, else getstops?stpid=)', async () => {
  const { p, urls } = make();
  assert.deepEqual(await call(p.listRoutes), [
    { id: '9', label: '9 Ashland' }, { id: '20', label: '20 Madison' }, { id: 'X9', label: 'X9 Ashland Express' }]);
  const info = await call(p.routeInfo, '20');
  assert.equal(info.directions[1].stopIds.length, 4);
  const n = urls.length;
  assert.deepEqual(await call(p.stopInfo, '457'), { id: '457', name: 'Madison & Ashland', lat: 41.8819, lon: -87.6669 });
  assert.equal(urls.length, n);
  assert.deepEqual(await call(p.stopInfo, '1577'), { id: '1577', name: '1509 S Michigan', lat: 41.861706666665, lon: -87.623969999999 });
  assert.equal(urls[urls.length - 1], BASE + '/getstops?key=K%261&format=json&stpid=1577');
  await assert.rejects(call(p.stopInfo, '2'), /unknown stop 2/);
});

test('cta: catalog = getroutes + getpatterns per route; failing routes without stops; progress', async () => {
  const { p, urls } = make();
  const progress = [];
  const cat = await call((cb) => p.catalog(cb, (d, t) => progress.push([d, t])));
  assert.equal(urls.length, 4); // getroutes + 3 × getpatterns (X9 has no fixture → fails)
  assert.deepEqual(progress.map(x => x[1]), [3, 3, 3]);
  assert.deepEqual(progress.map(x => x[0]), [1, 2, 3]);
  assert.deepEqual(cat.routes, [
    { id: '9', shortName: '9', longName: 'Ashland' }, { id: '20', shortName: '20', longName: 'Madison' },
    { id: 'X9', shortName: 'X9', longName: 'Ashland Express' }]);
  const s457 = cat.stops.find(s => s.id === '457');
  assert.deepEqual(s457, { id: '457', name: 'Madison & Ashland', routeIds: ['9', '20'], lat: 41.8819, lon: -87.6669, dir: '' }, 'served in two directions: none');
  assert.equal(cat.stops.length, 11);
  assert.ok(cat.stops.every(s => typeof s.lat === 'number' && s.routeIds.length));
});

test('cta: catalog uses routes already built without fetching their patterns again', async () => {
  const storage = memStorage();
  const first = make({ storage });
  await call(first.p.route, '20');
  const { p, urls } = make({ storage });
  await call(p.catalog);
  assert.deepEqual(urls.filter(u => u.includes('getpatterns')).map(u => u.split('&rt=')[1]).sort(), ['9', 'X9']);
  assert.equal(urls.filter(u => u.includes('getroutes')).length, 0); // the route list is stored too
});

// ---------------------------------------------------------------- plug-in

test('cta: plug-in through the registry (type, label, defaults, ctx routes)', async () => {
  assert.equal(plugin.type, 'cta');
  assert.equal(plugin.label, 'CTA (Chicago)');
  assert.equal(DEFAULT_BASE_URL, 'https://www.ctabustracker.com/bustime/api/v3');
  const reg = createRegistry([plugin]);
  assert.equal(reg.types()[0].needsKey, true);
  const f = fakeHttp(standard);
  const p = reg.create({ provider: { type: 'cta', apiKey: 'KEY' }, routes: [{ id: '20', name: 'Madison' }] },
    { http: f.http, clock: () => NOW });
  const stops = await call(p.stopsNear, { lat: 41.8818, lon: -87.6668 }, 120);
  assert.deepEqual(stops.map(s => s.id), ['4724', '457']);
  assert.ok(f.urls.every(u => u.startsWith(DEFAULT_BASE_URL + '/') && u.includes('?key=KEY&format=json')));
});
