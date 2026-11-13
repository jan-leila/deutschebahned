// Live smoke test against Metro Transit's real API (needs network; not part of `npm test`).
// Runs the real phone pipeline (session + Metro Transit provider + planner + ranking + protocol) at a
// Minneapolis location and prints what the watch would show.
//
// usage (inside nix-shell): node tools/smoke-metrotransit.js [lat lon] [routes] [pinnedRoute:stopId]
//   default: Franklin Ave & Lyndale Ave S, routes 2 and 922 (B Line), route 2 pinned to 8th St SE & 5th Ave SE (16058)
const https = require('https');
const { createSession } = require('../src/common/session');
const { createRegistry } = require('../src/sources/registry');
const createProvider = (config, deps) => createRegistry(require('../src/sources/all')).create(config, deps);

const [lat, lon] = [Number(process.argv[2] || 44.96265), Number(process.argv[3] || -93.2895)];
const routes = (process.argv[4] || '2,922').split(',');
const [pinRoute, pinStop] = (process.argv[5] || '2:16058').split(':');

function http(url, cb) {
  const req = https.get(url, { timeout: 20000 }, res => {
    let body = '';
    res.on('data', d => (body += d));
    res.on('end', () => { try { cb(null, JSON.parse(body)); } catch (e) { cb(new Error('bad JSON from ' + url + ' (HTTP ' + res.statusCode + ')')); } });
  });
  req.on('timeout', () => req.destroy(new Error('timeout ' + url)));
  req.on('error', cb);
}
let requests = 0;
const countingHttp = (url, cb) => { requests++; http(url, cb); };

const store = new Map();
const storage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
storage.setItem('busWatch.config', JSON.stringify({
  provider: { type: 'metrotransit' },
  location: { mode: 'fixed', lat, lon },
  stopRadius: 400, routeRadius: 120,
  routes: routes.map(id => ({ id })),
  connections: [{ routeId: pinRoute, stopId: pinStop, name: 'Pinned ' + pinStop }],
}));
const clock = () => Math.floor(Date.now() / 1000);
const sent = [];
const session = createSession({
  storage, clock,
  locate: cb => cb(new Error('fixed location only')),
  createProvider: config => createProvider(config, { http: countingHttp, clock, storage }),
  send: m => sent.push(...m),
  log: msg => console.log('  log:', msg),
});
session.load();

const t0 = Date.now();
session.refresh((err, items) => {
  console.log(`refresh took ${((Date.now() - t0) / 1000).toFixed(1)} s, ${requests} HTTP requests`);
  if (err) { console.error('ERROR', err.message); process.exit(1); }
  const now = clock();
  const rel = t => (t ? Math.round((t - now) / 60) + 'm' : '-');
  console.log(`${items.length} items at ${lat},${lon}:`);
  for (const it of items) {
    console.log(`  [${it.badge} #${it.color}] ${it.kind.padEnd(7)} ${it.title.padEnd(34)} ${it.times.map(rel).join(' ')}  score ${it.score.toFixed(0)}`);
  }
  const msgs = sent.filter(m => 'ITEM_INDEX' in m);
  console.log(`watch messages: ${msgs.length} items, e.g.`, JSON.stringify(msgs[0] || null));
  // second refresh should be served from the route cache
  const before = requests;
  session.refresh(() => {
    console.log(`second refresh: ${requests - before} HTTP requests (route geometry cached)`);
    process.exit(0);
  });
});
