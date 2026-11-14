// Settings page: builds src/pkjs/config-page.js, loads it in headless Chromium with injected params,
// drives the DOM contract (CONTRACTS.md §10) and checks what Save hands back to the phone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { openPage, findChrome } = require('./helpers/chrome');

const root = path.join(__dirname, '..');
const skip = !findChrome() && 'chromium not found (run inside nix-shell)';

const settingsMod = require('../src/common/settings');
const catalogMod = require('../src/common/catalog');

// two systems: OneBusAway (Seattle) and the mock
const config = {
  version: 2,
  providers: [
    { id: 'onebusaway', type: 'onebusaway', name: 'King County', baseUrl: 'https://oba.example/api/where', apiKey: 'abc' },
    { id: 'mock', type: 'mock', coverage: { mode: 'manual', lat: 44.97, lon: -93.26, radius: 25000 } },
  ],
  location: { mode: 'gps', lat: 0, lon: 0 },
  stopRadius: 250, routeRadius: 60, recentWindow: 240, lookahead: 45, maxItems: 8, vehicleRadius: 300,
  routes: [{ providerId: 'onebusaway', id: '1_100225', name: '44', scale: -1.5 }, { providerId: 'onebusaway', id: '1_100223', name: '43', scale: -1 }],
  stops: [{ providerId: 'onebusaway', id: '1_29247', name: 'Home', lat: 47.6612, lon: -122.3132, walkScale: 0, rideScale: -2 },
          { providerId: 'onebusaway', id: '1_10914', name: '1_10914', lat: 47.656426, lon: -122.312164, walkScale: -0.5, rideScale: 0 }],
  training: { autoTrain: true, learningRate: 0.05, iterations: 100, temperature: 60, regularization: 0.01, maxSamples: 200 },
};
// two picks: the user always prefers the sooner bus even when it is farther away
const samples = [
  { t: 1, lat: 0, lon: 0, chosen: 1, candidates: [
    { key: 'a', features: { 'stop:onebusaway/1_10914': 50, 'route:onebusaway/1_100223': 900 } },
    { key: 'b', features: { 'stop:onebusaway/X': 300, 'route:onebusaway/1_100225': 60 } }] },
  { t: 2, lat: 0, lon: 0, chosen: 0, candidates: [
    { key: 'c', features: { 'stop:onebusaway/X': 280, 'route:onebusaway/1_100225': 30 } },
    { key: 'd', features: { 'stop:onebusaway/1_10914': 20, 'route:onebusaway/1_100223': 1200 } }] },
];
const learned = { 'stop:onebusaway/1_10914': -0.25 };
const IMPERIAL = { units: 'imperial', clock24: false, known: true };
const METRIC = { units: 'metric', clock24: true, known: true };

function build() {
  const r = spawnSync(process.execPath, [path.join(root, 'tools/build-config.js')], { encoding: 'utf8', cwd: root });
  assert.equal(r.status, 0, 'build-config failed: ' + r.stderr);
  delete require.cache[require.resolve('../src/pkjs/config-page')];
  return require('../src/pkjs/config-page');
}

