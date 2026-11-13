'use strict';
// WMATA (Washington DC) provider: Metrobus + Metrorail via the developer.wmata.com JSON APIs. ES5 only (runs in
// PebbleKit JS). See CONTRACTS.md §3.
//
// Ids: bus routes are WMATA RouteIDs ('D80'), bus stops 7-digit StopIDs ('1001141'); rail lines are the line codes
// (RAIL_LINES: 'RD', 'OR', 'SV', 'BL', 'YL', 'GR'), rail stops the platform station codes ('A01', 'C01': a transfer
// station has one code per platform, each serving its own lines).
var geo = require('../../common/geo');
var util = require('../util');

var DEFAULT_BASE_URL = 'https://api.wmata.com';
var KEY_MESSAGE = 'WMATA needs an API key: get one at developer.wmata.com';
var MAX_IN_FLIGHT = 3;
var CACHE_PREFIX = 'busWatch.wmata.';
var CACHE_TTL = 7 * 86400;       // seconds: route details, route list, stations, lines, line paths
var SNAPSHOT_TTL = 30;           // seconds: one GetPrediction/All snapshot serves every rail stop of a refresh
var RETRY_MS = 1100;             // a 429 ("Try again in 1 seconds") is retried once after this delay

// official line colours (WMATA brand guide)
var RAIL_LINES = {
  RD: { name: 'Red', color: 'BF0D3E' },
  OR: { name: 'Orange', color: 'ED8B00' },
  SV: { name: 'Silver', color: '919D9D' },
  BL: { name: 'Blue', color: '009CDE' },
  YL: { name: 'Yellow', color: 'FFD100' },
  GR: { name: 'Green', color: '00B140' }
};
var RAIL_ORDER = ['RD', 'OR', 'SV', 'BL', 'YL', 'GR'];
// jLines still lists Wiehle-Reston East (N06) as the Silver Line's start; the line runs on to Ashburn (N12)
var TERMINAL_FIX = { SV: { from: 'N06', to: 'N12' } };
// rail run-time model for matching one train across stations: metres per second between stations + dwell
var RAIL_SPEED = 13;
var RAIL_DWELL = 20;
var RAIL_TOLERANCE = 150;        // seconds

function isRailLine(id) { return RAIL_LINES.hasOwnProperty(id); }
function isStation(id) { return /^[A-Z][0-9]{2}$/.test(id); }

function toError(e) { return e instanceof Error ? e : new Error(String(e)); }

function once(cb) {
  var done = false;
  return function (err, value) {
    if (done) return;
    done = true;
    if (typeof cb === 'function') cb(err, value);
  };
}

function later(cb, err, value) { setTimeout(function () { cb(err, value); }, 0); }

function trim(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }

