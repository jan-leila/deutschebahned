// Trips: navigation to a pickup stop, a drop-off stop, a saved location or a scheduled trip (CONTRACTS.md §18). The watch
// shows the steps, as legs with their steps folded out under them (nav-rows.js), in the trip view with the current one
// open (arrow, distance, time left); the phone follows the GPS, advances through the steps and re-sends what changed. A
// trip runs until it is cancelled or replaced, also while the watch shows its home screen. A scheduled trip is first
// shown as a preview (its steps, nothing followed) that the watch can start. With a routing source (routing.js) a walking
// step is replaced by its turns; without one it is a straight arrow. All I/O is injected. ES5.

var geo = require('./geo');
var format = require('./format');
var protocol = require('./protocol');
var routing = require('./routing');
var navRows = require('./nav-rows');

var POLL_MS = 5000;        // position check while navigating
var MAX_RUN = 7200;        // s: navigation ends by itself
var WALK_RADIUS = 30;      // m: a walk step is done this close to its target
var TURN_RADIUS = 20;      // m: a routing turn is passed this close
var RIDE_RADIUS = 60;      // m: a ride step is done this close to the stop you get off at
var AT_STOP = 40;          // m: riding, you are at a stop this close to it
var BOARD_GRACE = 30;      // s after the bus's departure: boarding is over
var RIDE_GRACE = 60;       // s after the planned arrival: riding is over

function isPoint(p) {
  return !!p && typeof p.lat === 'number' && typeof p.lon === 'number' && isFinite(p.lat) && isFinite(p.lon);
}

function stopCoords(data, routeId, stopId) {
  var route = data && data.routes && data.routes[routeId];
  var s = route && route.stops && route.stops[stopId];
  if (isPoint(s)) return s;
  var stops = (data && data.stops) || [];
  for (var i = 0; i < stops.length; i++) if (stops[i] && stops[i].id === stopId && isPoint(stops[i])) return stops[i];
  return null;
}

function point(p) {
  return isPoint(p) ? { lat: p.lat, lon: p.lon } : null;
}

// a route's full name ("Franklin Av / Riverside Av"), '' when unknown
function routeName(data, routeId) {
  var route = data && data.routes && data.routes[routeId];
  return route && route.longName ? String(route.longName) : '';
}

// The stops a ride passes, from fromId (null: the stop nearest `pos` before toId) to toId on one direction of the route
// (dirId first, when given) → [{id, name, lat, lon}] (stops without a position left out), or null when unknown.
function rideStops(data, routeId, dirId, fromId, toId, pos) {
  var route = data && data.routes && data.routes[routeId];
  var dirs = (route && route.directions) || [], order = [], d, k, pick = null;
  for (d = 0; d < dirs.length; d++) if (dirs[d] && String(dirs[d].id) === String(dirId)) order.push(dirs[d]);
  for (d = 0; d < dirs.length; d++) if (dirs[d] && String(dirs[d].id) !== String(dirId)) order.push(dirs[d]);
  // fromId: the first direction serving both in that order; else the direction whose stop nearest you comes first
  for (d = 0; d < order.length && !(pick && fromId !== null); d++) {
    var ids = order[d].stopIds || [], t = ids.indexOf(toId);
    if (t <= 0) continue;
    if (fromId !== null) {
      var f = ids.indexOf(fromId);
      if (f >= 0 && f < t) pick = { ids: ids, f: f, t: t };
    } else if (isPoint(pos)) {
      for (k = 0; k < t; k++) {
        var s = stopCoords(data, routeId, ids[k]), m = s ? geo.distance(pos, s) : Infinity;
        if (m < Infinity && (!pick || m < pick.m)) pick = { ids: ids, f: k, t: t, m: m };
      }
    }
  }
  if (!pick) return null;
  var out = [];
  for (k = pick.f; k <= pick.t; k++) {
    var c = stopCoords(data, routeId, pick.ids[k]);
    if (c) out.push({ id: pick.ids[k], name: c.name || '', lat: c.lat, lon: c.lon });
  }
  return out.length >= 2 ? out : null;
}

