'use strict';
// BVG / VBB (Berlin–Brandenburg) provider: the public HAFAS REST API https://v6.bvg.transport.rest (no key, CORS open,
// ~100 requests/min). ES5 only (runs in PebbleKit JS). See CONTRACTS.md §3.
var geo = require('../../common/geo');
var util = require('../util');

var DEFAULT_BASE_URL = 'https://v6.bvg.transport.rest';
var MAX_IN_FLIGHT = 3;
var CACHE_PREFIX = 'busWatch.bvg.';
var ROUTE_TTL = 7 * 86400;      // seconds: built routes in storage
var NEARBY_TTL = 300;           // seconds: stopsNear answers kept in memory (same rounded position / radius)
var NEARBY_RESULTS = 100;
var MAX_PATTERNS = 6;           // distinct origin→destination trips fetched per route
var TRIP_WINDOW = 1800;         // seconds: /trips time window used to find a line's trips
var CATALOG_RADIUS = 15000;     // metres: one /locations/nearby tile of the catalog (the API returns the nearest 1000 stops at most)
var CATALOG_RESULTS = 1000;
var CATALOG_RING = 12000;       // metres from the centre to the 6 outer tiles
var PATH_STEP = 15;             // metres: polyline points closer than this to the previous kept one are dropped

var PRODUCT_LABELS = {
  subway: 'U-Bahn', suburban: 'S-Bahn', tram: 'Tram', bus: 'Bus', ferry: 'Ferry',
  regional: 'Regional train', express: 'Long-distance train'
};

// official VBB line colours (Berlin lines only; ids scoped '11000000')
var LINE_COLORS = {
  'subway:U1': '7DAD4C', 'subway:U2': 'DA421E', 'subway:U3': '16683D', 'subway:U4': 'F0D722', 'subway:U5': '7E5330',
  'subway:U6': '8C6DAB', 'subway:U7': '528DBA', 'subway:U8': '224F86', 'subway:U9': 'F3791D',
  'suburban:S1': 'DE4DA4', 'suburban:S2': '005F27', 'suburban:S25': '005F27', 'suburban:S26': '005F27',
  'suburban:S3': '0A4C99', 'suburban:S41': 'A23B1E', 'suburban:S42': 'C26A36', 'suburban:S45': 'C38737',
  'suburban:S46': 'C38737', 'suburban:S47': 'C38737', 'suburban:S5': 'DF6418', 'suburban:S7': '745896',
  'suburban:S75': '745896', 'suburban:S8': '55A822', 'suburban:S85': '55A822', 'suburban:S9': '8A0E30'
};
var PRODUCT_COLORS = { tram: 'BE1414', bus: 'A5027D' }; // BVG tram red / bus purple (Berlin lines)

function toError(e) {
  return e instanceof Error ? e : new Error(String(e));
}

function once(cb) {
  var done = false;
  return function (err, value) {
    if (done) return;
    done = true;
    if (typeof cb === 'function') cb(err, value);
  };
}

function later(cb, err, value) {
  setTimeout(function () { cb(err, value); }, 0);
}

function sortBy(arr, key) {
  var tagged = [];
  var i;
  for (i = 0; i < arr.length; i++) tagged.push({ k: key(arr[i]), i: i, v: arr[i] });
  tagged.sort(function (a, b) { return a.k !== b.k ? a.k - b.k : a.i - b.i; });
  var out = [];
  for (i = 0; i < tagged.length; i++) out.push(tagged[i].v);
  return out;
}

function trim(s) {
  return String(s == null ? '' : s).replace(/^\s+|\s+$/g, '');
}

// 'S+U Alexanderplatz Bhf (Berlin)' → 'S+U Alexanderplatz Bhf'
function cleanName(s) {
  return trim(s).replace(/\s*\(Berlin\)$/, '');
}

// direction names drop the 'S ' / 'U ' / 'S+U ' station prefix ('S Hackescher Markt' would read as "southbound")
function directionName(s) {
  return cleanName(s).replace(/^(S\+U|S|U)\s+/, '');
}

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

