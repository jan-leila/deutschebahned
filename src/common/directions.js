// Travel-direction labels for stops: 'NB' | 'SB' | 'EB' | 'WB' | '' (CONTRACTS.md §12). Pure, ES5.
// Used by the planner (tile titles) and the router (trip descriptions).
var geo = require('./geo');

// 'Northbound', 'north', 'NB', 'N' ... → 'NB' (same for S/E/W); anything else → ''
function abbreviate(name) {
  if (typeof name !== 'string') return '';
  var m = name.replace(/^\s+/, '').match(/^(north|south|east|west|nb|sb|eb|wb|n|s|e|w)(bound|\b)/i);
  return m ? m[1].charAt(0).toUpperCase() + 'B' : '';
}

// compass quadrant of a bearing: [315, 45) → 'NB', [45, 135) → 'EB', [135, 225) → 'SB', [225, 315) → 'WB'
function fromBearing(deg) {
  if (typeof deg !== 'number' || !isFinite(deg)) return '';
  var d = ((deg % 360) + 360) % 360;
  if (d >= 315 || d < 45) return 'NB';
  if (d < 135) return 'EB';
  if (d < 225) return 'SB';
  return 'WB';
}

var NAMES = { NB: 'North', SB: 'South', EB: 'East', WB: 'West' };
// 'NB' → 'North', 'SB' → 'South', 'EB' → 'East', 'WB' → 'West'; anything else → '' (what the watch and notifications show)
function fullName(code) {
  return Object.prototype.hasOwnProperty.call(NAMES, code) ? NAMES[code] : '';
}

function findDirection(route, directionId) {
  var dirs = (route && route.directions) || [];
  for (var i = 0; i < dirs.length; i++) if (String(dirs[i].id) === String(directionId)) return dirs[i];
  return null;
}

// Label of `direction` at `stopId`: the direction's name if it names a compass direction, else the
// heading from the stop to the next stop of the direction (from the previous stop when it is the last);
// '' when unknown (no coordinates, single-stop direction).
function label(route, direction, stopId) {
  if (typeof direction === 'string' || typeof direction === 'number') direction = findDirection(route, direction);
  if (!direction) return '';
  var named = abbreviate(direction.name);
  if (named) return named;
  var ids = direction.stopIds || [];
  var stops = (route && route.stops) || {};
  var k = -1;
  for (var i = 0; i < ids.length; i++) if (String(ids[i]) === String(stopId)) { k = i; break; }
  if (k < 0) return '';
  var a, b;
  if (k + 1 < ids.length) { a = stops[ids[k]]; b = stops[ids[k + 1]]; } else if (k > 0) { a = stops[ids[k - 1]]; b = stops[ids[k]]; }
  if (!a || !b || (a.lat === b.lat && a.lon === b.lon)) return '';
  return fromBearing(geo.bearing(a, b));
}

// directions of `route` whose stopIds contain stopId (in route order)
function directionsAt(route, stopId) {
  var out = [];
  var dirs = (route && route.directions) || [];
  for (var i = 0; i < dirs.length; i++) {
    var ids = dirs[i].stopIds || [];
    for (var j = 0; j < ids.length; j++) if (String(ids[j]) === String(stopId)) { out.push(dirs[i]); break; }
  }
  return out;
}

// label for a stop of a route: the label of its only direction; '' if it is served in 0 or ≥ 2 directions
function stopLabel(route, stopId) {
  var dirs = directionsAt(route, stopId);
  return dirs.length === 1 ? label(route, dirs[0], stopId) : '';
}

module.exports = { abbreviate: abbreviate, fromBearing: fromBearing, fullName: fullName, label: label, directionsAt: directionsAt, stopLabel: stopLabel };
