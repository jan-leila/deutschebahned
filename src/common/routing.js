// Optional walking-route source for navigation (CONTRACTS.md §18): the user's own routing service, called through a URL
// template, turns "walk to this stop" into a list of waypoints with instructions. Without one, navigation is a plain
// arrow to the stop. http is injected. ES5.

var MAX_WAYPOINTS = 40;

function coord(v) {
  return String(Math.round(v * 1000000) / 1000000);
}

function finite(v) {
  return typeof v === 'number' && isFinite(v);
}

function validPoint(p) {
  return !!p && finite(p.lat) && finite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
}

// Only http(s) templates with at least a {toLat}/{toLon} (or {to}) placeholder are usable.
function usable(template) {
  return typeof template === 'string' && /^https?:\/\//i.test(template) && /\{to(Lat|Lon)?\}/.test(template);
}

// Placeholders: {fromLat} {fromLon} {toLat} {toLon}, and {from} / {to} = "lat,lon". Coordinates have 6 decimals.
function url(template, from, to) {
  return template
    .replace(/\{fromLat\}/g, coord(from.lat)).replace(/\{fromLon\}/g, coord(from.lon))
    .replace(/\{toLat\}/g, coord(to.lat)).replace(/\{toLon\}/g, coord(to.lon))
    .replace(/\{from\}/g, coord(from.lat) + ',' + coord(from.lon))
    .replace(/\{to\}/g, coord(to.lat) + ',' + coord(to.lon));
}

function thin(points) {
  if (points.length <= MAX_WAYPOINTS) return points;
  var out = [];
  for (var i = 0; i < MAX_WAYPOINTS; i++) out.push(points[Math.round(i * (points.length - 1) / (MAX_WAYPOINTS - 1))]);
  return out;
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.substring(1) : s;
}

// An OSRM-style maneuver → "Turn left onto Pine St".
function maneuverText(step) {
  var m = step && step.maneuver;
  if (!m) return '';
  var type = String(m.type || ''), mod = String(m.modifier || '').replace(/_/g, ' ');
  var name = typeof step.name === 'string' ? step.name : '';
  var verb;
  if (type === 'depart') verb = 'Head ' + (mod || 'out');
  else if (type === 'arrive') return 'Arrive';
  else if (type === 'roundabout' || type === 'rotary') verb = 'Take the roundabout';
  else if (type === 'continue' || mod === 'straight') verb = 'Continue straight';
  else verb = mod ? (/^(slight |sharp )?(left|right)$/.test(mod) ? 'Turn ' : 'Go ') + mod : capitalize(type.replace(/_/g, ' '));
  return verb + (name ? ' on ' + name : '');
}

// The routing response → [{lat, lon, text}], at most MAX_WAYPOINTS; throws when it holds no route. Understands
//   {steps: [{text, lat, lon}]}                      (the simple form: build a service in a few lines)
//   {points: [{lat, lon}]} / {points: [[lat, lon]]}
//   OSRM / Valhalla-OSRM:  routes[0].legs[].steps[].maneuver.location = [lon, lat] (instructions), else
//                          routes[0].geometry.coordinates = [[lon, lat]] (GeoJSON, no instructions)
function parse(body) {
  if (!body || typeof body !== 'object') throw new Error('unexpected routing response');
  var out = [], i, j;
  if (body.steps instanceof Array) {
    for (i = 0; i < body.steps.length; i++) {
      var s = body.steps[i];
      if (validPoint(s)) out.push({ lat: s.lat, lon: s.lon, text: typeof s.text === 'string' ? s.text : '' });
    }
  } else if (body.points instanceof Array) {
    for (i = 0; i < body.points.length; i++) {
      var p = body.points[i];
      if (p instanceof Array) p = { lat: p[0], lon: p[1] };
      if (validPoint(p)) out.push({ lat: p.lat, lon: p.lon, text: '' });
    }
  } else if (body.routes instanceof Array && body.routes[0]) {
    var r = body.routes[0], legs = r.legs instanceof Array ? r.legs : [];
    for (i = 0; i < legs.length; i++) {
      var steps = legs[i] && legs[i].steps instanceof Array ? legs[i].steps : [];
      for (j = 0; j < steps.length; j++) {
        var loc = steps[j] && steps[j].maneuver && steps[j].maneuver.location;
        if (loc instanceof Array && validPoint({ lat: loc[1], lon: loc[0] })) {
          out.push({ lat: loc[1], lon: loc[0], text: maneuverText(steps[j]) });
        }
      }
    }
    var coords = r.geometry && r.geometry.coordinates;
    if (!out.length && coords instanceof Array) {
      for (i = 0; i < coords.length; i++) {
        if (coords[i] instanceof Array && validPoint({ lat: coords[i][1], lon: coords[i][0] })) {
          out.push({ lat: coords[i][1], lon: coords[i][0], text: '' });
        }
      }
    }
  }
  if (!out.length) throw new Error('no route in the routing response');
  return thin(out);
}

// fetcher(template, from, to, cb(err, waypoints)); cb is called exactly once.
function createFetcher(http) {
  return function (template, from, to, cb) {
    if (!usable(template) || !validPoint(from) || !validPoint(to)) {
      cb(new Error('no routing source'));
      return;
    }
    http(url(template, from, to), function (err, body) {
      if (err) return cb(err);
      var points;
      try {
        points = parse(body);
      } catch (e) {
        return cb(e);
      }
      cb(null, points);
    });
  };
}

module.exports = { usable: usable, url: url, parse: parse, createFetcher: createFetcher, MAX_WAYPOINTS: MAX_WAYPOINTS };
