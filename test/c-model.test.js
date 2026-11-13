// Compiles the host C tests in test/c/ against the pure watch modules in src/c/ and runs them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const hasGcc = spawnSync('gcc', ['--version']).status === 0;
const skip = !hasGcc && 'gcc not found (run inside nix-shell)';

function runC(name, sources) {
  const outDir = path.join(root, 'test', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const exe = path.join(outDir, name);
  const cc = spawnSync('gcc', ['-std=c99', '-Wall', '-Wextra', '-Werror', '-D_POSIX_C_SOURCE=200809L',
    '-I', path.join(root, 'src/c'), ...sources.map(s => path.join(root, s)), '-lm', '-o', exe], { encoding: 'utf8' });
  assert.equal(cc.status, 0, 'compile failed:\n' + cc.stderr);
  const run = spawnSync(exe, [], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
}

test('C bus_model (host gcc)', { skip }, () => runC('test_bus_model', ['test/c/test_bus_model.c', 'src/c/bus_model.c']));
test('C bus_wheel layout (host gcc)', { skip }, () => runC('test_bus_wheel', ['test/c/test_bus_wheel.c', 'src/c/bus_wheel.c']));
test('C bus_arrow geometry (host gcc)', { skip }, () => runC('test_bus_arrow', ['test/c/test_bus_arrow.c', 'src/c/bus_arrow.c']));
test('C bus_wakeup list (host gcc)', { skip }, () => runC('test_bus_wakeup', ['test/c/test_bus_wakeup.c', 'src/c/bus_wakeup.c']));
test('C bus_marquee timing (host gcc)', { skip }, () => runC('test_bus_marquee', ['test/c/test_bus_marquee.c', 'src/c/bus_marquee.c']));
