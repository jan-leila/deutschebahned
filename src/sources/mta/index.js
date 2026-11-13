'use strict';
// MTA Bus Time (New York City: MTA NYCT + MTA Bus) provider. ES5 only (runs in PebbleKit JS). See CONTRACTS.md §3.
//
// Static data: MTA's OneBusAway "where" API without real-time data ({base}/api/where/…, OBA REST v2 envelope).
// Real time: SIRI StopMonitoring / VehicleMonitoring JSON ({base}/api/siri/…). One key for both
// (https://register.developer.obanyc.com).
//
// Ids (what the app stores): stops are the OBA ids 'MTA_308209' (SIRI MonitoringRef takes the bare '308209'; SIRI
// StopPointRef is 'MTA_308209' again), routes are 'MTA NYCT_B63' / 'MTABC_Q53+' (OBA route id = SIRI LineRef),
// tripKey = SIRI DatedVehicleJourneyRef.
//
// The SIRI JSON nesting (array vs object at each level, v1 vs v2, DestinationName string vs array) is parsed
// tolerantly: every level accepts an object or an array of them, every text a string, an array or {value}.
var geo = require('../../common/geo');
var util = require('../util');

var DEFAULT_BASE_URL = 'https://bustime-classic.mta.info';
var KEY_URL = 'https://register.developer.obanyc.com';
var AGENCIES = ['MTA NYCT', 'MTABC'];
var STOP_PREFIX = 'MTA_';
var CACHE_PREFIX = 'busWatch.mta.';
var CACHE_TTL = 7 * 86400; // seconds
var CATALOG_IN_FLIGHT = 3;
var MAX_STOP_VISITS = 30;
var M_PER_DEG_LAT = 111320;

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

function decodeAll(polylines) {
  var paths = [];
  if (!polylines) return paths;
  for (var i = 0; i < polylines.length; i++) {
    if (polylines[i] && typeof polylines[i].points === 'string') paths.push(geo.decodePolyline(polylines[i].points));
  }
  return paths;
}

function strList(a) {
  var out = [];
  if (!a) return out;
  for (var i = 0; i < a.length; i++) out.push(String(a[i]));
  return out;
}

function trim(s) {
  return String(s).replace(/^\s+|\s+$/g, '');
}

// ---------------------------------------------------------------- tolerant SIRI helpers
// object-or-array → array
function list(v) {
  if (v == null) return [];
  return v instanceof Array ? v : [v];
}

// object-or-array → first object (or null)
function first(v) {
  var l = list(v);
  return l.length ? l[0] : null;
}

// string / number / [text…] / {value} → trimmed string ('' if none)
function text(v) {
  if (v == null) return '';
  if (typeof v === 'string') return trim(v);
  if (typeof v === 'number') return String(v);
  if (v instanceof Array) {
    for (var i = 0; i < v.length; i++) {
      var t = text(v[i]);
      if (t) return t;
    }
    return '';
  }
  if (typeof v === 'object') return text(v.value != null ? v.value : v._);
  return '';
}

// ISO 8601 with offset ('2026-11-13T16:44:34.369-05:00', 'Z', '-0500') → epoch seconds (rounded); NaN if unparseable
function parseIso(v) {
  var s = text(v);
  if (!s) return NaN;
  var m = s.match(/^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d)(\.\d+)?)?(Z|[+-]\d\d(?::?\d\d)?)?$/);
  if (!m) {
    var t = Date.parse(s);
    return isFinite(t) ? Math.round(t / 1000) : NaN;
  }
  var ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) + (m[7] ? Math.round(parseFloat(m[7]) * 1000) : 0);
  var tz = m[8];
  if (tz && tz !== 'Z') {
    var sign = tz.charAt(0) === '-' ? -1 : 1;
    var digits = tz.slice(1).replace(':', '');
    var offMin = (+digits.slice(0, 2)) * 60 + (+(digits.slice(2, 4) || 0));
    ms -= sign * offMin * 60000;
  } else if (!tz) {
    // no offset: let the JS engine decide (local time); MTA always sends one
    var local = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
    ms = local + (m[7] ? Math.round(parseFloat(m[7]) * 1000) : 0);
  }
  return Math.round(ms / 1000);
}

function keyHint(msg) {
  return /key/i.test(msg) ? msg + ' (MTA Bus Time API keys: ' + KEY_URL + ')' : msg;
}

// text of a SIRI ErrorCondition: Description, else the ErrorText of any child (OtherError, NoInfoForTopicError, …)
function siriErrorText(ec) {
  var d = text(ec.Description);
  if (d) return d;
  for (var k in ec) {
    if (!ec.hasOwnProperty(k)) continue;
    var c = first(ec[k]);
    if (c && typeof c === 'object' && text(c.ErrorText)) return text(c.ErrorText);
  }
  return 'SIRI error';
}