// 'FRIENDSHIP HTS' → 'Friendship Hts'
function titleCase(s) {
  return trim(s).toLowerCase().replace(/(^|[\s\-\/(+])([a-z])/g, function (m, p, c) { return p + c.toUpperCase(); });
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

function coord(v) {
  var n = +v;
  return isFinite(n) ? n : NaN;
}

function hasPos(lat, lon) { return isFinite(lat) && isFinite(lon) && !(lat === 0 && lon === 0); }

// 'YYYY-MM-DDTHH:MM:SS' in Washington local time (America/New_York; US DST rules since 2007) → epoch seconds
function easternEpoch(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s || ''));
  if (!m) return NaN;
  var y = +m[1];
  var local = Date.UTC(y, +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000;
  var mar1 = new Date(Date.UTC(y, 2, 1)).getUTCDay();
  var nov1 = new Date(Date.UTC(y, 10, 1)).getUTCDay();
  var dstStart = Date.UTC(y, 2, 1 + (7 - mar1) % 7 + 7, 7) / 1000;  // second Sunday of March, 02:00 EST
  var dstEnd = Date.UTC(y, 10, 1 + (7 - nov1) % 7, 6) / 1000;        // first Sunday of November, 02:00 EDT
  var utc = local + 5 * 3600;
  return utc >= dstStart && utc < dstEnd ? utc - 3600 : utc;
}

function createWmata(opts, http, deps) {
  opts = opts || {};
  deps = deps || {};
  var baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '') || DEFAULT_BASE_URL;
  var apiKey = trim(opts.apiKey);
  var clock = deps.clock || function () { return Math.floor(new Date().getTime() / 1000); };
  var storage = deps.storage || null;
  var retryMs = typeof deps.retryMs === 'number' ? deps.retryMs : RETRY_MS;

  function now() { return Math.floor(clock()); }

  // ------------------------------------------------------------ requests (key header, max 3 in flight, one 429 retry)
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
      http(job.url, finish, { api_key: apiKey });
    } catch (e) {
      setTimeout(function () { finish(toError(e)); }, 0);
    }
  }

  // GET a path; WMATA error bodies → Error; cb(err, body)
  function get(path, cb, retried) {
    if (!apiKey) return later(cb, new Error(KEY_MESSAGE));
    queue.push({
      url: baseUrl + path,
      cb: function (err, body) {
        if (err) return cb(toError(err));
        if (body == null || typeof body !== 'object') return cb(new Error('empty response'));
        // API gateway errors: {statusCode, message}
        if (typeof body.statusCode === 'number' && body.statusCode >= 400) {
          if (body.statusCode === 429 && !retried) {
            return setTimeout(function () { get(path, cb, true); }, retryMs);
          }
          if (body.statusCode === 401) return cb(new Error('WMATA rejected the API key (' + trim(body.message) + ')'));
          return cb(new Error(trim(body.message) || 'HTTP ' + body.statusCode));
        }
        // service errors (HTTP 400): {Message}
        if (typeof body.Message === 'string') return cb(new Error(body.Message));
        cb(null, body);
      }
    });
    pump();
  }

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

  // fn(done) runs once for concurrent callers of one key; results kept for the provider's lifetime unless keep === false
  function table() { return { done: {}, pending: {} }; }
  function shared(t, key, fn, cb) {
    if (t.done.hasOwnProperty(key)) return later(cb, null, t.done[key]);
    if (t.pending.hasOwnProperty(key)) return t.pending[key].push(cb);
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

  // ------------------------------------------------------------ storage cache (7 days)
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
      // best effort
    }
  }

  // a shared + stored load: memory first, then storage, then fetch
  function cached(t, key, fetch, cb) {
    shared(t, key, function (done) {
      var hit = cacheGet(key);
      if (hit) return later(done, null, hit);
      fetch(function (err, value) {
        if (!err) cacheSet(key, value);
        done(err, value);
      });
    }, cb);
  }

  // ------------------------------------------------------------ reference data
  var tables = { routes: table(), stations: table(), lines: table(), paths: table(), routesBuilt: table() };

  // jRoutes → [{id, name, desc}]
  function loadBusRoutes(cb) {
    cached(tables.routes, 'routes', function (done) {
      getMapped('/Bus.svc/json/jRoutes', function (body) {
        var list = body.Routes || [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
          var r = list[i];
          if (!r || r.RouteID == null || r.RouteID === '') continue;
          out.push({ id: String(r.RouteID), name: trim(r.Name), desc: trim(r.LineDescription) });
        }
        return out;
      }, done);
    }, cb);
  }

  // jStations → {code: {id, name, lat, lon, lines: [code], together: [code]}}
  function loadStations(cb) {
    cached(tables.stations, 'stations', function (done) {
      getMapped('/Rail.svc/json/jStations', function (body) {
        var list = body.Stations || [];
        var out = {};
        for (var i = 0; i < list.length; i++) {
          var s = list[i];
          if (!s || !s.Code) continue;
          var lines = [];
          var keys = ['LineCode1', 'LineCode2', 'LineCode3', 'LineCode4'];
          for (var k = 0; k < keys.length; k++) {
            if (s[keys[k]] && isRailLine(s[keys[k]]) && lines.indexOf(s[keys[k]]) < 0) lines.push(String(s[keys[k]]));
          }
          var together = [];
          if (s.StationTogether1) together.push(String(s.StationTogether1));
          if (s.StationTogether2) together.push(String(s.StationTogether2));
          out[String(s.Code)] = { id: String(s.Code), name: trim(s.Name), lat: coord(s.Lat), lon: coord(s.Lon),
                                  lines: lines, together: together };
        }
        return out;
      }, done);
    }, cb);
  }

  // jLines → {code: {id, name, start, end}} (known rail lines only)
  function loadLines(cb) {
    cached(tables.lines, 'lines', function (done) {
      getMapped('/Rail.svc/json/jLines', function (body) {
        var list = body.Lines || [];
        var out = {};
        for (var i = 0; i < list.length; i++) {
          var l = list[i];
          if (!l || !isRailLine(l.LineCode)) continue;
          var start = String(l.StartStationCode || '');
          var end = String(l.EndStationCode || '');
          var fix = TERMINAL_FIX[l.LineCode];
          if (fix && start === fix.from) start = fix.to;
          if (fix && end === fix.from) end = fix.to;
          out[l.LineCode] = { id: String(l.LineCode), name: trim(l.DisplayName) || RAIL_LINES[l.LineCode].name, start: start, end: end };
        }
        return out;
      }, done);
    }, cb);
  }

  // jPath start → end of a line → [{id, name, dist /*feet from the previous station*/}]
  function loadPath(line, cb) {
    cached(tables.paths, 'path.' + line, function (done) {
      loadLines(function (err, lines) {
        if (err) return done(err);
        var l = lines[line];
        if (!l || !l.start || !l.end) return done(new Error('unknown route ' + line));
        getMapped('/Rail.svc/json/jPath?FromStationCode=' + encodeURIComponent(l.start) +
          '&ToStationCode=' + encodeURIComponent(l.end), function (body) {
          var list = sortBy(body.Path || [], function (p) { return +p.SeqNum || 0; });
          var out = [];
          for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].StationCode) {
              out.push({ id: String(list[i].StationCode), name: trim(list[i].StationName), dist: +list[i].DistanceToPrev || 0 });
            }
          }
          if (!out.length) throw new Error('no stations for line ' + line);
          return out;
        }, done);
      });
    }, cb);
  }

  // ------------------------------------------------------------ route
  function busRoute(id, done) {
    getMapped('/Bus.svc/json/jRouteDetails?RouteID=' + encodeURIComponent(id), function (body) {
      var directions = [];
      var stops = {};
      var keys = ['Direction0', 'Direction1'];
      for (var k = 0; k < keys.length; k++) {
        var d = body[keys[k]];
        if (!d) continue;
        var stopIds = [];
        var list = d.Stops || [];
        for (var i = 0; i < list.length; i++) {
          var s = list[i];
          if (!s || s.StopID == null) continue;
          var sid = String(s.StopID);
          var lat = coord(s.Lat), lon = coord(s.Lon);
          if (!hasPos(lat, lon)) continue;
          stopIds.push(sid);
          if (!stops.hasOwnProperty(sid)) stops[sid] = { id: sid, name: trim(s.Name), lat: lat, lon: lon };
        }
        var shape = sortBy(d.Shape || [], function (p) { return +p.SeqNum || 0; });
        var path = [];
        for (i = 0; i < shape.length; i++) {
          var plat = coord(shape[i].Lat), plon = coord(shape[i].Lon);
          if (hasPos(plat, plon)) path.push({ lat: plat, lon: plon });
        }
        if (!path.length) for (i = 0; i < stopIds.length; i++) path.push({ lat: stops[stopIds[i]].lat, lon: stops[stopIds[i]].lon });
        var dirText = titleCase(d.DirectionText);
        var head = titleCase(d.TripHeadsign);
        directions.push({ id: String(d.DirectionNum != null ? d.DirectionNum : k), name: dirText && head ? dirText + ' to ' + head : dirText || head,
                          stopIds: stopIds, paths: [path] });
      }
      if (!directions.length) throw new Error('unknown route ' + id);
      // 'D80 - FRIENDSHIP HTS - UNION STATION' → 'Friendship Hts - Union Station' (when the route list is unavailable)
      var name = trim(body.Name);
      if (name.indexOf(id + ' - ') === 0) name = name.substring(id.length + 3);
      return { id: id, shortName: id, longName: titleCase(name), color: '', directions: directions, stops: stops };
    }, function (err, r) {
      if (err) return done(err);
      loadBusRoutes(function (e, list) {
        for (var i = 0; !e && i < list.length; i++) if (list[i].id === id && list[i].desc) r.longName = list[i].desc;
        done(null, r);
      });
    });
  }

  function railRoute(line, done) {
    loadLines(function (err, lines) {
      if (err) return done(err);
      loadPath(line, function (err2, path) {
        if (err2) return done(err2);
        loadStations(function (err3, stations) {
          if (err3) return done(err3);
          var stops = {};
          var fwd = [], coords = [];
          for (var i = 0; i < path.length; i++) {
            var st = stations[path[i].id];
            if (!st || !hasPos(st.lat, st.lon)) continue;
            fwd.push(st.id);
            coords.push({ lat: st.lat, lon: st.lon });
            stops[st.id] = { id: st.id, name: st.name, lat: st.lat, lon: st.lon };
          }
          var l = lines[line];
          var endName = stops[l.end] ? stops[l.end].name : (fwd.length ? stops[fwd[fwd.length - 1]].name : '');
          var startName = stops[l.start] ? stops[l.start].name : (fwd.length ? stops[fwd[0]].name : '');
          var name = l.name || RAIL_LINES[line].name;
          done(null, {
            id: line, shortName: name, longName: name + ' Line', color: RAIL_LINES[line].color,
            directions: [
              { id: '1', name: 'to ' + endName, stopIds: fwd, paths: [coords] },
              { id: '2', name: 'to ' + startName, stopIds: fwd.slice().reverse(), paths: [coords.slice().reverse()] }
            ],
            stops: stops
          });
        });
      });
    });
  }

  function route(routeId, cb) {
    cb = once(cb);
    var id = String(routeId);
    if (!apiKey) return later(cb, new Error(KEY_MESSAGE));
    shared(tables.routesBuilt, id, function (done) {
      var hit = cacheGet('route.' + id);
      if (hit) return later(done, null, hit);
      (isRailLine(id) ? railRoute : busRoute)(id, function (err, r) {
        if (!err) cacheSet('route.' + id, r);
        done(err, r);
      });
    }, cb);
  }

  // ------------------------------------------------------------ stopsNear: bus jStops + rail stations
  function stopsNear(pos, radiusMeters, cb) {
    cb = once(cb);
    var r = Math.max(0, Math.round(+radiusMeters || 0));
    var bus = null, rail = null, busErr = null, railErr = null, remaining = 2;
    getMapped('/Bus.svc/json/jStops?Lat=' + pos.lat + '&Lon=' + pos.lon + '&Radius=' + r, function (body) {
      var list = body.Stops || [];
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        if (!s || s.StopID == null || String(s.StopID) === '0') continue;
        var lat = coord(s.Lat), lon = coord(s.Lon);
        if (!hasPos(lat, lon)) continue;
        out.push({ id: String(s.StopID), name: trim(s.Name), lat: lat, lon: lon, routeIds: strings(s.Routes) });
      }
      return out;
    }, function (err, v) { busErr = err; bus = v; if (--remaining === 0) merge(); });
    loadStations(function (err, stations) {
      railErr = err;
      if (!err) {
        rail = [];
        for (var code in stations) {
          if (!stations.hasOwnProperty(code)) continue;
          var st = stations[code];
          if (!st.lines.length || !hasPos(st.lat, st.lon) || !(geo.distance(pos, st) <= r)) continue;
          rail.push({ id: st.id, name: st.name, lat: st.lat, lon: st.lon, routeIds: st.lines.slice() });
        }
      }
      if (--remaining === 0) merge();
    });
    function merge() {
      if (!bus && !rail) return cb(busErr || railErr);
      var all = (bus || []).concat(rail || []);
      try {
        cb(null, sortBy(all, function (s) { return geo.distance(pos, s); }));
      } catch (e) {
        cb(toError(e));
      }
    }
  }

  function strings(a) {
    var out = [];
    for (var i = 0; a && i < a.length; i++) if (a[i] != null && a[i] !== '' && out.indexOf(String(a[i])) < 0) out.push(String(a[i]));
    return out;
  }

  // ------------------------------------------------------------ arrivals
  function inWindow(minutesBefore, minutesAfter, list) {
    var t = now();
    var lo = t - (+minutesBefore || 0) * 60;
    var hi = t + (+minutesAfter || 0) * 60;
    var out = [];
    for (var i = 0; i < list.length; i++) if (list[i].time >= lo && list[i].time <= hi) out.push(list[i]);
    return sortBy(out, function (a) { return a.time; });
  }

  function busArrivals(sid, minutesBefore, minutesAfter, cb) {
    getMapped('/NextBusService.svc/json/jPredictions?StopID=' + encodeURIComponent(sid), function (body) {
      var list = body.Predictions || [];
      var t = now();
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (!p || p.RouteID == null || p.TripID == null) continue;
        var min = +p.Minutes;
        if (!isFinite(min)) continue;
        out.push({ stopId: sid, routeId: String(p.RouteID), tripKey: String(p.TripID), time: t + Math.round(min * 60),
                   predicted: true, headsign: trim(p.DirectionText) });
      }
      return inWindow(minutesBefore, minutesAfter, out);
    }, cb);
  }

  // Rail: GetPrediction/All (one request for every station, kept SNAPSHOT_TTL seconds) gives minutes per train and
  // station but no train ids. Within a snapshot the same train is linked across consecutive stations of its line
  // (see linkTrains), so the tripKey is consistent at every station of that snapshot.
  var snapshot = null;          // {t, trains: [{line, group, dest, at, time, key}], linked: {line: true}}
  var snapshotWaiters = null;

  function loadSnapshot(cb) {
    if (snapshot && now() - snapshot.t < SNAPSHOT_TTL && now() >= snapshot.t) return later(cb, null, snapshot);
    if (snapshotWaiters) return snapshotWaiters.push(cb);
    snapshotWaiters = [cb];
    getMapped('/StationPrediction.svc/json/GetPrediction/All', function (body) {
      var list = body.Trains || [];
      var t = now();
      var trains = [];
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (!p || !isRailLine(p.Line) || !p.LocationCode) continue;
        var m = trim(p.Min).toUpperCase();
        var min = m === 'ARR' || m === 'BRD' ? 0 : /^[0-9]+$/.test(m) ? +m : NaN;
        if (!isFinite(min)) continue;
        var dest = trim(p.DestinationName || p.Destination);
        // the same train reads 'Shady Grove' at one station and 'Shady Grv' at the next: match on a short prefix
        trains.push({ line: String(p.Line), group: String(p.Group || ''), dest: dest,
                      destKey: dest.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 5),
                      at: String(p.LocationCode), time: t + min * 60, key: null });
      }
      return { t: t, trains: trains, linked: {} };
    }, function (err, snap) {
      var w = snapshotWaiters;
      snapshotWaiters = null;
      if (!err) snapshot = snap;
      for (var i = 0; i < w.length; i++) {
        try {
          w[i](err, snap);
        } catch (e) {
          // keep going
        }
      }
    });
  }

  // gives every train of `line` in snap a key: walking the stations in travel order, a train at station i is the
  // one seen at station i-1 about (run time) earlier with the same destination (5-letter prefix) (trains of a line keep their order);
  // a train first seen at station i (it is between i-1 and i, or starts there) gets a new key
  function linkTrains(snap, line, path) {
    var pos = {};
    var cum = 0;
    for (var i = 0; i < path.length; i++) {
      cum += path[i].dist;
      pos[path[i].id] = { i: i, cum: cum * 0.3048 };
    }
    var groups = { '1': [], '2': [] };
    for (i = 0; i < snap.trains.length; i++) {
      var tr = snap.trains[i];
      if (tr.line !== line || tr.key || !pos.hasOwnProperty(tr.at) || !groups.hasOwnProperty(tr.group)) continue;
      groups[tr.group].push(tr);
    }
    for (var g in groups) {
      if (!groups.hasOwnProperty(g)) continue;
      // group 1 travels start → end (path order), group 2 end → start
      var order = [];
      for (i = 0; i < path.length; i++) order.push(path[i].id);
      if (g === '2') order.reverse();
      var prev = [];
      for (var s = 0; s < order.length; s++) {
        var here = [];
        for (i = 0; i < groups[g].length; i++) if (groups[g][i].at === order[s]) here.push(groups[g][i]);
        here = sortBy(here, function (x) { return x.time; });
        var run = s ? Math.abs(pos[order[s]].cum - pos[order[s - 1]].cum) / RAIL_SPEED + RAIL_DWELL : 0;
        var used = {};
        for (i = 0; i < here.length; i++) {
          var b = here[i];
          var best = -1, bestD = Infinity;
          for (var j = 0; j < prev.length; j++) {
            if (used[j] || prev[j].destKey !== b.destKey || prev[j].time > b.time) continue;
            var d = Math.abs(b.time - run - prev[j].time);
            if (d <= RAIL_TOLERANCE && d < bestD) { best = j; bestD = d; }
          }
          if (best >= 0) {
            used[best] = true;
            b.key = prev[best].key;
          } else {
            b.key = line + '.' + g + '.' + order[s] + '.' + b.time;
          }
        }
        // trains not listed here (prediction horizon, short turns) are not carried further
        prev = here;
      }
    }
    snap.linked[line] = true;
  }

  function railArrivals(code, minutesBefore, minutesAfter, cb) {
    loadSnapshot(function (err, snap) {
      if (err) return cb(err);
      var lines = [];
      for (var i = 0; i < snap.trains.length; i++) {
        var tr = snap.trains[i];
        if (tr.at === code && lines.indexOf(tr.line) < 0) lines.push(tr.line);
      }
      var remaining = lines.length;
      if (!remaining) return cb(null, []);
      for (i = 0; i < lines.length; i++) {
        (function (line) {
          if (snap.linked[line]) return later(step);
          loadPath(line, function (e, path) {
            if (!e && !snap.linked[line]) {
              try {
                linkTrains(snap, line, path);
              } catch (x) {
                // fall back to per-station keys
              }
            }
            step();
          });
        })(lines[i]);
      }
      function step() {
        if (--remaining > 0) return;
        var out = [];
        for (var k = 0; k < snap.trains.length; k++) {
          var t = snap.trains[k];
          if (t.at !== code) continue;
          out.push({ stopId: code, routeId: t.line, tripKey: t.key || t.line + '.' + t.group + '.' + code + '.' + t.time,
                     time: t.time, predicted: true, headsign: t.dest });
        }
        cb(null, inWindow(minutesBefore, minutesAfter, out));
      }
    });
  }

  function arrivals(stopId, minutesBefore, minutesAfter, cb) {
    cb = once(cb);
    var sid = String(stopId);
    if (!apiKey) return later(cb, new Error(KEY_MESSAGE));
    (isStation(sid) ? railArrivals : busArrivals)(sid, minutesBefore, minutesAfter, cb);
  }

  // ------------------------------------------------------------ vehicles (bus only; rail → [])
  function vehicles(routeId, cb) {
    cb = once(cb);
    var id = String(routeId);
    if (!apiKey) return later(cb, new Error(KEY_MESSAGE));
    if (isRailLine(id)) return later(cb, null, []);
    getMapped('/Bus.svc/json/jBusPositions?RouteID=' + encodeURIComponent(id), function (body) {
      var list = body.BusPositions || [];
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var v = list[i];
        if (!v || v.TripID == null) continue;
        var lat = coord(v.Lat), lon = coord(v.Lon), t = easternEpoch(v.DateTime);
        if (!hasPos(lat, lon) || !isFinite(t)) continue;
        out.push({ tripKey: String(v.TripID), routeId: String(v.RouteID != null ? v.RouteID : id),
                   directionId: String(v.DirectionNum), lat: lat, lon: lon, time: t });
      }
      return out;
    }, cb);
  }

  // ------------------------------------------------------------ catalog (settings page)
  function railRouteList(lines) {
    var out = [];
    for (var i = 0; i < RAIL_ORDER.length; i++) {
      var code = RAIL_ORDER[i];
      if (lines && !lines.hasOwnProperty(code)) continue;
      var name = (lines && lines[code].name) || RAIL_LINES[code].name;
      out.push({ id: code, name: name });
    }
    return out;
  }

  function listRoutes(cb) {
    cb = once(cb);
    loadBusRoutes(function (err, bus) {
      if (err) return cb(err);
      loadLines(function (e, lines) {
        var out = [];
        for (var i = 0; i < bus.length; i++) out.push({ id: bus[i].id, label: bus[i].name || bus[i].id });
        var rail = railRouteList(e ? null : lines);
        for (i = 0; i < rail.length; i++) out.push({ id: rail[i].id, label: rail[i].name + ' Line' });
        cb(null, out);
      });
    });
  }

  function stopInfo(stopId, cb) {
    cb = once(cb);
    var id = String(stopId);
    if (!apiKey) return later(cb, new Error(KEY_MESSAGE));
    if (isStation(id)) {
      return loadStations(function (err, stations) {
        if (err) return cb(err);
        if (!stations.hasOwnProperty(id)) return cb(new Error('unknown stop ' + id));
        var s = stations[id];
        cb(null, { id: id, name: s.name, lat: s.lat, lon: s.lon });
      });
    }
    getMapped('/Bus.svc/json/jStopSchedule?StopID=' + encodeURIComponent(id), function (body) {
      var s = body.Stop;
      var lat = s ? coord(s.Lat) : NaN, lon = s ? coord(s.Lon) : NaN;
      if (!s || !hasPos(lat, lon)) throw new Error('unknown stop ' + id);
      return { id: s.StopID != null ? String(s.StopID) : id, name: trim(s.Name), lat: lat, lon: lon };
    }, cb);
  }

  // everything in 4 requests: jRoutes + jStops (no position → every bus stop, with its routes and position)
  // + jLines + jStations. Bus parts failing → error; rail parts failing → bus only.
  function catalog(cb, onProgress) {
    cb = once(cb);
    if (!apiKey) return later(cb, new Error(KEY_MESSAGE));
    var total = 4, count = 0, res = {}, errs = {};
    function step(name) {
      return function (err, v) {
        if (err) errs[name] = err;
        else res[name] = v;
        count++;
        if (typeof onProgress === 'function') {
          try { onProgress(count, total); } catch (e) { /* progress display only */ }
        }
        if (count === total) finish();
      };
    }
    loadBusRoutes(step('routes'));
    getMapped('/Bus.svc/json/jStops', function (body) { return body.Stops || []; }, step('stops'));
    loadLines(step('lines'));
    loadStations(step('stations'));
    function finish() {
      if (errs.routes || errs.stops) return cb(errs.routes || errs.stops);
      var routes = [], stops = [], i;
      for (i = 0; i < res.routes.length; i++) {
        routes.push({ id: res.routes[i].id, shortName: res.routes[i].id, longName: res.routes[i].desc || '' });
      }
      for (i = 0; i < res.stops.length; i++) {
        var s = res.stops[i];
        if (!s || s.StopID == null || String(s.StopID) === '0') continue;
        var st = { id: String(s.StopID), name: trim(s.Name), routeIds: strings(s.Routes) };
        var lat = coord(s.Lat), lon = coord(s.Lon);
        if (hasPos(lat, lon)) { st.lat = lat; st.lon = lon; }
        stops.push(st);
      }
      if (res.lines && res.stations) {
        var rail = railRouteList(res.lines);
        for (i = 0; i < rail.length; i++) routes.push({ id: rail[i].id, shortName: rail[i].name, longName: rail[i].name + ' Line' });
        for (var code in res.stations) {
          if (!res.stations.hasOwnProperty(code)) continue;
          var x = res.stations[code];
          if (!x.lines.length) continue;
          var rs = { id: x.id, name: x.name, routeIds: x.lines.slice() };
          if (hasPos(x.lat, x.lon)) { rs.lat = x.lat; rs.lon = x.lon; }
          stops.push(rs);
        }
      }
      cb(null, { routes: routes, stops: stops });
    }
  }

  return { stopsNear: stopsNear, arrivals: arrivals, route: route, vehicles: vehicles,
           listRoutes: listRoutes,
           routeInfo: route, stopInfo: stopInfo, catalog: catalog };
}

var plugin = {
  type: 'wmata',
  label: 'WMATA (Washington DC)',
  area: { lat: 38.9072, lon: -77.0369, radius: 60000 },
  needsKey: true,
  keyUrl: 'https://developer.wmata.com',
  create: function (options, ctx) {
    return createWmata({ baseUrl: options.baseUrl, apiKey: options.apiKey }, ctx.http,
      { clock: ctx.clock, storage: ctx.storage });
  }
};

module.exports = { createWmata: createWmata, DEFAULT_BASE_URL: DEFAULT_BASE_URL, RAIL_LINES: RAIL_LINES,
                   easternEpoch: easternEpoch, plugin: plugin };
