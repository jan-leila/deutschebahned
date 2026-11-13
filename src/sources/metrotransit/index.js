'use strict';
// Metro Transit (Minneapolis–St Paul) provider: NexTrip v2 + Schedule v1 JSON APIs. ES5 only (runs in PebbleKit JS).
// See CONTRACTS.md §3.
var geo = require('../../common/geo');
var util = require('../util');

var DEFAULT_BASE_URL = 'https://svc.metrotransit.org';
var MAX_IN_FLIGHT = 4;
var CACHE_PREFIX = 'busWatch.mt.';
var CACHE_TTL = 7 * 86400; // seconds

function toError(e) {
  return e instanceof Error ? e : new Error(String(e));
}

// wraps cb so it runs at most once and an exception thrown by it never reaches our code paths
function once(cb) {
  var done = false;
  return function (err, value) {
    if (done) return;
    done = true;
    if (typeof cb === 'function') cb(err, value);
  };
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

function createMetroTransit(opts, http, deps) {
  opts = opts || {};
  deps = deps || {};
  var baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '') || DEFAULT_BASE_URL;
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

  // ------------------------------------------------------------ request queue (max 4 in flight)
  var inFlight = 0;
  var queue = [];

  function pump() {
    while (inFlight < MAX_IN_FLIGHT && queue.length) {
      start(queue.shift());
    }
  }

  function start(job) {
    inFlight++;
    var finished = false;
    function finish(err, body) {
      if (finished) return;
      finished = true;
      inFlight--;
      // deliver first, then start queued requests
      try {
        job.cb(err, body);
      } finally {
        pump();
      }
    }
    try {
      http(job.url, finish);
    } catch (e) {
      // http threw synchronously: report asynchronously so callers see a consistent flow
      setTimeout(function () { finish(toError(e)); }, 0);
    }
  }

  // GET a path; checks ProblemDetails bodies; cb(err, body)
  function get(path, cb) {
    queue.push({
      url: baseUrl + path,
      cb: function (err, body) {
        if (err) return cb(toError(err));
        if (body == null || typeof body !== 'object') return cb(new Error('empty response'));
        if (typeof body.status === 'number' && body.status >= 400) {
          return cb(new Error(body.detail || body.title || 'HTTP ' + body.status));
        }
        cb(null, body);
      }
    });
    pump();
  }

  // GET + map; mapping errors reach cb
  function getMapped(path, map, cb) {
    get(path, function (err, body) {
      if (err) return cb(err);
      var value;
      try {
        value = map(body);
      } catch (e) {
        return cb(toError(e));
      }
      cb(null, value);
    });
  }

  // runs fn(done) once for concurrent callers sharing a key; result cached forever when keep(err, value) is true
  function shared(table, key, fn, cb) {
    if (table.done.hasOwnProperty(key)) {
      var v = table.done[key];
      return setTimeout(function () { cb(null, v); }, 0);
    }
    if (table.pending.hasOwnProperty(key)) {
      table.pending[key].push(cb);
      return;
    }
    var waiters = [cb];
    table.pending[key] = waiters;
    fn(function (err, value, keep) {
      delete table.pending[key];
      if (!err && keep !== false) table.done[key] = value;
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

  // ------------------------------------------------------------ storage cache
  function cacheGet(key) {
    if (!storage) return null;
    try {
      var raw = storage.getItem(CACHE_PREFIX + key);
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
      storage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: now(), v: value }));
    } catch (e) {
      // storage full / unavailable: caching is best effort
    }
  }

  // ------------------------------------------------------------ arrivals
  function arrivals(stopId, minutesBefore, minutesAfter, cb) {
    cb = once(cb);
    var sid = String(stopId);
    getMapped('/nextrip/' + encodeURIComponent(sid), function (body) {
      var list = body.departures || [];
      var t = now();
      var lo = t - (+minutesBefore || 0) * 60;
      var hi = t + (+minutesAfter || 0) * 60;
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var d = list[i];
        if (!d) continue;
        var time = +d.departure_time;
        if (!(time >= lo && time <= hi)) continue;
        out.push({
          stopId: String(d.stop_id != null ? d.stop_id : sid),
          routeId: String(d.route_id),
          tripKey: String(d.trip_id),
          time: time,
          predicted: !!d.actual,
          headsign: String(d.description || '').replace(/^\s+|\s+$/g, '')
        });
      }
      return sortBy(out, function (a) { return a.time; });
    }, cb);
  }

  // ------------------------------------------------------------ route
  var scheduleRoutes = table();   // key 'all' -> {routeId: route_url_param}
  var stopCoords = table();       // stopId -> {lat, lon}
  var builtRoutes = table();      // routeId -> Route

  function loadScheduleRoutes(cb) {
    shared(scheduleRoutes, 'all', function (done) {
      getMapped('/schedule/routes', function (body) {
        var map = {};
        var list = body instanceof Array ? body : [];
        for (var i = 0; i < list.length; i++) {
          var r = list[i];
          if (r && r.route_id != null && r.route_url_param != null && r.route_url_param !== '') {
            map[String(r.route_id)] = String(r.route_url_param);
          }
        }
        return map;
      }, done);
    }, cb);
  }

  function loadStopCoord(stopId, cb) {
    shared(stopCoords, stopId, function (done) {
      getMapped('/nextrip/' + encodeURIComponent(stopId), function (body) {
        var s = body.stops && body.stops[0];
        var lat = s ? +s.latitude : NaN;
        var lon = s ? +s.longitude : NaN;
        if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) throw new Error('no coordinates for stop ' + stopId);
        return { lat: lat, lon: lon, name: String(s.description || '').replace(/^\s+|\s+$/g, '') };
      }, done);
    }, cb);
  }

  // steps 1-3 of route(): schedule routes → route details → one stop list per direction (no coordinates).
  // Shared by route() and routeInfo(); kept for the provider's lifetime.
  var routeDetails = table();     // routeId -> {shortName, color, dirs: [{id, name, schedule}], lists: [[{id, name}]]}

  function loadDetails(routeId, cb) {
    shared(routeDetails, routeId, function (done) {
      loadScheduleRoutes(function (err, params) {
        if (err) return done(err);
        if (!params.hasOwnProperty(routeId)) return done(new Error('unknown route ' + routeId));
        getMapped('/schedule/routedetails/' + encodeURIComponent(params[routeId]), function (body) {
          var sched = body.schedules && body.schedules[0];
          var tts = (sched && sched.timetables) || [];
          var dirs = [];
          for (var i = 0; i < tts.length; i++) {
            if (!tts[i] || tts[i].schedule_number == null) continue;
            dirs.push({ id: String(tts[i].direction_id), name: String(tts[i].direction || ''), schedule: String(tts[i].schedule_number) });
          }
          return { shortName: body.route_short_name ? String(body.route_short_name) : routeId,
                   longName: body.route_desc ? String(body.route_desc).replace(/^\s+|\s+$/g, '') : '',
                   color: util.color(body.route_color), dirs: dirs };
        }, function (err, details) {
          if (err) return done(err);
          loadStopLists(routeId, details, done);
        });
      });
    }, cb);
  }

  function buildRoute(routeId, done) {
    loadDetails(routeId, function (err, details) {
      if (err) return done(err);
      finishRoute(routeId, details, details.lists, done);
    });
  }

  function loadStopLists(routeId, details, done) {
    var dirs = details.dirs;
    var lists = [];
    var remaining = dirs.length;
    var failed = false;
    details.lists = lists;
    if (!remaining) return done(null, details);
    for (var i = 0; i < dirs.length; i++) {
      (function (i) {
        getMapped('/schedule/stoplist/' + encodeURIComponent(routeId) + '/' + encodeURIComponent(dirs[i].schedule), function (body) {
          var list = body instanceof Array ? body : [];
          var out = [];
          for (var k = 0; k < list.length; k++) {
            if (list[k] && list[k].stop_id != null) out.push({ id: String(list[k].stop_id), name: String(list[k].stop_name || '') });
          }
          return out;
        }, function (err, stops) {
          if (failed) return;
          if (err) {
            failed = true;
            return done(err);
          }
          lists[i] = stops;
          if (--remaining === 0) done(null, details);
        });
      })(i);
    }
  }

  function finishRoute(routeId, details, lists, done) {
    // unique stop ids across directions
    var ids = [];
    var seen = {};
    var i, k;
    for (i = 0; i < lists.length; i++) {
      for (k = 0; k < lists[i].length; k++) {
        if (!seen.hasOwnProperty(lists[i][k].id)) {
          seen[lists[i][k].id] = true;
          ids.push(lists[i][k].id);
        }
      }
    }
    var coords = {};
    var complete = true;
    var remaining = ids.length;
    if (!remaining) return assemble();
    for (i = 0; i < ids.length; i++) {
      (function (id) {
        loadStopCoord(id, function (err, c) {
          if (err) complete = false;
          else coords[id] = c;
          if (--remaining === 0) assemble();
        });
      })(ids[i]);
    }

    function assemble() {
      var stops = {};
      var directions = [];
      for (var d = 0; d < details.dirs.length; d++) {
        var stopIds = [];
        var path = [];
        var list = lists[d];
        for (var j = 0; j < list.length; j++) {
          var s = list[j];
          if (!coords.hasOwnProperty(s.id)) continue;
          var c = coords[s.id];
          stopIds.push(s.id);
          path.push({ lat: c.lat, lon: c.lon });
          if (!stops.hasOwnProperty(s.id)) stops[s.id] = { id: s.id, name: s.name, lat: c.lat, lon: c.lon };
        }
        directions.push({ id: details.dirs[d].id, name: details.dirs[d].name, stopIds: stopIds, paths: [path] });
      }
      var route = { id: routeId, shortName: details.shortName, longName: details.longName || '', color: details.color, directions: directions, stops: stops };
      // a route with missing stops is returned but not kept, so a later call can fill the gaps
      if (complete) cacheSet('route.' + routeId, route);
      done(null, route, complete);
    }
  }

  function route(routeId, cb) {
    cb = once(cb);
    var id = String(routeId);
    if (!builtRoutes.done.hasOwnProperty(id)) {
      var cached = cacheGet('route.' + id);
      if (cached) {
        return setTimeout(function () { cb(null, cached); }, 0);
      }
    }
    shared(builtRoutes, id, function (done) {
      try {
        buildRoute(id, done);
      } catch (e) {
        done(toError(e));
      }
    }, cb);
  }

  // ------------------------------------------------------------ stopsNear
  function stopsNear(pos, radiusMeters, cb) {
    cb = once(cb);
    var ids = configuredRoutes;
    if (!ids.length) return setTimeout(function () { cb(null, []); }, 0);
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
              if (e.stop.routeIds[e.stop.routeIds.length - 1] !== ids[i]) e.stop.routeIds.push(ids[i]);
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

  // ------------------------------------------------------------ vehicles
  function vehicles(routeId, cb) {
    cb = once(cb);
    getMapped('/nextrip/vehicles/' + encodeURIComponent(String(routeId)), function (body) {
      var list = body instanceof Array ? body : [];
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var v = list[i];
        if (!v) continue;
        var t = +v.location_time;
        var lat = +v.latitude;
        var lon = +v.longitude;
        if (!(t > 0) || !lat || !lon || !isFinite(lat) || !isFinite(lon)) continue;
        out.push({
          tripKey: String(v.trip_id),
          routeId: String(v.route_id != null ? v.route_id : routeId),
          directionId: String(v.direction_id),
          lat: lat,
          lon: lon,
          time: t
        });
      }
      return out;
    }, cb);
  }

  // ------------------------------------------------------------ catalog (settings page)
  var routeList = table();

  // every route NexTrip knows: [{id, label}]
  function listRoutes(cb) {
    cb = once(cb);
    shared(routeList, 'all', function (done) {
      getMapped('/nextrip/routes', function (body) {
        var list = body instanceof Array ? body : [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
          if (!list[i] || list[i].route_id == null || list[i].route_id === '') continue;
          var id = String(list[i].route_id);
          out.push({ id: id, label: String(list[i].route_label || id) });
        }
        return out;
      }, done);
    }, cb);
  }

  // directions and ordered stops of a route, without the per-stop coordinate lookups
  function routeInfo(routeId, cb) {
    cb = once(cb);
    var id = String(routeId);
    var built = builtRoutes.done.hasOwnProperty(id) ? builtRoutes.done[id] : cacheGet('route.' + id);
    if (built) return setTimeout(function () { cb(null, built); }, 0);
    loadDetails(id, function (err, details) {
      if (err) return cb(err);
      var stops = {};
      var directions = [];
      for (var d = 0; d < details.dirs.length; d++) {
        var stopIds = [];
        var list = details.lists[d] || [];
        for (var j = 0; j < list.length; j++) {
          stopIds.push(list[j].id);
          if (!stops.hasOwnProperty(list[j].id)) stops[list[j].id] = { id: list[j].id, name: list[j].name };
        }
        directions.push({ id: details.dirs[d].id, name: details.dirs[d].name, stopIds: stopIds });
      }
      cb(null, { id: id, shortName: details.shortName, longName: details.longName || '', color: details.color, directions: directions, stops: stops });
    });
  }

  // one stop's name and position (NexTrip stop description; shares the stop-coordinate cache)
  function stopInfo(stopId, cb) {
    cb = once(cb);
    var id = String(stopId);
    loadStopCoord(id, function (err, c) {
      if (err) return cb(err);
      cb(null, { id: id, name: c.name || '', lat: c.lat, lon: c.lon });
    });
  }

  // every route and stop (search index): the route list, then each route's details and stop lists (a route already
  // built and stored also gives its stops' positions). Routes that fail are listed without stops.
  function catalog(cb, onProgress) {
    cb = once(cb);
    listRoutes(function (err, list) {
      if (err) return cb(err);
      list = list || [];
      var total = list.length, count = 0, routes = [], stops = {}, order = [];
      if (!total) return cb(null, { routes: [], stops: [] });
      function addStop(id, name, routeId, c) {
        if (!stops.hasOwnProperty(id)) { stops[id] = { id: id, name: name, routeIds: [] }; order.push(id); }
        var s = stops[id];
        if (!s.name && name) s.name = name;
        if (s.routeIds.indexOf(routeId) < 0) s.routeIds.push(routeId);
        if (c && typeof c.lat === 'number' && s.lat === undefined) { s.lat = c.lat; s.lon = c.lon; }
      }
      function finished() {
        count++;
        if (typeof onProgress === 'function') onProgress(count, total);
        if (count < total) return;
        var out = [];
        for (var k = 0; k < order.length; k++) out.push(stops[order[k]]);
        cb(null, { routes: routes, stops: out });
      }
      for (var i = 0; i < list.length; i++) {
        (function (i, entry) {
          var id = entry.id;
          routes[i] = { id: id, shortName: id, longName: entry.label === 'Route ' + id ? '' : entry.label };
          var built = builtRoutes.done.hasOwnProperty(id) ? builtRoutes.done[id] : cacheGet('route.' + id);
          if (built) {
            routes[i] = { id: id, shortName: built.shortName || id, longName: built.longName || routes[i].longName };
            for (var d = 0; d < built.directions.length; d++) {
              var ids = built.directions[d].stopIds || [];
              for (var k = 0; k < ids.length; k++) {
                var bs = built.stops[ids[k]];
                if (bs) addStop(ids[k], bs.name, id, bs);
              }
            }
            return setTimeout(finished, 0);
          }
          loadDetails(id, function (e, details) {
            if (!e && details) {
              routes[i] = { id: id, shortName: details.shortName || id, longName: details.longName || routes[i].longName };
              for (var d = 0; d < details.lists.length; d++) {
                var l = details.lists[d] || [];
                for (var k = 0; k < l.length; k++) {
                  var c = stopCoords.done.hasOwnProperty(l[k].id) ? stopCoords.done[l[k].id] : null;
                  addStop(l[k].id, l[k].name, id, c);
                }
              }
            }
            finished();
          });
        })(i, list[i]);
      }
    });
  }

  return { stopsNear: stopsNear, arrivals: arrivals, route: route, vehicles: vehicles,
           listRoutes: listRoutes, routeInfo: routeInfo, stopInfo: stopInfo, catalog: catalog };
}

var plugin = {
  type: 'metrotransit',
  label: 'Metro Transit (Minneapolis–St Paul)',
  create: function (options, ctx) {
    return createMetroTransit({ baseUrl: options.baseUrl, routeIds: ctx.routeIds }, ctx.http,
      { clock: ctx.clock, storage: ctx.storage });
  }
};

module.exports = { createMetroTransit: createMetroTransit, DEFAULT_BASE_URL: DEFAULT_BASE_URL, plugin: plugin };
