// Addresses ⇄ positions for trip destinations (Photon). Fixtures are real responses (2026-11-13).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const geocode = require('../src/common/geocode');

const fx = n => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));
const call = (fn, ...args) => new Promise((resolve, reject) => fn(...args, (err, v) => (err ? reject(err) : resolve(v))));
function fakeHttp(body) {
  const urls = [];
  return { urls, http: (url, cb) => { urls.push(url); setTimeout(() => (body instanceof Error ? cb(body) : cb(null, body)), 0); } };
}

test('place: name, address line in the local order, rounded position', () => {
  const dc = fx('geocode-search-dc.json').features.map(geocode.place);
  assert.deepEqual(dc[0], { name: 'White House', address: 'White House, 1600 Pennsylvania Avenue Northwest, Washington, DC',
    lat: 38.897639, lon: -77.036552 });
  const berlin = geocode.place(fx('geocode-search-berlin.json').features[0]);
  assert.equal(berlin.address, 'Primark, Alexanderplatz 5-7, Berlin', 'street before number outside the US / UK …');
  const street = geocode.place(fx('geocode-reverse-mpls.json').features[0]);
  assert.deepEqual(street, { name: 'South 4th Street', address: 'South 4th Street, Minneapolis, Minnesota', lat: 44.977774, lon: -93.26505 });
  // an unnamed house: "number street" is the name
  assert.equal(geocode.place({ geometry: { coordinates: [1, 2] }, properties: { housenumber: '12', street: 'Elm St', city: 'X',
    countrycode: 'US', state: 'MN' } }).name, '12 Elm St');
  for (const bad of [null, {}, { geometry: { coordinates: ['a', 2] } }, { geometry: { coordinates: [1, 2] }, properties: {} }]) {
    assert.equal(geocode.place(bad), null);
  }
});

test('search: URL with the query, limit and a position to look near; mapped places; empty query → no request', async () => {
  const { http, urls } = fakeHttp(fx('geocode-search-dc.json'));
  const places = await call(geocode.search, http, ' 1600 Pennsylvania Ave & Co ', { lat: 38.9, lon: -77 });
  assert.equal(urls[0], 'https://photon.komoot.io/api/?q=1600%20Pennsylvania%20Ave%20%26%20Co&limit=5&lat=38.9&lon=-77');
  assert.equal(places.length, 2);
  assert.equal(places[0].name, 'White House');
  const plain = fakeHttp(fx('geocode-search-dc.json'));
  await new Promise(resolve => geocode.search(plain.http, 'x', null, resolve, { baseUrl: 'https://geo.example/', limit: 3 }));
  assert.equal(plain.urls[0], 'https://geo.example/api/?q=x&limit=3');
  const none = fakeHttp(null);
  assert.deepEqual(await call(geocode.search, none.http, '  ', null), []);
  assert.equal(none.urls.length, 0);
  await assert.rejects(call(geocode.search, fakeHttp({ message: 'missing q' }).http, 'x', null), /missing q/);
  await assert.rejects(call(geocode.search, fakeHttp(new Error('offline')).http, 'x', null), /offline/);
});

test('reverse: the place at a position; nothing there → null', async () => {
  const { http, urls } = fakeHttp(fx('geocode-reverse-mpls.json'));
  const pl = await call(geocode.reverse, http, { lat: 44.9778, lon: -93.265 });
  assert.equal(urls[0], 'https://photon.komoot.io/reverse?lat=44.9778&lon=-93.265&limit=1');
  assert.equal(pl.name, 'South 4th Street');
  assert.equal(await call(geocode.reverse, fakeHttp({ type: 'FeatureCollection', features: [] }).http, { lat: 0, lon: 0 }), null);
  await assert.rejects(call(geocode.reverse, fakeHttp(null).http, null), /no position/);
});