// How far along its stops a ride is: the last stop passed (or the one you are at), never going back.
function rideProgress(step, pos) {
  var stops = step.stops, at = step.at || 0, best = -1, bestM = Infinity;
  for (var k = at; k < stops.length; k++) {
    var m = geo.distance(pos, stops[k]);
    if (m < bestM) { bestM = m; best = k; }
  }
  if (best < 0) return at;
  // nearest stop not reached yet when you are still closer to the one before it than that one is
  if (bestM > AT_STOP && best > at && geo.distance(pos, stops[best - 1]) < geo.distance(stops[best - 1], stops[best])) best--;
  return Math.max(at, best);
}

// ctx = {data, now, clock24, plan (Plan|null), destination (config destination|null)}
// → [{type: 'walk'|'board'|'ride'|'wait'|'arrive'|'info', text, to: {lat, lon}|null, color, leg, ...}]; a ride step
// has `stops` (the stops it passes, see rideStops) when they are known. Steps of one leg (board + ride) share `leg`.
// The last step is terminal (never done by itself): you stay on it until you leave the screen.
function buildSteps(item, ctx) {
  return withLegs(stepsOf(item, ctx));
}

function withLegs(steps) {
  for (var i = 0, leg = 0; i < steps.length; i++) {
    if (i > 0 && !(steps[i].type === 'ride' && steps[i - 1].type === 'board')) leg++;
    steps[i].leg = leg;
  }
  return steps;
}

function stepsOf(item, ctx) {
  var steps = [], to;
  if (item.kind === 'pickup') {
    to = stopCoords(ctx.data, item.routeId, item.stopId);
    if (!to) return [{ type: 'info', text: 'No location for ' + item.title, to: null, color: item.color }];
    steps.push({ type: 'walk', text: 'Walk to ' + item.title, toName: item.title, to: point(to), color: item.color });
    steps.push({ type: 'wait', text: 'Wait for the ' + item.badge, to: point(to), color: item.color, times: item.times || [] });
    return steps;
  }
  if (item.kind === 'place') {
    to = point(item);
    if (!to) return [{ type: 'info', text: 'No location for ' + item.title, to: null, color: item.color }];
    steps.push({ type: 'walk', text: 'Walk to ' + item.title, toName: item.title, to: to, color: item.color });
    steps.push({ type: 'arrive', text: 'Arrive at ' + item.title, to: to, color: item.color });
    return steps;
  }
  if (item.kind === 'dropoff') {
    to = stopCoords(ctx.data, item.routeId, item.stopId);
    if (!to) return [{ type: 'info', text: 'No location for ' + item.title, to: null, color: item.color }];
    // its stops: from the one nearest you once your position is known (see update)
    steps.push({ type: 'ride', text: 'Ride to ' + item.title, toName: item.title, to: point(to), color: item.color, radius: RIDE_RADIUS,
                 routeId: item.routeId, alightStopId: item.stopId, stops: undefined, dir: item.dir || '',
                 badge: item.badge || '', route: item.routeLongName || routeName(ctx.data, item.routeId) });
    steps.push({ type: 'arrive', text: 'Get off here', to: point(to), color: item.color });
    return steps;
  }
  // a trip tile: every remaining leg of its plan
  var plan = ctx.plan, legs = (plan && plan.legs) || [], first = 0, i;
  if (!legs.length) return [{ type: 'info', text: 'No trip plan', to: null, color: item.color }];
  for (i = 0; i < legs.length; i++) {
    if (legs[i].mode === 'bus' && legs[i].arriveAt + RIDE_GRACE < ctx.now) first = i + 1;
  }
  var dest = ctx.destination, destPoint = point(dest);
  for (i = first; i < legs.length; i++) {
    var leg = legs[i];
    if (leg.mode === 'walk') {
      var next = legs[i + 1], target = next && next.mode === 'bus' ? stopCoords(ctx.data, next.routeId, next.boardStopId) : destPoint;
      if (!target) continue;
      var walkTo = leg.toName || (dest && dest.name) || 'the stop';
      steps.push({ type: 'walk', text: 'Walk to ' + walkTo, toName: walkTo, to: point(target),
                   color: next && next.color ? next.color : item.color,
                   note: next && next.mode === 'bus' ? next.routeName + ' at ' + format.clock(next.departAt, ctx.clock24) : '' });
    } else if (leg.mode === 'bus') {
      var board = stopCoords(ctx.data, leg.routeId, leg.boardStopId), alight = stopCoords(ctx.data, leg.routeId, leg.alightStopId);
      var route = routeName(ctx.data, leg.routeId) || (leg.headsign ? 'to ' + leg.headsign : '');
      steps.push({ type: 'board', text: 'Board ' + leg.routeName + (leg.dir ? ' ' + leg.dir : ''), to: point(board),
                   color: leg.color, dir: leg.dir || '', departAt: leg.departAt, stopName: leg.boardStopName,
                   badge: leg.routeName || '', route: route });
      steps.push({ type: 'ride', text: 'Ride to ' + (leg.alightStopName || leg.alightStopId), toName: leg.alightStopName || '',
                   to: point(alight), color: leg.color, dir: leg.dir || '', arriveAt: leg.arriveAt, radius: RIDE_RADIUS,
                   badge: leg.routeName || '', route: route,
                   stops: rideStops(ctx.data, leg.routeId, leg.dirId, leg.boardStopId, leg.alightStopId, null) });
    }
  }
  if (dest) steps.push({ type: 'arrive', text: 'Arrive at ' + dest.name, to: destPoint, color: item.color });
  return steps.length ? steps : [{ type: 'info', text: 'No steps left', to: null, color: item.color }];
}

