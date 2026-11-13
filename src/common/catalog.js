// The route / stop index of each transit system, for type-to-search in the settings page (CONTRACTS.md §3b). ES5.
//
// A source with a `catalog(cb, onProgress)` method lists everything it knows: cb(err, {routes, stops}) with
// routes [{id, shortName, longName}] and stops [{id, name, routeIds, lat?, lon?, dir?}] (dir: the direction buses travel
// at the stop, 'Northbound' / 'NB' / 'N' ..., to tell same-name stops apart). The phone builds each system's index in
// the background, keeps it in storage for TTL (7 days) and hands it to the settings page, which can also build one itself
// (e.g. for a system added on the page). Stored packed: routes [id, shortName, longName],
// stops [id, name, [route index...]] + [lat, lon] (when known) + [dir code] (when known; lat/lon null without a position).
var directions = require('./directions');

var TTL = 7 * 86400;
var PREFIX = 'busWatch.catalog.';
var DEFAULT_LIMIT = 6;

function str(v) { return v == null ? '' : String(v); }

// what the index depends on: rebuilt when the system's type / server / key change
function signature(entry) {
  entry = entry || {};
  return [str(entry.type), str(entry.baseUrl), str(entry.apiKey)].join('|');
}

function round6(n) { return Math.round(n * 1e6) / 1e6; }

function pack(data, meta) {
  var routes = [], stops = [], at = {}, i, k;
  var rs = (data && data.routes) || [];
  for (i = 0; i < rs.length; i++) {
    var id = str(rs[i].id);
    if (id === '' || at.hasOwnProperty(id)) continue;
    at[id] = routes.length;
    routes.push([id, str(rs[i].shortName || id), str(rs[i].longName)]);
  }
  var ss = (data && data.stops) || [];
  var seen = {};
  for (i = 0; i < ss.length; i++) {
    var s = ss[i], sid = str(s.id);
    if (sid === '' || seen.hasOwnProperty(sid)) continue;
    seen[sid] = true;
    var idx = [];
    for (k = 0; s.routeIds && k < s.routeIds.length; k++) {
      var r = str(s.routeIds[k]);
      if (!at.hasOwnProperty(r)) { at[r] = routes.length; routes.push([r, r, '']); }
      if (idx.indexOf(at[r]) < 0) idx.push(at[r]);
    }
    var row = [sid, str(s.name || sid), idx];
    var pos = typeof s.lat === 'number' && typeof s.lon === 'number' && isFinite(s.lat) && isFinite(s.lon) && !(s.lat === 0 && s.lon === 0);
    var dir = directions.abbreviate(str(s.dir));
    if (pos || dir) row.push(pos ? round6(s.lat) : null, pos ? round6(s.lon) : null);
    if (dir) row.push(dir);
    stops.push(row);
  }
  meta = meta || {};
  return { v: 1, t: meta.t || 0, sig: str(meta.sig), routes: routes, stops: stops };
}

// packed → {t, sig, routes: [{id, shortName, longName}], stops: [{id, name, routeIds, lat?, lon?}]}; bad → null
function unpack(p) {
  if (!p || p.v !== 1 || !(p.routes instanceof Array) || !(p.stops instanceof Array)) return null;
  var routes = [], stops = [], i;
  for (i = 0; i < p.routes.length; i++) {
    var r = p.routes[i];
    if (r instanceof Array) routes.push({ id: str(r[0]), shortName: str(r[1]), longName: str(r[2]) });
  }
  for (i = 0; i < p.stops.length; i++) {
    var s = p.stops[i];
    if (!(s instanceof Array)) continue;
    var ids = [];
    for (var k = 0; s[2] instanceof Array && k < s[2].length; k++) if (routes[s[2][k]]) ids.push(routes[s[2][k]].id);
    var stop = { id: str(s[0]), name: str(s[1]), routeIds: ids };
    if (typeof s[3] === 'number' && typeof s[4] === 'number') { stop.lat = s[3]; stop.lon = s[4]; }
    if (typeof s[5] === 'string' && s[5]) stop.dir = s[5];
    stops.push(stop);
  }
  return { t: +p.t || 0, sig: str(p.sig), routes: routes, stops: stops };
}

