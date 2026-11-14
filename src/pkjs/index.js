// PebbleKit JS entry: wires the session to Pebble, XMLHttpRequest, geolocation and localStorage
// (CONTRACTS.md section 9). Thin glue, not unit tested. ES5.

var protocol = require('../common/protocol');
var sessionModule = require('../common/session');
var schedulerModule = require('../common/scheduler');
var triggers = require('../common/triggers');
var tripItems = require('../common/trip-items');
var federation = require('../common/federation');
var catalog = require('../common/catalog');
var weather = require('../common/weather');
// Data sources are plug-ins: this composition root is the only place that picks them.
var sources = require('../sources/registry').createRegistry(require('../sources/all'));

// The settings page is bundled with the app (see tools/build-config.js) and handed to the phone
// app as a data: URI, so no external server is needed.
var CONFIG_PAGE = require('./config-page');

var HTTP_TIMEOUT_MS = 20000;
var LOCATE_OPTIONS = { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 };
var RETURN_TO = 'pebblejs://close#';
var CATALOG_DELAY_MS = 15000;   // let the first refresh finish before indexing routes and stops

function log(msg) {
  console.log('[bus-watch] ' + msg);
}

function clock() {
  return Math.floor(Date.now() / 1000);
}

// GET url, cb(err, parsedJson). Calls cb exactly once. headers: optional {name: value} request headers (e.g. API keys
// that a source sends as a header).
function http(url, cb, headers) {
  var done = false;
  function finish(err, body) {
    if (done) return;
    done = true;
    cb(err, body);
  }
  var xhr;
  try {
    xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.timeout = HTTP_TIMEOUT_MS;
    for (var h in headers || {}) if (headers.hasOwnProperty(h)) xhr.setRequestHeader(h, headers[h]);
  } catch (e) {
    finish(e);
    return;
  }
  // Some PebbleKit JS runtimes ignore xhr.timeout; keep our own timer too.
  var timer = setTimeout(function () {
    try { xhr.abort(); } catch (e) { /* ignore */ }
    finish(new Error('Request timed out'));
  }, HTTP_TIMEOUT_MS + 1000);
  xhr.onload = function () {
    clearTimeout(timer);
    var body;
    try {
      // some APIs (511.org) start their JSON with a UTF-8 byte order mark, which JSON.parse rejects
      body = JSON.parse(String(xhr.responseText).replace(/^﻿/, ''));
    } catch (e) {
      finish(new Error('HTTP ' + xhr.status + (xhr.status >= 200 && xhr.status < 300 ? ' (bad JSON)' : '')));
      return;
    }
    // OneBusAway reports errors in the body's `code`; the provider checks it.
    finish(null, body);
  };
  xhr.onerror = function () {
    clearTimeout(timer);
    finish(new Error('Network error'));
  };
  xhr.ontimeout = function () {
    clearTimeout(timer);
    finish(new Error('Request timed out'));
  };
  try {
    xhr.send();
  } catch (e) {
    clearTimeout(timer);
    finish(e);
  }
}

function locate(cb) {
  var done = false;
  function finish(err, pos) {
    if (done) return;
    done = true;
    cb(err, pos);
  }
  if (!navigator.geolocation) {
    finish(new Error('No location service'));
    return;
  }
  // Guard against platforms that never call back.
  var timer = setTimeout(function () {
    finish(new Error('Location timed out'));
  }, LOCATE_OPTIONS.timeout + 5000);
  navigator.geolocation.getCurrentPosition(function (p) {
    clearTimeout(timer);
    finish(null, { lat: p.coords.latitude, lon: p.coords.longitude });
  }, function (err) {
    clearTimeout(timer);
    finish(new Error((err && err.message) || 'Location unavailable'));
  }, LOCATE_OPTIONS);
}

var sender = protocol.createSender(function (dict, onOk, onErr) {
  Pebble.sendAppMessage(dict, onOk, function (e) {
    log('send failed: ' + JSON.stringify(dict));
    onErr(e);
  });
}, { retries: 2 });

var sourceDeps = { http: http, clock: clock, storage: localStorage };

// One federated provider (every configured transit system, ids namespaced 'system/id') per source-relevant config,
// shared by the session and the scheduler.
var providerKey = null;
var providerInstance = null;
function providerFor(config) {
  var key = JSON.stringify([config.providers, config.routes, config.stops, config.location]);
  if (key !== providerKey) {
    providerKey = key;
    providerInstance = federation.fromConfig(sources, config, sourceDeps);
  }
  return providerInstance;
}

// ---- route / stop search index, one per transit system (built in the background, kept 7 days) ----
var catalogBusy = false;
function refreshCatalogs() {
  if (catalogBusy) return;
  var config = session.getConfig();
  var todo = [];
  for (var i = 0; i < config.providers.length; i++) {
    if (!catalog.fresh(catalog.loadPacked(localStorage, config.providers[i]), clock())) todo.push(config.providers[i]);
  }
  if (!todo.length) return;
  catalogBusy = true;
  (function next() {
    var entry = todo.shift();
    if (!entry) { catalogBusy = false; return; }
    var provider;
    try {
      provider = sources.createFor(entry, config, sourceDeps);
    } catch (e) {
      log('index ' + entry.id + ': ' + (e.message || e));
      return next();
    }
    log('indexing routes and stops of ' + entry.id);
    catalog.build(provider, entry, clock(), function (err, packed) {
      if (err) log('index ' + entry.id + ' failed: ' + (err.message || err));
      else if (!catalog.save(localStorage, entry, packed)) log('index ' + entry.id + ': storage full');
      else log('indexed ' + entry.id + ': ' + packed.routes.length + ' routes, ' + packed.stops.length + ' stops');
      next();
    });
  })();
}

