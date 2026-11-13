// session.js is tested with every collaborator faked, so it is independent of planner/ranking/optimize.
const test = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../src/common/settings');
const { createSession, STORAGE_KEYS } = require('../src/common/session');

function memoryStorage(init) {
  const m = new Map(Object.entries(init || {}));
  return {
    map: m,
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
  };
}

const NOW = 1_800_000_000;
const ITEMS = [
  { kind: 'pickup', key: 'p1', title: 'P1', times: [NOW + 60], features: { 'stop:a': 100, 'route:r': 60 } },
  { kind: 'dropoff', key: 'd1', title: 'D1', times: [0, NOW + 600, NOW + 120], features: { 'ride:z': 10, 'route:r': 600 } },
];

function harness(opts) {
  opts = opts || {};
  const sent = [];
  const calls = { gather: 0, createProvider: 0, train: [], locate: 0 };
  const storage = memoryStorage(opts.storage);
  const deps = {
    storage,
    clock: () => NOW,
    locate: cb => { calls.locate++; setTimeout(() => (opts.locateErr ? cb(new Error(opts.locateErr)) : cb(null, { lat: 10, lon: 20 })), 0); },
    createProvider: config => { calls.createProvider++; return { fake: true, config }; },
    send: messages => sent.push(...messages),
    log: () => {},
    planner: {
      gather: (provider, config, pos, now, cache, cb) => {
        calls.gather++;
        calls.lastGather = { provider, config, pos, now, cache };
        setTimeout(() => (opts.gatherErr ? cb(new Error(opts.gatherErr)) : cb(null, { stops: [], routes: {}, arrivals: {}, errors: [] })), 0);
      },
      buildItems: () => (opts.items || ITEMS).map(i => ({ ...i })),
    },
    ranking: {
      // fake rank: reverse order when learned has 'flip', else keep order; tag score
      rank: (items, config, learned) => {
        const out = items.map((i, n) => ({ ...i, score: -n }));
        return learned && learned.flip ? out.reverse() : out;
      },
      weightFor: (key, config, learned) => (learned ? 99 : -1),
    },
    optimize: {
      makeSample: (items, index, pos, now) => ({ t: now, lat: pos.lat, lon: pos.lon, chosen: index, candidates: items.map(i => ({ key: i.key, features: i.features })) }),
      train: (samples, priorFn, o) => { calls.train.push({ n: samples.length, prior: priorFn('x'), opts: o }); return { weights: { flip: 1 }, before: {}, after: {} }; },
    },
  };
  const session = createSession(deps);
  return { session, sent, calls, storage };
}
const refresh = s => new Promise((resolve, reject) => s.refresh((e, items) => (e ? reject(e) : resolve(items))));
const statuses = sent => sent.filter(m => 'STATUS' in m && !('ITEM_COUNT' in m)).map(m => m.STATUS);

test('storage keys', () => {
  assert.deepEqual(STORAGE_KEYS, { config: 'busWatch.config', samples: 'busWatch.samples', learned: 'busWatch.learned',
    prefs: 'busWatch.prefs' });
});

test('load: defaults on empty or corrupt storage', () => {
  const { session } = harness({ storage: { 'busWatch.config': '{bad', 'busWatch.samples': 'nope', 'busWatch.learned': '[]x' } });
  session.load();
  assert.deepEqual(session.getConfig(), settings.defaults());
  assert.deepEqual(session.getSamples(), []);
  assert.deepEqual(session.getLearned(), {});
  assert.equal(session.lastList(), null);
});

test('load: reads and normalizes stored values', () => {
  const { session } = harness({ storage: {
    'busWatch.config': JSON.stringify({ version: 2, providers: [{ id: 'p', type: 'mock' }], maxItems: '5' }),
    'busWatch.samples': JSON.stringify([{ chosen: 0, candidates: [] }]),
    'busWatch.learned': JSON.stringify({ 'stop:p/a': -2 }) } });
  session.load();
  assert.equal(session.getConfig().maxItems, 5);
  assert.equal(session.getSamples().length, 1);
  assert.deepEqual(session.getLearned(), { 'stop:p/a': -2 });
});