// ISO 8601 with offset ('2026-11-13T22:45:00+01:00') → epoch seconds; NaN if unparseable
function parseTime(s) {
  if (typeof s !== 'string') return NaN;
  var m = s.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?(?:\.\d+)?(Z|([+-])(\d\d):?(\d\d))?$/);
  if (!m) return NaN;
  var t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000;
  if (m[8]) t -= (m[8] === '-' ? -1 : 1) * (+m[9] * 3600 + +m[10] * 60);
  return t;
}

// a HAFAS line → our route id '<scope>:<product>:<name>' (scope = the region code of 'de-vbb-11000000-…' ids, else the
// id's first segment). Merges the S-Bahn / tram variants HAFAS reports as separate lines ('…-s3-s3-bi', '…-tram-m8-808').
function routeKey(line) {
  if (!line || line.name == null || trim(line.name) === '') return '';
  var id = String(line.id || '');
  var m = id.match(/^de-[a-z]+-(\d+)-/);
  var scope = m ? m[1] : (id.split('-')[0] || 'x');
  return scope + ':' + String(line.product || 'unknown') + ':' + trim(line.name).replace(/\s+/g, '');
}

// '11000000:tram:M4' → {scope, product, name}; null if malformed
function parseKey(routeId) {
  var parts = String(routeId).split(':');
  if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  return { scope: parts[0], product: parts[1], name: parts.slice(2).join(':') };
}

function productLabel(product) {
  return PRODUCT_LABELS.hasOwnProperty(product) ? PRODUCT_LABELS[product] : '';
}

function lineColor(k) {
  if (!k || k.scope !== '11000000') return '';
  var c = LINE_COLORS[k.product + ':' + k.name] || PRODUCT_COLORS[k.product] || '';
  return util.color(c);
}

function stopPos(s) {
  var loc = s && s.location;
  var lat = loc ? +loc.latitude : NaN;
  var lon = loc ? +loc.longitude : NaN;
  if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) return null;
  return { lat: lat, lon: lon };
}

// is `small` an in-order subsequence of `big`?
function subsequence(small, big) {
  var j = 0;
  for (var i = 0; i < big.length && j < small.length; i++) if (big[i] === small[j]) j++;
  return j === small.length;
}

