// Live smoke test of the trip router against Metro Transit (needs network; not part of `npm test`).
// usage (inside nix-shell): node tools/smoke-route.js [fromLat fromLon] [toLat toLon] [minutesFromNow] [routes]
//   default: Franklin Ave & Lyndale Ave S → 8th St SE & 5th Ave SE, arrive in 45 min, routes 2,922
const https = require('https');
const router = require('../src/common/router');
const settings = require('../src/common/settings');
const { createRegistry } = require('../src/sources/registry');

const a = process.argv.slice(2);
const origin = { lat: Number(a[0] || 44.96265), lon: Number(a[1] || -93.2895) };
const destination = { lat: Number(a[2] || 44.9894), lon: Number(a[3] || -93.2453), name: 'Destination' };
const minutes = Number(a[4] || 45);
const routeIds = (a[5] || '2,922').split(',');

let requests = 0;
function http(url, cb) {
  requests++;
  https.get(url, { timeout: 20000 }, res => {
    let body = '';
    res.on('data', d => (body += d));
    res.on('end', () => { try { cb(null, JSON.parse(body)); } catch (e) { cb(new Error('bad JSON ' + url)); } });
  }).on('error', cb);
}
const store = new Map();
const storage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
const clock = () => Math.floor(Date.now() / 1000);
const config = settings.normalize({ routes: routeIds.map(id => ({ id })) });
const source = createRegistry(require('../src/sources/all')).create(config, { http, clock, storage });

const now = clock();
const t0 = Date.now();
router.plan(source, Object.assign({}, config.schedule, { origin, destination, now, arriveBy: now + minutes * 60, routeIds }), (err, plan) => {
  console.log(`planned in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${requests} HTTP requests`);
  if (err) { console.error('ERROR', err.message); process.exit(1); }
  const opts = { units: config.units, clock24: config.clock24 };
  console.log('summary :', router.summary(plan, opts));
  console.log(router.describe(plan, opts));
  if (plan) console.log(JSON.stringify(plan.legs, null, 1).slice(0, 1500));
});
