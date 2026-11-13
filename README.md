# Bus Watch

A Pebble watchapp for the buses you actually ride.

- **Pickups:** when you're near a stop served by one of *your* routes, it shows that route's next pickup times at the stop.
- **Drop-offs:** when you're within a set distance of one of your routes' paths, it shows when you'd reach each *pinned stop*. You get one time for the bus that was physically here within the last *x* seconds (probably the one you're on) and one for the next bus to come by.
- **Ordering:** each row's score is `Σ scale × value`. Stop and connection scales multiply meters, route scales multiply seconds, and higher scores show first, so negative scales put nearer and sooner rows first.
- **Learning:** press **SELECT** on the row you care about right now. The phone records the position, every row's distance and time values, and which row you picked. It then fits the scales (a softmax over row scores against the one-hot pick, L2-pulled toward your configured scales). Hold **SELECT** to refresh.

Everything is configured on the phone in the app's settings page: transit API, routes, pinned stops, distances, time windows, scales and training options. The page can also train on demand, bake learned weights into the scales, or reset them.

Transit data comes from **Metro Transit (Minneapolis–St Paul)** by default: the public NexTrip v2 and Schedule APIs at `svc.metrotransit.org`, which need no API key. The settings page can suggest route ids, load each route's official color, and pick pinned stops from a route's stop list. Route geometry is built from the stop lists plus per-stop coordinates (about 85 requests the first time per route), then cached on the phone for 7 days. "The bus you're on" comes from live vehicle positions (`vehicleRadius`). Providers sit behind a small interface (`src/common/providers/`): [OneBusAway](https://onebusaway.org/) works for other cities, and a deterministic `mock` is used for demos and tests.

On the watch the list is a **rotating drum**. The selected row is full size, with bars in its route color above and below it and a colored route badge. Rows further away shrink, dim and narrow (following the circle on round watches), and scrolling animates between rows.

## Build

```
nix-shell                       # pebble.nix pinned with npins (see shell.nix)
pebble sdk install 4.9.169      # once
node tools/build-config.js      # regenerate src/pkjs/config-page.js after editing config/
pebble build                    # -> build/bus-watch.pbw
pebble install --emulator basalt
```

## Tests

Each part is tested on its own (see `CONTRACTS.md` for the interfaces):

| part | test | command (inside nix-shell) |
|---|---|---|
| settings model | `test/settings.test.js` | `node tools/run-tests.js settings` |
| transit API (Metro Transit, OBA, mock) | `test/providers.test.js` + `test/fixtures/` | `node tools/run-tests.js providers` |
| pickup / drop-off planner | `test/planner.test.js` | `node tools/run-tests.js planner` |
| list sorting | `test/ranking.test.js` | `node tools/run-tests.js ranking` |
| scale optimizer | `test/optimize.test.js` | `node tools/run-tests.js optimize` |
| phone⇄watch protocol, session | `test/protocol.test.js`, `test/session.test.js` | `node tools/run-tests.js protocol session` |
| settings page (headless Chromium) | `test/config-page.test.js` | `node tools/run-tests.js config-page` |
| watch UI model + wheel layout (host gcc) | `test/c/test_bus_model.c`, `test/c/test_bus_wheel.c` | `node tools/run-tests.js c-model` |
| watch UI in the emulator (fixture data) | `tools/test-ui-emulator.sh [platform]` | |
| integration (all JS parts together) | `test/integration.test.js`, `test/pkjs-glue.test.js` | `node tools/run-tests.js integration pkjs-glue` |
| end to end in the emulator | `tools/test-app-emulator.sh [platform]` | |

`node tools/run-tests.js` runs every `test/*.test.js`. `node tools/smoke-metrotransit.js [lat lon] [routes] [route:stop]` runs the real pipeline against the live Metro Transit API.
