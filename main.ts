// png-squeeze-01 entry: lossless PNG minimiser for 1280x720 RGBA screenshots.
// Self-contained (Node builtins only). Strategy, written from the kit's published
// description of the scale compressor and the PNG spec:
//  - pick the smallest form: palette (by count / by luminance) when <= 256 colours,
//    grey (0) / grey+alpha (4) / RGB (2) / RGBA (6), with a tRNS key when exactly one
//    fully-transparent value exists and no opaque pixel uses it;
//  - pick the filter per form from {fixed 0,1,2,4, minsum, pairs, brute}, where brute
//    weighs each row's five filters by a real level-4 deflate after the previous 32 KiB;
//  - screen every candidate at zlib level 6, then re-deflate the winner at level 9
//    under several strategies and keep the smallest stream.
// Deterministic: ties keep the first candidate, deflateSync is deterministic.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, createDeflateRaw, deflateSync, inflateSync } from 'node:zlib';

const DEBUG = process.env.MAKEFUN_DEBUG === '1';
const log = (...a: unknown[]) => { if (DEBUG) console.error(...a); };

// ---------------------------------------------------------------- PNG codec
const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const ascii = (s: string) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

function pngOf(chunks: [string, Uint8Array][]): Uint8Array {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width: number, height: number, colourType: number): Uint8Array {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

interface Decoded { ok: true; width: number; height: number; colourType: number; rgba: Uint8Array }
interface Failed { ok: false; why: string }

function decodePng(bytes: Uint8Array): Decoded | Failed {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) return { ok: false, why: 'bad signature' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header: { width: number; height: number; colourType: number } | null = null;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) return { ok: false, why: 'bytes after IEND' };
    if (at + 12 > bytes.length) return { ok: false, why: 'chunk cut short' };
    const len = view.getUint32(at);
    if (len > 0x7fffffff || at + 12 + len > bytes.length) return { ok: false, why: 'chunk overruns file' };
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) return { ok: false, why: `${type} CRC` };
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), colourType: data[9] };
      if (data[8] !== 8 || data[12] !== 0) return { ok: false, why: 'depth/interlace' };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') ended = true;
    else return { ok: false, why: `unexpected chunk ${type}` };
  }
  if (!header || !ended || idat.length === 0) return { ok: false, why: 'missing IHDR/IDAT/IEND' };
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  if (bpp === undefined) return { ok: false, why: 'colour type' };
  const stride = width * bpp;
  const expected = height * (stride + 1);
  let raw: Uint8Array;
  try {
    raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch (e) {
    return { ok: false, why: `inflate: ${String(e)}` };
  }
  if (raw.length !== expected) return { ok: false, why: 'inflate length' };
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) return { ok: false, why: `filter ${ft}` };
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    else if (ft === 2) for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    else if (ft === 3) for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    else for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? samples[o + i - bpp] : 0;
      const b = y > 0 ? samples[p + i] : 0;
      const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
      samples[o + i] = raw[src + i] + paeth(a, b, c);
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    if (palette === null) return { ok: false, why: 'palette missing' };
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) return { ok: false, why: 'palette index' };
      rgba[d] = lut[e * 4]; rgba[d + 1] = lut[e * 4 + 1]; rgba[d + 2] = lut[e * 4 + 2]; rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { ok: true, width, height, colourType, rgba };
}

// ---------------------------------------------------------------- analysis
interface Colour { rgba: [number, number, number, number]; word: number; count: number }

function wordsOf(rgba: Uint8Array): Uint32Array {
  const at = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  return new Uint32Array(at.buffer, at.byteOffset, at.length >>> 2);
}

function analyse(rgba: Uint8Array): { opaque: boolean; grey: boolean; colours: Colour[] | null } {
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  if (many) return { opaque, grey, colours: null };
  const colours: Colour[] = [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]] as [number, number, number, number], word: c, count: counts.get(c)! };
  });
  return { opaque, grey, colours };
}

/** The one fully-transparent value (grey or RGB) a tRNS key can stand for, else null. */
function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}

// ---------------------------------------------------------------- palette
function paletteForm(rgba: Uint8Array, colours: Colour[], order: 'count' | 'luminance' | 'first'): { plte: Uint8Array; trns: Uint8Array | null; indices: Uint8Array } {
  const lum = (c: Colour) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  const firstSeen = new Map<number, number>();
  {
    const u32 = wordsOf(rgba);
    for (let i = 0; i < u32.length; i++) if (!firstSeen.has(u32[i])) firstSeen.set(u32[i], i);
  }
  const entries = [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    if (order === 'first') return firstSeen.get(x.word)! - firstSeen.get(y.word)!;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0]; plte[i * 3 + 1] = c.rgba[1]; plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i])!;
  return { plte, trns, indices };
}

// ---------------------------------------------------------------- filters
function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  else if (type === 2) for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  else if (type === 3) for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  else for (let i = 0; i < n; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev === null ? 0 : prev[i];
    const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
    out[i] = cur[i] - paeth(a, b, c);
  }
}

function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

function pairsOf(row: Uint8Array, seen: Uint32Array, stamp: number): number {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) { seen[pair] = stamp; n++; }
  }
  return n;
}

type FilterChoice = number | 'minsum' | 'pairs' | 'brute';

