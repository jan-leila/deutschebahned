// tools/lib/png-diff.js: PNG decode/encode/diff on synthetic images.
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const png = require('../tools/lib/png-diff');

function image(w, h, fn) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(fn(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}

// Hand-built PNG with a given colour type / depth / per-row filter, to exercise the decoder independently of encode().
function rawPng(w, h, colorType, depth, rows, extra) {
  const chunk = (type, body) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(body.length, 0); head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(png.crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth; ihdr[9] = colorType;
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  for (const [t, b] of extra || []) parts.push(chunk(t, b));
  parts.push(chunk('IDAT', zlib.deflateSync(Buffer.concat(rows.map((r) => Buffer.from(r))))), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

const px = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

test('encode -> decode round trip (RGBA)', () => {
  const img = image(7, 5, (x, y) => [x * 30, y * 50, (x + y) * 10, 255 - x]);
  const back = png.decode(png.encode(img));
  assert.equal(back.width, 7); assert.equal(back.height, 5);
  assert.deepEqual(Array.from(back.data), Array.from(img.data));
});

test('decodes RGB with every filter type', () => {
  // 2x5 RGB, one row per filter 0..4; row bytes chosen so the reconstructed values are known
  const rows = [
    [0, 10, 20, 30, 40, 50, 60],          // none: (10,20,30) (40,50,60)
    [1, 1, 2, 3, 1, 1, 1],                // sub: (1,2,3) (2,3,4)
    [2, 1, 1, 1, 1, 1, 1],                // up: (2,3,4) (3,4,5)
    [3, 0, 0, 0, 0, 0, 0],                // average: (1,1,2) ((1+3)>>1=2, (1+4)>>1=2, (2+5)>>1=3)
    [4, 0, 0, 0, 0, 0, 0]                 // paeth: a=0 b=up c=0 -> up: (1,1,2); then x=1: a=(1,1,2) b=(2,2,3) c=(1,1,2) -> b
  ];
  const img = png.decode(rawPng(2, 5, 2, 8, rows));
  assert.deepEqual(px(img, 0, 0), [10, 20, 30, 255]); assert.deepEqual(px(img, 1, 0), [40, 50, 60, 255]);
  assert.deepEqual(px(img, 0, 1), [1, 2, 3, 255]); assert.deepEqual(px(img, 1, 1), [2, 3, 4, 255]);
  assert.deepEqual(px(img, 0, 2), [2, 3, 4, 255]); assert.deepEqual(px(img, 1, 2), [3, 4, 5, 255]);
  assert.deepEqual(px(img, 0, 3), [1, 1, 2, 255]); assert.deepEqual(px(img, 1, 3), [2, 2, 3, 255]);
  assert.deepEqual(px(img, 0, 4), [1, 1, 2, 255]); assert.deepEqual(px(img, 1, 4), [2, 2, 3, 255]);
});

test('decodes 1-bit greyscale and 2-bit palette with transparency', () => {
  const g = png.decode(rawPng(10, 1, 0, 1, [[0, 0b10110000, 0b01000000]]));
  assert.deepEqual([0, 1, 2, 3, 4, 8, 9].map((x) => px(g, x, 0)[0]), [255, 0, 255, 255, 0, 0, 255]);
  const plte = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]);
  const p = png.decode(rawPng(4, 1, 3, 2, [[0, 0b00011011]], [['PLTE', plte], ['tRNS', Buffer.from([128])]]));
  assert.deepEqual(px(p, 0, 0), [255, 0, 0, 128]);
  assert.deepEqual(px(p, 1, 0), [0, 255, 0, 255]);
  assert.deepEqual(px(p, 3, 0), [9, 9, 9, 255]);
});

test('rejects garbage and corrupted chunks', () => {
  assert.throws(() => png.decode(Buffer.from('hello world')), /not a PNG/);
  const buf = png.encode(image(2, 2, () => [1, 2, 3, 255]));
  buf[20] ^= 0xff;  // inside IHDR
  assert.throws(() => png.decode(buf), /CRC/);
});

test('diff counts differing pixels and marks them red', () => {
  const a = image(10, 10, () => [255, 255, 255, 255]);
  const b = image(10, 10, (x, y) => (x === 3 && y === 4) || (x === 9 && y === 9) ? [0, 0, 0, 255] : [255, 255, 255, 255]);
  const d = png.diff(a, b);
  assert.equal(d.diffPixels, 2); assert.equal(d.total, 100); assert.equal(d.ratio, 0.02); assert.equal(d.sizeMismatch, false);
  assert.deepEqual(px(d.image, 3, 4), [255, 0, 0, 255]);
  assert.notDeepEqual(px(d.image, 0, 0), [255, 0, 0, 255]);
  assert.equal(png.diff(a, a).diffPixels, 0);
  const near = image(10, 10, () => [253, 255, 255, 255]);
  assert.equal(png.diff(a, near).diffPixels, 100);
  assert.equal(png.diff(a, near, { tolerance: 2 }).diffPixels, 0);
  const small = image(8, 10, () => [255, 255, 255, 255]);
  const ds = png.diff(a, small);
  assert.equal(ds.sizeMismatch, true); assert.equal(ds.diffPixels, 20);
});

test('compareDirs: ok / DIFF / missing / new, writes diff images', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'png-diff-'));
  const base = path.join(root, 'baseline'), cur = path.join(root, 'current'), dd = path.join(root, 'diff');
  for (const d of [base, cur]) fs.mkdirSync(path.join(d, 'basalt'), { recursive: true });
  const white = png.encode(image(20, 20, () => [255, 255, 255, 255]));
  const dot = png.encode(image(20, 20, (x, y) => x === 0 && y === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const black = png.encode(image(20, 20, () => [0, 0, 0, 255]));
  fs.writeFileSync(path.join(base, 'basalt/same.png'), white); fs.writeFileSync(path.join(cur, 'basalt/same.png'), white);
  fs.writeFileSync(path.join(base, 'basalt/tiny.png'), white); fs.writeFileSync(path.join(cur, 'basalt/tiny.png'), dot);
  fs.writeFileSync(path.join(base, 'basalt/big.png'), white); fs.writeFileSync(path.join(cur, 'basalt/big.png'), black);
  fs.writeFileSync(path.join(base, 'basalt/gone.png'), white);
  fs.writeFileSync(path.join(cur, 'basalt/extra.png'), white);
  const r = Object.fromEntries(png.compareDirs(base, cur, dd, { threshold: 0.005 }).map((x) => [x.name, x]));
  assert.equal(r[path.join('basalt', 'same.png')].status, 'ok');
  assert.equal(r[path.join('basalt', 'tiny.png')].status, 'ok~');    // 1/400 = 0.25% <= 0.5%
  assert.equal(r[path.join('basalt', 'big.png')].status, 'DIFF');
  assert.equal(r[path.join('basalt', 'gone.png')].status, 'missing');
  assert.equal(r[path.join('basalt', 'extra.png')].status, 'new');
  assert.ok(fs.existsSync(path.join(dd, 'basalt/big.png')));
  assert.ok(!fs.existsSync(path.join(dd, 'basalt/same.png')));
  assert.equal(png.decode(fs.readFileSync(path.join(dd, 'basalt/big.png'))).width, 20);
  fs.rmSync(root, { recursive: true, force: true });
});
