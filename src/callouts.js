// Outside call-outs in Five9 IVR script XML, the redaction marker check, the
// XXE check, and the encoded payloads all three must see through.
//
// An IVR script can make outbound HTTP requests with call data (query or web
// service modules). That is data egress, so the server must see every host a
// definition reaches, however it is written: plain, entity encoded, inside
// CDATA, in an attribute, percent encoded, or inside an encoded payload (the
// designer stores text to speech documents as gzip+base64). Several views of
// the same text are scanned and the union of hosts is returned. Element names
// that look like a call-out module are flagged even when no URL can be parsed
// (the URL may be built from variables at run time).

import { parseXml } from './five9.js';
import { gunzip, unzlib, inflateRaw, isGzip, isZlib } from './inflate.js';

// scheme://authority, any scheme (http, https, ftp, ws, sftp, ...).
// The authority runs to the first "/", "?" or "#" like a java.net.URL style parser
// would read it; backslashes are kept so "good.com\@evil.net" yields both hosts.
const URL_RE = /\b([a-z][a-z0-9+.-]{1,15}):\/\/([^\s"'<>/?#]+)/gi;
const CALLOUT_ELEMENT = /query|webservice|web_service|httprequest|http|restapi|rest_api|thirdparty|externaltransfer|callout|webhook|url|endpoint/i;
// Namespace and schema declarations name URLs that are never fetched.
const DECLARATIONS = /\s(?:xmlns(?::[\w.-]+)?|xsi:schemaLocation|xsi:noNamespaceSchemaLocation)\s*=\s*("[^"]*"|'[^']*')/g;

const ENTITY = /&(#x[0-9a-fA-F]+|#\d+|lt|gt|quot|apos|amp);/g;
const NAMED = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
export function decodeOnce(s) {
  return String(s).replace(ENTITY, (m, e) => {
    if (e[0] !== '#') return NAMED[e];
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try { return String.fromCodePoint(n); } catch { return m; }
  });
}
// Percent decode each run on its own, so one invalid sequence cannot hide the rest.
const percentRuns = (x) => x.replace(/(?:%[0-9a-fA-F]{2})+/g, (m) => { try { return decodeURIComponent(m); } catch { return m; } });

// The views of one document, without looking inside encoded payloads.
function baseViews(xml) {
  const base = String(xml).replace(DECLARATIONS, ' ');
  const out = [base];
  // Up to three rounds of entity decoding (double encoding), CDATA unwrapped, comments dropped.
  let v = base.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<!--[\s\S]*?-->/g, '');
  for (let i = 0; i < 3; i++) { out.push(v); const next = decodeOnce(v); if (next === v) break; v = next; }
  out.push(v);
  for (const x of [...out]) {
    const d = percentRuns(x);
    if (d !== x) out.push(d);
  }
  // Decoded text values from the parsed document.
  try {
    const walk = (n, acc) => {
      if (typeof n === 'string') acc.push(n);
      else if (Array.isArray(n)) n.forEach((x) => walk(x, acc));
      else if (n && typeof n === 'object') Object.values(n).forEach((x) => walk(x, acc));
      return acc;
    };
    out.push(walk(parseXml(base), []).join('\n'));
  } catch { /* unparseable: the raw views still apply */ }
  return out;
}

// ---------- encoded payloads ----------

// The designer stores text to speech documents (<ttsPrompt><xml>) and the TCPA
// consent text (<tcpaConsentText>) as gzip+base64, and Five9 parses what they
// inflate to. Every check runs on the decoded text too: gzip and zlib (any
// base64 run whose bytes carry the header), plain base64 text, and raw DEFLATE
// in those two payload elements, nested up to PAYLOAD_LIMITS.depth levels.
// A run that carries a gzip header but does not inflate, a payload element whose
// base64 decodes to nothing readable, or more than the limits allow makes the
// text UNDECODABLE: the server refuses it rather than send what it cannot check.
export const PAYLOAD_LIMITS = { depth: 3, count: 2000, bytes: 4_000_000, candidates: 20_000 };
export const ENCODED_PAYLOAD_PROBLEM = 'An encoded payload in this request (base64, gzip or zlib, for example the text to speech <xml> block of an IVR prompt) could not be decoded and checked, so it was not sent. Use the format the Five9 IVR designer writes, or plain text. Nothing was changed.';
const PAYLOAD_ELEMENT = /<\s*(?:[A-Za-z_][\w.-]*:)?(xml|tcpaConsentText)(?:\s[^>]*)?>([^<]*)<\//gi;
const B64_RUN = /[A-Za-z0-9+/_-]{16,}={0,2}/g;
const B64_ONLY = /^[A-Za-z0-9+/_-]+={0,2}$/;
const B64V = new Int8Array(128).fill(-1);
[...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].forEach((c, i) => { B64V[c.charCodeAt(0)] = i; });
B64V['-'.charCodeAt(0)] = 62;
B64V['_'.charCodeAt(0)] = 63;

function fromBase64(s) {
  const t = s.replace(/=+$/, '');
  if (t.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((t.length * 3) / 4));
  let acc = 0;
  let n = 0;
  let o = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    const v = c < 128 ? B64V[c] : -1;
    if (v < 0) return null;
    acc = ((acc << 6) | v) & 0xffffff;
    n += 6;
    if (n >= 8) { n -= 8; out[o++] = (acc >> n) & 255; }
  }
  return out.subarray(0, o);
}

const NOT_TEXT = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f�]/;
// Readable text, or null. A document may only declare an encoding the checks can read.
function textOf(bytes) {
  let b = bytes;
  let enc = 'utf-8';
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  else if ((b[0] === 0xfe && b[1] === 0xff) || (b[0] === 0 && b[1] === 0x3c)) enc = 'utf-16be';
  else if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0x3c && b[1] === 0)) enc = 'utf-16le';
  let s;
  try { s = new TextDecoder(enc, { fatal: true }).decode(b); } catch { s = null; }
  const decl = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([^"']*)["']/i.exec(s ?? new TextDecoder('windows-1252').decode(b.subarray(0, 200)));
  if (decl) {
    const name = decl[1].toLowerCase().replace(/[_\s]/g, '-');
    if (/^(iso-?8859-1|latin-?1|windows-1252|cp1252)$/.test(name) && enc === 'utf-8') s = new TextDecoder('windows-1252').decode(b);
    else if (!/^(utf-?8|utf-?16(le|be)?|us-ascii|ascii)$/.test(name)) return null;
  }
  return s === null || NOT_TEXT.test(s) ? null : s;
}

// { text, size } for a payload, { bad: true } for one that must be readable and is not, null for "not a payload".
function payloadOf(bytes, inElement, left) {
  const inflated = (fn) => {
    let out;
    try { out = fn(); } catch { return { bad: true }; }
    const text = textOf(out);
    return text === null ? { bad: true } : { text, size: out.length };
  };
  if (isGzip(bytes)) return inflated(() => gunzip(bytes, { max: left }));
  if (isZlib(bytes)) {
    const r = inflated(() => unzlib(bytes, { max: left }));
    if (!r.bad || inElement) return r;
  }
  const text = bytes.length ? textOf(bytes) : null;
  if (text !== null && text.trim()) return { text, size: bytes.length };
  return inElement && bytes.length ? inflated(() => inflateRaw(bytes, { max: left }).bytes) : null;
}

function candidates(text) {
  const out = new Map();
  const add = (c, inElement) => {
    if (c.length >= 16 && B64_ONLY.test(c)) out.set(c, out.get(c) === true || inElement);
  };
  for (const v of baseViews(text)) {
    // Plain words with spaces in a payload element are text, not a payload (gzip is still caught below).
    for (const m of v.matchAll(PAYLOAD_ELEMENT)) add(m[2].replace(/\s+/g, ''), !/\S\s+\S/.test(m[2]));
    // A payload wrapped over several lines inside one element.
    for (const m of v.matchAll(/>([^<]*)</g)) if (/\S\s+\S/.test(m[1])) add(m[1].replace(/\s+/g, ''), false);
    for (const m of v.matchAll(B64_RUN)) add(m[0], false);
  }
  return out;
}

function expand(text, depth, st) {
  const found = candidates(text);
  if (found.size > PAYLOAD_LIMITS.candidates) { st.bad = true; return; }
  const ok = [];
  const failed = [];
  for (const [c, inElement] of found) {
    if (st.bad) return;
    const bytes = fromBase64(c);
    if (!bytes) { if (inElement) failed.push(c); continue; }
    const p = payloadOf(bytes, inElement, PAYLOAD_LIMITS.bytes - st.bytes);
    if (!p) continue;
    if (p.bad) { failed.push(c); continue; }
    if (depth >= PAYLOAD_LIMITS.depth || st.texts.length >= PAYLOAD_LIMITS.count) { st.bad = true; return; }
    ok.push(c);
    st.bytes += p.size;
    st.texts.push(p.text);
    expand(p.text, depth + 1, st);
  }
  // A run that failed only because it is the first line of a wrapped payload that did decode is fine.
  if (failed.some((c) => !ok.some((o) => o !== c && o.startsWith(c)))) st.bad = true;
}

// The same large definition is checked several times per call (tiering, card,
// refusal checks), so the last few large results are kept.
const PAYLOAD_CACHE = new Map();
const NONE = Object.freeze({ texts: Object.freeze([]), bad: false });
// { texts: [decoded payload text, ...], bad: true when something could not be decoded }
export function decodePayloads(text) {
  const key = String(text);
  if (key.length < 16) return NONE; // too short to hold a payload
  const hit = PAYLOAD_CACHE.get(key);
  if (hit) return hit;
  const st = { texts: [], bad: false, bytes: 0 };
  try { expand(key, 0, st); } catch { st.bad = true; }
  const out = { texts: st.texts, bad: st.bad };
  if (key.length >= 256) {
    if (PAYLOAD_CACHE.size >= 8) PAYLOAD_CACHE.delete(PAYLOAD_CACHE.keys().next().value);
    PAYLOAD_CACHE.set(key, out);
  }
  return out;
}

export function hasUndecodablePayload(v, depth = 0) {
  if (depth > 32) return true;
  if (typeof v === 'string') return decodePayloads(v).bad;
  if (Array.isArray(v)) return v.some((x) => hasUndecodablePayload(x, depth + 1));
  if (v && typeof v === 'object') return Object.entries(v).some(([k, x]) => decodePayloads(k).bad || hasUndecodablePayload(x, depth + 1));
  return false;
}

// ---------- hosts ----------

// IPv4 the way inet_aton reads it: one to four parts, each decimal, octal
// (leading 0) or hex (0x), the last part filling the remaining bytes. Returns a
// dotted quad, or null when the host is not an IPv4 literal in any form.
export function inetAton(h) {
  const parts = String(h).split('.');
  if (parts.length > 4 || parts.some((p) => p === '')) return null;
  const nums = [];
  for (const p of parts) {
    if (/^0x[0-9a-f]*$/i.test(p)) nums.push(p.length > 2 ? parseInt(p.slice(2), 16) : 0);
    else if (/^0[0-7]*$/.test(p)) nums.push(parseInt(p, 8));
    else if (/^[1-9]\d*$/.test(p)) nums.push(Number(p));
    else return null;
  }
  const last = nums.pop();
  const room = 4 - nums.length;
  if (nums.some((n) => n > 255) || !Number.isFinite(last) || last > 2 ** (8 * room) - 1) return null;
  let v = 0;
  for (const n of nums) v = v * 256 + n;
  v = v * 2 ** (8 * room) + last;
  return [24, 16, 8, 0].map((b) => Math.floor(v / 2 ** b) % 256).join('.');
}
function cleanHost(a) {
  let h = a.trim();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1).toLowerCase();
  h = h.replace(/:\d*$/, '').toLowerCase().replace(/\.$/, '');
  return inetAton(h) ?? h;
}
// Every host a parser could take from this authority: the part after the last
// "@", and the part before the first backslash (with or without userinfo).
function hostsOf(authority) {
  const out = new Set();
  const afterAt = authority.slice(authority.lastIndexOf('@') + 1);
  for (const cand of [afterAt, afterAt.split('\\')[0], authority.split('\\')[0].split('@').pop()]) {
    const h = cleanHost(cand);
    if (h) out.add(h);
  }
  return out;
}

