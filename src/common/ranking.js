// Sort order for list items: score = sum of scale * feature value. ES5. See CONTRACTS.md §5.

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

function orDefault(v, def) { return isFiniteNumber(v) ? v : (isFiniteNumber(def) ? def : 0); }

function weightFor(key, config, learned) {
  if (learned && learned.hasOwnProperty(key) && isFiniteNumber(learned[key])) return learned[key];
  var p = splitKey(key);
  if (!p) return 0;
  var c = config || {};
  if (p.prefix === 'stop') {
    var ss = c.stopScales || {};
    return orDefault(ss.hasOwnProperty(p.id) ? ss[p.id] : undefined, c.defaultStopScale);
  }
  if (p.prefix === 'route') {
    var r = findById(c.routes, p.id);
    return orDefault(r ? r.scale : undefined, c.defaultRouteScale);
  }
  if (p.prefix === 'conn') {
    var cn = findById(c.connections, p.id);
    return orDefault(cn ? cn.scale : undefined, c.defaultConnectionScale);
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

function bake(config, learned) {
  var c = JSON.parse(JSON.stringify(config || {}));
  if (!c.stopScales || typeof c.stopScales !== 'object') c.stopScales = {};
  if (!learned) return c;
  for (var key in learned) {
    if (!learned.hasOwnProperty(key) || !isFiniteNumber(learned[key])) continue;
    var p = splitKey(key);
    if (!p) continue;
    if (p.prefix === 'stop') {
      c.stopScales[p.id] = learned[key];
    } else if (p.prefix === 'route') {
      var r = findById(c.routes, p.id);
      if (r) r.scale = learned[key];
    } else if (p.prefix === 'conn') {
      var cn = findById(c.connections, p.id);
      if (cn) cn.scale = learned[key];
    }
  }
  return c;
}

module.exports = { weightFor: weightFor, score: score, rank: rank, bake: bake };
