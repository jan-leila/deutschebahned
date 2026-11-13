# Bus Watch — module contracts

Each part is built and tested on its own against the contract below. **Contract tests in `test/` are
the spec**: when this document and a test disagree, the test wins (and this doc gets fixed).

Conventions everywhere:

- **Time** is epoch **seconds** (integers) in JS and C. `now` is always passed in, never read from a global clock inside a module (only `session` gets a `clock()` dependency).
- **Positions** are `{lat, lon}` in degrees. **Distances** are meters.
- `src/common/**` and `src/pkjs/**` are **ES5** (`var`, `function`, no arrow functions, no `let`/`const`, no template strings, no classes, no `Object.assign`, no `Array.prototype.find/includes`, no Promises). They run inside PebbleKit JS on the phone and inside the settings page. Tests (`test/**`) and tools (`tools/**`) can use modern Node (v24).
- Async results use node-style callbacks: `cb(err, value)`.
- Modules use `require('./x')` / `module.exports`. No npm dependencies.

```
                 ┌──────────────────────────── phone (PebbleKit JS) ─────────────────────────────────┐
 settings page ─►│ pkjs/index.js  (composition root: the only file that knows every part)          │
 (config/…html)  │   ├─ sources/registry ◄── plug-ins: sources/{metrotransit,onebusaway,mock}      │
                 │   ├─ session ──► planner ──► ranking ;  optimize (on SELECT)                    │
                 │   │      └─► protocol.encodeList ─────────────────────────────┐                  │
                 │   └─ scheduler ──► router (trip plans)  ;  triggers (when)    │                  │
                 │          └─► protocol.encodeWakeups / encodeNotify ───────────┤  AppMessage      │
                 └───────────────────────────────────────────────────────────────┼──────────────────┘
 watch (C): main.c (wheel, arrows+compass, notify window, wakeups) ◄─ bus_model / bus_wheel / bus_arrow / bus_wakeup
```

Modularity rules: `src/sources/**` never requires anything outside `src/sources/` except the pure `src/common/geo.js`.
`router.js` and `triggers.js` require only pure helpers (`geo`, `directions`, `format`); `scheduler.js` gets everything injected.
Nothing in `src/common/` requires `src/sources/`.

---

## 1. `src/common/geo.js` (done, foundation)

`distance(a,b)`, `offset(p, meters, bearingDeg)`, `decodePolyline(str) → [{lat,lon}]`,
`encodePolyline(points)`, `nearestOnPath(p, path) → {distance, index, along}`,
`distanceToPaths(p, paths) → number` (Infinity if none). See `test/geo.test.js`.

## 2. `src/common/settings.js` — configuration model

```js
RANGES        // { fieldName: {min, max, integer: bool} } for every numeric top-level field (see table)
defaults()    // → fresh deep copy of the default config
normalize(raw)// → full valid config. NEVER throws, for any input (null, array, string, garbage fields)
parse(json)   // → normalize(JSON.parse(json)), or defaults() if json is not valid JSON / empty
connectionId(routeId, stopId) // → routeId + '|' + stopId
```

Config shape and defaults:

| field | default | range / rule |
|---|---|---|
| `version` | `1` | always 1 |
| `provider.type` | `''` | a source plug-in id matching `/^[a-z0-9_-]{1,32}$/` (shipped: `metrotransit`, `onebusaway`, `mock`); anything else → `''`. `''` = the registry's default source (Metro Transit) |
| `provider.baseUrl` | `''` | string, trailing `/` stripped; `''` = the provider's default URL |
| `provider.apiKey` | `''` | string, trimmed; `''` = the provider's default (OBA: `TEST`; Metro Transit needs none) |
| `location.mode` | `'gps'` | `'gps'` or `'fixed'` (fixed = use lat/lon below; for testing/demo) |
| `location.lat` / `location.lon` | `0` / `0` | clamp −90..90 / −180..180 |
| `stopRadius` | 300 | 10..5000 integer — meters: stops this close are "nearby" |
| `routeRadius` | 80 | 5..2000 integer — meters: this close to a route's path = "on the route" |
| `recentWindow` | 180 | 0..3600 integer — seconds: "bus was physically here within the last x" |
| `lookahead` | 60 | 1..240 integer — minutes: pickups and "next bus here" |
| `dropoffHorizon` | 120 | 1..480 integer — minutes ahead to look for arrivals at pinned stops |
| `maxStops` | 4 | 1..10 integer — nearby stops queried |
| `pickupsPerItem` | 3 | 1..3 integer |
| `maxItems` | 10 | 1..12 integer |
| `refreshInterval` | 60 | 15..3600 integer — seconds |
| `vehicleRadius` | 250 | 10..2000 integer — meters: a live bus position reported this close to you (within `recentWindow`) is "the bus you're on" |
| `defaultStopScale` | −1 | −1000..1000 — weight per meter for stops without their own scale |
| `defaultRouteScale` | −1 | −1000..1000 — weight per second for unconfigured route keys |
| `defaultConnectionScale` | −1 | −1000..1000 — weight per meter |
| `routes` | `[]` | `[{id, name, scale, color}]` — `color` is `'RRGGBB'` or `''` (= provider color / default) |
| `connections` | `[]` | `[{id, routeId, stopId, name, scale}]` |
| `stopScales` | `{}` | `{stopId: number}` |
| `units` | `'imperial'` | `'imperial'` or `'metric'` — how distances are shown (settings fields stay in meters) |
| `clock24` | `false` | boolean — 24 h clock in notifications |
| `destinations` | `[]` | ≤ 8 × `{id, name, lat, lon, arriveBy: 'HH:MM', days: [0..6], enabled}` — see below |
| `schedule.leadMinutes` | 15 | 0..120 integer — re-check this long before the leave time |
| `schedule.walkSpeed` | 1.3 | 0.3..3 m/s |
| `schedule.maxWalk` | 800 | 50..5000 integer m — walking to the first / from the last stop |
| `schedule.transferWalk` | 250 | 0..1000 integer m — walking between stops when transferring |
| `schedule.maxTransfers` | 1 | 0..1 integer |
| `schedule.minTransfer` | 120 | 0..1200 integer s — slack needed to make a transfer |
| `schedule.leaveReminder` | `true` | boolean — also notify at the leave time itself |
| `schedule.fallbackMinutes` | 60 | 5..240 integer — no plan yet: re-check this long (+ lead) before `arriveBy` |
| `training.autoTrain` | `true` | boolean (accept `1/0`, `'true'/'false'`) |
| `training.learningRate` | 0.05 | 0.0001..10 |
| `training.iterations` | 300 | 1..5000 integer |
| `training.temperature` | 60 | 0.01..100000 |
| `training.regularization` | 0.01 | 0..100 |
| `training.maxSamples` | 200 | 1..2000 integer |

Numeric rules: values may arrive as numeric strings (`"120"`); non-finite/unparseable → default;
out of range → clamped; `integer` fields rounded. Range checks apply to the training fields too.

List rules: `routes` entries need a non-empty trimmed `id` (others dropped), duplicate ids → first wins,
`name` defaults to `id`, `scale` defaults to the config's `defaultRouteScale`. `color` = `settings.color(v)`: `#rrggbb` or `rrggbb` → upper-case `RRGGBB`, anything else → `''`. `connections` need non-empty
`routeId` and `stopId`, `id` is always recomputed as `connectionId(routeId, stopId)`, duplicates → first
wins, `name` defaults to `stopId`, `scale` defaults to `defaultConnectionScale`. `stopScales` keeps only
non-empty trimmed keys with finite numeric values. Strings are trimmed. Unknown fields are dropped.

`destinations` (`settings.MAX_DESTINATIONS = 8`, extra entries dropped): entries need numeric `lat`/`lon` (clamped) and a valid
`arriveBy` (`settings.clockTime`: `'H:MM'`/`'HH:MM'`, 0–23 : 00–59 → zero-padded `'HH:MM'`), others are dropped. `name` defaults to
`'Destination N'` (N = position among kept entries). `days` = weekday numbers (0 = Sunday) deduplicated and sorted, invalid ones
dropped; `[]` = every day. `enabled` defaults to `true`. A non-empty `id` is kept (duplicates → first wins); empty ids are filled
after the pass with the lowest unused `'destN'` (N = 1, 2, …). Tests: `test/settings.test.js`.

