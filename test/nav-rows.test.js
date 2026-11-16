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

test('build: an info step alone has no rail; a pickup walks (dashes) into the stop you wait at (circle)', () => {
  let r = build([{ type: 'info', text: 'No trip plan', leg: 0 }], 0);
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.rows[0].rail, { marker: 'none', top: 'none', bottom: 'none' });
  r = build([{ type: 'walk', text: 'Walk to First', leg: 0 }, { type: 'wait', text: 'Wait for the 44', leg: 1 }], 1);
  assert.deepEqual(r.rows.map(x => x.rail), [{ marker: 'none', top: 'none', bottom: 'dash' },
                                             { marker: 'stop', top: 'dash', bottom: 'none' }]);
  assert.equal(r.current, 1);
});

test('build: a ride whose stops are unknown is its board / ride rows joined by its line', () => {
  const steps = [{ type: 'board', text: 'Board 44', color: 'ff0000', leg: 0 },
                 { type: 'ride', text: 'Ride to Second', color: 'ff0000', leg: 0, stops: null },
                 { type: 'arrive', text: 'Arrive at Work', leg: 1 }];
  const r = build(steps, 1);
  assert.deepEqual(r.rows.map(x => x.text), ['Board 44', 'Ride to Second', 'Arrive at Work']);
  assert.deepEqual(r.rows.map(x => x.rail), [{ marker: 'stop', top: 'none', bottom: 'line' },
                                             { marker: 'stop', top: 'line', bottom: 'line' },
                                             { marker: 'stop', top: 'line', bottom: 'none' }], 'arriving right where you get off: part of the ride');
  assert.equal(r.current, 1);
});

test('build: a routed walk you are not on is one row with its turns\' total length', () => {
  const walk = { text: 'Walk to Work', note: '', color: '' };
  const steps = [{ type: 'board', text: 'Board 44', leg: 0 }, { type: 'ride', text: 'Ride to Second', leg: 0 },
                 { type: 'turn', text: 'Turn left', meters: 130, leg: 1, walk },
                 { type: 'turn', text: 'Arrive', meters: 130, leg: 1, walk },
                 { type: 'arrive', text: 'Arrive at Work', leg: 2 }];
  const r = build(steps, 0, { walkSpeed: 1.3 });
  assert.deepEqual(r.rows.map(x => x.text), ['Board 44', 'Ride to Second', 'Walk to Work', 'Arrive at Work']);
  assert.equal(r.rows[2].meters, 260);
  assert.equal(r.rows[2].sub, '4 min walk');
});
