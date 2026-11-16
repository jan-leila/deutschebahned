// What the trip view shows (CONTRACTS.md §18): the steps as legs, each a header row (where it goes, its direction,
// length, arrival time and the stops / turns left; a ride's header carries its route like a home-screen tile) with its
// steps folded out under it: the time and length of each one still ahead. The leg you are on is open (the last and next
// few turns of a walk; the stops behind and ahead of a ride, down to the one you get off at), the others are their
// header only until opened. Each step row carries its rail: a hollow circle in the route's colour at a stop, a line to the
// next stop of the same ride, a dashed line through walking. Pure. ES5.

var format = require('./format');
var geo = require('./geo');
var directions = require('./directions');

var BEFORE = 2;          // rows of an open leg kept behind its current one
var AFTER = 3;           // ... and ahead of it (the leg's last row is always kept)
var RIDE_SPEED = 6;      // m/s: a ride with no times
var WALK_COLOR = '555555';

function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : many);
}

// Indices lo..hi (inclusive) around c: [{k}] for the ones shown, [{fold: n, before}] for a run of n hidden ones. The
// last index always shows; a fold of one is just that index.
function foldRange(lo, hi, c, before, after) {
  var out = [], from = Math.max(lo, c - before), to = Math.min(hi, c + after), k;
  if (from - lo === 1) from = lo;
  if (from > lo) out.push({ fold: from - lo, before: true });
  for (k = from; k <= to; k++) out.push({ k: k });
  if (to < hi) {
    var rest = hi - 1 - to;
    if (rest === 1) out.push({ k: hi - 1 });
    else if (rest > 1) out.push({ fold: rest, before: false });
    out.push({ k: hi });
  }
  return out;
}

function allRange(lo, hi) {
  var out = [];
  for (var k = lo; k <= hi; k++) out.push({ k: k });
  return out;
}

function isWalk(st) { return st.type === 'walk' || st.type === 'turn'; }
function isRide(st) { return st.type === 'board' || st.type === 'ride'; }
function isTerminal(st) { return st.type === 'wait' || st.type === 'arrive' || st.type === 'info'; }
function num(v) { return typeof v === 'number' && isFinite(v); }

// Steps split into legs: a walk (one walk step or its turns), a ride (board? ride, and a wait / arrive step right
// after it, which happens at the stop you get off at), or a single other step. → [{from, to, kind: 'walk'|'ride'|'other'}]
function legsOf(steps) {
  var legs = [], i = 0;
  while (i < steps.length) {
    var st = steps[i], j = i;
    if (isWalk(st)) {
      while (j + 1 < steps.length && steps[j + 1].type === 'turn' && steps[j + 1].leg === st.leg) j++;
      legs.push({ from: i, to: j, kind: 'walk' });
    } else if (isRide(st)) {
      if (st.type === 'board' && j + 1 < steps.length && steps[j + 1].type === 'ride') j++;
      if (j + 1 < steps.length && isTerminal(steps[j + 1]) && steps[j + 1].type !== 'info') j++;
      legs.push({ from: i, to: j, kind: 'ride' });
    } else {
      legs.push({ from: i, to: j, kind: 'other' });
    }
    i = j + 1;
  }
  return legs;
}

// When each step from the current one on ends (epoch s): walking at o.walkSpeed (the current step from o.live metres
// away), a bus at its departure / arrival, a wait until its next time. From o.start (a preview: the plan's leave time) or
// o.now. Steps behind the current one: undefined.
function etas(steps, i, o) {
  var t = num(o.start) ? o.start : o.now, out = [], speed = o.walkSpeed > 0 ? o.walkSpeed : 1.3;
  if (!num(t)) return out;
  for (var k = Math.max(0, i); k < steps.length; k++) {
    var st = steps[k];
    if (isWalk(st)) {
      var m = k === i && num(o.live) ? o.live : st.meters;
      if (num(m)) t += Math.ceil(m / speed);
    } else if (st.type === 'board') {
      if (num(st.departAt)) t = Math.max(t, st.departAt);
    } else if (st.type === 'ride') {
      if (num(st.arriveAt)) t = Math.max(t, st.arriveAt);
      else if (st.stops) t += Math.round(alongMeters(st.stops, st.at || 0, st.stops.length - 1) / RIDE_SPEED);
      else if (k === i && num(o.live)) t += Math.round(o.live / RIDE_SPEED);
    } else if (st.type === 'wait') {
      var times = st.times || [];
      for (var q = 0; q < times.length; q++) if (times[q] && times[q] >= t) { t = times[q]; break; }
    }
    out[k] = t;
  }
  return out;
}

