// Enforces the module boundaries of CONTRACTS.md (top): data sources are plug-ins, the router and the
// trigger logic are independent, and only composition roots know every part.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const rel = p => path.relative(ROOT, p).split(path.sep).join('/');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []);
}

// every require('./x') of a file, resolved to a repo-relative path
function requiresOf(file) {
  const src = fs.readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '');
  const out = [];
  for (const m of src.matchAll(/require\(\s*'([^']+)'\s*\)/g)) {
    if (!m[1].startsWith('.')) { out.push(m[1]); continue; }
    let p = path.resolve(path.dirname(file), m[1]);
    if (!p.endsWith('.js')) p = fs.existsSync(p + '.js') ? p + '.js' : path.join(p, 'index.js');
    out.push(rel(p));
  }
  return out;
}

test('src/common never requires a data source', () => {
  for (const f of walk(path.join(ROOT, 'src/common'))) {
    for (const r of requiresOf(f)) assert.ok(!r.startsWith('src/sources/'), `${rel(f)} requires ${r}`);
  }
});

test('data sources only require src/sources/** and the pure geo library', () => {
  for (const f of walk(path.join(ROOT, 'src/sources'))) {
    for (const r of requiresOf(f)) {
      assert.ok(r.startsWith('src/sources/') || r === 'src/common/geo.js', `${rel(f)} requires ${r}`);
    }
  }
});

test('a source plug-in never requires another plug-in (only registry/all/util are shared)', () => {
  for (const f of walk(path.join(ROOT, 'src/sources'))) {
    const own = rel(f).split('/')[2];
    if (!f.endsWith(path.join(own, 'index.js')) && !rel(f).startsWith(`src/sources/${own}/`)) continue;
    for (const r of requiresOf(f)) {
      if (!r.startsWith('src/sources/')) continue;
      const other = r.split('/')[2];
      assert.ok(other === own || other === 'util.js', `${rel(f)} requires ${r}`);
    }
  }
});

test('router and triggers are independent: only pure helpers', () => {
  const pure = new Set(['src/common/geo.js', 'src/common/directions.js', 'src/common/format.js']);
  for (const name of ['router', 'triggers', 'trip-items']) {
    const f = path.join(ROOT, 'src/common', name + '.js');
    if (!fs.existsSync(f)) continue;
    for (const r of requiresOf(f)) assert.ok(pure.has(r), `${name}.js requires ${r}`);
  }
});

test('the scheduler gets the router, triggers and all I/O injected (no transport, no sources, no session)', () => {
  const f = path.join(ROOT, 'src/common/scheduler.js');
  if (!fs.existsSync(f)) return;
  // view.js is a pure helper (coverage areas of the runtime config)
  const allowed = new Set(['src/common/router.js', 'src/common/triggers.js', 'src/common/format.js', 'src/common/settings.js',
    'src/common/view.js', 'src/sources/registry.js']);
  for (const r of requiresOf(f)) {
    assert.ok(allowed.has(r) && r !== 'src/sources/registry.js', `scheduler.js requires ${r}`);
  }
});

test('only composition roots register the shipped sources', () => {
  const roots = new Set(['src/pkjs/index.js']);
  for (const f of [...walk(path.join(ROOT, 'src'))]) {
    if (requiresOf(f).includes('src/sources/all.js')) assert.ok(roots.has(rel(f)), `${rel(f)} requires src/sources/all.js`);
  }
});
