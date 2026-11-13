'use strict';
// The data-source plug-ins shipped with the app, default first. Only composition roots
// (src/pkjs/index.js, the settings page bundle, tools) require this file.
module.exports = [
  require('./metrotransit/index').plugin,
  require('./onebusaway/index').plugin,
  require('./mock/index').plugin
];
