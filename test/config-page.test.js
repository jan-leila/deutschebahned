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

const config = {
  provider: { type: 'onebusaway', baseUrl: 'https://oba.example/api/where', apiKey: 'abc' },
  location: { mode: 'gps', lat: 0, lon: 0 },
  stopRadius: 250, routeRadius: 60, recentWindow: 240, lookahead: 45, maxItems: 8,
  routes: [{ id: '1_100225', name: '44', scale: -1.5 }, { id: '1_100223', name: '43', scale: -1 }],
  connections: [{ routeId: '1_100225', stopId: '1_29247', name: 'Home', scale: -2 }],
  stopScales: { '1_10914': -0.5 },
  training: { autoTrain: true, learningRate: 0.05, iterations: 100, temperature: 60, regularization: 0.01, maxSamples: 200 },
};
// two picks: the user always prefers the sooner bus even when it is farther away
const samples = [
  { t: 1, lat: 0, lon: 0, chosen: 1, candidates: [
    { key: 'a', features: { 'stop:1_10914': 50, 'route:1_100223': 900 } },
    { key: 'b', features: { 'stop:X': 300, 'route:1_100225': 60 } }] },
  { t: 2, lat: 0, lon: 0, chosen: 0, candidates: [
    { key: 'c', features: { 'stop:X': 280, 'route:1_100225': 30 } },
    { key: 'd', features: { 'stop:1_10914': 20, 'route:1_100223': 1200 } }] },
];
const learned = { 'stop:1_10914': -0.25 };

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

const params = () => ({ config, samples, learned, return_to: 'http://return.test/close?' });

test('config page: shows injected settings and saves them unchanged', { skip }, async () => {
  const page = await load(params());
  try {
    assert.deepEqual(page.errors, []);
    assert.equal(await page.eval(`document.querySelector('[data-field="stopRadius"]').value`), '250');
    assert.equal(await page.eval(`document.querySelector('[data-field="provider.baseUrl"]').value`), 'https://oba.example/api/where');
    assert.equal(await page.eval(`document.querySelector('[data-field="training.autoTrain"]').checked`), true);
    assert.equal(await page.eval(`document.querySelectorAll('#routes .route-row').length`), 2);
    assert.equal(await page.eval(`document.querySelector('#routes .route-row input[name=name]').value`), '44');
    assert.equal(await page.eval(`document.querySelectorAll('#connections .connection-row').length`), 1);
    assert.equal(await page.eval(`document.querySelectorAll('#stop-scales .stop-scale-row').length`), 1);
    assert.equal(await page.eval(`document.getElementById('sample-count').textContent.trim()`), '2');
    assert.match(await page.eval(`document.getElementById('learned').textContent`), /1_10914/);
    const out = await saved(page);
    const settings = require('../src/common/settings');
    assert.deepEqual(out.config, settings.normalize(config));
    assert.equal('learned' in out, false, 'learned untouched -> not sent');
    assert.equal('clearSamples' in out, false);
  } finally { await page.close(); }
});

