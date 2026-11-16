'use strict';
// src/common/nav-rows.js: steps folded into the rows the watch shows (CONTRACTS.md §18). The end-to-end cases (trip,
// drop-off, routed walks) are in nav.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { build, foldRange } = require('../src/common/nav-rows');

const shown = parts => parts.map(p => (p.k !== undefined ? p.k : (p.before ? '-' : '+') + p.fold));

test('foldRange: two behind, three ahead, the last always; a fold of one is just that one', () => {
  assert.deepEqual(shown(foldRange(0, 9, 0, 2, 3)), [0, 1, 2, 3, '+5', 9]);
  assert.deepEqual(shown(foldRange(0, 9, 5, 2, 3)), ['-3', 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(shown(foldRange(0, 9, 3, 2, 3)), [0, 1, 2, 3, 4, 5, 6, '+2', 9]);
  assert.deepEqual(shown(foldRange(0, 5, 0, 2, 3)), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(shown(foldRange(0, 0, 0, 2, 3)), [0]);
  assert.deepEqual(shown(foldRange(4, 20, 20, 2, 3)), ['-14', 18, 19, 20]);
});

const format = require('../src/common/format');
const NOW = 1768464000;
const c24 = t => format.clock(t, true);
const O = { walkSpeed: 1.3, clock24: true, now: NOW };
const texts = r => r.rows.map(x => x.text);
const rails = r => r.rows.map(x => [x.rail.marker, x.rail.top, x.rail.bottom].join(' '));

test('build: an info step alone has no rail and no header', () => {
  const r = build([{ type: 'info', text: 'No trip plan', leg: 0 }], 0, O);
  assert.deepEqual(texts(r), ['No trip plan']);
  assert.deepEqual(r.rows[0].rail, { marker: 'none', top: 'none', bottom: 'none' });
  assert.equal(r.head, -1);
});

test('build: a pickup: the walk you are on is its header and its step, then the stop you wait at', () => {
  const steps = [{ type: 'walk', text: 'Walk to First', toName: 'First', meters: 130, dir: 'EB', color: 'ff0000', leg: 0 },
                 { type: 'wait', text: 'Wait for the 44', color: 'ff0000', times: [NOW + 600], leg: 1 }];
  let r = build(steps, 0, O);
  assert.deepEqual(texts(r), ['First', 'Walk to First', 'Wait for the 44']);
  assert.equal(r.rows[0].type, 'head');
  assert.equal(r.rows[0].route, 'Walk');
  assert.equal(r.rows[0].open, true);
  assert.equal(r.rows[0].meters, 130);
  assert.equal(r.rows[0].dir, 'EB');
  assert.equal(r.rows[0].sub, 'arr ' + c24(NOW + 100), '130 m at 1.3 m/s');
  assert.equal(r.rows[2].sub, c24(NOW + 600), 'the stop still ahead: the bus you wait for');
  assert.deepEqual(rails(r), ['none none none', 'none none dash', 'stop dash none']);
  assert.equal(r.current, 1);
  assert.equal(r.head, 0);
  assert.equal(r.headEnd, 1);
  // there: the walk closes to its header
  r = build(steps, 1, O);
  assert.deepEqual(texts(r), ['First', 'Wait for the 44']);
  assert.equal(r.rows[0].open, false);
  assert.equal(r.current, 1);
  assert.equal(r.head, -1);
});

test('build: a ride whose stops are unknown: its header (route, badge, arrival) over board / ride / arrive on its line', () => {
  const steps = [{ type: 'board', text: 'Board 44', color: 'ff0000', badge: '44', route: 'Lake St', dir: 'EB', departAt: NOW + 60, leg: 0 },
                 { type: 'ride', text: 'Ride to Second', toName: 'Second', color: 'ff0000', arriveAt: NOW + 900, leg: 0, stops: null },
                 { type: 'arrive', text: 'Arrive at Work', leg: 1 }];
  const r = build(steps, 1, O);
  assert.deepEqual(texts(r), ['Second', 'Board 44', 'Ride to Second', 'Arrive at Work']);
  assert.equal(r.rows[0].badge, '44');
  assert.equal(r.rows[0].route, 'Lake St');
  assert.equal(r.rows[0].sub, 'East · arr ' + c24(NOW + 900));
  assert.deepEqual(rails(r), ['none none none', 'stop none line', 'stop line line', 'stop line none']);
  assert.equal(r.current, 2);
  assert.deepEqual([r.head, r.headEnd], [0, 3]);
});

const LINE = Array.from({ length: 9 }, (_, i) => ({ id: 's' + i, name: 'Stop ' + i, lat: 44.97, lon: -93.26 + i * 0.005 }));

test('build: riding: the stops behind and ahead with their times, the rest folded; the header counts the stops left', () => {
  const ride = { type: 'ride', text: 'Ride to Stop 8', color: 'ff0000', arriveAt: NOW + 800, leg: 0, stops: LINE, at: 1 };
  const steps = [{ type: 'board', text: 'Board 2', color: 'ff0000', badge: '2', departAt: NOW, leg: 0 }, ride];
  const r = build(steps, 1, O);
  assert.deepEqual(texts(r), ['Stop 8', 'Board 2', 'Stop 1', 'Stop 2', 'Stop 3', 'Stop 4', '3 more stops', 'Get off at Stop 8']);
  assert.equal(r.rows[0].sub, 'arr ' + c24(NOW + 800) + ' · 7 stops');
  assert.equal(r.rows[2].sub, '', 'the stop you are at');
  assert.equal(r.rows[3].sub, c24(NOW + 200), 'stops evenly spaced: an eighth of the ride each');
  assert.equal(r.rows[7].sub, c24(NOW + 800));
  assert.ok(r.rows[3].meters > 300 && r.rows[3].meters < 450, 'from the stop before');
  assert.equal(r.rows[6].fold, true);
  assert.equal(r.current, 2);
  // a long SELECT on the fold: every stop
  const all = build(steps, 1, Object.assign({ expand: { 0: true } }, O));
  assert.equal(all.rows.length, 1 + 9);
});

test('build: a routed walk you are not on is its header only (its turns\' total length); opened, its turns', () => {
  const walk = { text: 'Walk to Work', toName: 'Work', note: '', color: '' };
  const steps = [{ type: 'board', text: 'Board 44', leg: 0 }, { type: 'ride', text: 'Ride to Second', leg: 0 },
                 { type: 'turn', text: 'Turn left', meters: 130, leg: 1, walk },
                 { type: 'turn', text: 'Arrive', meters: 130, leg: 1, walk },
                 { type: 'arrive', text: 'Arrive at Work', leg: 2 }];
  let r = build(steps, 0, O);
  assert.deepEqual(texts(r), ['Second', 'Board 44', 'Ride to Second', 'Work', 'Arrive at Work']);
  assert.equal(r.rows[3].meters, 260);
  assert.equal(r.rows[3].sub, 'arr ' + c24(NOW + 200) + ' · 1 turn');
  r = build(steps, 0, Object.assign({ open: { 1: true, 0: false } }, O));
  assert.deepEqual(texts(r), ['Second', 'Work', 'Turn left', 'Arrive', 'Arrive at Work']);
  assert.equal(r.current, 0, 'the leg you are on closed: its header');
  assert.equal(r.head, -1);
  assert.equal(r.rows[2].sub, c24(NOW + 100));
});

test('build: a preview: every leg closed, times from the plan\'s leave time, no current row', () => {
  const steps = [{ type: 'walk', text: 'Walk to First', toName: 'First', meters: 260, leg: 0 },
                 { type: 'board', text: 'Board 44', badge: '44', departAt: NOW + 900, leg: 1 },
                 { type: 'ride', text: 'Ride to Second', toName: 'Second', arriveAt: NOW + 1500, leg: 1 },
                 { type: 'arrive', text: 'Arrive at Work', leg: 2 }];
  const r = build(steps, 0, Object.assign({}, O, { preview: true, start: NOW + 600 }));
  assert.deepEqual(texts(r), ['First', 'Second'], 'arriving where you get off is part of the ride');
  assert.equal(r.rows[0].sub, 'arr ' + c24(NOW + 800));
  assert.equal(r.rows[1].sub, 'arr ' + c24(NOW + 1500));
  assert.equal(r.current, 0);
  assert.equal(r.head, -1);
});
