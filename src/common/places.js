// Saved locations as watch tiles (CONTRACTS.md §19): the list above the first row (UP from the top), ranked like the
// main list. Pure; requires only geo / format. ES5.

var geo = require('./geo');
var format = require('./format');

var MAX_PLACES = 8;   // the watch keeps at most this many (fewer on aplite: it shows the first ones)

// config: a runtime view (view.build) → [{kind: 'place', key: 'place:<id>', placeId, title, address, color: '',
//   bearing, distance, walk, features: {'place:<id>': round(distance)}}] in config order; no pos → no bearing /
//   distance / walk, feature 0
function buildItems(config, pos) {
  var list = (config && config.places) || [], out = [];
  var speed = config && config.schedule ? config.schedule.walkSpeed : null;
  for (var i = 0; i < list.length && out.length < MAX_PLACES; i++) {
    var p = list[i];
    if (!p || typeof p.lat !== 'number' || typeof p.lon !== 'number') continue;
    var d = pos ? geo.distance(pos, p) : null, f = {};
    f['place:' + p.id] = d === null ? 0 : Math.round(d);
    out.push({ kind: 'place', key: 'place:' + p.id, placeId: p.id, title: p.name, address: p.address || '', color: '',
               bearing: pos ? geo.bearing(pos, p) : null, distance: d, walk: d === null ? null : format.walkSeconds(d, speed),
               lat: p.lat, lon: p.lon, features: f });
  }
  return out;
}

module.exports = { MAX_PLACES: MAX_PLACES, buildItems: buildItems };
