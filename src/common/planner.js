// Planner: decides which pickups (buses at nearby stops) and drop-offs (arrival at a pinned stop for
// the bus you are probably on / the next bus) to show. See CONTRACTS.md section 4.
// ES5 only: runs inside PebbleKit JS.
var geo = require('./geo');
var settings = require('./settings');
var directions = require('./directions');
var format = require('./format');

var DEFAULT_COLORS = ['0055AA', 'AA0000', '00AA55', 'AA5500', '5500AA', '00AAAA', 'AA00AA', '555555'];

function errMessage(err) {
  if (err && err.message) return String(err.message);
  return String(err);
}

function indexOf(arr, x) {
  if (!arr) return -1;
  for (var i = 0; i < arr.length; i++) if (arr[i] === x) return i;
  return -1;
}

function configuredRoute(config, routeId) {
  var routes = (config && config.routes) || [];
  for (var i = 0; i < routes.length; i++) if (routes[i].id === routeId) return routes[i];
  return null;
}

function routeName(config, routeId, route) {
  var r = configuredRoute(config, routeId);
  if (r && r.name) return r.name;
  if (route && route.shortName) return route.shortName;
  return routeId;
}

// The route's full / formal name from the source ('' if none), e.g. "Franklin Av - Riverside Av - U of M - 8th St SE".
function routeLongName(route) {
  return route && typeof route.longName === 'string' ? route.longName : '';
}

// Configured color, else the provider's route color, else a default by config index (or id char-code sum).
function routeColor(config, routeId, route) {
  var routes = (config && config.routes) || [];
  var idx = -1;
  for (var i = 0; i < routes.length; i++) {
    if (routes[i].id === routeId) { idx = i; break; }
  }
  if (idx >= 0) {
    var c = settings.color(routes[idx].color);
    if (c) return c;
  }
  var rc = route ? settings.color(route.color) : '';
  if (rc) return rc;
  if (idx < 0) {
    idx = 0;
    var id = String(routeId);
    for (var k = 0; k < id.length; k++) idx += id.charCodeAt(k);
  }
  return DEFAULT_COLORS[idx % DEFAULT_COLORS.length];
}

// Nearest stop of `direction` strictly before the pinned stop that exists in route.stops, or null.
function pickHereStop(direction, route, pinnedStopId, pos) {
  if (!direction || !route) return null;
  var ids = direction.stopIds || [];
  var stops = route.stops || {};
  var end = indexOf(ids, pinnedStopId);
  if (end < 0) return null;
  // The direction path closest to pos, used to tell which stops are behind pos along the route.
  var paths = direction.paths || [];
  var path = null;
  var posAlong = 0;
  var bestPathD = Infinity;
  for (var p = 0; p < paths.length; p++) {
    var n = geo.nearestOnPath(pos, paths[p]);
    if (n.distance < bestPathD) { bestPathD = n.distance; path = paths[p]; posAlong = n.along; }
  }
  var best = null, bestD = Infinity;            // nearest overall
  var behind = null, behindD = Infinity;        // nearest among stops at/behind pos along the path
  for (var i = 0; i < end; i++) {
    var s = Object.prototype.hasOwnProperty.call(stops, ids[i]) ? stops[ids[i]] : null;
    if (!s) continue;
    var d = geo.distance(pos, s);
    if (best === null || d < bestD) { best = ids[i]; bestD = d; }
    if (path && geo.nearestOnPath(s, path).along <= posAlong && (behind === null || d < behindD)) {
      behind = ids[i];
      behindD = d;
    }
  }
  return behind !== null ? behind : best;
}

// Direction containing the pinned stop that is closest to pos → {direction, distance} or null.
function pickDirection(route, pinnedStopId, pos) {
  var dirs = (route && route.directions) || [];
  var best = null;
  var bestD = Infinity;
  for (var i = 0; i < dirs.length; i++) {
    if (indexOf(dirs[i].stopIds, pinnedStopId) < 0) continue;
    var d = geo.distanceToPaths(pos, dirs[i].paths || []);
    if (best === null || d < bestD) { best = dirs[i]; bestD = d; }
  }
  return best ? { direction: best, distance: bestD } : null;
}

