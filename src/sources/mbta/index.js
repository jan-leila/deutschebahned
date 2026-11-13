'use strict';
// MBTA (Boston: subway, bus, commuter rail, ferry) provider: MBTA V3 API (JSON:API). ES5 only (runs in PebbleKit JS).
// See CONTRACTS.md §3.
//
// Stop ids are GTFS stops with location_type 0: platforms of stations (e.g. '70042' = State, Blue Line towards
// Wonderland) and plain bus / ferry stops. That is what route patterns, predictions, schedules and vehicles refer to, and
// one platform serves one travel direction, so the planner's same-name tiles and direction labels work. Parent
// stations ('place-…') are still accepted by arrivals() and stopInfo() (the API expands them to their platforms).
var geo = require('../../common/geo');
var util = require('../util');

var DEFAULT_BASE_URL = 'https://api-v3.mbta.com';
var MAX_IN_FLIGHT = 4;
var MAX_BATCH = 20;           // stop / route ids per batched request
var MAX_ROUTE_BATCH = 6;      // routes per /route_patterns request (shapes make these large)
var CACHE_PREFIX = 'busWatch.mbta.';
var CACHE_TTL = 7 * 86400;    // seconds

var COMPASS = { north: 'Northbound', south: 'Southbound', east: 'Eastbound', west: 'Westbound' };

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

function uniqueStrings(list) {
  var out = [];
  var seen = {};
  for (var i = 0; i < (list || []).length; i++) {
    if (list[i] == null) continue;
    var s = String(list[i]);
    if (s === '' || seen.hasOwnProperty(s)) continue;
    seen[s] = true;
    out.push(s);
  }
  return out;
}

function chunks(list, n) {
  var out = [];
  for (var i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

// ------------------------------------------------------------ time (ES5, no Intl)

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

// '2026-11-13T16:45:00-05:00' (also 'Z', '+0000', fractional seconds) → epoch seconds; anything else → NaN
function parseIso(s) {
  if (typeof s !== 'string') return NaN;
  var m = s.match(/^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d)(?:\.\d+)?)?(Z|([+-])(\d\d):?(\d\d))?$/);
  if (!m) return NaN;
  var t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0) / 1000;
  if (m[8]) t -= (m[8] === '-' ? -1 : 1) * (+m[9] * 3600 + +m[10] * 60);
  // no offset: the MBTA always sends one; treat it as Boston local time
  else if (!m[7]) t -= easternOffset(t) * 3600;
  return t;
}

// epoch s of the n-th Sunday (n >= 1) of month (0-based) at hourUtc UTC
function nthSunday(year, month, n, hourUtc) {
  var first = new Date(Date.UTC(year, month, 1)).getUTCDay();
  var day = 1 + ((7 - first) % 7) + (n - 1) * 7;
  return Date.UTC(year, month, day, hourUtc) / 1000;
}

// UTC offset of Boston (US Eastern) in hours at epoch s t: -4 from the 2nd Sunday of March 02:00 EST (07:00 UTC)
// to the 1st Sunday of November 02:00 EDT (06:00 UTC), else -5
function easternOffset(t) {
  var year = new Date(t * 1000).getUTCFullYear();
  return t >= nthSunday(year, 2, 2, 7) && t < nthSunday(year, 10, 1, 6) ? -4 : -5;
}

// schedule query window for [lo, hi] (epoch s) in MBTA service-day terms: {date: 'YYYY-MM-DD', min: 'HH:MM', max: 'HH:MM'}
// (a service day runs to 03:00 the next morning; times after midnight are written as 24:xx, 25:xx, …)
function serviceWindow(lo, hi) {
  var loLocal = lo + easternOffset(lo) * 3600;
  var hiLocal = hi + easternOffset(hi) * 3600;
  var d = new Date(loLocal * 1000);
  var dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  if (d.getUTCHours() < 3) dayStart -= 86400;
  var day = new Date(dayStart * 1000);
  var minLo = Math.max(0, Math.floor((loLocal - dayStart) / 60));
  var minHi = Math.max(minLo, Math.ceil((hiLocal - dayStart) / 60));
  function hhmm(m) { return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60); }
  return { date: day.getUTCFullYear() + '-' + pad2(day.getUTCMonth() + 1) + '-' + pad2(day.getUTCDate()),
           min: hhmm(minLo), max: hhmm(minHi) };
}

