// Several transit systems behind the one provider interface (CONTRACTS.md §3a). ES5.
//
// Every id going in or out is a ref, `providerId + '/' + id` (stops, routes, trips), so systems can't collide.
// stopsNear only asks the systems whose coverage contains the position; the other calls go to the system the ref
// names. Built by composition roots from a registry (fromConfig); nothing here requires src/sources.
var geo = require('./geo');
var view = require('./view');

function later(cb, err, value) { setTimeout(function () { cb(err, value); }, 0); }

function once(cb) {
  var done = false;
  return function (err, value) {
    if (done) return;
    done = true;
    cb(err, value);
  };
}

function prefixList(pid, list) {
  var out = [];
  for (var i = 0; list && i < list.length; i++) out.push(view.ref(pid, String(list[i])));
  return out;
}

function prefixRoute(pid, r) {
  if (!r) return r;
  var dirs = [];
  for (var i = 0; r.directions && i < r.directions.length; i++) {
    var d = r.directions[i];
    var nd = { id: d.id, name: d.name, stopIds: prefixList(pid, d.stopIds) };
    if (d.paths) nd.paths = d.paths;
    dirs.push(nd);
  }
  var stops = {};
  for (var k in r.stops || {}) {
    if (!r.stops.hasOwnProperty(k)) continue;
    var s = r.stops[k], ns = {};
    for (var f in s) if (s.hasOwnProperty(f)) ns[f] = s[f];
    ns.id = view.ref(pid, String(s.id != null ? s.id : k));
    stops[view.ref(pid, k)] = ns;
  }
  return { id: view.ref(pid, String(r.id)), shortName: r.shortName, longName: r.longName || '', color: r.color || '',
           directions: dirs, stops: stops };
}

// members: [{id, provider, covers(pos) → bool (optional; missing = everywhere)}]
function createFederation(members) {
  var byId = {};
  var list = [];
  for (var i = 0; members && i < members.length; i++) {
    var m = members[i];
    if (!m || !m.provider || byId.hasOwnProperty(m.id)) continue;
    byId[m.id] = m;
    list.push(m);
  }

  // the member a ref names → {member, id} or null
  function target(r) {
    var p = view.splitRef(String(r));
    return p && byId.hasOwnProperty(p.providerId) ? { member: byId[p.providerId], id: p.id } : null;
  }

  // call member method on a ref, map the result; unknown system / missing method → error
  function routed(method, r, args, map, cb) {
    cb = once(cb);
    var t = target(r);
    if (!t) return later(cb, new Error('unknown transit system for ' + r));
    var fn = t.member.provider[method];
    if (typeof fn !== 'function') return later(cb, new Error(t.member.id + " can't " + method));
    try {
      fn.apply(t.member.provider, [t.id].concat(args).concat([function (err, value) {
        if (err) return cb(err);
        var out;
        try { out = map(t.member.id, value); } catch (e) { return cb(e); }
        cb(null, out);
      }]));
    } catch (e) {
      later(cb, e);
    }
  }

  function active(pos) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var ok = true;
      try { ok = typeof list[i].covers === 'function' ? !!list[i].covers(pos) : true; } catch (e) { ok = false; }
      if (ok) out.push(list[i]);
    }
    return out;
  }

  // nearby stops of every covering system, merged nearest first; an error only when every system failed
  function stopsNear(pos, radius, cb) {
    cb = once(cb);
    var ms = active(pos);
    if (!ms.length) return later(cb, null, []);
    var results = [], remaining = ms.length, lastErr = null, anyOk = false;
    function done() {
      if (!anyOk) return cb(lastErr || new Error('no stops'));
      var all = [];
      for (var i = 0; i < results.length; i++) if (results[i]) all = all.concat(results[i]);
      var tagged = [];
      for (i = 0; i < all.length; i++) {
        var d = typeof all[i].lat === 'number' ? geo.distance(pos, all[i]) : Infinity;
        tagged.push({ d: d, i: i, s: all[i] });
      }
      tagged.sort(function (a, b) { return a.d !== b.d ? a.d - b.d : a.i - b.i; });
      var out = [];
      for (i = 0; i < tagged.length; i++) out.push(tagged[i].s);
      cb(null, out);
    }
    for (var i = 0; i < ms.length; i++) {
      (function (i, m) {
        var finish = once(function (err, stops) {
          if (err) lastErr = err;
          else {
            anyOk = true;
            var out = [];
            for (var k = 0; stops && k < stops.length; k++) {
              var s = stops[k];
              out.push({ id: view.ref(m.id, String(s.id)), name: s.name, lat: s.lat, lon: s.lon, routeIds: prefixList(m.id, s.routeIds) });
            }
            results[i] = out;
          }
          if (--remaining === 0) done();
        });
        try { m.provider.stopsNear(pos, radius, finish); } catch (e) { later(finish, e); }
      })(i, ms[i]);
    }
  }

  function arrivals(stopRef, before, after, cb) {
    routed('arrivals', stopRef, [before, after], function (pid, list) {
      var out = [];
      for (var i = 0; list && i < list.length; i++) {
        var a = list[i];
        out.push({ stopId: view.ref(pid, String(a.stopId)), routeId: view.ref(pid, String(a.routeId)),
                   tripKey: view.ref(pid, String(a.tripKey)), time: a.time, predicted: a.predicted, headsign: a.headsign });
      }
      return out;
    }, cb);
  }

  function route(routeRef, cb) { routed('route', routeRef, [], prefixRoute, cb); }

  // systems without live positions report none
  function vehicles(routeRef, cb) {
    var t = target(routeRef);
    if (t && typeof t.member.provider.vehicles !== 'function') return later(once(cb), null, []);
    routed('vehicles', routeRef, [], function (pid, list) {
      var out = [];
      for (var i = 0; list && i < list.length; i++) {
        var v = list[i];
        out.push({ tripKey: view.ref(pid, String(v.tripKey)), routeId: view.ref(pid, String(v.routeId)), directionId: v.directionId,
                   lat: v.lat, lon: v.lon, time: v.time });
      }
      return out;
    }, cb);
  }

  function routeInfo(routeRef, cb) { routed('routeInfo', routeRef, [], prefixRoute, cb); }

  function stopInfo(stopRef, cb) {
    routed('stopInfo', stopRef, [], function (pid, s) {
      return { id: view.ref(pid, String(s.id)), name: s.name, lat: s.lat, lon: s.lon };
    }, cb);
  }

  return {
    stopsNear: stopsNear, arrivals: arrivals, route: route, vehicles: vehicles, routeInfo: routeInfo, stopInfo: stopInfo,
    members: function () { return list.slice(); },
    member: function (id) { return byId.hasOwnProperty(id) ? byId[id].provider : null; }
  };
}

// One member per configured system, created with registry.createFor; covers = the system's coverage area.
function fromConfig(registry, config, deps) {
  var members = [];
  var providers = (config && config.providers) || [];
  for (var i = 0; i < providers.length; i++) {
    (function (p) {
      var area = view.coverage(config, p.id);
      members.push({ id: p.id, provider: registry.createFor(p, config, deps), covers: function (pos) { return view.inArea(area, pos); } });
    })(providers[i]);
  }
  return createFederation(members);
}

module.exports = { createFederation: createFederation, fromConfig: fromConfig, prefixRoute: prefixRoute };
