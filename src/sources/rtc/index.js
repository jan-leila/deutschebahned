'use strict';
// RTC Southern Nevada (Las Vegas) provider: the Swiftly real-time + agency-info JSON API (api.goswift.ly).
// ES5 only (runs in PebbleKit JS). See CONTRACTS.md §3.
//
// RTC publishes its real-time data only through Swiftly; every request needs a Swiftly API key, sent as the
// `Authorization` header. The base URL may name another Swiftly agency (`https://api.goswift.ly/<agencyKey>`),
// so the same plug-in can serve any Swiftly agency; the default is `las-vegas-rtc`.
//
// Ids: route ids are GTFS `route_id`s (Swiftly `routeId` / `id`); Swiftly's `route=` query parameter takes the
// route short name, so the route list (cached) maps one to the other. Stop ids are GTFS `stop_id`s.
var geo = require('../../common/geo');
var util = require('../util');

var DEFAULT_HOST = 'https://api.goswift.ly';
var DEFAULT_AGENCY = 'las-vegas-rtc';
var KEY_URL = 'https://goswift.ly/realtime-api-key';
var MAX_IN_FLIGHT = 3;
var CACHE_PREFIX = 'busWatch.rtc.';
var CACHE_TTL = 7 * 86400; // seconds

function toError(e) {
  return e instanceof Error ? e : new Error(String(e));
}

function trim(s) {
  return String(s == null ? '' : s).replace(/^\s+|\s+$/g, '');
}

// wraps cb so it runs at most once
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

// stable sort by numeric key ascending
function sortBy(arr, key) {
  var tagged = [];
  var i;
  for (i = 0; i < arr.length; i++) tagged.push({ k: key(arr[i]), i: i, v: arr[i] });
  tagged.sort(function (a, b) { return a.k !== b.k ? a.k - b.k : a.i - b.i; });
  var out = [];
  for (i = 0; i < tagged.length; i++) out.push(tagged[i].v);
  return out;
}

function round5(x) {
  return Math.round(+x * 1e5) / 1e5;
}

