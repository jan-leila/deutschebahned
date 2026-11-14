// Spoken commands (CONTRACTS.md §20): the routers the app declares to the phone app's text routing (Gravel:
// Pebble.setRouters, a 'route' event per routed text) and what each does. 'open' only opens the app, which the delivery
// itself does; the others take a query, find the saved route / stop / location whose name is closest to it and start
// navigation there. Routes and stops must be within the config's voiceRadius. All I/O is injected. ES5.

var catalog = require('./catalog');
var geo = require('./geo');

var ROUTERS = [
  { id: 'open', name: 'Open', description: 'Opens the app on the watch' },
  { id: 'route', name: 'Navigate to a route', description: 'To the nearby saved route closest to the query', params: ['query'] },
  { id: 'stop', name: 'Navigate to a stop', description: 'To the nearby saved stop closest to the query', params: ['query'] },
  { id: 'location', name: 'Navigate to a location', description: 'To the saved location closest to the query', params: ['query'] }
];

var KIND_NAMES = { route: 'route', stop: 'stop', location: 'saved location' };
// words people say around a name that are rarely part of it; dropped only when something is left without them
var FILLER = { the: 1, a: 1, an: 1, my: 1, to: 1, bus: 1, line: 1, route: 1, stop: 1, station: 1 };

function isNum(v) { return typeof v === 'number' && isFinite(v); }
function isPoint(p) { return !!p && isNum(p.lat) && isNum(p.lon); }

// payload: what the phone app hands a router (an object, or its JSON): the router's `query` field when the routing
// maps one, else the text its rule left unmatched, else the whole text → trimmed string
function query(payload) {
  var p = payload;
  if (typeof p === 'string') {
    try { p = JSON.parse(p); } catch (e) { return p.replace(/^\s+|\s+$/g, ''); }
  }
  if (!p || typeof p !== 'object') return '';
  var picks = [p.fields && p.fields.query, p.unmatched_text, p.text];
  for (var i = 0; i < picks.length; i++) {
    if (typeof picks[i] === 'string' && /\S/.test(picks[i])) return picks[i].replace(/^\s+|\s+$/g, '');
  }
  return '';
}

function withoutFiller(q) {
  var words = catalog.norm(q).split(' '), kept = [];
  for (var i = 0; i < words.length; i++) if (!FILLER.hasOwnProperty(words[i])) kept.push(words[i]);
  return kept.join(' ');
}

// the better of the query as said and without its filler words, against each of texts
function score(q, texts) {
  var bare = withoutFiller(q), best = 0;
  for (var i = 0; i < texts.length; i++) {
    if (!texts[i]) continue;
    best = Math.max(best, catalog.score(q, texts[i]), bare ? catalog.score(bare, texts[i]) : 0);
  }
  return best;
}

// the stop of a loaded route nearest to pos → {id, stop, distance} | null
function nearestStop(route, pos) {
  var stops = (route && route.stops) || {}, best = null;
  for (var id in stops) {
    if (!stops.hasOwnProperty(id) || !isPoint(stops[id])) continue;
    var d = geo.distance(pos, stops[id]);
    if (!best || d < best.distance) best = { id: id, stop: stops[id], distance: d };
  }
  return best;
}

// What can be asked for: kind 'route' | 'stop' | 'location'; cfg a runtime view (view.build), data the planner Data of
// the same refresh, pos the position → [{kind, entry, names, distance (m | null), near?}]. Routes (by their nearest
// stop) and stops further than cfg.voiceRadius, or without a known position, are left out; locations never are.
function candidates(kind, cfg, data, pos) {
  var out = [], i, list;
  if (kind === 'route') {
    list = (cfg && cfg.routes) || [];
    for (i = 0; i < list.length; i++) {
      var near = pos ? nearestStop(data && data.routes && data.routes[list[i].id], pos) : null;
      if (!near || near.distance > cfg.voiceRadius) continue;
      var loaded = data.routes[list[i].id];
      out.push({ kind: kind, entry: list[i], names: [list[i].name, list[i].sourceId, loaded.shortName, loaded.longName],
                 distance: near.distance, near: near });
    }
  } else if (kind === 'stop') {
    list = (cfg && cfg.stops) || [];
    for (i = 0; i < list.length; i++) {
      if (!pos || !isPoint(list[i])) continue;
      var d = geo.distance(pos, list[i]);
      if (d <= cfg.voiceRadius) out.push({ kind: kind, entry: list[i], names: [list[i].name], distance: d });
    }
  } else if (kind === 'location') {
    list = (cfg && cfg.places) || [];
    for (i = 0; i < list.length; i++) {
      if (!isPoint(list[i])) continue;
      out.push({ kind: kind, entry: list[i], names: [list[i].name, list[i].address],
                 distance: pos ? geo.distance(pos, list[i]) : null });
    }
  }
  return out;
}

