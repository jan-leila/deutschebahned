// Sort order for list items: score = sum of scale * feature value. ES5. See CONTRACTS.md §5.
// (Learned weights are copied back into a saved config by view.bake.)

function isFiniteNumber(v) { return typeof v === 'number' && isFinite(v); }

// split 'prefix:ID' at the first colon -> {prefix, id}, or null
function splitKey(key) {
  if (typeof key !== 'string') return null;
  var i = key.indexOf(':');
  if (i <= 0) return null;
  return { prefix: key.slice(0, i), id: key.slice(i + 1) };
}

function findById(list, id) {
  if (!(list instanceof Array)) return null;
  for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
  return null;
}

function orZero(v) { return isFiniteNumber(v) ? v : 0; }

// config is a runtime view (view.build): routes and stops carry ref ids
function weightFor(key, config, learned) {
  if (learned && learned.hasOwnProperty(key) && isFiniteNumber(learned[key])) return learned[key];
  var p = splitKey(key);
  if (!p) return 0;
  var c = config || {};
  if (p.prefix === 'stop') {
    var s = findById(c.stops, p.id);
    return orZero(s ? s.walkScale : undefined);
  }
  if (p.prefix === 'ride') {
    var rs = findById(c.stops, p.id);
    return orZero(rs ? rs.rideScale : undefined);
  }
  if (p.prefix === 'route') {
    var r = findById(c.routes, p.id);
    return orZero(r ? r.scale : undefined);
  }
  return 0;
}

function score(features, weightFn) {
  var s = 0;
  if (!features) return s;
  for (var k in features) {
    if (!features.hasOwnProperty(k)) continue;
    var v = features[k];
    if (!isFiniteNumber(v) || v === 0) continue;
    s += weightFn(k) * v;
  }
  return s;
}

function shallowCopy(o) {
  var out = {};
  for (var k in o) if (o.hasOwnProperty(k)) out[k] = o[k];
  return out;
}

function rank(items, config, learned) {
  var list = items instanceof Array ? items : [];
  var wf = function (k) { return weightFor(k, config, learned); };
  var scored = [];
  for (var i = 0; i < list.length; i++) {
    var copy = shallowCopy(list[i]);
    copy.score = score(copy.features, wf);
    scored.push({ item: copy, index: i });
  }
  scored.sort(function (a, b) {
    if (b.item.score !== a.item.score) return b.item.score > a.item.score ? 1 : -1;
    return a.index - b.index;
  });
  var max = config && isFiniteNumber(config.maxItems) ? config.maxItems : scored.length;
  var out = [];
  for (var j = 0; j < scored.length && j < max; j++) out.push(scored[j].item);
  return out;
}

module.exports = { weightFor: weightFor, score: score, rank: rank };
