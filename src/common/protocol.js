// Phone <-> watch AppMessage encoding (CONTRACTS.md section 7). ES5.
var format = require('./format');

var KIND = { pickup: 0, dropoff: 1, trip: 2, place: 3 };
var TITLE_MAX_BYTES = 63;        // full stop names: the watch scrolls (marquee) what doesn't fit
var ROUTE_MAX_BYTES = 63;        // the route's full name (ITEM_ROUTE)
var NOTIFY_TITLE_MAX_BYTES = 31;
var BADGE_MAX_BYTES = 7;
var NAV_TEXT_MAX_BYTES = 47;
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
  var dz = opts && opts.deadZone;
  var deadZone = typeof dz === 'number' && isFinite(dz) && dz > 0 ? dz : 0;
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
    // pickups: seconds from now a bus must be later than to be catchable (walk + dead zone); sooner times are highlighted
    if (it.kind === 'pickup' && typeof it.walk === 'number' && isFinite(it.walk) && it.walk >= 0) {
      msg.ITEM_LEAD = Math.round(it.walk + deadZone);
    }
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

// Saved locations (CONTRACTS.md §19): their own list, shown above the first row. [{LIST_ID, PLACE_COUNT: n},
// {LIST_ID, PLACE_INDEX: i, ITEM_TITLE (name), ITEM_ROUTE (address), ITEM_COLOR, ITEM_BEARING, ITEM_DIST, ITEM_WALK?,
// PLACE_ETA? (s to get there leaving now), ITEM_BADGE (the first bus of that trip, '' = walking)} × n]
var MAX_PLACES = 8;
var PLACE_TEXT_MAX_BYTES = 47;
function encodePlaces(listId, items, opts) {
  items = items || [];
  var units = opts && opts.units === 'metric' ? 'metric' : 'imperial';
  var showWalk = !(opts && opts.showWalk === false), showArrow = !(opts && opts.showArrow === false);
  var n = Math.min(items.length, MAX_PLACES);
  var out = [{ LIST_ID: listId, PLACE_COUNT: n }];
  for (var i = 0; i < n; i++) {
    var it = items[i] || {};
    var msg = {
      LIST_ID: listId,
      PLACE_INDEX: i,
      ITEM_TITLE: truncateUtf8(it.title, PLACE_TEXT_MAX_BYTES),
      ITEM_ROUTE: truncateUtf8(it.address, PLACE_TEXT_MAX_BYTES),
      ITEM_COLOR: encodeColor(it.color),
      ITEM_BEARING: showArrow ? encodeBearing(it.bearing) : -1,
      ITEM_DIST: encodeDistance(it.distance, units)
    };
    if (showWalk && typeof it.walk === 'number' && isFinite(it.walk) && it.walk >= 0) msg.ITEM_WALK = Math.round(it.walk);
    if (typeof it.eta === 'number' && isFinite(it.eta) && it.eta >= 0) {
      msg.PLACE_ETA = Math.round(it.eta);
      msg.ITEM_BADGE = encodeBadge(it.via);
      if (it.via) msg.ITEM_COLOR = encodeColor(it.viaColor);
    }
    out.push(msg);
  }
  return out;
}

// Navigation (CONTRACTS.md §18): the row list, then the live guidance of the current row. The list has any length;
// the watch keeps NAV_WINDOW rows of it (row i in slot i % NAV_WINDOW) and asks for others (NAV_FETCH) as you scroll.
var NAV_WINDOW = 16;
var NAV_WINDOW_BEFORE = 5;   // rows before the centre in a window
var NAV_MAX_ROWS = 1000;
var NAV_KIND = { walk: 0, board: 1, ride: 2, wait: 3, arrive: 4, info: 5, turn: 6, stop: 7, fold: 8, head: 9 };
// NAV_RAIL = marker | top << 2 | bottom << 4 | folding: the line beside the row (a stop's circle, the line to the rows
// around), and what a long SELECT on the row does (NAV_UNFOLD): FOLDED opens it (a closed leg's header, a run of hidden
// rows), OPEN closes it (an open leg's header)
var NAV_MARKER = { none: 0, stop: 1, here: 2 };
var NAV_LINE = { none: 0, line: 1, dash: 2 };
var NAV_FOLDED = 64, NAV_OPEN = 128;
var NAV_STATE = { closed: 0, guiding: 1, arrived: 2, preview: 3 };