// For a connection: {direction, distance, hereStopId} when on-route with a here stop, else null.
function planConnection(config, conn, route, pos) {
  if (!route) return null;
  var dir = pickDirection(route, conn.stopId, pos);
  if (!dir) return null;
  if (!(dir.distance <= config.routeRadius)) return null;
  var here = pickHereStop(dir.direction, route, conn.stopId, pos);
  if (here === null) return null;
  return { direction: dir.direction, distance: dir.distance, hereStopId: here };
}

function servesConfiguredRoute(config, stop) {
  var ids = (stop && stop.routeIds) || [];
  for (var i = 0; i < ids.length; i++) if (configuredRoute(config, ids[i])) return true;
  return false;
}

// Wraps a callback so it runs at most once.
function once(fn) {
  var done = false;
  return function () {
    if (done) return;
    done = true;
    fn.apply(null, arguments);
  };
}

function gather(provider, config, pos, now, routeCache, cb) {
  cb = once(cb);
  routeCache = routeCache || {};
  var connections = (config && config.connections) || [];
  var data = { stops: [], routes: {}, vehicles: {}, arrivals: {}, errors: [] };

  // 1) nearby stops
  var stopsDone = once(function (err, stops) {
    if (err) {
      if (connections.length === 0) return cb(err instanceof Error ? err : new Error(errMessage(err)));
      data.errors.push('stops: ' + errMessage(err));
      stops = [];
    }
    var kept = [];
    stops = stops || [];
    for (var i = 0; i < stops.length && kept.length < config.maxStops; i++) {
      if (servesConfiguredRoute(config, stops[i])) kept.push(stops[i]);
    }
    data.stops = kept;
    loadRoutes();
  });
  try {
    provider.stopsNear(pos, config.stopRadius, stopsDone);
  } catch (e) {
    stopsDone(e);
  }

  // 2) routes of every configured route and every connection (cache first). A failing route that is
  // only configured (needed just for its color) is not reported; connection routes are.
  function loadRoutes() {
    var ids = [];
    var connIds = [];
    var routes = (config && config.routes) || [];
    var i;
    for (i = 0; i < connections.length; i++) {
      if (indexOf(connIds, connections[i].routeId) < 0) connIds.push(connections[i].routeId);
    }
    for (i = 0; i < routes.length; i++) {
      if (indexOf(ids, routes[i].id) < 0) ids.push(routes[i].id);
    }
    for (i = 0; i < connIds.length; i++) {
      if (indexOf(ids, connIds[i]) < 0) ids.push(connIds[i]);
    }
    var pending = ids.length;
    if (pending === 0) return fetchArrivals();
    function finished() {
      pending--;
      if (pending === 0) fetchArrivals();
    }
    for (var j = 0; j < ids.length; j++) {
      (function (routeId) {
        if (Object.prototype.hasOwnProperty.call(routeCache, routeId) && routeCache[routeId]) {
          data.routes[routeId] = routeCache[routeId];
          finished();
          return;
        }
        var done = once(function (err, route) {
          if (err || !route) {
            if (indexOf(connIds, routeId) >= 0) data.errors.push('route ' + routeId + ': ' + (err ? errMessage(err) : 'empty'));
          } else {
            routeCache[routeId] = route;
            data.routes[routeId] = route;
          }
          finished();
        });
        try {
          provider.route(routeId, done);
        } catch (e) {
          done(e);
        }
      })(ids[j]);
    }
  }

  // 3) + 4) arrivals, once per stop with the union window of its roles; live vehicles of on-route
  // connection routes (when the provider supports them)
  function fetchArrivals() {
    var vehicleRoutes = [];
    var hasVehicles = typeof provider.vehicles === 'function';
    var windows = {};
    var order = [];
    function need(stopId, before, after) {
      if (!Object.prototype.hasOwnProperty.call(windows, stopId)) {
        windows[stopId] = { before: before, after: after };
        order.push(stopId);
      } else {
        var w = windows[stopId];
        if (before > w.before) w.before = before;
        if (after > w.after) w.after = after;
      }
    }
    var i;
    for (i = 0; i < data.stops.length; i++) need(data.stops[i].id, 0, config.lookahead);
    for (i = 0; i < connections.length; i++) {
      var conn = connections[i];
      var plan = planConnection(config, conn, data.routes[conn.routeId], pos);
      if (!plan) continue;
      need(plan.hereStopId, Math.ceil(config.recentWindow / 60), config.lookahead);
      need(conn.stopId, 0, config.dropoffHorizon);
      if (hasVehicles && indexOf(vehicleRoutes, conn.routeId) < 0) vehicleRoutes.push(conn.routeId);
    }
    var pending = order.length + vehicleRoutes.length;
    if (pending === 0) return cb(null, data);
    for (i = 0; i < vehicleRoutes.length; i++) {
      (function (routeId) {
        var done = once(function (err, list) {
          if (err) data.errors.push('vehicles ' + routeId + ': ' + errMessage(err));
          else data.vehicles[routeId] = list || [];
          pending--;
          if (pending === 0) cb(null, data);
        });
        try {
          provider.vehicles(routeId, done);
        } catch (e) {
          done(e);
        }
      })(vehicleRoutes[i]);
    }
    for (i = 0; i < order.length; i++) {
      (function (stopId) {
        var w = windows[stopId];
        var done = once(function (err, list) {
          if (err) data.errors.push('arrivals ' + stopId + ': ' + errMessage(err));
          else data.arrivals[stopId] = list || [];
          pending--;
          if (pending === 0) cb(null, data);
        });
        try {
          provider.arrivals(stopId, w.before, w.after, done);
        } catch (e) {
          done(e);
        }
      })(order[i]);
    }
  }
}

