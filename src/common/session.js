// Orchestration: location -> provider -> planner -> ranking -> watch, plus learning from SELECT
// presses (CONTRACTS.md section 8). All I/O is injected. ES5.

var settings = require('./settings');
var protocol = require('./protocol');
var view = require('./view');
var weather = require('./weather');
var context = require('./context');
var places = require('./places');

var STORAGE_KEYS = { config: 'busWatch.config', samples: 'busWatch.samples', learned: 'busWatch.learned', prefs: 'busWatch.prefs' };

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !(v instanceof Array);
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function clockText(epoch) {
  var d = new Date(epoch * 1000);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function errorText(err) {
  if (!err) return 'unknown';
  if (typeof err === 'string') return err;
  return err.message || String(err);
}

function createSession(deps) {
  var storage = deps.storage;
  var clock = deps.clock;
  var log = deps.log || function () {};
  // Collaborators are resolved lazily so tests (and partial builds) can inject fakes.
  var planner = deps.planner || null;
  var ranking = deps.ranking || null;
  var optimize = deps.optimize || null;
  function getPlanner() { return planner || (planner = require('./planner')); }
  function getRanking() { return ranking || (ranking = require('./ranking')); }
  function getOptimize() { return optimize || (optimize = require('./optimize')); }

  var config = settings.defaults();
  var prefs = view.prefs(null, deps.locale);   // the watch's display preferences (units, 24 h clock)
  var samples = [];
  var learned = {};
  var provider = null;
  var routeCache = {};
  var listId = 0;
  var last = null;        // { listId, items, pinned, ranked, pos, now, cfg }
  var running = false;
  var rerun = false;      // a refresh was requested by applySettings while one was running
  var forecast = null;    // the last forecast fetched (weather.parse), resent when the units change
  var weatherShown = false;
  var placeListId = 0;
  var lastPlaces = null;  // { listId, items, pos, cfg, ctx, sent } the saved locations as last sent (ranked)

  function send(messages) {
    try {
      deps.send(messages);
    } catch (e) {
      log('send failed: ' + errorText(e));
    }
  }

  function sendStatus(text) {
    send([protocol.encodeStatus(text)]);
  }

  function readJson(key) {
    var raw;
    try {
      raw = storage.getItem(key);
    } catch (e) {
      return undefined;
    }
    if (raw === null || raw === undefined || raw === '') return undefined;
    try {
      return JSON.parse(raw);
    } catch (e) {
      log('bad JSON in ' + key);
      return undefined;
    }
  }

  function writeJson(key, value) {
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch (e) {
      log('could not save ' + key + ': ' + errorText(e));
    }
  }

  function getProvider() {
    if (!provider) provider = deps.createProvider(config);
    return provider;
  }

  function sendList(items, status) {
    listId++;
    send(protocol.encodeList(listId, items, status, { units: prefs.units, showWalk: config.showWalk, deadZone: config.walkDeadZone, showArrow: config.showArrow }));
    return listId;
  }

  // The moment, for ranking and learning (context.js): weekday, time of day, month and, unless training.useWeather is
  // off, the weather from the last forecast fetched.
  function momentAt(now) {
    var w = config.training.useWeather && forecast ? weather.slice(forecast, now) : null;
    return context.at(now, w);
  }

  // Saved locations, ranked like the main list, sent as their own list when what the watch shows changes (a new list id
  // then); otherwise the watch's list keeps its id and only the candidates for learning are updated.
  function placeOpts() {
    return { units: prefs.units, showWalk: config.showWalk, showArrow: config.showArrow };
  }
  function sendPlaces(cfg, pos, ctx, force) {
    var items = context.augment(places.buildItems(cfg, pos), ctx);
    var ranked = getRanking().rank(items, { places: cfg.places, maxItems: places.MAX_PLACES }, learned);
    var msgs = protocol.encodePlaces(0, ranked, placeOpts());
    var key = JSON.stringify(msgs);
    if (!force && lastPlaces && lastPlaces.sent === key) {
      lastPlaces = { listId: lastPlaces.listId, items: ranked, pos: pos, cfg: cfg, ctx: ctx, sent: key };
      return;
    }
    if (!ranked.length && !lastPlaces && !force) return;   // nothing saved and nothing shown yet
    placeListId++;
    for (var i = 0; i < msgs.length; i++) msgs[i].LIST_ID = placeListId;
    send(msgs);
    lastPlaces = { listId: placeListId, items: ranked, pos: pos, cfg: cfg, ctx: ctx, sent: key };
  }

  // the runtime config (view.build) at pos; null = every transit system
  function runtimeConfig(pos) {
    return view.build(config, prefs, pos || null);
  }

  // feature keys of a version 1 config's learned weights / samples → version 2 (see settings.migrateKey)
  function migrateLearning(providerId) {
    var out = {};
    for (var k in learned) if (learned.hasOwnProperty(k)) out[settings.migrateKey(k, providerId)] = learned[k];
    learned = out;
    for (var i = 0; i < samples.length; i++) {
      var cands = (samples[i] && samples[i].candidates) || [];
      for (var j = 0; j < cands.length; j++) {
        var f = cands[j] && cands[j].features, nf = {};
        if (!isPlainObject(f)) continue;
        for (var fk in f) if (f.hasOwnProperty(fk)) nf[settings.migrateKey(fk, providerId)] = f[fk];
        cands[j].features = nf;
      }
    }
  }

  function load() {
    var c = readJson(STORAGE_KEYS.config);
    config = c === undefined ? settings.defaults() : settings.normalize(c);
    var s = readJson(STORAGE_KEYS.samples);
    samples = s instanceof Array ? s : [];
    var l = readJson(STORAGE_KEYS.learned);
    learned = isPlainObject(l) ? l : {};
    prefs = view.prefs(readJson(STORAGE_KEYS.prefs), deps.locale);
    if (c !== undefined && settings.isV1(c) && config.providers.length) {
      migrateLearning(config.providers[0].id);
      writeJson(STORAGE_KEYS.config, config);
      writeJson(STORAGE_KEYS.learned, learned);
      writeJson(STORAGE_KEYS.samples, samples);
      log('settings migrated to version 2');
    }
    provider = null;
    routeCache = {};
  }

  // {clock24, units ('metric'|'imperial'|null = the watch doesn't know)} from the watch. Saved; when the units change
  // the last list is sent again with distances in the new units. Returns true when something changed.
  function setPrefs(p) {
    p = isPlainObject(p) ? p : {};
    var next = { clock24: p.clock24 === true, units: prefs.units, known: prefs.known };
    if (p.units === 'metric' || p.units === 'imperial') { next.units = p.units; next.known = true; }
    var changed = next.units !== prefs.units || next.clock24 !== prefs.clock24 || next.known !== prefs.known;
    if (!changed) return false;
    var unitsChanged = next.units !== prefs.units;
    prefs = next;
    writeJson(STORAGE_KEYS.prefs, prefs);
    if (unitsChanged && last && !running) {
      var id = sendList(last.items, 'Updated ' + clockText(clock()));
      last.listId = id;
    }
    if (unitsChanged && lastPlaces) sendPlaces(lastPlaces.cfg, lastPlaces.pos, lastPlaces.ctx, true);
    if (unitsChanged && config.showWeather) sendWeather();
    return true;
  }

  // The weather panel (config.showWeather, deps.weather(pos, cb) → weather.parse result): fetched alongside each
  // refresh and sent on its own; a failed fetch keeps the last one. Turned off → the watch is told to hide it.
  function sendWeather() {
    if (!forecast) return;
    var w = weather.slice(forecast, clock());
    weatherShown = !!w;
    send([protocol.encodeWeather(w, prefs.units)]);
  }

  // The forecast is also wanted for learning (training.useWeather) when the panel is off.
  function wantWeather() {
    return (config.showWeather || config.training.useWeather) && typeof deps.weather === 'function';
  }

  function updateWeather(pos) {
    if (!config.showWeather && weatherShown) {
      weatherShown = false;
      send([protocol.encodeWeather(null)]);
    }
    if (!wantWeather()) {
      forecast = null;
      return;
    }
    if (!pos) return;
    deps.weather(pos, function (err, data) {
      if (err) return log('weather failed: ' + errorText(err));
      if (!wantWeather()) return;
      forecast = data;
      if (config.showWeather) sendWeather();
    });
  }

  function locate(cb) {
    if (config.location && config.location.mode === 'fixed') {
      var p = { lat: config.location.lat, lon: config.location.lon };
      setTimeout(function () { cb(null, p); }, 0);
      return;
    }
    deps.locate(cb);
  }

  function refresh(cb) {
    cb = cb || function () {};
    if (running) {
      cb(null, null);
      return;
    }
    running = true;
    var finished = false;
    function finish(err, items) {
      if (finished) return;
      finished = true;
      running = false;
      if (err) {
        log('refresh failed: ' + errorText(err));
        sendStatus('Error: ' + errorText(err));
      }
      try {
        cb(err || null, err ? undefined : items);
      } finally {
        if (rerun) {
          rerun = false;
          refresh();
        }
      }
    }

    if (!wantWeather() || !config.showWeather) updateWeather(null);
    sendStatus('Locating...');
    locate(function (err, pos) {
      if (err) return finish(err);
      if (!pos) return finish(new Error('no position'));
      if (wantWeather()) updateWeather(pos);
      sendStatus('Loading...');
      var prov, cache, cfg, now = clock(), ctx = momentAt(now);
      try {
        cfg = runtimeConfig(pos);
        prov = getProvider();
        cache = routeCache;
      } catch (e) {
        return finish(e);
      }
      try {
        sendPlaces(cfg, pos, ctx, false);
      } catch (e) {
        log('places failed: ' + errorText(e));
      }
      getPlanner().gather(prov, cfg, pos, now, cache, function (gErr, data) {
        if (gErr) return finish(gErr);
        var ranked;
        try {
          if (data && data.errors && data.errors.length) log('gather errors: ' + data.errors.join('; '));
          var items = context.augment(getPlanner().buildItems(cfg, data, pos, now), ctx);
          var pinned = pinnedItems(cfg, data, pos, now);
          ranked = getRanking().rank(items, cfg, learned);
          var list = withPinned(pinned, ranked);
          var status = list.length === 0 ? 'No buses nearby' : 'Updated ' + clockText(clock());
          var id = sendList(list, status);
          last = { listId: id, items: list, pinned: pinned, ranked: ranked, pos: pos, now: now, cfg: cfg, data: data, ctx: ctx };
          ranked = list;
        } catch (e) {
          return finish(e);
        }
        finish(null, ranked);
      });
    });
  }

  // Pinned tiles (deps.pinnedItems, e.g. the scheduled trip in progress) go above the ranked list; together ≤ MAX_ITEMS.
  function pinnedItems(cfg, data, pos, now) {
    if (typeof deps.pinnedItems !== 'function') return [];
    try {
      var p = deps.pinnedItems(cfg, data, pos, now);
      return p instanceof Array ? p.slice(0, protocol.MAX_ITEMS) : [];
    } catch (e) {
      log('pinned items failed: ' + errorText(e));
      return [];
    }
  }

  function withPinned(pinned, ranked) {
    return pinned.concat(ranked.slice(0, Math.max(0, protocol.MAX_ITEMS - pinned.length)));
  }

  function select(id, index) {
    if (!last || id !== last.listId) return false;
    if (typeof index !== 'number' || index !== Math.floor(index) || index < 0 || index >= last.items.length) {
      return false;
    }
    var pinned = last.pinned || [];
    if (index < pinned.length) {
      log('select on a pinned tile: not a training sample');
      return false;
    }
    var candidates = last.ranked || last.items;
    index -= pinned.length;
    var cfg = last.cfg || runtimeConfig(last.pos);
    record(candidates, index, last.pos, last.ctx, cfg);

    var ranked = getRanking().rank(candidates, cfg, learned);
    var list = withPinned(pinned, ranked);
    var newId = sendList(list, 'Learned (' + samples.length + ' picks)');
    last = { listId: newId, items: list, pinned: pinned, ranked: ranked, pos: last.pos, now: last.now, cfg: cfg, data: last.data,
             ctx: last.ctx };
    return true;
  }

  // SELECT on a saved location: a pick among the places as the watch showed them; they are re-ranked and re-sent.
  function selectPlace(id, index) {
    var lp = lastPlaces;
    if (!lp || id !== lp.listId) return false;
    if (typeof index !== 'number' || index !== Math.floor(index) || index < 0 || index >= lp.items.length) return false;
    record(lp.items, index, lp.pos, lp.ctx, lp.cfg);
    sendPlaces(lp.cfg, lp.pos, lp.ctx, true);
    return true;
  }

  // one pick → a sample (kept: the newest training.maxSamples), then training when it is automatic
  function record(candidates, index, pos, ctx, cfg) {
    samples.push(getOptimize().makeSample(candidates, index, pos, clock(), ctx || null));
    var max = config.training.maxSamples;
    if (samples.length > max) samples = samples.slice(samples.length - max);
    writeJson(STORAGE_KEYS.samples, samples);
    if (config.training.autoTrain) retrain(cfg);
  }

  function retrain(cfg) {
    var rank = getRanking();
    try {
      var result = getOptimize().train(samples, function (k) { return rank.weightFor(k, cfg, null); }, cfg.training);
      learned = (result && isPlainObject(result.weights)) ? result.weights : {};
      writeJson(STORAGE_KEYS.learned, learned);
    } catch (e) {
      log('training failed: ' + errorText(e));
    }
  }

  function handleWatchMessage(payload) {
    var msg = protocol.decodeWatchMessage(payload);
    if (!msg) {
      log('ignored watch message: ' + JSON.stringify(payload));
      return null;
    }
    if (msg.type === 'select') select(msg.listId, msg.index);
    else if (msg.type === 'placeSelect') selectPlace(msg.listId, msg.index);
    else if (msg.type === 'prefs') setPrefs(msg);
    return msg;   // e.g. {type: 'wakeup'} is routed to the scheduler by the composition root
  }

  function applySettings(result) {
    result = isPlainObject(result) ? result : {};
    config = settings.normalize(result.config);
    writeJson(STORAGE_KEYS.config, config);
    if (result.hasOwnProperty('learned')) {
      learned = isPlainObject(result.learned) ? result.learned : {};
      writeJson(STORAGE_KEYS.learned, learned);
    }
    if (result.clearSamples) {
      samples = [];
      writeJson(STORAGE_KEYS.samples, samples);
    } else if (result.samples instanceof Array) {
      // picks removed on the settings page: keep the rest, and learn again from them unless learned weights came too
      var kept = [];
      for (var i = 0; i < result.samples.length; i++) if (isPlainObject(result.samples[i])) kept.push(result.samples[i]);
      samples = kept.slice(Math.max(0, kept.length - config.training.maxSamples));
      writeJson(STORAGE_KEYS.samples, samples);
      if (!result.hasOwnProperty('learned') && config.training.autoTrain) retrain(runtimeConfig(null));
    }
    provider = null;
    routeCache = {};
    if (running) rerun = true;
    else refresh();
  }

  return {
    load: load,
    getConfig: function () { return config; },
    getPrefs: function () { return prefs; },
    setPrefs: setPrefs,
    runtimeConfig: runtimeConfig,
    getSamples: function () { return samples; },
    getLearned: function () { return learned; },
    lastList: function () { return last; },
    lastPlaces: function () { return lastPlaces; },
    refresh: refresh,
    select: select,
    selectPlace: selectPlace,
    handleWatchMessage: handleWatchMessage,
    configPageParams: function () { return { config: config, samples: samples, learned: learned, prefs: prefs }; },
    applySettings: applySettings
  };
}

module.exports = { createSession: createSession, STORAGE_KEYS: STORAGE_KEYS };
