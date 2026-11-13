// Minimal PNG decode / encode / pixel diff for visual regression tests (Node, zlib only, no npm deps).
//   decode(buf) -> {width, height, data: Uint8Array RGBA}   (8-bit and 1/2/4-bit gray/palette, all colour types,
//                                                            no interlacing, 16-bit samples reduced to 8)
//   encode({width, height, data}) -> Buffer                 (8-bit RGBA, filter 0)
//   diff(a, b, opts) -> {width, height, sizeMismatch, diffPixels, total, ratio, image}
//                       image: baseline greyed out with differing pixels in red (b's pixels where sizes differ)
//   compareDirs(baselineDir, currentDir, diffDir, opts) -> [{name, status, diffPixels, ratio}]
// CLI: node tools/lib/png-diff.js compare <baselineDir> <currentDir> <diffDir> [--threshold 0.001]
//      prints a table; exit 1 when any image is missing or differs by more than the threshold (fraction of pixels).
'use strict';
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decode(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let pos = 8, ihdr = null, palette = null, trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (body.length !== len) throw new Error('truncated PNG chunk ' + type);
    if (buf.readUInt32BE(pos + 8 + len) !== crc32(buf.subarray(pos + 4, pos + 8 + len))) throw new Error('bad CRC in ' + type);
    pos += 12 + len;
    if (type === 'IHDR') {
      ihdr = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colorType: body[9], interlace: body[12] };
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
  }
  if (!ihdr) throw new Error('PNG without IHDR');
  const { width, height, depth, colorType, interlace } = ihdr;
  if (interlace) throw new Error('interlaced PNGs are not supported');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('bad PNG colour type ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bitsPP = channels * depth, bpp = Math.max(1, bitsPP >> 3), stride = (width * bitsPP + 7) >> 3;
  if (raw.length < height * (stride + 1)) throw new Error('PNG data too short');
  const lines = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? lines[dst + x - bpp] : 0, b = y ? lines[dst - stride + x] : 0;
      const c = x >= bpp && y ? lines[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) v += paeth(a, b, c);
      else if (f !== 0) throw new Error('bad PNG filter ' + f);
      lines[dst + x] = v & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  const sample = (row, i) => {  // i-th sample of a row, scaled to 8 bits
    if (depth === 8) return lines[row + i];
    if (depth === 16) return lines[row + 2 * i];
    const perByte = 8 / depth, byte = lines[row + Math.floor(i / perByte)];
    return (byte >> (8 - depth * (1 + (i % perByte)))) & ((1 << depth) - 1);
  };
  const scale = depth < 8 ? 255 / ((1 << depth) - 1) : 1;
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r, g, b, a = 255;
      if (colorType === 3) {
        const idx = sample(row, x);
        if (!palette || idx * 3 + 2 >= palette.length) throw new Error('bad palette index');
        r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
        if (trns && idx < trns.length) a = trns[idx];
      } else if (colorType === 0 || colorType === 4) {
        r = g = b = Math.round(sample(row, x * channels) * scale);
        if (colorType === 4) a = sample(row, x * 2 + 1);
      } else {
        r = sample(row, x * channels); g = sample(row, x * channels + 1); b = sample(row, x * channels + 2);
        if (colorType === 6) a = sample(row, x * 4 + 3);
      }
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = a;
    }
  }
  return { width, height, data };
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

