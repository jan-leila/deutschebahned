'use strict';
// CTA (Chicago) provider: Bus Tracker API v3 (BusTime, JSON). ES5 only (runs in PebbleKit JS). See CONTRACTS.md §3.
// Buses only: 'L' trains live in the separate Train Tracker API (own key, station ids, no route geometry).
var geo = require('../../common/geo');
var util = require('../util');

var DEFAULT_BASE_URL = 'https://www.ctabustracker.com/bustime/api/v3';
var MAX_IN_FLIGHT = 4;
var MAX_IDS = 10;                 // getpredictions stpid / getvehicles rt: at most 10 per request
var CACHE_PREFIX = 'busWatch.cta.';
var ROUTE_TTL = 3 * 86400;        // built routes (patterns) in storage; detours change patterns, so not much longer
var LIST_TTL = 7 * 86400;         // the route list
var LIVE_TTL = 20;                // predictions / vehicle positions are reused for 20 s (BusTime updates every ~30 s)
var DROPPED_DYN = { 1: true, 16: true, 17: true, 18: true }; // canceled / invalidated trips (Dynamic Action Types)

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

function trim(s) {
  return String(s == null ? '' : s).replace(/^\s+|\s+$/g, '');
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

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

// ------------------------------------------------------------ Chicago local time → epoch seconds
// US rules (since 2007): DST from the second Sunday of March 02:00 CST (08:00 UTC) to the first Sunday of
// November 02:00 CDT (07:00 UTC). Only Date.UTC is used, so the phone's own time zone never matters.
function nthSunday(year, month, n) {
  var first = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return 1 + (7 - first) % 7 + 7 * (n - 1);
}

function chicagoDst(epoch) {
  var y = new Date(epoch * 1000).getUTCFullYear();
  var start = Date.UTC(y, 2, nthSunday(y, 2, 2), 8) / 1000;
  var end = Date.UTC(y, 10, nthSunday(y, 10, 1), 7) / 1000;
  return epoch >= start && epoch < end;
}

// "YYYYMMDD HH:MM" or "YYYYMMDD HH:MM:SS" (Chicago wall time), or Unix milliseconds → epoch s; NaN if unreadable.
// The repeated hour in November is resolved to the instant nearest `ref` (epoch s; default: the first one);
// a time in the skipped March hour is read as standard time.
function chicagoTime(text, ref) {
  var s = trim(text);
  if (/^\d{11,}$/.test(s)) return Math.floor(+s / 1000);
  var m = s.match(/^(\d{4})(\d{2})(\d{2}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return NaN;
  var wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0) / 1000;
  var cdt = wall + 5 * 3600;
  var cst = wall + 6 * 3600;
  var cdtOk = chicagoDst(cdt);
  var cstOk = !chicagoDst(cst);
  if (cdtOk && cstOk) {
    if (typeof ref === 'number' && isFinite(ref)) return Math.abs(cst - ref) < Math.abs(cdt - ref) ? cst : cdt;
    return cdt;
  }
  return cdtOk ? cdt : cst;
}

// ------------------------------------------------------------ the provider
function createCta(opts, http, deps) {
  opts = opts || {};
  deps = deps || {};
  var baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '') || DEFAULT_BASE_URL;
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

  function now() { return Math.floor(clock()); }

  function keyMissing() {
    return new Error('CTA Bus Tracker needs an API key (request one at ctabustracker.com, then enter it in this system\'s settings)');
  }

  // ---------------------------------------------------------- request queue (max 4 in flight)
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

  // GET {base}/{fn}?key=K&format=json&{params}; cb(err, {data: bustime-response, errors: [entry], global: Error|null})
  // `global` = the first error entry that names no stop / route / vehicle / pattern (key, limit, server errors).
  function call(fn, params, cb) {
    var url = baseUrl + '/' + fn + '?key=' + encodeURIComponent(apiKey) + '&format=json' + (params ? '&' + params : '');
    queue.push({
      url: url,
      cb: function (err, body) {
        if (err) return cb(toError(err));
        var data = body && typeof body === 'object' ? body['bustime-response'] : null;
        if (!data || typeof data !== 'object') return cb(new Error('bad response from CTA Bus Tracker'));
        var errors = data.error instanceof Array ? data.error : (data.error ? [data.error] : []);
        var global = null;
        for (var i = 0; i < errors.length; i++) {
          var e = errors[i] || {};
          if (e.stpid == null && e.rt == null && e.vid == null && e.pid == null) {
            global = new Error(trim(e.msg) || 'CTA Bus Tracker error');
            break;
          }
        }
        cb(null, { data: data, errors: errors, global: global });
      }
    });
    pump();
  }

  // a call whose only interesting outcome is all-or-nothing: any error entry fails it
  function callStrict(fn, params, map, cb) {
    call(fn, params, function (err, res) {
      if (err) return cb(err);
      if (res.global) return cb(res.global);
      var value;
      try {
        value = map(res.data, res.errors);
      } catch (e) {
        return cb(toError(e));
      }
      cb(null, value);
    });
  }

  function idList(ids) {
    var out = [];
    for (var i = 0; i < ids.length; i++) out.push(encodeURIComponent(ids[i]));
    return out.join(',');
  }

  // ---------------------------------------------------------- shared loads + storage cache
  function table() { return { done: {}, pending: {} }; }

  function shared(t, key, fn, cb) {
    if (t.done.hasOwnProperty(key)) return later(cb, null, t.done[key]);
    if (t.pending.hasOwnProperty(key)) {
      t.pending[key].push(cb);
      return;
    }
    var waiters = [cb];
    t.pending[key] = waiters;
    fn(function (err, value) {
      delete t.pending[key];
      if (!err) t.done[key] = value;
      for (var i = 0; i < waiters.length; i++) {
        try {
          waiters[i](err, value);
        } catch (e) {
          // one waiter's failure must not stop the others
        }
      }
    });
  }

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
      // storage full / unavailable: caching is best effort
    }
  }

  // ---------------------------------------------------------- batching of per-id live calls
  // get(id, cb(err, rawList)): calls made in the same tick are sent together, up to MAX_IDS ids per request;
  // results are reused for LIVE_TTL seconds. fetch(ids, done(err, {id: list}, {id: Error})).
  function batcher(fetch) {
    var cache = {};     // id -> {t, v}
    var waiting = {};   // id -> [cb]  (queued or in flight)
    var queued = [];
    var scheduled = false;

    function flush() {
      scheduled = false;
      var ids = queued;
      queued = [];
      for (var i = 0; i < ids.length; i += MAX_IDS) send(ids.slice(i, i + MAX_IDS));
    }

    function send(ids) {
      fetch(ids, function (err, lists, errors) {
        for (var i = 0; i < ids.length; i++) {
          var id = ids[i];
          var cbs = waiting[id] || [];
          delete waiting[id];
          var e = err || (errors && errors[id]) || null;
          var v = e ? null : (lists && lists[id]) || [];
          if (!e) cache[id] = { t: now(), v: v };
          for (var k = 0; k < cbs.length; k++) {
            try {
              cbs[k](e, v);
            } catch (x) {
              // keep delivering
            }
          }
        }
      });
    }

    return function get(id, cb) {
      var c = cache[id];
      if (c && now() - c.t < LIVE_TTL && now() >= c.t) return later(cb, null, c.v);
      if (waiting.hasOwnProperty(id)) {
        waiting[id].push(cb);
        return;
      }
      waiting[id] = [cb];
      queued.push(id);
      if (!scheduled) {
        scheduled = true;
        setTimeout(flush, 0);
      }
    };
  }

  // per-item error entries: "No service scheduled" / "No arrival times" just mean nothing is coming
  function itemError(e) {
    var msg = trim(e && e.msg);
    if (/^no (arrival times|service scheduled)/i.test(msg)) return null;
    return new Error(msg || 'CTA Bus Tracker error');
  }

  var predictionsFor = batcher(function (ids, done) {
    call('getpredictions', 'stpid=' + idList(ids) + '&tmres=s', function (err, res) {
      if (err) return done(err);
      if (res.global) return done(res.global);
      var lists = {};
      var errors = {};
      var prd = res.data.prd instanceof Array ? res.data.prd : [];
      var i;
      for (i = 0; i < prd.length; i++) {
        if (!prd[i] || prd[i].stpid == null) continue;
        var sid = String(prd[i].stpid);
        (lists[sid] = lists[sid] || []).push(prd[i]);
      }
      for (i = 0; i < res.errors.length; i++) {
        var e = res.errors[i];
        if (!e || e.stpid == null) continue;
        var ie = itemError(e);
        if (ie && !lists.hasOwnProperty(String(e.stpid))) errors[String(e.stpid)] = ie;
      }
      done(null, lists, errors);
    });
  });

  var vehiclesFor = batcher(function (ids, done) {
    call('getvehicles', 'rt=' + idList(ids) + '&tmres=s', function (err, res) {
      if (err) return done(err);
      if (res.global) return done(res.global);
      var lists = {};
      var list = res.data.vehicle instanceof Array ? res.data.vehicle : [];
      for (var i = 0; i < list.length; i++) {
        if (!list[i] || list[i].rt == null) continue;
        var rt = String(list[i].rt);
        (lists[rt] = lists[rt] || []).push(list[i]);
      }
      // per-route errors ("No data found for parameter") = no buses on that route right now
      done(null, lists, {});
    });
  });

  // one run of a trip: route + BusTime trip id + scheduled start date (the same in predictions and vehicles)
  function tripKey(x) {
    var trip = trim(x.tatripid);
    if (trip) return String(x.rt) + '/' + trip + (trim(x.stsd) ? '@' + trim(x.stsd) : '');
    return String(x.rt) + '/v' + trim(x.vid) + '/' + trim(x.tablockid);
  }

  // ---------------------------------------------------------- arrivals
  function arrivals(stopId, minutesBefore, minutesAfter, cb) {
    cb = once(cb);
    if (!apiKey) return later(cb, keyMissing());
    var sid = String(stopId);
    predictionsFor(sid, function (err, prd) {
      if (err) return cb(err);
      var t = now();
      var lo = t - (+minutesBefore || 0) * 60;
      var hi = t + (+minutesAfter || 0) * 60;
      var out = [];
      for (var i = 0; i < prd.length; i++) {
        var p = prd[i];
        if (DROPPED_DYN[+p.dyn]) continue;
        var time = chicagoTime(p.prdtm, t);
        if (!(time >= lo && time <= hi)) continue;
        out.push({
          stopId: sid,
          routeId: String(p.rt),
          tripKey: tripKey(p),
          time: time,
          predicted: true,
          headsign: trim(p.des)
        });
      }
      cb(null, sortBy(out, function (a) { return a.time; }));
    });
  }

  // ---------------------------------------------------------- vehicles
  var patternDirs = {};   // pid -> direction id (from every pattern list seen)

  function vehicles(routeId, cb) {
    cb = once(cb);
    if (!apiKey) return later(cb, keyMissing());
    var rid = String(routeId);
    var built = builtRoutes.done.hasOwnProperty(rid) ? null : cacheGet('route.' + rid, ROUTE_TTL);
    if (built) rememberPids(built.pids);
    vehiclesFor(rid, function (err, list) {
      if (err) return cb(err);
      var out = [];
      var ref = now();
      for (var i = 0; i < list.length; i++) {
        var v = list[i];
        var lat = +v.lat;
        var lon = +v.lon;
        var time = chicagoTime(v.tmstmp, ref);
        if (!lat || !lon || !isFinite(lat) || !isFinite(lon) || !isFinite(time)) continue;
        out.push({
          tripKey: tripKey(v),
          routeId: String(v.rt),
          directionId: patternDirs.hasOwnProperty(String(v.pid)) ? patternDirs[String(v.pid)] : '',
          lat: lat,
          lon: lon,
          time: time
        });
      }
      cb(null, out);
    });
  }

  function rememberPids(pids) {
    for (var p in pids) if (pids.hasOwnProperty(p)) patternDirs[p] = pids[p];
  }

  // ---------------------------------------------------------- route list
  var routeList = table();

  // [{id, shortName, longName, color}] from getroutes; fetched once per provider, stored for 7 days
  function loadRouteList(cb) {
    shared(routeList, 'all', function (done) {
      var cached = cacheGet('routes', LIST_TTL);
      if (cached) return later(done, null, cached);
      callStrict('getroutes', '', function (data) {
        var list = data.routes instanceof Array ? data.routes : [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
          var r = list[i];
          if (!r || r.rt == null || r.rt === '') continue;
          out.push({ id: String(r.rt), shortName: trim(r.rtdd) || String(r.rt), longName: trim(r.rtnm), color: util.color(r.rtclr) });
        }
        return out;
      }, function (err, list) {
        if (!err) cacheSet('routes', list);
        done(err, list);
      });
    }, cb);
  }

  function routeMeta(list, id) {
    for (var i = 0; list && i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  // ---------------------------------------------------------- route (getpatterns?rt=)
  // patterns of one route: [{pid, dir, detour, stops: [{id, name, lat, lon}], points: [{lat, lon}]}] in API order
  function loadPatterns(routeId, cb) {
    callStrict('getpatterns', 'rt=' + encodeURIComponent(routeId), function (data) {
      var ptr = data.ptr instanceof Array ? data.ptr : [];
      var out = [];
      for (var i = 0; i < ptr.length; i++) {
        var p = ptr[i];
        if (!p || !(p.pt instanceof Array)) continue;
        var pts = sortBy(p.pt, function (x) { return +x.seq || 0; });
        var stops = [];
        var points = [];
        for (var k = 0; k < pts.length; k++) {
          var lat = +pts[k].lat;
          var lon = +pts[k].lon;
          if (!isFinite(lat) || !isFinite(lon) || (!lat && !lon)) continue;
          var pt = { lat: round6(lat), lon: round6(lon) };
          var last = points[points.length - 1];
          if (!last || last.lat !== pt.lat || last.lon !== pt.lon) points.push(pt);
          if (pts[k].typ === 'S' && pts[k].stpid != null && pts[k].stpid !== '') {
            stops.push({ id: String(pts[k].stpid), name: trim(pts[k].stpnm), lat: pt.lat, lon: pt.lon });
          }
        }
        var dir = trim(p.rtdir);
        out.push({ pid: String(p.pid), dir: dir, detour: !!p.dtrid, stops: stops, points: points });
        patternDirs[String(p.pid)] = dir;
      }
      if (!out.length) throw new Error('no patterns for route ' + routeId);
      return out;
    }, cb);
  }

  // inserts the stops of `ids` missing from `merged` after the nearest preceding stop already in it
  function mergeStops(merged, ids) {
    var at = -1;
    for (var i = 0; i < ids.length; i++) {
      var k = merged.indexOf(ids[i]);
      if (k >= 0) {
        at = k;
        continue;
      }
      merged.splice(at + 1, 0, ids[i]);
      at++;
    }
  }

  function buildRoute(routeId, patterns, meta) {
    var dirOrder = [];
    var byDir = {};
    var pids = {};
    var stops = {};
    var i, k;
    for (i = 0; i < patterns.length; i++) {
      var p = patterns[i];
      pids[p.pid] = p.dir;
      if (!byDir.hasOwnProperty(p.dir)) {
        byDir[p.dir] = [];
        dirOrder.push(p.dir);
      }
      byDir[p.dir].push(p);
      for (k = 0; k < p.stops.length; k++) {
        var s = p.stops[k];
        if (!stops.hasOwnProperty(s.id)) stops[s.id] = { id: s.id, name: s.name, lat: s.lat, lon: s.lon };
      }
    }
    var directions = [];
    for (i = 0; i < dirOrder.length; i++) {
      var group = byDir[dirOrder[i]];
      // regular patterns before detours, the one with the most stops first
      var ordered = sortBy(group, function (x) { return (x.detour ? 1e6 : 0) - x.stops.length; });
      var stopIds = [];
      var paths = [];
      for (k = 0; k < ordered.length; k++) {
        var ids = [];
        for (var j = 0; j < ordered[k].stops.length; j++) ids.push(ordered[k].stops[j].id);
        mergeStops(stopIds, ids);
        if (ordered[k].points.length) paths.push(ordered[k].points);
      }
      directions.push({ id: dirOrder[i], name: dirOrder[i], stopIds: stopIds, paths: paths });
    }
    return {
      id: routeId,
      shortName: (meta && meta.shortName) || routeId,
      longName: (meta && meta.longName) || '',
      color: (meta && meta.color) || '',
      directions: directions,
      stops: stops
    };
  }

  var builtRoutes = table();

  function route(routeId, cb) {
    cb = once(cb);
    if (!apiKey) return later(cb, keyMissing());
    var id = String(routeId);
    if (!builtRoutes.done.hasOwnProperty(id)) {
      var cached = cacheGet('route.' + id, ROUTE_TTL);
      if (cached && cached.route) {
        rememberPids(cached.pids);
        builtRoutes.done[id] = cached.route;
        return later(cb, null, cached.route);
      }
    }
    shared(builtRoutes, id, function (done) {
      var meta = null;
      var patterns = null;
      var left = 2;
      var patternErr = null;
      loadRouteList(function (err, list) {
        if (!err) meta = routeMeta(list, id);
        if (--left === 0) finish();
      });
      loadPatterns(id, function (err, ps) {
        patternErr = err;
        patterns = ps;
        if (--left === 0) finish();
      });
      function finish() {
        if (patternErr) return done(patternErr);
        var r;
        try {
          r = buildRoute(id, patterns, meta);
        } catch (e) {
          return done(toError(e));
        }
        var pids = {};
        for (var i = 0; i < patterns.length; i++) pids[patterns[i].pid] = patterns[i].dir;
        cacheSet('route.' + id, { route: r, pids: pids });
        done(null, r);
      }
    }, cb);
  }

  // ---------------------------------------------------------- stopsNear
  function stopsNear(pos, radiusMeters, cb) {
    cb = once(cb);
    if (!apiKey) return later(cb, keyMissing());
    var ids = configuredRoutes;
    if (!ids.length) return later(cb, null, []);
    var results = [];
    var remaining = ids.length;
    var lastErr = null;
    for (var i = 0; i < ids.length; i++) {
      (function (i) {
        route(ids[i], function (err, r) {
          if (err) lastErr = err;
          results[i] = err ? null : r;
          if (--remaining === 0) merge();
        });
      })(i);
    }

    function merge() {
      var anyOk = false;
      var byId = {};
      var found = [];
      try {
        for (var i = 0; i < ids.length; i++) {
          var r = results[i];
          if (!r) continue;
          anyOk = true;
          for (var sid in r.stops) {
            if (!r.stops.hasOwnProperty(sid)) continue;
            var s = r.stops[sid];
            if (byId.hasOwnProperty(sid)) {
              var e = byId[sid];
              if (e.stop.routeIds.indexOf(ids[i]) < 0) e.stop.routeIds.push(ids[i]);
              continue;
            }
            var d = geo.distance(pos, s);
            if (!(d <= radiusMeters)) continue;
            var entry = { d: d, stop: { id: s.id, name: s.name, lat: s.lat, lon: s.lon, routeIds: [ids[i]] } };
            byId[sid] = entry;
            found.push(entry);
          }
        }
      } catch (e) {
        return cb(toError(e));
      }
      if (!anyOk) return cb(lastErr || new Error('no routes'));
      found = sortBy(found, function (x) { return x.d; });
      var out = [];
      for (var k = 0; k < found.length; k++) out.push(found[k].stop);
      cb(null, out);
    }
  }

  // ---------------------------------------------------------- catalog (settings page)
  function listRoutes(cb) {
    cb = once(cb);
    if (!apiKey) return later(cb, keyMissing());
    loadRouteList(function (err, list) {
      if (err) return cb(err);
      var out = [];
      for (var i = 0; i < list.length; i++) {
        out.push({ id: list[i].id, label: list[i].longName ? list[i].shortName + ' ' + list[i].longName : list[i].shortName });
      }
      cb(null, out);
    });
  }

  // getpatterns already carries the stop names and positions, so routeInfo is route()
  function routeInfo(routeId, cb) {
    route(routeId, cb);
  }

  // a stop of a route already built (memory or storage) answers without a request; else getstops?stpid=
  function stopInfo(stopId, cb) {
    cb = once(cb);
    if (!apiKey) return later(cb, keyMissing());
    var id = String(stopId);
    var known = knownStop(id);
    if (known) return later(cb, null, known);
    callStrict('getstops', 'stpid=' + encodeURIComponent(id), function (data) {
      var list = data.stops instanceof Array ? data.stops : [];
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        if (!s || String(s.stpid) !== id) continue;
        var lat = +s.lat;
        var lon = +s.lon;
        if (!isFinite(lat) || !isFinite(lon)) break;
        return { id: id, name: trim(s.stpnm), lat: lat, lon: lon };
      }
      throw new Error('unknown stop ' + id);
    }, cb);
  }

  function knownStop(id) {
    var r;
    for (r in builtRoutes.done) {
      if (builtRoutes.done.hasOwnProperty(r) && builtRoutes.done[r].stops.hasOwnProperty(id)) return copyStop(builtRoutes.done[r].stops[id]);
    }
    for (var i = 0; i < configuredRoutes.length; i++) {
      var c = cacheGet('route.' + configuredRoutes[i], ROUTE_TTL);
      if (c && c.route && c.route.stops && c.route.stops.hasOwnProperty(id)) return copyStop(c.route.stops[id]);
    }
    return null;
  }

  function copyStop(s) {
    return { id: s.id, name: s.name, lat: s.lat, lon: s.lon };
  }

  // getroutes, then getpatterns per route (4 at a time); a route built or stored already is used as it is.
  // Only the stops are kept (patterns of every route would not fit in storage). Failing routes are listed without stops.
  function catalog(cb, onProgress) {
    cb = once(cb);
    if (!apiKey) return later(cb, keyMissing());
    loadRouteList(function (err, list) {
      if (err) return cb(err);
      var total = list.length;
      var count = 0;
      var routes = [];
      var stops = {};
      var order = [];
      if (!total) return cb(null, { routes: [], stops: [] });
      // dir: the pattern direction ('Northbound'); a stop served in two differing directions gets none
      function addStop(s, routeId, dir) {
        if (!stops.hasOwnProperty(s.id)) {
          stops[s.id] = { id: s.id, name: s.name, routeIds: [], lat: s.lat, lon: s.lon };
          order.push(s.id);
        }
        var e = stops[s.id];
        if (!e.name && s.name) e.name = s.name;
        if (e.routeIds.indexOf(routeId) < 0) e.routeIds.push(routeId);
        if (dir) e.dir = e.dir === undefined || e.dir === dir ? dir : '';
      }
      function finished() {
        count++;
        if (typeof onProgress === 'function') {
          try { onProgress(count, total); } catch (e) { /* progress is informational */ }
        }
        if (count < total) return;
        var out = [];
        for (var k = 0; k < order.length; k++) out.push(stops[order[k]]);
        cb(null, { routes: routes, stops: out });
      }
      for (var i = 0; i < list.length; i++) {
        (function (entry) {
          var id = entry.id;
          routes.push({ id: id, shortName: entry.shortName, longName: entry.longName });
          var built = builtRoutes.done.hasOwnProperty(id) ? builtRoutes.done[id] : null;
          if (!built) {
            var c = cacheGet('route.' + id, ROUTE_TTL);
            built = c && c.route;
          }
          if (built) {
            for (var d = 0; d < built.directions.length; d++) {
              var ids = built.directions[d].stopIds;
              for (var k = 0; k < ids.length; k++) if (built.stops[ids[k]]) addStop(built.stops[ids[k]], id, built.directions[d].name);
            }
            return later(finished);
          }
          loadPatterns(id, function (e, patterns) {
            if (!e) {
              for (var p = 0; p < patterns.length; p++) {
                for (var k = 0; k < patterns[p].stops.length; k++) addStop(patterns[p].stops[k], id, patterns[p].dir);
              }
            }
            finished();
          });
        })(list[i]);
      }
    });
  }

  return { stopsNear: stopsNear, arrivals: arrivals, route: route, vehicles: vehicles,
           listRoutes: listRoutes, routeInfo: routeInfo, stopInfo: stopInfo, catalog: catalog };
}

var plugin = {
  type: 'cta',
  label: 'CTA (Chicago)',
  area: { lat: 41.8781, lon: -87.6298, radius: 60000 },
  needsKey: true,
  keyUrl: 'https://www.transitchicago.com/developers/bustracker/',
  create: function (options, ctx) {
    return createCta({ baseUrl: options.baseUrl, apiKey: options.apiKey, routeIds: ctx.routeIds }, ctx.http,
      { clock: ctx.clock, storage: ctx.storage });
  }
};

module.exports = { createCta: createCta, chicagoTime: chicagoTime, DEFAULT_BASE_URL: DEFAULT_BASE_URL, plugin: plugin };