// rows [lo, hi) the watch is sent around row `center` of a list of `count` (same rule as bus_nav_window on the watch)
function navWindow(center, count) {
  count = Math.max(0, Math.min(toInt(count), NAV_MAX_ROWS));
  var lo = Math.max(0, Math.min(toInt(center) - NAV_WINDOW_BEFORE, count - NAV_WINDOW));
  return { lo: lo, hi: Math.min(count, lo + NAV_WINDOW) };
}

function encodeRail(r) {
  r = r || {};
  var m = NAV_MARKER[r.marker] || 0, t = NAV_LINE[r.top] || 0, b = NAV_LINE[r.bottom] || 0;
  return m | t << 2 | b << 4;
}

// row = {type, text, sub, meters, dir, color, rail, fold?, head rows: open, route, badge} → {NAV_INDEX: i, NAV_KIND,
// NAV_TEXT, NAV_SUB, NAV_DIST (the row's length, '' when unknown), NAV_DIR, NAV_COLOR, NAV_RAIL; a header also NAV_ROUTE
// (the band: the route's name, "Walk") and NAV_BADGE}
function encodeNavRow(i, row, units) {
  row = row || {};
  var fold = row.type === 'head' ? (row.open ? NAV_OPEN : NAV_FOLDED) : row.fold ? NAV_FOLDED : 0;
  var msg = {
    NAV_INDEX: i,
    NAV_KIND: NAV_KIND.hasOwnProperty(row.type) ? NAV_KIND[row.type] : NAV_KIND.info,
    NAV_TEXT: truncateUtf8(row.text, NAV_TEXT_MAX_BYTES),
    NAV_SUB: truncateUtf8(row.sub, NAV_TEXT_MAX_BYTES),
    NAV_DIST: encodeDistance(typeof row.meters === 'number' ? row.meters : null, units),
    NAV_DIR: encodeDir(row.dir),
    NAV_COLOR: encodeColor(row.color),
    NAV_RAIL: encodeRail(row.rail) | fold
  };
  if (row.type === 'head') {
    msg.NAV_ROUTE = truncateUtf8(row.route, NAV_TEXT_MAX_BYTES);
    msg.NAV_BADGE = encodeBadge(row.badge);
  }
  return msg;
}

// The window of rows around `center`, the centre first and then outwards (what you look at arrives first).
function encodeNavRows(rows, units, center) {
  rows = rows || [];
  var w = navWindow(center, rows.length), out = [], c = Math.max(w.lo, Math.min(toInt(center), w.hi - 1));
  for (var d = 0; out.length < w.hi - w.lo; d++) {
    if (c + d < w.hi) out.push(encodeNavRow(c + d, rows[c + d], units));
    if (d > 0 && c - d >= w.lo) out.push(encodeNavRow(c - d, rows[c - d], units));
  }
  return out;
}

// A new list: [{NAV_COUNT: n, NAV_WINDOW: center, NAV_HEAD, NAV_HEAD_END}] then the window around `center` (the
// current row). head / headEnd: the header row and the last row of the open leg you are on (its header stays at the
// top while you look at its rows); -1 when there is none.
function encodeNavList(rows, units, center, head, headEnd) {
  rows = rows || [];
  var n = Math.min(rows.length, NAV_MAX_ROWS);
  center = Math.max(0, Math.min(toInt(center), n - 1));
  var h = typeof head === 'number' && head >= 0 && head < n ? toInt(head) : -1;
  var e = h >= 0 && typeof headEnd === 'number' ? Math.max(h, Math.min(toInt(headEnd), n - 1)) : -1;
  return [{ NAV_COUNT: n, NAV_WINDOW: center, NAV_HEAD: h, NAV_HEAD_END: e }].concat(encodeNavRows(rows.slice(0, n), units, center));
}