/** Filtered data for `samples` by `choice`; brute weighs each row by a real deflate. */
function filtered(samples: Uint8Array, width: number, height: number, bpp: number, choice: FilterChoice): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride + 1));
  for (let t = 0; t < 5; t++) trial[t][0] = t;
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost: number;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else cost = deflateSync(trial[t], before.length === 0 ? { level: BRUTE_LEVEL, memLevel: 9 } : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before }).length;
      if (cost < best) { best = cost; type = t; }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

// ---------------------------------------------------------------- screening
interface Form { colourType: number; bpp: number; samples: Uint8Array; plte: Uint8Array | null; trns: Uint8Array | null; filters: FilterChoice[] }

const CHANNEL_FILTERS: FilterChoice[] = [0, 1, 2, 4, 'minsum', 'pairs', 'brute'];

function formsOf(rgba: Uint8Array): Form[] {
  const { opaque, grey, colours } = analyse(rgba);
  const forms: Form[] = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance', 'first'] as const) {
      const p = paletteForm(rgba, colours, order);
      forms.push({
        colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns,
        filters: order === 'count' ? [0] : [0, 'minsum', 'brute'],
      });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct: number;
  let trns: Uint8Array | null = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct]!;
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: CHANNEL_FILTERS });
  return forms;
}

const chunkBytes = (form: Form) => (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

/** Adler-32 (zlib's checksum) of bytes. */
function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Wrap a raw deflate stream in a zlib stream (header + Adler-32). */
function zlibWrap(raw: Uint8Array, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(raw.length + 6);
  out[0] = 0x78;
  out[1] = 0x9c;
  out.set(raw, 2);
  new DataView(out.buffer).setUint32(raw.length + 2, adler32(data));
  return out;
}

/**
 * Raw deflate of `data` in `segments` equal parts, with a sync flush between parts:
 * each part gets its own Huffman table, which suits screenshots whose regions differ
 * (flat top, photo-like bottom). Deterministic for fixed segment boundaries.
 * Returns a full zlib stream (header + raw deflate + Adler-32).
 */
function deflateSegmented(data: Uint8Array, segments: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const d = createDeflateRaw({ level: 9, memLevel: 9 });
    const chunks: Buffer[] = [];
    d.on('data', (c: Buffer) => chunks.push(c));
    d.on('error', reject);
    d.on('end', () => resolve(zlibWrap(new Uint8Array(Buffer.concat(chunks)), data)));
    const n = data.length;
    const per = Math.ceil(n / segments);
    let i = 0;
    const step = () => {
      if (i >= segments) { d.end(); return; }
      const part = data.subarray(i * per, Math.min(n, (i + 1) * per));
      i++;
      d.write(part, () => {
        if (i < segments) d.flush(constants.Z_SYNC_FLUSH, step);
        else d.end();
      });
    };
    step();
  });
}

const SCREEN = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };

function pngOfForm(width: number, height: number, form: Form, idat: Uint8Array): Uint8Array {
  const chunks: [string, Uint8Array][] = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

/** Smallest PNG of the image: screen forms/filters at level 6, then re-deflate the
 *  top candidate at level 9 (single and segmented) and keep the smallest. */
async function squeeze(rgba: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const forms = formsOf(rgba);
  const cands: { form: Form; choice: FilterChoice; data: Uint8Array; zlib: Uint8Array; bytes: number }[] = [];
  for (const form of forms) {
    const chunks = chunkBytes(form);
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice);
      const zlib = deflateSync(data, SCREEN);
      cands.push({ form, choice, data, zlib: new Uint8Array(zlib.buffer, zlib.byteOffset, zlib.length), bytes: zlib.length + chunks });
    }
  }
  cands.sort((a, b) => a.bytes - b.bytes);
  // The level-6 stream stays a candidate: level 9 is not always smaller.
  const top = cands[0];
  let best: { form: Form; choice: FilterChoice; zlib: Uint8Array; bytes: number } = { form: top.form, choice: top.choice, zlib: top.zlib, bytes: top.bytes };
  const consider = (z: Uint8Array, form: Form, choice: FilterChoice) => {
    const bytes = z.length + chunkBytes(form);
    if (bytes < best.bytes) best = { form, choice, zlib: z, bytes };
  };
  for (const strategy of [constants.Z_DEFAULT_STRATEGY, constants.Z_FILTERED, constants.Z_RLE]) {
    const z = deflateSync(top.data, { level: 9, memLevel: 9, strategy });
    consider(new Uint8Array(z.buffer, z.byteOffset, z.length), top.form, top.choice);
  }
  for (const segments of [4, 8, 16]) {
    consider(await deflateSegmented(top.data, segments), top.form, top.choice);
  }
  const { form } = best;
  log(`  form ct${form.colourType} choice ${String(best.choice)} -> ${best.bytes} bytes (idat ${best.zlib.length})`);
  return pngOfForm(width, height, form, best.zlib);
}

// ---------------------------------------------------------------- main
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const t0 = performance.now();
for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  if (!image.ok) throw new Error(`${id}/image.png: ${image.why}`);
  log(`${id}: decode ok ${image.width}x${image.height}`);
  const t1 = performance.now();
  const out = await squeeze(image.rgba, image.width, image.height);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), out);
  log(`${id}: ${out.length} bytes in ${(performance.now() - t1).toFixed(0)}ms`);
}
log(`total ${(performance.now() - t0).toFixed(0)}ms`);
