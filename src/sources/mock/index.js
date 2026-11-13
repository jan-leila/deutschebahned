'use strict';
// Deterministic fake transit network for demos and the emulator. ES5 only.
var geo = require('../../common/geo');

var HALF_LENGTH = 3000;   // meters from line start to centre
var STOP_SPACING = 400;   // meters between stops
var STOP_COUNT = 16;
var HEADWAY = 600;        // seconds between trips
var HOP = 50;             // seconds between consecutive stops
var SPEED = 8;            // m/s, live vehicle positions
var ON_ROAD = 750;        // seconds a run is reported as a vehicle
var MOCK_COLORS = ['E53935', '1E88E5', '43A047', 'FB8C00', '8E24AA', '00897B'];
// demo routes every mock network has after the configured ones, so there is something to search for
var DEMO_ROUTES = [{ id: 'M1', name: 'Mock 1' }, { id: 'M2', name: 'Mock 2' }, { id: 'M3', name: 'Mock 3' }];

function later(cb, err, value) {
  setTimeout(function () { cb(err, value); }, 0);
}

function createMock(config, clock) {
  var center = { lat: +config.location.lat, lon: +config.location.lon };
  var routesCfg = (config.routes || []).concat(DEMO_ROUTES);
  var routes = {};      // routeId -> {id, name, bearing, stops: [{id,name,lat,lon}]}
  var stopIndex = {};   // stopId -> {routeId, k, stop}
  var allStops = [];    // [{id,name,lat,lon,routeId}]
  var routeOrder = [];  // route ids in config order

  // point at signed distance d (meters) from the centre along bearing
  function along(d, bearing) {
    return d >= 0 ? geo.offset(center, d, bearing) : geo.offset(center, -d, bearing + 180);
  }

  for (var i = 0; i < routesCfg.length; i++) {
    var rc = routesCfg[i];
    var id = String(rc.id);
    if (routes.hasOwnProperty(id)) continue;
    var name = rc.name != null && rc.name !== '' ? String(rc.name) : id;
    var bearing = i * 60;
    var r = { id: id, name: name, bearing: bearing, color: MOCK_COLORS[i % MOCK_COLORS.length], stops: [] };
    for (var k = 0; k < STOP_COUNT; k++) {
      var p = along(k * STOP_SPACING - HALF_LENGTH, bearing);
      var s = { id: id + ':s' + k, name: name + ' stop ' + k, lat: p.lat, lon: p.lon };
      r.stops.push(s);
      stopIndex[s.id] = { routeId: id, k: k, stop: s };
      allStops.push({ id: s.id, name: s.name, lat: s.lat, lon: s.lon, routeId: id });
    }
    routes[id] = r;
    routeOrder.push(id);
  }

  function now() { return Math.floor(clock()); }

  function stopsNear(pos, radiusMeters, cb) {
    var found = [];
    for (var i = 0; i < allStops.length; i++) {
      var s = allStops[i];
      var d = geo.distance(pos, s);
      if (d <= radiusMeters) found.push({ d: d, i: i, s: s });
    }
    found.sort(function (a, b) { return a.d !== b.d ? a.d - b.d : a.i - b.i; });
    var out = [];
    for (i = 0; i < found.length; i++) {
      var f = found[i].s;
      out.push({ id: f.id, name: f.name, lat: f.lat, lon: f.lon, routeIds: [f.routeId] });
    }
    later(cb, null, out);
  }

  function arrivals(stopId, minutesBefore, minutesAfter, cb) {
    var info = stopIndex.hasOwnProperty(stopId) ? stopIndex[stopId] : null;
    if (!info) return later(cb, new Error('unknown stop ' + stopId));
    var t = now();
    var lo = t - minutesBefore * 60;
    var hi = t + minutesAfter * 60;
    var hop = HOP * info.k;
    var base = Math.floor(t / HEADWAY) * HEADWAY;
    var jMin = Math.ceil((lo - hop - base) / HEADWAY);
    var jMax = Math.floor((hi - hop - base) / HEADWAY);
    var route = routes[info.routeId];
    var out = [];
    for (var j = jMin; j <= jMax; j++) {
      var tj = base + j * HEADWAY;
      var time = tj + hop;
      if (time < lo || time > hi) continue;
      out.push({ stopId: stopId, routeId: route.id, tripKey: route.id + ':t' + tj, time: time, predicted: true, headsign: route.name });
    }
    later(cb, null, out);
  }

  function route(routeId, cb) {
    var r = routes.hasOwnProperty(routeId) ? routes[routeId] : null;
    if (!r) return later(cb, new Error('unknown route ' + routeId));
    var stopIds = [];
    var path = [];
    var stops = {};
    for (var k = 0; k < r.stops.length; k++) {
      var s = r.stops[k];
      stopIds.push(s.id);
      path.push({ lat: s.lat, lon: s.lon });
      stops[s.id] = { id: s.id, name: s.name, lat: s.lat, lon: s.lon };
      // keep the centre exactly on the path (it lies between stops 7 and 8)
      if (k * STOP_SPACING < HALF_LENGTH && (k + 1) * STOP_SPACING > HALF_LENGTH) path.push({ lat: center.lat, lon: center.lon });
    }
    later(cb, null, {
      id: r.id,
      shortName: r.name,
      longName: r.name + ' via Mock Av - Centre - Station ' + r.id,
      color: r.color,
      directions: [{ id: '0', name: 'Outbound', stopIds: stopIds, paths: [path] }],
      stops: stops
    });
  }

  function vehicles(routeId, cb) {
    var r = routes.hasOwnProperty(routeId) ? routes[routeId] : null;
    if (!r) return later(cb, new Error('unknown route ' + routeId));
    var t = now();
    var base = Math.floor(t / HEADWAY) * HEADWAY;
    // geo.offset is a flat approximation; scale so the great-circle distance from the line start is exact
    var scale = 2 * HALF_LENGTH / geo.distance(along(-HALF_LENGTH, r.bearing), along(HALF_LENGTH, r.bearing));
    var out = [];
    for (var j = -Math.ceil(ON_ROAD / HEADWAY); j <= 0; j++) {
      var tj = base + j * HEADWAY;
      var elapsed = t - tj;
      if (elapsed < 0 || elapsed > ON_ROAD) continue;
      var p = along(SPEED * elapsed * scale - HALF_LENGTH, r.bearing);
      out.push({ tripKey: r.id + ':t' + tj, routeId: r.id, directionId: '0', lat: p.lat, lon: p.lon, time: t });
    }
    later(cb, null, out);
  }

  // ------------------------------------------------------------ catalog
  // (routeOrder: config order, filled while building the network above)

  function listRoutes(cb) {
    var out = [];
    for (var i = 0; i < routeOrder.length; i++) {
      var r = routes[routeOrder[i]];
      out.push({ id: r.id, label: r.id + ' ' + r.name });
    }
    later(cb, null, out);
  }

  function stopInfo(stopId, cb) {
    var info = stopIndex.hasOwnProperty(stopId) ? stopIndex[stopId] : null;
    if (!info) return later(cb, new Error('unknown stop ' + stopId));
    var s = info.stop;
    later(cb, null, { id: s.id, name: s.name, lat: s.lat, lon: s.lon });
  }

  // every route and stop of the network (search index)
  // the compass quadrant a line travels in (its stops' direction in the search index)
  function quadrant(bearing) {
    var d = ((bearing % 360) + 360) % 360;
    return d >= 315 || d < 45 ? 'Northbound' : d < 135 ? 'Eastbound' : d < 225 ? 'Southbound' : 'Westbound';
  }

  function catalog(cb, onProgress) {
    var routesOut = [], stopsOut = [];
    for (var i = 0; i < routeOrder.length; i++) {
      var r = routes[routeOrder[i]];
      routesOut.push({ id: r.id, shortName: r.name, longName: r.name + ' via Mock Av - Centre - Station ' + r.id });
      for (var k = 0; k < r.stops.length; k++) {
        var s = r.stops[k];
        stopsOut.push({ id: s.id, name: s.name, lat: s.lat, lon: s.lon, routeIds: [r.id], dir: quadrant(r.bearing) });
      }
    }
    if (typeof onProgress === 'function') onProgress(routeOrder.length, routeOrder.length);
    later(cb, null, { routes: routesOut, stops: stopsOut });
  }

  return { stopsNear: stopsNear, arrivals: arrivals, route: route, vehicles: vehicles,
           listRoutes: listRoutes, routeInfo: route, stopInfo: stopInfo, catalog: catalog };
}

var plugin = {
  type: 'mock',
  label: 'Mock (demo data)',
  create: function (options, ctx) {
    return createMock({ location: ctx.center, routes: ctx.routes }, ctx.clock);
  }
};

module.exports = { createMock: createMock, plugin: plugin };