test('config page: editing fields and lists', { skip }, async () => {
  const page = await load(params());
  try {
    await page.eval(`(() => {
      const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); };
      set('[data-field="stopRadius"]', '400');
      set('[data-field="provider.apiKey"]', 'newkey');
      const mode = document.querySelector('[data-field="location.mode"]'); mode.value = 'fixed'; mode.dispatchEvent(new Event('change', {bubbles: true}));
      set('[data-field="location.lat"]', '47.6');
      set('[data-field="location.lon"]', '-122.3');
      document.querySelector('[data-field="training.autoTrain"]').click();
      document.querySelector('#routes .route-row .remove').click();            // drop route 44
      document.getElementById('add-route').click();
      const rows = document.querySelectorAll('#routes .route-row');
      const last = rows[rows.length - 1];
      last.querySelector('input[name=id]').value = '1_102574';
      last.querySelector('input[name=name]').value = 'E';
      last.querySelector('input[name=scale]').value = '-0.8';
      last.querySelector('input[name=color]').value = '#00aa55';
      document.getElementById('add-connection').click();
      const c = [...document.querySelectorAll('#connections .connection-row')].pop();
      c.querySelector('input[name=routeId]').value = '1_102574';
      c.querySelector('input[name=stopId]').value = '1_578';
      c.querySelector('input[name=name]').value = 'Work';
      document.getElementById('add-stop-scale').click();
      const s = [...document.querySelectorAll('#stop-scales .stop-scale-row')].pop();
      s.querySelector('input[name=stopId]').value = '1_999';
      s.querySelector('input[name=scale]').value = '-3';
    })()`);
    const rf = await page.eval('JSON.stringify(readForm())');
    const out = await saved(page);
    assert.deepEqual(out.config, JSON.parse(rf));
    assert.equal(out.config.stopRadius, 400);
    assert.equal(out.config.provider.apiKey, 'newkey');
    assert.deepEqual(out.config.location, { mode: 'fixed', lat: 47.6, lon: -122.3 });
    assert.equal(out.config.training.autoTrain, false);
    assert.deepEqual(out.config.routes, [{ id: '1_100223', name: '43', scale: -1, color: '' }, { id: '1_102574', name: 'E', scale: -0.8, color: '00AA55' }]);
    assert.deepEqual(out.config.connections.map(c => c.id), ['1_100225|1_29247', '1_102574|1_578']);
    assert.equal(out.config.connections[1].scale, -1);
    assert.deepEqual(out.config.stopScales, { '1_10914': -0.5, '1_999': -3 });
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test('config page: train now, then bake learned weights into the form', { skip }, async () => {
  const page = await load(params());
  try {
    await page.eval(`document.getElementById('train-now').click()`);
    await new Promise(r => setTimeout(r, 300));
    assert.match(await page.eval(`document.getElementById('train-result').textContent`), /\d/);
    assert.match(await page.eval(`document.getElementById('learned').textContent`), /route:1_100225/);
    await page.eval(`document.getElementById('bake-learned').click()`);
    const out = await saved(page);
    assert.equal(out.learned, null, 'after baking, learned weights are reset');
    // baked: the route that was picked became relatively more important than the prior -1.5 / -1 suggested
    const r44 = out.config.routes.find(r => r.id === '1_100225');
    assert.ok(Number.isFinite(r44.scale));
    assert.notEqual(r44.scale, -1.5);
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

test('config page: works with no injected params (defaults)', { skip }, async () => {
  const page = await load({ return_to: 'http://return.test/close?' });
  try {
    assert.deepEqual(page.errors, []);
    const out = await saved(page);
    assert.deepEqual(out.config, require('../src/common/settings').defaults());
  } finally { await page.close(); }
});

// Metro Transit helpers: the page talks to svc.metrotransit.org directly (CORS is open). Here fetch is stubbed
// with recorded responses so the test runs offline.
function fetchStub() {
  const fx = n => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));
  const table = {
    '/nextrip/routes': fx('mt-nextrip-routes.json'),
    '/schedule/routes': fx('mt-schedule-routes.json'),
    '/schedule/routedetails/2': fx('mt-routedetails-2.json'),
    '/schedule/stoplist/2/1': fx('mt-stoplist-2-1.json'),
    '/schedule/stoplist/2/2': fx('mt-stoplist-2-2.json'),
    '/nextrip/16058': fx('mt-nextrip-stop-16058.json'),
  };
  return `<script>window.__fetched = []; window.fetch = function (url) {
    window.__fetched.push(String(url));
    var table = ${JSON.stringify(table).replace(/</g, '\\u003c')};
    var p = String(url).replace('https://svc.metrotransit.org', '');
    var body = table[p];
    return Promise.resolve({ ok: !!body, status: body ? 200 : 400, json: function () { return Promise.resolve(body || { status: 400, detail: 'Invalid' }); } });
  };</script>`;
}
const mtParams = () => ({ config: { provider: { type: 'metrotransit' }, routes: [{ id: '2' }],
  connections: [] }, samples: [], learned: {}, return_to: 'http://return.test/close?' });
const until = async (page, expr, ms = 3000) => {
  for (let t = 0; t < ms; t += 50) { if (await page.eval(expr)) return true; await new Promise(r => setTimeout(r, 50)); }
  return false;
};

test('config page (metrotransit): route list offered for route ids', { skip }, async () => {
  const page = await load(mtParams(), fetchStub());
  try {
    assert.ok(await until(page, `document.querySelectorAll('#route-options option').length === 3`), 'datalist filled');
    assert.ok(await page.eval(`window.__fetched.includes('https://svc.metrotransit.org/nextrip/routes')`));
    assert.equal(await page.eval(`document.querySelector('#routes .route-row input[name=id]').getAttribute('list')`), 'route-options');
    assert.equal(await page.eval(`document.querySelector('#route-options option[value="922"]').textContent.trim() || document.querySelector('#route-options option[value="922"]').label`), 'METRO B Line');
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test('config page (metrotransit): load the official route color', { skip }, async () => {
  const page = await load(mtParams(), fetchStub());
  try {
    await page.eval(`document.querySelector('#routes .route-row .load-color').click()`);
    assert.ok(await until(page, `document.querySelector('#routes .route-row input[name=color]').value.replace('#','').toUpperCase() === '771473'`));
    const out = await saved(page);
    assert.equal(out.config.routes[0].color, '771473');
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test('config page (metrotransit): pick a pinned stop from the route stop list', { skip }, async () => {
  const page = await load(mtParams(), fetchStub());
  try {
    await page.eval(`(() => { document.getElementById('add-connection').click();
      const r = document.querySelector('#connections .connection-row'); r.querySelector('input[name=routeId]').value = '2';
      r.querySelector('.pick-stop').click(); })()`);
    assert.ok(await until(page, `document.querySelectorAll('#stop-picker select[name=direction] option').length === 2`), 'directions');
    await page.eval(`(() => { const d = document.querySelector('#stop-picker select[name=direction]'); d.value = '1'; d.dispatchEvent(new Event('change', {bubbles: true})); })()`);
    assert.ok(await until(page, `[...document.querySelectorAll('#stop-picker select[name=stop] option')].some(o => o.value === '16058')`), 'westbound stops listed');
    await page.eval(`(() => { const s = document.querySelector('#stop-picker select[name=stop]'); s.value = '16058'; s.dispatchEvent(new Event('change', {bubbles: true})); document.querySelector('#stop-picker .use').click(); })()`);
    const row = `document.querySelector('#connections .connection-row')`;
    assert.equal(await page.eval(`${row}.querySelector('input[name=stopId]').value`), '16058');
    assert.equal(await page.eval(`${row}.querySelector('input[name=name]').value`), '8th St SE & 5th Ave SE');
    const out = await saved(page);
    assert.deepEqual(out.config.connections.map(c => c.id), ['2|16058']);
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test('config page (metrotransit): offline API does not break the page', { skip }, async () => {
  const page = await load(mtParams(), '<script>window.fetch = function () { return Promise.reject(new Error("offline")); };</script>');
  try {
    await new Promise(r => setTimeout(r, 300));
    await page.eval(`document.querySelector('#routes .route-row .load-color').click()`);
    await new Promise(r => setTimeout(r, 300));
    assert.deepEqual(page.errors, []);
    const out = await saved(page);
    assert.equal(out.config.routes[0].id, '2');
  } finally { await page.close(); }
});

// ---------------------------------------------------------------- sources, destinations, schedule, display (§10)
const settingsMod = require('../src/common/settings');
const set = (sel, v) => `(() => { const el = ${sel}; el.value = ${JSON.stringify(v)};
  el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); })()`;

test('config page: provider select lists the registered sources; default and unknown types are kept', { skip }, async () => {
  const types = require('../src/sources/registry').createRegistry(require('../src/sources/all')).types();
  let page = await load({ return_to: 'http://return.test/close?' });
  try {
    const opts = await page.eval(`[...document.querySelectorAll('select[data-field="provider.type"] option')].map(o => ({type: o.value, label: o.textContent}))`);
    assert.deepEqual(opts, types);
    assert.equal(await page.eval(`document.querySelector('select[data-field="provider.type"]').value`), 'metrotransit', "'' shows as the default source");
    assert.equal((await saved(page)).config.provider.type, '', "untouched '' stays ''");
  } finally { await page.close(); }
  page = await load({ config: { provider: { type: 'someday' } }, return_to: 'http://return.test/close?' });
  try {
    assert.equal(await page.eval(`readForm().provider.type`), 'someday', 'unknown (future) source id kept');
    await page.eval(set(`document.querySelector('select[data-field="provider.type"]')`, 'mock'));
    assert.equal((await saved(page)).config.provider.type, 'mock');
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

const dests = [
  { id: 'work', name: 'Work', lat: 44.97, lon: -93.26, arriveBy: '08:45', days: [1, 2, 3, 4, 5], enabled: true },
  { id: 'gym', name: 'Gym', lat: 44.95, lon: -93.29, arriveBy: '18:00', days: [], enabled: false },
];
const destParams = (extra) => Object.assign({ config: { provider: { type: 'mock' }, location: { mode: 'fixed', lat: 44.96, lon: -93.27 },
  routes: [{ id: 'R1', name: 'One' }], destinations: dests, units: 'metric', clock24: true,
  schedule: { leadMinutes: 20, walkSpeed: 1.1, maxWalk: 600, transferWalk: 150, maxTransfers: 0, minTransfer: 90, leaveReminder: false, fallbackMinutes: 45 } },
  samples: [], learned: {}, return_to: 'http://return.test/close?' }, extra);

test('config page: destinations, schedule, units and clock24 are shown and saved unchanged', { skip }, async () => {
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
    assert.equal(await page.eval(`[...${rows}[1].querySelectorAll('input[name=day]')].some(b => b.checked)`), false);
    for (const sel of ['.pick-stop', '.here', '.remove', '.plan-summary']) assert.ok(await page.eval(`!!${first}.querySelector('${sel}')`), sel);
    assert.equal(await page.eval(`document.querySelector('select[data-field="units"]').value`), 'metric');
    assert.equal(await page.eval(`document.querySelector('input[data-field="clock24"]').checked`), true);
    assert.equal(await page.eval(`document.querySelector('[data-field="schedule.leadMinutes"]').value`), '20');
    assert.equal(await page.eval(`document.querySelector('input[data-field="schedule.leaveReminder"]').type`), 'checkbox');
    const out = await saved(page);
    const expected = settingsMod.normalize(destParams().config);
    assert.deepEqual(out.config, expected);
    assert.deepEqual(out.config.destinations, dests);
    // fillForm(readForm()) is a fixed point
    assert.deepEqual(await page.eval(`(() => { const c = readForm(); fillForm(c); return readForm(); })()`), expected);
  } finally { await page.close(); }
});

test('config page: editing destinations, days, schedule and display fields', { skip }, async () => {
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
    await page.eval(set(`document.querySelector('select[data-field="units"]')`, 'imperial'));
    await page.eval(`document.querySelector('input[data-field="clock24"]').click()`);
    await page.eval(set(`document.querySelector('[data-field="schedule.maxWalk"]')`, '9999'));
    await page.eval(`document.querySelector('input[data-field="schedule.leaveReminder"]').click()`);
    const out = await saved(page);
    assert.deepEqual(out.config.destinations, [
      { id: 'work', name: 'Work', lat: 44.97, lon: -93.26, arriveBy: '08:45', days: [1, 2, 4, 5, 6], enabled: true },
      { id: 'gym', name: 'Gym', lat: 44.95, lon: -93.29, arriveBy: '07:05', days: [], enabled: true },
      { id: 'dest1', name: 'School', lat: 44.9, lon: -93.1, arriveBy: '10:30', days: [0], enabled: true }]);
    assert.equal(out.config.units, 'imperial');
    assert.equal(out.config.clock24, false);
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

test('config page: plan summary from window.__params.plans', { skip }, async () => {
  const leaveAt = Math.floor(new Date(2026, 10, 13, 8, 12).getTime() / 1000);
  const plans = { work: { occurrence: leaveAt + 1980, summary: 'Leave 08:12 · R1 at 08:16', plannedAt: leaveAt - 3600,
    plan: { leaveAt, arriveAt: leaveAt + 1800, arriveBy: leaveAt + 1980, estimated: false, legs: [] } } };
  const page = await load(destParams({ plans }));
  try {
    const rows = `document.querySelectorAll('#destinations .destination-row')`;
    const text = await page.eval(`${rows}[0].querySelector('.plan-summary').textContent`);
    assert.match(text, /Leave 08:12 · R1 at 08:16/);
    assert.match(text, /08:12/, 'leave time (24 h as configured)');
    assert.equal(await page.eval(`${rows}[1].querySelector('.plan-summary').textContent`), '', 'no plan → nothing');
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test('config page (metrotransit): destination coordinates from a picked stop via stopInfo', { skip }, async () => {
  const page = await load(mtParams(), fetchStub());
  try {
    await page.eval(`document.getElementById('add-destination').click()`); // new row: empty name, arrive by 09:00
    const row = `document.querySelector('#destinations .destination-row')`;
    assert.ok(await until(page, `document.body.className.includes('has-stopInfo')`));
    assert.equal(await page.eval(`getComputedStyle(${row}.querySelector('.pick-stop')).display !== 'none'`), true);
    await page.eval(`${row}.querySelector('.pick-stop').click()`);
    assert.equal(await page.eval(`document.querySelector('#stop-picker select[name=route]').value`), '2', 'configured route first');
    assert.ok(await until(page, `document.querySelectorAll('#stop-picker select[name=direction] option').length === 2`), 'directions');
    await page.eval(set(`document.querySelector('#stop-picker select[name=direction]')`, '1'));
    await page.eval(set(`document.querySelector('#stop-picker select[name=stop]')`, '16058'));
    await page.eval(`document.querySelector('#stop-picker .use').click()`);
    assert.ok(await until(page, `${row}.querySelector('input[name=lat]').value === '44.989411'`), 'lat filled');
    assert.equal(await page.eval(`${row}.querySelector('input[name=lon]').value`), '-93.245348');
    assert.equal(await page.eval(`${row}.querySelector('input[name=name]').value`), '8th St SE & 5th Ave SE', 'empty name filled');
    assert.equal(await page.eval(`document.getElementById('stop-picker').hidden`), true);
    assert.ok(await page.eval(`window.__fetched.includes('https://svc.metrotransit.org/nextrip/16058')`));
    const out = await saved(page);
    assert.deepEqual(out.config.destinations[0], { id: 'dest1', name: '8th St SE & 5th Ave SE', lat: 44.989411, lon: -93.245348,
      arriveBy: '09:00', days: [], enabled: true });
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test('config page (mock): catalog helpers work offline from the generated network; a set name is kept', { skip }, async () => {
  const { createMock } = require('../src/sources/mock/index');
  const cfg = settingsMod.normalize(destParams().config);
  const stop = await new Promise((res, rej) => createMock({ location: cfg.location, routes: cfg.routes }, () => 0)
    .stopInfo('R1:s5', (e, v) => (e ? rej(e) : res(v))));
  const page = await load(destParams(), '<script>window.fetch = function () { throw new Error("no network in this test"); };</script>');
  try {
    assert.ok(await until(page, `document.querySelectorAll('#route-options option').length === 1`), 'mock listRoutes → datalist');
    assert.equal(await page.eval(`document.querySelector('#route-options option').value`), 'R1');
    const row = `document.querySelector('#destinations .destination-row')`;
    await page.eval(`${row}.querySelector('.pick-stop').click()`);
    assert.ok(await until(page, `document.querySelectorAll('#stop-picker select[name=stop] option').length === 16`));
    await page.eval(set(`document.querySelector('#stop-picker select[name=stop]')`, 'R1:s5'));
    await page.eval(`document.querySelector('#stop-picker .use').click()`);
    assert.ok(await until(page, `${row}.querySelector('input[name=lat]').value === ${JSON.stringify(String(Math.round(stop.lat * 1e6) / 1e6))}`));
    assert.equal(await page.eval(`${row}.querySelector('input[name=name]').value`), 'Work', 'existing name kept');
    // the route color helper uses routeInfo too
    await page.eval(`document.querySelector('#routes .route-row .load-color').click()`);
    assert.ok(await until(page, `document.querySelector('#routes .route-row input[name=color]').value === '#e53935'`));
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test('config page (onebusaway): no route list helper without listRoutes', { skip }, async () => {
  const page = await load(params(), '<script>window.__fetched = []; window.fetch = function (u) { window.__fetched.push(String(u)); return Promise.reject(new Error("offline")); };</script>');
  try {
    await new Promise(r => setTimeout(r, 200));
    const cls = await page.eval(`document.body.className`);
    assert.ok(!cls.includes('has-listRoutes'), cls);
    assert.ok(cls.includes('has-routeInfo') && cls.includes('has-stopInfo'), cls);
    assert.equal(await page.eval(`document.querySelectorAll('#route-options option').length`), 0);
    assert.deepEqual(await page.eval(`window.__fetched`), [], 'nothing fetched on load');
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});
