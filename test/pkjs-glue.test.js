// Integration: loads the real src/pkjs/index.js against a fake Pebble runtime (Pebble events, sendAppMessage,
// localStorage, geolocation, XMLHttpRequest, timers) and walks through ready -> list -> SELECT -> settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

function installFakes(storedConfig) {
  const handlers = {};
  const messages = [];
  const opened = [];
  const intervals = [];
  const store = new Map(storedConfig ? [['busWatch.config', JSON.stringify(storedConfig)]] : []);
  globalThis.Pebble = {
    addEventListener: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); },
    sendAppMessage: (dict, ok) => { messages.push(dict); setTimeout(() => ok && ok({}), 0); },
    openURL: url => opened.push(url),
    getActiveWatchInfo: () => ({ platform: 'basalt' }),
    getWatchToken: () => 'token',
    getAccountToken: () => 'acct',
  };
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    clear: () => store.clear(),
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    language: 'en-US',
    geolocation: { getCurrentPosition: (ok) => setTimeout(() => ok({ coords: { latitude: 47.6, longitude: -122.3, accuracy: 10 } }), 0) },
  } });
  globalThis.XMLHttpRequest = function () { throw new Error('no network in tests (provider should be mock)'); };
  // keep the refresh interval from holding the process open
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
  globalThis.clearInterval = () => {};
  const fire = (name, e) => (handlers[name] || []).forEach(fn => fn(e || {}));
  return { handlers, messages, opened, intervals, store, fire, restore: () => { globalThis.setInterval = realSetInterval; } };
}

test('pkjs glue: ready -> list, select -> sample, settings page open/close', async () => {
  const fakes = installFakes({
    provider: { type: 'mock' }, location: { mode: 'gps', lat: 47.6, lon: -122.3 }, refreshInterval: 45,
    routes: [{ id: 'R1', name: 'One' }], connections: [{ routeId: 'R1', stopId: 'R1:s12', name: 'Work' }],
  });
  try {
    require(path.join(__dirname, '..', 'src/pkjs/index.js'));
    assert.ok(fakes.handlers.ready, 'registers ready');
    fakes.fire('ready');
    await tick(100);
    const header = fakes.messages.filter(m => 'ITEM_COUNT' in m).pop();
    assert.ok(header && header.ITEM_COUNT > 0, 'a list was sent: ' + JSON.stringify(fakes.messages.slice(0, 4)));
    assert.ok(fakes.messages.some(m => m.ITEM_BADGE === 'One' && m.ITEM_TITLE === 'Work' && m.ITEM_COLOR === 0xE53935), 'drop-off item sent');
    assert.ok(fakes.intervals.some(i => i.ms === 45000), 'periodic refresh every refreshInterval s');

    fakes.fire('appmessage', { payload: { SELECT_INDEX: 0, LIST_ID: header.LIST_ID } });
    await tick();
    assert.equal(JSON.parse(fakes.store.get('busWatch.samples')).length, 1, 'sample stored');
    assert.ok(fakes.messages.some(m => /^Learned \(1 picks\)$/.test(m.STATUS || '')));

    fakes.fire('showConfiguration');
    assert.equal(fakes.opened.length, 1);
    assert.ok(fakes.opened[0].startsWith('data:text/html'), fakes.opened[0].slice(0, 40));
    const html = decodeURIComponent(fakes.opened[0].slice(fakes.opened[0].indexOf(',') + 1));
    const m = html.match(/window\.__params = (\{.*?\});<\/script>/s);
    assert.ok(m, 'params injected');
    const params = JSON.parse(m[1]);
    assert.equal(params.config.routes[0].id, 'R1');
    assert.equal(params.samples.length, 1);
    assert.equal(params.return_to, 'pebblejs://close#');

    const result = { config: Object.assign({}, params.config, { maxItems: 3 }), clearSamples: true };
    fakes.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify(result)) });
    await tick(100);
    assert.equal(JSON.parse(fakes.store.get('busWatch.config')).maxItems, 3);
    assert.deepEqual(JSON.parse(fakes.store.get('busWatch.samples')), []);
    assert.equal(fakes.messages.filter(m => 'ITEM_COUNT' in m).pop().ITEM_COUNT <= 3, true);

    assert.deepEqual(params.sources.map(s => s.type), ['metrotransit', 'onebusaway', 'mock'], 'source plug-ins listed');
    assert.deepEqual(params.plans, {});
    assert.equal(params.config.version, 2, 'the stored version 1 config was migrated');
    assert.deepEqual(params.prefs, { units: 'imperial', clock24: false, known: false }, 'en-US guess until the watch says');
    assert.deepEqual(params.catalogs, {}, 'nothing indexed yet');

    // the watch reports its display settings; the page gets them, with the stored search index
    fakes.fire('appmessage', { payload: { WATCH_PREFS: 1 | 2 | 4 } });
    const catalog = require('../src/common/catalog');
    const entry = params.config.providers[0];
    fakes.store.set(catalog.PREFIX + entry.id, JSON.stringify(catalog.pack({ routes: [{ id: 'R1', shortName: 'One' }], stops: [] },
      { t: Math.floor(Date.now() / 1000), sig: catalog.signature(entry) })));
    fakes.fire('showConfiguration');
    const p2 = JSON.parse(decodeURIComponent(fakes.opened[1].slice(fakes.opened[1].indexOf(',') + 1)).match(/window\.__params = (\{.*?\});<\/script>/s)[1]);
    assert.deepEqual(p2.prefs, { units: 'metric', clock24: true, known: true });
    assert.deepEqual(Object.keys(p2.catalogs), [entry.id]);
    assert.deepEqual(catalog.fromText(p2.catalogs[entry.id]).routes, [['R1', 'One', '']], 'sent in the text form');
    fakes.opened.pop();

    // add a destination: the scheduler plans it and schedules wakeups on the watch
    const d = new Date(Date.now() + 3 * 3600 * 1000);
    const arriveBy = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const withDest = { config: Object.assign({}, params.config, {
      destinations: [{ id: 'work', name: 'Work', lat: 47.6 + 0.0234, lon: -122.3, arriveBy }] }) };
    fakes.messages.length = 0;
    fakes.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify(withDest)) });
    await tick(300);
    const wake = fakes.messages.filter(m => 'WAKEUP_COUNT' in m).pop();
    assert.ok(wake && wake.WAKEUP_COUNT >= 1, 'wakeups sent: ' + JSON.stringify(fakes.messages.filter(m => !('ITEM_INDEX' in m))));
    assert.ok(JSON.parse(fakes.store.get('busWatch.plans')).work, 'plan stored');
    fakes.fire('showConfiguration');
    const html2 = decodeURIComponent(fakes.opened[1].slice(fakes.opened[1].indexOf(',') + 1));
    assert.ok(JSON.parse(html2.match(/window\.__params = (\{.*?\});<\/script>/s)[1]).plans.work, 'plans passed to the page');
    fakes.fire('appmessage', { payload: { WAKEUP_FIRED: 1 } }); // routed to the scheduler: no crash
    await tick(100);

    fakes.fire('webviewclosed', { response: '' }); // cancelled settings page: no crash
    fakes.fire('appmessage', { payload: { REFRESH: 1 } });
    await tick(100);
  } finally { fakes.restore(); }
});