function encode(img) {
  const { width, height, data } = img;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// opts.tolerance: max per-channel difference still counted as equal (default 0).
function diff(a, b, opts) {
  const tol = (opts && opts.tolerance) || 0;
  const width = Math.max(a.width, b.width), height = Math.max(a.height, b.height);
  const sizeMismatch = a.width !== b.width || a.height !== b.height;
  const image = { width, height, data: new Uint8Array(width * height * 4) };
  let diffPixels = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const inA = x < a.width && y < a.height, inB = x < b.width && y < b.height;
      const oa = (y * a.width + x) * 4, ob = (y * b.width + x) * 4;
      let same = inA && inB;
      if (same) for (let k = 0; k < 4; k++) if (Math.abs(a.data[oa + k] - b.data[ob + k]) > tol) { same = false; break; }
      if (same) {
        const grey = Math.round((a.data[oa] * 299 + a.data[oa + 1] * 587 + a.data[oa + 2] * 114) / 1000);
        const v = 160 + (grey * 95 / 255) | 0;  // faded baseline
        image.data[o] = image.data[o + 1] = image.data[o + 2] = v;
      } else {
        diffPixels++;
        image.data[o] = 255; image.data[o + 1] = 0; image.data[o + 2] = 0;
      }
      image.data[o + 3] = 255;
    }
  }
  const total = width * height;
  return { width, height, sizeMismatch, diffPixels, total, ratio: total ? diffPixels / total : 0, image };
}

function listPngs(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
      if (e.isDirectory()) walk(path.join(d, e.name), path.join(rel, e.name));
      else if (e.name.endsWith('.png')) out.push(path.join(rel, e.name));
    }
  })(dir, '');
  return out;
}

// opts.threshold: fraction of differing pixels still accepted (default 0.001); opts.tolerance as for diff().
function compareDirs(baselineDir, currentDir, diffDir, opts) {
  const threshold = opts && opts.threshold !== undefined ? opts.threshold : 0.001;
  const names = Array.from(new Set(listPngs(baselineDir).concat(listPngs(currentDir)))).sort();
  return names.map((name) => {
    const bp = path.join(baselineDir, name), cp = path.join(currentDir, name);
    if (!fs.existsSync(bp)) return { name, status: 'new', diffPixels: 0, ratio: 0 };
    if (!fs.existsSync(cp)) return { name, status: 'missing', diffPixels: 0, ratio: 0 };
    const d = diff(decode(fs.readFileSync(bp)), decode(fs.readFileSync(cp)), opts);
    const ok = !d.sizeMismatch && d.ratio <= threshold;
    if (d.diffPixels) {
      const dp = path.join(diffDir, name);
      fs.mkdirSync(path.dirname(dp), { recursive: true });
      fs.writeFileSync(dp, encode(d.image));
    }
    return { name, status: ok ? (d.diffPixels ? 'ok~' : 'ok') : d.sizeMismatch ? 'size' : 'DIFF', diffPixels: d.diffPixels, ratio: d.ratio };
  });
}

function main(argv) {
  const args = argv.slice(2);
  if (args[0] !== 'compare' || args.length < 4) {
    console.error('usage: node tools/lib/png-diff.js compare <baselineDir> <currentDir> <diffDir> [--threshold f] [--tolerance n]');
    return 2;
  }
  const opt = (name, def) => { const i = args.indexOf(name); return i > 0 ? Number(args[i + 1]) : def; };
  const results = compareDirs(args[1], args[2], args[3], { threshold: opt('--threshold', 0.001), tolerance: opt('--tolerance', 0) });
  const w = Math.max(5, ...results.map((r) => r.name.length));
  console.log('scene'.padEnd(w) + '  status   pixels   ratio');
  for (const r of results) {
    console.log(r.name.padEnd(w) + '  ' + r.status.padEnd(7) + '  ' + String(r.diffPixels).padStart(6) + '  ' + (r.ratio * 100).toFixed(3).padStart(6) + '%');
  }
  const bad = results.filter((r) => r.status === 'DIFF' || r.status === 'size' || r.status === 'missing' || r.status === 'new');
  console.log(results.length + ' images, ' + bad.length + ' failing' + (bad.length ? ' (diff images in ' + args[3] + ')' : ''));
  return results.length && !bad.length ? 0 : 1;
}

module.exports = { decode, encode, diff, compareDirs, crc32 };
if (require.main === module) process.exit(main(process.argv));