## 3. Data sources — plug-ins (`src/sources/`)

A **data source** is a self-contained plug-in. `src/sources/<type>/index.js` exports `plugin = {type, label, create(options, ctx) → provider}`
(plus its own factory for tests). `src/sources/all.js` lists the shipped plug-ins, default first: metrotransit, onebusaway, mock.
Sources may require only `src/sources/util.js` (`color(v)` → `'RRGGBB'`|`''`) and `src/common/geo.js`.

`src/sources/registry.js`:

```js
createRegistry(plugins?) → registry
registry.register(plugin)        // same type again replaces it; bad plug-in → throws
registry.resolve(type)           // plug-in for type; '' / unknown → the first registered; none registered → null
registry.has(type); registry.types() // → [{type, label}] in registration order
registry.create(config, deps)    // → provider = resolve(config.provider.type).create(options, ctx)
                                 //   options = {baseUrl, apiKey} (from config.provider)
                                 //   ctx = sourceContext(config, deps) = {http, clock, storage, routeIds, routes: [{id, name}], center: {lat, lon}}
configuredRouteIds(config)       // configured route ids, then connection route ids; deduplicated, config order
```

`deps = {http, clock, storage}`. Only composition roots (`src/pkjs/index.js`, the settings page bundle, tools, integration tests) build
a registry; every other module receives a provider object.

Every provider implements:

```js
provider.stopsNear(pos, radiusMeters, cb)        // cb(err, Stop[])   sorted by distance from pos, ascending
provider.arrivals(stopId, minutesBefore, minutesAfter, cb) // cb(err, Arrival[]) sorted by time ascending
provider.route(routeId, cb)                      // cb(err, Route)
provider.vehicles(routeId, cb)                   // OPTIONAL (absent on OBA): cb(err, Vehicle[]) live positions
// catalog (OPTIONAL; used by the settings page — show the matching helper only when the method exists):
provider.listRoutes(cb)                          // cb(err, [{id, label}]) every route the source knows
provider.routeInfo(routeId, cb)                  // cb(err, RouteInfo) cheap: no stop coordinates needed
provider.stopInfo(stopId, cb)                    // cb(err, {id, name, lat, lon})
```

`Route` and `RouteInfo` also carry `longName` (the formal / descriptive route name, `''` if unknown): Metro Transit `route_desc` from
`/schedule/routedetails`, OneBusAway `longName || description`, mock `name + ' via Mock Av - Centre - Station ' + id`.
`RouteInfo = { id, shortName, color, directions: [{id, name, stopIds}], stops: { [stopId]: {id, name} } }` (a `Route` is a valid RouteInfo).
Catalog per source: **Metro Transit** — `listRoutes` = `/nextrip/routes` → `{id: route_id, label: route_label}`; `routeInfo` = steps 1–3 of
`route()` below (shares the `/schedule/routes` fetch; no coordinate lookups); `stopInfo` = `/nextrip/{stopId}` → `stops[0]`
(`name = description`, shares the stop-coordinate cache; no coordinates → error). `listRoutes` is fetched once per provider; `routeInfo`
answers from an already built / stored `route()` without requests. **OneBusAway** — no `listRoutes`; `routeInfo` = `route()`; `stopInfo` =
`{base}/stop/{id}.json?key={K}` → `data.entry` (fixture `test/fixtures/oba-stop.json`). **Mock** — all three from its generated network
(`listRoutes` in config order, `label` = `id + ' ' + name`; `routeInfo` = `route`). Tests: `test/providers.test.js`, `test/sources-registry.test.js`.

```js
Stop    = { id, name, lat, lon, routeIds: [string] }
Arrival = { stopId, routeId, tripKey, time /*epoch s*/, predicted: bool, headsign: string }
Route   = { id, shortName, color /*'RRGGBB' or ''*/,
            directions: [{ id, name, stopIds: [string] /*travel order*/, paths: [[{lat,lon}]] }],
            stops: { [stopId]: {id, name, lat, lon} } }
Vehicle = { tripKey, routeId, directionId, lat, lon, time /*epoch s of the position report*/ }
```

`tripKey` identifies one physical run of a trip; the same run has the same `tripKey` at every stop and in `vehicles`.
All ids are strings.

### `sources/metrotransit/index.js` — `createMetroTransit({baseUrl, routeIds}, http, deps)` (Minneapolis–St Paul)

Exports `{createMetroTransit, DEFAULT_BASE_URL}`; `DEFAULT_BASE_URL = 'https://svc.metrotransit.org'` (used when `baseUrl`
is empty; a trailing `/` is stripped). No API key. `routeIds` = the routes the user configured (for `stopsNear`).
`deps = {clock, storage?}`; `storage` is `localStorage`-like and optional (no caching across instances without it).
Fixtures: `test/fixtures/mt-*.json` are real, trimmed responses.

APIs used (NexTrip v2 + Schedule v1; JSON, CORS open): `GET {base}/nextrip/{stopId}`, `GET {base}/nextrip/vehicles/{routeId}`,
`GET {base}/schedule/routes`, `GET {base}/schedule/routedetails/{route_url_param}`, `GET {base}/schedule/stoplist/{routeId}/{schedule_number}`
(path segments `encodeURIComponent`-ed). A body with a numeric `status >= 400` (ASP.NET ProblemDetails) → `Error(detail || title)`.
(`/nextrip/shape/{route}` exists but returns HTTP 500, and there is no "stops near a point" call — hence the approach below.)

- `arrivals`: `/nextrip/{stopId}` → `departures[]`: `{stopId: String(stop_id), routeId: route_id, tripKey: trip_id, time: departure_time,
  predicted: !!actual, headsign: description trimmed}`, all routes, filtered to `[now - before*60, now + after*60]`, ascending.
  (NexTrip only lists upcoming departures, so `minutesBefore` never yields past ones — use `vehicles` for "the bus that was here".)
- `route(routeId)`: 1) `/schedule/routes` (fetched once per provider) → the entry's `route_url_param` (missing → `Error('unknown route ' + id)`);
  2) `/schedule/routedetails/{param}` → `shortName = route_short_name || routeId`, `color = settings.color(route_color)`, directions =
  the timetables of `schedules[0]` (`{id: String(direction_id), name: direction}`); 3) `/schedule/stoplist/{routeId}/{schedule_number}` per
  direction → ordered stops (`name = stop_name`); 4) coordinates per stop from `/nextrip/{stopId}` → `stops[0].latitude/longitude`
  (shared stop-coordinate cache; a stop whose lookup fails is left out of `stopIds`, `paths` and `stops`); 5) each direction's
  `paths = [ordered stop coordinates]`. At most **4 requests in flight** per provider; concurrent `route()` calls for one id share a
  single fetch. Built routes are cached in `storage` under keys starting `busWatch.mt.` for **7 days** (`clock()` based).
- `stopsNear(pos, r)`: every stop of the `routeIds` routes (via `route()`) within `r`, merged by id (`routeIds` = the configured routes
  serving it, in `routeIds` order), nearest first. No routes → `[]`. Routes that fail are skipped; all failing → error.
- `vehicles(routeId)`: `/nextrip/vehicles/{routeId}` → entries with `location_time > 0` and non-zero lat/lon →
  `{tripKey: trip_id, routeId: route_id, directionId: String(direction_id), lat: latitude, lon: longitude, time: location_time}`.

### `sources/onebusaway/index.js` — `createOneBusAway({baseUrl, apiKey}, http)`

`http(url, cb)` performs a GET and calls `cb(err, parsedJsonBody)`. URLs (params in this order):

- `{baseUrl}/stops-for-location.json?key={K}&lat={lat}&lon={lon}&radius={r}`
- `{baseUrl}/arrivals-and-departures-for-stop/{encodeURIComponent(stopId)}.json?key={K}&minutesBefore={b}&minutesAfter={a}`
- `{baseUrl}/stops-for-route/{encodeURIComponent(routeId)}.json?key={K}&includePolylines=true&version=2`