// '' → defaults; 'https://host' → that host, default agency; 'https://host/<agency>' (also '/real-time/<agency>',
// '/info/<agency>') → that agency. A missing scheme means https.
function parseBase(baseUrl) {
  var raw = trim(baseUrl);
  if (!raw) return { host: DEFAULT_HOST, agency: DEFAULT_AGENCY };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw;
  var m = raw.match(/^([a-z][a-z0-9+.-]*:\/\/[^\/?#]+)([^?#]*)/i);
  if (!m) return { host: DEFAULT_HOST, agency: DEFAULT_AGENCY };
  var segs = m[2].split('/');
  var parts = [];
  for (var i = 0; i < segs.length; i++) if (segs[i] !== '') parts.push(segs[i]);
  while (parts.length && (parts[parts.length - 1] === 'real-time' || parts[parts.length - 1] === 'info')) parts.pop();
  var agency = parts.length ? parts.pop() : DEFAULT_AGENCY;
  while (parts.length && (parts[parts.length - 1] === 'real-time' || parts[parts.length - 1] === 'info')) parts.pop();
  var host = m[1] + (parts.length ? '/' + parts.join('/') : '');
  return { host: host, agency: decodeURIComponent(agency) };
}

function createRtc(opts, http, deps) {
  opts = opts || {};
  deps = deps || {};
  var base = parseBase(opts.baseUrl);
  var host = base.host;
  var agency = base.agency;
  var agencyPath = encodeURIComponent(agency);
  var apiKey = trim(opts.apiKey);
  var configuredRoutes = [];
  (function () {
    var seen = {};
    var ids = opts.routeIds || [];
    for (var i = 0; i < ids.length; i++) {
      if (ids[i] == null) continue;
      var id = String(ids[i]);
      if (id === '' || seen.hasOwnProperty(id)) continue;
      seen[id] = true;
      configuredRoutes.push(id);
    }
  })();
  var clock = deps.clock || function () { return Math.floor(new Date().getTime() / 1000); };
  var storage = deps.storage || null;
  var headers = { Authorization: apiKey };

  function now() { return Math.floor(clock()); }

  function missingKey() {
    return new Error('RTC (Las Vegas) needs a Swiftly API key: request one at ' + KEY_URL +
      ' and enter it as this system\'s API key');
  }

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
      http(job.url, finish, headers);
    } catch (e) {
      setTimeout(function () { finish(toError(e)); }, 0);
    }
  }

  // GET host + path; checks the Swiftly envelope; cb(err, data)
  function get(path, cb) {
    if (!apiKey) return later(cb, missingKey());
    queue.push({
      url: host + path,
      cb: function (err, body) {
        if (err) return cb(toError(err));
        if (body == null || typeof body !== 'object') return cb(new Error('empty response'));
        if (typeof body.errorCode === 'number' || body.errorMessage) {
          var msg = 'Swiftly: ' + (body.errorMessage || 'HTTP ' + body.errorCode);
          if (body.errorCode === 401 || body.errorCode === 403) msg += ' (check the API key; get one at ' + KEY_URL + ')';
          return cb(new Error(msg));
        }
        if (body.success === false) return cb(new Error('Swiftly: request failed'));
        cb(null, body.data || {});
      }
    });
    pump();
  }

  // GET + map; mapping errors reach cb
  function getMapped(path, map, cb) {
    get(path, function (err, data) {
      if (err) return cb(err);
      var value;
      try {
        value = map(data);
      } catch (e) {
        return cb(toError(e));
      }
      cb(null, value);
    });
  }

  // runs fn(done) once for concurrent callers sharing a key; successful results kept for the provider's life
  function shared(table, key, fn, cb) {
    if (table.done.hasOwnProperty(key)) return later(cb, null, table.done[key]);
    if (table.pending.hasOwnProperty(key)) {
      table.pending[key].push(cb);
      return;
    }
    var waiters = [cb];
    table.pending[key] = waiters;
    fn(function (err, value) {
      delete table.pending[key];
      if (!err) table.done[key] = value;
      for (var i = 0; i < waiters.length; i++) {
        try {
          waiters[i](err, value);
        } catch (e) {
          // one waiter's failure must not stop the others
        }
      }
    });
  }

  function table() { return { done: {}, pending: {} }; }

  // ------------------------------------------------------------ storage cache (per agency)
  function cacheKey(key) { return CACHE_PREFIX + agency + '.' + key; }

  function cacheGet(key) {
    if (!storage) return null;
    try {
      var raw = storage.getItem(cacheKey(key));
      if (!raw) return null;
      var entry = JSON.parse(raw);
      if (!entry || typeof entry.t !== 'number' || entry.v == null) return null;
      var t = now();
      if (t - entry.t >= CACHE_TTL || entry.t > t + 86400) return null;
      return entry.v;
    } catch (e) {
      return null;
    }
  }

  function cacheSet(key, value) {
    if (!storage) return;
    try {
      storage.setItem(cacheKey(key), JSON.stringify({ t: now(), v: value }));
    } catch (e) {
      // storage full / unavailable: caching is best effort
    }
  }

  // ------------------------------------------------------------ route list (/info/{agency}/routes)
  var routeList = table();

  // cb(err, [{id, shortName, longName, name}])
  function loadRouteList(cb) {
    shared(routeList, 'all', function (done) {
      var cached = cacheGet('routes');
      if (cached) return later(done, null, cached);
      getMapped('/info/' + agencyPath + '/routes', function (data) {
        var list = data.routes || [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
          var r = list[i];
          if (!r || r.id == null) continue;
          out.push({ id: String(r.id), shortName: trim(r.shortName), longName: trim(r.longName), name: trim(r.name) });
        }
        return out;
      }, function (err, list) {
        if (!err) cacheSet('routes', list);
        done(err, list);
      });
    }, cb);
  }

  // route id → Swiftly route key (short name); falls back to the id itself
  function shortNameOf(routeId, cb) {
    loadRouteList(function (err, list) {
      if (!err) {
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === routeId) return cb(null, list[i].shortName || routeId);
        }
      }
      cb(null, routeId);
    });
  }

  function listRoutes(cb) {
    cb = once(cb);
    loadRouteList(function (err, list) {
      if (err) return cb(err);
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        var label = r.name || trim((r.shortName || r.id) + ' ' + r.longName);
        out.push({ id: r.id, label: label });
      }
      cb(null, out);
    });
  }

  // ------------------------------------------------------------ route (/info/{agency}/routes?route=&verbose=true)
  var builtRoutes = table();

  function buildRoute(routeId, entry) {
    var i, j;
    var stops = {};
    var directions = [];
    var dirs = entry.directions || [];
    var shapes = entry.shapes || [];
    for (i = 0; i < dirs.length; i++) {
      var d = dirs[i];
      if (!d) continue;
      var dirId = String(d.id != null ? d.id : i);
      var stopIds = [];
      var coords = [];
      var list = d.stops || [];
      for (j = 0; j < list.length; j++) {
        var s = list[j];
        if (!s || s.id == null) continue;
        var lat = +s.lat, lon = +s.lon;
        if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) continue;
        var sid = String(s.id);
        stopIds.push(sid);
        coords.push({ lat: lat, lon: lon });
        if (!stops.hasOwnProperty(sid)) stops[sid] = { id: sid, name: trim(s.name), lat: lat, lon: lon };
      }
      var paths = [];
      var seenShapes = {};
      for (j = 0; j < shapes.length; j++) {
        var sh = shapes[j];
        if (!sh || String(sh.directionId) !== dirId) continue;
        var sk = sh.shapeId != null ? 'id:' + sh.shapeId : 'pattern:' + sh.tripPatternId;
        if (seenShapes.hasOwnProperty(sk)) continue;
        seenShapes[sk] = true;
        var path = [];
        var locs = sh.locs || [];
        for (var k = 0; k < locs.length; k++) {
          if (!locs[k]) continue;
          var p = { lat: round5(locs[k].lat), lon: round5(locs[k].lon) };
          if (!isFinite(p.lat) || !isFinite(p.lon)) continue;
          var prev = path[path.length - 1];
          if (prev && prev.lat === p.lat && prev.lon === p.lon) continue;
          path.push(p);
        }
        if (path.length >= 2) paths.push(path);
      }
      if (!paths.length && coords.length >= 2) paths.push(coords);
      var headsigns = d.headsigns || [];
      directions.push({ id: dirId, name: trim(d.title) || trim(headsigns.join(' / ')), stopIds: stopIds, paths: paths });
    }
    return {
      id: routeId,
      shortName: trim(entry.shortName) || routeId,
      longName: trim(entry.longName),
      color: util.color(entry.color),
      directions: directions,
      stops: stops
    };
  }

  function route(routeId, cb) {
    cb = once(cb);
    var id = String(routeId);
    shared(builtRoutes, id, function (done) {
      var cached = cacheGet('route.' + id);
      if (cached) return later(done, null, cached);
      shortNameOf(id, function (e, shortName) {
        getMapped('/info/' + agencyPath + '/routes?route=' + encodeURIComponent(shortName) + '&verbose=true', function (data) {
          var list = data.routes || [];
          var entry = null;
          for (var i = 0; i < list.length; i++) {
            if (list[i] && String(list[i].id) === id) { entry = list[i]; break; }
          }
          if (!entry) {
            for (i = 0; i < list.length; i++) {
              if (list[i] && trim(list[i].shortName) === shortName) { entry = list[i]; break; }
            }
          }
          if (!entry) throw new Error('unknown route ' + id);
          return buildRoute(id, entry);
        }, function (err, built) {
          if (!err) cacheSet('route.' + id, built);
          done(err, built);
        });
      });
    }, cb);
  }

  // ------------------------------------------------------------ arrivals (/real-time/{agency}/predictions?stop=)
  function arrivals(stopId, minutesBefore, minutesAfter, cb) {
    cb = once(cb);
    var sid = String(stopId);
    var after = +minutesAfter || 0;
    // predictions per route / destination: roughly one every 10 minutes over the window, 3..10
    var number = Math.max(3, Math.min(10, Math.ceil(after / 10)));
    getMapped('/real-time/' + agencyPath + '/predictions?stop=' + encodeURIComponent(sid) + '&number=' + number, function (data) {
      var list = data.predictionsData || [];
      var t = now();
      var lo = t - (+minutesBefore || 0) * 60;
      var hi = t + after * 60;
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (!p) continue;
        var dests = p.destinations || [];
        for (var j = 0; j < dests.length; j++) {
          var d = dests[j];
          if (!d) continue;
          var preds = d.predictions || [];
          for (var k = 0; k < preds.length; k++) {
            var x = preds[k];
            if (!x) continue;
            var time = Math.round(+x.time);
            if (!(time >= lo && time <= hi)) continue;
            var tripId = x.tripId != null && x.tripId !== '' ? String(x.tripId) : '';
            out.push({
              stopId: String(p.stopId != null ? p.stopId : sid),
              routeId: String(p.routeId != null ? p.routeId : p.routeShortName),
              tripKey: tripId || String(p.routeId) + '@' + time,
              time: time,
              predicted: x.scheduleBased !== true && x.vehicleId != null && x.vehicleId !== '',
              headsign: trim(d.headsign)
            });
          }
        }
      }
      return sortBy(out, function (a) { return a.time; });
    }, cb);
  }

  // ------------------------------------------------------------ vehicles (/real-time/{agency}/vehicles?route=&verbose=true)
  function vehicles(routeId, cb) {
    cb = once(cb);
    var id = String(routeId);
    if (!apiKey) return later(cb, missingKey());
    shortNameOf(id, function (e, shortName) {
      getMapped('/real-time/' + agencyPath + '/vehicles?route=' + encodeURIComponent(shortName) + '&verbose=true', function (data) {
        var list = data.vehicles || [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
          var v = list[i];
          if (!v || !v.loc) continue;
          var lat = +v.loc.lat, lon = +v.loc.lon, time = Math.round(+v.loc.time);
          if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0) || !(time > 0)) continue;
          var trip = v.trip != null && v.trip !== '' ? v.trip : v.tripId;
          if (trip == null || trip === '') continue; // not on a trip: nothing to match arrivals against
          var dir = v.direction != null ? v.direction : v.directionId;
          out.push({
            tripKey: String(trip),
            routeId: String(v.routeId != null ? v.routeId : id),
            directionId: dir != null ? String(dir) : '',
            lat: lat,
            lon: lon,
            time: time
          });
        }
        return out;
      }, cb);
    });
  }

  // ------------------------------------------------------------ stopsNear: stops of the configured routes
  function stopsNear(pos, radiusMeters, cb) {
    cb = once(cb);
    if (!apiKey) return later(cb, missingKey());
    if (!configuredRoutes.length) return later(cb, null, []);
    var results = [];
    var left = configuredRoutes.length;
    var lastErr = null;
    var ok = 0;
    for (var i = 0; i < configuredRoutes.length; i++) {
      (function (i) {
        route(configuredRoutes[i], function (err, r) {
          if (err) lastErr = err;
          else { ok++; results[i] = r; }
          if (--left) return;
          if (!ok) return cb(lastErr);
          var byId = {};
          var out = [];
          for (var n = 0; n < configuredRoutes.length; n++) {
            var rt = results[n];
            if (!rt) continue;
            for (var sid in rt.stops) {
              if (!rt.stops.hasOwnProperty(sid)) continue;
              var s = rt.stops[sid];
              if (geo.distance(pos, s) > radiusMeters) continue;
              if (!byId.hasOwnProperty(sid)) {
                byId[sid] = { id: sid, name: s.name, lat: s.lat, lon: s.lon, routeIds: [] };
                out.push(byId[sid]);
              }
              if (byId[sid].routeIds.indexOf(configuredRoutes[n]) < 0) byId[sid].routeIds.push(configuredRoutes[n]);
            }
          }
          cb(null, sortBy(out, function (s) { return geo.distance(pos, s); }));
        });
      })(i);
    }
  }

  // ------------------------------------------------------------ stopInfo
  // Swiftly has no stop endpoint: a route already built knows the stop; otherwise /predictions?stop= names the
  // routes serving it and the first of them that loads gives its position.
  function knownStop(sid) {
    for (var id in builtRoutes.done) {
      if (builtRoutes.done.hasOwnProperty(id) && builtRoutes.done[id].stops.hasOwnProperty(sid)) return builtRoutes.done[id].stops[sid];
    }
    for (var i = 0; i < configuredRoutes.length; i++) {
      var c = cacheGet('route.' + configuredRoutes[i]);
      if (c && c.stops && c.stops.hasOwnProperty(sid)) return c.stops[sid];
    }
    return null;
  }

  function stopInfo(stopId, cb) {
    cb = once(cb);
    var sid = String(stopId);
    if (!apiKey) return later(cb, missingKey());
    var known = knownStop(sid);
    if (known) return later(cb, null, { id: sid, name: known.name, lat: known.lat, lon: known.lon });
    getMapped('/real-time/' + agencyPath + '/predictions?stop=' + encodeURIComponent(sid) + '&number=1', function (data) {
      var list = data.predictionsData || [];
      var routeIds = [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].routeId != null && routeIds.indexOf(String(list[i].routeId)) < 0) routeIds.push(String(list[i].routeId));
      }
      return routeIds;
    }, function (err, routeIds) {
      if (err) return cb(err);
      var n = 0;
      (function next() {
        if (n >= routeIds.length) return cb(new Error('unknown stop ' + sid));
        route(routeIds[n++], function (e, r) {
          if (!e && r.stops.hasOwnProperty(sid)) {
            var s = r.stops[sid];
            return cb(null, { id: sid, name: s.name, lat: s.lat, lon: s.lon });
          }
          next();
        });
      })();
    });
  }

  // ------------------------------------------------------------ catalog: route list, then route() per route
  function catalog(cb, onProgress) {
    cb = once(cb);
    loadRouteList(function (err, list) {
      if (err) return cb(err);
      var routes = [];
      var stops = {};
      var order = [];
      var built = [];
      var count = 0;
      var next = 0;
      var running = 0;
      for (var i = 0; i < list.length; i++) {
        routes.push({ id: list[i].id, shortName: list[i].shortName || list[i].id, longName: list[i].longName });
      }
      if (!list.length) return later(cb, null, { routes: [], stops: [] });
      function finish() {
        for (var n = 0; n < built.length; n++) {
          var r = built[n];
          if (!r) continue;
          for (var d = 0; d < r.directions.length; d++) {
            var ids = r.directions[d].stopIds;
            for (var k = 0; k < ids.length; k++) {
              var s = r.stops[ids[k]];
              if (!s) continue;
              if (!stops.hasOwnProperty(s.id)) {
                stops[s.id] = { id: s.id, name: s.name, routeIds: [], lat: s.lat, lon: s.lon };
                order.push(s.id);
              }
              if (stops[s.id].routeIds.indexOf(r.id) < 0) stops[s.id].routeIds.push(r.id);
            }
          }
        }
        var out = [];
        for (var m = 0; m < order.length; m++) out.push(stops[order[m]]);
        cb(null, { routes: routes, stops: out });
      }
      function pumpRoutes() {
        while (running < MAX_IN_FLIGHT && next < routes.length) {
          running++;
          (function (idx) {
            route(routes[idx].id, function (e, r) {
              running--;
              if (!e && r) {
                built[idx] = r;
                if (!routes[idx].longName && r.longName) routes[idx].longName = r.longName;
              }
              count++;
              if (typeof onProgress === 'function') {
                try { onProgress(count, routes.length); } catch (x) { /* ignore */ }
              }
              if (count === routes.length) finish();
              else pumpRoutes();
            });
          })(next++);
        }
      }
      pumpRoutes();
    });
  }

  return { stopsNear: stopsNear, arrivals: arrivals, route: route, vehicles: vehicles,
           listRoutes: listRoutes, routeInfo: route, stopInfo: stopInfo, catalog: catalog };
}

var plugin = {
  type: 'rtc',
  label: 'RTC (Las Vegas)',
  area: { lat: 36.1699, lon: -115.1398, radius: 50000 },
  needsKey: true,
  keyUrl: 'https://goswift.ly/realtime-api-key',
  create: function (options, ctx) {
    options = options || {};
    ctx = ctx || {};
    return createRtc({ baseUrl: options.baseUrl, apiKey: options.apiKey, routeIds: ctx.routeIds }, ctx.http,
      { clock: ctx.clock, storage: ctx.storage });
  }
};

module.exports = { createRtc: createRtc, parseBase: parseBase, DEFAULT_HOST: DEFAULT_HOST, DEFAULT_AGENCY: DEFAULT_AGENCY,
                   plugin: plugin };
