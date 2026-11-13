// Source registry (CONTRACTS.md §3): plug-in lookup, replacement, provider creation and its context.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createRegistry, configuredRouteIds, sourceContext } = require('../src/sources/registry');
const all = require('../src/sources/all');

// a fake plug-in that records what create() got
function fake(type, label) {
  const calls = [];
  return { calls, type, label, create(options, ctx) { calls.push({ options, ctx }); return { type, options, ctx }; } };
}

test('registry: shipped plug-ins, default first', () => {
  assert.deepEqual(all.map(p => p.type), ['metrotransit', 'onebusaway', 'mock']);
  const reg = createRegistry(all);
  assert.deepEqual(reg.types().map(t => t.type), ['metrotransit', 'onebusaway', 'mock']);
  for (const t of reg.types()) assert.equal(typeof t.label, 'string');
  assert.ok(reg.types()[0].label.length > 0);
});

test('registry: resolve default / unknown / none registered', () => {
  const a = fake('a', 'A'), b = fake('b', 'B');
  const reg = createRegistry([a, b]);
  assert.equal(reg.resolve('b'), b);
  assert.equal(reg.resolve(''), a);
  assert.equal(reg.resolve('nope'), a);
  assert.equal(reg.resolve(undefined), a);
  assert.equal(reg.resolve('hasOwnProperty'), a, 'no prototype leaks');
  assert.equal(reg.has('b'), true);
  assert.equal(reg.has('nope'), false);
  assert.equal(reg.has('toString'), false);
  const empty = createRegistry();
  assert.equal(empty.resolve(''), null);
  assert.deepEqual(empty.types(), []);
  assert.throws(() => empty.create({ provider: { type: '' } }, {}));
});

test('registry: register validates, re-registering a type replaces it in place', () => {
  const reg = createRegistry([fake('a', 'A'), fake('b', 'B')]);
  for (const bad of [null, {}, { type: '', create() {} }, { type: 'x' }, { type: 3, create() {} }]) {
    assert.throws(() => reg.register(bad), /plug-in/);
  }
  const a2 = fake('a', 'A two');
  assert.equal(reg.register(a2), reg, 'chainable');
  assert.deepEqual(reg.types(), [{ type: 'a', label: 'A two' }, { type: 'b', label: 'B' }]);
  assert.equal(reg.resolve(''), a2);
  reg.register({ type: 'c', create() { return {}; } });
  assert.deepEqual(reg.types()[2], { type: 'c', label: 'c' }, 'label defaults to type');
});

test('registry: create passes options from config.provider and the source context', () => {
  const a = fake('a', 'A'), b = fake('b', 'B');
  const reg = createRegistry([a, b]);
  const http = () => {}, clock = () => 123, storage = { getItem() { return null; } };
  const config = {
    provider: { type: 'b', baseUrl: 'https://x.example', apiKey: 'k' },
    location: { mode: 'fixed', lat: 44.9, lon: -93.2 },
    routes: [{ id: '2', name: 'Two' }, { id: '5', name: '' }],
    connections: [{ routeId: '7', stopId: 's' }, { routeId: '2', stopId: 't' }],
  };
  const p = reg.create(config, { http, clock, storage });
  assert.equal(p.type, 'b');
  assert.equal(a.calls.length, 0);
  assert.deepEqual(b.calls[0].options, { baseUrl: 'https://x.example', apiKey: 'k' });
  const ctx = b.calls[0].ctx;
  assert.equal(ctx.http, http);
  assert.equal(ctx.clock, clock);
  assert.equal(ctx.storage, storage);
  assert.deepEqual(ctx.routeIds, ['2', '5', '7']);
  assert.deepEqual(ctx.routes, [{ id: '2', name: 'Two' }, { id: '5', name: '5' }]);
  assert.deepEqual(ctx.center, { lat: 44.9, lon: -93.2 });
  // '' / missing provider → default plug-in, empty options, a default clock
  reg.create({}, {});
  assert.deepEqual(a.calls[0].options, { baseUrl: '', apiKey: '' });
  assert.equal(typeof a.calls[0].ctx.clock(), 'number');
  assert.deepEqual(a.calls[0].ctx.center, { lat: 0, lon: 0 });
  assert.deepEqual(sourceContext(config, { http }).routeIds, ['2', '5', '7']);
});

test('registry: configuredRouteIds = routes then connection routes, deduplicated, config order', () => {
  assert.deepEqual(configuredRouteIds({ routes: [{ id: 'b' }, { id: 'a' }, { id: 'b' }],
    connections: [{ routeId: 'c' }, { routeId: 'a' }, { routeId: '' }, null] }), ['b', 'a', 'c']);
  assert.deepEqual(configuredRouteIds({ routes: [{ id: 2 }] }), ['2']);
  assert.deepEqual(configuredRouteIds(null), []);
  assert.deepEqual(configuredRouteIds({}), []);
});

test('sources require only src/sources/** and src/common/geo.js', () => {
  const dir = path.join(__dirname, '..', 'src', 'sources');
  const files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (f.isDirectory()) walk(path.join(d, f.name)); else if (f.name.endsWith('.js')) files.push(path.join(d, f.name));
    }
  })(dir);
  const geo = path.join(__dirname, '..', 'src', 'common', 'geo.js');
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const target = require.resolve(path.resolve(path.dirname(file), m[1]));
      assert.ok(target.startsWith(dir + path.sep) || target === geo, path.relative(dir, file) + ' requires ' + m[1]);
    }
  }
});
