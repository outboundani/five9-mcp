// Pure safety rules for the New Platform REST client and the raw rest_call
// tool. No I/O here, so every "where may the token go / is this call allowed"
// decision is unit tested in test/rest-rules.test.mjs.
//
// Rules return null when allowed, or a refusal string that the caller raises
// as a Five9RestError.

// Region -> API base URL. See "Getting Started with Five9 New Platform APIs".
export const REGION_BASE_URLS = {
  US: 'https://api.prod.us.five9.net',
  'US-ALPHA': 'https://api.alpha.us.five9.net',
  CA: 'https://api.prod.ca.five9.net',
  EU: 'https://api.prod.eu.five9.net',
  IN: 'https://api.prod.in.five9.net',
  UK: 'https://api.prod.uk.five9.net',
};

// The only hosts a caller-supplied base_url may name (exact match).
export const REST_HOSTS = new Set(Object.values(REGION_BASE_URLS).map((u) => new URL(u).hostname));

export const REST_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

// ---------- host: the bearer token only goes to Five9 ----------

// Parse a base URL down to a bare https origin, or explain why not.
function parseOrigin(base) {
  const raw = String(base ?? '').replace(/\/+$/, '');
  if (!/^[\x21-\x7e]+$/.test(raw)) return { error: `Invalid base URL: ${JSON.stringify(String(base ?? ''))}` };
  let u;
  try { u = new URL(raw); } catch { return { error: `Invalid base URL: ${raw}` }; }
  if (u.protocol !== 'https:') return { error: `Refusing to send a Five9 token over a non-HTTPS URL: ${raw}` };
  if (u.username || u.password) return { error: 'Refusing a base URL with embedded credentials (user@host).' };
  if (u.port) return { error: 'Refusing a base URL with an explicit port.' };
  if (u.pathname !== '/' || u.search || u.hash) return { error: 'The base URL must be a bare origin such as https://api.prod.us.five9.net (no path, query, or fragment).' };
  return { origin: `https://${u.hostname}`, host: u.hostname };
}

const isFive9Domain = (h) => h === 'five9.net' || h === 'five9.com' || h.endsWith('.five9.net') || h.endsWith('.five9.com');

