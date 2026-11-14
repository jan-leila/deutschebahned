// Weather for the watch's panel above the first row (CONTRACTS.md §17): the current temperature and the next HOURS
// hours of temperature and chance of rain, from Open-Meteo (no key). Temperatures stay in °C here; the protocol
// converts them to the watch's units. http is injected. ES5.

var geo = require('./geo');

var DEFAULT_BASE_URL = 'https://api.open-meteo.com';
var HOURS = 24;
var MAX_AGE = 1800;        // s: a forecast is fetched again after this long
var MAX_MOVE = 2000;       // m: ... or once you are this far from where it was fetched

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

function url(pos, opts) {
  var base = ((opts && opts.baseUrl) || DEFAULT_BASE_URL).replace(/\/+$/, '');
  return base + '/v1/forecast?latitude=' + round4(pos.lat) + '&longitude=' + round4(pos.lon) +
    '&current=temperature_2m&hourly=temperature_2m,precipitation_probability' +
    '&temperature_unit=celsius&timeformat=unixtime&forecast_days=2';
}

function finite(v) {
  return typeof v === 'number' && isFinite(v);
}

// Open-Meteo response → {current, times: [epoch s], temps: [°C], rain: [0..100]}; throws on anything else.
// Hours without a temperature are dropped; a missing chance of rain counts as 0.
function parse(body) {
  if (!body || typeof body !== 'object') throw new Error('unexpected weather response');
  if (body.error) throw new Error(body.reason || 'weather error');
  var h = body.hourly || {};
  var times = h.time instanceof Array ? h.time : [];
  var temps = h.temperature_2m instanceof Array ? h.temperature_2m : [];
  var rain = h.precipitation_probability instanceof Array ? h.precipitation_probability : [];
  var out = { current: null, times: [], temps: [], rain: [] };
  for (var i = 0; i < times.length; i++) {
    if (!finite(times[i]) || !finite(temps[i])) continue;
    var r = finite(rain[i]) ? rain[i] : 0;
    out.times.push(times[i]);
    out.temps.push(temps[i]);
    out.rain.push(Math.max(0, Math.min(100, r)));
  }
  var cur = body.current && body.current.temperature_2m;
  out.current = finite(cur) ? cur : null;
  if (!out.times.length) throw new Error('no hourly forecast');
  return out;
}

// The forecast from the hour containing `now` on: {start, now, hi, lo, temps, rain} (≤ HOURS points), or null when
// the forecast has no such hour. `now` is the current temperature (else the first hour's); hi / lo span the shown
// hours and the current temperature.
function slice(data, now, hours) {
  if (!data || !(data.times instanceof Array)) return null;
  hours = hours || HOURS;
  var first = -1;
  for (var i = 0; i < data.times.length; i++) {
    if (data.times[i] + 3600 > now) { first = i; break; }
  }
  if (first < 0) return null;
  var temps = data.temps.slice(first, first + hours), rain = data.rain.slice(first, first + hours);
  var cur = finite(data.current) ? data.current : temps[0];
  var hi = cur, lo = cur;
  for (var j = 0; j < temps.length; j++) {
    if (temps[j] > hi) hi = temps[j];
    if (temps[j] < lo) lo = temps[j];
  }
  return { start: data.times[first], now: cur, hi: hi, lo: lo, temps: temps, rain: rain };
}

// fetch(pos, cb) → cb(err, parsed) with one cached forecast, reused for MAX_AGE s within MAX_MOVE m of where it was
// fetched. Concurrent calls while a request is out share it.
function createFetcher(http, clock, opts) {
  var cache = null;      // {pos, at, data}
  var waiting = null;    // callbacks of the request in flight
  return function fetch(pos, cb) {
    var now = clock();
    if (cache && now - cache.at < MAX_AGE && geo.distance(cache.pos, pos) < MAX_MOVE) {
      var data = cache.data;
      setTimeout(function () { cb(null, data); }, 0);
      return;
    }
    if (waiting) { waiting.push(cb); return; }
    waiting = [cb];
    http(url(pos, opts), function (err, body) {
      var parsed = null;
      if (!err) {
        try {
          parsed = parse(body);
          cache = { pos: { lat: pos.lat, lon: pos.lon }, at: now, data: parsed };
        } catch (e) {
          err = e;
        }
      }
      var cbs = waiting;
      waiting = null;
      for (var i = 0; i < cbs.length; i++) cbs[i](err || null, err ? undefined : parsed);
    });
  };
}

module.exports = {
  DEFAULT_BASE_URL: DEFAULT_BASE_URL,
  HOURS: HOURS,
  MAX_AGE: MAX_AGE,
  MAX_MOVE: MAX_MOVE,
  url: url,
  parse: parse,
  slice: slice,
  createFetcher: createFetcher
};
