// Alternative PebbleKit JS entry for testing the watch UI alone:
//   PKJS_ENTRY=src/pkjs/ui-fixture.js pebble build
// Used by tools/test-ui-emulator.sh and tools/screenshots.sh. ES5; uses only protocol.encodeList / createSender /
// decodeWatchMessage. The newer ITEM_* keys (bearing, distance, lanes, full title, route name), the WAKEUP_* list and
// the NOTIFY_* message are built here directly so the fixture does not depend on newer protocol encoders.
//
// Deterministic: every time is relative to FIXED_NOW (not the phone clock). The scripts pin the emulator clock to it
// with `pebble emu-set-time FIXED_NOW` before installing (the wakeups rely on that), but the emulator ignores later
// emu-set-time calls while the app runs, so the clock drifts during a run; every test hook therefore also sends
// {TEST_NOW: FIXED_NOW}, which the watch then shows its times against (times carry +20 s of slack).
//
// On 'ready': the main list + a wakeup list (cookie 1 fires at FIXED_NOW + 70 s; reported back as 'UI-FIXTURE wakeup 1').
// Every REFRESH (long SELECT) from the watch logs 'UI-FIXTURE refresh' and runs the next entry of STEPS; a step can set
// the watch's test hook ({REFRESH: v}, CONTRACTS.md §11: v >= 0 freezes the marquee clock at v ms, MARQUEE_END at the
// end of its scroll, v <= -1000 freezes the wheel between rows), send another list, a notification, or an empty list.
// tools/screenshots.sh walks these steps in order: keep the two in sync.

var protocol = require('../common/protocol');

var FIXED_NOW = 1768464000;   // 2026-01-15 08:00:00 UTC
var MARQUEE_END = 1000000000;

var listId = 0;
var step = 0;

var sender = protocol.createSender(function (dict, onOk, onErr) {
  Pebble.sendAppMessage(dict, onOk, onErr);
});

function t(s) { return FIXED_NOW + s + 20; }

function mainItems() {
  // At least 8 items so the watch wheel has rows above and below the selection. Two-lane pickups have `lanes`
  // (lane 0 = the tile's own dir/times); drop-off distance = left to ride.
  return [
    { kind: 'pickup', badge: '2', color: '771473', title: 'Franklin Av & Lyndale Av S',
      route: 'Franklin Av - Riverside Av - U of M - 8th St SE', times: [t(180), t(720), t(1500)],
      bearing: 40, dist: '350ft', dir: 'EB',
      lanes: [{ dir: 'EB', times: [t(180), t(720), t(1500)] }, { dir: 'WB', times: [t(300), t(1260)] }] },
    { kind: 'dropoff', badge: '2', color: '771473', title: 'Home', route: 'Franklin Av - Riverside Av - U of M - 8th St SE',
      times: [t(600), t(1500), t(300)], bearing: 275, dist: '2.4mi', dir: 'WB' },
    { kind: 'pickup', badge: 'B Line', color: 'ED1B2E', title: 'Lake St & Hennepin Av', route: 'B Line - Lake St - Marshall Av',
      times: [t(0), t(900), t(4000)], bearing: 180, dist: '0.2mi', dir: 'EB' },
    { kind: 'dropoff', badge: 'B Line', color: 'ED1B2E', title: 'Work', route: 'B Line - Lake St - Marshall Av',
      times: [0, t(1200), t(240)], bearing: 95, dist: '3.1mi', dir: 'EB' },
    { kind: 'pickup', badge: 'Blue', color: '00539F', title: 'Lake St/Midtown Station', route: 'Blue Line - Mpls - Airport - MOA',
      times: [t(300), t(900)], bearing: 130, dist: '0.4mi', dir: 'SB',
      lanes: [{ dir: 'SB', times: [t(300), t(900)] }, { dir: 'NB', times: [t(420)] }] },
    { kind: 'dropoff', badge: 'Blue', color: '00539F', title: 'Airport', route: 'Blue Line - Mpls - Airport - MOA',
      times: [t(1800), t(2400), t(1500)], bearing: 160, dist: '6.8mi', dir: 'SB' },
    { kind: 'pickup', badge: '21', color: 'FFD200', title: 'Lake St & Chicago Av - Midtown Global Market (Stop 21)',
      route: 'Selby - Lake - Uptown - Midway - Downtown St Paul', times: [t(480), t(1080), t(1680)],
      bearing: 90, dist: '0.3mi', dir: 'WB' },
    { kind: 'pickup', badge: '612', title: 'Hennepin & 31st St', times: [t(900)] },
    { kind: 'dropoff', badge: '6', color: '0053A0', title: 'Gym', route: 'Hennepin Av - University Av SE - Southdale',
      times: [t(240), t(1140), t(360)], bearing: 0, dist: '1.2mi', dir: 'NB' },
    { kind: 'pickup', badge: '18', color: '0053A0', title: 'Nicollet & 26th St', route: 'Nicollet Av - 46th St Station',
      times: [t(60), t(660), 0], bearing: 315, dist: '90ft', dir: 'NB' }
  ];
}

function tripItems() {
  // A planned trip in progress: its remaining bus legs come first (kind 2: t0 board, t1 alight, t2 = 1 once riding).
  var items = [
    { kind: 'trip', badge: '2', color: '771473', title: 'Franklin Av & Lyndale Av S', dir: 'EB',
      route: 'Planned trip: Work · by 9:00 AM', times: [t(240), t(1260), 0], bearing: 40, dist: '350ft' },
    { kind: 'trip', badge: 'Blue', color: '00539F', title: 'Mall of America Station', dir: 'SB',
      route: 'Planned trip: Work · by 9:00 AM', times: [t(-600), t(1500), 1], bearing: 160, dist: '6.8mi' }
  ];
  return items.concat(mainItems().slice(0, 6));
}

