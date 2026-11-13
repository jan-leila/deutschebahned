const test = require('node:test');
const assert = require('node:assert/strict');
const optimize = require('../src/common/optimize');

const OPTS = { learningRate: 0.05, iterations: 300, temperature: 60, regularization: 0.01 };

test('makeSample copies only what training needs', () => {
  const items = [
    { kind: 'pickup', key: 'a', title: 'A', times: [1], features: { 'stop:1': 10, 'route:x': 60 }, extra: 1 },
    { kind: 'dropoff', key: 'b', title: 'B', times: [2], features: { 'conn:x|1': 5 } },
  ];
  const s = optimize.makeSample(items, 1, { lat: 1.5, lon: 2.5 }, 1234);
  assert.deepEqual(s, { t: 1234, lat: 1.5, lon: 2.5, chosen: 1,
    candidates: [{ key: 'a', features: { 'stop:1': 10, 'route:x': 60 } }, { key: 'b', features: { 'conn:x|1': 5 } }] });
  items[0].features['stop:1'] = 999;
  assert.equal(s.candidates[0].features['stop:1'], 10, 'deep copy');
});

test('evaluate: loss and accuracy by hand', () => {
  const samples = [
    { chosen: 0, candidates: [{ key: 'a', features: { x: 1 } }, { key: 'b', features: { x: 0 } }] },
    { chosen: 1, candidates: [{ key: 'a', features: { x: 1 } }, { key: 'b', features: { x: 0 } }] },
    { chosen: 0, candidates: [{ key: 'only', features: { x: 1 } }] },           // ignored: one candidate
    { chosen: 5, candidates: [{ key: 'a', features: {} }, { key: 'b', features: {} }] }, // ignored: bad index
  ];
  const e = optimize.evaluate(samples, () => Math.log(3), 1); // scores ln3 vs 0 -> p = 0.75 / 0.25
  assert.equal(e.n, 2);
  assert.equal(e.accuracy, 0.5);
  assert.ok(Math.abs(e.loss - (-Math.log(0.75) - Math.log(0.25)) / 2) < 1e-9, String(e.loss));
  assert.deepEqual(optimize.evaluate([], () => 1, 1), { n: 0, loss: 0, accuracy: 0 });
});

test('evaluate: ties are not counted as correct', () => {
  const s = [{ chosen: 0, candidates: [{ key: 'a', features: { x: 1 } }, { key: 'b', features: { x: 1 } }] }];
  assert.equal(optimize.evaluate(s, () => 1, 1).accuracy, 0);
});

test('evaluate: temperature scales the softmax', () => {
  const s = [{ chosen: 0, candidates: [{ key: 'a', features: { x: 60 } }, { key: 'b', features: { x: 0 } }] }];
  const e = optimize.evaluate(s, () => 1, 60); // scores 60 vs 0, /60 -> 1 vs 0
  assert.ok(Math.abs(e.loss - Math.log(1 + Math.exp(-1))) < 1e-9);
  // huge score gaps must not overflow
  const big = optimize.evaluate(s, () => 1e6, 1);
  assert.ok(Number.isFinite(big.loss));
});

test('train: no usable samples -> empty weights, no throw', () => {
  const r = optimize.train([], () => -1, OPTS);
  assert.deepEqual(r.weights, {});
  assert.equal(r.before.n, 0);
  assert.equal(r.after.n, 0);
});

// deterministic pseudo-random generator for synthetic data
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// The user secretly ranks by: score = -0.2*meters - 1.0*seconds for route A, -3.0*seconds for route B,
// and stop 'home' is liked (-0.05 per meter). The prior (all -1) ranks distance far too strongly.
const TRUTH = { 'stop:s1': -0.2, 'stop:s2': -0.2, 'stop:home': -0.05, 'route:A': -1.0, 'route:B': -3.0 };
function synthSamples(n, seed) {
  const rand = rng(seed);
  const stops = ['stop:s1', 'stop:s2', 'stop:home'];
  const routes = ['route:A', 'route:B'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = 2 + Math.floor(rand() * 4);
    const candidates = [];
    for (let c = 0; c < k; c++) {
      const st = stops[Math.floor(rand() * stops.length)], rt = routes[Math.floor(rand() * routes.length)];
      candidates.push({ key: 'c' + c, features: { [st]: Math.round(rand() * 400), [rt]: Math.round(rand() * 900) } });
    }
    const score = f => Object.keys(f).reduce((s, key) => s + TRUTH[key] * f[key], 0);
    let best = 0;
    candidates.forEach((cand, j) => { if (score(cand.features) > score(candidates[best].features)) best = j; });
    out.push({ t: i, lat: 0, lon: 0, chosen: best, candidates });
  }
  return out;
}

test('train: recovers the user ranking from picks (one-hot softmax)', () => {
  const train = synthSamples(150, 1), holdout = synthSamples(150, 2);
  const prior = () => -1;
  const r = optimize.train(train, prior, OPTS);
  for (const k of Object.keys(TRUTH)) assert.ok(Number.isFinite(r.weights[k]), k);
  assert.ok(r.after.loss < r.before.loss, `${r.after.loss} < ${r.before.loss}`);
  assert.ok(r.after.accuracy >= 0.85, 'train accuracy ' + r.after.accuracy);
  assert.ok(r.after.accuracy > r.before.accuracy);
  const held = optimize.evaluate(holdout, k => r.weights[k], OPTS.temperature);
  const heldPrior = optimize.evaluate(holdout, prior, OPTS.temperature);
  assert.ok(held.accuracy >= 0.8, 'holdout accuracy ' + held.accuracy);
  assert.ok(held.accuracy > heldPrior.accuracy + 0.1);
  // the learned weights moved the right way: route B time matters more than route A, and distance matters much
  // less than the prior (-1/m) claimed. (Individual stop weights are weakly identified here — time dominates the
  // true scores — so only their direction away from the prior is checked.)
  assert.ok(r.weights['route:B'] < r.weights['route:A']);
  for (const k of ['stop:s1', 'stop:s2', 'stop:home']) assert.ok(r.weights[k] > -0.6, k + ' ' + r.weights[k]);
});

test('train: deterministic and does not mutate samples', () => {
  const s = synthSamples(40, 3);
  const copy = JSON.stringify(s);
  const a = optimize.train(s, () => -1, OPTS), b = optimize.train(s, () => -1, OPTS);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(s), copy);
});

test('train: regularization keeps weights near the prior', () => {
  const s = synthSamples(60, 4);
  const loose = optimize.train(s, () => -1, { ...OPTS, regularization: 0 });
  const tight = optimize.train(s, () => -1, { ...OPTS, regularization: 100 });
  const drift = r => Object.keys(r.weights).reduce((acc, k) => acc + Math.abs(r.weights[k] + 1), 0);
  assert.ok(drift(tight) < drift(loose));
  assert.ok(drift(tight) < 0.5, String(drift(tight)));
});

test('train: keys only in unusable samples are not learned', () => {
  const s = [
    { chosen: 0, candidates: [{ key: 'a', features: { 'stop:x': 10 } }, { key: 'b', features: { 'stop:y': 100 } }] },
    { chosen: 0, candidates: [{ key: 'solo', features: { 'stop:lonely': 1 } }] },
  ];
  const r = optimize.train(s, () => -1, OPTS);
  assert.deepEqual(Object.keys(r.weights).sort(), ['stop:x', 'stop:y']);
});
