'use strict';
// Trip planning (CONTRACTS.md §13): given a transit source, an origin, a destination and an
// arrive-by time, find the itinerary on the user's routes that leaves as late as possible while still
// arriving on time. Pure apart from the injected source (only `route` and `arrivals` are used). ES5.
var geo = require('./geo');
var directions = require('./directions');
var format = require('./format');

var ESTIMATED_SPEED = 6;          // m/s, bus speed when no live times are available
var MAX_ARRIVAL_REQUESTS = 8;     // arrivals requests per plan
var MAX_CANDIDATES = 3;           // geometric candidates checked against live times, per phase
var DEFAULT_HEADWAY = 900;        // s, wait slack when the headway can't be observed
var MAX_LOOKAHEAD_MINUTES = 240;  // cap of the arrivals window
var WINDOW_MARGIN_MINUTES = 30;   // arrivals are fetched until arriveBy + this, to see whether the data reaches arriveBy
var SUMMARY_MAX = 40;
var DEFAULTS = { walkSpeed: 1.3, maxWalk: 800, transferWalk: 250, maxTransfers: 1, minTransfer: 120 };

function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
function isPos(p) { return !!p && typeof p.lat === 'number' && typeof p.lon === 'number' && isFinite(p.lat) && isFinite(p.lon); }
function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }

