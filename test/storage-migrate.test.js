'use strict';
// src/common/storage-migrate.js: the one-time 'busWatch.' → 'deutschebahned.' storage key move.
const test = require('node:test');
const assert = require('node:assert/strict');
const { migrate, DONE_KEY } = require('../src/common/storage-migrate');

// listable: a Web Storage-like object with length / key(); otherwise only get / set / remove
function makeStorage(entries, { listable = true, failSet = () => false } = {}) {
  const map = new Map(Object.entries(entries));
  const s = {
    map,
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { if (failSet(k)) throw new Error('QuotaExceededError'); map.set(k, String(v)); },
    removeItem: k => map.delete(k),
  };
  if (listable) {
    Object.defineProperty(s, 'length', { get: () => map.size });
    s.key = i => [...map.keys()][i] ?? null;
  }
  return s;
}

test('storage-migrate: every busWatch. key moves to deutschebahned. and the old one is removed', () => {
  const s = makeStorage({ 'busWatch.config': '{"a":1}', 'busWatch.mt.route.2': 'r', 'other': 'x' });
  assert.equal(migrate(s), 2);
  assert.equal(s.getItem('deutschebahned.config'), '{"a":1}');
  assert.equal(s.getItem('deutschebahned.mt.route.2'), 'r');
  assert.equal(s.getItem('busWatch.config'), null);
  assert.equal(s.getItem('busWatch.mt.route.2'), null);
  assert.equal(s.getItem('other'), 'x');
  assert.equal(s.getItem(DONE_KEY), '1');
});

test('storage-migrate: runs once; a second call does nothing', () => {
  const s = makeStorage({ 'busWatch.prefs': '{}' });
  assert.equal(migrate(s), 1);
  s.setItem('busWatch.prefs', '{"late":1}');
  assert.equal(migrate(s), 0);
  assert.equal(s.getItem('deutschebahned.prefs'), '{}');
});

test('storage-migrate: an existing new key wins over the old one', () => {
  const s = makeStorage({ 'busWatch.config': 'old', 'deutschebahned.config': 'new' });
  assert.equal(migrate(s), 0);
  assert.equal(s.getItem('deutschebahned.config'), 'new');
  assert.equal(s.getItem('busWatch.config'), null);
});

test('storage-migrate: without key listing, moves the known keys and the configured systems\' indexes', () => {
  const config = JSON.stringify({ providers: [{ id: 'metrotransit' }, { id: 'bvg' }] });
  const s = makeStorage({
    'busWatch.config': config, 'busWatch.learned': 'L', 'busWatch.plans': 'P',
    'busWatch.catalog.metrotransit': 'C', 'busWatch.mt.routes': 'cache',
  }, { listable: false });
  assert.equal(migrate(s), 4);
  assert.equal(s.getItem('deutschebahned.config'), config);
  assert.equal(s.getItem('deutschebahned.learned'), 'L');
  assert.equal(s.getItem('deutschebahned.plans'), 'P');
  assert.equal(s.getItem('deutschebahned.catalog.metrotransit'), 'C');
  assert.equal(s.getItem('busWatch.mt.routes'), 'cache', 'unlisted caches stay; they are rebuilt under the new prefix');
});

test('storage-migrate: storage full on settings keeps the old copy and retries next launch', () => {
  let full = true;
  const s = makeStorage({ 'busWatch.config': 'C' }, { failSet: k => full && k === 'deutschebahned.config' });
  assert.equal(migrate(s), 0);
  assert.equal(s.getItem('busWatch.config'), 'C');
  assert.equal(s.getItem(DONE_KEY), null);
  full = false;
  assert.equal(migrate(s), 1);
  assert.equal(s.getItem('deutschebahned.config'), 'C');
});

test('storage-migrate: storage full on a cache drops the old cache and carries on', () => {
  const s = makeStorage({ 'busWatch.catalog.mt': 'big', 'busWatch.config': 'C' },
    { failSet: k => k === 'deutschebahned.catalog.mt' });
  assert.equal(migrate(s), 1);
  assert.equal(s.getItem('busWatch.catalog.mt'), null);
  assert.equal(s.getItem('deutschebahned.config'), 'C');
  assert.equal(s.getItem(DONE_KEY), '1');
});
