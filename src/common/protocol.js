// Phone <-> watch AppMessage encoding (CONTRACTS.md section 7). ES5.
var format = require('./format');

var KIND = { pickup: 0, dropoff: 1, trip: 2 };
var TITLE_MAX_BYTES = 63;        // full stop names: the watch scrolls (marquee) what doesn't fit
var ROUTE_MAX_BYTES = 63;        // the route's full name (ITEM_ROUTE)
var NOTIFY_TITLE_MAX_BYTES = 31;
var BADGE_MAX_BYTES = 7;
var STATUS_MAX_BYTES = 47;
var MAX_ITEMS = 12;
var DIST_MAX_BYTES = 7;
var DIR_MAX_BYTES = 3;
var MAX_WAKEUPS = 8;
var NOTIFY_BODY_MAX_BYTES = 159;

// UTF-8 byte length of the code point starting at str[i], and how many UTF-16 units it uses.
function codePointAt(str, i) {
  var c = str.charCodeAt(i);
  if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
    var d = str.charCodeAt(i + 1);
    if (d >= 0xDC00 && d <= 0xDFFF) return { units: 2, bytes: 4 };
  }
  if (c < 0x80) return { units: 1, bytes: 1 };
  if (c < 0x800) return { units: 1, bytes: 2 };
  return { units: 1, bytes: 3 }; // BMP (lone surrogates encode as 3-byte U+FFFD)
}

// Longest prefix of str whose UTF-8 encoding fits in maxBytes, never splitting a code point.
function truncateUtf8(str, maxBytes) {
  str = str === null || str === undefined ? '' : String(str);
  var used = 0;
  var i = 0;
  while (i < str.length) {
    var cp = codePointAt(str, i);
    if (used + cp.bytes > maxBytes) break;
    used += cp.bytes;
    i += cp.units;
  }
  return str.substring(0, i);
}

function toInt(v) {
  var n = Number(v);
  return isFinite(n) ? Math.round(n) : 0;
}

// Badge: truncated to BADGE_MAX_BYTES, then trailing spaces trimmed (missing -> '').
function encodeBadge(badge) {
  return truncateUtf8(badge, BADGE_MAX_BYTES).replace(/ +$/, '');
}

// 'RRGGBB' -> integer, anything else -> -1.
function encodeColor(color) {
  if (typeof color !== 'string' || !/^[0-9a-fA-F]{6}$/.test(color)) return -1;
  return parseInt(color, 16);
}

// degrees -> integer in [0, 360), or -1 when unknown
function encodeBearing(b) {
  if (b === null || b === undefined || typeof b !== 'number' || !isFinite(b)) return -1;
  return ((Math.round(b) % 360) + 360) % 360;
}

function encodeDistance(d, units) {
  if (d === null || d === undefined) return '';
  return truncateUtf8(format.distance(d, units), DIST_MAX_BYTES);
}

function encodeDir(d) {
  return truncateUtf8(d || '', DIR_MAX_BYTES);
}

function encodeList(listId, items, status, opts) {
  items = items || [];
  var units = opts && opts.units === 'metric' ? 'metric' : 'imperial';
  var showWalk = !(opts && opts.showWalk === false), showArrow = !(opts && opts.showArrow === false);
  var n = Math.min(items.length, MAX_ITEMS);
  var out = [{ LIST_ID: listId, ITEM_COUNT: n, STATUS: truncateUtf8(status, STATUS_MAX_BYTES) }];
  for (var i = 0; i < n; i++) {
    var it = items[i] || {};
    var times = it.times || [];
    var lanes = it.lanes instanceof Array ? it.lanes : [];
    var lane0 = lanes[0] || {};
    var msg = {
      LIST_ID: listId,
      ITEM_INDEX: i,
      ITEM_KIND: KIND.hasOwnProperty(it.kind) ? KIND[it.kind] : 0,
      ITEM_BADGE: encodeBadge(it.badge),
      ITEM_TITLE: truncateUtf8(it.title, TITLE_MAX_BYTES),
      ITEM_ROUTE: truncateUtf8(it.routeLongName, ROUTE_MAX_BYTES),
      ITEM_COLOR: encodeColor(it.color),
      ITEM_T0: toInt(times[0]),
      ITEM_T1: toInt(times[1]),
      ITEM_T2: toInt(times[2]),
      ITEM_BEARING: showArrow ? encodeBearing(it.bearing) : -1,
      ITEM_DIST: encodeDistance(it.distance, units),
      ITEM_DIR: encodeDir(lane0.dir || it.dir),
      ITEM_LANES: lanes.length >= 2 ? 2 : 1
    };
    // a tile you walk to (pickup, trip boarding): whole seconds to walk there, shown right-aligned in its times line
    if (showWalk && typeof it.walk === 'number' && isFinite(it.walk) && it.walk >= 0) msg.ITEM_WALK = Math.round(it.walk);
    if (lanes.length >= 2) {
      var lane1 = lanes[1] || {};
      var u = lane1.times || [];
      msg.ITEM_DIR2 = encodeDir(lane1.dir);
      msg.ITEM_U0 = toInt(u[0]);
      msg.ITEM_U1 = toInt(u[1]);
      msg.ITEM_U2 = toInt(u[2]);
    }
    out.push(msg);
  }
  return out;
}

