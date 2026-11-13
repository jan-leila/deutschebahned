// Configuration model: defaults, validation and (de)serialization. ES5 (runs in PebbleKit JS and the settings page).
// See CONTRACTS.md §2.

// Data sources are plug-ins (src/sources/); settings only checks the type looks like an id. '' = the default source.
var PROVIDER_TYPE_RE = /^[a-z0-9_-]{1,32}$/;
var UNITS = ['imperial', 'metric'];
var MAX_DESTINATIONS = 8;
var LOCATION_MODES = ['gps', 'fixed'];

var RANGES = {
  stopRadius: { min: 10, max: 5000, integer: true },
  routeRadius: { min: 5, max: 2000, integer: true },
  recentWindow: { min: 0, max: 3600, integer: true },
  lookahead: { min: 1, max: 240, integer: true },
  dropoffHorizon: { min: 1, max: 480, integer: true },
  maxStops: { min: 1, max: 10, integer: true },
  pickupsPerItem: { min: 1, max: 3, integer: true },
  maxItems: { min: 1, max: 12, integer: true },
  refreshInterval: { min: 15, max: 3600, integer: true },
  vehicleRadius: { min: 10, max: 2000, integer: true },
  defaultStopScale: { min: -1000, max: 1000, integer: false },
  defaultRouteScale: { min: -1000, max: 1000, integer: false },
  defaultConnectionScale: { min: -1000, max: 1000, integer: false }
};

var SCHEDULE_RANGES = {
  leadMinutes: { min: 0, max: 120, integer: true },
  walkSpeed: { min: 0.3, max: 3, integer: false },
  maxWalk: { min: 50, max: 5000, integer: true },
  transferWalk: { min: 0, max: 1000, integer: true },
  maxTransfers: { min: 0, max: 1, integer: true },
  minTransfer: { min: 0, max: 1200, integer: true },
  fallbackMinutes: { min: 5, max: 240, integer: true }
};

var TRAINING_RANGES = {
  learningRate: { min: 0.0001, max: 10, integer: false },
  iterations: { min: 1, max: 5000, integer: true },
  temperature: { min: 0.01, max: 100000, integer: false },
  regularization: { min: 0, max: 100, integer: false },
  maxSamples: { min: 1, max: 2000, integer: true }
};

function defaults() {
  return {
    version: 1,
    provider: { type: '', baseUrl: '', apiKey: '' },  // '' type = the default source; empty baseUrl / apiKey = the source's default
    location: { mode: 'gps', lat: 0, lon: 0 },
    stopRadius: 300,
    routeRadius: 80,
    recentWindow: 180,
    lookahead: 60,
    dropoffHorizon: 120,
    maxStops: 4,
    pickupsPerItem: 3,
    maxItems: 10,
    refreshInterval: 60,
    vehicleRadius: 250,
    defaultStopScale: -1,
    defaultRouteScale: -1,
    defaultConnectionScale: -1,
    routes: [],
    connections: [],
    stopScales: {},
    units: 'imperial',
    clock24: false,
    destinations: [],
    schedule: { leadMinutes: 15, walkSpeed: 1.3, maxWalk: 800, transferWalk: 250, maxTransfers: 1, minTransfer: 120,
                leaveReminder: true, fallbackMinutes: 60 },
    training: { autoTrain: true, learningRate: 0.05, iterations: 300, temperature: 60, regularization: 0.01, maxSamples: 200 }
  };
}

function isObject(v) { return v !== null && typeof v === 'object' && !(v instanceof Array); }

// number from a number or numeric string; null when missing / not numeric
function toNumber(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'string' && v.replace(/\s/g, '') !== '') {
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  return null;
}

function num(v, def, range) {
  var n = toNumber(v);
  if (n === null) return def;
  if (range) {
    if (range.integer) n = Math.round(n);
    if (n < range.min) n = range.min;
    if (n > range.max) n = range.max;
  }
  return n;
}

function str(v, def) {
  if (typeof v === 'string') return v.replace(/^\s+|\s+$/g, '');
  if (typeof v === 'number' && isFinite(v)) return String(v);
  return def;
}

function bool(v, def) {
  if (v === true || v === 1 || v === 'true' || v === '1') return true;
  if (v === false || v === 0 || v === 'false' || v === '0') return false;
  return def;
}

function oneOf(v, list, def) {
  for (var i = 0; i < list.length; i++) if (list[i] === v) return v;
  return def;
}

