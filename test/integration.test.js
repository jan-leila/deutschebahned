// Integration: the real session + mock provider + planner + ranking + optimize + protocol, no fakes
// except storage, clock and the message sink.
const test = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../src/common/settings');
const { createSession } = require('../src/common/session');
const { createRegistry } = require('../src/sources/registry');
const federation = require('../src/common/federation');
// the same federated provider src/pkjs/index.js builds: every configured system, ids 'system/id'
const createProvider = (config, deps) => federation.fromConfig(createRegistry(require('../src/sources/all')), config, deps);

const geo = require("../src/common/geo");
const CENTER = { lat: 47.6, lon: -122.3 };

function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}

function world(extra, pos) {
  // the mock network is centred on config.location; the user (gps) is at `pos` (default: the centre)
  let now = 1_800_000_123;
  pos = pos || CENTER;
  const sent = [];
  const storage = memoryStorage();
  storage.setItem('busWatch.config', JSON.stringify(Object.assign({
    version: 2,
    providers: [{ id: 'mock', type: 'mock' }],
    location: { mode: "gps", lat: CENTER.lat, lon: CENTER.lon },
    routes: [{ providerId: 'mock', id: 'R1', name: 'One' }, { providerId: 'mock', id: 'R2', name: 'Two' }],
    stops: [{ providerId: 'mock', id: 'R1:s12', name: 'Work' }],
  }, extra || {})));
  const session = createSession({
    storage,
    clock: () => now,
    locate: cb => setTimeout(() => cb(null, pos), 0),
    createProvider: config => createProvider(config, { http: () => { throw new Error('no network in tests'); }, clock: () => now }),
    send: messages => sent.push(...messages),
  });
  session.load();
  return { session, sent, storage, advance: s => { now += s; }, now: () => now };
}
const refresh = s => new Promise((resolve, reject) => s.refresh((e, items) => (e ? reject(e) : resolve(items))));
const lastHeader = sent => sent.filter(m => 'ITEM_COUNT' in m).pop();
const lastItems = sent => {
  const h = lastHeader(sent);
  return sent.filter(m => m.LIST_ID === h.LIST_ID && 'ITEM_INDEX' in m);
};

test('pipeline: nearby pickups and an on-route drop-off reach the watch', async () => {
  const w = world();
  const items = await refresh(w.session);
  const kinds = items.map(i => i.kind);
  assert.equal(kinds.filter(k => k === 'pickup').length, 4, JSON.stringify(items.map(i => i.key)));
  assert.equal(kinds.filter(k => k === 'dropoff').length, 1);
  const drop = items.find(i => i.kind === 'dropoff');
  assert.equal(drop.badge, 'One');
  assert.equal(drop.title, 'Work');
  assert.equal(drop.color, 'E53935', 'mock route color');
  assert.ok(drop.times[1] > w.now(), 'next bus drop-off time in the future');
  assert.ok(drop.times[2] > w.now() && drop.times[2] < drop.times[1], 'next bus is here before it reaches the pinned stop');
  // sorted by score, descending
  for (let i = 1; i < items.length; i++) assert.ok(items[i - 1].score >= items[i].score);
  // the watch got the same list
  const header = lastHeader(w.sent);
  assert.equal(header.ITEM_COUNT, items.length);
  assert.match(header.STATUS, /^Updated /);
  assert.deepEqual(lastItems(w.sent).map(m => m.ITEM_TITLE), items.map(i => i.title));
  assert.deepEqual(lastItems(w.sent).map(m => m.ITEM_BADGE), items.map(i => i.badge));
  assert.ok(lastItems(w.sent).every(m => m.ITEM_COLOR === 0xE53935 || m.ITEM_COLOR === 0x1E88E5));
  assert.deepEqual(lastItems(w.sent).map(m => m.ITEM_KIND), items.map(i => (i.kind === 'pickup' ? 0 : 1)));
});

test('pipeline: a bus that just left the here-stop is reported as the one you are on', async () => {
  const w = world(null, geo.offset(CENTER, 50, 180)); // 50 m back along R1: here stop is s7
  // mock: R1 trips depart s0 every 600 s and reach stop k at T + 50k; here stop is s7 (T+350), pinned s12 (T+600)
  const base = Math.floor(w.now() / 600) * 600;
  w.advance(base + 350 + 60 - w.now()); // a bus passed s7 60 s ago
  const items = await refresh(w.session);
  const drop = items.find(i => i.kind === 'dropoff');
  assert.equal(drop.times[0], base + 600, 'on-bus drop-off');
  assert.equal(drop.times[1], base + 600 + 600, 'next bus drop-off');
  assert.equal(drop.times[2], base + 600 + 350, 'next bus at the here stop');
});