// Live guidance: n = {state: 'guiding' | 'arrived' | 'preview' (a trip's steps before it starts: no current row),
// current (row index), sub (time left...), distance (m to the step's target), bearing (deg, null = no arrow), units,
// show (open the trip view: a trip just started), title (the trip view's top line)}; null → {NAV_STATE: 0} (no trip).
function encodeNavLive(n) {
  if (!n) return { NAV_STATE: 0 };
  var state = NAV_STATE.hasOwnProperty(n.state) ? NAV_STATE[n.state] : n.state === 2 ? 2 : n.state === 3 ? 3 : 1;
  var msg = {
    NAV_STATE: state || 1,
    NAV_CURRENT: Math.max(0, toInt(n.current)),
    NAV_LSUB: truncateUtf8(n.sub, NAV_TEXT_MAX_BYTES),
    NAV_LDIST: encodeDistance(typeof n.distance === 'number' ? n.distance : null, n.units),
    NAV_BEARING: encodeBearing(n.bearing),
    NAV_TITLE: truncateUtf8(n.title, NAV_TEXT_MAX_BYTES)
  };
  if (n.show) msg.NAV_SHOW = 1;
  return msg;
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
  if (has(payload, 'PLACE_SELECT') && has(payload, 'LIST_ID')) {
    return { type: 'placeSelect', listId: Number(payload.LIST_ID), index: Number(payload.PLACE_SELECT) };
  }
  if (has(payload, 'PLACE_NAV') && has(payload, 'LIST_ID')) {
    return { type: 'navStart', places: true, listId: Number(payload.LIST_ID), index: Number(payload.PLACE_NAV) };
  }
  if (has(payload, 'NAV_START') && has(payload, 'LIST_ID')) {
    return { type: 'navStart', listId: Number(payload.LIST_ID), index: Number(payload.NAV_START) };
  }
  if (has(payload, 'NAV_STOP')) return { type: 'navStop' };
  if (has(payload, 'NAV_FETCH')) return { type: 'navFetch', index: Number(payload.NAV_FETCH) };
  if (has(payload, 'NAV_UNFOLD')) return { type: 'navUnfold', index: Number(payload.NAV_UNFOLD) };
  if (has(payload, 'NAV_GO')) return { type: 'navGo' };
  if (has(payload, 'UNDO_SELECT')) return { type: 'undoSelect' };
  if (has(payload, 'WATCH_PREFS')) return decodePrefs(payload.WATCH_PREFS);
  return null;
}

// WATCH_PREFS flags (sent by the watch once the phone talks to it): bit 0 = 24 h clock, bit 2 = the watch knows the
// user's measurement system, bit 1 = it is metric, bit 3 = it has the trip view (not aplite).
// → {type: 'prefs', clock24, units: 'metric'|'imperial'|null, nav}
var PREFS = { CLOCK24: 1, METRIC: 2, UNITS_KNOWN: 4, NAV: 8 };
function decodePrefs(v) {
  var n = Number(v) | 0;
  return { type: 'prefs', clock24: (n & PREFS.CLOCK24) !== 0,
           units: (n & PREFS.UNITS_KNOWN) ? ((n & PREFS.METRIC) ? 'metric' : 'imperial') : null,
           nav: (n & PREFS.NAV) !== 0 };
}