(`key` is `encodeURIComponent`-ed.) A body whose `code` isn't 200 → `cb(Error(text || 'HTTP ' + code))`.
Mapping (OBA REST v2): stops from `data.list`; arrivals from `data.entry.arrivalsAndDepartures`,
`time = round((predictedArrivalTime > 0 ? predictedArrivalTime : scheduledArrivalTime) / 1000)`,
`predicted = predictedArrivalTime > 0`, `tripKey = tripId + '@' + serviceDate`, `headsign = tripHeadsign || ''`.
Route directions from `data.entry.stopGroupings[*].stopGroups[*]` (`id`, `name.name`, `stopIds`,
`polylines[*].points` decoded); if there are no stop groups: a single direction `{id:'0', name:'', stopIds: entry.stopIds, paths: entry.polylines decoded}`.
`shortName` from `data.references.routes` (`shortName || longName || id`); `stops` from `data.references.stops`.
`color = settings.color(route.color)` from the same reference entry (`''` if none). Empty `baseUrl` → `https://api.pugetsound.onebusaway.org/api/where`;
empty `apiKey` → `TEST`. OBA has no `vehicles`.
Fixtures: `test/fixtures/oba-*.json`.

### `sources/mock/index.js` — `createMock({location, routes}, clock)` (plug-in passes `ctx.center` / `ctx.routes`)

Deterministic fake transit network centred on `config.location` (used for demos and the emulator test):

- Route *i* (index in `config.routes`) is a straight line through the centre at bearing `i*60`°, from
  3000 m behind the centre to 3000 m ahead (`geo.offset`). One direction `{id:'0', name:'Outbound'}`.
- 16 stops every 400 m from the line start: id `` `${routeId}:s${k}` `` (k = 0..15), name `` `${route.name} stop ${k}` ``
  (`route.name` from config). The centre is at 3000 m, between stops 7 (2800 m) and 8 (3200 m).
- A trip departs stop 0 every 600 s at `T_j = floor(now/600)*600 + j*600` for all integer j; it reaches
  stop k at `T_j + 50*k`. `tripKey = routeId + ':t' + T_j`. `predicted: true`, `headsign: route.name`.
- `stopsNear` returns every mock stop within the radius (routeIds `[routeId]`), sorted by distance.
- `arrivals` returns that stop's runs with time in `[now - before*60, now + after*60]`, ascending.
- `route` returns the line as one path. Unknown ids → `cb(Error('unknown ...'))`. All callbacks are async (`setTimeout(…, 0)`).
- Route colors: `MOCK_COLORS = ['E53935','1E88E5','43A047','FB8C00','8E24AA','00897B']`, route *i* gets `MOCK_COLORS[i % 6]`.
- `vehicles(routeId)`: every run with `0 <= now - T_j <= 750` is on the road at `8*(now - T_j)` m along the line from its
  start: `{tripKey, routeId, directionId: '0', lat, lon, time: now}`.

(`color = util.color(...)` wherever the provider docs below say `settings.color`.) The Metro Transit plug-in passes `ctx.routeIds`, `ctx.clock`, `ctx.storage`.

## 4. `src/common/planner.js` — which pickups / drop-offs to show

```js
gather(provider, config, pos, now, routeCache, cb)  // cb(err, Data)
buildItems(config, data, pos, now)                   // → Item[] (pure, unranked)
pickHereStop(direction, route, pinnedStopId, pos)    // → stopId | null (pure)
routeColor(config, routeId, route)                   // → 'RRGGBB' (pure)
DEFAULT_COLORS = ['0055AA','AA0000','00AA55','AA5500','5500AA','00AAAA','AA00AA','555555']
```

`routeCache` is a plain object `{routeId: Route}` owned by the caller; `gather` reads it and adds to it
(routes don't change while the app is open).

```js
Data = { stops: Stop[],                    // nearby stops serving ≥1 configured route, ≤ maxStops, nearest first
         routes: { [routeId]: Route },     // every configured route and every connection route (fetched/cached)
         vehicles: { [routeId]: Vehicle[] },// on-route connection routes, only if provider.vehicles exists and succeeded
         arrivals: { [stopId]: Arrival[] },// stops whose arrivals request failed are absent
         errors: [string] }
```

**gather**: 1) `stopsNear(pos, stopRadius)`; keep stops serving a configured route; first `maxStops`.
2) `route()` for each distinct id of `config.routes` and `config.connections` (cache first). 3) For each connection whose
route loaded: pick its direction (below) and here stop; if within `routeRadius`, the here stop and pinned stop
need arrivals, and (when `typeof provider.vehicles === 'function'`) `vehicles(routeId)` is fetched once per such route. 4) Fetch arrivals once per stop with the union window of every role it plays:
nearby stop `(0, lookahead)`; here stop `(ceil(recentWindow/60), lookahead)`; pinned stop `(0, dropoffHorizon)`.
Any single failing request → message pushed to `errors`, keep going. (Exception: a route loaded only for its color — a configured route
with no connection — fails silently; its items fall back to the default colors.) `cb(err)` only when `stopsNear` fails
**and** there are no connections. Arrival requests may run in parallel.

**Direction of a connection**: among route directions whose `stopIds` contain the pinned stop, the one with
the smallest `geo.distanceToPaths(pos, paths)`. On-route iff that distance ≤ `routeRadius`.

**pickHereStop**: of the direction's stops strictly *before* the pinned stop (in `stopIds` order) that exist in
`route.stops` (the *eligible* stops): project `pos` onto the direction's closest path; the nearest eligible stop that
is at or behind `pos` along that path (i.e. the stop a bus you are riding just passed); if none is behind `pos` (or the
direction has no paths), the nearest eligible stop; `null` if there are no eligible stops.

**Items** (`buildItems`):

```js
Item = { kind: 'pickup'|'dropoff', key, badge, title, color, times: [epoch s], routeId, stopId,
         features: { [featureKey]: number },
         bearing,   // degrees [0, 360) from pos to the item's stop (geo.bearing), null if the stop has no coordinates
         distance,  // meters, null if unknown. pickup: straight line pos → stop; dropoff: left to travel (below)
         dir,       // directions label of the item's stop: 'NB'|'SB'|'EB'|'WB'|''
         routeLongName, // route.longName of the item's route ('' if none) — shown as a scrolling line on the watch
         lanes }    // pickup: [{stopId, dir, times}] 1 or 2 lanes, lanes[0] is the item's own stopId/dir/times; dropoff: []
```

**Same-name stops** (opposite sides of a street): pickup candidates (one per stop × route, built as below) with the same `routeId` and the
same normalized stop name (trimmed, lower-case, runs of whitespace → one space) are merged into **one tile with two lanes**, nearest stop
first (more than two → the nearest two merge, the rest stay separate tiles, merging again pairwise in distance order; a stop without
coordinates sorts last; the sort is stable). Only candidates that have times take part. The tile takes lane 0's
`stopId`, `dir`, `times`, `bearing`, `distance`, `key`; `features['route:'+routeId]` = the soonest first time of either lane − now (≥ 0);
`features['stop:'+lane0.stopId]` as usual (0 when the stop has no coordinates). A tile takes the position of the earlier (in candidate
order) of its candidates. **Drop-offs are never merged** (one tile per
connection); their `dir` tells same-name stops apart. `dir` for a pickup lane = `directions.stopLabel(route, stopId)`; for a drop-off =
`directions.label(route, chosenDirection, pinnedStopId)`. A pickup lane's `dir` is `''` when the route isn't in `data.routes`.

