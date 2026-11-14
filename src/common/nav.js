// Navigation to a pickup stop, a drop-off stop or a scheduled trip (CONTRACTS.md §18). The watch shows an arrow, a
// distance and one line of instruction; the phone follows the GPS, advances through the steps and re-sends the guidance
// when it changes. With a routing source (routing.js) walking steps get waypoints; without one they are straight arrows.
// All I/O is injected. ES5.

var geo = require('./geo');
var format = require('./format');
var protocol = require('./protocol');
var routing = require('./routing');

var POLL_MS = 5000;        // position check while navigating
var MAX_RUN = 7200;        // s: navigation ends by itself
var WALK_RADIUS = 30;      // m: a walk step is done this close to its target
var WAY_RADIUS = 20;       // m: a routing waypoint is passed this close
var RIDE_RADIUS = 60;      // m: a ride step is done this close to the stop you get off at
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

// ctx = {data, now, clock24, plan (Plan|null), destination (config destination|null)}
// → [{type: 'walk'|'board'|'ride'|'wait'|'arrive'|'info', text, to: {lat, lon}|null, color, ...}]
// The last step is terminal (never done by itself): you stay on it until you leave the screen.
function buildSteps(item, ctx) {
  var steps = [], to;
  if (item.kind === 'pickup') {
    to = stopCoords(ctx.data, item.routeId, item.stopId);
    if (!to) return [{ type: 'info', text: 'No location for ' + item.title, to: null, color: item.color }];
    steps.push({ type: 'walk', text: 'Walk to ' + item.title, to: point(to), color: item.color });
    steps.push({ type: 'wait', text: 'Wait for the ' + item.badge, to: point(to), color: item.color, times: item.times || [] });
    return steps;
  }
  if (item.kind === 'dropoff') {
    to = stopCoords(ctx.data, item.routeId, item.stopId);
    if (!to) return [{ type: 'info', text: 'No location for ' + item.title, to: null, color: item.color }];
    steps.push({ type: 'ride', text: 'Ride to ' + item.title, to: point(to), color: item.color, radius: RIDE_RADIUS });
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
      steps.push({ type: 'walk', text: 'Walk to ' + (leg.toName || (dest && dest.name) || 'the stop'), to: point(target),
                   color: next && next.color ? next.color : item.color,
                   note: next && next.mode === 'bus' ? next.routeName + ' at ' + format.clock(next.departAt, ctx.clock24) : '' });
    } else if (leg.mode === 'bus') {
      var board = stopCoords(ctx.data, leg.routeId, leg.boardStopId), alight = stopCoords(ctx.data, leg.routeId, leg.alightStopId);
      steps.push({ type: 'board', text: 'Board ' + leg.routeName + (leg.dir ? ' ' + leg.dir : ''), to: point(board),
                   color: leg.color, departAt: leg.departAt, stopName: leg.boardStopName });
      steps.push({ type: 'ride', text: 'Ride to ' + (leg.alightStopName || leg.alightStopId), to: point(alight), color: leg.color,
                   arriveAt: leg.arriveAt, radius: RIDE_RADIUS });
    }
  }
  if (dest) steps.push({ type: 'arrive', text: 'Arrive at ' + dest.name, to: destPoint, color: item.color });
  else if (steps.length) steps[steps.length - 1].terminal = true;
  return steps.length ? steps : [{ type: 'info', text: 'No steps left', to: null, color: item.color }];
}

function stepDone(step, pos, now) {
  var d = step.to ? geo.distance(pos, step.to) : Infinity;
  if (step.type === 'walk') return d <= WALK_RADIUS;
  if (step.type === 'board') return now >= step.departAt + BOARD_GRACE;
  if (step.type === 'ride') return d <= (step.radius || RIDE_RADIUS) || (step.arriveAt && now >= step.arriveAt + RIDE_GRACE);
  return false;
}

function relative(t, now) {
  return format.duration(t - now);
}