export const isIpHost = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || /^\[[0-9a-f:.]+\]$/i.test(h) || inetAton(String(h).replace(/\.$/, '')) !== null;

// Inside a decoded prompt payload, anything that names an audio source or a link is a call-out.
const PAYLOAD_SOURCE = [
  /<\s*(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*(?:audio|src|href|url|uri)[\w.-]*)(?=[\s/>])/gi,
  /\s((?:[A-Za-z_][\w.-]*:)?(?:src|href|url|uri))\s*=/gi,
  /<name>\s*(src|href|url|uri)\s*<\/name>/gi,
];

// Returns { hosts: [...], modules: [...], dynamic, undecodable, any }.
export function ivrCallouts(xml) {
  const hosts = new Set();
  const modules = new Set();
  const payload = decodePayloads(xml);
  const docs = [String(xml), ...payload.texts];
  let dynamic = false;
  for (const [i, doc] of docs.entries()) {
    for (const v of baseViews(doc)) {
      for (const m of v.matchAll(URL_RE)) for (const h of hostsOf(m[2])) hosts.add(h);
    }
    const base = doc.replace(DECLARATIONS, ' ');
    for (const v of [base, decodeOnce(base)]) {
      for (const m of v.matchAll(/<\s*(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)/g)) if (CALLOUT_ELEMENT.test(m[1])) modules.add(m[1]);
      if (i > 0) for (const re of PAYLOAD_SOURCE) for (const m of v.matchAll(re)) modules.add(m[1].replace(/^.*:/, ''));
    }
    // A URL built at run time: an url, uri or endpoint element whose text has no literal scheme://host.
    for (const m of decodeOnce(base).matchAll(/<\s*(?:[A-Za-z_][\w.-]*:)?((?:[A-Za-z_][\w.-]*)?(?:url|uri|endpoint)[\w.-]*)(?:\s[^>]*)?>([^<]*)</gi)) {
      if (m[2].trim() && !/[a-z][a-z0-9+.-]{1,15}:\/\/[^\s/]/i.test(m[2])) dynamic = true;
    }
  }
  return { hosts: [...hosts].sort(), modules: [...modules].sort(), dynamic, undecodable: payload.bad, any: hosts.size > 0 || modules.size > 0 || dynamic || payload.bad };
}

