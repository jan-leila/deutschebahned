'use strict';
// 511 SF Bay (San Francisco Bay Area) provider: the 511.org open data transit API (NeTEx static + SIRI real time, JSON).
// ES5 only (runs in PebbleKit JS). See CONTRACTS.md §3.
//
// One system covers one or more 511 operators (agencies), e.g. SF = Muni, BA = BART, AC = AC Transit. Every id is
// '<operator>:<511 id>' (stop 'SF:15696', route 'SF:14'), so adding operators never changes saved ids.
//
// The default key allows 60 requests per hour, so every request goes through a token bucket kept in `storage`
// (shared by every provider instance with that key on the phone): static data (lines, stops, patterns) is cached for
// 7 days and always allowed; real-time predictions are refreshed per stop only when the bucket has a token and the
// stop's last answer is older than FRESH_AGE, otherwise the last answer is reused (up to STALE_MAX old).
var geo = require('../../common/geo');
var util = require('../util');

var DEFAULT_BASE_URL = 'https://api.511.org/transit';
var DEFAULT_OPERATORS = ['SF'];
var KEY_URL = 'https://511.org/open-data/token';
var CACHE_PREFIX = 'busWatch.511.';
var STATIC_TTL = 7 * 86400;      // s: lines, stops and built routes
var BUDGET_PER_HOUR = 55;        // tokens refilled per hour (511 default limit: 60 / hour / key; 5 spare)
var BUCKET_CAPACITY = 10;        // burst
var FRESH_AGE = 55;              // s: a stop's predictions younger than this are reused without a request
var STALE_MAX = 1800;            // s: older predictions are never shown
var VEHICLE_AGE = 120;           // s: vehicle positions of an operator are fetched at most this often
var MAX_IN_FLIGHT = 3;
// operators whose StopMonitoring for all stops at once is small (rail / ferry): one request answers every stop
var WHOLE_OPERATOR = { BA: true, CT: true, GF: true, SB: true, AM: true, CE: true };
// BART lines are named after their color ('Yellow-S'); the 511 NeTEx lines carry no colors
var LINE_COLORS = { yellow: 'FFFF33', orange: 'FF9933', green: '339933', red: 'FF0000', blue: '0099CC', beige: 'D5CFA3',
                    purple: '8A2BE2', grey: 'A9A9A9', gray: 'A9A9A9' };

function toError(e) { return e instanceof Error ? e : new Error(String(e)); }
function trim(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }

function once(cb) {
  var done = false;
  return function (err, value) {
    if (done) return;
    done = true;
    if (typeof cb === 'function') cb(err, value);
  };
}

function later(cb, err, value) { setTimeout(function () { cb(err, value); }, 0); }

// XML-derived JSON: a single element may come as an object instead of a one-element array
function list(x) {
  if (x == null || x === '') return [];
  return x instanceof Array ? x : [x];
}

// text of a value that may be a string, a number, [{value}] or {value}
function text(x) {
  if (x == null) return '';
  if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') return trim(x);
  if (x instanceof Array) return x.length ? text(x[0]) : '';
  if (typeof x === 'object') return text(x.value != null ? x.value : x.Value != null ? x.Value : x['#text']);
  return '';
}

function sortBy(arr, key) {
  var tagged = [], i;
  for (i = 0; i < arr.length; i++) tagged.push({ k: key(arr[i]), i: i, v: arr[i] });
  tagged.sort(function (a, b) { return a.k !== b.k ? (a.k < b.k ? -1 : 1) : a.i - b.i; });
  var out = [];
  for (i = 0; i < tagged.length; i++) out.push(tagged[i].v);
  return out;
}

// ISO 8601 date-time ('2026-11-13T13:05:00-08:00', '...Z', fractional seconds) → epoch s; no offset = UTC; bad → 0
function parseIso(s) {
  var m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.\d+)?)?(Z|[+-]\d\d:?\d\d)?$/.exec(trim(s));
  if (!m) return 0;
  var t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000;
  var z = m[7];
  if (z && z !== 'Z') {
    var sign = z.charAt(0) === '-' ? -1 : 1;
    var hh = +z.substr(1, 2), mm = +z.substr(z.length - 2, 2);
    t -= sign * (hh * 3600 + mm * 60);
  }
  return t;
}

// the system's "Base URL" field: '' → default server + SF; 'SF, BA' → default server + those operators;
// 'https://host/transit?operators=SF,BA' (also operator / operator_id / agency, or '#SF,BA') → that server + operators
function parseOptions(baseUrl) {
  var s = trim(baseUrl), base = DEFAULT_BASE_URL, ops = '';
  if (/:\/\//.test(s)) {
    var hash = s.indexOf('#');
    if (hash >= 0) { ops = s.substr(hash + 1); s = s.substr(0, hash); }
    var q = s.indexOf('?');
    if (q >= 0) {
      var params = s.substr(q + 1).split('&');
      s = s.substr(0, q);
      for (var i = 0; i < params.length; i++) {
        var kv = params[i].split('=');
        if (/^(operators?|operator_id|agency)$/i.test(kv[0]) && kv.length > 1) ops = decodeURIComponent(kv[1].replace(/\+/g, ' '));
      }
    }
    base = s.replace(/\/+$/, '') || DEFAULT_BASE_URL;
  } else {
    ops = s;
  }
  var operators = [], seen = {};
  var parts = ops.split(/[\s,;+|]+/);
  for (var k = 0; k < parts.length; k++) {
    var op = trim(parts[k]).toUpperCase();
    if (op && !seen.hasOwnProperty(op)) { seen[op] = true; operators.push(op); }
  }
  return { baseUrl: base, operators: operators.length ? operators : DEFAULT_OPERATORS.slice() };
}

