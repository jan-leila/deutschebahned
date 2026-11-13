'use strict';
// The data-source plug-ins shipped with the app, default first. Only composition roots
// (src/pkjs/index.js, the settings page bundle, tools) require this file.
module.exports = [
  require('./metrotransit/index').plugin,
  require('./onebusaway/index').plugin,
  require('./bvg/index').plugin,        // Berlin (BVG / VBB)
  require('./wmata/index').plugin,      // Washington DC
  require('./mta/index').plugin,        // New York (MTA Bus Time)
  require('./bay511/index').plugin,     // San Francisco Bay Area (511.org)
  require('./mbta/index').plugin,       // Boston
  require('./cta/index').plugin,        // Chicago
  require('./rtc/index').plugin,        // Las Vegas (RTC, via Swiftly)
  require('./mock/index').plugin
];