function createBvg(opts, http, deps) {
  opts = opts || {};
  deps = deps || {};
  var baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '') || DEFAULT_BASE_URL;
  var center = opts.center && isFinite(+opts.center.lat) && isFinite(+opts.center.lon) ? { lat: +opts.center.lat, lon: +opts.center.lon } : null;
  var clock = deps.clock || function () { return Math.floor(new Date().getTime() / 1000); };
  var storage = deps.storage || null;

  function now() { return Math.floor(clock()); }

  // ------------------------------------------------------------ request queue
  var inFlight = 0;
  var queue = [];

  function pump() {
    while (inFlight < MAX_IN_FLIGHT && queue.length) start(queue.shift());
  }

  function start(job) {
    inFlight++;
    var finished = false;
    function finish(err, body) {
      if (finished) return;
      finished = true;
      inFlight--;
      try {
        job.cb(err, body);
      } finally {
        pump();
      }
    }
    try {
      http(job.url, finish);
    } catch (e) {
      setTimeout(function () { finish(toError(e)); }, 0);
    }
  }

  // GET path, check for a hafas-rest-api error body, map; cb(err, value) (mapping errors reach cb)
  function get(path, map, cb) {
    queue.push({
      url: baseUrl + path,
      cb: function (err, body) {
        if (err) return cb(toError(err));
        if (body == null || typeof body !== 'object') return cb(new Error('empty response'));
        if (!(body instanceof Array) && typeof body.message === 'string' &&
            (body.isHafasError || body.code !== undefined || body.error)) {
          return cb(new Error(body.message));
        }
        var value;
        try {
          value = map(body);
        } catch (e) {
          return cb(toError(e));
        }
        cb(null, value);
      }
    });
    pump();
  }

  function table() { return { done: {}, pending: {} }; }

  // one fetch for concurrent callers of a key; kept for the provider's lifetime unless keep === false
  function shared(t, key, fn, cb) {
    if (t.done.hasOwnProperty(key)) return later(cb, null, t.done[key]);
    if (t.pending.hasOwnProperty(key)) {
      t.pending[key].push(cb);
      return;
    }
    var waiters = [cb];
    t.pending[key] = waiters;
    fn(function (err, value, keep) {
      delete t.pending[key];
      if (!err && keep !== false) t.done[key] = value;
      for (var i = 0; i < waiters.length; i++) {
        try {
          waiters[i](err, value);
        } catch (e) {
          // one waiter's failure must not stop the others
        }
      }
    });
  }

  // ------------------------------------------------------------ storage cache
  function cacheGet(key, ttl) {
    if (!storage) return null;
    try {
      var raw = storage.getItem(CACHE_PREFIX + key);
      if (!raw) return null;
      var entry = JSON.parse(raw);
      if (!entry || typeof entry.t !== 'number' || entry.v == null) return null;
      var t = now();
      if (t - entry.t >= ttl || entry.t > t + 86400) return null;
      return entry.v;
    } catch (e) {
      return null;
    }
  }

  function cacheSet(key, value) {
    if (!storage) return;
    try {
      storage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: now(), v: value }));
    } catch (e) {
      // best effort
    }
  }

  // stops seen in any response: id → {id, name, lat, lon} (answers stopInfo without a request)
  var knownStops = {};

  function remember(s) {
    if (!s || s.id == null) return null;
    var p = stopPos(s);
    if (!p) return null;
    var st = { id: String(s.id), name: cleanName(s.name), lat: round6(p.lat), lon: round6(p.lon) };
    knownStops[st.id] = st;
    return st;
  }

  // /locations/nearby entries → [{id, name, lat, lon, routeIds, d}] (stops with a position only)
  function mapNearby(body, pos) {
    if (!(body instanceof Array)) throw new Error('bad response');
    var out = [];
    var seen = {};
    for (var i = 0; i < body.length; i++) {
      var s = body[i];
      if (!s || (s.type !== 'stop' && s.type !== 'station')) continue;
      var st = remember(s);
      if (!st || seen.hasOwnProperty(st.id)) continue;
      seen[st.id] = true;
      var routeIds = [];
      var lines = s.lines || [];
      for (var k = 0; k < lines.length; k++) {
        var key = routeKey(lines[k]);
        if (key && routeIds.indexOf(key) < 0) routeIds.push(key);
      }
      out.push({ id: st.id, name: st.name, lat: st.lat, lon: st.lon, routeIds: routeIds,
                 lines: lines, d: pos ? geo.distance(pos, st) : 0 });
    }
    return out;
  }

  function nearbyPath(pos, radius, results) {
    return '/locations/nearby?latitude=' + pos.lat + '&longitude=' + pos.lon + '&distance=' + radius +
      '&results=' + results + '&stops=true&poi=false&linesOfStops=true&pretty=false';
  }

  // ------------------------------------------------------------ stopsNear
  var nearbyMemo = {}; // path → {t, list}

  function stopsNear(pos, radiusMeters, cb) {
    cb = once(cb);
    var r = Math.max(1, Math.round(+radiusMeters || 0));
    var q = { lat: Math.round(+pos.lat * 1e4) / 1e4, lon: Math.round(+pos.lon * 1e4) / 1e4 };
    if (!isFinite(q.lat) || !isFinite(q.lon)) return later(cb, new Error('bad position'));
    var path = nearbyPath(q, r, NEARBY_RESULTS);
    var memo = nearbyMemo[path];
    if (memo && now() - memo.t < NEARBY_TTL && memo.t <= now()) return later(cb, null, finish(memo.list));
    get(path, function (body) { return mapNearby(body, null); }, function (err, list) {
      if (err) return cb(err);
      nearbyMemo[path] = { t: now(), list: list };
      cb(null, finish(list));
    });

    function finish(list) {
      var found = [];
      for (var i = 0; i < list.length; i++) {
        var d = geo.distance(pos, list[i]);
        if (!(d <= r)) continue;
        found.push({ d: d, stop: { id: list[i].id, name: list[i].name, lat: list[i].lat, lon: list[i].lon, routeIds: list[i].routeIds.slice() } });
      }
      found = sortBy(found, function (x) { return x.d; });
      var out = [];
      for (var k = 0; k < found.length; k++) out.push(found[k].stop);
      return out;
    }
  }

  // ------------------------------------------------------------ arrivals
  function arrivals(stopId, minutesBefore, minutesAfter, cb) {
    cb = once(cb);
    var sid = String(stopId);
    var before = Math.max(0, +minutesBefore || 0);
    var after = Math.max(0, +minutesAfter || 0);
    var t = now();
    var lo = t - Math.round(before * 60);
    var hi = t + Math.round(after * 60);
    var duration = Math.max(1, Math.ceil(before + after));
    get('/stops/' + encodeURIComponent(sid) + '/departures?when=' + lo + '&duration=' + duration +
        '&linesOfStops=false&remarks=false&pretty=false', function (body) {
      var list = body.departures;
      if (!(list instanceof Array)) throw new Error('bad response');
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var d = list[i];
        if (!d || d.cancelled || d.tripId == null) continue;
        // the API also lists departures of neighbouring stops of the same station; keep this stop's own
        if (d.stop && d.stop.id != null && String(d.stop.id) !== sid) continue;
        var routeId = routeKey(d.line);
        if (!routeId) continue;
        var time = parseTime(d.when || d.plannedWhen);
        if (!(time >= lo && time <= hi)) continue;
        out.push({
          stopId: sid,
          routeId: routeId,
          tripKey: String(d.tripId),
          time: time,
          predicted: typeof d.delay === 'number',
          headsign: cleanName(d.direction || (d.destination && d.destination.name) || '')
        });
      }
      return sortBy(out, function (a) { return a.time; });
    }, cb);
  }

  // ------------------------------------------------------------ route
  var builtRoutes = table();

  // the next 11:00 UTC (around noon in Berlin) after t, for lines that are not running right now
  function nextNoon(t) {
    var day = Math.floor(t / 86400) * 86400 + 11 * 3600;
    return day > t ? day : day + 86400;
  }

  function tripsPath(name, from) {
    return '/trips?lineName=' + encodeURIComponent(name) + '&fromWhen=' + from + '&untilWhen=' + (from + TRIP_WINDOW) +
      '&stopovers=false&remarks=false&subStops=false&entrances=false&pretty=false';
  }

  // trips of the line routeId in a time window: [{id, origin, destination}]
  function findTrips(routeId, name, from, cb) {
    get(tripsPath(name, from), function (body) {
      var list = body.trips;
      if (!(list instanceof Array)) throw new Error('bad response');
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        if (!t || t.id == null || !t.origin || !t.destination || routeKey(t.line) !== routeId) continue;
        out.push({ id: String(t.id), origin: String(t.origin.id), destination: String(t.destination.id) });
      }
      return out;
    }, cb);
  }

  // one representative trip per origin→destination pattern, most frequent first
  function patterns(trips) {
    var groups = {};
    var order = [];
    for (var i = 0; i < trips.length; i++) {
      var k = trips[i].origin + '>' + trips[i].destination;
      if (!groups.hasOwnProperty(k)) {
        groups[k] = { key: k, trip: trips[i], n: 0 };
        order.push(groups[k]);
      }
      groups[k].n++;
    }
    order = sortBy(order, function (g) { return -g.n; });
    return order.slice(0, MAX_PATTERNS);
  }

  function mapTrip(body) {
    var trip = body.trip;
    if (!trip || !(trip.stopovers instanceof Array)) throw new Error('bad response');
    var stopIds = [];
    var stops = {};
    var stopPath = [];
    for (var i = 0; i < trip.stopovers.length; i++) {
      var so = trip.stopovers[i];
      if (!so || so.cancelled) continue;
      var st = remember(so.stop);
      if (!st) continue;
      if (stopIds.length && stopIds[stopIds.length - 1] === st.id) continue;
      stopIds.push(st.id);
      stops[st.id] = st;
      stopPath.push({ lat: st.lat, lon: st.lon });
    }
    var path = [];
    var feats = (trip.polyline && trip.polyline.features) || [];
    for (var k = 0; k < feats.length; k++) {
      var g = feats[k] && feats[k].geometry;
      var c = g && g.type === 'Point' && g.coordinates;
      if (!c || !isFinite(+c[0]) || !isFinite(+c[1])) continue;
      var p = { lat: round6(+c[1]), lon: round6(+c[0]) };
      if (path.length && k < feats.length - 1 && geo.distance(path[path.length - 1], p) < PATH_STEP) continue;
      path.push(p);
    }
    if (path.length < 2) path = stopPath;
    var origin = trip.origin ? String(trip.origin.id) : stopIds[0];
    var dest = trip.destination ? String(trip.destination.id) : stopIds[stopIds.length - 1];
    var name = trip.direction || (trip.destination && trip.destination.name) ||
      (stopIds.length ? stops[stopIds[stopIds.length - 1]].name : '');
    return {
      direction: { id: origin + '>' + dest, name: directionName(name), stopIds: stopIds, paths: [path] },
      stops: stops,
      line: trip.line,
      from: trip.origin ? cleanName(trip.origin.name) : '',
      to: trip.destination ? cleanName(trip.destination.name) : ''
    };
  }

  function buildRoute(routeId, done) {
    var k = parseKey(routeId);
    if (!k) return later(done, new Error('unknown route ' + routeId));
    var t = now();
    findTrips(routeId, k.name, t, function (err, trips) {
      if (err) return done(err);
      if (trips.length) return fetchPatterns(trips);
      findTrips(routeId, k.name, nextNoon(t), function (err2, trips2) {
        if (err2) return done(err2);
        if (!trips2.length) return done(new Error('no trips found for route ' + routeId));
        fetchPatterns(trips2);
      });
    });

    function fetchPatterns(trips) {
      var pats = patterns(trips);
      var results = [];
      var remaining = pats.length;
      var lastErr = null;
      for (var i = 0; i < pats.length; i++) {
        (function (i) {
          get('/trips/' + encodeURIComponent(pats[i].trip.id) + '?stopovers=true&polyline=true&remarks=false&pretty=false',
            mapTrip, function (e, r) {
              if (e) lastErr = e;
              results[i] = e ? null : r;
              if (--remaining === 0) assemble(results, lastErr);
            });
        })(i);
      }
    }

    function assemble(results, lastErr) {
      var dirs = [];
      var i, j;
      for (i = 0; i < results.length; i++) if (results[i] && results[i].direction.stopIds.length >= 2) dirs.push(results[i]);
      if (!dirs.length) return done(lastErr || new Error('no trips found for route ' + routeId));
      // drop short runs whose stops are part of a longer pattern (depot runs, short turns)
      var keep = [];
      for (i = 0; i < dirs.length; i++) {
        var covered = false;
        for (j = 0; j < dirs.length && !covered; j++) {
          if (i === j) continue;
          var a = dirs[i].direction.stopIds, b = dirs[j].direction.stopIds;
          if (a.length < b.length || (a.length === b.length && j < i)) covered = subsequence(a, b);
        }
        if (!covered) keep.push(dirs[i]);
      }
      var stops = {};
      var directions = [];
      for (i = 0; i < keep.length; i++) {
        directions.push(keep[i].direction);
        for (var sid in keep[i].stops) if (keep[i].stops.hasOwnProperty(sid)) stops[sid] = keep[i].stops[sid];
      }
      var first = keep[0];
      var label = productLabel(k.product);
      var ends = first.from && first.to ? first.from + ' - ' + first.to : '';
      var route = {
        id: routeId,
        shortName: (first.line && first.line.name) ? trim(first.line.name) : k.name,
        longName: label && ends ? label + ': ' + ends : (label || ends),
        color: lineColor(k),
        directions: directions,
        stops: stops
      };
      var complete = !lastErr;
      if (complete) cacheSet('route.' + routeId, route);
      done(null, route, complete);
    }
  }

  function route(routeId, cb) {
    cb = once(cb);
    var id = String(routeId);
    if (!builtRoutes.done.hasOwnProperty(id)) {
      var cached = cacheGet('route.' + id, ROUTE_TTL);
      if (cached) return later(cb, null, cached);
    }
    shared(builtRoutes, id, function (done) {
      try {
        buildRoute(id, done);
      } catch (e) {
        done(toError(e));
      }
    }, cb);
  }

  // ------------------------------------------------------------ vehicles (radar over the route's bounding box)
  function vehicles(routeId, cb) {
    cb = once(cb);
    var id = String(routeId);
    route(id, function (err, r) {
      if (err) return cb(err);
      var n = -90, s = 90, e = -180, w = 180, any = false;
      for (var sid in r.stops) {
        if (!r.stops.hasOwnProperty(sid)) continue;
        var st = r.stops[sid];
        any = true;
        if (st.lat > n) n = st.lat;
        if (st.lat < s) s = st.lat;
        if (st.lon > e) e = st.lon;
        if (st.lon < w) w = st.lon;
      }
      if (!any) return cb(null, []);
      var m = 0.01;
      get('/radar?north=' + round6(n + m) + '&west=' + round6(w - m) + '&south=' + round6(s - m) + '&east=' + round6(e + m) +
          '&results=256&duration=30&frames=1&polylines=false&pretty=false', function (body) {
        var list = body.movements;
        if (!(list instanceof Array)) throw new Error('bad response');
        var t = +body.realtimeDataUpdatedAt > 0 ? Math.floor(+body.realtimeDataUpdatedAt) : now();
        var out = [];
        for (var i = 0; i < list.length; i++) {
          var mv = list[i];
          if (!mv || mv.tripId == null || routeKey(mv.line) !== id) continue;
          var lat = mv.location ? +mv.location.latitude : NaN;
          var lon = mv.location ? +mv.location.longitude : NaN;
          if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) continue;
          out.push({ tripKey: String(mv.tripId), routeId: id, directionId: pickDirection(r, mv.direction, { lat: lat, lon: lon }),
                     lat: lat, lon: lon, time: t });
        }
        return out;
      }, cb);
    });
  }

  // the direction a vehicle heading for `headsign` at p runs in: those named like the headsign (else all), nearest path
  function pickDirection(r, headsign, p) {
    var name = directionName(headsign || '');
    var cands = [];
    var i;
    for (i = 0; i < r.directions.length; i++) if (name && r.directions[i].name === name) cands.push(r.directions[i]);
    if (!cands.length) cands = r.directions;
    if (cands.length === 1) return cands[0].id;
    var best = '', bestD = Infinity;
    for (i = 0; i < cands.length; i++) {
      var d = geo.distanceToPaths(p, cands[i].paths);
      if (d < bestD) { bestD = d; best = cands[i].id; }
    }
    return best;
  }

  // ------------------------------------------------------------ catalog (settings page)
  var tiles = table();

  function loadTile(pos, cb) {
    var path = nearbyPath({ lat: round6(pos.lat), lon: round6(pos.lon) }, CATALOG_RADIUS, CATALOG_RESULTS);
    shared(tiles, path, function (done) {
      get(path, function (body) { return mapNearby(body, null); }, done);
    }, cb);
  }

  function lineRoutes(list, routes, seen) {
    for (var i = 0; i < list.length; i++) {
      var lines = list[i].lines || [];
      for (var k = 0; k < lines.length; k++) {
        var key = routeKey(lines[k]);
        if (!key || seen.hasOwnProperty(key)) continue;
        seen[key] = true;
        routes.push({ id: key, shortName: trim(lines[k].name), longName: productLabel(lines[k].product) });
      }
    }
  }

  // the lines of the stops within CATALOG_RADIUS of the map centre: [{id, label}]
  function listRoutes(cb) {
    cb = once(cb);
    if (!center) return later(cb, new Error('no map centre to list routes around'));
    loadTile(center, function (err, list) {
      if (err) return cb(err);
      var routes = [];
      lineRoutes(list, routes, {});
      var out = [];
      for (var i = 0; i < routes.length; i++) {
        out.push({ id: routes[i].id, label: routes[i].shortName + (routes[i].longName ? ' ' + routes[i].longName : '') });
      }
      cb(null, out);
    });
  }

  function routeInfo(routeId, cb) {
    route(routeId, cb);
  }

  function stopInfo(stopId, cb) {
    cb = once(cb);
    var id = String(stopId);
    if (knownStops.hasOwnProperty(id)) {
      var k = knownStops[id];
      return later(cb, null, { id: k.id, name: k.name, lat: k.lat, lon: k.lon });
    }
    get('/stops/' + encodeURIComponent(id) + '?linesOfStops=false&pretty=false', function (body) {
      var st = remember(body);
      if (!st) throw new Error('no coordinates for stop ' + id);
      return { id: st.id, name: st.name, lat: st.lat, lon: st.lon };
    }, cb);
  }

  // The network (≈13 000 VBB stops, no line list endpoint) is too big to crawl politely, so the catalog covers 7
  // /locations/nearby tiles (the map centre and 6 around it, CATALOG_RING apart; ≤ 1000 stops each, with their lines).
  function catalog(cb, onProgress) {
    cb = once(cb);
    if (!center) return later(cb, new Error('no map centre to build the catalog around'));
    var centres = [center];
    for (var b = 0; b < 360; b += 60) centres.push(geo.offset(center, CATALOG_RING, b));
    var total = centres.length, count = 0, ok = 0, lastErr = null;
    var lists = [];
    for (var i = 0; i < centres.length; i++) {
      (function (i) {
        loadTile(centres[i], function (err, list) {
          if (err) lastErr = err;
          else ok++;
          lists[i] = err ? [] : list;
          count++;
          if (typeof onProgress === 'function') {
            try { onProgress(count, total); } catch (e) { /* ignore */ }
          }
          if (count === total) finish();
        });
      })(i);
    }

    function finish() {
      if (!ok) return cb(lastErr || new Error('no stops'));
      var routes = [], seenRoutes = {}, stops = [], seenStops = {};
      for (var i = 0; i < lists.length; i++) {
        lineRoutes(lists[i], routes, seenRoutes);
        for (var k = 0; k < lists[i].length; k++) {
          var s = lists[i][k];
          if (seenStops.hasOwnProperty(s.id)) continue;
          seenStops[s.id] = true;
          stops.push({ id: s.id, name: s.name, routeIds: s.routeIds.slice(), lat: s.lat, lon: s.lon });
        }
      }
      cb(null, { routes: routes, stops: stops });
    }
  }

  return { stopsNear: stopsNear, arrivals: arrivals, route: route, vehicles: vehicles,
           listRoutes: listRoutes, routeInfo: routeInfo, stopInfo: stopInfo, catalog: catalog };
}

var plugin = {
  type: 'bvg',
  label: 'BVG (Berlin)',
  area: { lat: 52.52, lon: 13.405, radius: 60000 },   // home area; no API key needed
  create: function (options, ctx) {
    options = options || {};
    ctx = ctx || {};
    return createBvg({ baseUrl: options.baseUrl, center: ctx.center }, ctx.http,
      { clock: ctx.clock, storage: ctx.storage });
  }
};

module.exports = { createBvg: createBvg, DEFAULT_BASE_URL: DEFAULT_BASE_URL, routeKey: routeKey, parseTime: parseTime, plugin: plugin };