// ------------------------------------------------------------ JSON:API helpers

function relId(resource, name) {
  var r = resource && resource.relationships && resource.relationships[name];
  var d = r && r.data;
  return d && d.id != null ? String(d.id) : null;
}

function relIds(resource, name) {
  var r = resource && resource.relationships && resource.relationships[name];
  var d = r && r.data;
  var out = [];
  if (!(d instanceof Array)) return out;
  for (var i = 0; i < d.length; i++) if (d[i] && d[i].id != null) out.push(String(d[i].id));
  return out;
}

function attrs(resource) {
  return (resource && resource.attributes) || {};
}

// {type: {id: resource}} of a body's `included`
function indexIncluded(body) {
  var idx = {};
  var list = (body && body.included) || [];
  for (var i = 0; i < list.length; i++) {
    var x = list[i];
    if (!x || x.type == null || x.id == null) continue;
    if (!idx.hasOwnProperty(x.type)) idx[x.type] = {};
    idx[x.type][String(x.id)] = x;
  }
  return idx;
}

function lookup(idx, type, id) {
  return id != null && idx.hasOwnProperty(type) && idx[type].hasOwnProperty(id) ? idx[type][id] : null;
}

function dataList(body) {
  var d = body && body.data;
  return d instanceof Array ? d : [];
}

function errorOf(body) {
  var e = body && body.errors && body.errors[0];
  if (!e) return null;
  var status = e.status != null ? String(e.status) : '';
  if (e.code === 'forbidden' || status === '403') return new Error('MBTA API key rejected (HTTP 403)');
  var text = e.detail || e.title || e.code || 'error';
  return new Error('MBTA: ' + text + (status ? ' (HTTP ' + status + ')' : ''));
}

// stop name for lists where platforms of one station are told apart: 'State - Wonderland'
function displayName(a) {
  var name = trim(a.name);
  var platform = trim(a.platform_name);
  return platform && platform !== name ? name + ' - ' + platform : name;
}

function routeNames(id, a) {
  var sn = trim(a.short_name);
  var ln = trim(a.long_name);
  var shortName = sn || ln || id;
  return { shortName: shortName, longName: ln === shortName ? '' : ln };
}

// direction name: compass names → 'Southbound' (as other systems word them), else the destination ('Harvard Square')
function directionName(a, d) {
  var name = trim(a.direction_names && a.direction_names[d]);
  var dest = trim(a.direction_destinations && a.direction_destinations[d]);
  if (COMPASS.hasOwnProperty(name.toLowerCase())) return COMPASS[name.toLowerCase()];
  return dest || name;
}

// stop lists of a route's patterns (each in travel order) → one list: the first pattern, then stops of the others
// inserted after the last stop they share with it (branches follow the trunk)
function mergeStopLists(lists) {
  var merged = (lists[0] || []).slice();
  for (var i = 1; i < lists.length; i++) {
    var at = 0;
    for (var k = 0; k < lists[i].length; k++) {
      var idx = merged.indexOf(lists[i][k]);
      if (idx >= 0) {
        at = idx + 1;
      } else {
        merged.splice(at, 0, lists[i][k]);
        at++;
      }
    }
  }
  return merged;
}

// ------------------------------------------------------------ provider