function encodeStatus(status) {
  return { STATUS: truncateUtf8(status, STATUS_MAX_BYTES) };
}

// [{time, cookie}] -> [{WAKEUP_COUNT: n}, {WAKEUP_INDEX: i, WAKEUP_TIME, WAKEUP_COOKIE} x n]; [] cancels all
function encodeWakeups(wakeups) {
  wakeups = wakeups instanceof Array ? wakeups : [];
  var n = Math.min(wakeups.length, MAX_WAKEUPS);
  var out = [{ WAKEUP_COUNT: n }];
  for (var i = 0; i < n; i++) {
    var w = wakeups[i] || {};
    out.push({ WAKEUP_INDEX: i, WAKEUP_TIME: toInt(w.time), WAKEUP_COOKIE: toInt(w.cookie) });
  }
  return out;
}

function encodeNotify(n) {
  n = n || {};
  return {
    NOTIFY_TITLE: truncateUtf8(n.title, NOTIFY_TITLE_MAX_BYTES),
    NOTIFY_BODY: truncateUtf8(n.body, NOTIFY_BODY_MAX_BYTES),
    NOTIFY_COLOR: encodeColor(n.color)
  };
}

// Weather panel (weather.slice: °C) → one message: WEATHER_COUNT n (0 = hide the panel; null → just that),
// WEATHER_START (epoch s of the first hour), WEATHER_NOW / WEATHER_HI / WEATHER_LO (whole degrees in the watch's units:
// °F unless 'metric'), WEATHER_TEMPS (n bytes, each hour's temperature scaled lo → 0 … hi → 255; all 128 when hi = lo)
// and WEATHER_RAIN (n bytes, chance of rain 0..100).
var WEATHER_MAX_HOURS = 24;
function encodeWeather(w, units) {
  var temps = w && w.temps instanceof Array ? w.temps : [];
  var n = Math.min(temps.length, WEATHER_MAX_HOURS);
  if (!n) return { WEATHER_COUNT: 0 };
  function deg(c) { return Math.round(units === 'metric' ? c : c * 9 / 5 + 32); }
  var lo = w.lo, span = w.hi - w.lo, rain = w.rain instanceof Array ? w.rain : [];
  var tb = [], rb = [];
  for (var i = 0; i < n; i++) {
    tb.push(span > 0 ? Math.max(0, Math.min(255, Math.round((temps[i] - lo) / span * 255))) : 128);
    rb.push(Math.max(0, Math.min(100, toInt(rain[i]))));
  }
  return { WEATHER_COUNT: n, WEATHER_START: toInt(w.start), WEATHER_NOW: deg(w.now), WEATHER_HI: deg(w.hi),
           WEATHER_LO: deg(w.lo), WEATHER_TEMPS: tb, WEATHER_RAIN: rb };
}

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined && obj[key] !== null;
}

function decodeWatchMessage(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (has(payload, 'WAKEUP_FIRED')) return { type: 'wakeup', cookie: Number(payload.WAKEUP_FIRED) };
  if (has(payload, 'SELECT_INDEX') && has(payload, 'LIST_ID')) {
    return { type: 'select', listId: Number(payload.LIST_ID), index: Number(payload.SELECT_INDEX) };
  }
  if (has(payload, 'REFRESH')) return { type: 'refresh' };
  if (has(payload, 'WATCH_PREFS')) return decodePrefs(payload.WATCH_PREFS);
  return null;
}