// ---------- the redaction marker ----------

// The literal marker that get_ivr_script and every other redacted result carry.
// Writing it back would store "[redacted]" in place of a real secret. It is
// found in every form Five9's parser would turn back into it: character
// references for either bracket or any letter (decimal or hex, mixed),
// named entities, percent encoding, CDATA, and inside encoded payloads.
const MARKER_TEXT = /\[\s*redacted\s*\]/i;
export const REDACTION_MARKER_PROBLEM = 'This request contains [redacted] placeholders copied from an earlier result (for example get_ivr_script). Five9 would store them in place of the real secrets. Re-supply the real values, or edit only the part that changes (for an IVR script, use the Five9 IVR designer). Nothing was changed.';

function markerIn(s) {
  let v = String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  for (let i = 0; i < 4; i++) {
    if (MARKER_TEXT.test(v) || MARKER_TEXT.test(percentRuns(v))) return true;
    const next = decodeOnce(v);
    if (next === v) break;
    v = next;
  }
  return MARKER_TEXT.test(v) || MARKER_TEXT.test(percentRuns(v));
}
const markerOrPayload = (s) => markerIn(s) || decodePayloads(s).texts.some(markerIn);

export function hasRedactionMarker(v, depth = 0) {
  if (depth > 32) return false;
  if (typeof v === 'string') return markerOrPayload(v);
  if (Array.isArray(v)) return v.some((x) => hasRedactionMarker(x, depth + 1));
  if (v && typeof v === 'object') return Object.entries(v).some(([k, x]) => markerOrPayload(k) || hasRedactionMarker(x, depth + 1));
  return false;
}

// ---------- XXE ----------

// DOCTYPE, ENTITY and conditional sections in XML sent to Five9 could make its
// parser resolve external entities (XXE). Five9's designer never writes them,
// in a script or in the documents its payloads carry. XInclude is refused for the same reason.
export const XML_DECLARATION_RE = /<!DOCTYPE|<!ENTITY|<!\[\s*INCLUDE|<!\[\s*IGNORE|w3\.org\/2001\/XInclude/i;
export const XML_DECLARATION_PROBLEM = 'XML definitions cannot contain DOCTYPE, ENTITY, conditional section or XInclude declarations, also inside encoded payloads. Nothing was changed.';
export function hasXmlDeclarations(v, depth = 0) {
  if (depth > 32) return false;
  if (typeof v === 'string') return XML_DECLARATION_RE.test(v) || decodePayloads(v).texts.some((t) => XML_DECLARATION_RE.test(t));
  if (Array.isArray(v)) return v.some((x) => hasXmlDeclarations(x, depth + 1));
  if (v && typeof v === 'object') return Object.values(v).some((x) => hasXmlDeclarations(x, depth + 1));
  return false;
}
