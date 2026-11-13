// Runtime view of a (version 2) config: what the planner, ranking, session and scheduler work with. ES5.
// See CONTRACTS.md §2a.
//
// A config saves routes and stops per transit system ({providerId, id}). Everything downstream sees one flat list
// with namespaced ids (refs, `providerId + '/' + id`), restricted to the systems whose coverage area contains the
// position, plus the watch's display preferences (units, 24 h clock) instead of settings of our own.
var geo = require('./geo');
var settings = require('./settings');

var AUTO_MARGIN = 30000;       // meters added around a system's saved stops for its automatic coverage area
var IMPERIAL_REGIONS = ['US', 'LR', 'MM'];

function ref(providerId, id) { return providerId + '/' + id; }

// 'pid/id' → {providerId, id} (split at the first '/'; provider ids never contain one), or null
function splitRef(r) {
  if (typeof r !== 'string') return null;
  var i = r.indexOf('/');
  if (i <= 0) return null;
  return { providerId: r.slice(0, i), id: r.slice(i + 1) };
}

function hasCoords(p) {
  return !!p && typeof p.lat === 'number' && typeof p.lon === 'number' && isFinite(p.lat) && isFinite(p.lon) &&
    !(p.lat === 0 && p.lon === 0);
}

function findProvider(config, providerId) {
  var list = (config && config.providers) || [];
  for (var i = 0; i < list.length; i++) if (list[i].id === providerId) return list[i];
  return null;
}