function hasCoords(p) {
  return !!p && typeof p.lat === 'number' && typeof p.lon === 'number' && isFinite(p.lat) && isFinite(p.lon);
}

// trimmed, lower-case, runs of whitespace -> one space
function normalizeName(name) {
  return String(name === null || name === undefined ? '' : name).replace(/\s+/g, ' ').replace(/^ | $/g, '').toLowerCase();
}

// Distance left to ride to the pinned stop: along the direction's path closest to pos; the straight
// line when the direction has no paths or the stop is not ahead of pos along it.
function rideDistance(direction, pinnedStop, pos) {
  var paths = (direction && direction.paths) || [];
  var path = null, posAlong = 0, bestD = Infinity;
  for (var p = 0; p < paths.length; p++) {
    var n = geo.nearestOnPath(pos, paths[p]);
    if (n.distance < bestD) { bestD = n.distance; path = paths[p]; posAlong = n.along; }
  }
  if (path) {
    var left = geo.nearestOnPath(pinnedStop, path).along - posAlong;
    if (left >= 0) return left;
  }
  return geo.distance(pos, pinnedStop);
}

function distanceKey(c) {
  return c.distance === null ? Infinity : c.distance;
}

// Groups pickup candidates by (routeId, normalized stop name); within a group sorted by distance (stable,
// unknown last), consecutive pairs become one two-lane tile (lane 0 = nearer). A tile takes the position of
// its earliest candidate. Returns arrays of 1 or 2 candidates.
function mergeSameName(candidates) {
  var groups = {};
  var order = [];
  var i, j;
  for (i = 0; i < candidates.length; i++) {
    var gk = candidates[i].routeId + '\u0000' + normalizeName(candidates[i].stop.name);
    if (!Object.prototype.hasOwnProperty.call(groups, gk)) { groups[gk] = []; order.push(gk); }
    groups[gk].push(i);
  }
  var tileAt = [];   // candidate index -> the tile whose earliest candidate it is
  for (var o = 0; o < order.length; o++) {
    var g = groups[order[o]].slice();
    for (i = 1; i < g.length; i++) {          // stable insertion sort by distance
      var x = g[i];
      for (j = i - 1; j >= 0 && distanceKey(candidates[g[j]]) > distanceKey(candidates[x]); j--) g[j + 1] = g[j];
      g[j + 1] = x;
    }
    for (i = 0; i < g.length; i += 2) {
      var tile = [candidates[g[i]]];
      var first = g[i];
      if (i + 1 < g.length) {
        tile.push(candidates[g[i + 1]]);
        if (g[i + 1] < first) first = g[i + 1];
      }
      tileAt[first] = tile;
    }
  }
  var out = [];
  for (i = 0; i < candidates.length; i++) if (tileAt[i]) out.push(tileAt[i]);
  return out;
}

