// The moment a list is shown (weekday, time of day, month, weather) as extra features for ranking and learning
// (CONTRACTS.md §19). The model is linear (ranking.js), so a feature every candidate shares would cancel out in the
// softmax: each context value is crossed with the item's own key ('pickup:…@dow1'), which lets learning give a tile
// its own lift on Mondays, at 8 in the morning, in winter or in the rain. Pure; local time. ES5.

var UNIT = 60;   // value of a one-hot context feature: a learned weight of 1 is worth a minute of waiting (route:…)
var SEP = '@';
var SUFFIX_RE = /@(dow[0-6]|tod1s|tod1c|tod2s|tod2c|yrs|yrc|temp|rain)$/;

function isNum(v) { return typeof v === 'number' && isFinite(v); }

// now (epoch s), w = weather.slice result or null → {t, dow (0 = Sunday), minute (of the day), month (0..11), day (1..31),
// temp (°C) | null, rain (chance %, this hour) | null}
function at(now, w) {
  var d = new Date(now * 1000);
  var temp = w && isNum(w.now) ? Math.round(w.now * 10) / 10 : null;
  var rain = w && w.rain instanceof Array && isNum(w.rain[0]) ? Math.max(0, Math.min(100, Math.round(w.rain[0]))) : null;
  return { t: now, dow: d.getDay(), minute: d.getHours() * 60 + d.getMinutes(), month: d.getMonth(), day: d.getDate(),
           temp: temp, rain: rain };
}

function round4(x) { return Math.round(x * 10000) / 10000; }

// key = an item's key → {key@dowD: UNIT, key@tod1s/c, key@tod2s/c (time of day, once and twice a day round the circle),
// key@yrs/c (time of year), key@temp (UNIT per 10 °C), key@rain (UNIT at 100 %)}; weather ones only when known
function features(key, ctx) {
  var out = {};
  if (typeof key !== 'string' || !key || !ctx) return out;
  var k = key + SEP;
  if (isNum(ctx.dow)) out[k + 'dow' + ctx.dow] = UNIT;
  if (isNum(ctx.minute)) {
    var a = 2 * Math.PI * ctx.minute / 1440;
    out[k + 'tod1s'] = round4(UNIT * Math.sin(a));
    out[k + 'tod1c'] = round4(UNIT * Math.cos(a));
    out[k + 'tod2s'] = round4(UNIT * Math.sin(2 * a));
    out[k + 'tod2c'] = round4(UNIT * Math.cos(2 * a));
  }
  if (isNum(ctx.month)) {
    var y = 2 * Math.PI * (ctx.month + ((isNum(ctx.day) ? ctx.day : 1) - 1) / 31) / 12;
    out[k + 'yrs'] = round4(UNIT * Math.sin(y));
    out[k + 'yrc'] = round4(UNIT * Math.cos(y));
  }
  if (isNum(ctx.temp)) out[k + 'temp'] = round4(UNIT * ctx.temp / 10);
  if (isNum(ctx.rain)) out[k + 'rain'] = round4(UNIT * ctx.rain / 100);
  return out;
}

// → NEW array of shallow copies whose features also hold features(item.key, ctx). Items without a key are copied as they are.
function augment(items, ctx) {
  var list = items instanceof Array ? items : [], out = [];
  for (var i = 0; i < list.length; i++) {
    var it = list[i] || {}, copy = {}, f = {}, k;
    for (k in it) if (it.hasOwnProperty(k)) copy[k] = it[k];
    var base = it.features || {};
    for (k in base) if (base.hasOwnProperty(k)) f[k] = base[k];
    var extra = features(it.key, ctx);
    for (k in extra) if (extra.hasOwnProperty(k)) f[k] = extra[k];
    copy.features = f;
    out.push(copy);
  }
  return out;
}

// 'pickup:a/1:a/2@dow1' → {base: 'pickup:a/1:a/2', part: 'dow1'}; a key without a context suffix → {base: key, part: ''}
function split(key) {
  var m = typeof key === 'string' ? key.match(SUFFIX_RE) : null;
  if (!m) return { base: key, part: '' };
  return { base: key.slice(0, key.length - m[0].length), part: m[1] };
}

module.exports = { UNIT: UNIT, at: at, features: features, augment: augment, split: split };