test('load: a version 1 config is migrated, with its learned weights and samples', () => {
  const h = harness({ storage: {
    'busWatch.config': JSON.stringify({ provider: { type: 'onebusaway', apiKey: 'k' }, routes: [{ id: 'r', scale: -2 }],
      connections: [{ routeId: 'r', stopId: 'z', name: 'Home', scale: -3 }], stopScales: { a: -1 } }),
    'busWatch.samples': JSON.stringify([{ chosen: 0, candidates: [{ key: 'x', features: { 'stop:a': 5, 'conn:r|z': 7, 'route:r': 9 } }] }]),
    'busWatch.learned': JSON.stringify({ 'stop:a': -2, 'conn:r|z': -4, 'route:r': -1, other: 3 }) } });
  h.session.load();
  const c = h.session.getConfig();
  assert.deepEqual(c.providers.map(p => [p.id, p.type, p.apiKey]), [['onebusaway', 'onebusaway', 'k']]);
  assert.deepEqual(c.routes.map(r => [r.providerId, r.id, r.scale]), [['onebusaway', 'r', -2]]);
  assert.deepEqual(c.stops.map(s => [s.id, s.name, s.walkScale, s.rideScale]), [['z', 'Home', 0, -3], ['a', 'a', -1, 0]]);
  assert.deepEqual(h.session.getLearned(), { 'stop:onebusaway/a': -2, 'ride:onebusaway/z': -4, 'route:onebusaway/r': -1, other: 3 });
  assert.deepEqual(h.session.getSamples()[0].candidates[0].features,
    { 'stop:onebusaway/a': 5, 'ride:onebusaway/z': 7, 'route:onebusaway/r': 9 });
  assert.equal(JSON.parse(h.storage.getItem('busWatch.config')).version, 2, 'saved migrated');
  assert.deepEqual(JSON.parse(h.storage.getItem('busWatch.learned')), h.session.getLearned());
  // loading again changes nothing
  h.session.load();
  assert.deepEqual(h.session.getLearned(), { 'stop:onebusaway/a': -2, 'ride:onebusaway/z': -4, 'route:onebusaway/r': -1, other: 3 });
});

test('refresh: the planner and ranking get the runtime view at the position', async () => {
  const h = harness({ storage: { 'busWatch.config': JSON.stringify({ version: 2,
    providers: [{ id: 'near', type: 'mock' }, { id: 'far', type: 'mock', coverage: { mode: 'manual', lat: -40, lon: 170, radius: 10000 } }],
    routes: [{ providerId: 'near', id: 'A' }, { providerId: 'far', id: 'B' }] }) } });
  h.session.load();
  await refresh(h.session);
  const cfg = h.calls.lastGather.config;
  assert.deepEqual(cfg.routes.map(r => r.id), ['near/A']);
  assert.deepEqual(cfg.providers, ['near']);
  assert.equal(h.calls.lastGather.provider.config, h.session.getConfig(), 'the provider is built from the saved config');
});

test('refresh (gps): statuses, then a ranked list with an incrementing list id', async () => {
  const h = harness();
  h.session.load();
  const items = await refresh(h.session);
  assert.equal(items.length, 2);
  assert.deepEqual(statuses(h.sent), ['Locating...', 'Loading...']);
  const header = h.sent.find(m => 'ITEM_COUNT' in m);
  assert.equal(header.LIST_ID, 1);
  assert.equal(header.ITEM_COUNT, 2);
  assert.match(header.STATUS, /^Updated \d\d:\d\d$/);
  assert.deepEqual(h.sent.filter(m => 'ITEM_INDEX' in m).map(m => m.ITEM_TITLE), ['P1', 'D1']);
  assert.deepEqual(h.calls.lastGather.pos, { lat: 10, lon: 20 });
  assert.equal(h.calls.lastGather.now, NOW);
  assert.equal(h.calls.locate, 1);
  assert.deepEqual(h.session.lastList().listId, 1);
  await refresh(h.session);
  assert.equal(h.sent.filter(m => 'ITEM_COUNT' in m).pop().LIST_ID, 2);
  assert.equal(h.calls.createProvider, 1, 'provider reused');
  const cache1 = h.calls.lastGather.cache;
  await refresh(h.session);
  assert.equal(h.calls.lastGather.cache, cache1, 'route cache reused');
});

test('refresh (fixed location) skips locate', async () => {
  const h = harness({ storage: { 'busWatch.config': JSON.stringify({ location: { mode: 'fixed', lat: 1, lon: 2 } }) } });
  h.session.load();
  await refresh(h.session);
  assert.equal(h.calls.locate, 0);
  assert.deepEqual(h.calls.lastGather.pos, { lat: 1, lon: 2 });
});

test('refresh: empty list status, errors reported', async () => {
  const h = harness({ items: [] });
  h.session.load();
  await refresh(h.session);
  assert.equal(h.sent.find(m => 'ITEM_COUNT' in m).STATUS, 'No buses nearby');

  const e1 = harness({ locateErr: 'no gps' });
  e1.session.load();
  await assert.rejects(refresh(e1.session), /no gps/);
  assert.equal(statuses(e1.sent).pop(), 'Error: no gps');

  const e2 = harness({ gatherErr: 'api down' });
  e2.session.load();
  await assert.rejects(refresh(e2.session));
  assert.equal(statuses(e2.sent).pop(), 'Error: api down');
});