// configured: the operator's base (FIVE9_REST_BASE_URL or the region default).
// It must be https on a five9.net / five9.com host.
// requested: the caller's base_url (reachable by the connected AI). It must be
// exactly one of the official regional API hosts, or the configured host.
// Returns { origin } or { error }.
export function resolveRestBase(requested, configured) {
  const conf = parseOrigin(configured);
  if (conf.error) return { error: `Configured REST base URL rejected: ${conf.error}` };
  if (!REST_HOSTS.has(conf.host) && !isFive9Domain(conf.host)) {
    return { error: `Configured REST base URL host "${conf.host}" is not a Five9 host.` };
  }
  if (requested === undefined || requested === null || requested === '') return { origin: conf.origin };
  const req = parseOrigin(requested);
  if (req.error) return { error: req.error };
  if (!REST_HOSTS.has(req.host) && req.host !== conf.host) {
    return { error: `Refusing to send a Five9 token to "${req.host}". base_url must be one of: ${[...new Set([...REST_HOSTS, conf.host])].map((h) => `https://${h}`).join(', ')}.` };
  }
  return { origin: req.origin };
}

// ---------- path and query ----------

const SEGMENT = /^[A-Za-z0-9._~:-]+$/;

// strict (rest_call): no percent-encoding at all, plain segment characters.
// encoded (typed tools, which encodeURIComponent their ids): %XX allowed, but
// no segment may decode to "", ".", "..", or contain / \ %.
export function pathRefusal(path, { encoded = false } = {}) {
  if (typeof path !== 'string' || !path) return 'Refused: path is required.';
  if (!path.startsWith('/')) return 'Refused: path must start with "/", e.g. "/interactions/v1/domains/{domainId}/dispositions".';
  if (path.length > 2048) return 'Refused: path is too long.';
  if (/[\s\x00-\x1f\x7f\\?#;]/.test(path)) return 'Refused: the path may not contain whitespace, control characters, \\, ?, #, or ; (pass query parameters in `query`).';
  if (!encoded && path.includes('%')) return 'Refused: percent-encoding is not allowed in the path.';
  for (const seg of path.slice(1).split('/')) {
    if (seg === '{domainId}') continue;
    let s = seg;
    if (encoded) {
      try { s = decodeURIComponent(seg); } catch { return 'Refused: malformed percent-encoding in the path.'; }
      if (/[/\\%]/.test(s)) return 'Refused: path segments may not encode /, \\, or %.';
    }
    if (s === '' || s === '.' || s === '..') return 'Refused: empty, "." and ".." path segments are not allowed.';
    if (!encoded && !SEGMENT.test(seg)) return `Refused: path segment "${seg}" may only use letters, digits, and . _ ~ : - (plus the {domainId} placeholder).`;
  }
  return null;
}

// Query keys are plain identifiers, unique ignoring case (servers bind the
// first value, JS keeps the last), with single scalar values.
export function queryRefusal(query) {
  if (query === undefined || query === null) return null;
  if (typeof query !== 'object' || Array.isArray(query)) return 'Refused: query must be an object of name -> value.';
  const keys = Object.keys(query);
  if (keys.some((k) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(k))) return 'Refused: query parameter names must be plain identifiers.';
  const lower = keys.map((k) => k.toLowerCase());
  if (new Set(lower).size !== lower.length) return 'Refused: duplicate query parameters are not allowed.';
  const scalar = (v) => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
  if (!Object.values(query).every(scalar)) return 'Refused: query values must be single scalars (string, number, or boolean).';
  return null;
}

// ---------- rest_call only ----------

// The raw tool may configure the domain, but it may not start dialing or
// drive live interactions: campaign state goes through control_campaign,
// which the operator instructions gate on user confirmation. Any non-GET
// whose path touches these resources or verbs is refused.
const LIVE_SEGMENT = /^(campaigns?|calls?|dials?|dialer|dialing|outbound|callbacks?|sessions?|agent-?sessions|conversations?|start|stop|state|states)$/i;

export function liveControlRefusal(method, path) {
  if (method === 'GET') return null;
  const segs = String(path || '').split('/').filter(Boolean);
  // "interactions" as the first segment is the API family (dispositions live
  // there); anywhere later it names live interactions.
  const hit = segs.find((s, i) => LIVE_SEGMENT.test(s) || (i > 0 && /^interactions?$/i.test(s)));
  if (!hit) return null;
  return `Refused: rest_call does not send ${method} to "${hit}" endpoints. Starting or stopping dialing and controlling live calls, sessions, or interactions are out of scope for the raw tool; use control_campaign (with the user's confirmation) for campaign state.`;
}

export function credentialRefusal(name, configured = []) {
  if (typeof name === 'string' && configured.includes(name)) return null;
  const list = configured.length ? configured.join(', ') : 'none (set FIVE9_CONSUMER_KEY / FIVE9_CONSUMER_SECRET)';
  return `Refused: credential ${JSON.stringify(name)} is not configured on this server. Configured credentials: ${list}.`;
}

export function restCallRefusal({ method, path, query, body, credential, credentials }) {
  const m = String(method || 'GET').toUpperCase();
  if (!REST_METHODS.includes(m)) return `Refused: method ${m} is not allowed.`;
  const r = pathRefusal(path) || queryRefusal(query) || liveControlRefusal(m, path) || credentialRefusal(credential, credentials);
  if (r) return r;
  if (body !== undefined && body !== null) {
    if (typeof body !== 'object' || Array.isArray(body)) return 'Refused: body must be a single JSON object.';
    if (m === 'GET') return 'Refused: GET requests take no body.';
  }
  return null;
}

// ---------- response redaction ----------

// Scrub secret-looking fields (passwords, client secrets, tokens, API keys,
// credentials) from raw responses before they reach the model.
const SECRET_KEY = /passw|pwd|secret|token|api_?key|credential|securitykey/i;

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) && v !== null && v !== '' ? '[redacted]' : redactSecrets(v);
  }
  return out;
}
