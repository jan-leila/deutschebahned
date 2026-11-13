// Learn per-key scales from SELECT presses: softmax over candidate scores vs one-hot pick,
// cross-entropy, L2 toward the prior, Adam. ES5, deterministic. See CONTRACTS.md §6.

function isFiniteNumber(v) { return typeof v === 'number' && isFinite(v); }

function copyFeatures(f) {
  var out = {};
  if (!f) return out;
  for (var k in f) if (f.hasOwnProperty(k)) out[k] = f[k];
  return out;
}

function makeSample(items, chosenIndex, pos, now) {
  var list = items instanceof Array ? items : [];
  var candidates = [];
  for (var i = 0; i < list.length; i++) {
    candidates.push({ key: list[i].key, features: copyFeatures(list[i].features) });
  }
  return { t: now, lat: pos ? pos.lat : 0, lon: pos ? pos.lon : 0, chosen: chosenIndex, candidates: candidates };
}

function usable(s) {
  return s && s.candidates instanceof Array && s.candidates.length >= 2 &&
    typeof s.chosen === 'number' && s.chosen % 1 === 0 && s.chosen >= 0 && s.chosen < s.candidates.length;
}

function usableSamples(samples) {
  var out = [];
  var list = samples instanceof Array ? samples : [];
  for (var i = 0; i < list.length; i++) if (usable(list[i])) out.push(list[i]);
  return out;
}

// features as parallel arrays of finite values
function featureList(f) {
  var keys = [], vals = [];
  if (f) {
    for (var k in f) {
      if (!f.hasOwnProperty(k) || !isFiniteNumber(f[k])) continue;
      keys.push(k); vals.push(f[k]);
    }
  }
  return { keys: keys, vals: vals };
}

function scoreWith(fl, weightFn) {
  var s = 0;
  for (var i = 0; i < fl.keys.length; i++) {
    var w = weightFn(fl.keys[i]);
    if (!isFiniteNumber(w)) w = 0;
    s += w * fl.vals[i];
  }
  return s;
}

// stable softmax of scores / T -> {p: [], logp: []}
function softmax(scores, T) {
  var z = [], max = -Infinity, i;
  for (i = 0; i < scores.length; i++) { z.push(scores[i] / T); if (z[i] > max) max = z[i]; }
  var sum = 0;
  for (i = 0; i < z.length; i++) sum += Math.exp(z[i] - max);
  var lse = max + Math.log(sum), p = [], logp = [];
  for (i = 0; i < z.length; i++) { logp.push(z[i] - lse); p.push(Math.exp(z[i] - lse)); }
  return { p: p, logp: logp };
}

function validTemperature(T) { return isFiniteNumber(T) && T > 0 ? T : 1; }

function evaluateUsable(list, weightFn, T) {
  if (list.length === 0) return { n: 0, loss: 0, accuracy: 0 };
  var loss = 0, correct = 0;
  for (var i = 0; i < list.length; i++) {
    var s = list[i], scores = [];
    for (var c = 0; c < s.candidates.length; c++) scores.push(scoreWith(featureList(s.candidates[c].features), weightFn));
    loss -= softmax(scores, T).logp[s.chosen];
    var best = true;
    for (var j = 0; j < scores.length; j++) if (j !== s.chosen && !(scores[s.chosen] > scores[j])) { best = false; break; }
    if (best) correct++;
  }
  return { n: list.length, loss: loss / list.length, accuracy: correct / list.length };
}

function evaluate(samples, weightFn, temperature) {
  return evaluateUsable(usableSamples(samples), weightFn, validTemperature(temperature));
}

function opt(o, name, def) { return o && isFiniteNumber(o[name]) ? o[name] : def; }

function train(samples, priorFn, opts) {
  var list = usableSamples(samples);
  var T = validTemperature(opts && opts.temperature);
  var lr = opt(opts, 'learningRate', 0.05);
  var iterations = Math.max(0, Math.round(opt(opts, 'iterations', 300)));
  var reg = Math.max(0, opt(opts, 'regularization', 0));
  var before = evaluateUsable(list, priorFn, T);
  if (list.length === 0) return { weights: {}, before: before, after: before };

  // index keys and precompute sparse candidate features
  var index = {}, keys = [], data = [], i, c, j;
  for (i = 0; i < list.length; i++) {
    var cands = [];
    for (c = 0; c < list[i].candidates.length; c++) {
      var fl = featureList(list[i].candidates[c].features), idx = [];
      for (j = 0; j < fl.keys.length; j++) {
        var k = fl.keys[j];
        if (!index.hasOwnProperty(k)) { index[k] = keys.length; keys.push(k); }
        idx.push(index[k]);
      }
      cands.push({ idx: idx, vals: fl.vals });
    }
    data.push({ chosen: list[i].chosen, cands: cands });
  }

  var nk = keys.length, w0 = [], w = [], m = [], v = [], g = [];
  for (j = 0; j < nk; j++) {
    var p0 = priorFn(keys[j]);
    if (!isFiniteNumber(p0)) p0 = 0;
    w0.push(p0); w.push(p0); m.push(0); v.push(0); g.push(0);
  }

  var b1 = 0.9, b2 = 0.999, eps = 1e-8, b1t = 1, b2t = 1, n = data.length;
  for (var it = 0; it < iterations; it++) {
    for (j = 0; j < nk; j++) g[j] = reg * (w[j] - w0[j]);
    for (i = 0; i < n; i++) {
      var d = data[i], scores = [];
      for (c = 0; c < d.cands.length; c++) {
        var s = 0, cd = d.cands[c];
        for (j = 0; j < cd.idx.length; j++) s += w[cd.idx[j]] * cd.vals[j];
        scores.push(s);
      }
      var p = softmax(scores, T).p;
      for (c = 0; c < d.cands.length; c++) {
        var coef = (p[c] - (c === d.chosen ? 1 : 0)) / (T * n);
        if (coef === 0) continue;
        var cc = d.cands[c];
        for (j = 0; j < cc.idx.length; j++) g[cc.idx[j]] += coef * cc.vals[j];
      }
    }
    b1t *= b1; b2t *= b2;
    for (j = 0; j < nk; j++) {
      m[j] = b1 * m[j] + (1 - b1) * g[j];
      v[j] = b2 * v[j] + (1 - b2) * g[j] * g[j];
      w[j] -= lr * (m[j] / (1 - b1t)) / (Math.sqrt(v[j] / (1 - b2t)) + eps);
    }
  }

  var weights = {};
  for (j = 0; j < nk; j++) weights[keys[j]] = w[j];
  var after = evaluateUsable(list, function (key) { return weights.hasOwnProperty(key) ? weights[key] : 0; }, T);
  return { weights: weights, before: before, after: after };
}

module.exports = { makeSample: makeSample, evaluate: evaluate, train: train };