// createNav(deps): deps = {send(messages), locate(cb), clock(), getList() → the session's last list
// ({listId, items, data}), getConfig(), getUnits() → 'metric'|'imperial', getPlan(destId) → Plan|null,
// route? (routing.createFetcher), setInterval?, clearInterval?, log?}
function createNav(deps) {
  var log = deps.log || function () {};
  var setIv = deps.setInterval || setInterval, clearIv = deps.clearInterval || clearInterval;
  var active = null;   // {steps, i, item, timer, startedAt, locating, sentKey}

  function send(state) {
    try {
      deps.send([protocol.encodeNav(state)]);
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

  // the waypoints of the step's walk, fetched once when the step starts
  function fetchRoute(a, step, pos) {
    step.routed = true;
    deps.route(deps.getConfig().routingUrl, pos, step.to, function (err, points) {
      if (err) return log('routing failed: ' + (err.message || err));
      if (!active || active !== a || a.steps[a.i] !== step) return;
      step.way = points;
      step.wi = 0;
    });
  }

  function update(pos) {
    var a = active, now = deps.clock();
    if (!a) return;
    if (now - a.startedAt > MAX_RUN) return stop();
    while (a.i < a.steps.length - 1 && stepDone(a.steps[a.i], pos, now)) a.i++;
    var step = a.steps[a.i];
    if (!step.routed && wantRoute(step)) fetchRoute(a, step, pos);
    // the point the arrow aims at: the next routing waypoint of a walk, else the step's target
    var aim = step.to, text = step.text;
    if (step.way) {
      while (step.wi < step.way.length - 1 && geo.distance(pos, step.way[step.wi]) <= WAY_RADIUS) step.wi++;
      aim = step.way[step.wi];
      if (step.way[step.wi].text) text = step.way[step.wi].text;
    }
    var dist = aim ? geo.distance(pos, aim) : null;
    var toStep = step.to ? geo.distance(pos, step.to) : null;
    var sub = '', t;
    if (step.type === 'walk') {
      sub = toStep === null ? '' : format.walk(format.walkSeconds(toStep, walkSpeed())) + ' walk';
      if (step.note) sub += ' · ' + step.note;
    } else if (step.type === 'board') {
      sub = (step.stopName ? step.stopName + ' · ' : '') + format.clock(step.departAt, deps.getConfig().clock24) +
            ' · ' + relative(step.departAt, now);
    } else if (step.type === 'ride') {
      sub = step.arriveAt ? 'Arrive ' + format.clock(step.arriveAt, deps.getConfig().clock24) + ' · ' + relative(step.arriveAt, now) : '';
    } else if (step.type === 'wait') {
      for (var k = 0; k < step.times.length; k++) if (step.times[k] && step.times[k] >= now - 30) { t = step.times[k]; break; }
      sub = t ? 'Next ' + relative(t, now) : 'No times';
    }
    var terminal = step.type === 'wait' || step.type === 'arrive' || step.type === 'info';
    var msg = { state: terminal ? 2 : 1, text: text, sub: sub, distance: dist, bearing: aim ? geo.bearing(pos, aim) : null,
                color: step.color, units: deps.getUnits() };
    var encoded = protocol.encodeNav(msg), key = JSON.stringify(encoded);
    if (encoded.NAV_BEARING >= 0) key = key.replace(/"NAV_BEARING":\d+/, '"NAV_BEARING":' + Math.round(encoded.NAV_BEARING / 5));
    if (key === a.sentKey) return;
    a.sentKey = key;
    send(msg);
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
    if (!silent) send(null);
  }

  // listId / index: the watch's selection (index -1 = nothing selected)
  function start(listId, index) {
    stop(true);
    var list = deps.getList();
    if (!list || list.listId !== listId || typeof index !== 'number' || index < 0 || index >= list.items.length) {
      log('nav: nothing to navigate to');
      return false;
    }
    var item = list.items[index], cfg = deps.getConfig(), now = deps.clock();
    var dest = null, plan = null, i;
    if (item.kind === 'trip') {
      plan = deps.getPlan(item.destinationId);
      for (i = 0; i < (cfg.destinations || []).length; i++) if (cfg.destinations[i].id === item.destinationId) dest = cfg.destinations[i];
    }
    var steps = buildSteps(item, { data: list.data, now: now, clock24: cfg.clock24, plan: plan, destination: dest });
    active = { steps: steps, i: 0, item: item, startedAt: now, locating: false, sentKey: '', timer: null };
    active.timer = setIv(poll, POLL_MS);
    poll();
    return true;
  }

  return { start: start, stop: stop, active: function () { return !!active; } };
}

module.exports = { createNav: createNav, buildSteps: buildSteps, stepDone: stepDone, POLL_MS: POLL_MS };