// Sends messages one at a time through sendFn(dict, onOk, onErr) (= Pebble.sendAppMessage).
// Each queued entry remembers its batch and which list it carries, if any: 'items' (an ITEM_COUNT header) or 'places'
// (PLACE_COUNT); a newer list of the same kind supersedes it.
var LIST_HEADERS = { ITEM_COUNT: 'items', PLACE_COUNT: 'places', NAV_COUNT: 'nav' };
function listKind(messages) {
  for (var i = 0; i < messages.length; i++) {
    for (var h in LIST_HEADERS) {
      if (LIST_HEADERS.hasOwnProperty(h) && messages[i] && Object.prototype.hasOwnProperty.call(messages[i], h)) return LIST_HEADERS[h];
    }
  }
  return '';
}

// opts.timeout (ms, optional): a send that is neither acknowledged nor refused by then counts as failed, so a phone app
// that never calls back (seen with some companion apps when a message can't be converted) can't stall the queue.
function createSender(sendFn, opts) {
  var retries = opts && typeof opts.retries === 'number' ? opts.retries : 2;
  var timeout = opts && typeof opts.timeout === 'number' && opts.timeout > 0 ? opts.timeout : 0;
  var setT = (opts && opts.setTimeout) || (typeof setTimeout === 'function' ? setTimeout : null);
  var clearT = (opts && opts.clearTimeout) || (typeof clearTimeout === 'function' ? clearTimeout : null);
  var queue = [];       // [{ msg, batch, list }] not yet sent (list: '' | 'items' | 'places')
  var inFlight = null;  // { msg, batch, list, failures }
  var batches = 0;      // batch id counter
  var listBatch = {};   // list kind → id of its newest batch

  function stale(entry) {
    return !!entry.list && entry.batch !== listBatch[entry.list];
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
    var timer = timeout && setT ? setT(function () { timer = null; onErr(new Error('timeout')); }, timeout) : null;
    function settle() {
      done = true;
      if (timer !== null && clearT) clearT(timer);
      timer = null;
    }
    function onOk() {
      if (done) return;
      settle();
      inFlight = null;
      next();
    }
    function onErr() {
      if (done) return;
      settle();
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
    // A batch carrying a new list (ITEM_COUNT, PLACE_COUNT or NAV_COUNT header) drops the queued messages of earlier batches of the
    // same list; everything else queued (the other list, status, wakeups, notify) stays, in order. Others are appended.
    sendAll: function (messages) {
      messages = (messages || []).slice();
      var kind = listKind(messages);
      var i;
      var id = ++batches;
      if (kind) {
        listBatch[kind] = id;
        var kept = [];
        for (i = 0; i < queue.length; i++) if (queue[i].list !== kind) kept.push(queue[i]);
        queue = kept;
      }
      for (i = 0; i < messages.length; i++) queue.push({ msg: messages[i], batch: id, list: kind });
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
  encodeNavList: encodeNavList,
  encodePlaces: encodePlaces,
  MAX_PLACES: MAX_PLACES,
  PLACE_TEXT_MAX_BYTES: PLACE_TEXT_MAX_BYTES,
  encodeNavLive: encodeNavLive,
  encodeNavRows: encodeNavRows,
  navWindow: navWindow,
  NAV_WINDOW: NAV_WINDOW,
  NAV_WINDOW_BEFORE: NAV_WINDOW_BEFORE,
  NAV_MAX_ROWS: NAV_MAX_ROWS,
  NAV_KIND: NAV_KIND,
  NAV_MARKER: NAV_MARKER,
  NAV_LINE: NAV_LINE,
  NAV_FOLDED: NAV_FOLDED,
  NAV_OPEN: NAV_OPEN,
  NAV_STATE: NAV_STATE,
  encodeWakeups: encodeWakeups,
  encodeNotify: encodeNotify,
  encodeWeather: encodeWeather,
  WEATHER_MAX_HOURS: WEATHER_MAX_HOURS,
  decodeWatchMessage: decodeWatchMessage,
  PREFS: PREFS,
  createSender: createSender
};
