// Geometry helpers shared by the planner, the providers and the tests.
// Points are {lat, lon} in degrees; distances are meters. ES5 (runs in PebbleKit JS).

var EARTH_RADIUS = 6371000;

function toRad(d) { return d * Math.PI / 180; }

// Great-circle distance in meters.
function distance(a, b) {
  var dLat = toRad(b.lat - a.lat);
  var dLon = toRad(b.lon - a.lon);
  var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Point moved `meters` from `p` towards `bearingDeg` (0 = north, 90 = east). Flat-earth; fine below ~50 km.
function offset(p, meters, bearingDeg) {
  var b = toRad(bearingDeg);
  var dLat = meters * Math.cos(b) / 111320;
  var dLon = meters * Math.sin(b) / (111320 * Math.cos(toRad(p.lat)));
  return { lat: p.lat + dLat, lon: p.lon + dLon };
}

// Initial great-circle bearing from a to b in degrees, 0 = north, 90 = east, in [0, 360). Same point → 0.
function bearing(a, b) {
  var p1 = toRad(a.lat), p2 = toRad(b.lat), dl = toRad(b.lon - a.lon);
  var y = Math.sin(dl) * Math.cos(p2);
  var x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  if (x === 0 && y === 0) return 0;
  var deg = Math.atan2(y, x) * 180 / Math.PI;
  return (deg + 360) % 360;
}

// Google encoded polyline (precision 1e5) -> [{lat, lon}]
function decodePolyline(str) {
  var points = [], index = 0, lat = 0, lon = 0;
  if (!str) return points;
  while (index < str.length) {
    var vals = [0, 0];
    for (var k = 0; k < 2; k++) {
      var shift = 0, result = 0, byte;
      do {
        byte = str.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index < str.length);
      vals[k] = (result & 1) ? ~(result >> 1) : (result >> 1);
    }
    lat += vals[0];
    lon += vals[1];
    points.push({ lat: lat / 1e5, lon: lon / 1e5 });
  }
  return points;
}

function encodeValue(v) {
  v = v < 0 ? ~(v << 1) : (v << 1);
  var out = '';
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  return out + String.fromCharCode(v + 63);
}

// [{lat, lon}] -> Google encoded polyline
function encodePolyline(points) {
  var out = '', pLat = 0, pLon = 0;
  for (var i = 0; i < points.length; i++) {
    var lat = Math.round(points[i].lat * 1e5), lon = Math.round(points[i].lon * 1e5);
    out += encodeValue(lat - pLat) + encodeValue(lon - pLon);
    pLat = lat; pLon = lon;
  }
  return out;
}

// Closest point of a path to p: {distance, index (segment start index), along (meters from path start)}.
// Uses a local equirectangular projection around p (accurate for the distances buses care about).
function nearestOnPath(p, path) {
  if (!path || path.length === 0) return { distance: Infinity, index: -1, along: 0 };
  if (path.length === 1) return { distance: distance(p, path[0]), index: 0, along: 0 };
  var kx = 111320 * Math.cos(toRad(p.lat)), ky = 110574;
  var best = { distance: Infinity, index: -1, along: 0 };
  var walked = 0;
  for (var i = 0; i < path.length - 1; i++) {
    var ax = (path[i].lon - p.lon) * kx, ay = (path[i].lat - p.lat) * ky;
    var bx = (path[i + 1].lon - p.lon) * kx, by = (path[i + 1].lat - p.lat) * ky;
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    var t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    var cx = ax + t * dx, cy = ay + t * dy;
    var d = Math.sqrt(cx * cx + cy * cy);
    var segLen = Math.sqrt(len2);
    if (d < best.distance) best = { distance: d, index: i, along: walked + t * segLen };
    walked += segLen;
  }
  return best;
}

// Smallest distance from p to any of the paths (Infinity when there are none).
function distanceToPaths(p, paths) {
  var best = Infinity;
  for (var i = 0; paths && i < paths.length; i++) {
    var d = nearestOnPath(p, paths[i]).distance;
    if (d < best) best = d;
  }
  return best;
}

module.exports = {
  bearing: bearing,
  distance: distance,
  offset: offset,
  decodePolyline: decodePolyline,
  encodePolyline: encodePolyline,
  nearestOnPath: nearestOnPath,
  distanceToPaths: distanceToPaths
};