test('refresh while one is running is skipped', async () => {
  const h = harness();
  h.session.load();
  const a = refresh(h.session);
  const b = refresh(h.session);
  assert.equal(await b, null);
  await a;
  assert.equal(h.calls.gather, 1);
});

test('select: records a sample, trains with the config prior, re-sends the re-ranked list', async () => {
  const h = harness();
  h.session.load();
  await refresh(h.session);
  h.sent.length = 0;
  assert.equal(h.session.select(1, 1), true);
  const samples = h.session.getSamples();
  assert.equal(samples.length, 1);
  assert.deepEqual(samples[0], { t: NOW, lat: 10, lon: 20, chosen: 1,
    candidates: [{ key: 'p1', features: ITEMS[0].features }, { key: 'd1', features: ITEMS[1].features }] });
  assert.equal(JSON.parse(h.storage.getItem('busWatch.samples')).length, 1);
  assert.equal(h.calls.train.length, 1);
  assert.equal(h.calls.train[0].prior, -1, 'prior is weightFor(key, config, null)');
  assert.deepEqual(h.calls.train[0].opts, settings.defaults().training);
  assert.deepEqual(h.session.getLearned(), { flip: 1 });
  assert.deepEqual(JSON.parse(h.storage.getItem('busWatch.learned')), { flip: 1 });
  const header = h.sent.find(m => 'ITEM_COUNT' in m);
  assert.equal(header.LIST_ID, 2);
  assert.equal(header.STATUS, 'Learned (1 picks)');
  assert.deepEqual(h.sent.filter(m => 'ITEM_INDEX' in m).map(m => m.ITEM_TITLE), ['D1', 'P1'], 're-ranked with learned');
});

test('select: stale list id or bad index is ignored', async () => {
  const h = harness();
  h.session.load();
  assert.equal(h.session.select(1, 0), false, 'nothing sent yet');
  await refresh(h.session);
  assert.equal(h.session.select(7, 0), false);
  assert.equal(h.session.select(1, 5), false);
  assert.equal(h.session.select(1, -1), false);
  assert.equal(h.session.getSamples().length, 0);
});

test('select: autoTrain off records only; samples capped at maxSamples (newest kept)', async () => {
  const h = harness({ storage: { 'busWatch.config': JSON.stringify({ training: { autoTrain: false, maxSamples: 2 } }) } });
  h.session.load();
  await refresh(h.session);
  let id = 1;
  for (let i = 0; i < 3; i++) { assert.ok(h.session.select(id, i % 2)); id = h.session.lastList().listId; }
  assert.equal(h.calls.train.length, 0);
  assert.deepEqual(h.session.getSamples().map(s => s.chosen), [1, 0]);
});

test('handleWatchMessage dispatches and returns the decoded message', async () => {
  const h = harness();
  h.session.load();
  assert.deepEqual(h.session.handleWatchMessage({ REFRESH: 1 }), { type: 'refresh' });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(h.calls.gather, 1);
  assert.deepEqual(h.session.handleWatchMessage({ SELECT_INDEX: 0, LIST_ID: 1 }), { type: 'select', listId: 1, index: 0 });
  assert.equal(h.session.getSamples().length, 1);
  assert.equal(h.session.handleWatchMessage({ junk: 1 }), null);
  const sent = h.sent.length;
  assert.deepEqual(h.session.handleWatchMessage({ WAKEUP_FIRED: 2 }), { type: 'wakeup', cookie: 2 });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(h.calls.gather, 1, 'a wakeup is left to the caller (scheduler), no refresh');
  assert.equal(h.sent.length, sent);
});

test("lists are encoded with the watch's units", async () => {
  const items = [{ kind: 'pickup', key: 'p', title: 'P', times: [NOW + 60], distance: 350, bearing: 90, features: {} }];
  const metric = harness({ items, storage: { 'busWatch.prefs': JSON.stringify({ units: 'metric', clock24: true, known: true }) } });
  metric.session.load();
  await refresh(metric.session);
  assert.equal(metric.sent.find(m => 'ITEM_INDEX' in m).ITEM_DIST, '350m');
  assert.equal(metric.sent.find(m => 'ITEM_INDEX' in m).ITEM_BEARING, 90);
  const imperial = harness({ items });   // nothing from the watch yet, no locale: metric is the guess
  imperial.session.load();
  imperial.session.setPrefs({ clock24: false, units: 'imperial' });
  await refresh(imperial.session);
  assert.equal(imperial.sent.find(m => 'ITEM_INDEX' in m).ITEM_DIST, '0.2mi');
  // re-sent lists after select use the units too
  metric.sent.length = 0;
  metric.session.select(1, 0);
  assert.equal(metric.sent.find(m => 'ITEM_INDEX' in m).ITEM_DIST, '350m');
});