**Drop-off distance** = distance left to ride: on the chosen direction's path closest to `pos` (`geo.nearestOnPath`), `along(pinned stop) −
along(pos)` (both projected onto that path); if that is negative, or the direction has no paths, the straight-line distance. `bearing` =
pos → pinned stop. Pinned stop missing from `route.stops` or without coordinates → `bearing` and `distance` null (`dir` still set).

- *Pickup*: for each `data.stops` stop (in order) × each configured route it serves (in `config.routes` order):
  that route's arrivals at the stop with `time >= now - 30`, first `pickupsPerItem` times. None → no item.
  `key = 'pickup:' + stopId + ':' + routeId`, `badge = routeName`, `title = stop.name`, `color = routeColor(config, routeId, data.routes[routeId])`,
  `features = {['stop:'+stopId]: round(distance(pos, stop)), ['route:'+routeId]: max(0, times[0] - now)}`.
- *Drop-off*: for each connection (config order) whose route is in `data.routes`, has a direction, is on-route,
  and has a here stop. `pinned` = route's arrivals at the pinned stop with `time > now`, by tripKey.
  `here` = route's arrivals at the here stop.
  **on**: first from live vehicles: among `data.vehicles[routeId]` (if present) with `time >= now - recentWindow`,
  `distance(pos, vehicle) <= vehicleRadius` and tripKey in `pinned`, the nearest → `onDrop = pinned time`. If none, the latest
  `here` arrival with `now - recentWindow <= time <= now` whose tripKey is in `pinned` → `onDrop = pinned time`.
  **next**: the earliest `here` arrival with `time > now` whose tripKey is in `pinned` → `nextHere`, `nextDrop`.
  Neither → no item. `times = [onDrop||0, nextDrop||0, nextHere||0]`.
  `key = 'dropoff:' + conn.id`, `badge = routeName`, `title = conn.name`, `color` as for pickups, `stopId` = pinned stop, extra `hereStopId`,
  `features = {['conn:'+conn.id]: round(pathDistance), ['route:'+routeId]: (onDrop ? onDrop : nextDrop) - now}`.
- `routeName` = configured route `name`, else `route.shortName`, else the id.
- `routeColor`: the configured route's `color` if set; else `settings.color(route.color)` if non-empty; else
  `DEFAULT_COLORS[i % 8]` where *i* is the route's index in `config.routes`, or (unconfigured) the sum of the id's char codes.
- Output order: all pickups, then all drop-offs (ranking sorts them).

## 5. `src/common/ranking.js` — sort order (score = Σ scale × value)

```js
weightFor(key, config, learned) // learned[key] if finite number; else by prefix:
                                //  'stop:ID'  → config.stopScales[ID] ?? defaultStopScale
                                //  'route:ID' → configured route's scale ?? defaultRouteScale
                                //  'conn:ID'  → configured connection's scale ?? defaultConnectionScale
                                //  anything else → 0
score(features, weightFn)       // Σ weightFn(key) * value
rank(items, config, learned)    // → NEW array of shallow copies with `.score`, sorted by score descending,
                                //   ties keep input order (stable), truncated to config.maxItems. Input untouched.
bake(config, learned)           // → new config where each learned weight replaces the matching scale
                                //   (stop → stopScales, route → routes[].scale for configured routes,
                                //    conn → connections[].scale for configured ones; others ignored). Input untouched.
```

`learned` may be `null`/`undefined` (= no learned weights). Negative scales → nearer / sooner ranks first.

## 6. `src/common/optimize.js` — learn the scales from SELECT presses

```js
Sample = { t, lat, lon, chosen /*index*/, candidates: [{ key, features }] }
makeSample(items, chosenIndex, pos, now) // → Sample (deep copies features; no other item fields)
evaluate(samples, weightFn, temperature) // → { n, loss, accuracy }
train(samples, priorFn, opts)            // → { weights: {key: number}, before: Eval, after: Eval }
```

- Model: per candidate `s_i = Σ w[k]·x_ik`; `p = softmax(s / temperature)`; target = one-hot of `chosen`.
  Loss per sample = cross-entropy `-log p_chosen` (gradient `(p - onehot)·x / T`).
- Samples with < 2 candidates or an out-of-range `chosen` are ignored (`n` counts usable samples).
- `accuracy` = fraction of usable samples whose chosen candidate has a score strictly greater than every other one.
  With no usable samples: `{n: 0, loss: 0, accuracy: 0}`.
- `train`: `opts = {learningRate, iterations, temperature, regularization}` (same as `config.training`).
  Starts from `w0[k] = priorFn(k)` for every key in any usable sample; minimizes mean loss + `regularization/2 · Σ(w - w0)²`
  using Adam (β1 0.9, β2 0.999, ε 1e-8). Deterministic. `weights` contains every key seen; `{}` if no usable samples.
  `before` = evaluate with `priorFn`, `after` = evaluate with the result.

## 7. `src/common/protocol.js` — phone ⇄ watch messages

Message keys (`package.json` `messageKeys`): `LIST_ID ITEM_COUNT ITEM_INDEX ITEM_KIND ITEM_TITLE ITEM_T0 ITEM_T1 ITEM_T2 ITEM_BADGE ITEM_COLOR STATUS SELECT_INDEX REFRESH
ITEM_BEARING ITEM_DIST ITEM_DIR ITEM_LANES ITEM_DIR2 ITEM_U0 ITEM_U1 ITEM_U2 WAKEUP_COUNT WAKEUP_INDEX WAKEUP_TIME WAKEUP_COOKIE WAKEUP_FIRED NOTIFY_TITLE NOTIFY_BODY NOTIFY_COLOR ITEM_ROUTE`.

Phase 4 (carousel): `TITLE_MAX_BYTES = 63` (full stop names; the watch scrolls what doesn't fit), item messages carry `ITEM_ROUTE` =
`truncateUtf8(item.routeLongName, ROUTE_MAX_BYTES 63)` (the route's full name, `''` if none); `NOTIFY_TITLE` uses `NOTIFY_TITLE_MAX_BYTES = 31`.

```js
KIND = { pickup: 0, dropoff: 1 };  TITLE_MAX_BYTES = 31;  BADGE_MAX_BYTES = 7;  STATUS_MAX_BYTES = 47;  MAX_ITEMS = 12
truncateUtf8(str, maxBytes)        // longest prefix whose UTF-8 is ≤ maxBytes, never splitting a code point
encodeList(listId, items, status)  // → [ {LIST_ID, ITEM_COUNT: n, STATUS},
                                   //     {LIST_ID, ITEM_INDEX: i, ITEM_KIND, ITEM_BADGE, ITEM_TITLE, ITEM_COLOR, ITEM_T0, ITEM_T1, ITEM_T2} × n ]
                                   //   n = min(items.length, MAX_ITEMS); missing times → 0; titles/status truncated;
                                   //   badge truncated to BADGE_MAX_BYTES then trailing spaces trimmed (missing → '');
                                   //   ITEM_COLOR = parseInt(item.color, 16) for a valid RRGGBB, else -1
encodeList(listId, items, status, opts) // opts = {units} ('imperial' default). Each item message also carries:
                                   //   ITEM_BEARING = round(bearing) % 360, or -1 when bearing is null/not finite
                                   //   ITEM_DIST    = format.distance(distance, units) ('' when null)  (≤ DIST_MAX_BYTES 7); units other than 'metric' → imperial
                                   //   ITEM_DIR     = lanes[0].dir || dir || ''                         (truncated to DIR_MAX_BYTES 3)
                                   //   ITEM_LANES   = 2 if item.lanes has ≥ 2 entries, else 1
                                   //   ITEM_DIR2, ITEM_U0, ITEM_U1, ITEM_U2 = lanes[1].dir ('' / ≤ 3 B) and lanes[1].times (missing → 0) (only when ITEM_LANES = 2)
                                   //   Exported: DIST_MAX_BYTES, DIR_MAX_BYTES, MAX_WAKEUPS, NOTIFY_BODY_MAX_BYTES
encodeStatus(status)               // → { STATUS }
encodeWakeups(wakeups)             // [{time, cookie}] → [{WAKEUP_COUNT: n}, {WAKEUP_INDEX: i, WAKEUP_TIME, WAKEUP_COOKIE} × n], n = min(len, MAX_WAKEUPS 8)
                                   //   ([] → just {WAKEUP_COUNT: 0} = cancel all)
encodeNotify(n)                    // {title, body, color} → ONE message {NOTIFY_TITLE (≤ TITLE_MAX_BYTES 31), NOTIFY_BODY (≤ NOTIFY_BODY_MAX_BYTES 159),
                                   //   NOTIFY_COLOR (int / -1)}; send it as sendAll([encodeNotify(n)])
decodeWatchMessage(payload)        // { WAKEUP_FIRED: cookie }          → {type:'wakeup', cookie: Number(cookie)} (checked first)
                                   // { SELECT_INDEX: i, LIST_ID: id } → {type:'select', listId, index}
                                   // { REFRESH: any }                  → {type:'refresh'}
                                   // anything else                      → null