function hash(s) {
  var h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// coordinates of a pattern's shape: every *LineString under its links, in order ('lat lon' strings, a 'posList')
function shapeOf(pattern) {
  var pts = [];
  function addPair(a, b) {
    a = +a; b = +b;
    if (!isFinite(a) || !isFinite(b)) return;
    if (Math.abs(a) > 90 && Math.abs(b) <= 90) { var t = a; a = b; b = t; }  // lon lat order
    if (!pts.length || pts[pts.length - 1].lat !== a || pts[pts.length - 1].lon !== b) pts.push({ lat: a, lon: b });
  }
  function walk(node, depth) {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (node instanceof Array) { for (var i = 0; i < node.length; i++) walk(node[i], depth + 1); return; }
    for (var k in node) {
      if (!node.hasOwnProperty(k)) continue;
      if (/LineString$/.test(k)) {
        var ls = list(node[k]);
        for (var j = 0; j < ls.length; j++) {
          var pos = list(ls[j] && (ls[j].pos || ls[j]['gml:pos']));
          for (var p = 0; p < pos.length; p++) {
            var xy = text(pos[p]).split(/[\s,]+/);
            addPair(xy[0], xy[1]);
          }
          var pl = text(ls[j] && (ls[j].posList || ls[j]['gml:posList'])).split(/[\s,]+/);
          for (var n = 0; n + 1 < pl.length; n += 2) addPair(pl[n], pl[n + 1]);
        }
      } else {
        walk(node[k], depth + 1);
      }
    }
  }
  walk(pattern.LinksInSequence || pattern.linksInSequence, 0);
  return pts;
}

// a pattern's stops in order: StopPointInJourneyPattern and TimingPointInJourneyPattern merged by Order
function pointsOf(pattern) {
  var seq = pattern.PointsInSequence || pattern.pointsInSequence || {};
  var all = list(seq.StopPointInJourneyPattern).concat(list(seq.TimingPointInJourneyPattern));
  var pts = [];
  for (var i = 0; i < all.length; i++) {
    var p = all[i];
    if (!p) continue;
    var ref = p.ScheduledStopPointRef;
    ref = text(ref && typeof ref === 'object' && !(ref instanceof Array) && ref.ref != null ? ref.ref : ref);
    if (!ref) continue;
    pts.push({ order: +(p.Order != null ? p.Order : p.order) || 0, ref: ref, name: text(p.Name) });
  }
  pts = sortBy(pts, function (x) { return x.order; });
  var out = [];
  for (var k = 0; k < pts.length; k++) {
    var prev = out[out.length - 1];
    if (prev && prev.ref === pts[k].ref) continue;  // the same stop as a stop point and as a timing point
    out.push(pts[k]);
  }
  return out;
}

function lineColor(line) {
  var c = util.color(line.Color || line.RouteColor || (line.Presentation && line.Presentation.Colour));
  if (c) return c;
  var m = /^([A-Za-z]+)(?:[-\s]|$)/.exec(text(line.Id));
  return m && LINE_COLORS.hasOwnProperty(m[1].toLowerCase()) ? LINE_COLORS[m[1].toLowerCase()] : '';
}

function createBay511(opts, http, deps) {
  opts = opts || {};
  deps = deps || {};
  var parsed = parseOptions(opts.baseUrl);
  var baseUrl = parsed.baseUrl;
  var operators = parsed.operators;
  var apiKey = trim(opts.apiKey);
  var key = encodeURIComponent(apiKey);
  var clock = deps.clock || function () { return Math.floor(new Date().getTime() / 1000); };
  var storage = deps.storage || null;
  var configuredRoutes = [];
  (function () {
    var seen = {}, ids = opts.routeIds || [];
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i] == null ? '' : String(ids[i]);
      if (id !== '' && !seen.hasOwnProperty(id)) { seen[id] = true; configuredRoutes.push(id); }
    }
  })();

  function now() { return Math.floor(clock()); }
  function noKey() { return new Error('511.org needs an API key (free: ' + KEY_URL + ')'); }

  // 'SF:15696' → {op: 'SF', id: '15696'}; an id without operator belongs to the first operator
  function split(ref) {
    var s = String(ref == null ? '' : ref), i = s.indexOf(':');
    if (i > 0) return { op: s.substr(0, i).toUpperCase(), id: s.substr(i + 1) };
    return s ? { op: operators[0], id: s } : null;
  }
  function join(op, id) { return op + ':' + id; }

  // ------------------------------------------------------------ storage cache {t, v}
  function cacheGet(k, ttl) {
    if (!storage) return null;
    try {
      var raw = storage.getItem(CACHE_PREFIX + k);
      if (!raw) return null;
      var e = JSON.parse(raw);
      if (!e || typeof e.t !== 'number' || e.v == null) return null;
      var t = now();
      if (t - e.t >= ttl || e.t > t + 86400) return null;
      return e.v;
    } catch (err) {
      return null;
    }
  }
  function cacheSet(k, v) {
    if (!storage) return;
    try { storage.setItem(CACHE_PREFIX + k, JSON.stringify({ t: now(), v: v })); } catch (e) { /* best effort */ }
  }

  // ------------------------------------------------------------ request budget (token bucket, per API key)
  var RATE = BUDGET_PER_HOUR / 3600;
  var bucketKey = 'bucket.' + hash(apiKey);
  var memBucket = null;
  function bucket() {
    var b = memBucket;
    if (storage) {
      try {
        var raw = storage.getItem(CACHE_PREFIX + bucketKey);
        var s = raw ? JSON.parse(raw) : null;
        if (s && typeof s.t === 'number' && typeof s.n === 'number') b = s;
      } catch (e) { /* ignore */ }
    }
    var t = now();
    if (!b) b = { t: t, n: BUCKET_CAPACITY };
    var n = Math.min(BUCKET_CAPACITY, b.n + Math.max(0, t - b.t) * RATE);
    return { t: t, n: n };
  }
  function saveBucket(b) {
    memBucket = b;
    if (!storage) return;
    try { storage.setItem(CACHE_PREFIX + bucketKey, JSON.stringify({ t: b.t, n: Math.round(b.n * 1000) / 1000 })); } catch (e) { /* ignore */ }
  }
  // kind 'static' always goes (cached for days; may overdraw), 'realtime' needs a token, 'vehicles' half a bucket
  function take(kind) {
    var b = bucket();
    var need = kind === 'vehicles' ? BUCKET_CAPACITY / 2 : 1;
    if (kind !== 'static' && b.n < need) { saveBucket(b); return false; }
    b.n -= 1;
    saveBucket(b);
    return true;
  }
  function waitSeconds() { var b = bucket(); return b.n >= 1 ? 0 : Math.ceil((1 - b.n) / RATE); }
  function rateLimited() { var b = bucket(); b.n = Math.min(b.n, -BUCKET_CAPACITY / 2); saveBucket(b); }

  // ------------------------------------------------------------ http (max 3 in flight)
  var inFlight = 0, queue = [];
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
      try { job.cb(err, body); } finally { pump(); }
    }
    try {
      http(job.url, finish);
    } catch (e) {
      setTimeout(function () { finish(toError(e)); }, 0);
    }
  }

  // GET {base}/{path}?api_key=K&{query}&format=json; body checks; cb(err, body)
  function get(path, query, cb) {
    queue.push({
      url: baseUrl + '/' + path + '?api_key=' + key + (query ? '&' + query : '') + '&format=json',
      cb: function (err, body) {
        if (err) {
          err = toError(err);
          if (/\b429\b|too many|rate limit|quota/i.test(err.message)) rateLimited();
          return cb(err);
        }
        if (typeof body === 'string') {  // an http layer that hands over text: 511 bodies may start with a UTF-8 BOM
          try { body = JSON.parse(body.replace(/^﻿/, '')); } catch (e) { return cb(new Error('bad JSON from 511.org')); }
        }
        if (body == null || typeof body !== 'object') return cb(new Error('empty response'));
        var msg = !(body instanceof Array) && (body.Message || body.message || body.ErrorMessage || body.error);
        if (msg && typeof msg === 'string' && !body.ServiceDelivery && !body.Siri && !body.Contents && !body.content) {
          if (/too many|rate limit|quota/i.test(msg)) rateLimited();
          return cb(new Error(msg));
        }
        cb(null, body);
      }
    });
    pump();
  }

  function getMapped(path, query, map, cb) {
    get(path, query, function (err, body) {
      if (err) return cb(err);
      var v;
      try { v = map(body); } catch (e) { return cb(toError(e)); }
      cb(null, v);
    });
  }

  // concurrent callers of one key share a fetch; results kept in table.done unless keep === false
  function table() { return { done: {}, pending: {} }; }
  function shared(tab, k, fn, cb) {
    if (tab.done.hasOwnProperty(k)) return later(cb, null, tab.done[k]);
    if (tab.pending.hasOwnProperty(k)) { tab.pending[k].push(cb); return; }
    var waiters = [cb];
    tab.pending[k] = waiters;
    fn(function (err, v, keep) {
      delete tab.pending[k];
      if (!err && keep !== false) tab.done[k] = v;
      for (var i = 0; i < waiters.length; i++) {
        try { waiters[i](err, v); } catch (e) { /* one waiter must not stop the others */ }
      }
    });
  }

  // ------------------------------------------------------------ SIRI envelope
  function serviceDelivery(body) {
    var sd = body.ServiceDelivery || (body.Siri && body.Siri.ServiceDelivery);
    if (!sd || typeof sd !== 'object') throw new Error('unexpected response from 511.org');
    return sd;
  }
  function siriError(d) {
    var ec = d && d.ErrorCondition;
    if (!ec) return null;
    var t = text(ec.Description);
    if (!t) for (var k in ec) if (ec.hasOwnProperty(k) && ec[k] && typeof ec[k] === 'object' && text(ec[k].ErrorText)) { t = text(ec[k].ErrorText); break; }
    return t || 'error from 511.org';
  }
  function deliveries(sd, name) {
    var ds = list(sd[name]);
    for (var i = 0; i < ds.length; i++) {
      var e = siriError(ds[i]);
      if (e && ds[i].Status === false) throw new Error(e);
    }
    if (!ds.length && sd.Status === false) throw new Error(siriError(sd) || 'error from 511.org');
    return ds;
  }

  function tripKeyOf(op, mvj, fallback) {
    var f = mvj.FramedVehicleJourneyRef || {};
    var ref = text(f.DatedVehicleJourneyRef);
    var date = text(f.DataFrameRef);
    if (!ref) ref = text(mvj.VehicleRef) ? 'v' + text(mvj.VehicleRef) : fallback;
    return join(op, ref + (date ? '@' + date : ''));
  }

  // ------------------------------------------------------------ static data: lines, stops (whole operator, 7 days)
  var linesTable = table(), stopsTable = table();

  // → [{id, shortName, longName, siri, color}]
  function loadLines(op, cb) {
    shared(linesTable, op, function (done) {
      var c = cacheGet('lines.' + op, STATIC_TTL);
      if (c) return later(done, null, c);
      take('static');
      getMapped('lines', 'operator_id=' + encodeURIComponent(op), function (body) {
        var arr = body instanceof Array ? body : list(body.content || body.Content || body.lines || body.Lines);
        var out = [];
        for (var i = 0; i < arr.length; i++) {
          var l = arr[i];
          if (!l || text(l.Id) === '') continue;
          var id = text(l.Id), code = text(l.PublicCode) || id, name = text(l.Name);
          out.push({ id: id, shortName: code, longName: name === code ? '' : name, siri: text(l.SiriLineRef), color: lineColor(l) });
        }
        if (!out.length && !(body instanceof Array)) throw new Error('no lines for operator ' + op);
        return out;
      }, function (err, v) {
        if (!err) cacheSet('lines.' + op, v);
        done(err, v);
      });
    }, cb);
  }

  // lines already known without a request (memory / storage), or null
  function knownLines(op) {
    return linesTable.done.hasOwnProperty(op) ? linesTable.done[op] : cacheGet('lines.' + op, STATIC_TTL);
  }

  // SIRI LineRef → the NeTEx line id (they are equal for most operators)
  var siriMaps = {};
  function lineIdOf(op, lineRef) {
    if (!siriMaps.hasOwnProperty(op)) {
      var ls = knownLines(op);
      if (!ls) return lineRef;
      var m = {};
      for (var i = 0; i < ls.length; i++) if (ls[i].siri && ls[i].siri !== ls[i].id) m[ls[i].siri] = ls[i].id;
      siriMaps[op] = m;
    }
    return siriMaps[op].hasOwnProperty(lineRef) ? siriMaps[op][lineRef] : lineRef;
  }

  // → {id: [name, lat, lon]}
  function loadStops(op, cb) {
    shared(stopsTable, op, function (done) {
      var c = cacheGet('stops.' + op, STATIC_TTL);
      if (c) return later(done, null, c);
      take('static');
      getMapped('stops', 'operator_id=' + encodeURIComponent(op), function (body) {
        var contents = body.Contents || body.contents || {};
        var objs = contents.dataObjects || {};
        var arr = list(objs.ScheduledStopPoint);
        if (!body.Contents && !body.contents) throw new Error('unexpected response from 511.org');
        var out = {};
        for (var i = 0; i < arr.length; i++) {
          var s = arr[i];
          if (!s || text(s.id) === '') continue;
          var loc = s.Location || {};
          var lat = +text(loc.Latitude), lon = +text(loc.Longitude);
          if (!isFinite(lat) || !isFinite(lon) || (!lat && !lon)) continue;
          out[text(s.id)] = [text(s.Name), Math.round(lat * 1e6) / 1e6, Math.round(lon * 1e6) / 1e6];
        }
        return out;
      }, function (err, v) {
        if (!err) cacheSet('stops.' + op, v);
        done(err, v);
      });
    }, cb);
  }

  // ------------------------------------------------------------ patterns → route
  // → {dirs: [{id, name, points: [{ref, name}], shapes: [[{lat, lon}]]}]}
  function loadPatterns(op, line, cb) {
    take('static');
    getMapped('patterns', 'operator_id=' + encodeURIComponent(op) + '&line_id=' + encodeURIComponent(line), function (body) {
      var dirNames = {}, order = [], groups = {};
      var ds = list(body.directions || body.Directions);
      var i, k;
      for (i = 0; i < ds.length; i++) {
        var did = text(ds[i] && (ds[i].DirectionId || ds[i].id));
        if (!did) continue;
        dirNames[did] = text(ds[i].Name);
        if (!groups.hasOwnProperty(did)) { groups[did] = []; order.push(did); }
      }
      var ps = list(body.journeyPatterns || body.JourneyPatterns);
      if (!ps.length && !body.journeyPatterns && !body.directions) throw new Error('unknown route ' + join(op, line));
      for (i = 0; i < ps.length; i++) {
        var p = ps[i];
        if (!p) continue;
        var dref = text(p.DirectionRef) || '0';
        if (!groups.hasOwnProperty(dref)) { groups[dref] = []; order.push(dref); }
        groups[dref].push(p);
      }
      var dirs = [];
      for (i = 0; i < order.length; i++) {
        var g = groups[order[i]];
        if (!g.length) continue;
        // the main pattern: most trips (TripCount), else most stops
        var best = null, bestPts = null, bestScore = -1;
        var shapes = [];
        for (k = 0; k < g.length; k++) {
          var pts = pointsOf(g[k]);
          var score = (+g[k].TripCount || 0) * 10000 + pts.length;
          if (score > bestScore) { best = g[k]; bestPts = pts; bestScore = score; }
          var sh = shapeOf(g[k]);
          if (sh.length > 1) shapes.push(sh);
        }
        var dd = best.DestinationDisplayView || {};
        var headsign = text(dd.FontText) || text(dd.FrontText);
        dirs.push({ id: order[i], name: headsign || dirNames[order[i]] || text(best.Name) || order[i], points: bestPts, shapes: shapes });
      }
      return { dirs: dirs };
    }, cb);
  }

  function lineEntry(op, line) {
    var ls = knownLines(op) || [];
    for (var i = 0; i < ls.length; i++) if (ls[i].id === line) return ls[i];
    return null;
  }

  var builtRoutes = table();

  function buildRoute(op, line, done) {
    var pat = null, stops = null, failed = null, remaining = 3;
    function step(err) {
      if (err && !failed) failed = err;
      if (--remaining > 0) return;
      if (!pat) return done(failed || new Error('unknown route ' + join(op, line)));
      if (!stops) return done(failed || new Error('no stops for operator ' + op));
      var id = join(op, line), le = lineEntry(op, line);
      var routeStops = {}, directions = [], complete = true;
      for (var d = 0; d < pat.dirs.length; d++) {
        var dir = pat.dirs[d], stopIds = [], coords = [];
        for (var j = 0; j < dir.points.length; j++) {
          var s = stops[dir.points[j].ref];
          if (!s) { complete = false; continue; }
          var sid = join(op, dir.points[j].ref);
          stopIds.push(sid);
          coords.push({ lat: s[1], lon: s[2] });
          if (!routeStops.hasOwnProperty(sid)) routeStops[sid] = { id: sid, name: s[0] || dir.points[j].name, lat: s[1], lon: s[2] };
        }
        directions.push({ id: dir.id, name: dir.name, stopIds: stopIds, paths: dir.shapes.length ? dir.shapes : [coords] });
      }
      var route = { id: id, shortName: le ? le.shortName : line, longName: le ? le.longName : '', color: le ? le.color : '',
                    directions: directions, stops: routeStops };
      if (complete) cacheSet('route.' + id, route);
      done(null, route, complete);
    }
    loadPatterns(op, line, function (err, v) { pat = v || null; step(err); });
    loadStops(op, function (err, v) { stops = v || null; step(err); });
    loadLines(op, function () { step(null); });  // names / color only: failure is fine
  }

  function builtRoute(id) {
    return builtRoutes.done.hasOwnProperty(id) ? builtRoutes.done[id] : cacheGet('route.' + id, STATIC_TTL);
  }

  function route(routeId, cb) {
    cb = once(cb);
    if (!apiKey) return later(cb, noKey());
    var r = split(routeId);
    if (!r || !r.id) return later(cb, new Error('unknown route ' + routeId));
    var id = join(r.op, r.id);
    var cached = builtRoute(id);
    if (cached) return later(cb, null, cached);
    shared(builtRoutes, id, function (done) {
      try { buildRoute(r.op, r.id, done); } catch (e) { done(toError(e)); }
    }, cb);
  }

  // directions and ordered stops (names from the patterns): one request, no stop coordinates
  function routeInfo(routeId, cb) {
    cb = once(cb);
    if (!apiKey) return later(cb, noKey());
    var r = split(routeId);
    if (!r || !r.id) return later(cb, new Error('unknown route ' + routeId));
    var id = join(r.op, r.id);
    var cached = builtRoute(id);
    if (cached) return later(cb, null, cached);
    var pat = null, perr = null, remaining = 2;
    function step() {
      if (--remaining > 0) return;
      if (!pat) return cb(perr || new Error('unknown route ' + id));
      var le = lineEntry(r.op, r.id), stops = {}, directions = [];
      for (var d = 0; d < pat.dirs.length; d++) {
        var stopIds = [], pts = pat.dirs[d].points;
        for (var j = 0; j < pts.length; j++) {
          var sid = join(r.op, pts[j].ref);
          stopIds.push(sid);
          if (!stops.hasOwnProperty(sid)) stops[sid] = { id: sid, name: pts[j].name };
        }
        directions.push({ id: pat.dirs[d].id, name: pat.dirs[d].name, stopIds: stopIds });
      }
      cb(null, { id: id, shortName: le ? le.shortName : r.id, longName: le ? le.longName : '', color: le ? le.color : '',
                 directions: directions, stops: stops });
    }
    loadPatterns(r.op, r.id, function (err, v) { pat = v || null; perr = err; step(); });
    loadLines(r.op, function () { step(); });
  }

  // ------------------------------------------------------------ stopsNear: stops of the configured routes
  function stopsNear(pos, radiusMeters, cb) {
    cb = once(cb);
    if (!apiKey) return later(cb, noKey());
    var ids = configuredRoutes;
    if (!ids.length) return later(cb, null, []);
    var results = [], remaining = ids.length, lastErr = null;
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
      var anyOk = false, byId = {}, found = [];
      for (var i = 0; i < ids.length; i++) {
        var r = results[i];
        if (!r) continue;
        anyOk = true;
        for (var sid in r.stops) {
          if (!r.stops.hasOwnProperty(sid)) continue;
          var s = r.stops[sid];
          if (byId.hasOwnProperty(sid)) {
            if (byId[sid].stop.routeIds.indexOf(r.id) < 0) byId[sid].stop.routeIds.push(r.id);
            continue;
          }
          var d = geo.distance(pos, s);
          if (!(d <= radiusMeters)) continue;
          byId[sid] = { d: d, stop: { id: s.id, name: s.name, lat: s.lat, lon: s.lon, routeIds: [r.id] } };
          found.push(byId[sid]);
        }
      }
      if (!anyOk) return cb(lastErr || new Error('no routes'));
      found = sortBy(found, function (x) { return x.d; });
      var out = [];
      for (var k = 0; k < found.length; k++) out.push(found[k].stop);
      cb(null, out);
    }
  }

  // ------------------------------------------------------------ arrivals (StopMonitoring), batched per operator
  var realtime = {};      // 'OP:stop' → {t, list: [{line, trip, time, predicted, headsign}]}
  var wholeAt = {};       // op → time of the last StopMonitoring for all its stops
  var rtTable = { done: {}, pending: {} };  // in-flight fetches only (nothing kept in done)
  var batches = {};       // op → {ids: [stop], reqs: {stop: [request]}}

  function visitsToCache(op, body, onlyStop) {
    var ds = deliveries(serviceDelivery(body), 'StopMonitoringDelivery');
    var t = now(), byStop = {};
    for (var i = 0; i < ds.length; i++) {
      var visits = list(ds[i].MonitoredStopVisit);
      for (var k = 0; k < visits.length; k++) {
        var v = visits[k];
        var mvj = (v && v.MonitoredVehicleJourney) || {};
        var call = mvj.MonitoredCall || {};
        var stop = text(call.StopPointRef) || text(v && v.MonitoringRef) || onlyStop;
        if (!stop) continue;
        var exp = parseIso(text(call.ExpectedArrivalTime)) || parseIso(text(call.ExpectedDepartureTime));
        var aim = parseIso(text(call.AimedArrivalTime)) || parseIso(text(call.AimedDepartureTime));
        var time = exp || aim;
        if (!time) continue;
        var line = text(mvj.LineRef);
        if (!byStop.hasOwnProperty(stop)) byStop[stop] = [];
        byStop[stop].push({
          line: line,
          trip: tripKeyOf(op, mvj, line + '/' + aim),
          time: time,
          predicted: !!exp,
          headsign: text(call.DestinationDisplay) || text(mvj.DestinationName)
        });
      }
    }
    if (onlyStop) realtime[join(op, onlyStop)] = { t: t, list: byStop[onlyStop] || [] };
    else {
      for (var s in realtime) if (realtime.hasOwnProperty(s) && s.indexOf(op + ':') === 0) delete realtime[s];
      for (var sid in byStop) if (byStop.hasOwnProperty(sid)) realtime[join(op, sid)] = { t: t, list: byStop[sid] };
      wholeAt[op] = t;
    }
  }

  // latest predictions of one stop ({t, list}) or null
  function cachedVisits(op, stop) {
    var k = join(op, stop), e = realtime.hasOwnProperty(k) ? realtime[k] : null;
    if (wholeAt.hasOwnProperty(op) && (!e || e.t < wholeAt[op])) e = { t: wholeAt[op], list: [] };
    return e;
  }

  function fetchVisits(op, stop, cb) {  // stop '' = every stop of the operator
    shared(rtTable, op + '|' + stop, function (done) {
      get('StopMonitoring', 'agency=' + encodeURIComponent(op) + (stop ? '&stopCode=' + encodeURIComponent(stop) : ''), function (err, body) {
        if (err) return done(err);
        try { visitsToCache(op, body, stop); } catch (e) { return done(toError(e)); }
        done(null, true, false);
      });
    }, cb);
  }

  function answer(op, stop, reqs, err) {
    var e = cachedVisits(op, stop), t = now();
    for (var i = 0; i < reqs.length; i++) {
      var q = reqs[i];
      if (!e || t - e.t >= STALE_MAX) {
        q.cb(err || new Error('511.org request limit: arrivals in about ' + Math.max(1, Math.round(waitSeconds() / 60)) + ' min'));
        continue;
      }
      var lo = t - q.before * 60, hi = t + q.after * 60, out = [];
      for (var k = 0; k < e.list.length; k++) {
        var a = e.list[k];
        if (a.time < lo || a.time > hi) continue;
        out.push({ stopId: join(op, stop), routeId: join(op, lineIdOf(op, a.line)), tripKey: a.trip, time: a.time,
                   predicted: a.predicted, headsign: a.headsign });
      }
      q.cb(null, sortBy(out, function (x) { return x.time; }));
    }
  }

  function flush(op) {
    var b = batches[op];
    delete batches[op];
    var t = now(), need = [], i;
    for (i = 0; i < b.ids.length; i++) {
      var e = cachedVisits(op, b.ids[i]);
      if (e && t - e.t < FRESH_AGE) answer(op, b.ids[i], b.reqs[b.ids[i]]);
      else need.push({ stop: b.ids[i], age: e ? t - e.t : Infinity });
    }
    if (!need.length) return;
    need = sortBy(need, function (x) { return -x.age; });  // never fetched / stalest first
    if (WHOLE_OPERATOR[op] && need.length >= 2) {
      if (!take('realtime')) { for (i = 0; i < need.length; i++) answer(op, need[i].stop, b.reqs[need[i].stop]); return; }
      return fetchVisits(op, '', function (err) {
        for (var j = 0; j < need.length; j++) answer(op, need[j].stop, b.reqs[need[j].stop], err);
      });
    }
    for (i = 0; i < need.length; i++) {
      (function (stop) {
        if (!take('realtime')) return answer(op, stop, b.reqs[stop]);
        fetchVisits(op, stop, function (err) { answer(op, stop, b.reqs[stop], err); });
      })(need[i].stop);
    }
  }

  function arrivals(stopId, minutesBefore, minutesAfter, cb) {
    cb = once(cb);
    if (!apiKey) return later(cb, noKey());
    var s = split(stopId);
    if (!s || !s.id) return later(cb, new Error('unknown stop ' + stopId));
    var b = batches[s.op];
    if (!b) {
      b = batches[s.op] = { ids: [], reqs: {} };
      setTimeout(function () { flush(s.op); }, 0);
    }
    if (!b.reqs.hasOwnProperty(s.id)) { b.reqs[s.id] = []; b.ids.push(s.id); }
    b.reqs[s.id].push({ before: +minutesBefore || 0, after: +minutesAfter || 0, cb: cb });
  }

  // ------------------------------------------------------------ vehicles (VehicleMonitoring, whole operator)
  var vehicleCache = {};  // op → {t, list}
  var vmTable = { done: {}, pending: {} };

  function fetchVehicles(op, cb) {
    shared(vmTable, op, function (done) {
      getMapped('VehicleMonitoring', 'agency=' + encodeURIComponent(op), function (body) {
        var ds = deliveries(serviceDelivery(body), 'VehicleMonitoringDelivery');
        var out = [];
        for (var i = 0; i < ds.length; i++) {
          var acts = list(ds[i].VehicleActivity);
          for (var k = 0; k < acts.length; k++) {
            var mvj = (acts[k] && acts[k].MonitoredVehicleJourney) || {};
            var loc = mvj.VehicleLocation || {};
            var lat = +text(loc.Latitude), lon = +text(loc.Longitude);
            if (!isFinite(lat) || !isFinite(lon) || !lat || !lon || Math.abs(lat) >= 90 || Math.abs(lon) >= 180) continue;
            var line = text(mvj.LineRef);
            out.push({ line: line, tripKey: tripKeyOf(op, mvj, line + '/' + text(mvj.VehicleRef)),
                       directionId: text(mvj.DirectionRef), lat: lat, lon: lon,
                       time: parseIso(text(acts[k].RecordedAtTime)) || now() });
          }
        }
        return out;
      }, function (err, v) {
        if (!err) vehicleCache[op] = { t: now(), list: v };
        done(err, v, false);
      });
    }, cb);
  }

  function vehicles(routeId, cb) {
    cb = once(cb);
    if (!apiKey) return later(cb, noKey());
    var r = split(routeId);
    if (!r || !r.id) return later(cb, new Error('unknown route ' + routeId));
    function reply(err) {
      var e = vehicleCache[r.op], t = now();
      if (!e || t - e.t >= STALE_MAX) return cb(err || null, err ? undefined : []);
      var out = [];
      for (var i = 0; i < e.list.length; i++) {
        var v = e.list[i];
        if (lineIdOf(r.op, v.line) !== r.id) continue;
        out.push({ tripKey: v.tripKey, routeId: join(r.op, r.id), directionId: v.directionId, lat: v.lat, lon: v.lon, time: v.time });
      }
      cb(null, out);
    }
    var e = vehicleCache[r.op];
    if (e && now() - e.t < VEHICLE_AGE) return later(reply);
    if (!vmTable.pending.hasOwnProperty(r.op) && !take('vehicles')) return later(reply);
    fetchVehicles(r.op, function (err) { reply(err); });
  }

  // ------------------------------------------------------------ catalog (settings page)
  function stopInfo(stopId, cb) {
    cb = once(cb);
    if (!apiKey) return later(cb, noKey());
    var s = split(stopId);
    if (!s || !s.id) return later(cb, new Error('unknown stop ' + stopId));
    loadStops(s.op, function (err, stops) {
      if (err) return cb(err);
      var e = stops[s.id];
      if (!e) return cb(new Error('unknown stop ' + join(s.op, s.id)));
      cb(null, { id: join(s.op, s.id), name: e[0], lat: e[1], lon: e[2] });
    });
  }

  // every operator's lines; failing operators skipped, all failing → error
  function eachOperator(fn, cb) {
    var results = [], remaining = operators.length, lastErr = null;
    for (var i = 0; i < operators.length; i++) {
      (function (i) {
        fn(operators[i], function (err, v) {
          if (err) lastErr = err;
          results[i] = err ? null : v;
          if (--remaining === 0) {
            for (var k = 0; k < results.length; k++) if (results[k]) return cb(null, results);
            cb(lastErr || new Error('no operators'));
          }
        });
      })(i);
    }
  }

  function listRoutes(cb) {
    cb = once(cb);
    if (!apiKey) return later(cb, noKey());
    eachOperator(loadLines, function (err, all) {
      if (err) return cb(err);
      var out = [];
      for (var i = 0; i < all.length; i++) {
        var ls = all[i] || [];
        for (var k = 0; k < ls.length; k++) {
          var label = ls[k].shortName + (ls[k].longName ? ' ' + ls[k].longName : '');
          out.push({ id: join(operators[i], ls[k].id), label: operators.length > 1 ? operators[i] + ' ' + label : label });
        }
      }
      cb(null, out);
    });
  }

  // per operator: lines + stops (2 requests, cached 7 days). Stops get routeIds from routes already built.
  function catalog(cb, onProgress) {
    cb = once(cb);
    if (!apiKey) return later(cb, noKey());
    var count = 0;
    eachOperator(function (op, done) {
      var lines = null, stops = null, failed = null, remaining = 2;
      function step(err) {
        if (err) failed = err;
        if (--remaining > 0) return;
        count++;
        if (typeof onProgress === 'function') { try { onProgress(count, operators.length); } catch (e) { /* ignore */ } }
        if (!lines && !stops) return done(failed);
        done(null, { lines: lines || [], stops: stops || {} });
      }
      loadLines(op, function (err, v) { lines = v || null; step(err); });
      loadStops(op, function (err, v) { stops = v || null; step(err); });
    }, function (err, all) {
      if (err) return cb(err);
      var routes = [], stops = [], index = {};
      for (var i = 0; i < all.length; i++) {
        if (!all[i]) continue;
        var op = operators[i], ls = all[i].lines, sm = all[i].stops, k;
        for (var sid in sm) {
          if (!sm.hasOwnProperty(sid)) continue;
          var id = join(op, sid);
          index[id] = { id: id, name: sm[sid][0], routeIds: [], lat: sm[sid][1], lon: sm[sid][2] };
          stops.push(index[id]);
        }
        for (k = 0; k < ls.length; k++) {
          var rid = join(op, ls[k].id);
          routes.push({ id: rid, shortName: ls[k].shortName, longName: ls[k].longName });
          var built = builtRoute(rid);
          if (!built) continue;
          for (var d = 0; d < built.directions.length; d++) {
            var ids = built.directions[d].stopIds || [];
            for (var j = 0; j < ids.length; j++) {
              if (index.hasOwnProperty(ids[j]) && index[ids[j]].routeIds.indexOf(rid) < 0) index[ids[j]].routeIds.push(rid);
            }
          }
        }
      }
      cb(null, { routes: routes, stops: stops });
    });
  }

  return { stopsNear: stopsNear, arrivals: arrivals, route: route, vehicles: vehicles,
           listRoutes: listRoutes, routeInfo: routeInfo, stopInfo: stopInfo, catalog: catalog,
           operators: function () { return operators.slice(); } };
}

var plugin = {
  type: 'bay511',
  label: '511 Bay Area',
  area: { lat: 37.7749, lon: -122.4194, radius: 80000 },
  needsKey: true,
  keyUrl: KEY_URL,
  create: function (options, ctx) {
    return createBay511({ baseUrl: options.baseUrl, apiKey: options.apiKey, routeIds: ctx.routeIds }, ctx.http,
      { clock: ctx.clock, storage: ctx.storage });
  }
};

module.exports = { createBay511: createBay511, DEFAULT_BASE_URL: DEFAULT_BASE_URL, KEY_URL: KEY_URL,
                   parseIso: parseIso, parseOptions: parseOptions, plugin: plugin };
