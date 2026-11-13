'use strict';
// The plug point between the app and its transit data sources (CONTRACTS.md §3). ES5.
// The app never requires a concrete source: the composition root (src/pkjs/index.js, the settings page,
// tools) registers plug-ins here and asks the registry for a provider. This file knows the app config
// shape only to build the plug-in's context; it imports no source.

function defaultClock() { return Math.floor(new Date().getTime() / 1000); }

// configured route ids, then connection route ids; deduplicated, config order
function configuredRouteIds(config) {
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
  for (i = 0; i < routes.length; i++) if (routes[i]) add(routes[i].id);
  for (i = 0; i < conns.length; i++) if (conns[i]) add(conns[i].routeId);
  return out;
}

// What a plug-in gets besides its own options: I/O and the bits of the app config a source may need.
function sourceContext(config, deps) {
  deps = deps || {};
  var routes = [];
  var cfgRoutes = (config && config.routes) || [];
  for (var i = 0; i < cfgRoutes.length; i++) {
    if (cfgRoutes[i]) routes.push({ id: String(cfgRoutes[i].id), name: String(cfgRoutes[i].name || cfgRoutes[i].id) });
  }
  var loc = (config && config.location) || {};
  return {
    http: deps.http,
    clock: deps.clock || defaultClock,
    storage: deps.storage,
    routeIds: configuredRouteIds(config),
    routes: routes,
    center: { lat: +loc.lat || 0, lon: +loc.lon || 0 }
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
      for (var i = 0; i < list.length; i++) out.push({ type: list[i].type, label: list[i].label || list[i].type });
      return out;
    },
    // provider for config.provider.type (see resolve), created with options = config.provider
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