createSender(sendFn, opts)         // opts.retries (default 2). sendFn(dict, onOk, onErr) = Pebble.sendAppMessage
  sender.sendAll(messages)         //   send in order, one at a time (next only after onOk). Replaces whatever
                                   //   is still queued from an earlier sendAll (the in-flight message completes).
                                   //   Precisely: a batch containing a list header (ITEM_COUNT) drops the queued messages of
                                   //   earlier *list* batches only; every other queued message (status, wakeups, notify) stays,
                                   //   in order. Non-list batches are appended.
                                   //   A message failing more than `retries` times drops the rest of its own batch only (other
                                   //   batches stay queued). A list message superseded by a newer list while in flight is not retried.
  sender.pending()                 //   → number of messages not yet acknowledged (queued + in flight)
```

Watch → phone: `{SELECT_INDEX, LIST_ID}` when SELECT is pressed on an item; `{REFRESH: 1}` on long SELECT; `{WAKEUP_FIRED: cookie}` when a
wakeup fires while the app is running.

## 8. `src/common/session.js` — orchestration (all I/O injected)

```js
createSession(deps) → session
deps = { storage /*getItem,setItem,removeItem*/, clock /*() → epoch s*/, locate /*cb(err,pos)*/,
         createProvider /*(config) → provider*/, send /*(messages[]) → void*/, log /*optional*/,
         planner, ranking, optimize /*optional: default to the real modules*/ }
STORAGE_KEYS = { config: 'busWatch.config', samples: 'busWatch.samples', learned: 'busWatch.learned' }
```

- `load()` reads the three keys (bad/missing JSON → defaults / `[]` / `{}`).
- `getConfig()`, `getSamples()`, `getLearned()`; `lastList()` → `{listId, items, pos, now} | null`.
- `refresh(cb)`: sends `encodeStatus('Locating...')`; position = `config.location` if mode is `'fixed'` else `locate`;
  sends `encodeStatus('Loading...')`; `planner.gather` (provider created via `createProvider(config)` and reused until the
  config changes; one `routeCache` kept likewise) → `planner.buildItems` → `ranking.rank(items, config, learned)`;
  `listId` increments (starting at 1); sends `encodeList(listId, ranked, status, {units: config.units})` where status = `'No buses nearby'` if empty, else `'Updated HH:MM'` (local time, 24h).
  Errors (locate or gather) → sends `encodeStatus('Error: ' + message)`. `cb(err, rankedItems)`. A refresh started while
  one is running is skipped (`cb(null, null)`).
- `select(listId, index)`: ignored (returns `false`) unless it matches the last sent list and index is in range.
  Otherwise appends `optimize.makeSample(items, index, pos, clock())`, keeps the newest `training.maxSamples`, saves.
  If `training.autoTrain`: `learned = optimize.train(samples, k => ranking.weightFor(k, config, null), config.training).weights`, saved.
  Re-ranks the last list's items, increments `listId`, sends it with status `'Learned (N picks)'`. Returns `true`.
- `handleWatchMessage(payload)`: decodes with protocol, dispatches to `select` / `refresh`; returns the decoded message (`null` when
  unrecognized). `wakeup` is not handled by the session — the root routes it to the scheduler.
- `configPageParams()` → `{config, samples, learned}`.
- `applySettings(result)`: `result = {config, learned?, clearSamples?}` (as returned by the settings page).
  Config normalized + saved; `learned` given → replaces learned (`null` → `{}`); `clearSamples` → `[]`. Drops provider and
  route cache, then `refresh()`.

## 9. `src/pkjs/index.js` — Pebble glue (thin, not unit tested)

Wires the session to `Pebble`, `XMLHttpRequest`, `navigator.geolocation`, `localStorage`; starts a refresh on `ready`
and every `refreshInterval` s; `showConfiguration` opens the settings page as a `data:` URI with
`<script>window.__params = {config, samples, learned, return_to: 'pebblejs://close#'}</script>` injected at `<!--PARAMS-->`;
`webviewclosed` → `session.applySettings(JSON.parse(decodeURIComponent(e.response)))`.
Sources: `registry = createRegistry(require('../sources/all'))`; `createProvider(config)` = `registry.create(config, {http, clock, storage: localStorage})`,
memoized per config so the session and the scheduler share one provider. Scheduler: `createScheduler({..., sendWakeups: w => sender.sendAll(encodeWakeups(w)),
notify: n => sender.sendAll([encodeNotify(n)])})`; on `ready`: `scheduler.load()`, `scheduler.checkDue()`, and `scheduler.replan()` when no plan is stored for
an enabled destination's next occurrence; every refresh tick: `checkDue()`; `applySettings` → `scheduler.replan()`; watch `wakeup` message → `checkDue()`.
The settings page params also get `plans: scheduler.plans()` and `sources: registry.types()`.

`src/pkjs/ui-fixture.js` is an alternative entry (`PKJS_ENTRY=src/pkjs/ui-fixture.js pebble build`) that sends a canned
list on `ready` and logs `UI-FIXTURE select <listId> <index>` / `UI-FIXTURE refresh` on watch messages — used to test the watch UI alone.
Its items carry badges and colors (e.g. Metro Transit `2` `771473`, `B Line` `ED1B2E`, `Blue` `00539F`, one item with no color).
It keeps at least 8 items so the wheel has rows above and below the selection.

## 10. Settings page — `config/config-page.html` + `tools/build-config.js`

`tools/build-config.js` inlines `src/common/{geo,settings,ranking,optimize,directions,format}.js` and `src/sources/**` into the page (tiny
CommonJS shim resolving relative paths, exposing `window.BusWatch = {geo, settings, ranking, optimize, directions, format, registry}` where
`registry = createRegistry(require('src/sources/all'))`) and writes `src/pkjs/config-page.js` (`module.exports = "<html…"`),
keeping a literal `<!--PARAMS-->` marker in `<head>`. Self-contained: no external URLs. Mobile-friendly.

Reads `window.__params` (`{config, samples, learned, return_to}`); missing → defaults. DOM contract (used by the test):

- Every scalar field is an `<input>`/`<select>` with `data-field="<path>"`, e.g. `data-field="stopRadius"`,
  `data-field="provider.baseUrl"`, `data-field="training.autoTrain"` (checkbox), `data-field="location.mode"` (select).
- Lists: `#routes .route-row` (`input[name=id|name|scale|color]`; `color` holds `#rrggbb` or `''` = automatic, shown with a swatch
  and a picker limited to the 64 Pebble colors), `#connections .connection-row` (`input[name=routeId|stopId|name|scale]`),
  `#stop-scales .stop-scale-row` (`input[name=stopId|scale]`); each row has a `.remove` button.
  Buttons `#add-route`, `#add-connection`, `#add-stop-scale` append an empty row.
- Learned weights / training: `#sample-count` (text = number of samples), `#learned` (table of learned weights),
  `#train-now` (runs `optimize.train` on the injected samples with the form's current config as prior → sets learned,
  shows before/after accuracy in `#train-result`), `#reset-learned` (learned → null), `#bake-learned` (`ranking.bake` into
  the form, learned → null), `#clear-samples` (marks clearSamples, `#sample-count` → 0), `#save`.
- `select[data-field="provider.type"]` options = `registry.types()` (value `type`, text `label`); `''` shows as the first/default one.
  A config type of `''` (or an id no registered source has) is kept as-is by `readForm()` until the user picks a source.
- **Source helpers** — the page creates the current source with `registry.create(readForm(), {http: fetch-based GET → JSON, clock, storage: localStorage (guarded)})`
  and offers each helper only if the provider has the catalog method (`listRoutes` → route datalist, `routeInfo` → load color + stop picker,
  `stopInfo` → destination coordinates from a picked stop). `<body>` gets a class `has-<method>` per available catalog method; elements
  with class `needs-<method>` are hidden without it. Status of the route list in `#source-status`. All failures shown inline, never thrown.
  For Metro Transit that means these requests
  (base = `provider.baseUrl || 'https://svc.metrotransit.org'`):
  - on load and when the provider changes: `GET {base}/nextrip/routes` fills `<datalist id="route-options">` (`option value=route_id`,
    text = `route_label`); every route `input[name=id]` and connection `input[name=routeId]` has `list="route-options"`.
  - `.load-color` button on each route row: `/schedule/routes` → `route_url_param` → `/schedule/routedetails/{param}` → sets the
    row's `color` to `#` + `route_color` (and an empty `name` to `route_short_name`).
  - `.pick-stop` button on each connection row opens `#stop-picker` for that row's `routeId`: `select[name=direction]` from the
    route details' first schedule timetables (`value = direction_id`), `select[name=stop]` from `/schedule/stoplist/{route}/{schedule_number}`
    of the chosen direction (`value = stop_id`, text = `stop_name`), `.use` button fills the row's `stopId` and `name`. (Via `routeInfo`, so the
    stop lists of all directions are fetched when the picker opens.)
- **Destinations**: `#destinations .destination-row` with `input[name=name|lat|lon]`, `input[name=arriveBy]` (`type=time`), seven
  `input[name=day]` checkboxes (`value` 0..6, none checked = every day), `input[name=enabled]` checkbox, hidden `input[name=id]`, `.remove`;
  `.pick-stop` opens `#stop-picker` with an extra `select[name=route]` (configured routes, then connection routes, then the `listRoutes`
  suggestions) and its `.use` fills the row's `name` (if empty) and `lat`/`lon` (6 decimals) via `stopInfo`; `.here` fills lat/lon
  from `navigator.geolocation`; `.plan-summary` shows `plans[id].summary` and the leave time (`format.clock(plan.leaveAt, clock24)`, appended
  unless the summary already contains it) if `window.__params.plans` has one; empty otherwise.
  `#add-destination` appends a row (`arriveBy` `09:00`, enabled, no days; disabled when 8 rows). Rows without valid lat/lon/arriveBy are
  dropped by `settings.normalize` on save. Schedule fields: `data-field="schedule.<name>"`; `data-field="units"` (select),
  `data-field="clock24"` (checkbox).
- Global functions: `readForm()` → normalized config from the form; `fillForm(config)`; `save()`.
- `save()` navigates to `return_to + encodeURIComponent(JSON.stringify(result))`,
  `result = {config: readForm()}` plus `learned` (object, or `null` = reset) only if changed on the page, plus `clearSamples: true` if requested.

## 11. Watch — `src/c/bus_model.{h,c}`, `src/c/bus_wheel.{h,c}` (pure C, host-tested) and `src/c/main.c` (Pebble UI)

Pure modules include no `pebble.h` in their headers (only `<stdint.h> <stdbool.h> <stddef.h>`), use **no floating point and no
libm** (the Pebble SDK has no `sqrt`; use integer math, e.g. an integer square root), and must build with host gcc
(`-std=c99 -Wall -Wextra -Werror`) and the Pebble toolchain. (The Pebble SDK compiles with `-D_TIME_H_`, so `bus_model.c`
includes `<pebble.h>` when `PBL_RECT`/`PBL_ROUND` is defined, `<time.h>` otherwise.)

### `bus_model.h` — list state and text

```c
#define BUS_MAX_ITEMS 12
#define BUS_TITLE_LEN 32
#define BUS_BADGE_LEN 8
#define BUS_STATUS_LEN 48
enum { BUS_KIND_PICKUP = 0, BUS_KIND_DROPOFF = 1 };
typedef struct { bool present; uint8_t kind; char badge[BUS_BADGE_LEN]; char title[BUS_TITLE_LEN];
                 int32_t color /* 0xRRGGBB, -1 = none */; int32_t t[3]; } BusItem;
