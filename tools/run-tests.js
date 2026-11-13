// Runs every test suite: node:test files in test/ (JS units, config page in headless Chromium,
// host-compiled C model). Suites whose tools are missing (gcc, chromium) skip themselves.
// usage: node tools/run-tests.js [name-filter...]   e.g. node tools/run-tests.js ranking optimize
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'test');
const filters = process.argv.slice(2);
// src/pkjs/config-page.js is generated (not committed) and required by src/pkjs/index.js: build it first.
const cfg = spawnSync(process.execPath, [path.join(__dirname, 'build-config.js')], { stdio: 'inherit' });
if (cfg.status !== 0) process.exit(cfg.status === null ? 1 : cfg.status);
const files = fs.readdirSync(dir)
  .filter(f => f.endsWith('.test.js'))
  .filter(f => filters.length === 0 || filters.some(x => f.includes(x)))
  .map(f => path.join('test', f));
if (files.length === 0) { console.error('no test files match', filters); process.exit(1); }
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: path.join(__dirname, '..') });
process.exit(r.status === null ? 1 : r.status);
