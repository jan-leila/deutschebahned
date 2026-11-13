'use strict';
// Small helpers shared by the data-source plug-ins. ES5. Sources must not import app modules
// (settings, planner, session, ...); only this file and the pure geometry library src/common/geo.js.

// 'RRGGBB' (upper case) from '#rrggbb' or 'rrggbb'; anything else → ''
function color(v) {
  if (typeof v !== 'string') return '';
  var m = v.replace(/^\s+|\s+$/g, '').match(/^#?([0-9a-fA-F]{6})$/);
  return m ? m[1].toUpperCase() : '';
}

module.exports = { color: color };
