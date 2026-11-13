// Route / stop search index (CONTRACTS.md §3b).
const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../src/common/catalog');

const DATA = {
  routes: [
    { id: '901', shortName: 'Blue', longName: 'METRO Blue Line' },
    { id: '2', shortName: '2', longName: 'Franklin Av - Riverside Av - U of M - 8th St SE' },
    { id: '21', shortName: '21', longName: 'Lake St - Marshall Av - Selby Av' },
    { id: '6', shortName: '6', longName: 'U of M - Hennepin - Xerxes - France - Southdale' },
  ],
  stops: [
    { id: '13337', name: 'Franklin Ave and Hennepin Ave', routeIds: ['2'] },
    { id: '13334', name: 'Franklin Ave W & Lyndale Ave S', routeIds: ['2'], lat: 44.962618, lon: -93.287936 },
    { id: '16058', name: '8th St SE & 5th Ave SE', routeIds: ['2', '6'] },
    { id: '1335', name: 'Hennepin Ave & Lake St', routeIds: ['6', '21', 'X9'] },
    { id: '56302', name: 'Lake St / Midtown Station', routeIds: ['21', '901'] },
  ],
};
const index = catalog.unpack(catalog.pack(DATA, { t: 1000, sig: 'mt||' }));

test('pack / unpack round trip; route indexes; unknown routes of a stop are added; positions kept', () => {
  const p = catalog.pack(DATA, { t: 1000, sig: 'mt||' });
  assert.equal(p.v, 1);
  assert.equal(p.t, 1000);
  assert.deepEqual(p.routes[0], ['901', 'Blue', 'METRO Blue Line']);
  assert.deepEqual(p.routes[4], ['X9', 'X9', ''], 'a route only a stop mentions');
  assert.deepEqual(p.stops[1], ['13334', 'Franklin Ave W & Lyndale Ave S', [1], 44.962618, -93.287936]);
  const u = catalog.unpack(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(u.stops[3].routeIds, ['6', '21', 'X9']);
  assert.equal(u.stops[1].lat, 44.962618);
  assert.equal(u.stops[0].lat, undefined);
  assert.equal(u.sig, 'mt||');
  for (const bad of [null, {}, { v: 2, routes: [], stops: [] }, { v: 1, routes: 'x', stops: [] }]) assert.equal(catalog.unpack(bad), null);
});

test('search routes: id first, then name prefixes, word prefixes, typos', () => {
  const ids = (q, opts) => catalog.search(index, q, Object.assign({ kind: 'route' }, opts)).map(h => h.id);
  assert.deepEqual(ids('2'), ['2', '21']);
  assert.deepEqual(ids('blue'), ['901']);
  assert.deepEqual(ids('blue line'), ['901']);
  assert.deepEqual(ids('901'), ['901']);
  assert.deepEqual(ids('lake'), ['21']);
  assert.deepEqual(ids('riversde'), ['2'], 'one typo');
  assert.deepEqual(ids('southdale hennepin'), ['6'], 'words in any order');
  assert.deepEqual(ids(''), []);
  assert.deepEqual(ids('zzzz'), []);
  assert.equal(ids('u', { limit: 1 }).length, 1);
  const hit = catalog.search(index, 'blue', { kind: 'route' })[0];
  assert.deepEqual([hit.kind, hit.name, hit.detail], ['route', 'Blue', 'METRO Blue Line']);
});

test('search stops: by name or number, & and "and" alike, served routes in the detail', () => {
  const ids = q => catalog.search(index, q, { kind: 'stop' }).map(h => h.id);
  assert.deepEqual(ids('16058'), ['16058']);
  assert.deepEqual(ids('1333').sort(), ['13334', '13337']);
  assert.deepEqual(ids('franklin lyndale'), ['13334']);
  assert.deepEqual(ids('franklin & hennepin'), ['13337']);
  assert.deepEqual(ids('hennepin and lake'), ['1335']);
  assert.ok(ids('lake st').includes('1335') && ids('lake st').includes('56302'));
  assert.deepEqual(ids('midtwn'), ['56302'], 'typo');
  const hit = catalog.search(index, 'hennepin lake', { kind: 'stop' })[0];
  assert.equal(hit.detail, '6, 21, X9');
  assert.deepEqual(hit.routeIds, ['6', '21', 'X9']);
  const withPos = catalog.search(index, 'lyndale', { kind: 'stop' })[0];
  assert.deepEqual([withPos.lat, withPos.lon], [44.962618, -93.287936]);
  assert.equal(catalog.stop(index, '1335').name, 'Hennepin Ave & Lake St');
  assert.equal(catalog.stop(index, 'nope'), null);
});

test('norm and editDistance', () => {
  assert.equal(catalog.norm('  Hennepin Ave. & Lake St!'), 'hennepin ave and lake st');
  assert.equal(catalog.norm('Café Ré'), 'cafe re');
  assert.equal(catalog.editDistance('kitten', 'sitting', 5), 3);
  assert.equal(catalog.editDistance('abc', 'abc', 0), 0);
  assert.equal(catalog.editDistance('abcdef', 'a', 2), 3, 'max + 1 when farther');
});

test('storage: per system, rebuilt when type / server / key change, fresh for 7 days', () => {
  const mem = {};
  const storage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
  const entry = { id: 'mt', type: 'metrotransit', baseUrl: '', apiKey: '' };
  const p = catalog.pack(DATA, { t: 1000, sig: catalog.signature(entry) });
  assert.ok(catalog.save(storage, entry, p));
  assert.ok(Object.keys(mem)[0].startsWith(catalog.PREFIX));
  assert.deepEqual(catalog.loadPacked(storage, entry), p);
  assert.equal(catalog.loadPacked(storage, Object.assign({}, entry, { baseUrl: 'https://other' })), null);
  assert.equal(catalog.loadPacked(storage, Object.assign({}, entry, { id: 'other' })), null);
  assert.ok(catalog.fresh(p, 1000 + catalog.TTL - 1));
  assert.ok(!catalog.fresh(p, 1000 + catalog.TTL));
  assert.ok(!catalog.fresh(null, 0));
  catalog.remove(storage, 'mt');
  assert.equal(catalog.loadPacked(storage, entry), null);
  mem[catalog.PREFIX + 'mt'] = '{bad json';
  assert.equal(catalog.loadPacked(storage, entry), null);
  assert.equal(catalog.save({ setItem() { throw new Error('full'); } }, entry, p), false);
});

test('build: the source catalog with progress; listRoutes-only sources; neither → error', async () => {
  const build = (provider) => new Promise(resolve => {
    const progress = [];
    catalog.build(provider, { type: 't', baseUrl: '', apiKey: '' }, 42, (err, packed) => resolve({ err, packed, progress }), (n, t) => progress.push([n, t]));
  });
  const full = await build({ catalog(cb, onProgress) { onProgress(1, 2); onProgress(2, 2); setTimeout(() => cb(null, DATA), 0); } });
  assert.equal(full.err, null);
  assert.equal(full.packed.t, 42);
  assert.equal(full.packed.sig, 't||');
  assert.equal(full.packed.stops.length, 5);
  assert.deepEqual(full.progress, [[1, 2], [2, 2]]);
  const routesOnly = await build({ listRoutes(cb) { cb(null, [{ id: '2', label: 'Route 2' }]); } });
  assert.deepEqual(routesOnly.packed.routes, [['2', '2', 'Route 2']]);
  assert.deepEqual(routesOnly.packed.stops, []);
  assert.match((await build({})).err.message, /can't list/);
  assert.match((await build({ catalog(cb) { cb(new Error('offline')); } })).err.message, /offline/);
  assert.match((await build({ catalog() { throw new Error('boom'); } })).err.message, /boom/);
});

test('text form for the page: round trip, URI-friendly, packed input accepted as is', () => {
  const tricky = { routes: [{ id: 'a_b', shortName: 'A~B!', longName: 'x*y z' }],
    stops: [{ id: 's 1', name: 'Café & Bar_~!*', routeIds: ['a_b', 'Q'], lat: 44.5, lon: -93.25 }, { id: 's2', name: '', routeIds: [] }] };
  for (const data of [DATA, tricky, { routes: [], stops: [] }]) {
    const p = catalog.pack(data, { t: 5, sig: 'mt|https://x/|k' });
    const t = catalog.toText(p);
    assert.equal(typeof t.text, 'string');
    assert.deepEqual(catalog.fromText(JSON.parse(JSON.stringify(t))), p);
  }
  const p = catalog.pack(DATA, { t: 1, sig: 's' });
  assert.equal(catalog.fromText(p), p);
  assert.ok(encodeURIComponent(JSON.stringify(catalog.toText(p))).length < 0.75 * encodeURIComponent(JSON.stringify(p)).length);
  assert.equal(catalog.toText(null), null);
  assert.equal(catalog.fromText({ v: 1 }), null);
  assert.equal(catalog.fromText(null), null);
});