function createMbta(opts, http, deps) {
  opts = opts || {};
  deps = deps || {};
  var baseUrl = String(opts.baseUrl || '').replace(/^\s+|\s+$/g, '').replace(/\/+$/, '') || DEFAULT_BASE_URL;
  var apiKey = trim(opts.apiKey);
  var configuredRoutes = uniqueStrings(opts.routeIds);
  var clock = deps.clock || function () { return Math.floor(new Date().getTime() / 1000); };
  var storage = deps.storage || null;

  function now() { return Math.floor(clock()); }

  // path + [[name, value]] → URL (values encodeURIComponent-ed but ',' and ':' kept readable; lists joined with ',';
  // the key, if any, last as api_key — a query parameter rather than the x-api-key header, so no CORS preflight)
  function enc(s) {
    return encodeURIComponent(String(s)).replace(/%2C/gi, ',').replace(/%3A/gi, ':');
  }

  function url(path, params) {
    var q = [];
    for (var i = 0; i < (params || []).length; i++) {
      var v = params[i][1];
      if (v instanceof Array) {
        var parts = [];
        for (var k = 0; k < v.length; k++) parts.push(encodeURIComponent(String(v[k])));
        v = parts.join(',');
      } else {
        v = enc(v);
      }
      q.push(params[i][0] + '=' + v);
    }
    if (apiKey) q.push('api_key=' + encodeURIComponent(apiKey));
    return baseUrl + path + (q.length ? '?' + q.join('&') : '');
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
    var sync = true;
    function finish(err, body) {
      if (finished) return;
      finished = true;
      if (sync) return later(deliver, err, body);
      deliver(err, body);
    }
    function deliver(err, body) {
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
      finish(toError(e));
    }
    sync = false;
  }

  // GET; checks JSON:API `errors`; map(body) → value (exceptions reach cb)
  function get(path, params, map, cb) {
    queue.push({
      url: url(path, params),
      cb: function (err, body) {
        if (err) return cb(toError(err));
        if (body == null || typeof body !== 'object') return cb(new Error('MBTA: empty response'));
        var apiErr = errorOf(body);
        if (apiErr) return cb(apiErr);
        if (body.data == null) return cb(new Error('MBTA: bad response'));
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

  // collects calls made in the same tick; flush(items) runs once on the next tick
  function batcher(flush) {
    var pending = null;
    return function (item) {
      if (!pending) {
        pending = [];
        setTimeout(function () {
          var items = pending;
          pending = null;
          flush(items);
        }, 0);
      }
      pending.push(item);
    };
  }

  // ---------------------------------------------------------- storage cache
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

  // ---------------------------------------------------------- arrivals (batched: one /predictions + one /schedules)
  var addArrivalRequest = batcher(function (items) {
    // parent stations alone (all their platforms' times belong to the requested id); other stops together
    var groups = [];
    var plain = [];
    var byId = {};
    for (var i = 0; i < items.length; i++) {
      var id = items[i].id;
      if (/^place-/.test(id)) {
        groups.push({ ids: [id], parent: true, items: [items[i]] });
        continue;
      }
      if (!byId.hasOwnProperty(id)) {
        byId[id] = [];
        plain.push(id);
      }
      byId[id].push(items[i]);
    }
    var parts = chunks(plain, MAX_BATCH);
    for (var p = 0; p < parts.length; p++) {
      var its = [];
      for (var k = 0; k < parts[p].length; k++) its = its.concat(byId[parts[p][k]]);
      groups.push({ ids: parts[p], parent: false, items: its });
    }
    for (var g = 0; g < groups.length; g++) fetchArrivals(groups[g]);
  });

  function fetchArrivals(group) {
    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i < group.items.length; i++) {
      if (group.items[i].lo < lo) lo = group.items[i].lo;
      if (group.items[i].hi > hi) hi = group.items[i].hi;
    }
    var win = serviceWindow(lo, hi);
    var results = {};
    var remaining = 2;
    function got(kind) {
      return function (err, value) {
        results[kind] = { err: err, value: value };
        if (--remaining === 0) deliver();
      };
    }
    get('/predictions', [['filter[stop]', group.ids], ['include', 'trip'],
      ['fields[prediction]', 'arrival_time,departure_time,schedule_relationship,stop_sequence'], ['fields[trip]', 'headsign']],
      function (body) { return mapTimes(body, group, true); }, got('pred'));
    get('/schedules', [['filter[stop]', group.ids], ['filter[date]', win.date], ['filter[min_time]', win.min],
      ['filter[max_time]', win.max], ['include', 'trip'], ['fields[schedule]', 'arrival_time,departure_time,stop_sequence'],
      ['fields[trip]', 'headsign']],
      function (body) { return mapTimes(body, group, false); }, got('sched'));

    function deliver() {
      var pred = results.pred, sched = results.sched;
      var j;
      if (pred.err && sched.err) {
        for (j = 0; j < group.items.length; j++) group.items[j].cb(pred.err);
        return;
      }
      var merged;
      try {
        merged = mergeTimes(pred.err ? [] : pred.value, sched.err ? [] : sched.value);
      } catch (e) {
        for (j = 0; j < group.items.length; j++) group.items[j].cb(toError(e));
        return;
      }
      for (j = 0; j < group.items.length; j++) {
        var it = group.items[j];
        var out = [];
        for (var k = 0; k < merged.length; k++) {
          var a = merged[k];
          if (a.stopId === it.id && a.time >= it.lo && a.time <= it.hi) {
            out.push({ stopId: a.stopId, routeId: a.routeId, tripKey: a.tripKey, time: a.time, predicted: a.predicted, headsign: a.headsign });
          }
        }
        it.cb(null, out);
      }
    }
  }

  // predictions / schedules body → [{stopId, routeId, tripKey, seq, time (NaN = skipped / cancelled), predicted, headsign}]
  function mapTimes(body, group, predicted) {
    var idx = indexIncluded(body);
    var list = dataList(body);
    var out = [];
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      var x = list[i];
      if (!x || x.id == null || seen.hasOwnProperty(x.id)) continue; // a stop asked for twice (station + platform)
      seen[x.id] = true;
      var a = attrs(x);
      var trip = relId(x, 'trip');
      var stop = group.parent ? group.ids[0] : relId(x, 'stop');
      if (trip == null || stop == null) continue;
      var rel = a.schedule_relationship;
      var time = rel === 'CANCELLED' || rel === 'SKIPPED' ? NaN : parseIso(a.departure_time || a.arrival_time);
      var t = lookup(idx, 'trip', trip);
      out.push({ stopId: stop, routeId: String(relId(x, 'route') || ''), tripKey: trip,
                 seq: a.stop_sequence != null ? String(a.stop_sequence) : '', time: time, predicted: predicted,
                 headsign: trim(attrs(t).headsign) });
    }
    return out;
  }

  // predictions win; a scheduled time is added when its trip has no prediction (or a cancelled / skipped one) and it is
  // later than the last prediction of that route at that stop (earlier scheduled trips have gone or run as other trips)
  function mergeTimes(preds, scheds) {
    var out = [];
    var predictedVisit = {};
    var lastPred = {};
    var i, a, key;
    for (i = 0; i < preds.length; i++) {
      a = preds[i];
      key = a.stopId + '|' + a.tripKey + '|' + a.seq;
      predictedVisit[key] = true;
      if (!isFinite(a.time)) continue;
      var rk = a.stopId + '|' + a.routeId;
      if (!lastPred.hasOwnProperty(rk) || a.time > lastPred[rk]) lastPred[rk] = a.time;
      out.push(a);
    }
    for (i = 0; i < scheds.length; i++) {
      a = scheds[i];
      if (!isFinite(a.time)) continue;
      if (predictedVisit.hasOwnProperty(a.stopId + '|' + a.tripKey + '|' + a.seq)) continue;
      var last = lastPred[a.stopId + '|' + a.routeId];
      if (last !== undefined && a.time <= last) continue;
      out.push(a);
    }
    return sortBy(out, function (x) { return x.time; });
  }

  function arrivals(stopId, minutesBefore, minutesAfter, cb) {
    cb = once(cb);
    var t = now();
    addArrivalRequest({ id: String(stopId), lo: t - (+minutesBefore || 0) * 60, hi: t + (+minutesAfter || 0) * 60, cb: cb });
  }

  // ---------------------------------------------------------- route (batched /route_patterns, cached in storage)
  var built = {};     // routeId -> Route (this provider's lifetime)
  var waiting = {};   // routeId -> [cb] while a fetch is running

  var addRouteRequest = batcher(function (ids) {
    var parts = chunks(ids, MAX_ROUTE_BATCH);
    for (var p = 0; p < parts.length; p++) fetchRoutes(parts[p]);
  });

  function settleRoute(id, err, value) {
    var cbs = waiting[id] || [];
    delete waiting[id];
    if (!err) built[id] = value;
    for (var i = 0; i < cbs.length; i++) {
      try {
        cbs[i](err, value);
      } catch (e) {
        // one waiter's failure must not stop the others
      }
    }
  }

  function fetchRoutes(ids) {
    get('/route_patterns', [['filter[route]', ids], ['include', 'route,representative_trip.shape,representative_trip.stops'],
      ['fields[route]', 'short_name,long_name,color,direction_names,direction_destinations'],
      ['fields[route_pattern]', 'direction_id,typicality,sort_order'], ['fields[stop]', 'name,latitude,longitude']],
      function (body) { return buildRoutes(body, ids); },
      function (err, routes) {
        for (var i = 0; i < ids.length; i++) {
          var id = ids[i];
          if (err) settleRoute(id, err);
          else if (!routes.hasOwnProperty(id)) settleRoute(id, new Error('unknown route ' + id));
          else {
            cacheSet('route.' + id, pack(routes[id]));
            settleRoute(id, null, routes[id]);
          }
        }
      });
  }

  // /route_patterns body → {routeId: Route} for the asked ids that have patterns
  function buildRoutes(body, ids) {
    var idx = indexIncluded(body);
    var byRoute = {};
    var list = dataList(body);
    var i;
    for (i = 0; i < list.length; i++) {
      var rid = relId(list[i], 'route');
      if (rid == null) continue;
      if (!byRoute.hasOwnProperty(rid)) byRoute[rid] = [];
      byRoute[rid].push(list[i]);
    }
    var out = {};
    for (i = 0; i < ids.length; i++) {
      if (byRoute.hasOwnProperty(ids[i])) out[ids[i]] = buildRoute(ids[i], byRoute[ids[i]], idx);
    }
    return out;
  }

  function buildRoute(id, patterns, idx) {
    var ra = attrs(lookup(idx, 'route', id));
    var names = routeNames(id, ra);
    var stops = {};
    // per direction: the typical patterns (typicality 1; else the most typical there is), in sort order
    var byDir = {};
    var dirIds = [];
    var i;
    for (i = 0; i < patterns.length; i++) {
      var pa = attrs(patterns[i]);
      var d = String(pa.direction_id != null ? pa.direction_id : '0');
      if (!byDir.hasOwnProperty(d)) {
        byDir[d] = [];
        dirIds.push(d);
      }
      byDir[d].push({ typicality: pa.typicality != null ? +pa.typicality : 9, sort: +pa.sort_order || 0, p: patterns[i] });
    }
    dirIds.sort();
    var directions = [];
    for (var k = 0; k < dirIds.length; k++) {
      var cands = byDir[dirIds[k]];
      var best = Infinity;
      for (i = 0; i < cands.length; i++) if (cands[i].typicality < best) best = cands[i].typicality;
      var chosen = [];
      for (i = 0; i < cands.length; i++) if (cands[i].typicality === best) chosen.push(cands[i]);
      chosen = sortBy(chosen, function (c) { return c.sort; });
      var lists = [];
      var paths = [];
      for (i = 0; i < chosen.length; i++) {
        var trip = lookup(idx, 'trip', relId(chosen[i].p, 'representative_trip'));
        if (!trip) continue;
        var sids = relIds(trip, 'stops');
        var ordered = [];
        var pts = [];
        for (var s = 0; s < sids.length; s++) {
          var st = attrs(lookup(idx, 'stop', sids[s]));
          var lat = +st.latitude, lon = +st.longitude;
          if (st.latitude == null || !isFinite(lat) || !isFinite(lon)) continue;
          ordered.push(sids[s]);
          pts.push({ lat: lat, lon: lon });
          if (!stops.hasOwnProperty(sids[s])) stops[sids[s]] = { id: sids[s], name: trim(st.name), lat: lat, lon: lon };
        }
        lists.push(ordered);
        var shape = lookup(idx, 'shape', relId(trip, 'shape'));
        var line = shape && typeof attrs(shape).polyline === 'string' ? geo.decodePolyline(attrs(shape).polyline) : [];
        paths.push(line.length >= 2 ? line : pts);
      }
      directions.push({ id: dirIds[k], name: directionName(ra, +dirIds[k]), stopIds: mergeStopLists(lists), paths: paths });
    }
    return { id: id, shortName: names.shortName, longName: names.longName, color: util.color(ra.color),
             directions: directions, stops: stops };
  }

  // storage form: paths as encoded polylines (a tenth of the size)
  function pack(r) {
    var dirs = [];
    for (var i = 0; i < r.directions.length; i++) {
      var d = r.directions[i];
      var enc = [];
      for (var k = 0; k < d.paths.length; k++) enc.push(geo.encodePolyline(d.paths[k]));
      dirs.push({ id: d.id, name: d.name, stopIds: d.stopIds, paths: enc });
    }
    return { id: r.id, shortName: r.shortName, longName: r.longName, color: r.color, directions: dirs, stops: r.stops };
  }

  function unpack(v) {
    if (!v || !(v.directions instanceof Array) || !v.stops) return null;
    var dirs = [];
    for (var i = 0; i < v.directions.length; i++) {
      var d = v.directions[i];
      var paths = [];
      for (var k = 0; k < (d.paths || []).length; k++) paths.push(geo.decodePolyline(d.paths[k]));
      dirs.push({ id: String(d.id), name: String(d.name || ''), stopIds: d.stopIds || [], paths: paths });
    }
    return { id: String(v.id), shortName: String(v.shortName || v.id), longName: String(v.longName || ''),
             color: String(v.color || ''), directions: dirs, stops: v.stops };
  }

  function route(routeId, cb) {
    cb = once(cb);
    var id = String(routeId);
    if (built.hasOwnProperty(id)) return later(cb, null, built[id]);
    if (waiting.hasOwnProperty(id)) {
      waiting[id].push(cb);
      return;
    }
    var cached = null;
    try {
      cached = unpack(cacheGet('route.' + id));
    } catch (e) {
      cached = null;
    }
    if (cached) {
      built[id] = cached;
      return later(cb, null, cached);
    }
    waiting[id] = [cb];
    addRouteRequest(id);
  }

  // ---------------------------------------------------------- stopsNear (from the configured routes; no request once cached)
  function stopsNear(pos, radiusMeters, cb) {
    cb = once(cb);
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

  // ---------------------------------------------------------- vehicles (batched /vehicles)
  var addVehicleRequest = batcher(function (items) {
    var ids = [];
    var byId = {};
    for (var i = 0; i < items.length; i++) {
      if (!byId.hasOwnProperty(items[i].id)) {
        byId[items[i].id] = [];
        ids.push(items[i].id);
      }
      byId[items[i].id].push(items[i].cb);
    }
    var parts = chunks(ids, MAX_BATCH);
    for (var p = 0; p < parts.length; p++) fetchVehicles(parts[p], byId);
  });

  function fetchVehicles(ids, byId) {
    get('/vehicles', [['filter[route]', ids], ['fields[vehicle]', 'latitude,longitude,updated_at,direction_id']], function (body) {
      var list = dataList(body);
      var out = {};
      for (var i = 0; i < ids.length; i++) out[ids[i]] = [];
      for (i = 0; i < list.length; i++) {
        var v = list[i];
        var a = attrs(v);
        var rid = relId(v, 'route');
        var trip = relId(v, 'trip');
        var t = parseIso(a.updated_at);
        var lat = +a.latitude, lon = +a.longitude;
        if (rid == null || !out.hasOwnProperty(rid) || trip == null) continue;
        if (a.latitude == null || !isFinite(lat) || !isFinite(lon) || !isFinite(t) || (!lat && !lon)) continue;
        out[rid].push({ tripKey: trip, routeId: rid, directionId: String(a.direction_id != null ? a.direction_id : ''),
                        lat: lat, lon: lon, time: t });
      }
      return out;
    }, function (err, out) {
      for (var i = 0; i < ids.length; i++) {
        var cbs = byId[ids[i]];
        for (var k = 0; k < cbs.length; k++) {
          if (err) cbs[k](err);
          else cbs[k](null, out[ids[i]].slice());
        }
      }
    });
  }

  function vehicles(routeId, cb) {
    addVehicleRequest({ id: String(routeId), cb: once(cb) });
  }

  // ---------------------------------------------------------- catalog (settings page)
  var routeTable = null;      // {done: [route resources] | undefined, waiters: [cb]}

  // every listed route: /routes (fetched once per provider) → [{id, shortName, longName, label}]
  function loadRoutes(cb) {
    if (routeTable && routeTable.done) return later(cb, null, routeTable.done);
    if (routeTable) {
      routeTable.waiters.push(cb);
      return;
    }
    routeTable = { waiters: [cb] };
    get('/routes', [['fields[route]', 'short_name,long_name']], function (body) {
      var list = dataList(body);
      var out = [];
      for (var i = 0; i < list.length; i++) {
        if (!list[i] || list[i].id == null || list[i].id === '') continue;
        var id = String(list[i].id);
        var a = attrs(list[i]);
        var n = routeNames(id, a);
        var sn = trim(a.short_name), ln = trim(a.long_name);
        out.push({ id: id, shortName: n.shortName, longName: n.longName,
                   label: sn && ln && (' ' + ln + ' ').indexOf(' ' + sn + ' ') < 0 ? sn + ' ' + ln : ln || n.shortName });
      }
      return out;
    }, function (err, list) {
      var waiters = routeTable.waiters;
      if (err) routeTable = null;
      else routeTable = { done: list, waiters: [] };
      for (var i = 0; i < waiters.length; i++) waiters[i](err, list);
    });
  }

  function listRoutes(cb) {
    cb = once(cb);
    loadRoutes(function (err, list) {
      if (err) return cb(err);
      var out = [];
      for (var i = 0; i < list.length; i++) out.push({ id: list[i].id, label: list[i].label });
      cb(null, out);
    });
  }

  // a Route is a RouteInfo; one request (shared with route()), so no cheaper path is needed
  function routeInfo(routeId, cb) {
    route(routeId, cb);
  }

  // /stops/{id} → {id, name ('State - Wonderland' for a platform), lat, lon}
  function stopInfo(stopId, cb) {
    cb = once(cb);
    var id = String(stopId);
    get('/stops/' + encodeURIComponent(id), [['fields[stop]', 'name,latitude,longitude,platform_name']], function (body) {
      var a = attrs(body.data);
      var lat = +a.latitude, lon = +a.longitude;
      if (a.latitude == null || !isFinite(lat) || !isFinite(lon)) throw new Error('no coordinates for stop ' + id);
      return { id: body.data.id != null ? String(body.data.id) : id, name: displayName(a), lat: lat, lon: lon };
    }, cb);
  }

  // the whole network in two requests: /routes, then every route pattern with its representative trip's stops
  // (~4 MB, all patterns so that stops only some trips serve are found too)
  function catalog(cb, onProgress) {
    cb = once(cb);
    function progress(done) {
      if (typeof onProgress === 'function') {
        try { onProgress(done, 2); } catch (e) { /* progress display only */ }
      }
    }
    loadRoutes(function (err, list) {
      if (err) return cb(err);
      progress(1);
      get('/route_patterns', [['include', 'representative_trip.stops'], ['fields[route_pattern]', 'direction_id'],
        ['fields[trip]', 'headsign'], ['fields[stop]', 'name,latitude,longitude,platform_name']], function (body) {
        var idx = indexIncluded(body);
        var patterns = dataList(body);
        var routes = [];
        var known = {};
        var i;
        for (i = 0; i < list.length; i++) {
          routes.push({ id: list[i].id, shortName: list[i].shortName, longName: list[i].longName });
          known[list[i].id] = true;
        }
        var stops = {};
        var order = [];
        for (i = 0; i < patterns.length; i++) {
          var rid = relId(patterns[i], 'route');
          if (rid == null || !known.hasOwnProperty(rid)) continue; // unlisted routes (shuttles, …)
          var sids = relIds(lookup(idx, 'trip', relId(patterns[i], 'representative_trip')), 'stops');
          for (var k = 0; k < sids.length; k++) {
            var sid = sids[k];
            if (!stops.hasOwnProperty(sid)) {
              var st = lookup(idx, 'stop', sid);
              if (!st) continue;
              var a = attrs(st);
              var s = { id: sid, name: displayName(a), routeIds: [] };
              var lat = +a.latitude, lon = +a.longitude;
              if (a.latitude != null && isFinite(lat) && isFinite(lon)) {
                s.lat = lat;
                s.lon = lon;
              }
              stops[sid] = s;
              order.push(sid);
            }
            if (stops[sid].routeIds.indexOf(rid) < 0) stops[sid].routeIds.push(rid);
          }
        }
        var out = [];
        for (i = 0; i < order.length; i++) out.push(stops[order[i]]);
        return { routes: routes, stops: out };
      }, function (err2, data) {
        if (err2) return cb(err2);
        progress(2);
        cb(null, data);
      });
    });
  }

  return { stopsNear: stopsNear, arrivals: arrivals, route: route, vehicles: vehicles,
           listRoutes: listRoutes, routeInfo: routeInfo, stopInfo: stopInfo, catalog: catalog };
}

var plugin = {
  type: 'mbta',
  label: 'MBTA (Boston)',
  area: { lat: 42.3601, lon: -71.0589, radius: 60000 },   // a key is optional (it raises the rate limit)
  keyUrl: 'https://api-v3.mbta.com',
  create: function (options, ctx) {
    options = options || {};
    return createMbta({ baseUrl: options.baseUrl, apiKey: options.apiKey, routeIds: ctx.routeIds }, ctx.http,
      { clock: ctx.clock, storage: ctx.storage });
  }
};

module.exports = { createMbta: createMbta, DEFAULT_BASE_URL: DEFAULT_BASE_URL, plugin: plugin,
                   parseIso: parseIso, easternOffset: easternOffset, serviceWindow: serviceWindow };