// The ITEM_* keys of CONTRACTS.md §7 that the fixture sets itself (overriding whatever protocol.encodeList emits).
function extraKeys(item) {
  var lanes = item.lanes || [];
  var extra = {
    ITEM_KIND: item.kind === 'trip' ? 2 : item.kind === 'dropoff' ? 1 : 0,
    ITEM_TITLE: protocol.truncateUtf8(item.title, 63),
    ITEM_ROUTE: protocol.truncateUtf8(item.route || '', 63),
    ITEM_BEARING: typeof item.bearing === 'number' ? Math.round(item.bearing) % 360 : -1,
    ITEM_DIST: item.dist || '',
    ITEM_DIR: (lanes[0] && lanes[0].dir) || item.dir || '',
    ITEM_LANES: lanes.length >= 2 ? 2 : 1
  };
  if (lanes.length >= 2) {
    var u = lanes[1].times || [];
    extra.ITEM_DIR2 = lanes[1].dir || '';
    extra.ITEM_U0 = u[0] || 0;
    extra.ITEM_U1 = u[1] || 0;
    extra.ITEM_U2 = u[2] || 0;
  }
  return extra;
}

function sendList(items, status) {
  listId++;
  // encodeList knows only pickup/dropoff: encode trips as pickups, ITEM_KIND is overridden below.
  var plain = [];
  for (var j = 0; j < items.length; j++) {
    var copy = {};
    for (var key in items[j]) if (items[j].hasOwnProperty(key)) copy[key] = items[j][key];
    if (copy.kind === 'trip') copy.kind = 'pickup';
    plain.push(copy);
  }
  var messages = protocol.encodeList(listId, plain, status || ('Fixture ' + listId));
  for (var i = 0; i < messages.length; i++) {
    var idx = messages[i].ITEM_INDEX;
    if (typeof idx !== 'number' || !items[idx]) continue;
    var extra = extraKeys(items[idx]);
    for (var k in extra) {
      if (extra.hasOwnProperty(k)) messages[i][k] = extra[k];
    }
  }
  sender.sendAll(messages);
}

function sendWakeups() {
  // cookie 3 is listed first and cookie 2 within a minute of cookie 1: the watch sorts and spaces them.
  var wakeups = [{ time: FIXED_NOW + 3600, cookie: 3 }, { time: FIXED_NOW + 70, cookie: 1 }, { time: FIXED_NOW + 90, cookie: 2 }];
  var messages = [{ WAKEUP_COUNT: wakeups.length }];
  for (var i = 0; i < wakeups.length; i++) {
    messages.push({ WAKEUP_INDEX: i, WAKEUP_TIME: wakeups[i].time, WAKEUP_COOKIE: wakeups[i].cookie });
  }
  sender.sendAll(messages);
}

function sendNotify() {
  sender.sendAll([{
    NOTIFY_TITLE: 'Work: leave 8:05 AM',
    NOTIFY_BODY: 'Walk 4 min to Franklin Av & Lyndale Av S. Take 2 (EB) at 8:09 AM, 6 stops. Get off at Franklin ' +
      'Station 8:24 AM. Walk 3 min. Arrive 8:28 AM.',
    NOTIFY_COLOR: 0x771473
  }]);
}

// Every hook also pins the watch's display clock to FIXED_NOW (TEST_NOW): emu-set-time doesn't stick while an app runs.
function hook(v) { sender.sendAll([{ REFRESH: v, TEST_NOW: FIXED_NOW }]); }

// One entry per REFRESH, in order (tools/screenshots.sh relies on this order).
var STEPS = [
  function () { hook(0); },                       // 1 marquee frozen at its start (top, heading 0/90, down 1/2)
  function () { hook(2500); },                    // 2 mid-scroll
  function () { hook(MARQUEE_END); },             // 3 end of the scroll
  function () { hook(0); },                       // 4 back to the start (scrolling scenes)
  function () { hook(-1500); },                   // 5 wheel halfway to the next row (mid-animation)
  function () { hook(0); },                       // 6 two-lane tile, long title
  function () { hook(MARQUEE_END); },             // 7 long title scrolled to its end
  function () { sendList(tripItems()); hook(0); },// 8 planned-trip tiles pinned first
  function () { sendNotify(); },                  // 9 notification window
  function () { sendList([], 'No stops nearby'); } // 10 empty list / status screen
];

Pebble.addEventListener('ready', function () {
  console.log('UI-FIXTURE ready');
  sendList(mainItems());
  sendWakeups();
});

Pebble.addEventListener('appmessage', function (e) {
  var p = e.payload || {};
  if (p.WAKEUP_FIRED !== undefined) {
    console.log('UI-FIXTURE wakeup ' + p.WAKEUP_FIRED);
    return;
  }
  var msg = protocol.decodeWatchMessage(p);
  if (!msg) return;
  if (msg.type === 'select') {
    console.log('UI-FIXTURE select ' + msg.listId + ' ' + msg.index);
  } else if (msg.type === 'refresh') {
    console.log('UI-FIXTURE refresh');
    if (step < STEPS.length) STEPS[step++]();
    console.log('UI-FIXTURE step ' + step);
  }
});
