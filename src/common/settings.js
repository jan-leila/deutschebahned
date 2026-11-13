// Configuration model: defaults, validation and (de)serialization. ES5 (runs in PebbleKit JS and the settings page).
// See CONTRACTS.md §2.

// Data sources are plug-ins (src/sources/); settings only checks that types and provider ids look like ids.
var ID_RE = /^[a-z0-9_-]{1,32}$/;
var DEFAULT_PROVIDER_TYPE = 'metrotransit';   // what a version 1 config's '' provider type meant
var MAX_DESTINATIONS = 8;
var MAX_PROVIDERS = 8;
var LOCATION_MODES = ['gps', 'fixed'];
var COVERAGE_MODES = ['auto', 'manual'];
var COVERAGE_RADIUS = { min: 1000, max: 500000, integer: true };
var DEFAULT_COVERAGE_RADIUS = 50000;

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
  vehicleRadius: { min: 10, max: 2000, integer: true }
};
var SCALE_RANGE = { min: -1000, max: 1000, integer: false };

var SCHEDULE_RANGES = {
  leadMinutes: { min: 0, max: 120, integer: true },
  walkSpeed: { min: 0.3, max: 3, integer: false },
  maxWalk: { min: 50, max: 5000, integer: true },
  transferWalk: { min: 0, max: 1000, integer: true },
  maxTransfers: { min: 0, max: 1, integer: true },
  minTransfer: { min: 0, max: 1200, integer: true },
  // seconds of transfer slack needed when the connecting bus is the last one for an hour (missing it costs that much)
  lastTransfer: { min: 0, max: 3600, integer: true },
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
    version: 2,
    // transit systems; each saved route / stop belongs to one by providerId. Empty baseUrl / apiKey = the source's default.
    providers: [defaultProvider(DEFAULT_PROVIDER_TYPE, DEFAULT_PROVIDER_TYPE)],
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
    showWalk: true,    // watch: walking time to a stop, right-aligned in the tile's times line
    showArrow: true,   // watch: the arrow pointing at the stop
    routes: [],
    stops: [],
    destinations: [],
    schedule: { leadMinutes: 15, walkSpeed: 1.3, maxWalk: 800, transferWalk: 250, maxTransfers: 1, minTransfer: 120,
                lastTransfer: 600, leaveReminder: true, fallbackMinutes: 60 },
    training: { autoTrain: true, learningRate: 0.05, iterations: 300, temperature: 60, regularization: 0.01, maxSamples: 200 }
  };
}

function defaultProvider(id, type) {
  return { id: id, type: type, name: '', baseUrl: '', apiKey: '',
           coverage: { mode: 'auto', lat: 0, lon: 0, radius: DEFAULT_COVERAGE_RADIUS } };
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

// finite number or null (for optional coordinates)
function optCoord(v, range) {
  var n = toNumber(v);
  if (n === null) return null;
  return num(n, 0, range);
}

// a free provider id derived from `base` ('metrotransit', 'metrotransit-2', ...)
function freeId(base, seen) {
  base = String(base || 'source').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 28) || 'source';
  if (!seen.hasOwnProperty(base)) return base;
  for (var n = 2; ; n++) if (!seen.hasOwnProperty(base + '-' + n)) return base + '-' + n;
}

function normalizeProviders(list) {
  var out = [], seen = {};
  var raw = list instanceof Array ? list : [];
  for (var i = 0; i < raw.length && out.length < MAX_PROVIDERS; i++) {
    var p = raw[i];
    if (!isObject(p)) continue;
    var type = str(p.type, '');
    if (!ID_RE.test(type)) continue;
    var id = str(p.id, '');
    if (!ID_RE.test(id) || seen.hasOwnProperty(id)) id = freeId(type, seen);
    seen[id] = true;
    var cv = isObject(p.coverage) ? p.coverage : {};
    out.push({
      id: id, type: type, name: str(p.name, ''),
      baseUrl: str(p.baseUrl, '').replace(/\/+$/, ''), apiKey: str(p.apiKey, ''),
      coverage: { mode: oneOf(cv.mode, COVERAGE_MODES, 'auto'),
                  lat: num(cv.lat, 0, { min: -90, max: 90 }), lon: num(cv.lon, 0, { min: -180, max: 180 }),
                  radius: num(cv.radius, DEFAULT_COVERAGE_RADIUS, COVERAGE_RADIUS) }
    });
  }
  return out;
}

function hasProvider(providers, id) {
  for (var i = 0; i < providers.length; i++) if (providers[i].id === id) return true;
  return false;
}

function normalizeRoutes(list, providers) {
  var out = [], seen = {};
  var raw = list instanceof Array ? list : [];
  for (var i = 0; i < raw.length; i++) {
    var ro = raw[i];
    if (!isObject(ro)) continue;
    var pid = str(ro.providerId, ''), id = str(ro.id, '');
    if (id === '' || !hasProvider(providers, pid)) continue;
    var key = pid + '/' + id;
    if (seen.hasOwnProperty(key)) continue;
    seen[key] = true;
    var name = str(ro.name, '');
    out.push({ providerId: pid, id: id, name: name === '' ? id : name, scale: num(ro.scale, 0, SCALE_RANGE), color: color(ro.color) });
  }
  return out;
}

