#!/usr/bin/env node
// Visual regression screenshots of the settings page (config/config-page.html, bundled as src/pkjs/config-page.js)
// in headless Chromium. Same approach as binary-watch's tools/settings-screenshots.js.
//
//   node tools/settings-screenshots.js [--update] [--threshold F] [--only REGEX] [scheme...]
//                                                        # default colour schemes: light dark
//
// Rebuilds src/pkjs/config-page.js (tools/build-config.js), then for every colour scheme x SCENE loads the page with
// the same injected window.__params src/pkjs/index.js passes (config, samples, learned, plans, return_to), runs the
// scene's page action, and saves a full-page screenshot at phone width to
// test/settings-screenshots/current/<scheme>/<scene>.png (with --update: .../baseline/).
// Without --update the images are compared with the baseline (tools/lib/png-diff.js): diff images go to
// test/settings-screenshots/diff/, a table is printed, and the exit status is non-zero when any image differs by more
// than F (fraction of pixels, default 0.001) or is missing. Page script errors also fail the run.
//
// The page looks the same on every watch platform, so unlike binary-watch the variants are the phone's colour
// schemes (the page follows prefers-color-scheme) instead of watch platforms.
//
// Determinism: Date is frozen at 2026-11-13 07:30:00 UTC before the page's scripts run (plan summaries format
// times), timezone and locale are pinned, the network is replaced by recorded Metro Transit responses from
// test/fixtures (any other request fails as if offline), and CSS transitions, animations and the text caret are off.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { openPage, findChrome } = require('../test/helpers/chrome');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'settings-screenshots');
const FIXED_NOW = Date.UTC(2026, 10, 13, 7, 30, 0);
const ALL_SCHEMES = ['light', 'dark'];
const RETURN_TO = 'http://return.test/close?';

// ------------------------------------------------------------------------------------------------ scene data
const fx = n => JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', n), 'utf8'));
// recorded Metro Transit API (the same files test/config-page.test.js and test/providers.test.js use)
const MT_TABLE = {
  '/nextrip/routes': fx('mt-nextrip-routes.json'),
  '/schedule/routes': fx('mt-schedule-routes.json'),
  '/schedule/routedetails/2': fx('mt-routedetails-2.json'),
  '/schedule/stoplist/2/1': fx('mt-stoplist-2-1.json'),
  '/schedule/stoplist/2/2': fx('mt-stoplist-2-2.json'),
  '/nextrip/16058': fx('mt-nextrip-stop-16058.json'),
};

