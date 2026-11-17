// Alternative PebbleKit JS entry for tools/test-gravel.sh --expect weather:
//   PKJS_ENTRY=src/pkjs/gravel-weather.js pebble build
// Turns the weather panel on (showWeather, CONTRACTS.md §2 / §17) in the stored settings, then runs the real phone
// side unchanged, so a test gets the panel without tapping through the settings page. Everything after that is the
// real app: the position, the Open-Meteo request and the WEATHER_* message. The setting stays stored in the phone app
// afterwards, like one saved from the settings page. ES5.

var STORAGE_KEYS = require('../common/session').STORAGE_KEYS;
var settings = require('../common/settings');

(function () {
  var stored = null;
  try { stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.config)); } catch (e) { /* missing or broken: defaults */ }
  // A stored config (either version) keeps everything else; session.load() normalizes or migrates it as usual.
  if (!stored || typeof stored !== 'object' || stored instanceof Array) stored = settings.defaults();
  if (stored.showWeather !== true) {
    stored.showWeather = true;
    localStorage.setItem(STORAGE_KEYS.config, JSON.stringify(stored));
    console.log('[deutschebahned] gravel-weather: showWeather turned on');
  }
})();

require('./index');
