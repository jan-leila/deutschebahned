// Human-readable text for distances and times (CONTRACTS.md §12). Pure, ES5. Results are short
// enough for the watch (distance ≤ 7 bytes).

function pad2(n) { return n < 10 ? '0' + n : String(n); }

// meters → '35m' '350m' '1.2km' '12km' (metric) | '120ft' '0.4mi' '12mi' (imperial); not finite / < 0 → ''
function distance(meters, units) {
  if (typeof meters !== 'number' || !isFinite(meters) || meters < 0) return '';
  if (units === 'metric') {
    var m = meters < 100 ? Math.round(meters) : Math.round(meters / 10) * 10;
    if (m < 1000) return m + 'm';
    var km = Math.round(meters / 100) / 10;
    return km < 10 ? km.toFixed(1) + 'km' : Math.round(meters / 1000) + 'km';
  }
  var miles = meters / 1609.344;
  if (miles < 0.1) {
    var ft = meters * 3.28084;
    return (ft < 100 ? Math.round(ft) : Math.round(ft / 10) * 10) + 'ft';
  }
  var mi = Math.round(miles * 10) / 10;
  return mi < 10 ? mi.toFixed(1) + 'mi' : Math.round(miles) + 'mi';
}

// seconds → 'now' (≤ 30) | '4 min' | '1 h 05' ; negative → 'now'
function duration(seconds) {
  if (typeof seconds !== 'number' || !isFinite(seconds) || seconds <= 30) return 'now';
  var min = Math.max(1, Math.round(seconds / 60));
  if (min < 60) return min + ' min';
  return Math.floor(min / 60) + ' h ' + pad2(min % 60);
}

// epoch seconds → local wall clock: '8:05 AM' / '12:30 PM' (12 h) or '08:05' (24 h)
function clock(epoch, clock24) {
  var d = new Date(epoch * 1000);
  var h = d.getHours(), m = d.getMinutes();
  if (clock24) return pad2(h) + ':' + pad2(m);
  var h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + ':' + pad2(m) + (h < 12 ? ' AM' : ' PM');
}

module.exports = { distance: distance, duration: duration, clock: clock };
