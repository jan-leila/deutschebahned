// What the navigation window shows (CONTRACTS.md §18): the steps folded into rows. The leg you are on is open
// (the last and next few turns of a walk; the stops behind and ahead of a ride, down to the one you get off at), every
// other leg is one or two rows. Each row carries its rail: a hollow circle in the route's colour at a stop, a line to
// the next stop of the same ride, a dashed line through walking. Pure. ES5.

var format = require('./format');

var BEFORE = 2;   // rows of the open leg kept behind its current one
var AFTER = 3;    // ... and ahead of it (the leg's last row is always kept)

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

function isWalk(st) { return st.type === 'walk' || st.type === 'turn'; }
function isRide(st) { return st.type === 'board' || st.type === 'ride'; }
function isTerminal(st) { return st.type === 'wait' || st.type === 'arrive' || st.type === 'info'; }

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

function stepRow(st, index, leg) {
  return { type: st.type, text: st.text, sub: st.sub || '', meters: st.meters, dir: st.dir || '', color: st.color,
           step: index, leg: leg };
}

// a walk you are not on: its first step stands for all of it (a routed walk: its turns' total length)
function walkSummary(steps, L, leg, o) {
  var first = steps[L.from], s = first.walk || first;
  if (L.from === L.to && !first.walk) return stepRow(first, L.from, leg);
  var meters = 0, known = true;
  for (var i = L.from; i <= L.to; i++) {
    if (typeof steps[i].meters === 'number') meters += steps[i].meters;
    else known = false;
  }
  var sub = (known ? format.walk(format.walkSeconds(meters, o.walkSpeed)) + ' walk' : '') +
            (s.note ? (known ? ' · ' : '') + s.note : '');
  return { type: 'walk', text: s.text, sub: sub, meters: known ? meters : undefined, dir: '', color: s.color,
           step: L.from, leg: leg };
}

function walkRows(steps, L, leg, i, o) {
  if (i < L.from || i > L.to) return [walkSummary(steps, L, leg, o)];
  var out = [], parts = foldRange(L.from, L.to, i, BEFORE, AFTER);
  for (var p = 0; p < parts.length; p++) {
    if (parts[p].k !== undefined) out.push(stepRow(steps[parts[p].k], parts[p].k, leg));
    else out.push({ type: 'fold', text: plural(parts[p].fold, parts[p].before ? 'earlier turn' : 'more turn',
                                              parts[p].before ? 'earlier turns' : 'more turns'),
                    sub: '', color: steps[L.from].color, step: -1, leg: leg });
  }
  return out;
}

function rideRows(steps, L, leg, i) {
  var board = null, ride = null, end = null, boardAt = -1, rideAt = -1, endAt = -1;
  for (var s = L.from; s <= L.to; s++) {
    if (steps[s].type === 'board') { board = steps[s]; boardAt = s; }
    else if (steps[s].type === 'ride') { ride = steps[s]; rideAt = s; }
    else { end = steps[s]; endAt = s; }
  }
  var color = (ride || board).color, out = [];
  var stops = ride && ride.stops && ride.stops.length >= 2 ? ride.stops : null;
  var last = stops ? stops.length - 1 : 1;
  var alightName = stops ? stops[last].name : '';

  // the row of stop k (0 = where you board, last = where you get off)
  function stopRow(k) {
    if (k === 0 && board) return stepRow(board, boardAt, leg);
    if (k === last) {
      if (end) return stepRow(end, endAt, leg);
      var r = stepRow(ride, rideAt, leg);
      r.type = 'ride';
      if (stops) {
        r.text = 'Get off at ' + (alightName || ride.text);
        r.sub = plural(last, 'stop', 'stops') + (ride.sub ? ' · ' + ride.sub : '');
      }
      return r;
    }
    var name = stops ? stops[k].name : '';
    return { type: 'stop', text: name || 'Stop ' + k, sub: '', color: color, step: -1, leg: leg };
  }

  if (!stops) {   // stops along the way unknown: boarding, the ride, its end
    if (board) out.push(stepRow(board, boardAt, leg));
    if (ride) out.push(stepRow(ride, rideAt, leg));
    if (end) out.push(stepRow(end, endAt, leg));
    for (var q = 0; q < out.length; q++) out[q].marker = 'stop';
    return out;
  }
  var open = i >= L.from && i <= L.to, here = -1, c;
  if (!open) {
    out.push(stopRow(0), stopRow(last));
  } else {
    // where you are along the ride: boarding → its first stop, riding → the last stop passed, at the end → its last
    c = i === boardAt ? 0 : i === rideAt ? Math.max(0, Math.min(last, ride.at || 0)) : last;
    if (i === rideAt) here = c;
    var parts = foldRange(0, last, c, BEFORE, AFTER);
    for (var p = 0; p < parts.length; p++) {
      if (parts[p].k !== undefined) {
        var row = stopRow(parts[p].k);
        if (parts[p].k === here) {
          row.here = true;
          if (here < last) row.sub = plural(last - here, 'stop', 'stops') + ' to ' + (alightName || 'your stop');
        }
        out.push(row);
      } else {
        out.push({ type: 'fold', text: plural(parts[p].fold, parts[p].before ? 'earlier stop' : 'more stop',
                                             parts[p].before ? 'earlier stops' : 'more stops'),
                   sub: '', color: color, step: -1, leg: leg });
      }
    }
  }
  for (var r2 = 0; r2 < out.length; r2++) if (out[r2].type !== 'fold') out[r2].marker = out[r2].here ? 'here' : 'stop';
  return out;
}

// steps (described, see nav.js), i = the current step, o = {walkSpeed} → {rows, current: index of the current row}.
// Row = {type, text, sub, meters, dir, color, rail: {marker, top, bottom}, step: step index | -1, leg}.
function build(steps, i, o) {
  o = o || {};
  var legs = legsOf(steps || []), rows = [], current = -1, l, r;
  for (l = 0; l < legs.length; l++) {
    var L = legs[l], part;
    if (L.kind === 'walk') part = walkRows(steps, L, l, i, o);
    else if (L.kind === 'ride') part = rideRows(steps, L, l, i);
    else part = [stepRow(steps[L.from], L.from, l)];
    for (r = 0; r < part.length; r++) {
      part[r].legKind = L.kind;
      if (L.kind === 'other' && part[r].type !== 'info') part[r].marker = 'stop';
      rows.push(part[r]);
    }
  }
  // the current row: the stop you are at on a ride, else the current step's own row
  for (r = 0; r < rows.length && current < 0; r++) if (rows[r].here) current = r;
  for (r = 0; r < rows.length && current < 0; r++) if (rows[r].step === i) current = r;
  if (current < 0) current = 0;
  // rails: the rows of one ride are joined by its line, everything else by the walking dashes
  for (r = 0; r < rows.length; r++) {
    rows[r].rail = { marker: rows[r].marker || 'none', top: r > 0 ? join(rows[r - 1], rows[r]) : 'none',
                     bottom: r + 1 < rows.length ? join(rows[r], rows[r + 1]) : 'none' };
  }
  for (r = 0; r < rows.length; r++) {
    delete rows[r].marker; delete rows[r].here; delete rows[r].legKind;
  }
  return { rows: rows, current: current };
}

function join(a, b) {
  if (a.type === 'info' || b.type === 'info') return 'none';
  return a.leg === b.leg && a.legKind === 'ride' ? 'line' : 'dash';
}

module.exports = { build: build, foldRange: foldRange, BEFORE: BEFORE, AFTER: AFTER };