async function load(params, extraHead) {
  const html = build();
  assert.ok(html.includes('<!--PARAMS-->'), 'page keeps the <!--PARAMS--> marker');
  assert.ok(!/(src|href)=["']https?:/i.test(html), 'page must not load external resources');
  const injected = '<script>window.__params = ' + JSON.stringify(params).replace(/</g, '\\u003c') + ';</script>' + (extraHead || '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buswatch-page-'));
  const file = path.join(dir, 'page.html');
  fs.writeFileSync(file, html.replace('<!--PARAMS-->', injected));
  const page = await openPage('file://' + file);
  const close = page.close;
  page.close = async () => { await close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return page;
}

async function saved(page) {
  await page.eval('save()');
  for (let i = 0; i < 50 && page.navigations.length === 0; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(page.navigations.length, 1, 'save navigates to return_to');
  const url = page.navigations[0];
  assert.ok(url.startsWith('http://return.test/close?'), url);
  return JSON.parse(decodeURIComponent(url.slice('http://return.test/close?'.length)));
}

const params = (extra) => Object.assign({ config, samples, learned, prefs: IMPERIAL, return_to: 'http://return.test/close?' }, extra);
const set = (sel, v) => `(() => { const el = ${sel}; el.value = ${JSON.stringify(v)};
  el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); })()`;
const until = async (page, expr, ms = 3000) => {
  for (let t = 0; t < ms; t += 50) { if (await page.eval(expr)) return true; await new Promise(r => setTimeout(r, 50)); }
  return false;
};
const visiblePage = `[...document.querySelectorAll('.page')].filter(p => !p.hidden).map(p => p.getAttribute('data-page')).join()`;
const search = async (page, q) => {
  await page.eval(set(`document.querySelector('#search .search-input')`, q));
  await new Promise(r => setTimeout(r, 200));
};
const results = page => page.eval(`[...document.querySelectorAll('#search .result')].map(b => [b.getAttribute('data-provider'), b.getAttribute('data-id'),
  b.classList.contains('raw')])`);

test('config page: shows injected settings and saves them unchanged', { skip }, async () => {
  const page = await load(params());
  try {
    assert.deepEqual(page.errors, []);
    assert.equal(await page.eval(`document.querySelector('[data-field="stopRadius"]').value`), '820', '250 m in feet');
    assert.equal(await page.eval(`document.querySelector('[data-field="training.autoTrain"]').checked`), true);
    assert.equal(await page.eval(`document.querySelectorAll('#providers .provider-row').length`), 2);
    assert.equal(await page.eval(`document.querySelector('#providers .provider-row input[name=baseUrl]').value`), 'https://oba.example/api/where');
    assert.equal(await page.eval(`document.querySelectorAll('#routes .route-row').length`), 2);
    assert.equal(await page.eval(`document.querySelector('#routes .route-row input[name=name]').value`), '44');
    assert.equal(await page.eval(`document.querySelectorAll('#stops .stop-row').length`), 2);
    assert.equal(await page.eval(`document.querySelector('#stops .stop-row input[name=rideScale]').value`), '-2');
    assert.equal(await page.eval(`document.getElementById('sample-count').textContent.trim()`), '2');
    assert.match(await page.eval(`document.getElementById('learned').textContent`), /onebusaway\/1_10914/);
    for (const gone of ['provider.type', 'units', 'clock24', 'defaultStopScale', 'defaultRouteScale', 'defaultConnectionScale']) {
      assert.equal(await page.eval(`document.querySelectorAll('[data-field="${gone}"]').length`), 0, gone);
    }
    const out = await saved(page);
    assert.deepEqual(out.config, settingsMod.normalize(config));
    assert.equal('learned' in out, false, 'learned untouched -> not sent');
    assert.equal('clearSamples' in out, false);
    // fillForm(readForm()) is a fixed point
    assert.deepEqual(await page.eval(`(() => { const c = readForm(); fillForm(c); return readForm(); })()`), settingsMod.normalize(config));
  } finally { await page.close(); }
});

test('config page: a home menu of pages; one page at a time; back returns home', { skip }, async () => {
  const page = await load(params());
  try {
    assert.equal(await page.eval(visiblePage), 'home');
    assert.equal(await page.eval(`document.getElementById('back').hidden`), true);
    const summaries = await page.eval(`Object.fromEntries([...document.querySelectorAll('.nav-item')].map(b =>
      [b.getAttribute('data-go'), b.querySelector('.nav-summary').textContent]))`);
    assert.deepEqual(Object.keys(summaries), ['systems', 'routes', 'stops', 'trips', 'nearby', 'learning']);
    assert.equal(summaries.systems, 'King County, Mock (demo data)');
    assert.equal(summaries.routes, '44, 43');
    assert.equal(summaries.stops, 'Home, 1_10914');
    assert.match(summaries.nearby, /^Stops within 820 ft/);
    assert.equal(summaries.learning, '2 picks · 1 learned weight');
    for (const name of ['systems', 'routes', 'stops', 'trips', 'nearby', 'learning']) {
      await page.eval(`document.querySelector('.nav-item[data-go=${name}]').click()`);
      assert.ok(await until(page, `${visiblePage} === '${name}'`), name);
      assert.equal(await page.eval(`document.getElementById('back').hidden`), false);
      await page.eval(`document.getElementById('back').click()`);
      assert.ok(await until(page, `${visiblePage} === 'home'`), 'back from ' + name);
    }
    assert.match(await page.eval(`document.getElementById('page-title').textContent`), /Bus Watch/);
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test("config page: distances in the watch's units, stored in meters; untouched values unchanged", { skip }, async () => {
  for (const [prefs, shown, unit, coverage] of [[IMPERIAL, '820', 'ft', '15.5'], [METRIC, '250', 'm', '25']]) {
    const page = await load(params({ prefs }));
    try {
      assert.equal(await page.eval(`document.querySelector('[data-field="stopRadius"]').value`), shown);
      assert.equal(await page.eval(`document.querySelector('[data-field="stopRadius"]').parentNode.querySelector('.hint').textContent.split(' ')[0]`), unit);
      assert.equal(await page.eval(`document.querySelectorAll('#providers .provider-row')[1].querySelector('input[name=radius]').value`), coverage);
      assert.match(await page.eval(`document.getElementById('prefs-note').textContent`),
        prefs.units === 'metric' ? /meters and kilometers, times in the 24-hour clock, as set on your Pebble/ : /feet and miles, times in the 12-hour clock/);
      await page.eval(set(`document.querySelector('[data-field="routeRadius"]')`, prefs.units === 'metric' ? '100' : '328'));
      await page.eval(set(`document.querySelector('[data-field="schedule.walkSpeed"]')`, prefs.units === 'metric' ? '3.6' : '2.2'));
      await page.eval(set(`document.querySelectorAll('#providers .provider-row')[1].querySelector('input[name=radius]')`, '10'));
      const out = await saved(page);
      assert.equal(out.config.stopRadius, 250, 'untouched');
      assert.equal(out.config.schedule.maxWalk, 800, 'untouched');
      assert.equal(out.config.routeRadius, 100, 'edited, back in meters');
      assert.ok(Math.abs(out.config.schedule.walkSpeed - (prefs.units === 'metric' ? 1 : 2.2 / 2.236936)) < 1e-9, String(out.config.schedule.walkSpeed));
      assert.equal(out.config.providers[1].coverage.radius, prefs.units === 'metric' ? 10000 : 16093);
      assert.deepEqual(page.errors, []);
    } finally { await page.close(); }
  }
  // the watch hasn't said yet: the phone's locale, and a note that the watch will update it
  const page = await load(params({ prefs: undefined }));
  try {
    assert.match(await page.eval(`document.getElementById('prefs-note').textContent`), /once connected/);
  } finally { await page.close(); }
});

test('config page: editing fields; coverage area summaries', { skip }, async () => {
  const page = await load(params({ prefs: METRIC }));
  try {
    await page.eval(set(`document.querySelector('[data-field="stopRadius"]')`, '400'));
    await page.eval(`(() => { const mode = document.querySelector('[data-field="location.mode"]'); mode.value = 'fixed';
      mode.dispatchEvent(new Event('change', {bubbles: true})); })()`);
    await page.eval(set(`document.querySelector('[data-field="location.lat"]')`, '47.6'));
    await page.eval(set(`document.querySelector('[data-field="location.lon"]')`, '-122.3'));
    await page.eval(`document.querySelector('[data-field="training.autoTrain"]').click()`);
    const rows = `document.querySelectorAll('#providers .provider-row')`;
    await page.eval(`showPage('systems')`);
    assert.ok(await until(page, `${visiblePage} === 'systems'`));
    assert.match(await page.eval(`${rows}[0].querySelector('.coverage-summary').textContent`), /^Used within about 30\.\d km of 47\.6/);
    assert.equal(await page.eval(`${rows}[0].querySelector('.manual').hidden`), true);
    assert.equal(await page.eval(`${rows}[1].querySelector('.manual').hidden`), false);
    assert.equal(await page.eval(`${rows}[1].querySelector('.coverage-summary').textContent`), 'Used within 25 km of 44.97, -93.26.');
    await page.eval(set(`${rows}[0].querySelector('input[name=apiKey]')`, 'newkey'));
    await page.eval(set(`${rows}[1].querySelector('select[name=coverageMode]')`, 'auto'));
    assert.match(await page.eval(`${rows}[1].querySelector('.coverage-summary').textContent`), /^Used within about 25 km of 44.97, -93.26 \(its home area, until you save stops\)/, 'automatic without stops: the centre stays as its home area');
    await page.eval(`document.querySelector('#routes .route-row .remove').click()`);           // drop route 44
    await page.eval(`document.querySelector('#routes .route-row input[name=scale]').value = '-0.8'`);
    await page.eval(`document.querySelector('#routes .route-row input[name=color]').value = '#00aa55'`);
    await page.eval(`document.querySelector('#stops .stop-row input[name=walkScale]').value = '-3'`);
    const rf = await page.eval('JSON.stringify(readForm())');
    const out = await saved(page);
    assert.deepEqual(out.config, JSON.parse(rf));
    assert.equal(out.config.stopRadius, 400);
    assert.equal(out.config.providers[0].apiKey, 'newkey');
    assert.equal(out.config.providers[1].coverage.mode, 'auto');
    assert.deepEqual(out.config.location, { mode: 'fixed', lat: 47.6, lon: -122.3 });
    assert.equal(out.config.training.autoTrain, false);
    assert.deepEqual(out.config.routes, [{ providerId: 'onebusaway', id: '1_100223', name: '43', scale: -0.8, color: '00AA55' }]);
    assert.equal(out.config.stops[0].walkScale, -3);
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test('config page: add / remove transit systems; removing one drops its routes and stops', { skip }, async () => {
  const page = await load(params());
  try {
    await page.eval(`window.confirm = () => true; document.getElementById('add-provider').click()`);
    const rows = `document.querySelectorAll('#providers .provider-row')`;
    assert.equal(await page.eval(`${rows}.length`), 3);
    assert.equal(await page.eval(`${rows}[2].querySelector('select[name=type]').value`), 'metrotransit', 'first unused type');
    assert.deepEqual(await page.eval(`[...${rows}[2].querySelectorAll('select[name=type] option')].map(o => o.value)`),
      ['metrotransit', 'onebusaway', 'bvg', 'wmata', 'mta', 'bay511', 'mbta', 'cta', 'rtc', 'mock']);
    await page.eval(set(`${rows}[2].querySelector('select[name=type]')`, 'mock'));
    assert.equal(await page.eval(`${rows}[2].querySelector('input[name=id]').value`), 'mock-2', 'an unused system takes an id after its type');
    await page.eval(`${rows}[0].querySelector('.remove').click()`);
    assert.equal(await page.eval(`document.querySelectorAll('#routes .route-row, #stops .stop-row').length`), 0);
    const out = await saved(page);
    assert.deepEqual(out.config.providers.map(p => [p.id, p.type]), [['mock', 'mock'], ['mock-2', 'mock']]);
    assert.deepEqual(out.config.routes, []);
    assert.deepEqual(out.config.stops, []);
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
  // declining the confirmation keeps everything
  const page2 = await load(params());
  try {
    await page2.eval(`window.confirm = () => false; document.querySelector('#providers .provider-row .remove').click()`);
    assert.equal(await page2.eval(`document.querySelectorAll('#providers .provider-row').length`), 2);
    assert.equal(await page2.eval(`document.querySelectorAll('#routes .route-row').length`), 2);
  } finally { await page2.close(); }
});

test('config page: an unknown system type is kept', { skip }, async () => {
  const page = await load(params({ config: Object.assign({}, config, { providers: [{ id: 'gtfs', type: 'gtfs' }], routes: [], stops: [] }) }));
  try {
    assert.equal(await page.eval(`document.querySelector('#providers select[name=type]').value`), 'gtfs');
    assert.equal((await saved(page)).config.providers[0].type, 'gtfs');
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test('config page: works with no injected params (defaults)', { skip }, async () => {
  const page = await load({ return_to: 'http://return.test/close?' });
  try {
    assert.deepEqual(page.errors, []);
    const out = await saved(page);
    assert.deepEqual(out.config, settingsMod.defaults());
  } finally { await page.close(); }
});

// Metro Transit: the page talks to svc.metrotransit.org directly (CORS is open). Here fetch is stubbed
// with recorded responses so the test runs offline.
function fetchStub(offline) {
  const fx = n => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));
  const table = offline ? {} : {
    '/nextrip/routes': fx('mt-nextrip-routes.json'),
    '/schedule/routes': fx('mt-schedule-routes.json'),
    '/schedule/routedetails/2': fx('mt-routedetails-2.json'),
    '/schedule/stoplist/2/1': fx('mt-stoplist-2-1.json'),
    '/schedule/stoplist/2/2': fx('mt-stoplist-2-2.json'),
    '/nextrip/16058': fx('mt-nextrip-stop-16058.json'),
    '/nextrip/13334': fx('mt-nextrip-stop-13334.json'),
  };
  return `<script>window.__fetched = []; window.fetch = function (url) {
    window.__fetched.push(String(url));
    ${offline ? "return Promise.reject(new TypeError('Failed to fetch'));" : ''}
    var table = ${JSON.stringify(table).replace(/</g, '\\u003c')};
    var p = String(url).replace('https://svc.metrotransit.org', '');
    var body = table[p];
    return Promise.resolve({ ok: !!body, status: body ? 200 : 400, json: function () { return Promise.resolve(body || { status: 400, detail: 'Invalid' }); } });
  };</script>`;
}
const mtConfig = { version: 2, providers: [{ id: 'metrotransit', type: 'metrotransit' }], routes: [{ providerId: 'metrotransit', id: '2', name: '2' }] };
const mtParams = (extra) => Object.assign({ config: mtConfig, samples: [], learned: {}, prefs: IMPERIAL, return_to: 'http://return.test/close?' }, extra);

test('config page (metrotransit): add a route by typing its name; the index is built on the page', { skip }, async () => {
  const page = await load(mtParams(), fetchStub());
  try {
    await page.eval(`showPage('routes')`);
    assert.ok(await until(page, `${visiblePage} === 'routes'`));
    assert.equal(await page.eval(`document.getElementById('search').hidden`), true);
    await page.eval(`document.getElementById('add-route').click()`);
    assert.equal(await page.eval(`document.getElementById('search').hidden`), false, 'a text input appears');
    assert.equal(await page.eval(`document.activeElement === document.querySelector('#search .search-input')`), true);
    assert.ok(await until(page, `window.__fetched.includes('https://svc.metrotransit.org/schedule/stoplist/2/2')`), 'index built');
    await search(page, 'blue');
    assert.deepEqual(await results(page), [['metrotransit', '901', false], ['metrotransit', 'blue', true]]);
    assert.match(await page.eval(`document.querySelector('#search .result').textContent`), /METRO Blue Line/);
    await page.eval(`document.querySelector('#search .result').click()`);
    assert.equal(await page.eval(`document.getElementById('search').hidden`), true);
    const rows = `document.querySelectorAll('#routes .route-row')`;
    assert.equal(await page.eval(`${rows}.length`), 2);
    assert.match(await page.eval(`${rows}[1].querySelector('.row-head').textContent`), /Route 901/);
    // routes already saved (2, and now 901) aren't offered again, not even as a typed id
    await page.eval(`document.getElementById('add-route').click()`);
    await search(page, '2');
    assert.deepEqual(await results(page), [['metrotransit', '922', false]]);
    await search(page, 'blue');
    assert.deepEqual(await results(page), [['metrotransit', 'blue', true]]);
    await page.eval(`document.querySelector('#search .search-cancel').click()`);
    assert.equal(await page.eval(`${rows}.length`), 2);
    // anything the index doesn't know: the typed id
    await page.eval(`document.getElementById('add-route').click()`);
    await search(page, 'X99');
    assert.deepEqual(await results(page), [['metrotransit', 'X99', true]]);
    assert.match(await page.eval(`document.querySelector('#search .result').textContent`), /Use route id “X99”/);
    await page.eval(`document.querySelector('#search .result').click()`);
    const out = await saved(page);
    assert.deepEqual(out.config.routes, [
      { providerId: 'metrotransit', id: '2', name: '2', scale: 0, color: '' },
      { providerId: 'metrotransit', id: '901', name: '901', scale: 0, color: '' },
      { providerId: 'metrotransit', id: 'X99', name: 'X99', scale: 0, color: '' }]);
    assert.ok(!page.navigations.slice(1).length);
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test('config page (metrotransit): add a stop by name; its position is looked up; served routes shown', { skip }, async () => {
  const page = await load(mtParams(), fetchStub());
  try {
    await page.eval(`showPage('stops')`);
    await page.eval(`document.getElementById('add-stop').click()`);
    assert.ok(await until(page, `!document.querySelector('#search .search-status').textContent.includes('Indexing')`));
    await search(page, 'franklin lyndale');
    assert.deepEqual((await results(page))[0], ['metrotransit', '13334', false]);
    assert.match(await page.eval(`document.querySelector('#search .result').textContent`), /^Franklin Ave W & Lyndale Ave S · Eastbound#13334.*Routes 2/, 'the direction tells same-name stops apart');
    await page.eval(`document.querySelector('#search .result').click()`);
    const row = `document.querySelector('#stops .stop-row')`;
    assert.ok(await until(page, `${row}.querySelector('input[name=lat]').value !== ''`), 'position from stopInfo');
    assert.ok(await page.eval(`window.__fetched.includes('https://svc.metrotransit.org/nextrip/13334')`));
    assert.equal(await page.eval(`${row}.querySelector('input[name=name]').value`), 'Franklin Ave W & Lyndale Ave S');
    assert.equal(await page.eval(`${row}.querySelector('.stop-meta').textContent`), 'Eastbound · Routes 2', 'its direction, then the routes');
    assert.equal(await page.eval(`${row}.querySelector('.stop-meta b').textContent`), '2', 'saved route in bold');
    await page.eval(`${row}.querySelector('input[name=name]').value = 'Home'`);
    await page.eval(`${row}.querySelector('input[name=rideScale]').value = '-1.5'`);
    const out = await saved(page);
    const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mt-nextrip-stop-13334.json'), 'utf8')).stops[0];
    assert.deepEqual(out.config.stops, [{ providerId: 'metrotransit', id: '13334', name: 'Home', lat: fx.latitude, lon: fx.longitude,
      walkScale: 0, rideScale: -1.5 }]);
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
  // with route 2 not saved the stop warns that it gets no drop-off times
  const page2 = await load(mtParams({ config: Object.assign({}, mtConfig, { routes: [],
    stops: [{ providerId: 'metrotransit', id: '16058', name: 'Work' }] }) }), fetchStub());
  try {
    await page2.eval(`showPage('stops'); document.getElementById('add-stop').click()`);
    assert.ok(await until(page2, `/no drop-off times/.test(document.querySelector('#stops .stop-meta').textContent)`));
    assert.deepEqual(page2.errors, []);
  } finally { await page2.close(); }
});

test('config page: an index from the phone is searched without the network; results across systems name the system', { skip }, async () => {
  const mt = { id: 'metrotransit', type: 'metrotransit', baseUrl: '', apiKey: '' };
  const packed = catalogMod.pack({ routes: [{ id: '2', shortName: '2', longName: 'Franklin Av' }],
    stops: [{ id: '16058', name: '8th St SE & 5th Ave SE', routeIds: ['2'], lat: 44.989411, lon: -93.245348 }] },
  { t: Math.floor(Date.now() / 1000) - 3 * 86400, sig: catalogMod.signature(mt) });
  const cfg = Object.assign({}, mtConfig, { providers: [mt, { id: 'mock', type: 'mock' }] });
  const page = await load(mtParams({ config: cfg, catalogs: { metrotransit: catalogMod.toText(packed) } }), fetchStub(true));
  try {
    await page.eval(`showPage('systems')`);
    assert.match(await page.eval(`document.querySelector('#providers .provider-row .index-status').textContent`),
      /^Search index: 1 route, 1 stop · updated 3 days ago$/);
    await page.eval(`showPage('stops'); document.getElementById('add-stop').click()`);
    await search(page, '5th ave');
    assert.deepEqual((await results(page))[0], ['metrotransit', '16058', false]);
    assert.match(await page.eval(`document.querySelector('#search .result .r-id').textContent`), /#16058 · Metro Transit/);
    await page.eval(`document.querySelector('#search .result').click()`);
    assert.ok(!(await page.eval(`window.__fetched.length`)), 'no requests: the position came from the index');
    const out = await saved(page);
    assert.deepEqual(out.config.stops[0], { providerId: 'metrotransit', id: '16058', name: '8th St SE & 5th Ave SE', lat: 44.989411,
      lon: -93.245348, walkScale: 0, rideScale: 0 });
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test('config page (metrotransit): offline: indexing fails inline, a typed id still works', { skip }, async () => {
  const page = await load(mtParams(), fetchStub(true));
  try {
    await page.eval(`showPage('routes'); document.getElementById('add-route').click()`);
    assert.ok(await until(page, `/Couldn't index/.test(document.querySelector('#search .search-status').textContent)`));
    await search(page, '6');
    assert.deepEqual(await results(page), [['metrotransit', '6', true]]);
    await page.eval(`document.querySelector('#search .result').click()`);
    assert.equal((await saved(page)).config.routes.length, 2);
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test('config page (metrotransit): load the official route color', { skip }, async () => {
  const page = await load(mtParams(), fetchStub());
  try {
    await page.eval(`showPage('routes'); document.querySelector('#routes .route-row .load-color').click()`);
    assert.ok(await until(page, `document.querySelector('#routes .route-row input[name=color]').value === '#771473'`));
    assert.equal((await saved(page)).config.routes[0].color, '771473');
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test('config page: train now, then bake learned weights into the form', { skip }, async () => {
  const page = await load(params());
  try {
    await page.eval(`showPage('learning'); document.getElementById('train-now').click()`);
    await new Promise(r => setTimeout(r, 300));
    assert.match(await page.eval(`document.getElementById('train-result').textContent`), /\d/);
    assert.match(await page.eval(`document.getElementById('learned').textContent`), /route:onebusaway\/1_100225/);
    assert.match(await page.eval(`document.getElementById('learned').textContent`), /walking to 1_10914/);
    await page.eval(`document.getElementById('bake-learned').click()`);
    const out = await saved(page);
    assert.equal(out.learned, null, 'after baking, learned weights are reset');
    const r44 = out.config.routes.find(r => r.id === '1_100225');
    assert.ok(Number.isFinite(r44.scale));
    assert.notEqual(r44.scale, -1.5);
    assert.notEqual(out.config.stops[1].walkScale, -0.5);
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test('config page: reset learned and clear samples', { skip }, async () => {
  const page = await load(params());
  try {
    await page.eval(`document.getElementById('reset-learned').click()`);
    await page.eval(`document.getElementById('clear-samples').click()`);
    assert.equal(await page.eval(`document.getElementById('sample-count').textContent.trim()`), '0');
    const out = await saved(page);
    assert.equal(out.learned, null);
    assert.equal(out.clearSamples, true);
  } finally { await page.close(); }
});

const dests = [
  { id: 'work', name: 'Work', lat: 44.97, lon: -93.26, address: '', arriveBy: '08:45', days: [1, 2, 3, 4, 5], enabled: true },
  { id: 'gym', name: 'Gym', lat: 44.95, lon: -93.29, address: '', arriveBy: '18:00', days: [], enabled: false },
];
const destParams = (extra) => Object.assign({ config: { version: 2, providers: [{ id: 'mock', type: 'mock' }],
  location: { mode: 'fixed', lat: 44.96, lon: -93.27 },
  routes: [{ providerId: 'mock', id: 'R1', name: 'One' }], destinations: dests,
  schedule: { leadMinutes: 20, walkSpeed: 1.1, maxWalk: 600, transferWalk: 150, maxTransfers: 0, minTransfer: 90, leaveReminder: false, fallbackMinutes: 45 } },
  samples: [], learned: {}, prefs: METRIC, return_to: 'http://return.test/close?' }, extra);

test('config page: destinations and schedule are shown and saved unchanged', { skip }, async () => {
  const page = await load(destParams());
  try {
    assert.deepEqual(page.errors, []);
    const rows = `document.querySelectorAll('#destinations .destination-row')`;
    assert.equal(await page.eval(`${rows}.length`), 2);
    const first = `${rows}[0]`;
    assert.equal(await page.eval(`${first}.querySelector('input[name=name]').value`), 'Work');
    assert.equal(await page.eval(`${first}.querySelector('input[name=id]').type`), 'hidden');
    assert.equal(await page.eval(`${first}.querySelector('input[name=arriveBy]').type`), 'time');
    assert.equal(await page.eval(`${first}.querySelector('input[name=arriveBy]').value`), '08:45');
    assert.deepEqual(await page.eval(`[...${first}.querySelectorAll('input[name=day]')].map(b => b.value)`), ['0', '1', '2', '3', '4', '5', '6']);
    assert.deepEqual(await page.eval(`[...${first}.querySelectorAll('input[name=day]')].filter(b => b.checked).map(b => +b.value)`), [1, 2, 3, 4, 5]);
    assert.equal(await page.eval(`${rows}[1].querySelector('input[name=enabled]').checked`), false);
    for (const sel of ['.pick-stop', '.here', '.remove', '.plan-summary']) assert.ok(await page.eval(`!!${first}.querySelector('${sel}')`), sel);
    assert.equal(await page.eval(`document.querySelector('[data-field="schedule.leadMinutes"]').value`), '20');
    assert.equal(await page.eval(`document.querySelector('[data-field="schedule.maxWalk"]').value`), '600');
    assert.equal(await page.eval(`document.querySelector('[data-field="schedule.walkSpeed"]').value`), '4', '1.1 m/s in km/h');
    const out = await saved(page);
    assert.deepEqual(out.config, settingsMod.normalize(destParams().config));
    assert.deepEqual(out.config.destinations, dests);
  } finally { await page.close(); }
});

test('config page: editing destinations, days and schedule fields', { skip }, async () => {
  const page = await load(destParams());
  try {
    await page.eval(`(() => {
      const rows = document.querySelectorAll('#destinations .destination-row');
      rows[0].querySelector('input[name=day][value="3"]').click();          // Wed off
      rows[0].querySelector('input[name=day][value="6"]').click();          // Sat on
      rows[1].querySelector('input[name=enabled]').click();
      rows[1].querySelector('input[name=arriveBy]').value = '07:05';
      document.getElementById('add-destination').click();
      const r = [...document.querySelectorAll('#destinations .destination-row')].pop();
      r.querySelector('input[name=name]').value = 'School';
      r.querySelector('input[name=lat]').value = '44.9';
      r.querySelector('input[name=lon]').value = '-93.1';
      r.querySelector('input[name=arriveBy]').value = '10:30';
      r.querySelector('input[name=day][value="0"]').click();
    })()`);
    await page.eval(set(`document.querySelector('[data-field="schedule.maxWalk"]')`, '9999'));
    await page.eval(`document.querySelector('input[data-field="schedule.leaveReminder"]').click()`);
    const out = await saved(page);
    assert.deepEqual(out.config.destinations, [
      { id: 'work', name: 'Work', lat: 44.97, lon: -93.26, address: '', arriveBy: '08:45', days: [1, 2, 4, 5, 6], enabled: true },
      { id: 'gym', name: 'Gym', lat: 44.95, lon: -93.29, address: '', arriveBy: '07:05', days: [], enabled: true },
      { id: 'dest1', name: 'School', lat: 44.9, lon: -93.1, address: '', arriveBy: '10:30', days: [0], enabled: true }]);
    assert.equal(out.config.schedule.maxWalk, 5000, 'clamped');
    assert.equal(out.config.schedule.leaveReminder, true);
    assert.equal(out.config.schedule.leadMinutes, 20);
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test('config page: at most 8 destinations; remove re-enables adding', { skip }, async () => {
  const page = await load(destParams());
  try {
    const add = `document.getElementById('add-destination')`;
    for (let i = 0; i < 10; i++) await page.eval(`${add}.click()`);
    assert.equal(await page.eval(`document.querySelectorAll('#destinations .destination-row').length`), 8);
    assert.equal(await page.eval(`${add}.disabled`), true);
    await page.eval(`document.querySelector('#destinations .destination-row .remove').click()`);
    assert.equal(await page.eval(`${add}.disabled`), false);
    await page.eval(`fillForm(Object.assign(readForm(), {destinations: []}))`);
    assert.equal(await page.eval(`document.querySelectorAll('#destinations .destination-row').length`), 0);
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test("config page: plan summary from window.__params.plans, in the watch's clock style", { skip }, async () => {
  const leaveAt = Math.floor(new Date(2026, 10, 13, 8, 12).getTime() / 1000);
  const plans = { work: { occurrence: leaveAt + 1980, summary: 'Leave 08:12 · R1 at 08:16', plannedAt: leaveAt - 3600,
    plan: { leaveAt, arriveAt: leaveAt + 1800, arriveBy: leaveAt + 1980, estimated: false, legs: [] } } };
  const page = await load(destParams({ plans }));
  try {
    const rows = `document.querySelectorAll('#destinations .destination-row')`;
    const text = await page.eval(`${rows}[0].querySelector('.plan-summary').textContent`);
    assert.match(text, /Leave 08:12 · R1 at 08:16/);
    assert.equal(await page.eval(`${rows}[1].querySelector('.plan-summary').textContent`), '', 'no plan → nothing');
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
  const page12 = await load(destParams({ plans: { work: Object.assign({}, plans.work, { summary: 'R1 soon' }) }, prefs: IMPERIAL }));
  try {
    assert.match(await page12.eval(`document.querySelector('#destinations .plan-summary').textContent`), /leave 8:12 AM/);
  } finally { await page12.close(); }
});

test('config page (mock): a trip destination from a searched stop', { skip }, async () => {
  const page = await load(destParams());
  try {
    await page.eval(`showPage('trips')`);
    const row = `document.querySelectorAll('#destinations .destination-row')[1]`;
    await page.eval(`${row}.querySelector('input[name=name]').value = ''`);
    await page.eval(`${row}.querySelector('.pick-stop').click()`);
    assert.equal(await page.eval(`document.getElementById('search').hidden`), false);
    await search(page, 'one stop 9');
    const res = await results(page);
    assert.deepEqual(res[0], ['mock', 'R1:s9', false]);
    assert.ok(res.every(r => !r[2]), 'no typed-id fallback for a destination');
    await page.eval(`document.querySelector('#search .result').click()`);
    assert.ok(await until(page, `${row}.querySelector('input[name=lat]').value !== '44.95'`));
    assert.equal(await page.eval(`${row}.querySelector('input[name=name]').value`), 'One stop 9');
    const out = await saved(page);
    assert.ok(Math.abs(out.config.destinations[1].lat - 44.96) < 0.01);
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test('config page (metrotransit): a newly added route starts with its official color; none → Auto, no error', { skip }, async () => {
  const page = await load(mtParams({ config: Object.assign({}, mtConfig, { routes: [] }) }), fetchStub());
  try {
    await page.eval(`showPage('routes'); document.getElementById('add-route').click()`);
    assert.ok(await until(page, `!/Indexing/.test(document.querySelector('#search .search-status').textContent)`));
    await search(page, '2');
    await page.eval(`document.querySelector('#search .result[data-id="2"]').click()`);
    const row = id => `[...document.querySelectorAll('#routes .route-row')].find(r => r.querySelector('input[name=id]').value === '${id}')`;
    assert.ok(await until(page, `${row('2')}.querySelector('input[name=color]').value === '#771473'`), 'official color loaded');
    assert.match(await page.eval(`${row('2')}.querySelector('.c-color .status').textContent`), /Official color/);
    // route 901 has no route details in the recorded API: it stays Auto, quietly
    await page.eval(`document.getElementById('add-route').click()`);
    await search(page, 'blue');
    await page.eval(`document.querySelector('#search .result[data-id="901"]').click()`);
    assert.ok(await until(page, `${row('901')}.querySelector('.c-color .status').textContent === ''`));
    assert.equal(await page.eval(`${row('901')}.querySelector('input[name=color]').value`), '');
    const out = await saved(page);
    assert.deepEqual(out.config.routes.map(r => [r.id, r.color]), [['2', '771473'], ['901', '']]);
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test('config page: routes, stops and trips reorder by dragging their handle (or arrow keys); the order is saved', { skip }, async () => {
  const cfg = Object.assign({}, destParams().config, {
    routes: ['A', 'B', 'C'].map(id => ({ providerId: 'mock', id, name: id })),
    stops: ['s1', 's2', 's3'].map(id => ({ providerId: 'mock', id, name: id })) });
  const page = await load(destParams({ config: cfg }));
  try {
    const ids = list => page.eval(`[...document.querySelectorAll('#${list} > .row')].map(r => r.querySelector('input[name=id]').value)`);
    // drag a row by its handle with pointer events (what touch produces), to just below another row's middle / above it
    const dragTo = (list, from, to, below) => page.eval(`(() => {
      const rows = [...document.querySelectorAll('#${list} > .row')];
      const h = rows[${from}].querySelector('.drag'), r = rows[${to}].getBoundingClientRect();
      const y = ${below} ? r.bottom - 2 : r.top + 2, opts = { bubbles: true, cancelable: true, pointerId: 7, clientX: 10 };
      h.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ clientY: h.getBoundingClientRect().top }, opts)));
      if (!rows[${from}].classList.contains('dragging')) throw new Error('not dragging');
      document.dispatchEvent(new PointerEvent('pointermove', Object.assign({ clientY: y }, opts)));
      document.dispatchEvent(new PointerEvent('pointerup', Object.assign({ clientY: y }, opts)));
      return rows[${from}].classList.contains('dragging');
    })()`);
    await page.eval(`showPage('routes')`);
    assert.equal(await dragTo('routes', 0, 2, true), false, 'drag ends on pointerup');
    assert.deepEqual(await ids('routes'), ['B', 'C', 'A']);
    await dragTo('routes', 2, 0, false);
    assert.deepEqual(await ids('routes'), ['A', 'B', 'C']);
    await page.eval(`showPage('stops')`);
    await dragTo('stops', 2, 0, false);
    assert.deepEqual(await ids('stops'), ['s3', 's1', 's2']);
    await page.eval(`showPage('trips')`);
    await page.eval(`document.querySelectorAll('#destinations > .row')[0].querySelector('.drag')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))`);
    assert.deepEqual(await ids('destinations'), ['gym', 'work']);
    const out = await saved(page);
    assert.deepEqual(out.config.routes.map(r => r.id), ['A', 'B', 'C']);
    assert.deepEqual(out.config.stops.map(s => s.id), ['s3', 's1', 's2']);
    assert.deepEqual(out.config.destinations.map(d => d.id), ['gym', 'work']);
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test('config page (mock): adding a stop does not offer the stops already saved; a trip destination still can', { skip }, async () => {
  const cfg = Object.assign({}, destParams().config, { stops: [{ providerId: 'mock', id: 'R1:s9', name: 'Home' }] });
  const page = await load(destParams({ config: cfg }));
  try {
    await page.eval(`showPage('stops'); document.getElementById('add-stop').click()`);
    await search(page, 'one stop 9');
    const res = await results(page);
    assert.ok(res.length > 0 && !res.some(r => r[1] === 'R1:s9'), JSON.stringify(res));
    await search(page, 'R1:s9');
    assert.ok(!(await results(page)).some(r => r[1] === 'R1:s9'), 'not as a typed id either');
    await page.eval(`document.querySelector('#search .search-cancel').click(); showPage('trips')`);
    await page.eval(`document.querySelector('#destinations .row .pick-stop').click()`);
    await search(page, 'one stop 9');
    assert.deepEqual((await results(page))[0], ['mock', 'R1:s9', false]);
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test('config page: walking speed lives on the Nearby & timing page (also used for trip plans)', { skip }, async () => {
  const page = await load(destParams());
  try {
    assert.equal(await page.eval(`document.querySelectorAll('[data-field="schedule.walkSpeed"]').length`), 1);
    assert.equal(await page.eval(`document.querySelector('[data-field="schedule.walkSpeed"]').closest('.page').getAttribute('data-page')`), 'nearby');
    await page.eval(set(`document.querySelector('[data-field="schedule.walkSpeed"]')`, '5.4'));
    assert.ok(Math.abs((await saved(page)).config.schedule.walkSpeed - 1.5) < 1e-9, '5.4 km/h = 1.5 m/s');
  } finally { await page.close(); }
});

test('config page: watch display switches for the walking time, the direction arrow and the weather', { skip }, async () => {
  const page = await load(destParams());
  try {
    for (const f of ['showWalk', 'showArrow']) {
      assert.equal(await page.eval(`document.querySelector('[data-field="${f}"]').type`), 'checkbox');
      assert.equal(await page.eval(`document.querySelector('[data-field="${f}"]').checked`), true, f + ' on by default');
      assert.equal(await page.eval(`document.querySelector('[data-field="${f}"]').closest('.page').getAttribute('data-page')`), 'nearby');
    }
    const w = `document.querySelector('[data-field="showWeather"]')`;
    assert.equal(await page.eval(`${w}.type`), 'checkbox');
    assert.equal(await page.eval(`${w}.checked`), false, 'showWeather off by default');
    assert.equal(await page.eval(`${w}.closest('.page').getAttribute('data-page')`), 'nearby');
    await page.eval(`document.querySelector('[data-field="showArrow"]').click()`);
    await page.eval(`${w}.click()`);
    const out = await saved(page);
    assert.equal(out.config.showWalk, true);
    assert.equal(out.config.showArrow, false);
    assert.equal(out.config.showWeather, true);
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test('config page: a new system covers its home city; systems that need a key say where to get one', { skip }, async () => {
  const page = await load(destParams({ prefs: METRIC }));
  try {
    await page.eval(`showPage('systems'); document.getElementById('add-provider').click()`);
    const row = `[...document.querySelectorAll('#providers .provider-row')].pop()`;
    await page.eval(set(`${row}.querySelector('select[name=type]')`, 'wmata'));
    assert.equal(await page.eval(`${row}.querySelector('input[name=id]').value`), 'wmata');
    assert.equal(await page.eval(`${row}.querySelector('.coverage-summary').textContent`),
      'Used within about 60 km of 38.9072, -77.0369 (its home area, until you save stops).');
    assert.equal(await page.eval(`${row}.querySelector('.key-hint').textContent`), 'Needs a free API key: https://developer.wmata.com.');
    assert.equal(await page.eval(`${row}.querySelector('.key-hint').classList.contains('warn')`), true);
    await page.eval(set(`${row}.querySelector('input[name=apiKey]')`, 'k123'));
    assert.equal(await page.eval(`${row}.querySelector('.key-hint').textContent`), '', 'hint gone once a key is set');
    await page.eval(set(`${row}.querySelector('select[name=type]')`, 'bvg'));
    assert.match(await page.eval(`${row}.querySelector('.coverage-summary').textContent`), /of 52\.52, 13\.405/);
    assert.equal(await page.eval(`${row}.querySelector('.key-hint').textContent`), 'Optional: blank = the default.');
    const out = await saved(page);
    const p = out.config.providers.pop();
    assert.deepEqual([p.id, p.type, p.coverage], ['bvg', 'bvg', { mode: 'auto', lat: 52.52, lon: 13.405, radius: 60000 }]);
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

// the geocoder (photon.komoot.io) with recorded responses
function geoStub() {
  const fx = n => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));
  const search = fx('geocode-search-dc.json'), reverse = fx('geocode-reverse-mpls.json');
  return `<script>window.__fetched = []; window.fetch = function (url) {
    window.__fetched.push(String(url));
    var u = String(url), body = u.indexOf('https://photon.komoot.io/api/') === 0 ? ${JSON.stringify(search)}
      : u.indexOf('https://photon.komoot.io/reverse') === 0 ? ${JSON.stringify(reverse)} : null;
    if (!body) return Promise.reject(new TypeError('offline'));
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
  };</script>`;
}

test('config page: a trip address is looked up (pick from the matches); the place names a blank trip', { skip }, async () => {
  const page = await load(destParams(), geoStub());
  try {
    await page.eval(`showPage('trips'); document.getElementById('add-destination').click()`);
    const row = `[...document.querySelectorAll('#destinations .destination-row')].pop()`;
    await page.eval(`${row}.querySelector('input[name=address]').value = '1600 Pennsylvania Ave'`);
    await page.eval(`${row}.querySelector('.find-address').click()`);
    assert.ok(await until(page, `${row}.querySelectorAll('.address-results .result').length === 2`), 'matches listed');
    // looked up near the trip's area (the fixed location)
    assert.match(await page.eval(`window.__fetched[0]`), /^https:\/\/photon\.komoot\.io\/api\/\?q=1600%20Pennsylvania%20Ave&limit=5&lat=44\.96&lon=-93\.27$/);
    assert.match(await page.eval(`${row}.querySelector('.address-results .result').textContent`), /White House.*1600 Pennsylvania Avenue Northwest/);
    await page.eval(`${row}.querySelector('.address-results .result').click()`);
    assert.equal(await page.eval(`${row}.querySelectorAll('.address-results .result').length`), 0);
    assert.equal(await page.eval(`${row}.querySelector('input[name=name]').value`), 'White House', 'blank name → the place');
    assert.equal(await page.eval(`${row}.querySelector('input[name=address]').value`),
      'White House, 1600 Pennsylvania Avenue Northwest, Washington, DC');
    // typed coordinates on another blank trip: reverse geocoding names it
    await page.eval(`document.getElementById('add-destination').click()`);
    await page.eval(set(`${row}.querySelector('input[name=lat]')`, '44.9778'));
    await page.eval(set(`${row}.querySelector('input[name=lon]')`, '-93.265'));
    assert.ok(await until(page, `${row}.querySelector('input[name=name]').value === 'South 4th Street'`), 'named from the position');
    assert.equal(await page.eval(`${row}.querySelector('input[name=address]').value`), 'South 4th Street, Minneapolis, Minnesota');
    const out = await saved(page);
    const [white, street] = out.config.destinations.slice(-2);
    assert.deepEqual([white.name, white.lat, white.lon, white.address],
      ['White House', 38.897639, -77.036552, 'White House, 1600 Pennsylvania Avenue Northwest, Washington, DC']);
    assert.deepEqual([street.name, street.lat, street.lon], ['South 4th Street', 44.9778, -93.265]);
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test('config page: a name the user typed is kept; lookup failures show in the row; last-bus transfer safety is saved', { skip }, async () => {
  const page = await load(destParams(), geoStub());
  try {
    await page.eval(`showPage('trips')`);
    const row = `document.querySelectorAll('#destinations .destination-row')[0]`;   // "Work"
    await page.eval(`${row}.querySelector('input[name=address]').value = 'anything'`);
    await page.eval(`${row}.querySelector('.find-address').click()`);
    assert.ok(await until(page, `${row}.querySelectorAll('.address-results .result').length === 2`));
    await page.eval(`${row}.querySelectorAll('.address-results .result')[1].click()`);
    assert.equal(await page.eval(`${row}.querySelector('input[name=name]').value`), 'Work', 'kept');
    assert.equal(await page.eval(`${row}.querySelector('input[name=lat]').value`), '38.879226');
    await page.eval(`${row}.querySelector('input[name=address]').value = ''; ${row}.querySelector('.find-address').click()`);
    assert.equal(await page.eval(`${row}.querySelector('.line .status').textContent`), 'Type an address first.');
    await page.eval(`window.fetch = function () { return Promise.reject(new TypeError('offline')); }`);
    await page.eval(`${row}.querySelector('input[name=address]').value = 'x'; ${row}.querySelector('.find-address').click()`);
    assert.ok(await until(page, `/Couldn't look up the address/.test(${row}.querySelector('.line .status').textContent)`));
    assert.equal(await page.eval(`document.querySelector('[data-field="schedule.lastTransfer"]').value`), '600');
    await page.eval(set(`document.querySelector('[data-field="schedule.lastTransfer"]')`, '900'));
    const out = await saved(page);
    assert.equal(out.config.schedule.lastTransfer, 900);
    assert.equal(out.config.destinations[0].address, 'x');
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});