// Siri.ServiceDelivery.<name>[] (errors in any delivery, whatever its name, → throw)
function siriDeliveries(body, name) {
  var siri = body && (body.Siri || body.siri || body);
  var sd = siri && first(siri.ServiceDelivery);
  if (!sd || typeof sd !== 'object') throw new Error('bad SIRI response from MTA Bus Time');
  var ec = first(sd.ErrorCondition);
  if (ec) throw new Error(keyHint('MTA Bus Time: ' + siriErrorText(ec)));
  for (var k in sd) {
    if (!sd.hasOwnProperty(k) || !/Delivery$/.test(k)) continue;
    var ds = list(sd[k]);
    for (var i = 0; i < ds.length; i++) {
      var e = ds[i] && first(ds[i].ErrorCondition);
      if (e) throw new Error(keyHint('MTA Bus Time: ' + siriErrorText(e)));
    }
  }
  return list(sd[name]);
}

// ---------------------------------------------------------------- ids
// app stop id ('MTA_308209') → SIRI MonitoringRef ('308209')
function monitoringRef(stopId) {
  var s = String(stopId);
  return s.indexOf(STOP_PREFIX) === 0 ? s.slice(STOP_PREFIX.length) : s;
}

// SIRI / bare stop ref → app stop id
function appStopId(ref) {
  var s = String(ref);
  return /^\d+$/.test(s) ? STOP_PREFIX + s : s;
}

