// Addresses ⇄ positions for trip destinations (CONTRACTS.md §10a). ES5; http injected (`http(url, cb)` → parsed JSON).
// Uses Photon (https://photon.komoot.io, OpenStreetMap data): no API key, CORS open, so the settings page can call it directly.

var DEFAULT_BASE_URL = 'https://photon.komoot.io';
var LIMIT = 5;
var HOUSE_FIRST = ['US', 'CA', 'GB', 'IE', 'AU', 'NZ'];   // '1600 Main St' rather than 'Hauptstraße 5'

function str(v) { return v == null ? '' : String(v).replace(/^\s+|\s+$/g, ''); }

function round6(n) { return Math.round(n * 1e6) / 1e6; }

// one GeoJSON feature → {name, address, lat, lon} | null
//   name: the place's own name, else "number street", else street / city — what a destination is called by default
//   address: name (when it isn't the street line), street line, city, state (US-style only), comma separated, no repeats
function place(feature) {
  if (!feature || !feature.geometry || !(feature.geometry.coordinates instanceof Array)) return null;
  var c = feature.geometry.coordinates, lon = +c[0], lat = +c[1];
  if (!isFinite(lat) || !isFinite(lon)) return null;
  var p = feature.properties || {};
  var houseFirst = false;
  for (var i = 0; i < HOUSE_FIRST.length; i++) if (str(p.countrycode).toUpperCase() === HOUSE_FIRST[i]) houseFirst = true;
  var street = str(p.street), number = str(p.housenumber);
  var line = street && number ? (houseFirst ? number + ' ' + street : street + ' ' + number) : street;
  var city = str(p.city) || str(p.town) || str(p.village) || str(p.locality) || str(p.county);
  var own = str(p.name);
  var name = own || line || city || str(p.state) || str(p.country);
  var parts = [], seen = {};
  function add(v) { if (v && !seen.hasOwnProperty(v.toLowerCase())) { seen[v.toLowerCase()] = true; parts.push(v); } }
  add(own);
  add(line);
  if (str(p.district) && !line && !own) add(str(p.district));
  add(city);
  if (houseFirst && str(p.countrycode).toUpperCase() === 'US') add(str(p.state));
  if (!parts.length) add(str(p.country));
  if (!name) return null;
  return { name: name, address: parts.join(', '), lat: round6(lat), lon: round6(lon) };
}

function features(body) {
  if (!body || body.type !== 'FeatureCollection' || !(body.features instanceof Array)) {
    throw new Error(body && body.message ? String(body.message) : 'unexpected geocoder response');
  }
  return body.features;
}

function base(opts) { return str(opts && opts.baseUrl).replace(/\/+$/, '') || DEFAULT_BASE_URL; }

// cb(err, [{name, address, lat, lon}]) — up to `limit` (5) matches for `query`, ranked by the geocoder, nearer `near`
// ({lat, lon}, optional) first. An empty query → [] without a request.
function search(http, query, near, cb, opts) {
  var q = str(query);
  if (!q) return setTimeout(function () { cb(null, []); }, 0);
  var url = base(opts) + '/api/?q=' + encodeURIComponent(q) + '&limit=' + ((opts && opts.limit) || LIMIT);
  if (near && isFinite(+near.lat) && isFinite(+near.lon) && (+near.lat || +near.lon)) {
    url += '&lat=' + round6(+near.lat) + '&lon=' + round6(+near.lon);
  }
  var done = false;
  function finish(err, v) { if (!done) { done = true; cb(err, v); } }
  try {
    http(url, function (err, body) {
      if (err) return finish(err);
      var out = [];
      try {
        var fs = features(body);
        for (var i = 0; i < fs.length; i++) { var pl = place(fs[i]); if (pl) out.push(pl); }
      } catch (e) { return finish(e); }
      finish(null, out);
    });
  } catch (e) {
    setTimeout(function () { finish(e); }, 0);
  }
}

// cb(err, {name, address, lat, lon} | null) — what is at pos (the nearest addressable place), null if nothing
function reverse(http, pos, cb, opts) {
  if (!pos || !isFinite(+pos.lat) || !isFinite(+pos.lon)) return setTimeout(function () { cb(new Error('no position')); }, 0);
  var url = base(opts) + '/reverse?lat=' + round6(+pos.lat) + '&lon=' + round6(+pos.lon) + '&limit=1';
  var done = false;
  function finish(err, v) { if (!done) { done = true; cb(err, v); } }
  try {
    http(url, function (err, body) {
      if (err) return finish(err);
      var pl = null;
      try { var fs = features(body); pl = fs.length ? place(fs[0]) : null; } catch (e) { return finish(e); }
      finish(null, pl);
    });
  } catch (e) {
    setTimeout(function () { finish(e); }, 0);
  }
}

module.exports = { DEFAULT_BASE_URL: DEFAULT_BASE_URL, place: place, search: search, reverse: reverse };