// 'RRGGBB' (upper case) from '#rrggbb' or 'rrggbb'; '' = no color chosen (use the provider's / a default)
function color(v) {
  if (typeof v !== 'string') return '';
  var m = v.replace(/^\s+|\s+$/g, '').match(/^#?([0-9a-fA-F]{6})$/);
  return m ? m[1].toUpperCase() : '';
}

// 'HH:MM' (24 h, zero padded) from 'H:MM' / 'HH:MM'; null if not a valid time of day
function clockTime(v) {
  if (typeof v !== 'string') return null;
  var m = v.replace(/^\s+|\s+$/g, '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  var h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return (h < 10 ? '0' : '') + h + ':' + m[2];
}

// weekdays 0 (Sunday) .. 6: integers (or numeric strings) kept, deduplicated, ascending; [] = every day
function weekdays(v) {
  var seen = {}, out = [];
  if (!(v instanceof Array)) return out;
  for (var i = 0; i < v.length; i++) {
    var n = toNumber(v[i]);
    if (n === null || n !== Math.floor(n) || n < 0 || n > 6 || seen[n]) continue;
    seen[n] = true;
    out.push(n);
  }
  out.sort(function (a, b) { return a - b; });
  return out;
}

function connectionId(routeId, stopId) { return routeId + '|' + stopId; }

function normalize(raw) {
  var d = defaults();
  var r = isObject(raw) ? raw : {};
  var out = { version: 1 };

  var p = isObject(r.provider) ? r.provider : {};
  out.provider = {
    type: typeof p.type === 'string' && PROVIDER_TYPE_RE.test(str(p.type, '')) ? str(p.type, '') : d.provider.type,
    baseUrl: str(p.baseUrl, d.provider.baseUrl).replace(/\/+$/, ''),
    apiKey: str(p.apiKey, d.provider.apiKey)
  };

  var l = isObject(r.location) ? r.location : {};
  out.location = {
    mode: oneOf(l.mode, LOCATION_MODES, d.location.mode),
    lat: num(l.lat, d.location.lat, { min: -90, max: 90 }),
    lon: num(l.lon, d.location.lon, { min: -180, max: 180 })
  };

  for (var f in RANGES) {
    if (RANGES.hasOwnProperty(f)) out[f] = num(r[f], d[f], RANGES[f]);
  }

  var routes = [], seenRoutes = {};
  var rawRoutes = r.routes instanceof Array ? r.routes : [];
  for (var i = 0; i < rawRoutes.length; i++) {
    var ro = rawRoutes[i];
    if (!isObject(ro)) continue;
    var id = str(ro.id, '');
    if (id === '' || seenRoutes.hasOwnProperty(id)) continue;
    seenRoutes[id] = true;
    var name = str(ro.name, '');
    routes.push({ id: id, name: name === '' ? id : name, scale: num(ro.scale, out.defaultRouteScale), color: color(ro.color) });
  }
  out.routes = routes;

  var conns = [], seenConns = {};
  var rawConns = r.connections instanceof Array ? r.connections : [];
  for (var j = 0; j < rawConns.length; j++) {
    var c = rawConns[j];
    if (!isObject(c)) continue;
    var routeId = str(c.routeId, ''), stopId = str(c.stopId, '');
    if (routeId === '' || stopId === '') continue;
    var cid = connectionId(routeId, stopId);
    if (seenConns.hasOwnProperty(cid)) continue;
    seenConns[cid] = true;
    var cname = str(c.name, '');
    conns.push({ id: cid, routeId: routeId, stopId: stopId, name: cname === '' ? stopId : cname,
                 scale: num(c.scale, out.defaultConnectionScale) });
  }
  out.connections = conns;

  out.stopScales = {};
  if (isObject(r.stopScales)) {
    for (var k in r.stopScales) {
      if (!r.stopScales.hasOwnProperty(k)) continue;
      var key = str(k, '');
      var v = toNumber(r.stopScales[k]);
      if (key !== '' && v !== null) out.stopScales[key] = v;
    }
  }

  out.units = oneOf(r.units, UNITS, d.units);
  out.clock24 = bool(r.clock24, d.clock24);

  var dests = [], seenDests = {}, pendingIds = [];
  var rawDests = r.destinations instanceof Array ? r.destinations : [];
  for (var di = 0; di < rawDests.length && dests.length < MAX_DESTINATIONS; di++) {
    var de = rawDests[di];
    if (!isObject(de)) continue;
    var dlat = toNumber(de.lat), dlon = toNumber(de.lon), arrive = clockTime(de.arriveBy);
    if (dlat === null || dlon === null || arrive === null) continue;
    var did = str(de.id, '');
    if (did !== '' && seenDests.hasOwnProperty(did)) continue;
    if (did !== '') seenDests[did] = true;
    var dname = str(de.name, '');
    var dest = { id: did, name: dname === '' ? 'Destination ' + (dests.length + 1) : dname,
                 lat: num(dlat, 0, { min: -90, max: 90 }), lon: num(dlon, 0, { min: -180, max: 180 }),
                 arriveBy: arrive, days: weekdays(de.days), enabled: bool(de.enabled, true) };
    if (did === '') pendingIds.push(dest);
    dests.push(dest);
  }
  var nextId = 1;
  for (var pi = 0; pi < pendingIds.length; pi++) {
    while (seenDests.hasOwnProperty('dest' + nextId)) nextId++;
    pendingIds[pi].id = 'dest' + nextId;
    seenDests['dest' + nextId] = true;
  }
  out.destinations = dests;

  var sc = isObject(r.schedule) ? r.schedule : {};
  out.schedule = {};
  for (var sf in SCHEDULE_RANGES) {
    if (SCHEDULE_RANGES.hasOwnProperty(sf)) out.schedule[sf] = num(sc[sf], d.schedule[sf], SCHEDULE_RANGES[sf]);
  }
  out.schedule.leaveReminder = bool(sc.leaveReminder, d.schedule.leaveReminder);

  var t = isObject(r.training) ? r.training : {};
  out.training = { autoTrain: bool(t.autoTrain, d.training.autoTrain) };
  for (var tf in TRAINING_RANGES) {
    if (TRAINING_RANGES.hasOwnProperty(tf)) out.training[tf] = num(t[tf], d.training[tf], TRAINING_RANGES[tf]);
  }
  return out;
}

function parse(json) {
  if (typeof json !== 'string' || json === '') return defaults();
  try {
    return normalize(JSON.parse(json));
  } catch (e) {
    return defaults();
  }
}

module.exports = {
  RANGES: RANGES,
  TRAINING_RANGES: TRAINING_RANGES,
  SCHEDULE_RANGES: SCHEDULE_RANGES,
  UNITS: UNITS,
  MAX_DESTINATIONS: MAX_DESTINATIONS,
  clockTime: clockTime,
  LOCATION_MODES: LOCATION_MODES,
  defaults: defaults,
  normalize: normalize,
  parse: parse,
  connectionId: connectionId,
  color: color
};