function stepDone(step, pos, now) {
  var d = step.to ? geo.distance(pos, step.to) : Infinity;
  if (step.type === 'walk') return d <= WALK_RADIUS;
  if (step.type === 'turn') return d <= (step.radius || TURN_RADIUS);
  if (step.type === 'board') return now >= step.departAt + BOARD_GRACE;
  if (step.type === 'ride') return d <= (step.radius || RIDE_RADIUS) || (step.arriveAt && now >= step.arriveAt + RIDE_GRACE);
  return false;
}

function relative(t, now) {
  return format.duration(t - now);
}

function isTerminal(step) {
  return step.type === 'wait' || step.type === 'arrive' || step.type === 'info';
}

// travel direction of a step as the watch's direction code: 'NB' 'EB' 'SB' 'WB'
function cardinal(bearing) {
  return ['NB', 'EB', 'SB', 'WB'][Math.floor(((bearing + 45) % 360) / 90)];
}

// Fills what a step shows while it is not the current one: its length and direction from the previous point, and its
// detail line. prev = where the step starts (the user's position for the first step), null when unknown.
function describeStep(step, prev, o) {
  if (step.to && prev && !isTerminal(step)) {
    step.meters = geo.distance(prev, step.to);
    if (step.meters >= 10) step.dir = step.dir || cardinal(geo.bearing(prev, step.to));
  }
  var sub = '';
  if (step.type === 'walk') {
    sub = (typeof step.meters === 'number' ? format.walk(format.walkSeconds(step.meters, o.walkSpeed)) + ' walk' : '') +
          (step.note ? (typeof step.meters === 'number' ? ' · ' : '') + step.note : '');
  } else if (step.type === 'board') {
    sub = (step.stopName ? step.stopName + ' · ' : '') + format.clock(step.departAt, o.clock24);
  } else if (step.type === 'ride' && step.arriveAt) {
    sub = 'Arrive ' + format.clock(step.arriveAt, o.clock24);
  }
  step.sub = sub;
}