// ---------------------------------------------------------------------------------------------- transport
// The settings page is opened as a data: URI, percent-encoded, so the index travels as text whose separators are
// characters encodeURIComponent leaves alone: records '~', fields '!', route indexes '.', spaces as '_'; '_' '~' '!' '*'
// inside a field as '*' + 2 hex digits. About half the size of the encoded JSON.
//   {v: 1, t, sig, text: routes '~~' stops}  route = id!short!long   stop = id!name!i.j.k[!lat!lon[!dir]] (lat/lon '' = none)
function esc(v) {
  return str(v).replace(/[_~!*]/g, function (c) { return '*' + c.charCodeAt(0).toString(16).toUpperCase(); }).replace(/ /g, '_');
}
function unesc(v) {
  return v.replace(/_/g, ' ').replace(/\*([0-9A-F]{2})/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); });
}
function toText(p) {
  if (!p || p.v !== 1) return null;
  var routes = [], stops = [], i;
  for (i = 0; i < p.routes.length; i++) routes.push(esc(p.routes[i][0]) + '!' + esc(p.routes[i][1]) + '!' + esc(p.routes[i][2]));
  for (i = 0; i < p.stops.length; i++) {
    var s = p.stops[i];
    stops.push(esc(s[0]) + '!' + esc(s[1]) + '!' + (s[2] || []).join('.') +
      (s.length > 4 ? '!' + (s[3] == null ? '' : s[3]) + '!' + (s[4] == null ? '' : s[4]) : '') + (s.length > 5 ? '!' + esc(s[5]) : ''));
  }
  return { v: 1, t: p.t, sig: p.sig, text: routes.join('~') + '~~' + stops.join('~') };
}
// text form → packed (also accepts a packed index as it is); bad → null
function fromText(o) {
  if (!o || o.v !== 1) return null;
  if (o.routes instanceof Array) return o;
  if (typeof o.text !== 'string') return null;
  var parts = o.text.split('~~'), routes = [], stops = [], i;
  var rs = parts[0] ? parts[0].split('~') : [], ss = parts[1] ? parts[1].split('~') : [];
  for (i = 0; i < rs.length; i++) {
    var r = rs[i].split('!');
    routes.push([unesc(r[0]), unesc(r[1] || ''), unesc(r[2] || '')]);
  }
  for (i = 0; i < ss.length; i++) {
    var f = ss[i].split('!'), idx = [];
    var raw = f[2] ? f[2].split('.') : [];
    for (var k = 0; k < raw.length; k++) idx.push(+raw[k]);
    var row = [unesc(f[0]), unesc(f[1] || ''), idx];
    if (f.length > 4) row.push(f[3] === '' ? null : +f[3], f[4] === '' ? null : +f[4]);
    if (f.length > 5 && f[5]) row.push(unesc(f[5]));
    stops.push(row);
  }
  return { v: 1, t: +o.t || 0, sig: str(o.sig), routes: routes, stops: stops };
}

function key(providerId) { return PREFIX + providerId; }

// the stored packed index of system entry, or null (missing, bad, or built for another type / server / key)
function loadPacked(storage, entry) {
  if (!storage || !entry) return null;
  try {
    var raw = storage.getItem(key(entry.id));
    if (!raw) return null;
    var p = JSON.parse(raw);
    if (!p || p.v !== 1 || p.sig !== signature(entry)) return null;
    return p;
  } catch (e) {
    return null;
  }
}

function fresh(packed, now) {
  return !!packed && now - packed.t < TTL && packed.t <= now + 86400;
}

function save(storage, entry, packed) {
  if (!storage) return false;
  try {
    storage.setItem(key(entry.id), JSON.stringify(packed));
    return true;
  } catch (e) {
    return false;
  }
}

function remove(storage, providerId) {
  try { if (storage) storage.removeItem(key(providerId)); } catch (e) { /* blocked */ }
}

// cb(err, packed) — the provider's catalog, packed with {t: now, sig}. Sources without one: their route list
// (listRoutes) and no stops; neither → error.
function build(provider, entry, now, cb, onProgress) {
  var done = false;
  function finish(err, data) {
    if (done) return;
    done = true;
    if (err) return cb(err instanceof Error ? err : new Error(str(err)));
    var packed;
    try { packed = pack(data, { t: now, sig: signature(entry) }); } catch (e) { return cb(e); }
    cb(null, packed);
  }
  try {
    if (provider && typeof provider.catalog === 'function') {
      provider.catalog(finish, function (doneCount, total) {
        if (typeof onProgress === 'function') { try { onProgress(doneCount, total); } catch (e) { /* ignore */ } }
      });
    } else if (provider && typeof provider.listRoutes === 'function') {
      provider.listRoutes(function (err, list) {
        if (err) return finish(err);
        var routes = [];
        for (var i = 0; list && i < list.length; i++) routes.push({ id: list[i].id, shortName: list[i].id, longName: list[i].label });
        finish(null, { routes: routes, stops: [] });
      });
    } else {
      finish(new Error("this source can't list its routes and stops"));
    }
  } catch (e) {
    finish(e);
  }
}

// ---------------------------------------------------------------------------------------------- search
var ACCENTS = /[̀-ͯ]/g;

// lower case, accents stripped, '&' → 'and', other punctuation → spaces, single spaces
function norm(s) {
  s = str(s);
  if (typeof s.normalize === 'function') s = s.normalize('NFD').replace(ACCENTS, '');
  return s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/^ +| +$/g, '');
}

function words(s) { return s === '' ? [] : s.split(' '); }