function createMta(opts, http, deps) {
  opts = opts || {};
  deps = deps || {};
  var baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '') || DEFAULT_BASE_URL;
  var rawKey = trim(opts.apiKey || '');
  var key = encodeURIComponent(rawKey);
  var where = baseUrl + '/api/where';
  var siri = baseUrl + '/api/siri';
  var clock = deps.clock || function () { return Math.floor(new Date().getTime() / 1000); };
  var storage = deps.storage || null;

  function now() { return Math.floor(clock()); }

  function missingKey() {
    return new Error('MTA Bus Time needs an API key: get one at ' + KEY_URL);
  }

  // raw GET; cb(err, body) exactly once, asynchronously
  function fetch(url, cb) {
    cb = once(cb);
    if (!rawKey) return later(cb, missingKey());
    try {
      http(url, function (err, body) {
        if (err) return cb(toError(err));
        cb(null, body);
      });
    } catch (e) {
      later(cb, toError(e));
    }
  }

  // GET an OBA url, check the envelope, map data
  function getOba(url, map, cb) {
    fetch(url, function (err, body) {
      if (err) return cb(err);
      // MTA answers a missing / wrong key with a literal `null` body (HTTP 200)
      if (body == null) return cb(new Error('no data from MTA Bus Time: is the API key valid? (keys: ' + KEY_URL + ')'));
      if (typeof body !== 'object') return cb(new Error('empty response'));
      if (body.code !== 200) {
        var msg = String(body.text || 'HTTP ' + body.code);
        if (body.code === 401 || body.code === 403) msg = keyHint(msg + ' (API key)');
        return cb(new Error(msg));
      }
      var value;
      try {
        value = map(body.data || {});
      } catch (e) {
        return cb(toError(e));
      }
      cb(null, value);
    });
  }

  // GET a SIRI url, map its deliveries of one kind
  function getSiri(url, name, map, cb) {
    fetch(url, function (err, body) {
      if (err) return cb(err);
      var value;
      try {
        value = map(siriDeliveries(body, name));
      } catch (e) {
        return cb(toError(e));
      }
      cb(null, value);
    });
  }

  // ---------------------------------------------------------------- storage cache
  function cacheGet(k) {
    if (!storage) return null;
    try {
      var raw = storage.getItem(CACHE_PREFIX + k);
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

  function cacheSet(k, value) {
    if (!storage) return;
    try {
      storage.setItem(CACHE_PREFIX + k, JSON.stringify({ t: now(), v: value }));
    } catch (e) {
      // best effort
    }
  }

  // ---------------------------------------------------------------- stopsNear (OBA stops-for-location, lat/lon spans)
  function stopsNear(pos, radiusMeters, cb) {
    cb = once(cb);
    var r = +radiusMeters > 0 ? +radiusMeters : 0;
    var latSpan = 2 * r / M_PER_DEG_LAT;
    var cosLat = Math.cos(pos.lat * Math.PI / 180);
    var lonSpan = 2 * r / (M_PER_DEG_LAT * (cosLat > 0.01 ? cosLat : 0.01));
    var url = where + '/stops-for-location.json?lat=' + pos.lat + '&lon=' + pos.lon +
      '&latSpan=' + latSpan.toFixed(6) + '&lonSpan=' + lonSpan.toFixed(6) + '&key=' + key;
    getOba(url, function (data) {
      var l = data.list || [];
      var stops = [];
      for (var i = 0; i < l.length; i++) {
        var s = l[i];
        if (!s || s.id == null) continue;
        var stop = { id: String(s.id), name: s.name || '', lat: +s.lat, lon: +s.lon, routeIds: strList(s.routeIds) };
        // the box's corners lie outside the radius
        if (!(geo.distance(pos, stop) <= r)) continue;
        stops.push(stop);
      }
      return sortBy(stops, function (s) { return geo.distance(pos, s); });
    }, cb);
  }

  // ---------------------------------------------------------------- arrivals (SIRI StopMonitoring)
  function arrivals(stopId, minutesBefore, minutesAfter, cb) {
    cb = once(cb);
    var sid = String(stopId);
    var url = siri + '/stop-monitoring.json?key=' + key + '&version=2&OperatorRef=MTA&MonitoringRef=' +
      encodeURIComponent(monitoringRef(sid)) + '&MaximumStopVisits=' + MAX_STOP_VISITS;
    getSiri(url, 'StopMonitoringDelivery', function (deliveries) {
      var t = now();
      var lo = t - (+minutesBefore || 0) * 60;
      var hi = t + (+minutesAfter || 0) * 60;
      var out = [];
      for (var d = 0; d < deliveries.length; d++) {
        var visits = list(deliveries[d] && deliveries[d].MonitoredStopVisit);
        for (var i = 0; i < visits.length; i++) {
          var j = visits[i] && first(visits[i].MonitoredVehicleJourney);
          if (!j) continue;
          var c = first(j.MonitoredCall) || {};
          var expected = parseIso(c.ExpectedArrivalTime);
          if (!isFinite(expected)) expected = parseIso(c.ExpectedDepartureTime);
          var aimed = parseIso(c.AimedArrivalTime);
          if (!isFinite(aimed)) aimed = parseIso(c.AimedDepartureTime);
          var predicted = isFinite(expected);
          var time = predicted ? expected : aimed;
          if (!isFinite(time) || time < lo || time > hi) continue;
          var fr = first(j.FramedVehicleJourneyRef);
          var tripKey = text(fr && fr.DatedVehicleJourneyRef) || text(j.DatedVehicleJourneyRef);
          var routeId = text(j.LineRef);
          if (!tripKey || !routeId) continue;
          out.push({
            stopId: appStopId(text(c.StopPointRef) || sid),
            routeId: routeId,
            tripKey: tripKey,
            time: time,
            predicted: predicted,
            headsign: text(j.DestinationName)
          });
        }
      }
      return sortBy(out, function (a) { return a.time; });
    }, cb);
  }

  // ---------------------------------------------------------------- vehicles (SIRI VehicleMonitoring, always per LineRef)
  function vehicles(routeId, cb) {
    cb = once(cb);
    var rid = routeId == null ? '' : trim(routeId);
    // MTA revokes keys that poll every vehicle: never call VehicleMonitoring without a LineRef
    if (!rid) return later(cb, new Error('MTA Bus Time vehicles need a route (LineRef)'));
    var url = siri + '/vehicle-monitoring.json?key=' + key + '&version=2&LineRef=' + encodeURIComponent(rid);
    getSiri(url, 'VehicleMonitoringDelivery', function (deliveries) {
      var out = [];
      for (var d = 0; d < deliveries.length; d++) {
        var acts = list(deliveries[d] && deliveries[d].VehicleActivity);
        for (var i = 0; i < acts.length; i++) {
          var a = acts[i];
          var j = a && first(a.MonitoredVehicleJourney);
          if (!j) continue;
          var loc = first(j.VehicleLocation) || {};
          var lat = +text(loc.Latitude);
          var lon = +text(loc.Longitude);
          if (!lat || !lon || !isFinite(lat) || !isFinite(lon)) continue;
          var time = parseIso(a.RecordedAtTime);
          if (!isFinite(time)) continue;
          var fr = first(j.FramedVehicleJourneyRef);
          var tripKey = text(fr && fr.DatedVehicleJourneyRef) || text(j.DatedVehicleJourneyRef);
          if (!tripKey) continue;
          out.push({
            tripKey: tripKey,
            routeId: text(j.LineRef) || rid,
            directionId: text(j.DirectionRef),
            lat: lat,
            lon: lon,
            time: time
          });
        }
      }
      return out;
    }, cb);
  }

  // ---------------------------------------------------------------- route (OBA stops-for-route + polylines; cached 7 days)
  function mapRoute(routeId, data) {
    var entry = data.entry || {};
    var refs = data.references || {};
    var i, j;

    var shortName = String(routeId);
    var longName = '';
    var color = '';
    var routes = refs.routes || [];
    for (i = 0; i < routes.length; i++) {
      if (String(routes[i].id) === String(routeId)) {
        shortName = routes[i].shortName || routes[i].longName || String(routes[i].id);
        longName = String(routes[i].longName || routes[i].description || '');
        color = util.color(routes[i].color);
        break;
      }
    }

    var directions = [];
    var groupings = entry.stopGroupings || [];
    for (i = 0; i < groupings.length; i++) {
      var groups = groupings[i].stopGroups || [];
      for (j = 0; j < groups.length; j++) {
        var g = groups[j];
        directions.push({
          id: String(g.id),
          name: (g.name && g.name.name) || '',
          stopIds: strList(g.stopIds),
          paths: decodeAll(g.polylines)
        });
      }
    }
    if (!directions.length) {
      directions.push({ id: '0', name: '', stopIds: strList(entry.stopIds), paths: decodeAll(entry.polylines) });
    }

    var stops = {};
    var refStops = refs.stops || [];
    for (i = 0; i < refStops.length; i++) {
      var s = refStops[i];
      if (!s || s.id == null) continue;
      stops[String(s.id)] = { id: String(s.id), name: s.name || '', lat: +s.lat, lon: +s.lon };
    }

    return { id: String(routeId), shortName: shortName, longName: longName, color: color, directions: directions, stops: stops };
  }

  var builtRoutes = {};   // routeId -> Route
  var pendingRoutes = {}; // routeId -> [cb]

  function route(routeId, cb) {
    cb = once(cb);
    var id = String(routeId);
    var known = builtRoutes.hasOwnProperty(id) ? builtRoutes[id] : cacheGet('route.' + id);
    if (known) {
      builtRoutes[id] = known;
      return later(cb, null, known);
    }
    if (pendingRoutes.hasOwnProperty(id)) return pendingRoutes[id].push(cb);
    var waiters = pendingRoutes[id] = [cb];
    getOba(where + '/stops-for-route/' + encodeURIComponent(id) + '.json?key=' + key + '&includePolylines=true&version=2',
      function (data) { return mapRoute(id, data); },
      function (err, r) {
        delete pendingRoutes[id];
        if (!err) {
          builtRoutes[id] = r;
          cacheSet('route.' + id, r);
        }
        for (var i = 0; i < waiters.length; i++) {
          try { waiters[i](err, r); } catch (e) { /* one waiter must not stop the others */ }
        }
      });
  }

  // ---------------------------------------------------------------- stopInfo (OBA stop)
  function stopInfo(stopId, cb) {
    cb = once(cb);
    var id = appStopId(stopId);
    getOba(where + '/stop/' + encodeURIComponent(id) + '.json?key=' + key, function (data) {
      var e = data.entry;
      if (!e || e.id == null) throw new Error('unknown stop ' + stopId);
      return { id: String(e.id), name: e.name || '', lat: +e.lat, lon: +e.lon };
    }, cb);
  }

  // ---------------------------------------------------------------- listRoutes (routes-for-agency, NYCT + MTA Bus)
  function mapAgencyRoutes(data) {
    var l = data.list || [];
    var out = [];
    for (var i = 0; i < l.length; i++) {
      var r = l[i];
      if (!r || r.id == null) continue;
      out.push({ id: String(r.id), shortName: String(r.shortName || r.longName || r.id),
                 longName: String(r.longName || r.description || '') });
    }
    return out;
  }

  function agencyRoutesUrl(agency) {
    return where + '/routes-for-agency/' + encodeURIComponent(agency) + '.json?key=' + key;
  }

  var routeList = null;
  function listRoutes(cb) {
    cb = once(cb);
    if (routeList) return later(cb, null, routeList);
    var results = [], remaining = AGENCIES.length, lastErr = null, anyOk = false;
    for (var a = 0; a < AGENCIES.length; a++) {
      (function (a) {
        getOba(agencyRoutesUrl(AGENCIES[a]), mapAgencyRoutes, function (err, rs) {
          if (err) lastErr = err;
          else anyOk = true;
          results[a] = rs || [];
          if (--remaining) return;
          if (!anyOk) return cb(lastErr);
          var out = [];
          for (var i = 0; i < results.length; i++) {
            for (var k = 0; k < results[i].length; k++) {
              var r = results[i][k];
              out.push({ id: r.id, label: r.longName ? r.shortName + ' ' + r.longName : r.shortName });
            }
          }
          routeList = out;
          cb(null, out);
        });
      })(a);
    }
  }

  // ---------------------------------------------------------------- catalog (search index)
  // agencies-with-coverage → routes-for-agency per agency → stops-for-route (no polylines) per route (~330 routes),
  // CATALOG_IN_FLIGHT requests at a time; a route already built / stored gives its stops without a request.
  // Agencies / routes that fail are skipped; no agency list → error.
  function limited(jobs, each, done) {
    var next = 0, running = 0, finished = 0;
    if (!jobs.length) return done();
    function pump() {
      while (running < CATALOG_IN_FLIGHT && next < jobs.length) {
        running++;
        each(jobs[next++], function () {
          running--;
          finished++;
          if (finished === jobs.length) done();
          else pump();
        });
      }
    }
    pump();
  }

  function catalog(cb, onProgress) {
    cb = once(cb);
    getOba(where + '/agencies-with-coverage.json?key=' + key, function (data) {
      var out = [], l = data.list || [];
      for (var i = 0; i < l.length; i++) if (l[i] && l[i].agencyId != null) out.push(String(l[i].agencyId));
      return out;
    }, function (err, agencies) {
      if (err) return cb(err);
      var routes = [], seenRoute = {};
      limited(agencies, function (agency, next) {
        getOba(agencyRoutesUrl(agency), mapAgencyRoutes, function (e, rs) {
          if (!e) {
            for (var i = 0; i < rs.length; i++) {
              if (seenRoute.hasOwnProperty(rs[i].id)) continue;
              seenRoute[rs[i].id] = true;
              routes.push(rs[i]);
            }
          }
          next();
        });
      }, function () {
        var stops = {}, order = [], count = 0;
        function addStop(s, routeId) {
          if (!s || s.id == null) return;
          var id = String(s.id);
          if (!stops.hasOwnProperty(id)) {
            stops[id] = { id: id, name: s.name || '', lat: +s.lat, lon: +s.lon, routeIds: [] };
            if (s.direction) stops[id].dir = String(s.direction);   // 'N' / 'S' / 'E' / 'W' (OBA stop direction)
            order.push(id);
          }
          if (stops[id].routeIds.indexOf(routeId) < 0) stops[id].routeIds.push(routeId);
        }
        function progressed(next) {
          count++;
          if (typeof onProgress === 'function') {
            try { onProgress(count, routes.length); } catch (e) { /* ignore */ }
          }
          next();
        }
        limited(routes, function (r, next) {
          var built = builtRoutes.hasOwnProperty(r.id) ? builtRoutes[r.id] : cacheGet('route.' + r.id);
          if (built) {
            for (var d = 0; d < built.directions.length; d++) {
              var ids = built.directions[d].stopIds || [];
              for (var k = 0; k < ids.length; k++) addStop(built.stops[ids[k]], r.id);
            }
            return setTimeout(function () { progressed(next); }, 0);
          }
          getOba(where + '/stops-for-route/' + encodeURIComponent(r.id) + '.json?key=' + key + '&includePolylines=false&version=2',
            function (data) {
              var refStops = (data.references && data.references.stops) || [];
              for (var i = 0; i < refStops.length; i++) addStop(refStops[i], r.id);
              return null;
            }, function () { progressed(next); });
        }, function () {
          var out = [];
          for (var i = 0; i < order.length; i++) out.push(stops[order[i]]);
          cb(null, { routes: routes, stops: out });
        });
      });
    });
  }

  return { stopsNear: stopsNear, arrivals: arrivals, route: route, vehicles: vehicles,
           listRoutes: listRoutes, routeInfo: route, stopInfo: stopInfo, catalog: catalog };
}

var plugin = {
  type: 'mta',
  label: 'MTA Bus Time (New York)',
  area: { lat: 40.7128, lon: -74.006, radius: 50000 },
  needsKey: true,
  keyUrl: KEY_URL,
  create: function (options, ctx) {
    return createMta({ baseUrl: options.baseUrl, apiKey: options.apiKey }, ctx.http,
      { clock: ctx.clock, storage: ctx.storage });
  }
};

module.exports = { createMta: createMta, DEFAULT_BASE_URL: DEFAULT_BASE_URL, KEY_URL: KEY_URL,
                   parseIso: parseIso, monitoringRef: monitoringRef, plugin: plugin };