const training = { autoTrain: true, learningRate: 0.05, iterations: 100, temperature: 60, regularization: 0.01, maxSamples: 200 };
const obaConfig = {
  provider: { type: 'onebusaway', baseUrl: 'https://oba.example/api/where', apiKey: 'abc' },
  location: { mode: 'gps', lat: 0, lon: 0 },
  stopRadius: 250, routeRadius: 60, recentWindow: 240, lookahead: 45, maxItems: 8,
  routes: [{ id: '1_100225', name: '44', scale: -1.5, color: '1E88E5' }, { id: '1_100223', name: '43', scale: -1 }],
  connections: [{ routeId: '1_100225', stopId: '1_29247', name: 'Home', scale: -2 }],
  stopScales: { '1_10914': -0.5 },
  training,
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
const mtConfig = {
  provider: { type: 'metrotransit' },
  routes: [{ id: '2', name: '2', scale: -1, color: '771473' }, { id: '922', name: 'B Line', scale: -0.8, color: 'ED1B2E' }],
  connections: [{ routeId: '2', stopId: '16058', name: '8th St SE & 5th Ave SE', scale: -1.5 }],
};
const tripConfig = {
  provider: { type: 'mock' }, location: { mode: 'fixed', lat: 44.96, lon: -93.27 },
  routes: [{ id: 'R1', name: 'One', color: 'E53935' }], units: 'imperial', clock24: false,
  destinations: [
    { id: 'work', name: 'Work', lat: 44.97, lon: -93.26, arriveBy: '08:45', days: [1, 2, 3, 4, 5], enabled: true },
    { id: 'gym', name: 'Gym', lat: 44.95, lon: -93.29, arriveBy: '18:00', days: [], enabled: false },
  ],
  schedule: { leadMinutes: 20, walkSpeed: 1.1, maxWalk: 600, transferWalk: 150, maxTransfers: 1, minTransfer: 90,
    leaveReminder: true, fallbackMinutes: 45 },
};
const leaveAt = Math.floor(Date.UTC(2026, 10, 13, 8, 12) / 1000);
const plans = { work: { occurrence: leaveAt + 1980, summary: 'Leave 8:12 AM · One at 8:16 AM', plannedAt: leaveAt - 3600,
  plan: { leaveAt, arriveAt: leaveAt + 1800, arriveBy: leaveAt + 1980, estimated: false, legs: [] } } };

// Waits until a page expression is truthy (helpers fetch asynchronously).
const until = (expr, ms = 3000) => `(async () => { for (let t = 0; t < ${ms}; t += 50) { if (${expr}) return true;
  await new Promise(r => setTimeout(r, 50)); } throw new Error('timed out waiting for: ' + ${JSON.stringify(expr)}); })()`;
const set = (sel, v) => `(() => { const el = ${sel}; el.value = ${JSON.stringify(v)};
  el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); })()`;

// name, window.__params (return_to is added), page actions run in order (each awaited)
const SCENES = [
  ['01-defaults', {}, [until(`document.querySelectorAll('#route-options option').length > 0`)]],
  ['02-saved-onebusaway', { config: obaConfig, samples, learned: { 'stop:1_10914': -0.25 } }, []],
  ['03-metrotransit', { config: mtConfig, samples: [], learned: {} },
    [until(`document.querySelectorAll('#route-options option').length > 0`)]],
  ['04-stop-picker', { config: mtConfig, samples: [], learned: {} }, [
    until(`document.querySelectorAll('#route-options option').length > 0`),
    `document.querySelector('#connections .connection-row .pick-stop').click()`,
    until(`document.querySelectorAll('#stop-picker select[name=direction] option').length === 2`),
    set(`document.querySelector('#stop-picker select[name=direction]')`, '1'),
    until(`[...document.querySelectorAll('#stop-picker select[name=stop] option')].some(o => o.value === '16058')`),
    set(`document.querySelector('#stop-picker select[name=stop]')`, '16058'),
  ]],
  ['05-trips', { config: tripConfig, samples: [], learned: {}, plans }, [
    until(`document.querySelectorAll('#route-options option').length === 1`),
    `document.querySelectorAll('#sec-destinations details, #sec-training details').forEach(d => { d.open = true; })`,
  ]],
  ['06-trained', { config: obaConfig, samples, learned: {} }, [
    `document.getElementById('train-now').click()`,
    until(`/\\d/.test(document.getElementById('train-result').textContent)`),
  ]],
  ['07-fixed-location', { config: Object.assign({}, obaConfig, { location: { mode: 'fixed', lat: 44.977753, lon: -93.265011 },
    units: 'imperial', clock24: false }), samples: [], learned: {} }, []],
];

// --------------------------------------------------------------------------------------------------- page setup
const FREEZE_DATE = `(() => {
  const RealDate = Date, NOW = ${FIXED_NOW};
  class FrozenDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(NOW); }
    static now() { return NOW; }
  }
  window.Date = FrozenDate;
})();`;
const STILL_CSS = '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }';
// recorded responses for svc.metrotransit.org; everything else fails like an offline phone
const FETCH_STUB = `<script>window.fetch = function (url) {
  var table = ${JSON.stringify(MT_TABLE).replace(/</g, '\\u003c')};
  var u = String(url);
  if (u.indexOf('https://svc.metrotransit.org') !== 0) return Promise.reject(new Error('offline (settings screenshots)'));
  var body = table[u.replace('https://svc.metrotransit.org', '')];
  return Promise.resolve({ ok: !!body, status: body ? 200 : 400,
    json: function () { return Promise.resolve(body || { status: 400, detail: 'Invalid' }); } });
};</script>`;

function pageHtml(params) {
  delete require.cache[require.resolve('../src/pkjs/config-page')];
  const page = require('../src/pkjs/config-page');
  // the same injection src/pkjs/index.js performs, plus the network stub
  const injected = '<script>window.__params = ' +
    JSON.stringify(Object.assign({}, params, { return_to: RETURN_TO })).replace(/</g, '\\u003c') + ';</script>' + FETCH_STUB;
  return page.replace('<!--PARAMS-->', () => injected);
}

// ---------------------------------------------------------------------------------------------------------- main
async function main(argv) {
  let update = false, threshold = 0.001, only = null;
  const schemes = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--update') update = true;
    else if (argv[i] === '--threshold') threshold = Number(argv[++i]);
    else if (argv[i] === '--only') only = new RegExp(argv[++i]);
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 22).join('\n'));
      return 0;
    } else if (ALL_SCHEMES.includes(argv[i])) schemes.push(argv[i]);
    else { console.error('unknown argument ' + argv[i]); return 2; }
  }
  if (!schemes.length) schemes.push(...ALL_SCHEMES);
  if (!findChrome()) { console.error('[settings-screenshots] no chromium found (run inside nix-shell or set $CHROME)'); return 2; }

  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build-config.js')], { stdio: 'inherit' });
  const dest = path.join(OUT, update ? 'baseline' : 'current');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buswatch-settings-'));
  let fail = 0;
  try {
    for (const scheme of schemes) {
      const dir = path.join(dest, scheme);
      fs.mkdirSync(dir, { recursive: true });
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.png') && (!only || only.test(f.slice(0, -4)))) fs.rmSync(path.join(dir, f));
      for (const [name, params, actions] of SCENES) {
        if (only && !only.test(name)) continue;
        const file = path.join(tmp, `${scheme}-${name}.html`);
        fs.writeFileSync(file, pageHtml(params));
        const page = await openPage('file://' + file, { width: 400, height: 800, initScript: FREEZE_DATE, css: STILL_CSS,
          colorScheme: scheme, timezone: 'UTC', locale: 'en-US' });
        try {
          for (const a of actions) await page.eval(a);
          await page.settle();
          fs.writeFileSync(path.join(dir, name + '.png'), await page.screenshot());
          if (page.errors.length) { fail = 1; console.error(`[settings-screenshots ${scheme}] FAIL: ${name}: page errors: ${page.errors.join(' | ')}`); }
          else console.log(`[settings-screenshots ${scheme}] ${name}`);
        } catch (e) {
          fail = 1; console.error(`[settings-screenshots ${scheme}] FAIL: ${name}: ${e.message}`);
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (update) { console.log('[settings-screenshots] baseline written to ' + dest); return fail; }

  // compare only the schemes (and with --only, the scenes) that ran
  const cmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'buswatch-cmp-'));
  const cmpCur = fs.mkdtempSync(path.join(os.tmpdir(), 'buswatch-cur-'));
  try {
    for (const scheme of schemes) {
      fs.mkdirSync(path.join(cmpBase, scheme), { recursive: true });
      const bdir = path.join(OUT, 'baseline', scheme);
      if (fs.existsSync(bdir)) {
        for (const f of fs.readdirSync(bdir)) {
          if (f.endsWith('.png') && (!only || only.test(f.slice(0, -4)))) fs.copyFileSync(path.join(bdir, f), path.join(cmpBase, scheme, f));
        }
      }
      fs.cpSync(path.join(OUT, 'current', scheme), path.join(cmpCur, scheme), { recursive: true });
    }
    fs.rmSync(path.join(OUT, 'diff'), { recursive: true, force: true });
    const code = execFileSyncStatus(process.execPath, [path.join(ROOT, 'tools', 'lib', 'png-diff.js'), 'compare',
      cmpBase, cmpCur, path.join(OUT, 'diff'), '--threshold', String(threshold)]);
    return code || fail;
  } finally {
    fs.rmSync(cmpBase, { recursive: true, force: true });
    fs.rmSync(cmpCur, { recursive: true, force: true });
  }
}

function execFileSyncStatus(cmd, args) {
  try { execFileSync(cmd, args, { stdio: 'inherit' }); return 0; } catch (e) { return e.status || 1; }
}

if (require.main === module) main(process.argv.slice(2)).then(c => process.exit(c), e => { console.error(e); process.exit(1); });