// walking speed (m/s): the one trip planning uses
function walkSpeed(config) {
  var s = config && config.schedule && config.schedule.walkSpeed;
  return typeof s === 'number' && s > 0 ? s : 1.3;
}

function pickupItem(config, tile, now) {
  var c = tile[0];
  var lanes = [];
  var soonest = Infinity;
  for (var i = 0; i < tile.length; i++) {
    lanes.push({ stopId: tile[i].stop.id, dir: tile[i].dir, times: tile[i].times });
    if (tile[i].times[0] < soonest) soonest = tile[i].times[0];
  }
  var features = {};
  features['stop:' + c.stop.id] = Math.round(c.distance === null ? 0 : c.distance);
  features['route:' + c.routeId] = Math.max(0, soonest - now);
  return {
    kind: 'pickup',
    key: 'pickup:' + c.stop.id + ':' + c.routeId,
    badge: routeName(config, c.routeId, c.route),
    routeLongName: routeLongName(c.route),
    title: c.stop.name,
    color: routeColor(config, c.routeId, c.route),
    times: c.times,
    routeId: c.routeId,
    stopId: c.stop.id,
    features: features,
    bearing: c.bearing,
    distance: c.distance,
    walk: format.walkSeconds(c.distance, walkSpeed(config)),   // seconds to walk to lane 0's stop, null if unknown
    dir: c.dir,
    lanes: lanes
  };
}

