// Pinned list tiles for scheduled trips in progress (CONTRACTS.md §16). Pure, ES5. Requires only geo / format.
// One 'trip' tile per remaining bus leg of each active trip (triggers.activeTrips), shown above the ranked list.
var geo = require('./geo');
var format = require('./format');

var LEG_GRACE = 60;   // seconds a leg stays listed after its planned arrival

function stopCoords(data, routeId, stopId) {
  var route = data && data.routes && data.routes[routeId];
  var s = route && route.stops && route.stops[stopId];
  return s && typeof s.lat === 'number' && typeof s.lon === 'number' ? s : null;
}

// The label shown with every pinned tile ('Planned trip: Work · by 9:00 AM').
function tripLabel(destination, plan, opts) {
  return 'Planned trip: ' + destination.name + ' · by ' + format.clock(plan.arriveBy, !!(opts && opts.clock24));
}

// active = triggers.activeTrips(...); data = planner.gather Data (for stop coordinates); opts = {clock24}
// → Item[] (kind 'trip', pinned: true), trip order then leg order
function build(active, data, pos, now, opts) {
  var items = [];
  for (var t = 0; t < (active || []).length; t++) {
    var trip = active[t];
    var legs = (trip.plan && trip.plan.legs) || [];
    var label = tripLabel(trip.destination, trip.plan, opts);
    for (var i = 0; i < legs.length; i++) {
      var leg = legs[i];
      if (!leg || leg.mode !== 'bus' || leg.arriveAt + LEG_GRACE < now) continue;
      var riding = now >= leg.departAt;
      var stopId = riding ? leg.alightStopId : leg.boardStopId;
      var stop = stopCoords(data, leg.routeId, stopId);
      items.push({
        kind: 'trip',
        pinned: true,
        key: 'trip:' + trip.destination.id + ':' + i,
        destinationId: trip.destination.id,
        badge: leg.routeName || leg.routeId,
        title: (riding ? leg.alightStopName : leg.boardStopName) || stopId,
        routeLongName: label,
        color: leg.color || '',
        dir: leg.dir || '',
        times: [leg.departAt, leg.arriveAt, riding ? 1 : 0],
        routeId: leg.routeId,
        stopId: stopId,
        bearing: stop && pos ? geo.bearing(pos, stop) : null,
        distance: stop && pos ? geo.distance(pos, stop) : null,
        estimated: !!trip.plan.estimated,
        lanes: [],
        features: {}
      });
    }
  }
  return items;
}

module.exports = { build: build, tripLabel: tripLabel, LEG_GRACE: LEG_GRACE };