typedef struct { int32_t list_id; uint8_t count; BusItem items[BUS_MAX_ITEMS]; char status[BUS_STATUS_LEN]; } BusModel;

void bus_model_init(BusModel *m);                 // list_id -1, count 0, status "Waiting for phone"
void bus_model_begin_list(BusModel *m, int32_t list_id, int count); // count clamped 0..MAX; all items cleared
bool bus_model_set_item(BusModel *m, int32_t list_id, int index, int kind, const char *badge, const char *title,
                        int32_t color, int32_t t0, int32_t t1, int32_t t2);
                                  // false (no change) on list mismatch / bad index; badge/title copied, NUL-terminated,
                                  // cut at a UTF-8 boundary; NULL badge/title → ""
void bus_model_set_status(BusModel *m, const char *status);   // same truncation rule
int  bus_model_row_count(const BusModel *m);                  // count, or 1 when count == 0 (the status row)
const BusItem *bus_model_item(const BusModel *m, int index);  // NULL unless 0 <= index < count and present
int  bus_model_clamp_selection(const BusModel *m, int sel);   // into 0..row_count-1
bool bus_color_prefers_dark_text(int32_t rgb);                // 0.299R + 0.587G + 0.114B > 150 (integer math); -1 → false
void bus_format_relative(int32_t seconds, char *buf, size_t n);  // <= 30 → "now"; < 3600 → "%dm" (floor, min 1);
                                                                  // else "%dh%02d" (e.g. 3720 → "1h02")
void bus_format_clock(int32_t epoch, bool clock24, char *buf, size_t n); // localtime; 24h "HH:MM"; 12h "H:MM" (12 not 0)
void bus_format_detail(const BusItem *it, int32_t now, bool clock24, char *buf, size_t n);
  // pickup : non-zero times as relative, joined ", "  (e.g. "now, 12m, 1h05");  none → "no times"
  // dropoff: t0&&t1 → "off 12:43 / 12:58"; t0 only → "off 12:43";
  //          t1 only → "12m, off 12:58" (t2 relative) or "next off 12:58" if t2 == 0; none → "no buses"
```

### `bus_wheel.h` — the "rotating drum" layout

Rows shrink and indent with distance from the selection, like the face of a turning drum; scrolling animates the
(fractional) position so rows grow/shrink continuously.

```c
#define WHEEL_MAX_SLOTS 9
typedef struct { int16_t width, height; bool round; int16_t row_h[3]; int16_t inset[3]; } WheelGeometry;
typedef struct { int16_t index; int16_t y; int16_t h; int16_t inset; uint8_t level; } WheelSlot;

void bus_wheel_geometry(WheelGeometry *g, int16_t width, int16_t height, bool round);
  // row_h = {52, 34, 24} (height >= 200: {64, 42, 28}); inset = {0, 4, 10}