function buildItems(config, data, pos, now) {
  var items = [];
  var routes = (config && config.routes) || [];
  var stops = (data && data.stops) || [];
  var arrivals = (data && data.arrivals) || {};
  var dataRoutes = (data && data.routes) || {};
  var i, j, k;

  // pickups: one candidate per stop x configured route, then same-name stops of a route merged into two-lane tiles
  var candidates = [];
  for (i = 0; i < stops.length; i++) {
    var stop = stops[i];
    var list = Object.prototype.hasOwnProperty.call(arrivals, stop.id) ? arrivals[stop.id] : null;
    if (!list) continue;
    for (j = 0; j < routes.length; j++) {
      var routeId = routes[j].id;
      if (indexOf(stop.routeIds, routeId) < 0) continue;
      var times = [];
      for (k = 0; k < list.length && times.length < config.pickupsPerItem; k++) {
        if (list[k].routeId === routeId && list[k].time >= now - 30) times.push(list[k].time);
      }
      if (times.length === 0) continue;
      var dataRoute = Object.prototype.hasOwnProperty.call(dataRoutes, routeId) ? dataRoutes[routeId] : null;
      var hasPos = hasCoords(stop);
      candidates.push({
        stop: stop,
        routeId: routeId,
        route: dataRoute,
        times: times,
        dir: dataRoute ? directions.stopLabel(dataRoute, stop.id) : '',
        distance: hasPos ? geo.distance(pos, stop) : null,
        bearing: hasPos ? geo.bearing(pos, stop) : null
      });
    }
  }
  var tiles = mergeSameName(candidates);
  for (i = 0; i < tiles.length; i++) items.push(pickupItem(config, tiles[i], now));

  // drop-offs
  var connections = (config && config.connections) || [];
  for (i = 0; i < connections.length; i++) {
    var conn = connections[i];
    var route = Object.prototype.hasOwnProperty.call(dataRoutes, conn.routeId) ? dataRoutes[conn.routeId] : null;
    var plan = planConnection(config, conn, route, pos);
    if (!plan) continue;
    var pinnedList = arrivals[conn.stopId] || [];
    var hereList = arrivals[plan.hereStopId] || [];
    var pinned = {};
    for (k = 0; k < pinnedList.length; k++) {
      var pa = pinnedList[k];
      if (pa.routeId === conn.routeId && pa.time > now && !Object.prototype.hasOwnProperty.call(pinned, pa.tripKey)) {
        pinned[pa.tripKey] = pa.time;
      }
    }
    // "the bus you're on": the nearest recent live vehicle near you whose trip reaches the pinned stop
    var onDrop = 0;
    var vehicles = (data && data.vehicles && Object.prototype.hasOwnProperty.call(data.vehicles, conn.routeId))
      ? data.vehicles[conn.routeId] : null;
    if (vehicles) {
      var bestV = null, bestVD = Infinity;
      for (k = 0; k < vehicles.length; k++) {
        var v = vehicles[k];
        if (!v || !(v.time >= now - config.recentWindow)) continue;
        if (!Object.prototype.hasOwnProperty.call(pinned, v.tripKey)) continue;
        var vd = geo.distance(pos, v);
        if (!(vd <= config.vehicleRadius)) continue;
        if (bestV === null || vd < bestVD) { bestV = v; bestVD = vd; }
      }
      if (bestV) onDrop = pinned[bestV.tripKey];
    }
    var onHere = null;
    var nextHere = null;
    for (k = 0; k < hereList.length; k++) {
      var ha = hereList[k];
      if (ha.routeId !== conn.routeId) continue;
      if (!Object.prototype.hasOwnProperty.call(pinned, ha.tripKey)) continue;
      if (ha.time >= now - config.recentWindow && ha.time <= now) {
        if (onHere === null || ha.time >= onHere.time) onHere = ha;
      } else if (ha.time > now) {
        if (nextHere === null || ha.time < nextHere.time) nextHere = ha;
      }
    }
    if (!onDrop && onHere) onDrop = pinned[onHere.tripKey];
    if (!onDrop && !nextHere) continue;
    var nextDrop = nextHere ? pinned[nextHere.tripKey] : 0;
    var nextHereTime = nextHere ? nextHere.time : 0;
    var pinnedStop = route.stops && Object.prototype.hasOwnProperty.call(route.stops, conn.stopId) ? route.stops[conn.stopId] : null;
    if (!hasCoords(pinnedStop)) pinnedStop = null;
    var f = {};
    f['ride:' + conn.stopId] = Math.round(plan.distance);
    f['route:' + conn.routeId] = (onDrop ? onDrop : nextDrop) - now;
    items.push({
      kind: 'dropoff',
      key: 'dropoff:' + conn.id,
      badge: routeName(config, conn.routeId, route),
      routeLongName: routeLongName(route),
      title: conn.name,
      color: routeColor(config, conn.routeId, route),
      times: [onDrop || 0, nextDrop || 0, nextHereTime || 0],
      routeId: conn.routeId,
      stopId: conn.stopId,
      hereStopId: plan.hereStopId,
      features: f,
      bearing: pinnedStop ? geo.bearing(pos, pinnedStop) : null,
      distance: pinnedStop ? rideDistance(plan.direction, pinnedStop, pos) : null,
      dir: directions.label(route, plan.direction, conn.stopId),
      lanes: []
    });
  }

  return items;
}

module.exports = {
  gather: gather,
  buildItems: buildItems,
  pickHereStop: pickHereStop,
  routeColor: routeColor,
  DEFAULT_COLORS: DEFAULT_COLORS
};
