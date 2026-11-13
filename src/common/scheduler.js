// Destinations -> trip plans -> wakeup triggers -> notifications (CONTRACTS.md section 15).
// Every collaborator and all I/O is injected; the router and trigger logic default to the real
// modules, resolved lazily so tests and partial builds can inject fakes. ES5.

var format = require('./format');
var view = require('./view');

var STORAGE_KEYS = { plans: 'busWatch.plans', handled: 'busWatch.handled' };
var MAX_HANDLED = 100;
var NO_ROUTE = 'No route found';

function isPlainObject(v) { return v !== null && typeof v === 'object' && !(v instanceof Array); }

function errorText(err) {
  if (!err) return 'unknown';
  if (typeof err === 'string') return err;
  return err.message || String(err);
}

// fn(cb) where cb must fire once; protects against sync throws and double callbacks
function once(cb) {
  var done = false;
  return function () {
    if (done) return;
    done = true;
    cb.apply(null, arguments);
  };
}

var REFRESH_ACTIVE = 120;   // seconds between live re-plans of a trip in progress

function createScheduler(deps) {
  var storage = deps.storage;
  var clock = deps.clock;
  var log = deps.log || function () {};
  var router = deps.router || null;
  var triggers = deps.triggers || null;
  function getRouter() { return router || (router = require('./router.js')); }
  function getTriggers() { return triggers || (triggers = require('./triggers.js')); }

  var plans = {};       // destId -> {occurrence, plan, summary, plannedAt}
  var handled = [];     // trigger ids already notified, oldest first
  var running = false;
  var routeCache = {};
  var cacheSource = null;

  function readJson(key) {
    var raw;
    try { raw = storage.getItem(key); } catch (e) { return undefined; }
    if (raw === null || raw === undefined || raw === '') return undefined;
    try { return JSON.parse(raw); } catch (e) { log('bad JSON in ' + key); return undefined; }
  }

  function writeJson(key, value) {
    try { storage.setItem(key, JSON.stringify(value)); } catch (e) { log('could not save ' + key + ': ' + errorText(e)); }
  }

  function savePlans() { writeJson(STORAGE_KEYS.plans, plans); }
  function saveHandled() { writeJson(STORAGE_KEYS.handled, handled); }

  function load() {
    var p = readJson(STORAGE_KEYS.plans);
    plans = {};
    if (isPlainObject(p)) {
      for (var k in p) {
        if (p.hasOwnProperty(k) && isPlainObject(p[k]) && typeof p[k].occurrence === 'number') plans[k] = p[k];
      }
    }
    var h = readJson(STORAGE_KEYS.handled);
    handled = [];
    if (h instanceof Array) for (var i = 0; i < h.length; i++) if (typeof h[i] === 'string') handled.push(h[i]);
    if (handled.length > MAX_HANDLED) handled = handled.slice(handled.length - MAX_HANDLED);
  }

  function config() { return deps.getConfig(); }

  function enabledDestinations(cfg) {
    var out = [];
    var list = cfg && cfg.destinations instanceof Array ? cfg.destinations : [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].enabled !== false) out.push(list[i]);
    return out;
  }

  function findDestination(cfg, id) {
    var list = enabledDestinations(cfg);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function locate(cfg, cb) {
    cb = once(cb);
    if (cfg.location && cfg.location.mode === 'fixed') {
      var p = { lat: cfg.location.lat, lon: cfg.location.lon };
      setTimeout(function () { cb(null, p); }, 0);
      return;
    }
    try {
      deps.locate(function (err, pos) {
        if (!err && (!pos || typeof pos.lat !== 'number' || typeof pos.lon !== 'number')) err = new Error('no position');
        cb(err || null, err ? null : pos);
      });
    } catch (e) {
      cb(e, null);
    }
  }

  function getSource() {
    var src = deps.getSource();
    if (src !== cacheSource) {
      cacheSource = src;
      routeCache = {};
    }
    return src;
  }

  // cfg is a runtime view (view.build): only routes of systems that cover the origin or the destination are used
  function buildRequest(cfg, dest, origin, occurrence, now) {
    var ids = [], seen = {}, names = {}, colors = {};
    var routes = cfg.routes || [], conns = cfg.connections || [];
    var areas = cfg.coverage || {};
    function near(pid) {
      if (pid === undefined || !areas.hasOwnProperty(pid)) return true;
      return view.inArea(areas[pid], origin) || view.inArea(areas[pid], dest);
    }
    function add(id) { if (id && !seen.hasOwnProperty(id)) { seen[id] = true; ids.push(id); } }
    for (var i = 0; i < routes.length; i++) {
      if (!near(routes[i].providerId)) continue;
      add(routes[i].id);
      if (routes[i].name) names[routes[i].id] = routes[i].name;
      if (routes[i].color) colors[routes[i].id] = routes[i].color;
    }
    // a view's connections only pair saved routes; a plain config's may name other routes
    if (!cfg.coverage) for (var j = 0; j < conns.length; j++) add(conns[j].routeId);
    var s = cfg.schedule || {};
    return {
      origin: { lat: origin.lat, lon: origin.lon },
      destination: { lat: dest.lat, lon: dest.lon, name: dest.name },
      arriveBy: occurrence, now: now,
      routeIds: ids, routeNames: names, routeColors: colors,
      walkSpeed: s.walkSpeed, maxWalk: s.maxWalk, transferWalk: s.transferWalk,
      maxTransfers: s.maxTransfers, minTransfer: s.minTransfer,
      routeCache: routeCache
    };
  }

  function textOpts(cfg) { return { units: cfg.units, clock24: !!cfg.clock24 }; }

  function summaryOf(cfg, plan) {
    if (!plan) return NO_ROUTE;
    try { return getRouter().summary(plan, textOpts(cfg)); } catch (e) { log('summary failed: ' + errorText(e)); return ''; }
  }

  // cb(err, plan|null) for one destination; origin null = location unknown
  function planOne(cfg, dest, origin, occurrence, now, cb) {
    cb = once(cb);
    if (!origin) return cb(new Error('no position'), null);
    try {
      var src = getSource();
      getRouter().plan(src, buildRequest(cfg, dest, origin, occurrence, now), function (err, plan) {
        cb(err || null, err ? null : (plan || null));
      });
    } catch (e) {
      cb(e, null);
    }
  }

  function store(cfg, destId, occurrence, plan, now) {
    plans[destId] = { occurrence: occurrence, plan: plan, summary: summaryOf(cfg, plan), plannedAt: now };
  }

  function dropRemoved(cfg) {
    var keep = {};
    var list = enabledDestinations(cfg);
    for (var i = 0; i < list.length; i++) keep[list[i].id] = true;
    for (var k in plans) if (plans.hasOwnProperty(k) && !keep.hasOwnProperty(k)) delete plans[k];
  }

  // plan every destination in list (sequentially) for its next occurrence after now
  function planAll(cfg, list, origin, now, done) {
    var i = 0;
    function next() {
      if (i >= list.length) return done();
      var dest = list[i++];
      var occ = getTriggers().nextOccurrence(dest, now);
      if (occ === null) {
        delete plans[dest.id];
        return next();
      }
      planOne(cfg, dest, origin, occ, now, function (err, plan) {
        if (err) log('plan for ' + dest.id + ' failed: ' + errorText(err));
        store(cfg, dest.id, occ, plan, now);
        next();
      });
    }
    next();
  }

  function reschedule() {
    var cfg = config();
    var now = clock();
    var t = getTriggers();
    var all = t.build(cfg.destinations || [], plans, now, cfg.schedule || {});
    var done = {}, pending = [];
    for (var i = 0; i < handled.length; i++) done[handled[i]] = true;
    for (var j = 0; j < all.length; j++) if (!done.hasOwnProperty(all[j].id)) pending.push(all[j]);
    var wakeups = t.toWakeups(pending, now);   // handled triggers whose time moved need no wakeup
    try { deps.sendWakeups(wakeups); } catch (e) { log('sendWakeups failed: ' + errorText(e)); }
    return wakeups;
  }

  function finisher(cb) {
    cb = once(cb || function () {});
    return function (err, value) {
      running = false;
      cb(err || null, value);
    };
  }

  // Locate failures are not reported as errors: the plans are stored with plan: null (fallback trigger).
  function replan(cb) {
    if (running) { if (cb) cb(null, null); return; }
    running = true;
    var finish = finisher(cb);
    try {
      var cfg = config();
      locate(cfg, function (err, pos) {
        if (err) log('locate failed: ' + errorText(err));
        try {
          var now = clock();
          dropRemoved(cfg);
          planAll(cfg, enabledDestinations(cfg), pos, now, function () {
            try {
              savePlans();
              reschedule();
            } catch (e) { return finish(e); }
            finish(null, plans);
          });
        } catch (e) { finish(e); }
      });
    } catch (e) { finish(e); }
  }

  function firstBusColor(plan) {
    var legs = plan && plan.legs instanceof Array ? plan.legs : [];
    for (var i = 0; i < legs.length; i++) if (legs[i] && legs[i].mode === 'bus') return legs[i].color || '';
    return '';
  }

  function notification(cfg, dest, trigger, plan) {
    var c24 = !!cfg.clock24;
    if (!plan) {
      return { title: dest.name, body: 'No route found to arrive by ' + format.clock(trigger.occurrence, c24), color: '' };
    }
    var body;
    try { body = getRouter().describe(plan, textOpts(cfg)); } catch (e) { log('describe failed: ' + errorText(e)); body = ''; }
    var title = trigger.kind === 'leave' ? 'Leave now: ' + dest.name : dest.name + ': leave ' + format.clock(plan.leaveAt, c24);
    return { title: title, body: body, color: firstBusColor(plan) };
  }

  function markHandled(id) {
    handled.push(id);
    if (handled.length > MAX_HANDLED) handled = handled.slice(handled.length - MAX_HANDLED);
    saveHandled();
  }

  // Re-plans every due trigger's destination with one fresh location and live data, notifies, then
  // re-plans destinations whose occurrence has passed and reschedules. If the fresh re-plan fails
  // (location or router error) the previously stored plan is used for the notification and kept.
  // cb(err, notifications[]).
  function checkDue(cb) {
    if (running) { if (cb) cb(null, null); return; }
    running = true;
    var finish = finisher(cb);
    var sent = [];
    try {
      var cfg = config();
      var now = clock();
      var t = getTriggers();
      var list = t.due(t.build(cfg.destinations || [], plans, now, cfg.schedule || {}), now, handled);
      var passed = [];
      var enabled = enabledDestinations(cfg);
      for (var i = 0; i < enabled.length; i++) {
        var e = plans[enabled[i].id];
        if (!e || !(e.occurrence > now)) passed.push(enabled[i]);
      }
      if (list.length === 0 && passed.length === 0) {
        reschedule();
        return finish(null, sent);
      }
      locate(cfg, function (lErr, pos) {
        if (lErr) log('locate failed: ' + errorText(lErr));
        var k = 0;
        function nextDue() {
          if (k >= list.length) return afterDue();
          var trig = list[k++];
          var dest = findDestination(cfg, trig.destinationId);
          if (!dest) { markHandled(trig.id); return nextDue(); }
          var planNow = clock();
          planOne(cfg, dest, pos, trig.occurrence, planNow, function (err, plan) {
            try {
              var old = plans[dest.id];
              if (err) {
                log('re-plan for ' + dest.id + ' failed: ' + errorText(err));
                plan = old && old.occurrence === trig.occurrence ? old.plan : null;
              } else {
                store(cfg, dest.id, trig.occurrence, plan, planNow);
                savePlans();
              }
              var n = notification(cfg, dest, trig, plan);
              try { deps.notify(n); } catch (ex) { log('notify failed: ' + errorText(ex)); }
              sent.push(n);
              markHandled(trig.id);
            } catch (ex2) { return finish(ex2); }
            nextDue();
          });
        }
        function afterDue() {
          try {
            var later = clock();
            var stale = [];
            for (var j = 0; j < enabled.length; j++) {
              var en = plans[enabled[j].id];
              if (!en || !(en.occurrence > later)) stale.push(enabled[j]);
            }
            planAll(cfg, stale, pos, later, function () {
              try {
                savePlans();
                reschedule();
              } catch (ex) { return finish(ex); }
              finish(null, sent);
            });
          } catch (ex) { finish(ex); }
        }
        nextDue();
      });
    } catch (e) { finish(e); }
  }

  // Keep in-progress trips fresh: re-plan (live data, current position) every REFRESH_ACTIVE s until the
  // first bus departs — after that you are on it and the plan is kept as is. cb(err, refreshedDestIds | null)
  function refreshActive(cb) {
    if (running) { if (cb) cb(null, null); return; }
    running = true;
    var finish = finisher(cb);
    try {
      var cfg = config();
      var now = clock();
      var trips = getTriggers().activeTrips(cfg.destinations || [], plans, now, cfg.schedule || {});
      var stale = [];
      for (var i = 0; i < trips.length; i++) {
        var entry = plans[trips[i].destination.id];
        var bus = firstBus(trips[i].plan);
        if (bus && now < bus.departAt - 60 && (!entry.plannedAt || now - entry.plannedAt >= REFRESH_ACTIVE)) stale.push(trips[i]);
      }
      if (!stale.length) return finish(null, []);
      locate(cfg, function (err, pos) {
        if (err || !pos) { log('locate failed: ' + errorText(err)); return finish(null, []); }
        var k = 0, done = [];
        function next() {
          if (k >= stale.length) {
            try { savePlans(); reschedule(); } catch (e) { return finish(e); }
            return finish(null, done);
          }
          var trip = stale[k++];
          planOne(cfg, trip.destination, pos, trip.occurrence, clock(), function (perr, plan) {
            if (perr) log('trip refresh for ' + trip.destination.id + ' failed: ' + errorText(perr));
            else if (plan) { store(cfg, trip.destination.id, trip.occurrence, plan, clock()); done.push(trip.destination.id); }
            next();
          });
        }
        next();
      });
    } catch (e) { finish(e); }
  }

  function firstBus(plan) {
    var legs = (plan && plan.legs) || [];
    for (var i = 0; i < legs.length; i++) if (legs[i] && legs[i].mode === 'bus') return legs[i];
    return null;
  }

  function handleWakeup(cookie, cb) {
    log('wakeup ' + cookie);
    checkDue(cb);
  }

  return {
    load: load,
    plans: function () { return plans; },
    handled: function () { return handled; },
    replan: replan,
    reschedule: reschedule,
    checkDue: checkDue,
    refreshActive: refreshActive,
    handleWakeup: handleWakeup
  };
}

module.exports = { REFRESH_ACTIVE: REFRESH_ACTIVE, createScheduler: createScheduler, STORAGE_KEYS: STORAGE_KEYS, MAX_HANDLED: MAX_HANDLED };
