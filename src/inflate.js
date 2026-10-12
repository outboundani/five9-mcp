// A small synchronous DEFLATE decoder (RFC 1951) with the gzip (RFC 1952) and
// zlib (RFC 1950) wrappers, after Mark Adler's puff.c. The safety checks need
// to read compressed payloads inside IVR script XML while tiering, which is
// synchronous, and Workers only offer the async DecompressionStream. Output is
// capped; anything malformed, truncated or too large throws InflateError.

export class InflateError extends Error {}

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function bits(s, need) {
  let val = s.bitbuf;
  while (s.bitcnt < need) {
    if (s.pos >= s.buf.length) throw new InflateError('truncated');
    val |= s.buf[s.pos++] << s.bitcnt;
    s.bitcnt += 8;
  }
  s.bitbuf = val >>> need;
  s.bitcnt -= need;
  return val & ((1 << need) - 1);
}

function table(lengths) {
  const counts = new Uint16Array(16);
  for (const l of lengths) counts[l]++;
  counts[0] = 0;
  let left = 1;
  for (let i = 1; i < 16; i++) { left = (left << 1) - counts[i]; if (left < 0) throw new InflateError('bad code lengths'); }
  const offs = new Uint16Array(16);
  for (let i = 1; i < 15; i++) offs[i + 1] = offs[i] + counts[i];
  const symbols = new Uint16Array(lengths.length);
  for (let sym = 0; sym < lengths.length; sym++) if (lengths[sym]) symbols[offs[lengths[sym]]++] = sym;
  return { counts, symbols };
}

function decode(s, h) {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len < 16; len++) {
    code |= bits(s, 1);
    const count = h.counts[len];
    if (code - count < first) return h.symbols[index + (code - first)];
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new InflateError('bad code');
}

function put(s, byte) {
  if (s.len >= s.max) throw new InflateError('too large');
  if (s.len >= s.out.length) {
    const next = new Uint8Array(Math.min(s.max, s.out.length * 2));
    next.set(s.out);
    s.out = next;
  }
  s.out[s.len++] = byte;
}

function codes(s, lencode, distcode) {
  for (;;) {
    let sym = decode(s, lencode);
    if (sym < 256) { put(s, sym); continue; }
    if (sym === 256) return;
    sym -= 257;
    if (sym >= 29) throw new InflateError('bad length symbol');
    const len = LBASE[sym] + bits(s, LEXT[sym]);
    const dsym = decode(s, distcode);
    if (dsym >= 30) throw new InflateError('bad distance symbol');
    const dist = DBASE[dsym] + bits(s, DEXT[dsym]);
    if (dist > s.len) throw new InflateError('distance too far back');
    for (let i = 0; i < len; i++) put(s, s.out[s.len - dist]);
  }
}

let FIXED = null;
function fixed() {
  if (!FIXED) {
    const l = new Uint8Array(288);
    l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
    FIXED = [table(l), table(new Uint8Array(30).fill(5))];
  }
  return FIXED;
}

function dynamic(s) {
  const nlen = bits(s, 5) + 257;
  const ndist = bits(s, 5) + 1;
  const ncode = bits(s, 4) + 4;
  if (nlen > 286 || ndist > 30) throw new InflateError('bad counts');
  const lengths = new Uint8Array(320);
  for (let i = 0; i < ncode; i++) lengths[ORDER[i]] = bits(s, 3);
  const lencode = table(lengths.subarray(0, 19));
  const all = new Uint8Array(nlen + ndist);
  for (let i = 0; i < nlen + ndist;) {
    let sym = decode(s, lencode);
    if (sym < 16) { all[i++] = sym; continue; }
    let len = 0;
    if (sym === 16) {
      if (i === 0) throw new InflateError('repeat with no first length');
      len = all[i - 1];
      sym = 3 + bits(s, 2);
    } else if (sym === 17) sym = 3 + bits(s, 3);
    else sym = 11 + bits(s, 7);
    if (i + sym > nlen + ndist) throw new InflateError('too many lengths');
    while (sym--) all[i++] = len;
  }
  if (all[256] === 0) throw new InflateError('no end of block code');
  codes(s, table(all.subarray(0, nlen)), table(all.subarray(nlen)));
}

function stored(s) {
  s.bitbuf = 0;
  s.bitcnt = 0;
  if (s.pos + 4 > s.buf.length) throw new InflateError('truncated');
  const len = s.buf[s.pos] | (s.buf[s.pos + 1] << 8);
  const nlen = s.buf[s.pos + 2] | (s.buf[s.pos + 3] << 8);
  s.pos += 4;
  if (len !== (~nlen & 0xffff)) throw new InflateError('bad stored length');
  if (s.pos + len > s.buf.length) throw new InflateError('truncated');
  for (let i = 0; i < len; i++) put(s, s.buf[s.pos++]);
}

// Raw DEFLATE from buf[start]. Returns { bytes, end } where end is the first byte after the stream.
export function inflateRaw(buf, { max = 1_000_000, start = 0 } = {}) {
  const s = { buf, pos: start, bitbuf: 0, bitcnt: 0, out: new Uint8Array(Math.max(1, Math.min(max, 4096))), len: 0, max };
  let last;
  do {
    last = bits(s, 1);
    const type = bits(s, 2);
    if (type === 0) stored(s);
    else if (type === 1) codes(s, ...fixed());
    else if (type === 2) dynamic(s);
    else throw new InflateError('bad block type');
  } while (!last);
  return { bytes: s.out.slice(0, s.len), end: s.pos };
}

export const isGzip = (b) => b.length >= 3 && b[0] === 0x1f && b[1] === 0x8b && b[2] === 8;
export const isZlib = (b) => b.length >= 2 && (b[0] & 0x0f) === 8 && (b[0] >> 4) <= 7 && ((b[0] << 8) | b[1]) % 31 === 0;

// Every gzip member in buf, concatenated (Java's GZIPInputStream reads them all).
export function gunzip(buf, { max = 1_000_000 } = {}) {
  const parts = [];
  let total = 0;
  let pos = 0;
  while (pos < buf.length) {
    if (!isGzip(buf.subarray(pos))) {
      if (!parts.length) throw new InflateError('not gzip');
      break; // trailing bytes that are not a gzip member are ignored, as Java does
    }
    const flags = buf[pos + 3];
    if (flags & 0xe0) throw new InflateError('reserved gzip flags');
    let p = pos + 10;
    if (flags & 4) { if (p + 2 > buf.length) throw new InflateError('truncated'); p += 2 + (buf[p] | (buf[p + 1] << 8)); }
    if (flags & 8) { while (p < buf.length && buf[p] !== 0) p++; p++; }
    if (flags & 16) { while (p < buf.length && buf[p] !== 0) p++; p++; }
    if (flags & 2) p += 2;
    if (p > buf.length) throw new InflateError('truncated');
    const { bytes, end } = inflateRaw(buf, { max: max - total, start: p });
    if (end + 8 > buf.length) throw new InflateError('truncated');
    const size = (buf[end + 4] | (buf[end + 5] << 8) | (buf[end + 6] << 16) | (buf[end + 7] << 24)) >>> 0;
    if (size !== bytes.length) throw new InflateError('size mismatch');
    parts.push(bytes);
    total += bytes.length;
    pos = end + 8;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function unzlib(buf, { max = 1_000_000 } = {}) {
  if (!isZlib(buf)) throw new InflateError('not zlib');
  if (buf[1] & 0x20) throw new InflateError('preset dictionary');
  return inflateRaw(buf, { max, start: 2 }).bytes;
}
