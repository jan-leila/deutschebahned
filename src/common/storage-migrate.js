// One-time move of phone storage from the placeholder 'busWatch.' key prefix to 'deutschebahned.' (CONTRACTS.md §9a).
// Pure apart from the injected storage. ES5.

var OLD_PREFIX = 'busWatch.';
var NEW_PREFIX = 'deutschebahned.';
var DONE_KEY = NEW_PREFIX + 'migrated';
// what must survive; a failed copy of these leaves the migration for the next launch
var KEEP = ['config', 'samples', 'learned', 'prefs', 'plans', 'handled'];

// every key in storage, or null when it can't be listed (some PebbleKit JS runtimes have no length / key())
function listKeys(storage) {
  try {
    if (typeof storage.length !== 'number' || typeof storage.key !== 'function') return null;
    var out = [];
    for (var i = 0; i < storage.length; i++) {
      var k = storage.key(i);
      if (typeof k === 'string') out.push(k);
    }
    return out;
  } catch (e) {
    return null;
  }
}

// key names (without prefix) to move: every 'busWatch.' key when listable, else the known ones plus each configured
// system's search index (the per-source caches then stay behind and are rebuilt under the new prefix)
function oldNames(storage) {
  var keys = listKeys(storage), names = [], i;
  if (keys) {
    for (i = 0; i < keys.length; i++) if (keys[i].indexOf(OLD_PREFIX) === 0) names.push(keys[i].slice(OLD_PREFIX.length));
    return names;
  }
  names = KEEP.slice();
  var config = null;
  try { config = JSON.parse(storage.getItem(OLD_PREFIX + 'config')); } catch (e) { /* unreadable config: no indexes */ }
  var providers = (config && config.providers) || [];
  for (i = 0; i < providers.length; i++) if (providers[i] && providers[i].id) names.push('catalog.' + providers[i].id);
  return names;
}

// → number of keys moved. A key already present under the new prefix wins over the old one.
function migrate(storage) {
  try {
    if (storage.getItem(DONE_KEY)) return 0;
  } catch (e) {
    return 0;
  }
  var names = oldNames(storage), moved = 0;
  for (var i = 0; i < names.length; i++) {
    var from = OLD_PREFIX + names[i], to = NEW_PREFIX + names[i], value;
    try { value = storage.getItem(from); } catch (e) { value = null; }
    if (value === null || value === undefined) continue;
    try {
      if (storage.getItem(to) === null || storage.getItem(to) === undefined) {
        storage.setItem(to, value);
        moved++;
      }
    } catch (e) {
      // storage full: settings must not be lost, so try again next launch; a cache is simply rebuilt
      if (KEEP.indexOf(names[i]) >= 0) return moved;
    }
    try { storage.removeItem(from); } catch (e) { /* ignore */ }
  }
  try { storage.setItem(DONE_KEY, '1'); } catch (e) { /* retried next launch */ }
  return moved;
}

module.exports = { migrate: migrate, OLD_PREFIX: OLD_PREFIX, NEW_PREFIX: NEW_PREFIX, DONE_KEY: DONE_KEY };
