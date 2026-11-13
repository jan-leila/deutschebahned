// Minimal headless-Chromium driver over the DevTools protocol (Node 24: global WebSocket/fetch, no npm deps).
//   const page = await openPage(fileUrlOrDataUrl); await page.eval('1+1'); await page.close();
// Screenshot options (all optional, used by tools/settings-screenshots.js; the tests use none of them):
//   openPage(url, { width, height, initScript, css, colorScheme, timezone, locale })
//   await page.settle(); const png = await page.screenshot();
// width/height emulate a phone viewport, initScript runs before any page script (e.g. to freeze Date), css is
// injected once the page has loaded, colorScheme ('light' | 'dark') sets prefers-color-scheme, timezone/locale pin
// the page's Intl and Date behaviour.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function findChrome() {
  for (const c of [process.env.CHROME, 'chromium', 'chromium-browser', 'google-chrome']) {
    if (c && spawnSync(c, ['--version']).status === 0) return c;
  }
  return null;
}

async function openPage(url, opts = {}) {
  const bin = findChrome();
  if (!bin) throw new Error('no chromium');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buswatch-chrome-'));
  const env = Object.assign({}, process.env, opts.timezone ? { TZ: opts.timezone } : {}, opts.locale ? { LANG: opts.locale.replace('-', '_') + '.UTF-8' } : {});
  // --hide-scrollbars, no font hinting and a fixed colour profile keep screenshots stable across machines
  const proc = spawn(bin, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--hide-scrollbars',
    '--font-render-hinting=none', '--force-color-profile=srgb',
    '--user-data-dir=' + dir, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore', detached: true, env });
  const portFile = path.join(dir, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  let tab;
  for (let i = 0; i < 50 && !tab; i++) {
    try { tab = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch (e) {}
    if (!tab) await sleep(100);
  }
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const waiters = {}, listeners = [];
  const errors = [], logs = [], navigations = [];
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id && waiters[d.id]) { waiters[d.id](d); delete waiters[d.id]; return; }
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    if (d.method === 'Runtime.consoleAPICalled') logs.push(d.params.args.map(a => a.value).join(' '));
    if (d.method === 'Fetch.requestPaused') {
      navigations.push(d.params.request.url);
      send('Fetch.failRequest', { requestId: d.params.requestId, errorReason: 'Aborted' });
    }
    listeners.forEach(l => l(d));
  };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; waiters[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  await send('Page.enable');
  // capture navigations to pebblejs:// or the test return_to URL instead of following them
  await send('Fetch.enable', { patterns: [{ urlPattern: 'http://return.test/*' }] });
  if (opts.width || opts.height) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: opts.width || 400, height: opts.height || 800, deviceScaleFactor: 1, mobile: true });
  }
  if (opts.timezone) await send('Emulation.setTimezoneOverride', { timezoneId: opts.timezone });
  if (opts.locale) await send('Emulation.setLocaleOverride', { locale: opts.locale });
  if (opts.colorScheme) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: opts.colorScheme }] });
  if (opts.initScript) await send('Page.addScriptToEvaluateOnNewDocument', { source: opts.initScript });
  const loaded = new Promise(r => listeners.push(d => d.method === 'Page.loadEventFired' && r()));
  await send('Page.navigate', { url });
  await loaded;
  const page = {
    errors, logs, navigations,
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result.exceptionDetails) throw new Error('page eval failed: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
      return r.result.result.value;
    },
    // Waits for web fonts and two animation frames so the page has settled.
    async settle() {
      await page.eval('document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))');
    },
    // Full-page PNG (Buffer) at the emulated width. The viewport is first grown to the whole page so fixed elements
    // (the save bar) sit at the bottom of the image instead of over the content where the first screen ended.
    async screenshot() {
      let m = await send('Page.getLayoutMetrics');
      let size = m.result.cssContentSize || m.result.contentSize;
      if (opts.width || opts.height) {
        await send('Emulation.setDeviceMetricsOverride', {
          width: opts.width || 400, height: Math.ceil(size.height), deviceScaleFactor: 1, mobile: true });
        await page.settle();
        m = await send('Page.getLayoutMetrics');
        size = m.result.cssContentSize || m.result.contentSize;
      }
      const r = await send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 } });
      return Buffer.from(r.result.data, 'base64');
    },
    async close() {
      try { ws.close(); } catch (e) {}
      const exited = proc.exitCode !== null ? Promise.resolve() : new Promise(r => proc.once('exit', r));
      try { process.kill(-proc.pid); } catch (e) {}
      await Promise.race([exited, sleep(3000)]);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
  if (opts.css) {
    await page.eval(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(opts.css)};
      document.head.appendChild(s); })()`);
  }
  return page;
}

module.exports = { openPage, findChrome };
