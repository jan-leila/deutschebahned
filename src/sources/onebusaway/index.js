'use strict';
// OneBusAway REST v2 provider. ES5 only (runs in PebbleKit JS).
var geo = require('../../common/geo');
var util = require('../util');

var DEFAULT_BASE_URL = 'https://api.pugetsound.onebusaway.org/api/where';
var DEFAULT_API_KEY = 'TEST';

// stable sort helper: sorts arr by key(x) ascending, ties keep original order
function sortBy(arr, key) {
  var tagged = [];
  var i;
  for (i = 0; i < arr.length; i++) tagged.push({ k: key(arr[i]), i: i, v: arr[i] });
  tagged.sort(function (a, b) { return a.k !== b.k ? a.k - b.k : a.i - b.i; });
  var out = [];
  for (i = 0; i < tagged.length; i++) out.push(tagged[i].v);
  return out;
}

function decodeAll(polylines) {
  var paths = [];
  if (!polylines) return paths;
  for (var i = 0; i < polylines.length; i++) {
    if (polylines[i] && typeof polylines[i].points === 'string') paths.push(geo.decodePolyline(polylines[i].points));
  }
  return paths;
}

function strList(a) {
  var out = [];
  if (!a) return out;
  for (var i = 0; i < a.length; i++) out.push(String(a[i]));
  return out;
}

function createOneBusAway(opts, http) {
  var baseUrl = String((opts && opts.baseUrl) || '').replace(/\/+$/, '') || DEFAULT_BASE_URL;
  var key = encodeURIComponent(String((opts && opts.apiKey) || '').replace(/^\s+|\s+$/g, '') || DEFAULT_API_KEY);

  // GET url, check the OBA envelope, then map data (mapping errors also reach cb)
  function get(url, map, cb) {
    http(url, function (err, body) {
      if (err) return cb(err instanceof Error ? err : new Error(String(err)));
      if (!body || typeof body !== 'object') return cb(new Error('empty response'));
      if (body.code !== 200) return cb(new Error(body.text || 'HTTP ' + body.code));
      var value;
      try {
        value = map(body.data || {});
      } catch (e) {
        return cb(e instanceof Error ? e : new Error(String(e)));
      }
      cb(null, value);
    });
  }

  function stopsNear(pos, radiusMeters, cb) {
    var url = baseUrl + '/stops-for-location.json?key=' + key +
      '&lat=' + pos.lat + '&lon=' + pos.lon + '&radius=' + radiusMeters;
    get(url, function (data) {
      var list = data.list || [];
      var stops = [];
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        stops.push({ id: String(s.id), name: s.name || '', lat: +s.lat, lon: +s.lon, routeIds: strList(s.routeIds) });
      }
      return sortBy(stops, function (s) { return geo.distance(pos, s); });
    }, cb);
  }

  function arrivals(stopId, minutesBefore, minutesAfter, cb) {
    var url = baseUrl + '/arrivals-and-departures-for-stop/' + encodeURIComponent(stopId) +
      '.json?key=' + key + '&minutesBefore=' + minutesBefore + '&minutesAfter=' + minutesAfter;
    get(url, function (data) {
      var list = (data.entry && data.entry.arrivalsAndDepartures) || [];
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        var predicted = a.predictedArrivalTime > 0;
        out.push({
          stopId: String(a.stopId != null ? a.stopId : stopId),
          routeId: String(a.routeId),
          tripKey: a.tripId + '@' + a.serviceDate,
          time: Math.round((predicted ? a.predictedArrivalTime : a.scheduledArrivalTime) / 1000),
          predicted: predicted,
          headsign: a.tripHeadsign || ''
        });
      }
      return sortBy(out, function (a) { return a.time; });
    }, cb);
  }

  function route(routeId, cb) {
    var url = baseUrl + '/stops-for-route/' + encodeURIComponent(routeId) +
      '.json?key=' + key + '&includePolylines=true&version=2';
    get(url, function (data) {
      var entry = data.entry || {};
      var refs = data.references || {};
      var i, j;

      var shortName = String(routeId);
      var longName = '';
      var color = '';
      var routes = refs.routes || [];
      for (i = 0; i < routes.length; i++) {
        if (String(routes[i].id) === String(routeId)) {
          shortName = routes[i].shortName || routes[i].longName || String(routes[i].id);
          longName = String(routes[i].longName || routes[i].description || '');
          color = util.color(routes[i].color);
          break;
        }
      }

      var directions = [];
      var groupings = entry.stopGroupings || [];
      for (i = 0; i < groupings.length; i++) {
        var groups = groupings[i].stopGroups || [];
        for (j = 0; j < groups.length; j++) {
          var g = groups[j];
          directions.push({
            id: String(g.id),
            name: (g.name && g.name.name) || '',
            stopIds: strList(g.stopIds),
            paths: decodeAll(g.polylines)
          });
        }
      }
      if (!directions.length) {
        directions.push({ id: '0', name: '', stopIds: strList(entry.stopIds), paths: decodeAll(entry.polylines) });
      }

      var stops = {};
      var refStops = refs.stops || [];
      for (i = 0; i < refStops.length; i++) {
        var s = refStops[i];
        stops[String(s.id)] = { id: String(s.id), name: s.name || '', lat: +s.lat, lon: +s.lon };
      }

      return { id: String(routeId), shortName: shortName, longName: longName, color: color, directions: directions, stops: stops };
    }, cb);
  }

  // catalog: one stop's name and position
  function stopInfo(stopId, cb) {
    var url = baseUrl + '/stop/' + encodeURIComponent(stopId) + '.json?key=' + key;
    get(url, function (data) {
      var e = data.entry;
      if (!e || e.id == null) throw new Error('unknown stop ' + stopId);
      return { id: String(e.id), name: e.name || '', lat: +e.lat, lon: +e.lon };
    }, cb);
  }

  // OBA has no cheap route catalog (no listRoutes); routeInfo is the full route
  return { stopsNear: stopsNear, arrivals: arrivals, route: route, routeInfo: route, stopInfo: stopInfo };
}

var plugin = {
  type: 'onebusaway',
  label: 'OneBusAway',
  create: function (options, ctx) {
    return createOneBusAway({ baseUrl: options.baseUrl, apiKey: options.apiKey }, ctx.http);
  }
};

module.exports = { createOneBusAway: createOneBusAway, DEFAULT_BASE_URL: DEFAULT_BASE_URL, plugin: plugin };