// Coverage area of one system → {lat, lon, radius} in meters, or null = everywhere.
// manual: as configured. auto: around the system's saved stops that have a position (centre of their bounding box,
// radius = farthest stop + AUTO_MARGIN); no such stop → null.
function coverage(config, providerId) {
  var p = findProvider(config, providerId);
  if (!p) return null;
  var cv = p.coverage || {};
  if (cv.mode === 'manual') return { lat: +cv.lat || 0, lon: +cv.lon || 0, radius: +cv.radius || 0 };
  var stops = (config && config.stops) || [];
  var pts = [], i;
  for (i = 0; i < stops.length; i++) if (stops[i].providerId === providerId && hasCoords(stops[i])) pts.push(stops[i]);
  if (!pts.length) return null;
  var minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (i = 0; i < pts.length; i++) {
    if (pts[i].lat < minLat) minLat = pts[i].lat;
    if (pts[i].lat > maxLat) maxLat = pts[i].lat;
    if (pts[i].lon < minLon) minLon = pts[i].lon;
    if (pts[i].lon > maxLon) maxLon = pts[i].lon;
  }
  var c = { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
  var far = 0;
  for (i = 0; i < pts.length; i++) far = Math.max(far, geo.distance(c, pts[i]));
  return { lat: c.lat, lon: c.lon, radius: Math.round(far + AUTO_MARGIN) };
}

function inArea(area, pos) {
  if (!area || !pos) return true;
  return geo.distance(area, pos) <= area.radius;
}

// does system providerId serve pos? (no pos / everywhere → true)
function covers(config, providerId, pos) {
  return inArea(coverage(config, providerId), pos);
}

// ids of the systems covering pos, config order
function activeProviders(config, pos) {
  var out = [];
  var list = (config && config.providers) || [];
  for (var i = 0; i < list.length; i++) if (covers(config, list[i].id, pos)) out.push(list[i].id);
  return out;
}

// 'imperial' for the regions that use it, else 'metric' (used when the watch has not said)
function guessUnits(locale) {
  var m = String(locale || '').match(/[-_]([A-Za-z]{2})\b/);
  var region = m ? m[1].toUpperCase() : (/^en$/i.test(String(locale || '')) ? 'US' : '');
  for (var i = 0; i < IMPERIAL_REGIONS.length; i++) if (IMPERIAL_REGIONS[i] === region) return 'imperial';
  return 'metric';
}

// Watch display preferences: {units: 'metric'|'imperial', clock24: bool, known: bool}. Missing parts → the
// locale's units and a 12 h clock, known false.
function prefs(raw, locale) {
  var r = raw !== null && typeof raw === 'object' ? raw : {};
  var known = r.known === true;
  return {
    units: r.units === 'metric' || r.units === 'imperial' ? r.units : guessUnits(locale),
    clock24: r.clock24 === true,
    known: known
  };
}

function copy(v) { return JSON.parse(JSON.stringify(v)); }

// The runtime config for position pos (null = every system): the config's scalar fields, location, destinations,
// schedule and training as they are, plus
//   providers:   ids of the active systems
//   coverage:    {providerId: {lat, lon, radius} | null} for every system
//   routes:      [{id: ref, providerId, sourceId, name, scale, color}] of the active systems
//   stops:       [{id: ref, providerId, sourceId, name, lat, lon, walkScale, rideScale}] of the active systems
//   connections: [{id: connectionId(routeRef, stopRef), routeId, stopId, name}] every saved route × saved stop of the
//                same system (the planner drops pairs whose route doesn't serve the stop)
//   units, clock24 from the watch preferences
function build(config, watchPrefs, pos) {
  var c = settings.normalize(config);
  var p = prefs(watchPrefs);
  var out = {};
  for (var k in c) if (c.hasOwnProperty(k) && k !== 'providers' && k !== 'routes' && k !== 'stops') out[k] = copy(c[k]);
  out.units = p.units;
  out.clock24 = p.clock24;
  out.coverage = {};
  var active = {};
  out.providers = [];
  for (var i = 0; i < c.providers.length; i++) {
    var pid = c.providers[i].id;
    out.coverage[pid] = coverage(c, pid);
    if (inArea(out.coverage[pid], pos)) { active[pid] = true; out.providers.push(pid); }
  }
  out.routes = [];
  for (i = 0; i < c.routes.length; i++) {
    var r = c.routes[i];
    if (!active[r.providerId]) continue;
    out.routes.push({ id: ref(r.providerId, r.id), providerId: r.providerId, sourceId: r.id, name: r.name, scale: r.scale, color: r.color });
  }
  out.stops = [];
  for (i = 0; i < c.stops.length; i++) {
    var s = c.stops[i];
    if (!active[s.providerId]) continue;
    out.stops.push({ id: ref(s.providerId, s.id), providerId: s.providerId, sourceId: s.id, name: s.name, lat: s.lat, lon: s.lon,
                     walkScale: s.walkScale, rideScale: s.rideScale });
  }
  out.connections = [];
  for (i = 0; i < out.stops.length; i++) {
    for (var j = 0; j < out.routes.length; j++) {
      if (out.routes[j].providerId !== out.stops[i].providerId) continue;
      out.connections.push({ id: settings.connectionId(out.routes[j].id, out.stops[i].id), routeId: out.routes[j].id,
                             stopId: out.stops[i].id, name: out.stops[i].name });
    }
  }
  return out;
}

// config with learned weights copied into its scales: 'route:REF' → route scale, 'stop:REF' → stop walkScale,
// 'ride:REF' → stop rideScale (unknown refs ignored). Input untouched; returns a normalized config.
function bake(config, learned) {
  var c = settings.normalize(config);
  if (!learned || typeof learned !== 'object') return c;
  function find(list, r) {
    var p = splitRef(r);
    if (!p) return null;
    for (var i = 0; i < list.length; i++) if (list[i].providerId === p.providerId && list[i].id === p.id) return list[i];
    return null;
  }
  for (var key in learned) {
    if (!learned.hasOwnProperty(key) || typeof learned[key] !== 'number' || !isFinite(learned[key])) continue;
    var i = key.indexOf(':');
    if (i <= 0) continue;
    var kind = key.slice(0, i), id = key.slice(i + 1), e;
    if (kind === 'route' && (e = find(c.routes, id))) e.scale = learned[key];
    else if (kind === 'stop' && (e = find(c.stops, id))) e.walkScale = learned[key];
    else if (kind === 'ride' && (e = find(c.stops, id))) e.rideScale = learned[key];
  }
  return settings.normalize(c);
}

module.exports = {
  AUTO_MARGIN: AUTO_MARGIN,
  ref: ref,
  splitRef: splitRef,
  coverage: coverage,
  covers: covers,
  inArea: inArea,
  activeProviders: activeProviders,
  guessUnits: guessUnits,
  prefs: prefs,
  build: build,
  bake: bake
};