int  bus_wheel_layout(const WheelGeometry *g, int count, int32_t pos_milli, WheelSlot *out, int max_out);
```

`pos_milli` = selected index × 1000, fractional during animation; clamped to `[0, (count-1)*1000]`. For row *i*,
`d = |i*1000 - pos|` (milli-rows):
- **height** `h(d)`: linear from `row_h[0]` (d=0) to `row_h[1]` (d=1000) to `row_h[2]` (d≥2000), rounded to nearest.
- **inset**: linear `inset[0]→inset[1]→inset[2]` the same way. On round screens: max of that and the circle chord inset at the
  row's edge farther from the vertical centre: `r - isqrt(r² - dy²)` with `r = width/2`, `dy = min(r, |edge - height/2|)`.
- **level**: `d < 500` → 0 (selected), `d < 1500` → 1, else 2 (font/detail choice).
- **position**: with `k = floor(pos/1000)`, `f = pos - k*1000`, `c = height/2`: row *k*'s top is
  `y_k = c - round((h_k*1000 + f*(h_k + h_{k+1})) / 2000)` (`h_{k+1} = h_k` when `k+1` doesn't exist); all other rows stack
  contiguously above/below it. So at `f = 0` row *k* is centred, and the motion is continuous.
- Output: the rows that intersect `[0, height)`, ordered by index, at most `max_out`; returns how many. `count == 0` → 0.

### `BusItem` additions (phase 3)

`int16_t bearing` (−1 = none), `char dist[8]`, `char dir[4]`, `uint8_t lanes` (1|2), `char dir2[4]`, `int32_t u[3]` (lane 2 times), all from
the ITEM_* keys of §7 (missing → −1 / "" / 1 / 0). `bus_format_lane(times, now, buf, n)` = the pickup format above for one lane.
Drop-off detail with t0: `"off 12:43 · 12m"` (relative time left); the rest as before.

### `bus_arrow.h` — the direction arrow (pure)

`int bus_arrow_angle(int bearing, int heading)` → `(bearing − heading)` normalized to [0, 360) (heading −1 = unknown → bearing);
`void bus_arrow_points(int angle_deg, int cx, int cy, int r, BusPoint out[4])` → an arrow-head polygon pointing at `angle_deg` (0 = up,
clockwise), integer math only (a sine table), all points within `r` (+1) of the centre.

### `bus_wakeup.h` — wakeup list (pure)

Accumulates WAKEUP_* messages: `bus_wakeup_begin(n)`, `bus_wakeup_set(i, time, cookie)`, `bus_wakeup_complete()` → true once all n arrived;
`bus_wakeup_plan(now, out, max)` → the received wakeups with time > now, sorted, each ≥ 60 s after the previous (later ones pushed back),
at most 8. main.c then `wakeup_cancel_all()` and `wakeup_schedule(time, cookie, true)` each (retrying +60 s on a conflict).

### `main.c` — UI

- A custom `Layer` draws the wheel from `bus_wheel_layout` (no `MenuLayer`); a small status line (`GOTHIC_14`, the model
  status) sits at the top on rectangular screens / top centre on round ones, the wheel fills the rest.
- Row drawing by `level`:
  - 0 (selected): a **route-color bar 3 px tall above and below the row** marks the selection; route **badge** = rounded rect
    filled with the item color, text `GOTHIC_18_BOLD` in black or white per `bus_color_prefers_dark_text`; title `GOTHIC_24_BOLD`
    (falls back to `GOTHIC_18_BOLD` if it doesn't fit); detail line `GOTHIC_18` (`bus_format_detail`).
  - 1: smaller badge (`GOTHIC_14_BOLD`), title `GOTHIC_18_BOLD`, detail `GOTHIC_14`.
  - 2 (fringe): small badge, title `GOTHIC_14`, no detail; text drawn in a dimmer color on color screens.
  - rows are drawn inset by `slot.inset` on both sides, so the list visibly narrows towards the edges.
  - Color −1 → `GColorCobaltBlue` (color) / black. Aplite/diorite (black & white): badges black with white text, bars black.
- UP/DOWN (repeating, ~120 ms) move the selection; the position animates to the new row over ~180 ms (ease-out) by
  updating `pos_milli` and redrawing; a press during an animation retargets it from the current position.
- SELECT on an item → send `{SELECT_INDEX, LIST_ID}`, short vibe; long SELECT → send `{REFRESH: 1}`.
- **Arrow + distance** on every stop tile (levels 0 and 1): an arrow filled with the route color (black on B&W) pointing at the stop,
  rotated by the compass heading when `compass_service` reports a valid heading (north-up otherwise), with `dist` drawn under it
  (GOTHIC_14). Drop-off tiles: same arrow, `dist` = distance left to ride, and the detail line shows the ETA.
- **Direction labels**: `dir` is shown next to the badge; a two-lane pickup tile shows at level 0 one line per lane:
  `"NB 3m, 12m"` / `"SB 5m"` (level 1: lane 0 only).
- **Notifications**: NOTIFY_* → a notification window (color bar in NOTIFY_COLOR, title, scrollable body), double vibe, light; BACK closes.
- **Wakeups**: WAKEUP_* → bus_wakeup → scheduled as above; `wakeup_service_subscribe` → send `{WAKEUP_FIRED: cookie}`.
- No items → the status centred plus "Hold SELECT to refresh".
- Inbox: `ITEM_COUNT` → `begin_list` (selection kept, clamped); `ITEM_INDEX` → `set_item` (with `ITEM_BADGE`, `ITEM_COLOR`,
  missing color → −1); `STATUS` → `set_status`; then redraw. A minute tick redraws so relative times update.
  `app_message_open(768, 64)`.

## 12. `src/common/directions.js`, `src/common/format.js` (done, shared helpers)

`directions`: `abbreviate(name)` (`'Northbound'`/`'north'`/`'NB'`/`'N'` → `'NB'`, …, else `''`), `fromBearing(deg)` (quadrants centred on
N/E/S/W), `label(route, directionOrId, stopId)` (named direction, else heading to the next stop), `directionsAt(route, stopId)`,
`stopLabel(route, stopId)` (label of its only direction, else `''`). `format`: `distance(m, units)` (≤ 7 bytes: `35m 350m 1.2km 12km` /
`130ft 0.4mi 12mi`), `duration(s)` (`now`, `4 min`, `1 h 05`), `clock(epoch, clock24)` (`8:05 AM` / `08:05`, local time). `geo.bearing(a, b)`.
Tests: `test/directions-format.test.js`.

## 13. `src/common/router.js` — trip planning (independent; requires only geo / directions / format)

```js
plan(source, request, cb)      // cb(err, Plan | null)   null = no way to arrive in time with these routes
describe(plan, opts)           // → string, the notification body. opts = {units, clock24}
summary(plan, opts)            // → short string ≤ 40 chars, e.g. "Leave 8:12 AM · 2 at 8:16 AM"
ESTIMATED_SPEED = 6            // m/s, bus speed used when no live times are available
MAX_ARRIVAL_REQUESTS = 8; DEFAULT_HEADWAY = 900
```

`source` is any provider (§3; only `route` and `arrivals` are used). `request = {origin, destination /*{lat, lon, name?}*/, arriveBy, now, routeIds,
routeNames?: {id: name}, routeColors?: {id: 'RRGGBB'}, walkSpeed, maxWalk, transferWalk, maxTransfers, minTransfer, routeCache?: {id: Route}}`
(the scheduler passes `config.schedule` values; missing ones default to the §2 defaults). Every route in `routeIds` is loaded (cache first, the rest
in parallel; fetched routes are written into `routeCache` when given); failing routes are skipped; `routeIds` non-empty and none loaded → `cb(err)`
(empty `routeIds` → walk only or `null`). Bad request (no origin/destination/arriveBy/now) → `cb(Error)`. `cb` is called exactly once; a source
that throws or calls back twice is tolerated.

- Walking: straight-line meters / `walkSpeed` (seconds, rounded up). Origin→boarding and alighting→destination ≤ `maxWalk`.
- Along-route distance = sum of stop-to-stop straight-line distances in `stopIds` order (stops without coordinates are ignored).
- **Direct**: per route direction, the boarding stop b before the alighting stop a (in `stopIds` order) minimizing the estimated door-to-door time
  (walks + along-route / ESTIMATED_SPEED); directions ranked by it. Live times are fetched in parallel, once per stop
  (`arrivals(stop, 0, min(240, minutes until arriveBy + 30))`), for the best ≤ 3 directions; ≤ `MAX_ARRIVAL_REQUESTS` (8) per plan in total
  (a candidate whose new stops would exceed the budget is skipped). A **live** itinerary = the same `tripKey` (of that route) at b
  (t_b ≥ now + walk to b) and a (t_a > t_b) with t_a + walk from a ≤ arriveBy.
- **Coverage**: a candidate's data *reaches arriveBy* when the last bus leg's boarding or alighting stop lists an arrival (any route) at or after
  arriveBy − final walk. Covered → its best live itinerary or nothing. Not covered (truncated feed, arriveBy beyond the window, failed request) →
  its **estimated** plan, unless a live itinerary leaves later.
- **Estimated**: per leg, ride = median observed t_a − t_b for shared tripKeys, else along-route / ESTIMATED_SPEED (rounded); wait slack = median
  gap between that route's arrivals at the boarding stop, else 900 s. Worked back from arriveBy: final walk, ride, (transfer: walk x→y +
  max(slack, minTransfer)), …; leaveAt = first departAt − slack − first walk (dropped if < now). `estimated: true`, `tripKey: null`, bus leg
  departAt/arriveAt are the latest estimated times, headsign = the direction name.
- **Choice** within a phase: the latest `leaveAt` (t_b − walk to b), ties → shorter total walk, then live over estimated.
- **One transfer** (`maxTransfers` ≥ 1, only when no direct candidate gave a plan): route A b→x, walk x→y ≤ `transferWalk`, route B y→a (A ≠ B),
  best (b, x, y, a) per ordered direction pair, ranked by estimated time (+ `minTransfer`); ≤ 3 checked within the remaining request budget.
  t_y ≥ t_x + walk(x,y) + `minTransfer`; for each first-leg run the connection arriving first (in time) is used.
- **Walk only** when origin→destination ≤ `maxWalk` and leaving at arriveBy − walk is ≥ now: returned without fetching arrivals when the walk is
  no longer than every candidate's estimated door-to-door time; otherwise it wins when it leaves strictly later than the bus plan (or there is none).
- Walk legs with 0 m are omitted. `toName` = the boarding stop's name (first / transfer walk) or `destination.name` (final walk).
- `describe` → lines joined by `\n`: `Leave 8:13 AM`, `Walk 330ft to First Ave (2 min)` (minutes rounded up),
  `Take 2 NB to Downtown at 8:15 AM from First Ave` (headsign omitted when equal to the route name), `Get off at Tower 8:24 AM`, …,
  `Arrive 8:25 AM (by 8:33 AM)`; estimated: every planned time prefixed `~` and a last line `Estimated: no live times yet`. `null` → `No route found`.
- `summary` → `Leave 8:13 AM · 2 at 8:15 AM` (`, then T2` appended for a transfer when it fits), walk only `Leave 8:10 AM · walk 1.2km`,
  estimated `Leave ~8:13 AM · 2 at ~8:15 AM`; truncated to 40 chars with `…`; `null` → `No route found`. Tests: `test/router.test.js`.

```js
Plan = { arriveBy, leaveAt, arriveAt, estimated: bool,
         legs: [ {mode: 'walk', meters, seconds, toName?},
                 {mode: 'bus', routeId, routeName, color, dir, headsign, boardStopId, boardStopName, alightStopId, alightStopName,
                  departAt, arriveAt, tripKey /*null when estimated*/} … ] }
