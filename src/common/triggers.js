// When to re-check a destination's trip plan (CONTRACTS.md section 14). Pure, ES5, no requires.
// Times are epoch seconds; "local" means the JS runtime's local time zone (DST aware).

var WAKEUP_SPACING = 60;   // Pebble refuses wakeups closer than a minute apart
var MAX_WAKEUPS = 8;       // Pebble allows at most 8 scheduled wakeups per app

function hasOwn(o, k) { return o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k); }

// 'HH:MM' -> {h, m} or null
function parseClock(v) {
  if (typeof v !== 'string') return null;
  var m = v.match(/^\s*(\d{1,2}):(\d{2})\s*$/);
  if (!m) return null;
  var h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return { h: h, m: mi };
}

function dayAllowed(days, weekday) {
  if (!(days instanceof Array) || days.length === 0) return true;
  for (var i = 0; i < days.length; i++) if (Number(days[i]) === weekday) return true;
  return false;
}

// Epoch seconds of the next local dest.arriveBy strictly after now, on one of dest.days ([] = any day).
// Null if the destination is disabled, malformed, or no allowed day exists. On a DST "spring forward" day a
// wall time that does not exist is shifted forward by the JS Date rules (02:30 -> 03:30); on "fall back" the
// first of the two instants is used.
function nextOccurrence(dest, now) {
  if (!dest || dest.enabled === false || typeof now !== 'number' || !isFinite(now)) return null;
  var t = parseClock(dest.arriveBy);
  if (!t) return null;
  var base = new Date(now * 1000);
  var y = base.getFullYear(), mo = base.getMonth(), d = base.getDate();
  // start one day back in case of odd time zones; 9 days covers every weekday at least once after now
  for (var k = -1; k <= 8; k++) {
    var day = new Date(y, mo, d + k);           // local midnight (or the first valid instant) of that day
    if (!dayAllowed(dest.days, day.getDay())) continue;
    var at = new Date(y, mo, d + k, t.h, t.m, 0, 0);
    var epoch = Math.floor(at.getTime() / 1000);
    if (epoch > now) return epoch;
  }
  return null;
}

function num(v, def) { return typeof v === 'number' && isFinite(v) ? v : def; }

function byTime(a, b) {
  if (a.time !== b.time) return a.time - b.time;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function makeTrigger(destId, occurrence, kind, time) {
  return { id: destId + '@' + occurrence + ':' + kind, destinationId: destId, occurrence: occurrence, kind: kind, time: time };
}

// destinations: config.destinations; plans: {destId: {occurrence, plan|null}}; opts: config.schedule
function build(destinations, plans, now, opts) {
  opts = opts || {};
  var lead = num(opts.leadMinutes, 15) * 60;
  var fallback = num(opts.fallbackMinutes, 60) * 60;
  var out = [];
  if (!(destinations instanceof Array)) return out;
  for (var i = 0; i < destinations.length; i++) {
    var dest = destinations[i];
    if (!dest || dest.enabled === false || !hasOwn(plans, dest.id)) continue;
    var entry = plans[dest.id];
    if (!entry || typeof entry.occurrence !== 'number' || !(entry.occurrence > now)) continue;
    var occ = entry.occurrence;
    var plan = entry.plan && typeof entry.plan.leaveAt === 'number' ? entry.plan : null;
    var checkAt = (plan ? plan.leaveAt : occ - fallback) - lead;
    out.push(makeTrigger(dest.id, occ, 'check', checkAt));
    if (plan && opts.leaveReminder) out.push(makeTrigger(dest.id, occ, 'leave', plan.leaveAt));
  }
  out.sort(byTime);
  return out;
}

// triggers whose time has come, for an occurrence still ahead, not handled yet (handled = array of ids)
function due(triggers, now, handled) {
  var seen = {};
  if (handled instanceof Array) for (var i = 0; i < handled.length; i++) seen[handled[i]] = true;
  var out = [];
  if (!(triggers instanceof Array)) return out;
  for (var j = 0; j < triggers.length; j++) {
    var t = triggers[j];
    if (t.time <= now && t.occurrence > now && !seen.hasOwnProperty(t.id)) out.push(t);
  }
  out.sort(byTime);
  return out;
}

// future triggers -> Pebble wakeups [{time, cookie}]: sorted, ≥ 60 s apart (later ones pushed back), ≤ 8,
// cookie = 1-based index in the returned list
function toWakeups(triggers, now) {
  var future = [];
  if (triggers instanceof Array) {
    for (var i = 0; i < triggers.length; i++) if (triggers[i].time > now) future.push(triggers[i]);
  }
  future.sort(byTime);
  var out = [];
  var prev = null;
  for (var j = 0; j < future.length && out.length < MAX_WAKEUPS; j++) {
    var time = Math.floor(future[j].time);
    if (time <= now) time = now + 1;
    if (prev !== null && time < prev + WAKEUP_SPACING) time = prev + WAKEUP_SPACING;
    out.push({ time: time, cookie: out.length + 1 });
    prev = time;
  }
  return out;
}

var TRIP_GRACE = 120;   // seconds a trip stays "in progress" after its planned arrival

// Trips in progress: enabled destinations whose stored plan exists and now ∈ [leaveAt − leadMinutes·60, arriveAt + TRIP_GRACE].
// → [{destination, occurrence, plan}] sorted by leaveAt (ties: destination order).
function activeTrips(destinations, plans, now, opts) {
  var lead = (opts && typeof opts.leadMinutes === 'number' ? opts.leadMinutes : 15) * 60;
  var out = [];
  destinations = destinations || [];
  for (var i = 0; i < destinations.length; i++) {
    var d = destinations[i];
    if (!d || !d.enabled || !plans || !Object.prototype.hasOwnProperty.call(plans, d.id)) continue;
    var entry = plans[d.id];
    var plan = entry && entry.plan;
    if (!plan || typeof plan.leaveAt !== 'number' || typeof plan.arriveAt !== 'number') continue;
    if (now < plan.leaveAt - lead || now > plan.arriveAt + TRIP_GRACE) continue;
    out.push({ destination: d, occurrence: entry.occurrence, plan: plan, order: i });
  }
  out.sort(function (a, b) { return a.plan.leaveAt !== b.plan.leaveAt ? a.plan.leaveAt - b.plan.leaveAt : a.order - b.order; });
  for (var j = 0; j < out.length; j++) delete out[j].order;
  return out;
}

module.exports = {
  activeTrips: activeTrips,
  TRIP_GRACE: TRIP_GRACE,
  nextOccurrence: nextOccurrence,
  build: build,
  due: due,
  toWakeups: toWakeups,
  WAKEUP_SPACING: WAKEUP_SPACING,
  MAX_WAKEUPS: MAX_WAKEUPS
};