// createNav(deps): deps = {send(messages), locate(cb), clock(), getList() → the session's last list
// ({listId, items, data}), getPlaces() → the saved locations as last sent ({listId, items}), getConfig(), getUnits() → 'metric'|'imperial', getPlan(destId) → Plan|null,
// route? (routing.createFetcher), setInterval?, clearInterval?, log?}
function createNav(deps) {
  var log = deps.log || function () {};
  var setIv = deps.setInterval || setInterval, clearIv = deps.clearInterval || clearInterval;
  // {steps, i, item, data, timer, startedAt, locating, listKey, liveKey, described, rows (as last sent), pos (last fix),
  //  preview, startAt (a preview's first time), title, show (open the trip view with the next live message),
  //  open / expand (legs opened / closed and fully shown on the watch, see nav-rows), legAt (the leg you are on)}
  var active = null;

  function send(messages) {
    try {
      deps.send(messages);
    } catch (e) {
      log('nav send failed: ' + (e && e.message || e));
    }
  }

  function walkSpeed() {
    var c = deps.getConfig();
    var s = c && c.schedule && c.schedule.walkSpeed;
    return typeof s === 'number' && s > 0 ? s : 1.3;
  }

  function wantRoute(step) {
    var c = deps.getConfig();
    return typeof deps.route === 'function' && c && routing.usable(c.routingUrl) && step.type === 'walk' && step.to;
  }

  function describeAll(a, pos) {
    var o = { walkSpeed: walkSpeed(), clock24: deps.getConfig().clock24 }, prev = pos;
    for (var i = a.i; i < a.steps.length; i++) {
      describeStep(a.steps[i], prev, o);
      if (a.steps[i].to) prev = a.steps[i].to;
    }
  }

  // A walking step becomes its turns (the routing source's waypoints), all of them: the watch shows the ones around
  // you (nav-rows.js); the walk itself stays on each turn as `walk` (its leg's header).
  function expand(a, step, points) {
    var at = a.steps.indexOf(step);
    if (at < 0 || !points.length) return;
    var turns = [], walk = { text: step.text, note: step.note, color: step.color, toName: step.toName };
    for (var j = 0; j < points.length; j++) {
      turns.push({ type: 'turn', text: points[j].text || (j === points.length - 1 ? step.text : 'Continue'), to: { lat: points[j].lat, lon: points[j].lon },
                   color: step.color, radius: j === points.length - 1 ? WALK_RADIUS : TURN_RADIUS,
                   note: j === points.length - 1 ? step.note : '', leg: step.leg, walk: walk });
    }
    a.steps.splice.apply(a.steps, [at, 1].concat(turns));
    a.described = false;
  }

  // the waypoints of the step's walk, fetched once when the step starts
  function fetchRoute(a, step, pos) {
    step.routed = true;
    deps.route(deps.getConfig().routingUrl, pos, step.to, function (err, points) {
      if (err) return log('routing failed: ' + (err.message || err));
      if (!active || active !== a || a.steps.indexOf(step) !== a.i) return;
      expand(a, step, points);
    });
  }

  function liveSub(step, toStep, now) {
    var t;
    if (step.type === 'walk' || step.type === 'turn') {
      return toStep === null ? '' : format.walk(format.walkSeconds(toStep, walkSpeed())) + ' left';
    }
    if (step.type === 'board') return 'Departs ' + relative(step.departAt, now);
    if (step.type === 'ride') return step.arriveAt ? 'Arrive ' + relative(step.arriveAt, now) : '';
    if (step.type === 'wait') {
      for (var k = 0; k < step.times.length; k++) if (step.times[k] && step.times[k] >= now - 30) { t = step.times[k]; break; }
      return t ? 'Next ' + relative(t, now) : 'No times';
    }
    return '';
  }

  // pos: the latest fix (null: none yet, a preview only)
  function update(pos) {
    var a = active, now = deps.clock();
    if (!a) return;
    if (pos) a.pos = pos;
    if (!a.preview) {
      if (now - a.startedAt > MAX_RUN) return stop();
      while (a.i < a.steps.length - 1 && stepDone(a.steps[a.i], pos, now)) a.i++;
    }
    var step = a.steps[a.i], units = deps.getUnits(), k;
    if (!a.preview && !step.routed && wantRoute(step)) fetchRoute(a, step, pos);
    // a drop-off's ride starts where you are: its stops are known with the first position
    for (k = a.i; pos && k < a.steps.length; k++) {
      var st = a.steps[k];
      if (st.type === 'ride' && st.stops === undefined) st.stops = rideStops(a.data, st.routeId, null, null, st.alightStopId, pos);
    }
    if (!a.preview && step.type === 'ride' && step.stops) step.at = rideProgress(step, pos);
    if (!a.described || (pos && !a.describedAt)) {   // (a preview is described before it has a position)
      describeAll(a, pos);
      a.described = true;
      a.describedAt = !!pos;
    }
    var dist = !a.preview && pos && step.to ? geo.distance(pos, step.to) : null;
    var built = navRows.build(a.steps, a.i, { walkSpeed: walkSpeed(), clock24: deps.getConfig().clock24, now: now,
                                              live: dist, start: a.preview ? a.startAt : undefined, preview: a.preview,
                                              open: a.open, expand: a.expand });
    // a new leg: it opens (whatever was done to it on the watch before)
    var leg = -1;
    for (k = 0; k < built.legs.length; k++) if (a.i >= built.legs[k].from && a.i <= built.legs[k].to) leg = k;
    if (!a.preview && leg !== a.legAt) {
      var had = a.legAt !== undefined;
      a.legAt = leg;
      if (had && (a.open.hasOwnProperty(leg) || a.expand.hasOwnProperty(leg))) {
        delete a.open[leg];
        delete a.expand[leg];
        return update(pos);
      }
    }
    var msgs = [];
    var listKey = units + JSON.stringify(built.rows) + ':' + built.head + ':' + built.headEnd;
    if (listKey !== a.listKey) {
      a.listKey = listKey;
      a.rows = built.rows;
      msgs = msgs.concat(protocol.encodeNavList(built.rows, units, built.current, built.head, built.headEnd));
      a.liveKey = '';
    }
    var live = { state: a.preview ? 'preview' : isTerminal(step) ? 'arrived' : 'guiding', current: built.current,
                 sub: a.preview ? '' : liveSub(step, dist, now), distance: dist,
                 bearing: !a.preview && pos && step.to ? geo.bearing(pos, step.to) : null, units: units,
                 title: a.title, show: a.show };
    var encoded = protocol.encodeNavLive(live);
    live.show = false;   // (opening the view is no change of its own)
    var key = JSON.stringify(protocol.encodeNavLive(live));
    if (encoded.NAV_BEARING >= 0) key = key.replace(/"NAV_BEARING":\d+/, '"NAV_BEARING":' + Math.round(encoded.NAV_BEARING / 5));
    if (key !== a.liveKey) {
      a.liveKey = key;
      a.show = false;
      msgs.push(encoded);
    }
    if (msgs.length) send(msgs);
  }

  function poll() {
    var a = active;
    if (!a || a.locating) return;
    a.locating = true;
    deps.locate(function (err, pos) {
      if (a !== active) return;
      a.locating = false;
      if (err || !pos) return log('nav locate failed: ' + (err && err.message || err));
      update(pos);
    });
  }

  function stop(silent) {
    if (!active) return;
    if (active.timer !== null) clearIv(active.timer);
    active = null;
    if (!silent) send([protocol.encodeNavLive(null)]);
  }

  // listId / index: the watch's selection (index -1 = nothing selected); places: it is in the saved locations' list.
  // Starts a trip there, replacing the one running.
  function start(listId, index, places) {
    var list = places ? (typeof deps.getPlaces === 'function' ? deps.getPlaces() : null) : deps.getList();
    if (!list || list.listId !== listId || typeof index !== 'number' || index < 0 || index >= list.items.length) {
      log('nav: nothing to navigate to');
      return false;
    }
    stop(true);
    return begin(list.items[index], list.data, {});
  }

  // item: a tile (as in a list) to navigate to; data: the planner Data its stop coordinates come from
  function startItem(item, data) {
    if (!item) return false;
    stop(true);
    return begin(item, data, {});
  }

  // A scheduled trip's steps for the watch to look at (and start: go), from its stored plan; no plan → one row saying
  // `empty`. Replaces a preview, never a trip that is running (false).
  function preview(destinationId, title, empty) {
    if (active && !active.preview) return false;
    stop(true);
    var list = deps.getList();
    return begin({ kind: 'trip', destinationId: destinationId, color: '' }, list ? list.data : null,
                 { preview: true, title: title, empty: empty });
  }

  // the watch's "start trip" on a preview: follow it from now
  function go() {
    var a = active;
    if (!a || !a.preview) return false;
    a.preview = false;
    a.title = '';
    a.startedAt = deps.clock();
    a.open = {};
    a.expand = {};
    a.listKey = '';
    a.timer = setIv(poll, POLL_MS);
    if (a.pos) update(a.pos);
    poll();
    return true;
  }

  function begin(item, data, opts) {
    var cfg = deps.getConfig(), now = deps.clock();
    var dest = null, plan = null, i;
    if (item.kind === 'trip') {
      plan = deps.getPlan(item.destinationId);
      for (i = 0; i < (cfg.destinations || []).length; i++) if (cfg.destinations[i].id === item.destinationId) dest = cfg.destinations[i];
    }
    var steps = !plan && opts.empty ? [{ type: 'info', text: opts.empty, to: null, color: '', leg: 0 }]
      : buildSteps(item, { data: data, now: now, clock24: cfg.clock24, plan: plan, destination: dest });
    active = { steps: steps, i: 0, item: item, data: data, startedAt: now, locating: false, listKey: '', liveKey: '',
               described: false, timer: null, rows: null, pos: null, preview: !!opts.preview,
               startAt: plan && typeof plan.leaveAt === 'number' ? Math.max(now, plan.leaveAt) : now,
               title: opts.title || '', show: true, open: {}, expand: {} };
    if (active.preview) update(null);   // shown at once; a fix (once) adds the first walk's length
    else active.timer = setIv(poll, POLL_MS);
    poll();
    return true;
  }

  // the watch scrolled to a row it does not have: the window of rows around it
  function fetch(index) {
    if (!active || !active.rows || typeof index !== 'number' || !isFinite(index)) return;
    send(protocol.encodeNavRows(active.rows, deps.getUnits(), index));
  }

  // a long SELECT on a row: a leg's header opens / closes that leg, a run of hidden rows shows every row of its leg
  function unfold(index) {
    var a = active, row = a && a.rows && a.rows[index];
    if (!row || typeof index !== 'number') return false;
    if (row.type === 'head') {
      a.open[row.leg] = !row.open;
      if (row.open) delete a.expand[row.leg];
    } else if (row.fold) {
      a.open[row.leg] = true;
      a.expand[row.leg] = true;
    } else {
      return false;
    }
    if (a.pos || a.preview) update(a.pos);
    return true;
  }

  return {
    start: start, startItem: startItem, preview: preview, go: go, stop: stop, fetch: fetch, unfold: unfold,
    active: function () { return !!active; },
    guiding: function () { return !!active && !active.preview; }
  };
}

module.exports = { createNav: createNav, buildSteps: buildSteps, stepDone: stepDone, rideStops: rideStops, POLL_MS: POLL_MS };
