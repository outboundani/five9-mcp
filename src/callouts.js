// Outside call-outs in Five9 IVR script XML, and the redaction marker check.
//
// An IVR script can make outbound HTTP requests with call data (query or web
// service modules). That is data egress, so the server must see every host a
// definition reaches, however it is written: plain, entity encoded, inside
// CDATA, in an attribute, or percent encoded. Several views of the same text are
// scanned and the union of hosts is returned. Element names that look like a
// call-out module are flagged even when no URL can be parsed (the URL may be
// built from variables at run time).

import { parseXml } from './five9.js';

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

function views(xml) {
  const base = String(xml).replace(DECLARATIONS, ' ');
  const out = [base];
  // Up to three rounds of entity decoding (double encoding), CDATA unwrapped.
  let v = base.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  for (let i = 0; i < 3; i++) { out.push(v); const next = decodeOnce(v); if (next === v) break; v = next; }
  out.push(v);
  for (const x of [...out]) {
    // Percent decode each run on its own, so one invalid sequence cannot hide the rest.
    const d = x.replace(/(?:%[0-9a-fA-F]{2})+/g, (m) => { try { return decodeURIComponent(m); } catch { return m; } });
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

// Integer and hex IPv4 forms ("3405803826", "0xcb007132") as dotted quads.
function normalizeIp(h) {
  let n = null;
  if (/^\d+$/.test(h)) n = Number(h);
  else if (/^0x[0-9a-f]+$/i.test(h)) n = parseInt(h, 16);
  if (n !== null && Number.isFinite(n) && n >= 0 && n <= 0xffffffff) return [24, 16, 8, 0].map((b) => (n >>> b) & 255).join('.');
  return h;
}
function cleanHost(a) {
  let h = a.trim();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1).toLowerCase();
  h = h.replace(/:\d*$/, '').toLowerCase().replace(/\.$/, '');
  return normalizeIp(h);
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

export const isIpHost = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || /^\[[0-9a-f:.]+\]$/i.test(h);

// Returns { hosts: [...], modules: [...], any }.
export function ivrCallouts(xml) {
  const hosts = new Set();
  const modules = new Set();
  for (const v of views(xml)) {
    for (const m of v.matchAll(URL_RE)) for (const h of hostsOf(m[2])) hosts.add(h);
  }
  const base = String(xml).replace(DECLARATIONS, ' ');
  for (const v of [base, decodeOnce(base)]) {
    for (const m of v.matchAll(/<\s*(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)/g)) if (CALLOUT_ELEMENT.test(m[1])) modules.add(m[1]);
  }
  // A URL built at run time: an url, uri or endpoint element whose text has no literal scheme://host.
  let dynamic = false;
  for (const m of decodeOnce(base).matchAll(/<\s*(?:[A-Za-z_][\w.-]*:)?((?:[A-Za-z_][\w.-]*)?(?:url|uri|endpoint)[\w.-]*)(?:\s[^>]*)?>([^<]*)</gi)) {
    if (m[2].trim() && !/[a-z][a-z0-9+.-]{1,15}:\/\/[^\s/]/i.test(m[2])) dynamic = true;
  }
  return { hosts: [...hosts].sort(), modules: [...modules].sort(), dynamic, any: hosts.size > 0 || modules.size > 0 || dynamic };
}

// The literal marker that get_ivr_script and every other redacted result carry,
// and its encoded forms. Writing it back would store "[redacted]" in place of a
// real secret.
const MARKER = /\[redacted\]|&#0*91;redacted&#0*93;|&#x0*5b;redacted&#x0*5d;|%5bredacted%5d/i;
export const REDACTION_MARKER_PROBLEM = 'This request contains [redacted] placeholders copied from an earlier result (for example get_ivr_script). Five9 would store them in place of the real secrets. Re-supply the real values, or edit only the part that changes (for an IVR script, use the Five9 IVR designer). Nothing was changed.';

export function hasRedactionMarker(v, depth = 0) {
  if (depth > 32) return false;
  if (typeof v === 'string') return MARKER.test(v);
  if (Array.isArray(v)) return v.some((x) => hasRedactionMarker(x, depth + 1));
  if (v && typeof v === 'object') return Object.entries(v).some(([k, x]) => MARKER.test(k) || hasRedactionMarker(x, depth + 1));
  return false;
}

// DOCTYPE, ENTITY and conditional sections in XML sent to Five9 could make its
// parser resolve external entities (XXE). Five9's designer never writes them.
export const XML_DECLARATION_RE = /<!DOCTYPE|<!ENTITY|<!\[\s*INCLUDE|<!\[\s*IGNORE/i;
export const XML_DECLARATION_PROBLEM = 'XML definitions cannot contain DOCTYPE, ENTITY or conditional section declarations. Nothing was changed.';
export function hasXmlDeclarations(v, depth = 0) {
  if (depth > 32) return false;
  if (typeof v === 'string') return XML_DECLARATION_RE.test(v);
  if (Array.isArray(v)) return v.some((x) => hasXmlDeclarations(x, depth + 1));
  if (v && typeof v === 'object') return Object.values(v).some((x) => hasXmlDeclarations(x, depth + 1));
  return false;
}
