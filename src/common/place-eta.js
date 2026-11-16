// How long getting to each saved location takes when you leave now (CONTRACTS.md §19): the trip planner's leave-now
// plan, worked out one place at a time in the background and kept while you stay near where it was planned from. All
// I/O is injected. ES5.

var geo = require('./geo');

var MAX_AGE = 300;     // s: a time older than this is planned again...
var KEEP_AGE = 900;    // ... and one older than this is not shown any more
var MOVED = 300;       // m: moved this far from where it was planned: planned again (and not shown)

// deps = {plan(place {lat, lon, name}, origin, cb(err, Plan|null)), clock(), onChange() (a time changed: send the places
// again; called on its own turn, never from inside apply), later?(fn) (default setTimeout 0), log?}
function createPlaceEta(deps) {
  var log = deps.log || function () {};
  var later = deps.later || function (fn) { setTimeout(fn, 0); };
  var changePending = false;
  var known = {};     // placeId → {at, from, eta, via, viaColor}
  var busy = false;
  var queue = [];     // [{item, pos}] waiting to be planned

  function fresh(k, pos, now, age) {
    return !!k && now - k.at <= age && !!pos && geo.distance(k.from, pos) <= MOVED;
  }

  function next() {
    if (busy || !queue.length) return;
    var job = queue.shift(), now = deps.clock();
    if (fresh(known[job.item.placeId], job.pos, now, MAX_AGE)) return next();
    busy = true;
    var done = false;
    function finish(err, plan) {
      if (done) return;
      done = true;
      busy = false;
      if (err) log('place time for ' + job.item.placeId + ' failed: ' + (err.message || err));
      var k = { at: deps.clock(), from: { lat: job.pos.lat, lon: job.pos.lon }, eta: null, via: '', viaColor: '' };
      if (!err && plan && typeof plan.arriveAt === 'number') {
        k.eta = Math.max(0, plan.arriveAt - k.at);
        var legs = plan.legs || [];
        for (var i = 0; i < legs.length; i++) {
          if (legs[i] && legs[i].mode === 'bus') { k.via = legs[i].routeName || ''; k.viaColor = legs[i].color || ''; break; }
        }
      }
      var old = known[job.item.placeId];
      known[job.item.placeId] = k;
      if ((!old || old.eta !== k.eta || old.via !== k.via) && !changePending) {
        changePending = true;
        later(function () {
          changePending = false;
          try { deps.onChange(); } catch (e) { log('place time update failed: ' + (e.message || e)); }
        });
      }
      next();
    }
    try {
      deps.plan({ lat: job.item.lat, lon: job.item.lon, name: job.item.title }, job.pos, finish);
    } catch (e) {
      finish(e, null);
    }
  }

  // items (places.buildItems) get eta / via / viaColor from what is known near pos; the ones that are stale are planned
  // (the first time, each one) afterwards. → items
  function apply(items, pos) {
    var now = deps.clock();
    for (var i = 0; i < items.length; i++) {
      var it = items[i], k = known[it.placeId];
      if (fresh(k, pos, now, KEEP_AGE) && k.eta !== null) {
        it.eta = k.eta - (now - k.at);
        if (it.eta < 0) it.eta = 0;
        it.via = k.via;
        it.viaColor = k.viaColor;
      }
      if (pos && !fresh(k, pos, now, MAX_AGE)) {
        var queued = false;
        for (var q = 0; q < queue.length; q++) if (queue[q].item.placeId === it.placeId) { queue[q].pos = pos; queued = true; }
        if (!queued) queue.push({ item: it, pos: pos });
      }
    }
    next();
    return items;
  }

  return { apply: apply };
}

module.exports = { createPlaceEta: createPlaceEta, MAX_AGE: MAX_AGE, KEEP_AGE: KEEP_AGE, MOVED: MOVED };