```
`arriveAt` = arrival at the destination (after the final walk); walk only: `leaveAt = arriveBy − walk`, `arriveAt = arriveBy`. `routeName` =
`routeNames[id]` || `route.shortName` || id; `color` = `routeColors[id]` || `route.color` || `''`; `dir` = `directions.label(route, direction, boardStopId)`.

## 14. `src/common/triggers.js` — when to re-check (pure)

```js
nextOccurrence(dest, now)          // epoch s of the next local dest.arriveBy (on dest.days; [] = any day) strictly > now; null if !dest.enabled
build(destinations, plans, now, opts) // → Trigger[] sorted by time.  opts = config.schedule
                                   //   plans = {destId: {occurrence, plan|null}} (stored by the scheduler)
                                   //   per enabled destination with plans[id] and occurrence > now:
                                   //     'check' at (plan ? plan.leaveAt : occurrence − fallbackMinutes·60) − leadMinutes·60
                                   //     'leave' at plan.leaveAt            (only when opts.leaveReminder and plan)
                                   //   times before now are kept as-is (they are due)
                                   //   Trigger = {id: destId + '@' + occurrence + ':' + kind, destinationId, occurrence, kind, time}
due(triggers, now, handled)        // → triggers with time ≤ now, occurrence > now, id not in handled (array of ids)
toWakeups(triggers, now)           // → [{time, cookie}] for triggers with time > now: sorted, each ≥ 60 s after the previous (pushed later),
                                   //   at most 8; cookie = 1-based index in that list
```

## 15. `src/common/scheduler.js` — destinations → plans → triggers → notifications (all I/O injected)

```js
createScheduler(deps) → scheduler
deps = { storage, clock, locate /*cb(err,pos)*/, getConfig /*() → config*/, getSource /*() → provider*/,
         sendWakeups /*(wakeups[])*/, notify /*({title, body, color})*/, log?, router?, triggers? /*default: the real modules*/ }
STORAGE_KEYS = { plans: 'busWatch.plans', handled: 'busWatch.handled' }
```

- `load()`; `plans()` → `{destId: {occurrence, plan, summary, plannedAt}}` (summary = `router.summary` or `'No route found'`).
- `replan(cb)`: origin = `config.location` if mode `'fixed'` else `locate`; for each enabled destination: occurrence = `nextOccurrence`,
  `router.plan` (request from config: `routeIds` = configured + connection routes, names/colors from `config.routes`); store (locate or plan failure →
  `plan: null`); drop plans of removed/disabled destinations; then `reschedule()`. `cb(err, plans)`.
- `reschedule()`: `sendWakeups(triggers.toWakeups(triggers.build(...) minus handled ids, now))`; returns the wakeups.
  `replan` reports locate/plan failures only through `log` (`cb(null, plans)`); one `routeCache` is shared across plans until `getSource()` returns a different object.
- `checkDue(cb)`: for each `triggers.due(...)` (in time order, one at a time): re-plan that destination with a fresh location and live data,
  store it, `notify(...)`, mark handled (keep the newest 100 ids). Notification: 'check' → title `name + ': leave ' + clock(leaveAt)`,
  body `router.describe(plan)`; 'leave' → title `'Leave now: ' + name`; no plan → title `name`, body `'No route found to arrive by ' + clock(arriveBy)`.
  color = the first bus leg's color (or '' ). Then destinations whose stored occurrence ≤ now are re-planned for their next occurrence, and
  `reschedule()`. A `checkDue`/`replan` while one runs → skipped (`cb(null, null)`).
- `checkDue` locates once per call (fixed mode: `config.location`); if the fresh re-plan fails (locate or router error) the stored plan is kept and
  used for the notification (a router `null` = no route). Destinations without a stored plan are planned too. `cb(err, notifications[])`. `handled()` → the id list.
- `handleWakeup(cookie, cb?)` → `checkDue(cb)`. The root should also call `checkDue` on launch / after `replan` (past-due triggers get no wakeup).
- Tests: `test/triggers.test.js`, `test/scheduler.test.js` (fake router).

## 16. Pinned scheduled trip — `triggers.activeTrips`, `src/common/trip-items.js`, session `pinnedItems`

- `triggers.activeTrips(destinations, plans, now, schedule)` → `[{destination, occurrence, plan}]` for enabled destinations with a stored
  plan and `plan.leaveAt − leadMinutes·60 ≤ now ≤ plan.arriveAt + TRIP_GRACE (120 s)`, sorted by `leaveAt`.
- `tripItems.build(active, data, pos, now, {clock24})` (pure; requires geo/format only) → one tile per bus leg with
  `arriveAt + LEG_GRACE (60 s) ≥ now`: `{kind: 'trip', pinned: true, key: 'trip:<destId>:<legIndex>', destinationId, badge: routeName,
  color, dir, title, stopId, times: [departAt, arriveAt, riding ? 1 : 0], bearing, distance, routeLongName: 'Planned trip: <name> · by <clock>',
  estimated, lanes: [], features: {}}`. Before `departAt` the tile is about the boarding stop, after it the alighting stop (riding).
  Stop coordinates come from `data.routes[routeId].stops` (none → `bearing`/`distance` null).
- Protocol: `KIND.trip = 2`; the label travels in `ITEM_ROUTE`; `ITEM_T2` is the riding flag.
- Session: `deps.pinnedItems(config, data, pos, now)` (optional, errors logged → `[]`) is called on every refresh; the sent list is
  `pinned ++ ranked`, ≤ `MAX_ITEMS` (ranked cut first). Pinned tiles are never ranked nor trained on: SELECT on one returns `false`
  (no sample); SELECT below them uses the index within the ranked part; re-sends after learning keep the pinned tiles on top.
- Scheduler: `refreshActive(cb)` re-plans each active trip whose `plannedAt` is ≥ `REFRESH_ACTIVE` (120 s) old, while `now <` first bus
  `departAt − 60` (once on the bus, the plan is kept), same occurrence; then `reschedule()`. `cb(err, refreshedIds)`.
- Root: `pinnedItems = (c, d, p, n) => tripItems.build(triggers.activeTrips(c.destinations, scheduler.plans(), n, c.schedule), d, p, n, {clock24})`;
  each tick runs `checkDue` then `refreshActive` (they share the scheduler's busy guard).
- Watch: `BUS_KIND_TRIP = 2` tiles carry a visible "planned trip" marker at every wheel level; detail before departure `"board 8:16 · 4m"`,
  riding `"off 8:31 · 12m"`. Tests: `test/trip-items.test.js`, `test/schedule-integration.test.js`.
