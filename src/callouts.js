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
const URL_RE = /\b([a-z][a-z0-9+.-]{1,15}):\/\/([^\s"'<>/?#\\]+)/gi;
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
    try { const d = decodeURIComponent(x.replace(/%(?![0-9a-fA-F]{2})/g, '%25')); if (d !== x) out.push(d); } catch { /* not percent encoded */ }
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

function hostOf(authority) {
  let a = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
  if (a.startsWith('[')) return a.slice(0, a.indexOf(']') + 1).toLowerCase();
  a = a.replace(/:\d*$/, '');
  return a.toLowerCase().replace(/\.$/, '');
}

// Returns { hosts: [...], modules: [...], any }.
export function ivrCallouts(xml) {
  const hosts = new Set();
  const modules = new Set();
  for (const v of views(xml)) {
    for (const m of v.matchAll(URL_RE)) {
      const h = hostOf(m[2]);
      if (h) hosts.add(h);
    }
  }
  const base = String(xml).replace(DECLARATIONS, ' ');
  for (const v of [base, decodeOnce(base)]) {
    for (const m of v.matchAll(/<\s*(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)/g)) if (CALLOUT_ELEMENT.test(m[1])) modules.add(m[1]);
  }
  return { hosts: [...hosts].sort(), modules: [...modules].sort(), any: hosts.size > 0 || modules.size > 0 };
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
