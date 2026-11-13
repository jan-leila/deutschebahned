'use strict';
// The plug point between the app and its transit data sources (CONTRACTS.md §3). ES5.
// The app never requires a concrete source: the composition root (src/pkjs/index.js, the settings page,
// tools) registers plug-ins here and asks the registry for a provider. This file knows the app config
// shape only to build the plug-in's context; it imports no source.

function defaultClock() { return Math.floor(new Date().getTime() / 1000); }

// configured route ids (of system providerId when given: routes saved for another system are skipped), then any
// version 1 connection route ids; deduplicated, config order
function configuredRouteIds(config, providerId) {
  var out = [];
  var seen = {};
  function add(id) {
    if (id === null || id === undefined) return;
    id = String(id);
    if (id === '' || seen.hasOwnProperty(id)) return;
    seen[id] = true;
    out.push(id);
  }
  var routes = (config && config.routes) || [];
  var conns = (config && config.connections) || [];
  var i;
  for (i = 0; i < routes.length; i++) if (routes[i] && mine(routes[i], providerId)) add(routes[i].id);
  for (i = 0; i < conns.length; i++) if (conns[i]) add(conns[i].routeId);
  return out;
}

// a saved route / stop belongs to system providerId (entries without a providerId belong to every system)
function mine(entry, providerId) {
  return providerId === undefined || entry.providerId === undefined || entry.providerId === providerId;
}

// What a plug-in gets besides its own options: I/O and the bits of the app config a source may need
// (only system providerId's routes when given).
// center = the fixed location when one is set, else `home` (the system's coverage centre or its plug-in's home area, from
// createFor), else the location as configured.
function sourceContext(config, deps, providerId, home) {
  deps = deps || {};
  var routes = [];
  var cfgRoutes = (config && config.routes) || [];
  for (var i = 0; i < cfgRoutes.length; i++) {
    if (cfgRoutes[i] && mine(cfgRoutes[i], providerId)) {
      routes.push({ id: String(cfgRoutes[i].id), name: String(cfgRoutes[i].name || cfgRoutes[i].id) });
    }
  }
  var loc = (config && config.location) || {};
  return {
    http: deps.http,
    clock: deps.clock || defaultClock,
    storage: deps.storage,
    routeIds: configuredRouteIds(config, providerId),
    routes: routes,
    center: (loc.mode === 'fixed' && (+loc.lat || +loc.lon)) || !home ? { lat: +loc.lat || 0, lon: +loc.lon || 0 } : home
  };
}

function createRegistry(plugins) {
  var list = [];
  var byType = {};

  function register(plugin) {
    if (!plugin || typeof plugin.type !== 'string' || plugin.type === '' || typeof plugin.create !== 'function') {
      throw new Error('bad source plug-in');
    }
    if (!byType.hasOwnProperty(plugin.type)) list.push(plugin);
    else list[list.indexOf(byType[plugin.type])] = plugin;
    byType[plugin.type] = plugin;
    return api;
  }

  // the plug-in for `type`; '' or unknown → the first registered (the default source); none → null
  function resolve(type) {
    if (typeof type === 'string' && byType.hasOwnProperty(type)) return byType[type];
    return list.length ? list[0] : null;
  }

  var api = {
    register: register,
    resolve: resolve,
    has: function (type) { return byType.hasOwnProperty(type); },
    types: function () {
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var p = list[i], t = { type: p.type, label: p.label || p.type };
        // optional plug-in metadata for the settings page: home area {lat, lon, radius} (m), API key needed, where to get one
        if (p.area && typeof p.area.lat === 'number' && typeof p.area.lon === 'number') {
          t.area = { lat: p.area.lat, lon: p.area.lon, radius: +p.area.radius || 50000 };
        }
        if (p.needsKey) t.needsKey = true;
        if (p.keyUrl) t.keyUrl = String(p.keyUrl);
        out.push(t);
      }
      return out;
    },
    // provider for one configured system entry = {id, type, baseUrl, apiKey} (type resolved as above); its context
    // holds only that system's saved routes
    createFor: function (entry, config, deps) {
      entry = entry || {};
      var plugin = resolve(entry.type);
      if (!plugin) throw new Error('no transit data source registered');
      var cv = entry.coverage || {}, home = null;
      if (+cv.lat || +cv.lon) home = { lat: +cv.lat, lon: +cv.lon };
      else if (plugin.area && typeof plugin.area.lat === 'number') home = { lat: plugin.area.lat, lon: plugin.area.lon };
      return plugin.create({ baseUrl: entry.baseUrl || '', apiKey: entry.apiKey || '' }, sourceContext(config, deps, entry.id, home));
    },
    // provider for a single-source config ({provider: {type, baseUrl, apiKey}, routes}); tools and tests
    create: function (config, deps) {
      var opts = (config && config.provider) || {};
      var plugin = resolve(opts.type);
      if (!plugin) throw new Error('no transit data source registered');
      return plugin.create({ baseUrl: opts.baseUrl || '', apiKey: opts.apiKey || '' }, sourceContext(config, deps));
    }
  };
  for (var i = 0; plugins && i < plugins.length; i++) register(plugins[i]);
  return api;
}

module.exports = { createRegistry: createRegistry, configuredRouteIds: configuredRouteIds, sourceContext: sourceContext };
