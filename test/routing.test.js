const test = require('node:test');
const assert = require('node:assert/strict');
const routing = require('../src/common/routing');

const A = { lat: 44.97, lon: -93.26 }, B = { lat: 44.98, lon: -93.25 };

test('usable: http(s) templates with a destination placeholder only', () => {
  assert.equal(routing.usable('https://r.example/route?to={toLat},{toLon}'), true);
  assert.equal(routing.usable('http://r.example/{to}'), true);
  assert.equal(routing.usable('https://r.example/route'), false);
  assert.equal(routing.usable('ftp://r.example/{to}'), false);
  assert.equal(routing.usable(''), false);
  assert.equal(routing.usable(null), false);
});

test('url fills every placeholder with 6 decimals', () => {
  assert.equal(routing.url('https://r/x?a={fromLat}&b={fromLon}&c={toLat}&d={toLon}', A, B),
    'https://r/x?a=44.97&b=-93.26&c=44.98&d=-93.25');
  assert.equal(routing.url('https://r/{from};{to}', { lat: 1.23456789, lon: 2 }, B), 'https://r/1.234568,2;44.98,-93.25');
});

test('parse: the simple steps form', () => {
  const p = routing.parse({ steps: [{ text: 'Turn left', lat: 1, lon: 2 }, { lat: 3, lon: 4 }, { text: 'bad' }] });
  assert.deepEqual(p, [{ lat: 1, lon: 2, text: 'Turn left' }, { lat: 3, lon: 4, text: '' }]);
});

test('parse: points as objects or pairs', () => {
  assert.deepEqual(routing.parse({ points: [{ lat: 1, lon: 2 }, [3, 4]] }), [{ lat: 1, lon: 2, text: '' }, { lat: 3, lon: 4, text: '' }]);
});

test('parse: OSRM steps become instructions, [lon, lat] swapped', () => {
  const p = routing.parse({ routes: [{ legs: [{ steps: [
    { maneuver: { type: 'depart', modifier: 'north', location: [-93.26, 44.97] }, name: 'Pine St' },
    { maneuver: { type: 'turn', modifier: 'slight left', location: [-93.255, 44.975] }, name: 'Oak Ave' },
    { maneuver: { type: 'turn', modifier: 'right', location: [-93.25, 44.98] }, name: '' },
    { maneuver: { type: 'arrive', location: [-93.25, 44.98] }, name: '' }] }] }] });
  assert.deepEqual(p.map(x => x.text), ['Head north on Pine St', 'Turn slight left on Oak Ave', 'Turn right', 'Arrive']);
  assert.deepEqual([p[0].lat, p[0].lon], [44.97, -93.26]);
});

test('parse: GeoJSON geometry fallback, thinned to MAX_WAYPOINTS', () => {
  const coordinates = [];
  for (let i = 0; i < 200; i++) coordinates.push([-93 + i / 1000, 44 + i / 1000]);
  const p = routing.parse({ routes: [{ geometry: { coordinates } }] });
  assert.equal(p.length, routing.MAX_WAYPOINTS);
  assert.deepEqual([p[0].lat, p[0].lon], [44, -93]);
  assert.deepEqual([p[p.length - 1].lat, p[p.length - 1].lon], [44.199, -92.801]);
});

test('parse: no route throws', () => {
  assert.throws(() => routing.parse({}), /no route/);
  assert.throws(() => routing.parse(null), /unexpected/);
  assert.throws(() => routing.parse({ routes: [] }), /no route/);
});

test('createFetcher: requests the filled url; errors and bad bodies come back as errors', async () => {
  const urls = [];
  let body = { steps: [{ text: 'Go', lat: 1, lon: 2 }] }, err = null;
  const fetcher = routing.createFetcher((u, cb) => { urls.push(u); cb(err, body); });
  const call = (tpl) => new Promise(r => fetcher(tpl, A, B, (e, p) => r({ e, p })));
  let r = await call('https://r/{from}/{to}');
  assert.deepEqual(urls, ['https://r/44.97,-93.26/44.98,-93.25']);
  assert.deepEqual(r.p, [{ lat: 1, lon: 2, text: 'Go' }]);
  body = {}; r = await call('https://r/{to}'); assert.match(r.e.message, /no route/);
  err = new Error('Network error'); r = await call('https://r/{to}'); assert.equal(r.e.message, 'Network error');
  r = await call('nope'); assert.match(r.e.message, /no routing source/);
});