// metres along stops[a..b]
function alongMeters(stops, a, b) {
  var m = 0;
  for (var k = a + 1; k <= b && k < stops.length; k++) m += geo.distance(stops[k - 1], stops[k]);
  return m;
}

function stepRow(st, index, leg) {
  return { type: st.type, text: st.text, sub: st.sub || '', meters: st.meters, dir: st.dir || '', color: st.color,
           step: index, leg: leg };
}

function clockOf(t, o) {
  return num(t) ? format.clock(t, !!o.clock24) : '';
}

// a step still ahead: its time; the rest of its detail after it
function ahead(row, t, o) {
  var c = clockOf(t, o);
  if (c) row.sub = c + (row.sub ? ' · ' + row.sub : '');
  return row;
}

function joinParts(parts) {
  var out = [];
  for (var i = 0; i < parts.length; i++) if (parts[i]) out.push(parts[i]);
  return out.join(' · ');
}

// ---- walks

function walkTarget(steps, L) {
  var first = steps[L.from], s = first.walk || first;
  return s.toName || String(s.text || '').replace(/^Walk to /, '');
}

function walkHead(steps, L, l, i, t, o) {
  var first = steps[L.from], s = first.walk || first, meters = 0, known = true, k;
  var from = i >= L.from && i <= L.to ? i : L.from;
  for (k = from; k <= L.to; k++) {   // whole steps (the live distance would change the row on every fix)
    if (num(steps[k].meters)) meters += steps[k].meters;
    else known = false;
  }
  var turns = L.to - from;   // the turns still to make (the last one is getting there)
  var arrive = t[L.to];
  return { type: 'head', text: walkTarget(steps, L), route: 'Walk' + (s.note ? ' · ' + s.note : ''), badge: '',
           sub: joinParts([arrive ? 'arr ' + clockOf(arrive, o) : '', first.type === 'turn' && turns > 0 ? plural(turns, 'turn', 'turns') : '']),
           meters: known ? meters : undefined, dir: first.dir || '', color: WALK_COLOR, step: L.from, leg: l };
}

function walkRows(steps, L, l, i, t, o, all) {
  var open = i >= L.from && i <= L.to, out = [];
  var parts = all ? allRange(L.from, L.to) : foldRange(L.from, L.to, open ? i : L.from, BEFORE, AFTER);
  for (var p = 0; p < parts.length; p++) {
    var k = parts[p].k;
    if (k !== undefined) {
      var r = stepRow(steps[k], k, l);
      if (steps[k].type === 'turn') r.sub = '';
      out.push(k > i ? ahead(r, t[k], o) : r);
    } else {
      out.push({ type: 'fold', text: plural(parts[p].fold, parts[p].before ? 'earlier turn' : 'more turn',
                                            parts[p].before ? 'earlier turns' : 'more turns'),
                 sub: '', color: steps[L.from].color, step: -1, leg: l, fold: true });
    }
  }
  return out;
}

// ---- rides

function ridePieces(steps, L) {
  var r = { board: null, ride: null, end: null, boardAt: -1, rideAt: -1, endAt: -1 };
  for (var s = L.from; s <= L.to; s++) {
    if (steps[s].type === 'board') { r.board = steps[s]; r.boardAt = s; }
    else if (steps[s].type === 'ride') { r.ride = steps[s]; r.rideAt = s; }
    else { r.end = steps[s]; r.endAt = s; }
  }
  r.stops = r.ride && r.ride.stops && r.ride.stops.length >= 2 ? r.ride.stops : null;
  r.last = r.stops ? r.stops.length - 1 : 1;
  r.color = (r.ride || r.board).color;
  return r;
}

