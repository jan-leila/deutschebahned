// weather.js: Open-Meteo forecast → the watch's weather panel (CONTRACTS.md §17), and protocol.encodeWeather.
const test = require('node:test');
const assert = require('node:assert/strict');
const weather = require('../src/common/weather');
const protocol = require('../src/common/protocol');

const H = 3600, T0 = 1_800_000_000 - (1_800_000_000 % H);
function body(n, extra) {
  const time = [], temp = [], rain = [];
  for (let i = 0; i < n; i++) { time.push(T0 + i * H); temp.push(10 + i); rain.push(i * 2); }
  return { latitude: 44.98, longitude: -93.27, current: { time: T0 + 900, temperature_2m: 10.4 },
           hourly: { time, temperature_2m: temp, precipitation_probability: rain }, ...extra };
}

test('url: Open-Meteo forecast in °C with unix times', () => {
  assert.equal(weather.url({ lat: 44.977753, lon: -93.265011 }),
    'https://api.open-meteo.com/v1/forecast?latitude=44.9778&longitude=-93.265' +
    '&current=temperature_2m&hourly=temperature_2m,precipitation_probability' +
    '&temperature_unit=celsius&timeformat=unixtime&forecast_days=2');
  assert.ok(weather.url({ lat: 0, lon: 0 }, { baseUrl: 'http://x/' }).startsWith('http://x/v1/forecast?'));
});

test('parse: hours without a temperature dropped, missing rain = 0, rain clamped; errors throw', () => {
  const b = body(3);
  b.hourly.temperature_2m[1] = null;
  b.hourly.precipitation_probability[0] = null;
  b.hourly.precipitation_probability[2] = 140;
  assert.deepEqual(weather.parse(b), { current: 10.4, times: [T0, T0 + 2 * H], temps: [10, 12], rain: [0, 100] });
  assert.throws(() => weather.parse({ error: true, reason: 'Latitude must be in range' }), /Latitude/);
  assert.throws(() => weather.parse(null), /unexpected/);
  assert.throws(() => weather.parse({ hourly: {} }), /no hourly/);
  assert.equal(weather.parse(body(1, { current: {} })).current, null);
});

test('slice: from the current hour, 24 hours, hi / lo include the current temperature', () => {
  const d = weather.parse(body(48));
  const w = weather.slice(d, T0 + 2 * H + 10);
  assert.equal(w.start, T0 + 2 * H);
  assert.equal(w.temps.length, 24);
  assert.equal(w.temps[0], 12);
  assert.equal(w.now, 10.4);
  assert.equal(w.lo, 10.4);
  assert.equal(w.hi, 35);
  assert.equal(weather.slice(d, T0 + 48 * H), null);
  const noCur = weather.slice({ ...d, current: null }, T0);
  assert.equal(noCur.now, 10);
  assert.equal(weather.slice(null, T0), null);
});

test('createFetcher: cached for MAX_AGE within MAX_MOVE; shared while in flight; errors not cached', async () => {
  let now = T0, calls = 0, fail = false;
  const http = (url, cb) => { calls++; setTimeout(() => (fail ? cb(new Error('net')) : cb(null, body(3))), 0); };
  const fetch = weather.createFetcher(http, () => now);
  const get = pos => new Promise(r => fetch(pos, (e, d) => r([e, d])));
  const here = { lat: 44.98, lon: -93.27 };
  const [a, b] = await Promise.all([get(here), get(here)]);
  assert.equal(calls, 1);
  assert.equal(a[1].temps.length, 3);
  assert.equal(b[1], a[1]);
  await get({ lat: 44.981, lon: -93.27 });   // ~100 m away
  assert.equal(calls, 1);
  await get({ lat: 45.1, lon: -93.27 });     // ~13 km away
  assert.equal(calls, 2);
  now += weather.MAX_AGE;
  fail = true;
  const [err] = await get({ lat: 45.1, lon: -93.27 });
  assert.match(err.message, /net/);
  fail = false;
  await get({ lat: 45.1, lon: -93.27 });
  assert.equal(calls, 4);
});

test('encodeWeather: watch units, temperatures scaled to lo..hi, rain bytes; null / empty hide the panel', () => {
  const w = { start: T0, now: 10.4, hi: 20, lo: 10, temps: [10, 15, 20], rain: [0, 55.4, 120] };
  assert.deepEqual(protocol.encodeWeather(w, 'metric'), { WEATHER_COUNT: 3, WEATHER_START: T0, WEATHER_NOW: 10,
    WEATHER_HI: 20, WEATHER_LO: 10, WEATHER_TEMPS: [0, 128, 255], WEATHER_RAIN: [0, 55, 100] });
  const f = protocol.encodeWeather(w, 'imperial');
  assert.deepEqual([f.WEATHER_NOW, f.WEATHER_HI, f.WEATHER_LO], [51, 68, 50]);
  assert.deepEqual(protocol.encodeWeather({ ...w, hi: 10, temps: [10, 10] }, 'metric').WEATHER_TEMPS, [128, 128]);
  assert.deepEqual(protocol.encodeWeather(null), { WEATHER_COUNT: 0 });
  assert.deepEqual(protocol.encodeWeather({ temps: [] }), { WEATHER_COUNT: 0 });
  const long = { ...w, temps: new Array(30).fill(12), rain: [] };
  const e = protocol.encodeWeather(long, 'metric');
  assert.equal(e.WEATHER_COUNT, 24);
  assert.equal(e.WEATHER_RAIN.length, 24);
});