function normalizeStops(list, providers) {
  var out = [], seen = {};
  var raw = list instanceof Array ? list : [];
  for (var i = 0; i < raw.length; i++) {
    var so = raw[i];
    if (!isObject(so)) continue;
    var pid = str(so.providerId, ''), id = str(so.id, '');
    if (id === '' || !hasProvider(providers, pid)) continue;
    var key = pid + '/' + id;
    if (seen.hasOwnProperty(key)) continue;
    seen[key] = true;
    var name = str(so.name, '');
    var lat = optCoord(so.lat, { min: -90, max: 90 }), lon = optCoord(so.lon, { min: -180, max: 180 });
    if (lat === null || lon === null) { lat = null; lon = null; }
    out.push({ providerId: pid, id: id, name: name === '' ? id : name, lat: lat, lon: lon,
               walkScale: num(so.walkScale, 0, SCALE_RANGE), rideScale: num(so.rideScale, 0, SCALE_RANGE) });
  }
  return out;
}

// A version 1 config (one `provider`, `connections` + `stopScales`, default scales) as version 2 lists.
// Its single source becomes provider `<type>`; a pinned stop's route is saved too, so its drop-offs keep working.
function migrateV1(r) {
  var p = isObject(r.provider) ? r.provider : {};
  var type = str(p.type, '');
  if (!ID_RE.test(type)) type = DEFAULT_PROVIDER_TYPE;
  var prov = defaultProvider(type, type);
  prov.baseUrl = str(p.baseUrl, '');
  prov.apiKey = str(p.apiKey, '');
  var routes = [], stops = [], routeAt = {}, stopAt = {}, i;
  var rawRoutes = r.routes instanceof Array ? r.routes : [];
  for (i = 0; i < rawRoutes.length; i++) {
    var ro = rawRoutes[i];
    if (!isObject(ro)) continue;
    var rid = str(ro.id, '');
    if (rid === '' || routeAt.hasOwnProperty(rid)) continue;
    routeAt[rid] = true;
    routes.push({ providerId: type, id: rid, name: ro.name, color: ro.color,
                  scale: toNumber(ro.scale) !== null ? ro.scale : r.defaultRouteScale });
  }
  var conns = r.connections instanceof Array ? r.connections : [];
  for (i = 0; i < conns.length; i++) {
    var c = conns[i];
    if (!isObject(c)) continue;
    var cr = str(c.routeId, ''), cs = str(c.stopId, '');
    if (cr === '' || cs === '') continue;
    if (!routeAt.hasOwnProperty(cr)) { routeAt[cr] = true; routes.push({ providerId: type, id: cr, scale: 0 }); }
    if (stopAt.hasOwnProperty(cs)) continue;
    stopAt[cs] = stops.length;
    stops.push({ providerId: type, id: cs, name: c.name,
                 rideScale: toNumber(c.scale) !== null ? c.scale : r.defaultConnectionScale, walkScale: 0 });
  }
  var ss = isObject(r.stopScales) ? r.stopScales : {};
  for (var k in ss) {
    if (!ss.hasOwnProperty(k)) continue;
    var sid = str(k, '');
    if (sid === '' || toNumber(ss[k]) === null) continue;
    if (stopAt.hasOwnProperty(sid)) stops[stopAt[sid]].walkScale = ss[k];
    else { stopAt[sid] = stops.length; stops.push({ providerId: type, id: sid, walkScale: ss[k], rideScale: 0 }); }
  }
  return { providers: [prov], routes: routes, stops: stops };
}

function isV1(r) { return isObject(r) && !(r.providers instanceof Array) && r.version !== 2; }

// Feature / learned-weight key of a version 1 config → version 2 ('stop:S' → 'stop:<pid>/S', 'route:R' → 'route:<pid>/R',
// 'conn:R|S' → 'ride:<pid>/S'); keys that already name a provider, or that aren't feature keys, are returned unchanged.
function migrateKey(key, providerId) {
  if (typeof key !== 'string') return key;
  var i = key.indexOf(':');
  if (i <= 0) return key;
  var kind = key.slice(0, i), id = key.slice(i + 1);
  if (kind === 'conn') {
    var bar = id.indexOf('|');
    return bar < 0 ? key : 'ride:' + providerId + '/' + id.slice(bar + 1);
  }
  if ((kind === 'stop' || kind === 'route') && id.indexOf('/') < 0) return kind + ':' + providerId + '/' + id;
  return key;
}

function normalize(raw) {
  var d = defaults();
  var r = isObject(raw) ? raw : {};
  var out = { version: 2 };

  var lists = isV1(r) ? migrateV1(r) : r;
  out.providers = lists.providers instanceof Array ? normalizeProviders(lists.providers) : d.providers;

  var l = isObject(r.location) ? r.location : {};
  out.location = {
    mode: oneOf(l.mode, LOCATION_MODES, d.location.mode),
    lat: num(l.lat, d.location.lat, { min: -90, max: 90 }),
    lon: num(l.lon, d.location.lon, { min: -180, max: 180 })
  };

  for (var f in RANGES) {
    if (RANGES.hasOwnProperty(f)) out[f] = num(r[f], d[f], RANGES[f]);
  }

  out.showWalk = bool(r.showWalk, d.showWalk);
  out.showArrow = bool(r.showArrow, d.showArrow);
  out.routes = normalizeRoutes(lists.routes, out.providers);
  out.stops = normalizeStops(lists.stops, out.providers);

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
                 address: str(de.address, ''),   // what the user typed / picked (shown again; the position is what counts)
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
  SCALE_RANGE: SCALE_RANGE,
  COVERAGE_RADIUS: COVERAGE_RADIUS,
  MAX_DESTINATIONS: MAX_DESTINATIONS,
  MAX_PROVIDERS: MAX_PROVIDERS,
  ID_RE: ID_RE,
  freeId: freeId,
  isV1: isV1,
  migrateKey: migrateKey,
  clockTime: clockTime,
  LOCATION_MODES: LOCATION_MODES,
  COVERAGE_MODES: COVERAGE_MODES,
  defaultProvider: defaultProvider,
  defaults: defaults,
  normalize: normalize,
  parse: parse,
  connectionId: connectionId,
  color: color
};