function rideHead(steps, L, l, i, t, o, P) {
  var lead = P.board || P.ride, name = P.stops ? P.stops[P.last].name : '';
  if (!name && P.ride) name = P.ride.toName || String(P.ride.text || '').replace(/^Ride to /, '');
  var riding = i === P.rideAt, at = riding ? Math.max(0, Math.min(P.last, P.ride.at || 0)) : 0;
  var meters = P.stops ? alongMeters(P.stops, at, P.last) : (P.ride && num(P.ride.meters) ? P.ride.meters : undefined);
  var left = P.stops ? P.last - at : 0;
  var arrive = P.ride && num(P.ride.arriveAt) ? P.ride.arriveAt : t[P.rideAt];
  return { type: 'head', text: name || lead.text, route: lead.route || '', badge: lead.badge || '',
           sub: joinParts([directions.fullName(lead.dir || ''), arrive ? 'arr ' + clockOf(arrive, o) : '',
                           left > 0 ? plural(left, 'stop', 'stops') : '']),
           meters: meters, dir: lead.dir || '', color: P.color, step: L.from, leg: l };
}

// the time at stop k of a ride: between boarding and getting off by the distance along its stops
function stopTimes(P, t, o) {
  var tb = P.board && num(P.board.departAt) ? P.board.departAt : (P.boardAt >= 0 ? t[P.boardAt] : undefined);
  var ta = P.ride && num(P.ride.arriveAt) ? P.ride.arriveAt : t[P.rideAt];
  var out = [];
  if (!P.stops || !num(tb) || !num(ta)) return out;
  var total = alongMeters(P.stops, 0, P.last), m = 0;
  for (var k = 0; k <= P.last; k++) {
    if (k > 0) m += geo.distance(P.stops[k - 1], P.stops[k]);
    out[k] = Math.round(tb + (total > 0 ? (ta - tb) * m / total : 0));
  }
  return out;
}

function rideRows(steps, L, l, i, t, o, all, P) {
  var out = [], stops = P.stops, last = P.last, q;
  var alightName = stops ? stops[last].name : '';
  var times = stopTimes(P, t, o);

  // the row of stop k (0 = where you board, last = where you get off)
  function stopRow(k) {
    var r;
    if (k === 0 && P.board) {
      r = stepRow(P.board, P.boardAt, l);
    } else if (k === last) {
      if (P.end) {
        r = stepRow(P.end, P.endAt, l);
      } else {
        r = stepRow(P.ride, P.rideAt, l);
        r.type = 'ride';
        if (stops) {
          r.text = 'Get off at ' + (alightName || P.ride.text);
          r.sub = '';
        }
      }
    } else {
      r = { type: 'stop', text: (stops && stops[k].name) || 'Stop ' + k, sub: '', color: P.color, step: -1, leg: l };
    }
    if (stops && k > 0) r.meters = geo.distance(stops[k - 1], stops[k]);
    return r;
  }

  if (!stops) {   // stops along the way unknown: boarding, the ride, its end
    if (P.board) out.push(stepRow(P.board, P.boardAt, l));
    if (P.ride) out.push(stepRow(P.ride, P.rideAt, l));
    if (P.end) out.push(P.endAt > i ? ahead(stepRow(P.end, P.endAt, l), t[P.endAt], o) : stepRow(P.end, P.endAt, l));
    for (q = 0; q < out.length; q++) out[q].marker = 'stop';
    return out;
  }
  var open = i >= L.from && i <= L.to, here = -1;
  // where you are along the ride: boarding → its first stop, riding → the last stop passed, at the end → its last
  var c = !open ? 0 : i === P.boardAt ? 0 : i === P.rideAt ? Math.max(0, Math.min(last, P.ride.at || 0)) : last;
  if (open && i === P.rideAt) here = c;
  var parts = all ? allRange(0, last) : foldRange(0, last, c, BEFORE, AFTER);
  for (var p = 0; p < parts.length; p++) {
    var k = parts[p].k;
    if (k !== undefined) {
      var row = stopRow(k);
      if (k === here) row.here = true;
      // the stops still ahead: their time (the board row has its own)
      if ((!open || k > c || (k === c && i === P.boardAt)) && !(k === 0 && P.board)) ahead(row, times[k], o);
      out.push(row);
    } else {
      out.push({ type: 'fold', text: plural(parts[p].fold, parts[p].before ? 'earlier stop' : 'more stop',
                                           parts[p].before ? 'earlier stops' : 'more stops'),
                 sub: '', color: P.color, step: -1, leg: l, fold: true });
    }
  }
  for (var r2 = 0; r2 < out.length; r2++) if (out[r2].type !== 'fold') out[r2].marker = out[r2].here ? 'here' : 'stop';
  return out;
}