// edit distance between a and b, or max + 1 when it is larger than max
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  var prev = [], cur = [], i, j;
  for (j = 0; j <= b.length; j++) prev[j] = j;
  for (i = 1; i <= a.length; i++) {
    cur = [i];
    var rowMin = i;
    for (j = 1; j <= b.length; j++) {
      var v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function allowedEdits(len) { return len >= 7 ? 2 : len >= 3 ? 1 : 0; }

// how well query q (normalized, tokens qt) matches text t (normalized); 0 = not at all
function textScore(q, qt, t) {
  if (t === '') return 0;
  if (t === q) return 950;
  if (t.indexOf(q) === 0) return 850 - Math.min(100, t.length - q.length);
  var tw = words(t), i, j;
  // every query token starts a distinct word of t
  var used = [], inOrder = true, last = -1, ok = true;
  for (i = 0; i < qt.length && ok; i++) {
    var hit = -1;
    for (j = 0; j < tw.length; j++) if (!used[j] && tw[j].indexOf(qt[i]) === 0) { hit = j; break; }
    if (hit < 0) ok = false;
    else { used[hit] = true; if (hit < last) inOrder = false; last = hit; }
  }
  if (ok) return 700 + (inOrder ? 40 : 0) - Math.min(60, tw.length * 3);
  if (t.indexOf(q) >= 0) return 520;
  // every token is somewhere in t
  ok = true;
  for (i = 0; i < qt.length && ok; i++) if (t.indexOf(qt[i]) < 0) ok = false;
  if (ok) return 450;
  // typos: each token within a few edits of some word (or of a word's start of the same length)
  var edits = 0;
  for (i = 0; i < qt.length; i++) {
    var max = allowedEdits(qt[i].length), best = max + 1;
    for (j = 0; j < tw.length && best > 0; j++) {
      var w = tw[j];
      var d = Math.min(editDistance(qt[i], w, max), w.length > qt[i].length ? editDistance(qt[i], w.slice(0, qt[i].length), max) : max + 1);
      if (d < best) best = d;
    }
    if (best > max) return 0;
    edits += best;
  }
  return 300 - 30 * edits - Math.min(60, tw.length * 3);
}

function idScore(q, id) {
  var n = norm(id);
  if (n === q) return 1000;
  if (q.length >= 1 && n.indexOf(q) === 0) return 900 - Math.min(100, n.length - q.length);
  return 0;
}

// Best matches for query in one unpacked index → [{kind, id, name, detail, routeIds?, lat?, lon?, score}], best first
// (ties: shorter name, then id). opts = {kind: 'route'|'stop', limit (default 6), routeNames?: {id: label} for stop details}
function search(index, query, opts) {
  opts = opts || {};
  var kind = opts.kind === 'stop' ? 'stop' : 'route';
  var limit = opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;
  var q = norm(query);
  if (!index || q === '') return [];
  var qt = words(q);
  var found = [], i;
  if (kind === 'route') {
    for (i = 0; i < index.routes.length; i++) {
      var r = index.routes[i];
      var sc = Math.max(idScore(q, r.id), idScore(q, r.shortName), textScore(q, qt, norm(r.shortName)),
                        textScore(q, qt, norm(r.longName)) - 20);
      if (sc > 0) found.push({ kind: 'route', id: r.id, name: r.shortName || r.id, detail: r.longName, score: sc });
    }
  } else {
    var names = {};
    for (i = 0; i < index.routes.length; i++) names[index.routes[i].id] = index.routes[i].shortName || index.routes[i].id;
    // a direction word in the query ('westbound', 'wb'; not a bare 'west', which is often part of a street name) filters
    // by direction: stops going another way are left out, and the word isn't matched against names
    var qDir = '', rest = [];
    for (i = 0; i < qt.length; i++) {
      var code = /bound$|^[nsew]b$/.test(qt[i]) ? directions.abbreviate(qt[i]) : '';
      if (code && !qDir) qDir = code;
      else rest.push(qt[i]);
    }
    var qn = qDir ? rest.join(' ') : q, qnt = qDir ? rest : qt;
    for (i = 0; i < index.stops.length; i++) {
      var s = index.stops[i];
      if (qDir && s.dir && s.dir !== qDir) continue;
      var ss = qn ? Math.max(idScore(qn, s.id), textScore(qn, qnt, norm(s.name))) : (s.dir === qDir ? 200 : 0);
      if (qDir && s.dir === qDir && ss > 0) ss += 5;   // the asked-for direction first
      if (ss <= 0) continue;
      var labels = [];
      for (var k = 0; k < s.routeIds.length; k++) labels.push(names[s.routeIds[k]] || s.routeIds[k]);
      var hit = { kind: 'stop', id: s.id, name: s.name || s.id, detail: labels.join(', '), routeIds: s.routeIds.slice(), score: ss };
      if (typeof s.lat === 'number') { hit.lat = s.lat; hit.lon = s.lon; }
      if (s.dir) hit.dir = s.dir;
      found.push(hit);
    }
  }
  found.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    if (a.name.length !== b.name.length) return a.name.length - b.name.length;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return found.slice(0, limit);
}

// one stop of an unpacked index by id, or null
function stop(index, id) {
  for (var i = 0; index && i < index.stops.length; i++) if (index.stops[i].id === id) return index.stops[i];
  return null;
}

module.exports = {
  TTL: TTL, PREFIX: PREFIX,
  signature: signature, pack: pack, unpack: unpack, toText: toText, fromText: fromText,
  loadPacked: loadPacked, fresh: fresh, save: save, remove: remove, build: build,
  norm: norm, editDistance: editDistance, search: search, stop: stop
};