// the candidate whose name matches q best (ties: the nearer one), or null when none matches at all
function match(q, cands) {
  var best = null, bestScore = 0;
  for (var i = 0; i < cands.length; i++) {
    var s = score(q, cands[i].names);
    if (s <= 0) continue;
    var nearer = best && s === bestScore && cands[i].distance !== null && (best.distance === null || cands[i].distance < best.distance);
    if (!best || s > bestScore || nearer) { best = cands[i]; bestScore = s; }
  }
  return best;
}

function servesStop(item, stopId) {
  if (item.stopId === stopId) return true;
  for (var i = 0; i < (item.lanes || []).length; i++) if (item.lanes[i].stopId === stopId) return true;
  return false;
}

// The tile navigation starts from (nav.startItem). A route or stop that has a pickup tile in the list (items, ranked)
// is navigated as that tile; otherwise a route is its nearest stop (no bus times), a stop or location a walk to it.
function target(hit, items) {
  var e = hit.entry, i;
  items = items || [];
  if (hit.kind === 'route') {
    for (i = 0; i < items.length; i++) if (items[i].kind === 'pickup' && items[i].routeId === e.id) return items[i];
    return { kind: 'pickup', routeId: e.id, stopId: hit.near.id, badge: e.name, title: hit.near.stop.name || e.name,
             color: e.color || '', times: [] };
  }
  if (hit.kind === 'stop') {
    for (i = 0; i < items.length; i++) if (items[i].kind === 'pickup' && servesStop(items[i], e.id)) return items[i];
  }
  return { kind: 'place', title: e.name, lat: e.lat, lon: e.lon, color: '' };
}

// createVoice(deps): deps = {getList() → the session's last list ({items, pos, cfg, data}) | null,
// startNav(item, data), status(text), log?}
function createVoice(deps) {
  var log = deps.log || function () {};
  var pending = null;   // a command that arrived before the first list (the delivery opened the app)

  function run(kind, q, list) {
    var hit = match(q, candidates(kind, list.cfg, list.data, list.pos));
    if (!hit) {
      log('voice: no ' + kind + ' like "' + q + '"');
      deps.status('No ' + KIND_NAMES[kind] + ' like "' + q + '"');
      return false;
    }
    log('voice: ' + kind + ' "' + q + '" → ' + hit.entry.name);
    deps.startNav(target(hit, list.items), list.data);
    return true;
  }

  // routerId: a declared router's id; payload: see query(). → 'open' | 'started' | 'none' (nothing matched or nothing
  // asked for) | 'waiting' (runs at the next flush) | 'unknown'
  function handle(routerId, payload) {
    if (routerId === 'open') return 'open';
    if (!KIND_NAMES.hasOwnProperty(routerId)) {
      log('voice: unknown router ' + routerId);
      return 'unknown';
    }
    var q = query(payload);
    if (!q) {
      deps.status('Which ' + KIND_NAMES[routerId] + '?');
      return 'none';
    }
    var list = deps.getList();
    if (!list) {
      pending = { kind: routerId, q: q };
      return 'waiting';
    }
    return run(routerId, q, list) ? 'started' : 'none';
  }

  // call when a refresh ends: runs the waiting command against the list it produced; a refresh that produced none
  // drops the command (its error is on the watch)
  function flush() {
    var p = pending, list = deps.getList();
    pending = null;
    if (!p || !list) return false;
    return run(p.kind, p.q, list);
  }

  return { handle: handle, flush: flush };
}

module.exports = { ROUTERS: ROUTERS, query: query, candidates: candidates, match: match, target: target, createVoice: createVoice };