function median(xs) {
  if (!xs.length) return null;
  var s = xs.slice().sort(function (a, b) { return a - b; });
  var m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// ---------------------------------------------------------------------------------------------
// plan

function plan(source, request, cb) {
  var finished = false;
  function finish(err, value) {
    if (finished) return;
    finished = true;
    cb(err || null, err ? undefined : value);
  }
  // run fn(); a thrown error ends the plan with that error (cb is always called outside the try)
  function guard(fn) {
    var failure = null;
    try { fn(); } catch (e) { failure = e; }
    if (failure) finish(failure);
  }

  var req = request || {};
  if (!source || typeof source.route !== 'function' || typeof source.arrivals !== 'function') return finish(new Error('router: bad source'));
  if (!isPos(req.origin) || !isPos(req.destination) || typeof req.arriveBy !== 'number' || typeof req.now !== 'number') {
    return finish(new Error('router: bad request'));
  }

  var o = {
    origin: req.origin, destination: req.destination, arriveBy: req.arriveBy, now: req.now,
    walkSpeed: num(req.walkSpeed, DEFAULTS.walkSpeed) > 0 ? num(req.walkSpeed, DEFAULTS.walkSpeed) : DEFAULTS.walkSpeed,
    maxWalk: num(req.maxWalk, DEFAULTS.maxWalk),
    transferWalk: num(req.transferWalk, DEFAULTS.transferWalk),
    maxTransfers: num(req.maxTransfers, DEFAULTS.maxTransfers),
    minTransfer: num(req.minTransfer, DEFAULTS.minTransfer),
    routeNames: req.routeNames || {}, routeColors: req.routeColors || {}
  };

  var ids = [];
  var seen = {};
  var rawIds = req.routeIds || [];
  for (var i = 0; i < rawIds.length; i++) {
    var rid = String(rawIds[i]);
    if (!has(seen, rid)) { seen[rid] = true; ids.push(rid); }
  }

  loadRoutes(source, ids, req.routeCache, function (err, routes) {
    guard(function () {
      if (err) return finish(err);
      search(source, o, routes, finish);
    });
  });
}

// cb(err, [Route]) — cache first, the rest fetched in parallel; failures skipped; all failing → err
function loadRoutes(source, ids, cache, cb) {
  var out = [];
  var pending = 0;
  var lastErr = null;
  var results = {};
  var toFetch = [];
  for (var i = 0; i < ids.length; i++) {
    if (cache && has(cache, ids[i]) && cache[ids[i]]) results[ids[i]] = cache[ids[i]];
    else toFetch.push(ids[i]);
  }
  function collect() {
    for (var k = 0; k < ids.length; k++) if (results[ids[k]]) out.push(results[ids[k]]);
    if (ids.length && !out.length) return cb(lastErr || new Error('router: no routes loaded'));
    cb(null, out);
  }
  if (!toFetch.length) return collect();
  pending = toFetch.length;
  toFetch.forEach(function (id) {
    var called = false;
    function got(err, route) {
      if (called) return;
      called = true;
      if (err || !route || !route.directions) lastErr = err || new Error('router: bad route ' + id);
      else {
        results[id] = route;
        if (cache) cache[id] = route;
      }
      if (--pending === 0) collect();
    }
    try { source.route(id, got); } catch (e) { got(e); }
  });
}

function search(source, o, routes, finish) {
  var ws = o.walkSpeed;
  function walk(a, b) { var m = geo.distance(a, b); return { m: m, s: Math.ceil(m / ws) }; }

  // directions with their usable stops (coordinates known), cumulative along-route distance and walks
  var dirs = [];
  for (var r = 0; r < routes.length; r++) {
    var route = routes[r];
    var ds = route.directions || [];
    for (var d = 0; d < ds.length; d++) {
      var dir = ds[d];
      var pts = [];
      var cum = 0;
      var stopIds = dir.stopIds || [];
      for (var k = 0; k < stopIds.length; k++) {
        var st = route.stops && route.stops[stopIds[k]];
        if (!isPos(st)) continue;
        if (pts.length) cum += geo.distance(pts[pts.length - 1], st);
        pts.push({ id: String(stopIds[k]), name: st.name || '', lat: st.lat, lon: st.lon, cum: cum,
                   from: walk(o.origin, st), to: walk(st, o.destination) });
      }
      if (pts.length >= 2) dirs.push({ route: route, dir: dir, pts: pts });
    }
  }

  var walkOnly = null;
  var wOD = walk(o.origin, o.destination);
  if (wOD.m <= o.maxWalk && o.arriveBy - wOD.s >= o.now) {
    walkOnly = { arriveBy: o.arriveBy, leaveAt: o.arriveBy - wOD.s, arriveAt: o.arriveBy, estimated: false,
                 legs: [walkLeg(wOD, o.destination.name)] };
  }

  var direct = directCandidates(dirs, o);
  var cheapest = direct.length ? direct[0].cost : Infinity;
  if (walkOnly && wOD.s <= cheapest) {
    // no bus beats the walk even on paper (and transfers only cost more): no need to fetch anything
    var tr0 = o.maxTransfers >= 1 && !direct.length ? transferCandidates(dirs, o, walk) : [];
    if (!tr0.length || wOD.s <= tr0[0].cost) return finish(null, walkOnly);
  }

  var cache = {};     // stopId -> {err, list}
  var requested = 0;
  var horizon = Math.max(1, Math.min(MAX_LOOKAHEAD_MINUTES, Math.ceil((o.arriveBy - o.now) / 60) + WINDOW_MARGIN_MINUTES));

  function pick(cands) {
    var chosen = [];
    var queued = {};
    for (var i = 0; i < cands.length && chosen.length < MAX_CANDIDATES; i++) {
      var need = candidateStops(cands[i]).filter(function (s) { return !has(cache, s) && !has(queued, s); });
      need = unique(need);
      if (requested + Object.keys(queued).length + need.length > MAX_ARRIVAL_REQUESTS) continue;
      for (var j = 0; j < need.length; j++) queued[need[j]] = true;
      chosen.push(cands[i]);
    }
    return { cands: chosen, stops: Object.keys(queued) };
  }

  function fetch(stops, done) {
    var pending = stops.length;
    if (!pending) return done();
    stops.forEach(function (stopId) {
      var called = false;
      requested++;
      function got(err, list) {
        if (called) return;
        called = true;
        cache[stopId] = { err: err || null, list: err ? [] : (list || []) };
        if (--pending === 0) done();
      }
      try { source.arrivals(stopId, 0, horizon, got); } catch (e) { got(e); }
    });
  }

  function choose(bus) {
    if (walkOnly && (!bus || walkOnly.leaveAt > bus.leaveAt)) return walkOnly;
    return bus || null;
  }

  // each phase → the best plan over its candidates (live where the data reaches arriveBy, else estimated);
  // transfers are only tried when no direct candidate gives a plan
  var d1 = pick(direct);
  fetch(d1.stops, function () {
    var failure = null, result;
    try {
      var p1 = bestPlan(d1.cands, o, cache);
      if (p1 || o.maxTransfers < 1) result = { plan: p1 };
    } catch (e) { failure = e; }
    if (failure) return finish(failure);
    if (result) return finish(null, choose(result.plan));

    var t1;
    try { t1 = pick(transferCandidates(dirs, o, walk)); } catch (e2) { return finish(e2); }
    fetch(t1.stops, function () {
      var failure2 = null, out = null;
      try { out = bestPlan(t1.cands, o, cache); } catch (e3) { failure2 = e3; }
      if (failure2) return finish(failure2);
      finish(null, choose(out));
    });
  });
}

function unique(xs) {
  var out = [], seen = {};
  for (var i = 0; i < xs.length; i++) if (!has(seen, xs[i])) { seen[xs[i]] = true; out.push(xs[i]); }
  return out;
}

function candidateStops(c) {
  var out = [];
  for (var i = 0; i < c.legs.length; i++) out.push(c.legs[i].b.id, c.legs[i].a.id);
  return out;
}

function totalWalk(c) {
  var m = c.walks[0].m + c.walks[c.walks.length - 1].m;
  if (c.walks.length > 2) m += c.walks[1].m;
  return m;
}

function byCost(a, b) { return a.cost - b.cost; }

// best boarding / alighting pair per direction (b before a in travel order), ranked by estimated door-to-door time
function directCandidates(dirs, o) {
  var out = [];
  for (var i = 0; i < dirs.length; i++) {
    var pts = dirs[i].pts;
    var board = null, boardVal = Infinity, best = null;
    for (var k = 0; k < pts.length; k++) {
      var p = pts[k];
      if (board && p.to.m <= o.maxWalk) {
        var cost = boardVal + p.cum / ESTIMATED_SPEED + p.to.s;
        if (!best || cost < best.cost) best = { cost: cost, b: board, a: p };
      }
      if (p.from.m <= o.maxWalk) {
        var v = p.from.s - p.cum / ESTIMATED_SPEED;
        if (v < boardVal) { boardVal = v; board = p; }
      }
    }
    if (best) {
      out.push({ cost: best.cost, legs: [{ d: dirs[i], b: best.b, a: best.a }], walks: [best.b.from, best.a.to] });
    }
  }
  return out.sort(byCost);
}

// best b → x (route A), walk x → y, y → a (route B ≠ A) per pair of directions, ranked like directCandidates
function transferCandidates(dirs, o, walk) {
  var out = [];
  var lat = o.transferWalk / 110000 * 1.05;
  var starts = [], ends = [];
  var i, k;
  for (i = 0; i < dirs.length; i++) {
    var pts = dirs[i].pts;
    // costs to reach stop k as the alighting stop x (board before it)
    var s = [], board = null, boardVal = Infinity;
    for (k = 0; k < pts.length; k++) {
      s.push(board ? { cost: boardVal + pts[k].cum / ESTIMATED_SPEED, b: board } : null);
      if (pts[k].from.m <= o.maxWalk) {
        var v = pts[k].from.s - pts[k].cum / ESTIMATED_SPEED;
        if (v < boardVal) { boardVal = v; board = pts[k]; }
      }
    }
    // costs from boarding at stop k as y to the destination (alight after it)
    var e = [], alight = null, alightVal = Infinity;
    for (k = pts.length - 1; k >= 0; k--) {
      e[k] = alight ? { cost: alightVal - pts[k].cum / ESTIMATED_SPEED, a: alight } : null;
      if (pts[k].to.m <= o.maxWalk) {
        var w = pts[k].cum / ESTIMATED_SPEED + pts[k].to.s;
        if (w < alightVal) { alightVal = w; alight = pts[k]; }
      }
    }
    starts.push(s);
    ends.push(e);
  }
  for (i = 0; i < dirs.length; i++) {
    for (var j = 0; j < dirs.length; j++) {
      if (dirs[i].route === dirs[j].route || String(dirs[i].route.id) === String(dirs[j].route.id)) continue;
      var best = null;
      var A = dirs[i].pts, B = dirs[j].pts;
      for (var x = 0; x < A.length; x++) {
        var sx = starts[i][x];
        if (!sx) continue;
        for (var y = 0; y < B.length; y++) {
          var ey = ends[j][y];
          if (!ey || Math.abs(A[x].lat - B[y].lat) > lat) continue;
          var wxy = walk(A[x], B[y]);
          if (wxy.m > o.transferWalk) continue;
          var cost = sx.cost + wxy.s + o.minTransfer + ey.cost;
          if (!best || cost < best.cost) {
            best = { cost: cost, legs: [{ d: dirs[i], b: sx.b, a: A[x] }, { d: dirs[j], b: B[y], a: ey.a }],
                     walks: [sx.b.from, wxy, ey.a.to] };
          }
        }
      }
      if (best) out.push(best);
    }
  }
  return out.sort(byCost);
}

// arrivals of routeId at stopId, ascending; null when the request failed / wasn't made
function arrivalsOf(cache, stopId, routeId) {
  var c = cache[stopId];
  if (!c || c.err) return null;
  var out = [];
  for (var i = 0; i < c.list.length; i++) {
    var a = c.list[i];
    if (a && String(a.routeId) === String(routeId) && typeof a.time === 'number') out.push(a);
  }
  return out.sort(function (p, q) { return p.time - q.time; });
}

// [{b: Arrival, a: Arrival}] runs of leg (same tripKey) boarding at or after minBoard
function runs(leg, cache, minBoard) {
  var rid = leg.d.route.id;
  var at = arrivalsOf(cache, leg.b.id, rid), off = arrivalsOf(cache, leg.a.id, rid);
  var out = [];
  if (!at || !off) return out;
  for (var i = 0; i < at.length; i++) {
    var b = at[i];
    if (b.time < minBoard || b.tripKey == null) continue;
    for (var j = 0; j < off.length; j++) {
      if (off[j].tripKey === b.tripKey && off[j].time > b.time) { out.push({ b: b, a: off[j] }); break; }
    }
  }
  return out;
}

// live itinerary of one candidate with the latest leave time → Plan | null
function livePlan(cand, o, cache) {
  var w = cand.walks;
  var last = w[w.length - 1];
  var first = runs(cand.legs[0], cache, o.now + w[0].s);
  var best = null;
  for (var i = 0; i < first.length; i++) {
    var times = null;
    if (cand.legs.length === 1) {
      if (first[i].a.time + last.s <= o.arriveBy) times = [first[i]];
    } else {
      // the connection that gets there first (and in time)
      var second = runs(cand.legs[1], cache, first[i].a.time + w[1].s + o.minTransfer);
      var pickRun = null;
      for (var j = 0; j < second.length; j++) {
        if (second[j].a.time + last.s > o.arriveBy) continue;
        if (!pickRun || second[j].a.time < pickRun.a.time) pickRun = second[j];
      }
      if (pickRun) times = [first[i], pickRun];
    }
    if (times && (!best || times[0].b.time > best[0].b.time)) best = times;
  }
  return best ? buildPlan(cand, best, o, false) : null;
}

// does the fetched data reach arriveBy? (the last bus leg's boarding or alighting stop lists an arrival of any
// route at or after arriveBy − final walk; a failed request never does)
function covered(cand, o, cache) {
  var w = cand.walks;
  var latest = o.arriveBy - w[w.length - 1].s;
  var leg = cand.legs[cand.legs.length - 1];
  var stops = [leg.b.id, leg.a.id];
  for (var s = 0; s < stops.length; s++) {
    var c = cache[stops[s]];
    if (!c || c.err) continue;
    for (var i = 0; i < c.list.length; i++) if (c.list[i] && c.list[i].time >= latest) return true;
  }
  return false;
}

// estimated plan (no tripKeys): ride and wait slack per leg from observations, worked back from arriveBy
function estimatedPlan(cand, o, cache) {
  var w = cand.walks;
  var times = [];
  var t = o.arriveBy - w[w.length - 1].s;
  for (var l = cand.legs.length - 1; l >= 0; l--) {
    var e = estimateLeg(cand.legs[l], cache);
    var depart = t - e.ride;
    times.unshift({ b: { time: depart, headsign: '' }, a: { time: t }, slack: e.headway });
    // before a later leg: the transfer walk and a wait of max(headway, minTransfer)
    if (l > 0) t = depart - w[l].s - Math.max(e.headway, o.minTransfer);
  }
  var p = buildPlan(cand, times, o, true);
  return p.leaveAt >= o.now ? p : null;
}

// best plan over candidates: covered → live itinerary (or none); not covered → the estimate, or a live itinerary
// that leaves later. Latest leaveAt wins; ties → less walking, then live over estimated.
function bestPlan(cands, o, cache) {
  var best = null, bestWalk = 0;
  for (var c = 0; c < cands.length; c++) {
    var cand = cands[c];
    var p = livePlan(cand, o, cache);
    if (!covered(cand, o, cache)) {
      var e = estimatedPlan(cand, o, cache);
      if (e && (!p || e.leaveAt > p.leaveAt)) p = e;
    }
    if (!p) continue;
    var walked = totalWalk(cand);
    if (!best || p.leaveAt > best.leaveAt ||
        (p.leaveAt === best.leaveAt && (walked < bestWalk || (walked === bestWalk && best.estimated && !p.estimated)))) {
      best = p;
      bestWalk = walked;
    }
  }
  return best;
}


// {ride, headway}: median observed ride for shared tripKeys (else along-route / ESTIMATED_SPEED) and
// median gap between departures at the boarding stop (else DEFAULT_HEADWAY)
function estimateLeg(leg, cache) {
  var rs = runs(leg, cache, -Infinity);
  var rides = [];
  for (var i = 0; i < rs.length; i++) rides.push(rs[i].a.time - rs[i].b.time);
  var ride = median(rides);
  if (ride == null) ride = Math.round((leg.a.cum - leg.b.cum) / ESTIMATED_SPEED);
  var at = arrivalsOf(cache, leg.b.id, leg.d.route.id) || [];
  var gaps = [];
  for (var j = 1; j < at.length; j++) if (at[j].time > at[j - 1].time) gaps.push(at[j].time - at[j - 1].time);
  var headway = median(gaps);
  return { ride: ride, headway: headway == null ? DEFAULT_HEADWAY : headway };
}

function walkLeg(w, toName) {
  var leg = { mode: 'walk', meters: Math.round(w.m), seconds: w.s };
  if (toName) leg.toName = String(toName);
  return leg;
}

// times[l] = {b: Arrival-ish at boarding, a: Arrival-ish at alighting} for each bus leg
function buildPlan(cand, times, o, estimated) {
  var legs = [];
  var w = cand.walks;
  for (var l = 0; l < cand.legs.length; l++) {
    var leg = cand.legs[l];
    if (Math.round(w[l].m) >= 1) legs.push(walkLeg(w[l], leg.b.name));
    var route = leg.d.route;
    var id = String(route.id);
    var name = has(o.routeNames, id) && o.routeNames[id] ? String(o.routeNames[id]) : String(route.shortName || id);
    var color = has(o.routeColors, id) && o.routeColors[id] ? String(o.routeColors[id]) : String(route.color || '');
    var headsign = (!estimated && times[l].b.headsign) || leg.d.dir.name || '';
    legs.push({
      mode: 'bus', routeId: id, routeName: name, color: color,
      dir: directions.label(route, leg.d.dir, leg.b.id), headsign: String(headsign),
      boardStopId: leg.b.id, boardStopName: leg.b.name, alightStopId: leg.a.id, alightStopName: leg.a.name,
      departAt: times[l].b.time, arriveAt: times[l].a.time, tripKey: estimated ? null : times[l].b.tripKey
    });
  }
  var last = w[w.length - 1];
  if (Math.round(last.m) >= 1) legs.push(walkLeg(last, o.destination.name));
  var leaveAt = times[0].b.time - w[0].s - (estimated ? times[0].slack : 0);
  return { arriveBy: o.arriveBy, leaveAt: leaveAt, arriveAt: times[times.length - 1].a.time + last.s,
           estimated: !!estimated, legs: legs };
}

// ---------------------------------------------------------------------------------------------
// text

// walking time, rounded up to whole minutes
function walkTime(s) { var m = Math.max(1, Math.ceil(s / 60)); return m < 60 ? m + ' min' : format.duration(m * 60); }

function busLegs(p) {
  var out = [];
  for (var i = 0; p && p.legs && i < p.legs.length; i++) if (p.legs[i].mode === 'bus') out.push(p.legs[i]);
  return out;
}

// multi-line notification body
function describe(p, opts) {
  opts = opts || {};
  if (!p) return 'No route found';
  var units = opts.units === 'metric' ? 'metric' : 'imperial';
  var approx = p.estimated ? '~' : '';
  function t(x) { return approx + format.clock(x, !!opts.clock24); }
  var lines = ['Leave ' + t(p.leaveAt)];
  for (var i = 0; i < p.legs.length; i++) {
    var l = p.legs[i];
    if (l.mode === 'walk') {
      lines.push('Walk ' + format.distance(l.meters, units) + (l.toName ? ' to ' + l.toName : '') + ' (' + walkTime(l.seconds) + ')');
    } else {
      var head = l.headsign && l.headsign !== l.routeName && !(directions.abbreviate(l.headsign) && directions.abbreviate(l.headsign) === l.dir && /bound\s*$/i.test(l.headsign)) ? ' to ' + l.headsign : '';
      var dirName = directions.fullName(l.dir) || l.dir;
      lines.push('Take ' + l.routeName + (dirName ? ' ' + dirName : '') + head + ' at ' + t(l.departAt) +
                 (l.boardStopName ? ' from ' + l.boardStopName : ''));
      lines.push('Get off ' + (l.alightStopName ? 'at ' + l.alightStopName + ' ' : '') + t(l.arriveAt));
    }
  }
  lines.push('Arrive ' + t(p.arriveAt) + ' (by ' + format.clock(p.arriveBy, !!opts.clock24) + ')');
  if (p.estimated) lines.push('Estimated: no live times yet');
  return lines.join('\n');
}

function truncate(s, n) { return s.length <= n ? s : s.slice(0, n - 1) + '…'; }

// one line ≤ 40 chars: 'Leave 8:12 AM · 2 at 8:16 AM' (estimated: '~' before times)
function summary(p, opts) {
  opts = opts || {};
  if (!p) return 'No route found';
  var approx = p.estimated ? '~' : '';
  function t(x) { return approx + format.clock(x, !!opts.clock24); }
  var head = 'Leave ' + t(p.leaveAt) + ' · ';
  var buses = busLegs(p);
  if (!buses.length) {
    var m = 0;
    for (var i = 0; i < p.legs.length; i++) m += p.legs[i].meters || 0;
    return truncate(head + 'walk ' + format.distance(m, opts.units === 'metric' ? 'metric' : 'imperial'), SUMMARY_MAX);
  }
  var s = head + buses[0].routeName + ' at ' + t(buses[0].departAt);
  if (buses.length > 1) {
    var more = s + ', then ' + buses[1].routeName;
    if (more.length <= SUMMARY_MAX) return more;
  }
  return truncate(s, SUMMARY_MAX);
}

module.exports = {
  plan: plan,
  describe: describe,
  summary: summary,
  ESTIMATED_SPEED: ESTIMATED_SPEED,
  MAX_ARRIVAL_REQUESTS: MAX_ARRIVAL_REQUESTS,
  DEFAULT_HEADWAY: DEFAULT_HEADWAY
};