// stored indexes of the configured systems (also stale ones; the page rebuilds what is missing), in the text form that
// stays small in the page's data: URI
function storedCatalogs(config) {
  var out = {};
  for (var i = 0; i < config.providers.length; i++) {
    var p = catalog.toText(catalog.loadPacked(localStorage, config.providers[i]));
    if (p) out[config.providers[i].id] = p;
  }
  return out;
}

// (unref: under Node, in tests, a pending index build must not keep the process alive)
function later(fn, ms) {
  var t = setTimeout(fn, ms);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

function locale() {
  try { return navigator.language || ''; } catch (e) { return ''; }
}

var session = sessionModule.createSession({
  storage: localStorage,
  clock: clock,
  locale: locale(),
  locate: locate,
  createProvider: providerFor,
  weather: weather.createFetcher(http, clock),
  send: function (messages) {
    sender.sendAll(messages);
  },
  // the scheduled trip in progress is pinned above the ranked list
  pinnedItems: function (config, data, pos, now) {
    var active = triggers.activeTrips(config.destinations, scheduler.plans(), now, config.schedule);
    return tripItems.build(active, data, pos, now, { clock24: config.clock24, walkSpeed: config.schedule.walkSpeed });
  },
  log: log
});

var scheduler = schedulerModule.createScheduler({
  storage: localStorage,
  clock: clock,
  locate: locate,
  getConfig: function () { return session.runtimeConfig(null); },
  getSource: function () { return providerFor(session.getConfig()); },
  sendWakeups: function (wakeups) {
    log('scheduling ' + wakeups.length + ' wakeups');
    sender.sendAll(protocol.encodeWakeups(wakeups));
  },
  notify: function (n) {
    log('notify: ' + n.title + ' | ' + n.body);
    sender.sendAll([protocol.encodeNotify(n)]);
  },
  log: log
});

function checkDue(then) {
  scheduler.checkDue(function (err, sent) {
    if (err) log('schedule check error: ' + (err.message || err));
    else if (sent && sent.length) log('sent ' + sent.length + ' trip notifications');
    if (then) then();
  });
}

// checkDue and refreshActive share the scheduler's busy guard, so run them one after the other
function refreshTrips() {
  scheduler.refreshActive(function (err, refreshed) {
    if (err) log('trip refresh error: ' + (err.message || err));
    else if (refreshed && refreshed.length) log('re-planned trips in progress: ' + refreshed.join(', '));
  });
}

function replan() {
  scheduler.replan(function (err) {
    if (err) log('replan error: ' + (err.message || err));
    checkDue();
  });
}

function refresh() {
  session.refresh(function (err, items) {
    if (err) log('refresh error: ' + (err.message || err));
    else if (items) log('sent ' + items.length + ' items');
  });
}

function tick() {
  refresh();
  checkDue(refreshTrips);
}

var timer = null;
var timerSeconds = 0;
function armTimer() {
  var seconds = session.getConfig().refreshInterval;
  if (timer !== null && seconds === timerSeconds) return;
  if (timer !== null) clearInterval(timer);
  timerSeconds = seconds;
  timer = setInterval(tick, seconds * 1000);
}

Pebble.addEventListener('ready', function () {
  log('PebbleKit JS ready');
  session.load();
  scheduler.load();
  refresh();
  checkDue();   // also plans destinations that have no plan yet (e.g. after a wakeup launch)
  armTimer();
  later(refreshCatalogs, CATALOG_DELAY_MS);
});

Pebble.addEventListener('appmessage', function (e) {
  log('watch message: ' + JSON.stringify(e.payload));
  var msg = session.handleWatchMessage(e.payload);
  if (msg && msg.type === 'wakeup') scheduler.handleWakeup(msg.cookie);
});

Pebble.addEventListener('showConfiguration', function () {
  var p = session.configPageParams();
  var params = { config: p.config, samples: p.samples, learned: p.learned, prefs: p.prefs, plans: scheduler.plans(),
                 sources: sources.types(), catalogs: storedCatalogs(p.config), return_to: RETURN_TO };
  var injected = '<script>window.__params = ' +
      JSON.stringify(params).replace(/</g, '\\u003c') + ';</script>';
  // Function replacement so '$' sequences in the JSON are not treated as patterns.
  var html = CONFIG_PAGE.replace('<!--PARAMS-->', function () { return injected; });
  Pebble.openURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response || e.response === 'CANCELLED') {
    log('settings closed without saving');
    return;
  }
  var result;
  try {
    result = JSON.parse(decodeURIComponent(e.response));
  } catch (err) {
    log('bad settings response: ' + e.response);
    return;
  }
  session.applySettings(result);
  armTimer();
  replan();
  later(refreshCatalogs, CATALOG_DELAY_MS);
});