test('applySettings: saves normalized config, learned/clear handling, rebuilds provider, refreshes', async () => {
  const h = harness({ storage: {
    'busWatch.samples': JSON.stringify([{ chosen: 0, candidates: [] }]),
    'busWatch.learned': JSON.stringify({ 'stop:a': -2 }) } });
  h.session.load();
  await refresh(h.session);
  const before = h.calls.lastGather.cache;
  h.session.applySettings({ config: { maxItems: '3', foo: 1 } });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(h.session.getConfig().maxItems, 3);
  assert.equal(JSON.parse(h.storage.getItem('busWatch.config')).maxItems, 3);
  assert.deepEqual(h.session.getLearned(), { 'stop:a': -2 }, 'learned kept when not given');
  assert.equal(h.session.getSamples().length, 1, 'samples kept unless cleared');
  assert.equal(h.calls.createProvider, 2, 'provider rebuilt');
  assert.notEqual(h.calls.lastGather.cache, before, 'route cache reset');
  assert.equal(h.calls.gather, 2, 'refreshed');

  h.session.applySettings({ config: {}, learned: null, clearSamples: true });
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(h.session.getLearned(), {});
  assert.deepEqual(h.session.getSamples(), []);
  assert.deepEqual(JSON.parse(h.storage.getItem('busWatch.samples')), []);
  h.session.applySettings({ config: {}, learned: { 'route:r': -0.3 } });
  assert.deepEqual(h.session.getLearned(), { 'route:r': -0.3 });
});

test('watch prefs: saved, re-send the last list when the units change, known once the watch says', async () => {
  const items = [{ kind: 'pickup', key: 'p', title: 'P', times: [NOW + 60], distance: 350, bearing: 90, features: {} }];
  const h = harness({ items });
  h.session.load();
  assert.deepEqual(h.session.getPrefs(), { units: 'metric', clock24: false, known: false });
  assert.equal(h.session.setPrefs({ clock24: true, units: 'imperial' }), true, 'before any list: just saved');
  assert.equal(h.sent.length, 0);
  await refresh(h.session);
  h.sent.length = 0;
  assert.deepEqual(h.session.handleWatchMessage({ WATCH_PREFS: 1 | 2 | 4 }), { type: 'prefs', clock24: true, units: 'metric' });
  const header = h.sent.find(m => 'ITEM_COUNT' in m);
  assert.ok(header && header.LIST_ID === 2, 'list re-sent with a new id');
  assert.equal(h.sent.find(m => 'ITEM_INDEX' in m).ITEM_DIST, '350m');
  assert.deepEqual(JSON.parse(h.storage.getItem('busWatch.prefs')), { clock24: true, units: 'metric', known: true });
  h.sent.length = 0;
  assert.equal(h.session.setPrefs({ clock24: true, units: 'metric' }), false, 'unchanged');
  assert.equal(h.session.setPrefs({ clock24: false, units: null }), true, 'units unknown: kept');
  assert.equal(h.session.getPrefs().units, 'metric');
  assert.equal(h.sent.length, 0, 'clock only: nothing re-sent');
  assert.equal(h.session.runtimeConfig(null).clock24, false);
  // a new session reads them back
  const again = createSession({ storage: h.storage, clock: () => NOW, locate() {}, createProvider() {}, send() {} });
  again.load();
  assert.deepEqual(again.getPrefs(), { units: 'metric', clock24: false, known: true });
});

test('configPageParams', () => {
  const h = harness();
  h.session.load();
  const p = h.session.configPageParams();
  assert.deepEqual(Object.keys(p).sort(), ['config', 'learned', 'prefs', 'samples']);
  assert.deepEqual(p.config, settings.defaults());
  assert.deepEqual(p.prefs, h.session.getPrefs());
});

test('lists follow the showWalk / showArrow settings', async () => {
  const items = [{ kind: 'pickup', key: 'p', title: 'P', times: [NOW + 60], distance: 350, bearing: 90, walk: 270, features: {} }];
  const on = harness({ items });
  on.session.load();
  await refresh(on.session);
  const m = on.sent.find(x => 'ITEM_INDEX' in x);
  assert.equal(m.ITEM_WALK, 270);
  assert.equal(m.ITEM_BEARING, 90);
  const off = harness({ items, storage: { 'busWatch.config': JSON.stringify({ version: 2, providers: [{ id: 'p', type: 'mock' }],
    showWalk: false, showArrow: false }) } });
  off.session.load();
  await refresh(off.session);
  const m2 = off.sent.find(x => 'ITEM_INDEX' in x);
  assert.equal('ITEM_WALK' in m2, false);
  assert.equal(m2.ITEM_BEARING, -1);
});