// WATCH_PREFS flags (sent by the watch once the phone talks to it): bit 0 = 24 h clock, bit 2 = the watch knows the
// user's measurement system, bit 1 = it is metric. → {type: 'prefs', clock24, units: 'metric'|'imperial'|null}
var PREFS = { CLOCK24: 1, METRIC: 2, UNITS_KNOWN: 4 };
function decodePrefs(v) {
  var n = Number(v) | 0;
  return { type: 'prefs', clock24: (n & PREFS.CLOCK24) !== 0,
           units: (n & PREFS.UNITS_KNOWN) ? ((n & PREFS.METRIC) ? 'metric' : 'imperial') : null };
}

// Sends messages one at a time through sendFn(dict, onOk, onErr) (= Pebble.sendAppMessage).
// Each queued entry remembers its batch and whether that batch is a list (has an ITEM_COUNT header).
function createSender(sendFn, opts) {
  var retries = opts && typeof opts.retries === 'number' ? opts.retries : 2;
  var queue = [];       // [{ msg, batch, list }] not yet sent
  var inFlight = null;  // { msg, batch, list, failures }
  var batches = 0;      // batch id counter
  var listBatch = 0;    // id of the newest list batch

  function stale(entry) {
    return entry.list && entry.batch !== listBatch;
  }

  function next() {
    if (inFlight || queue.length === 0) return;
    var e = queue.shift();
    inFlight = { msg: e.msg, batch: e.batch, list: e.list, failures: 0 };
    transmit();
  }

  function transmit() {
    var current = inFlight;
    var done = false;
    function onOk() {
      if (done) return;
      done = true;
      inFlight = null;
      next();
    }
    function onErr() {
      if (done) return;
      done = true;
      current.failures++;
      if (!stale(current) && current.failures <= retries) {
        transmit();          // retry the same message (inFlight unchanged)
        return;
      }
      inFlight = null;
      var kept = [];         // drop the rest of the failed batch
      for (var i = 0; i < queue.length; i++) if (queue[i].batch !== current.batch) kept.push(queue[i]);
      queue = kept;
      next();
    }
    try {
      sendFn(current.msg, onOk, onErr);
    } catch (e) {
      onErr(e);
    }
  }

  return {
    // A batch carrying a new list (ITEM_COUNT header) drops the queued messages of earlier list batches; queued
    // non-list messages (status, wakeups, notify) stay, in order. Non-list batches are appended.
    sendAll: function (messages) {
      messages = (messages || []).slice();
      var isList = false;
      var i;
      for (i = 0; i < messages.length; i++) {
        if (messages[i] && Object.prototype.hasOwnProperty.call(messages[i], 'ITEM_COUNT')) isList = true;
      }
      var id = ++batches;
      if (isList) {
        listBatch = id;
        var kept = [];
        for (i = 0; i < queue.length; i++) if (!queue[i].list) kept.push(queue[i]);
        queue = kept;
      }
      for (i = 0; i < messages.length; i++) queue.push({ msg: messages[i], batch: id, list: isList });
      next();
    },
    pending: function () {
      return queue.length + (inFlight ? 1 : 0);
    }
  };
}

module.exports = {
  KIND: KIND,
  TITLE_MAX_BYTES: TITLE_MAX_BYTES,
  ROUTE_MAX_BYTES: ROUTE_MAX_BYTES,
  NOTIFY_TITLE_MAX_BYTES: NOTIFY_TITLE_MAX_BYTES,
  BADGE_MAX_BYTES: BADGE_MAX_BYTES,
  STATUS_MAX_BYTES: STATUS_MAX_BYTES,
  MAX_ITEMS: MAX_ITEMS,
  DIST_MAX_BYTES: DIST_MAX_BYTES,
  DIR_MAX_BYTES: DIR_MAX_BYTES,
  MAX_WAKEUPS: MAX_WAKEUPS,
  NOTIFY_BODY_MAX_BYTES: NOTIFY_BODY_MAX_BYTES,
  truncateUtf8: truncateUtf8,
  encodeList: encodeList,
  encodeStatus: encodeStatus,
  encodeWakeups: encodeWakeups,
  encodeNotify: encodeNotify,
  encodeWeather: encodeWeather,
  WEATHER_MAX_HOURS: WEATHER_MAX_HOURS,
  decodeWatchMessage: decodeWatchMessage,
  PREFS: PREFS,
  createSender: createSender
};