test('pipeline: off the route there is no drop-off, only pickups', async () => {
  const w = world(null, geo.offset(CENTER, 300, 90)); // 300 m east: off R1 (north-south), 150 m off R2
  const items = await refresh(w.session);
  assert.ok(items.length > 0);
  assert.ok(items.every(i => i.kind === 'pickup'));
});

test('learning: repeatedly picking an item that ranks low moves it to the top', async () => {
  // The user only cares about route Two's pickups; every scale starts at 0, so only learning can put Two first.
  const w = world({ training: { autoTrain: true, iterations: 200 } });
  let firstHits = 0;
  const rounds = 25;
  for (let r = 0; r < rounds; r++) {
    w.advance(97);
    const items = await refresh(w.session);
    const want = items.findIndex(i => i.kind === 'pickup' && i.routeId === 'mock/R2');
    assert.ok(want >= 0);
    if (r >= rounds - 5 && want === 0) firstHits++;
    const listId = w.session.lastList().listId;
    assert.equal(w.session.select(listId, want), true);
    assert.equal(lastHeader(w.sent).STATUS, `Learned (${r + 1} picks)`);
  }
  assert.equal(w.session.getSamples().length, rounds);
  assert.ok(Object.keys(w.session.getLearned()).length > 0);
  assert.ok(firstHits >= 4, `route Two first in only ${firstHits}/5 of the last rounds`);
  // learned weights survive a restart via storage
  const again = createSession({ storage: w.storage, clock: w.now, locate: () => {}, createProvider: () => null, send: () => {} });
  again.load();
  assert.deepEqual(again.getLearned(), w.session.getLearned());
});

test('settings round trip: applySettings with clearSamples + learned reset', async () => {
  const w = world();
  await refresh(w.session);
  w.session.select(w.session.lastList().listId, 0);
  assert.equal(w.session.getSamples().length, 1);
  const params = w.session.configPageParams();
  w.session.applySettings({ config: Object.assign({}, params.config, { maxItems: 2 }), learned: null, clearSamples: true });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(w.session.getConfig().maxItems, 2);
  assert.deepEqual(w.session.getSamples(), []);
  assert.deepEqual(w.session.getLearned(), {});
  assert.equal(lastHeader(w.sent).ITEM_COUNT, 2);
  assert.deepEqual(settings.normalize(w.session.getConfig()), w.session.getConfig());
});

test('pipeline: riding a bus — the live vehicle next to you gives the drop-off time', async () => {
  // mock: an R1 bus is 8 m/s * (now - T) along the line from its start (3000 m before the centre)
  const probe = world();
  const base = Math.floor(probe.now() / 600) * 600;
  const elapsed = probe.now() - base;                                // the bus that left stop 0 at `base`
  const start = geo.offset(CENTER, 3000, 180);                        // R1 runs north (bearing 0)
  const onBus = geo.offset(start, 8 * elapsed + 15, 0);               // you sit 15 m from its reported position
  const w = world(null, onBus);
  const items = await refresh(w.session);
  const drop = items.find(i => i.kind === 'dropoff');
  assert.ok(drop, 'on the route -> drop-off row');
  assert.equal(drop.times[0], base + 12 * 50, 'drop-off of the bus you are on: its arrival at stop 12');
});

test('two transit systems: only the one whose coverage area contains you is asked; its stops drop off on its routes', async () => {
  // 'home' covers the centre (automatic: around its saved stop), 'away' is set to another city
  const home = { id: 'home', type: 'mock' };
  const away = { id: 'away', type: 'mock', coverage: { mode: 'manual', lat: 44.97, lon: -93.26, radius: 30000 } };
  const w = world({ providers: [home, away],
    routes: [{ providerId: 'home', id: 'R1', name: 'One' }, { providerId: 'away', id: 'R1', name: 'Away One' }],
    stops: [{ providerId: 'home', id: 'R1:s12', name: 'Work', lat: CENTER.lat + 0.01, lon: CENTER.lon },
            { providerId: 'away', id: 'R1:s12', name: 'Elsewhere' }] });
  const items = await refresh(w.session);
  assert.ok(items.length > 0);
  assert.ok(items.every(i => i.routeId === 'home/R1'), JSON.stringify(items.map(i => i.key)));
  const drop = items.find(i => i.kind === 'dropoff');
  assert.equal(drop.title, 'Work');
  assert.ok('ride:home/R1:s12' in drop.features);
  assert.ok(items.some(i => i.kind === 'pickup' && Object.keys(i.features).some(k => k.startsWith('stop:home/'))));
});