// steps (described, see nav.js), i = the current step, o = {walkSpeed, clock24, now, start (a preview's first time),
// live (m to the current step's target), open: {leg: bool} (a leg opened / closed on the watch; else the leg you are on
// is open), expand: {leg: true} (an open leg with every row shown), preview (no current row)}
// → {rows, current: index of the current row, head / headEnd: the rows of the leg you are on (head -1: it is closed),
//    legs: [{head: row index, from, to (steps)}]}.
// Row = {type, text, sub, meters, dir, color, rail: {marker, top, bottom}, step: step index | -1, leg, fold?: true (a run
// of hidden rows), head rows also {route, badge, open}}.
function build(steps, i, o) {
  o = o || {};
  steps = steps || [];
  var legs = legsOf(steps), rows = [], current = -1, head = -1, headEnd = -1, l, r, out = [];
  var t = etas(steps, i, o), openMap = o.open || {}, expand = o.expand || {};
  for (l = 0; l < legs.length; l++) {
    var L = legs[l], part, hd = null, onLeg = !o.preview && i >= L.from && i <= L.to;
    var isOpen = openMap.hasOwnProperty(l) ? !!openMap[l] : onLeg;
    if (L.kind === 'walk') {
      hd = walkHead(steps, L, l, i, t, o);
      part = isOpen ? walkRows(steps, L, l, i, t, o, !!expand[l]) : [];
    } else if (L.kind === 'ride') {
      var P = ridePieces(steps, L);
      hd = rideHead(steps, L, l, i, t, o, P);
      part = isOpen ? rideRows(steps, L, l, i, t, o, !!expand[l], P) : [];
    } else {
      var one = stepRow(steps[L.from], L.from, l);
      part = [L.from > i ? ahead(one, t[L.from], o) : one];
    }
    var start = rows.length;
    if (hd) {
      hd.open = isOpen;
      hd.legKind = L.kind;
      rows.push(hd);
    }
    for (r = 0; r < part.length; r++) {
      part[r].legKind = L.kind;
      if (L.kind === 'other' && part[r].type !== 'info') part[r].marker = 'stop';
      rows.push(part[r]);
    }
    out.push({ head: hd ? start : -1, from: L.from, to: L.to });
    if (onLeg) {
      head = hd && isOpen ? start : -1;
      headEnd = rows.length - 1;
      if (!isOpen) current = start;
    }
  }
  // the current row: the stop you are at on a ride, else the current step's own row
  if (!o.preview) {
    for (r = 0; r < rows.length && current < 0; r++) if (rows[r].here) current = r;
    for (r = 0; r < rows.length && current < 0; r++) if (rows[r].step === i && rows[r].type !== 'head') current = r;
  }
  if (current < 0) current = 0;
  // rails: the rows of one ride are joined by its line, a walk's by the walking dashes; a header stands apart
  for (r = 0; r < rows.length; r++) {
    rows[r].rail = { marker: rows[r].marker || 'none', top: r > 0 ? join(rows[r - 1], rows[r]) : 'none',
                     bottom: r + 1 < rows.length ? join(rows[r], rows[r + 1]) : 'none' };
  }
  for (r = 0; r < rows.length; r++) {
    delete rows[r].marker; delete rows[r].here; delete rows[r].legKind;
  }
  return { rows: rows, current: current, head: head, headEnd: head >= 0 ? headEnd : -1, legs: out };
}

function join(a, b) {
  if (a.type === 'info' || b.type === 'info' || a.type === 'head' || b.type === 'head') return 'none';
  return a.leg === b.leg && a.legKind === 'ride' ? 'line' : 'dash';
}

module.exports = { build: build, foldRange: foldRange, etas: etas, BEFORE: BEFORE, AFTER: AFTER, WALK_COLOR: WALK_COLOR };
