// Minimal headless-Chromium driver over the DevTools protocol (Node 24: global WebSocket/fetch).
// const page = await openPage(fileUrlOrDataUrl); await page.eval('1+1'); await page.close();
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function findChrome() {
  for (const c of [process.env.CHROME, 'chromium', 'chromium-browser', 'google-chrome']) {
    if (c && spawnSync(c, ['--version']).status === 0) return c;
  }
  return null;
}

async function openPage(url) {
  const bin = findChrome();
  if (!bin) throw new Error('no chromium');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buswatch-chrome-'));
  const proc = spawn(bin, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--user-data-dir=' + dir, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore', detached: true });
  const portFile = path.join(dir, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await new Promise(r => setTimeout(r, 100));
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  let tab;
  for (let i = 0; i < 50 && !tab; i++) {
    try { tab = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch (e) {}
    if (!tab) await new Promise(r => setTimeout(r, 100));
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
  const loaded = new Promise(r => listeners.push(d => d.method === 'Page.loadEventFired' && r()));
  await send('Page.navigate', { url });
  await loaded;
  return {
    errors, logs, navigations,
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result.exceptionDetails) throw new Error('page eval failed: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
      return r.result.result.value;
    },
    async close() {
      try { ws.close(); } catch (e) {}
      const exited = proc.exitCode !== null ? Promise.resolve() : new Promise(r => proc.once('exit', r));
      try { process.kill(-proc.pid); } catch (e) {}
      await Promise.race([exited, new Promise(r => setTimeout(r, 3000))]);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

module.exports = { openPage, findChrome };
