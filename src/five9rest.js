// Five9 "New Platform" REST client — OAuth 2.0 client-credentials, bearer-token
// APIs (Enhanced Routing, Agent Sessions, …). Separate surface from the SOAP
// Configuration/Statistics Web Services in five9.js.
//
// Design goals: match five9.js — zero dependencies, stateless per request. A
// bearer token is fetched on demand and cached in-memory for the life of one
// client instance (i.e. one Worker request); cross-request caching (KV) is a
// deliberate future optimization, not needed for correctness.
//
// Docs: https://documentation.five9.com/bundle/api-docs (Getting Started).
//   Auth:  POST https://{baseUrl}/oauth2/v1/token  (grant_type=client_credentials,
//          Consumer Key/Secret as HTTP Basic) -> { access_token, expires_in, … }
//          (Five9's getting-started doc says /v1/auth/token, but the live
//           endpoint is /oauth2/v1/token — verified against a real domain.)
//   Calls: Authorization: Bearer {token}
//   Rate limits: 5 req/s/user, 5 parallel users; 429 -> honor Retry-After then
//                exponential backoff (1s,2s,4s,8s); 5xx -> backoff, ≤5 retries.
//   Concurrency: ETag on reads, If-Match on writes -> 412 Precondition Failed.

import { Five9Error } from './five9.js';
import { REGION_BASE_URLS, REST_METHODS, resolveRestBase, pathRefusal, queryRefusal } from './rest-rules.js';

// A REST error that the MCP layer surfaces gracefully (extends Five9Error so
// index.js's `e instanceof Five9Error` catch turns it into an isError result).
export class Five9RestError extends Five9Error {}

// Host, path, and query rules live in rest-rules.js (pure, unit tested).
export { REGION_BASE_URLS };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Backoff schedule for 429/5xx retries: 1s, 2s, 4s, 8s, 8s…
const backoffMs = (attempt) => [1000, 2000, 4000, 8000][Math.min(attempt, 3)];

export class Five9RestClient {
  // cfg: { restCredentials: { <name>: {key, secret} }, restConsumerKey,
  //        restConsumerSecret, restDomainId, restRegion, restBaseUrl } — see
  //        config.js. Supports multiple named credentials (different API
  //        families), e.g. 'default' (all-apis-access) and 'data-tables'.
  constructor(cfg) {
    this.credentials = { ...(cfg?.restCredentials || {}) };
    if (!this.credentials.default && cfg?.restConsumerKey) {
      this.credentials.default = { key: cfg.restConsumerKey, secret: cfg.restConsumerSecret };
    }
    this.domainId = cfg?.restDomainId || '';
    this.region = (cfg?.restRegion || 'US').toUpperCase();
    this.baseUrl = (cfg?.restBaseUrl || REGION_BASE_URLS[this.region] || REGION_BASE_URLS.US).replace(/\/+$/, '');
    this.readOnly = Boolean(cfg?.readOnly);
    this.maxRetries = 5;
    this._tokens = {}; // credentialName -> { token, expiry }
  }

  // OAuth 2.0 client-credentials grant for a named credential (default
  // 'default'). Cached per credential until ~30s before expiry.
  async getToken(credentialName = 'default') {
    const cred = Object.hasOwn(this.credentials, credentialName) ? this.credentials[credentialName] : null;
    if (!cred?.key || !cred?.secret) {
      throw new Five9RestError(
        credentialName === 'default'
          ? 'No New Platform credential configured — set FIVE9_CONSUMER_KEY / FIVE9_CONSUMER_SECRET (and FIVE9_DOMAIN_ID, FIVE9_REST_REGION). Generate them under Admin Console > API Access Control.'
          : `No '${credentialName}' New Platform credential configured — set its consumer key/secret (e.g. FIVE9_DT_CONSUMER_KEY / FIVE9_DT_CONSUMER_SECRET for data-tables).`
      );
    }
    const cached = this._tokens[credentialName];
    if (cached && Date.now() < cached.expiry) return cached.token;
    const res = await fetch(`${this._origin()}/oauth2/v1/token`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Authorization: 'Basic ' + btoa(`${cred.key}:${cred.secret}`),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Five9RestError(`Five9 token request failed for '${credentialName}' (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }
    let data;
    try { data = JSON.parse(text); } catch {
      throw new Five9RestError(`Five9 token response was not JSON: ${text.slice(0, 200)}`);
    }
    if (!data.access_token) {
      throw new Five9RestError(`Five9 token response had no access_token: ${text.slice(0, 200)}`);
    }
    const ttl = Number(data.expires_in) || 3600;
    this._tokens[credentialName] = { token: data.access_token, expiry: Date.now() + Math.max(30, ttl - 30) * 1000 };
    return data.access_token;
  }

  // Which credential names are configured.
  credentialNames() { return Object.keys(this.credentials).filter((n) => this.credentials[n]?.key); }

  // The https origin the token may be sent to. rest_call's base_url may only
  // name an official regional Five9 API host (or the configured one); a
  // prompt-injected base_url must never receive a live bearer token.
  _origin(requested) {
    const { origin, error } = resolveRestBase(requested, this.baseUrl);
    if (error) throw new Five9RestError(error);
    return origin;
  }

  // Substitute path placeholders and normalize to a leading slash.
  _resolvePath(path) {
    let p = String(path || '');
    p = p.replace(/\{domainId\}/g, encodeURIComponent(this.domainId));
    if (!p.startsWith('/')) p = '/' + p;
    return p;
  }

  // Authenticated REST call with rate-limit / retry handling. Returns
  // { status, etag, data } where data is parsed JSON (or text, or null).
  async request(method, path, { query, body, ifMatch, headers, credential = 'default', baseUrl } = {}) {
    // Every check runs before any token is fetched or sent.
    const m = String(method || 'GET').toUpperCase();
    if (!REST_METHODS.includes(m)) throw new Five9RestError(`HTTP method ${m} is not allowed.`);
    if (this.readOnly && m !== 'GET') {
      throw new Five9RestError(`${m} ${path} is blocked: this server is in read-only mode (FIVE9_READ_ONLY).`);
    }
    const base = this._origin(baseUrl);
    if (String(path || '').includes('{domainId}') && !this.domainId) {
      throw new Five9RestError('FIVE9_DOMAIN_ID is not configured, so {domainId} cannot be filled in.');
    }
    const resolved = this._resolvePath(path);
    const refusal = pathRefusal(resolved, { encoded: true }) || queryRefusal(query);
    if (refusal) throw new Five9RestError(refusal);
    const token = await this.getToken(credential);
    let url = base + resolved;
    if (query && Object.keys(query).length) {
      const qs = new URLSearchParams(query).toString();
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    }
    const h = { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(headers || {}) };
    let payload;
    if (body !== undefined && body !== null) {
      h['Content-Type'] = 'application/json';
      payload = typeof body === 'string' ? body : JSON.stringify(body);
    }
    if (ifMatch) h['If-Match'] = ifMatch;

    for (let attempt = 0; ; attempt++) {
      // No redirects: a 3xx must not carry the bearer token to another host.
      const res = await fetch(url, { method: m, headers: h, body: payload, redirect: 'manual' });
      // 429: honor Retry-After (seconds) if present, else backoff.
      if (res.status === 429 && attempt < this.maxRetries) {
        const ra = Number(res.headers.get('Retry-After'));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoffMs(attempt));
        continue;
      }
      // 5xx: transient — retry with backoff.
      if (res.status >= 500 && res.status < 600 && attempt < this.maxRetries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      return this._parse(res, m, url);
    }
  }

  async _parse(res, method, url) {
    const etag = res.headers.get('ETag') || undefined;
    const text = await res.text();
    if (res.status === 412) {
      throw new Five9RestError(`Five9 REST 412 Precondition Failed on ${method} ${url} — the resource changed since your ETag; re-read it and retry with the new If-Match.`);
    }
    if (!res.ok) {
      throw new Five9RestError(`Five9 REST HTTP ${res.status} on ${method} ${url}: ${text.slice(0, 400)}`);
    }
    let data = null;
    if (text) {
      const ct = res.headers.get('Content-Type') || '';
      if (ct.includes('json')) {
        try { data = JSON.parse(text); } catch { data = text; }
      } else {
        data = text;
      }
    }
    return { status: res.status, etag, data };
  }

  // Acquire a token and report connection metadata (no business call).
  async checkConnection(credential = 'default') {
    await this.getToken(credential);
    return {
      ok: true,
      baseUrl: this.baseUrl,
      region: this.region,
      domainId: this.domainId || null,
      credential,
      configuredCredentials: this.credentialNames(),
      tokenType: 'Bearer',
      note: 'OAuth client-credentials token acquired successfully. This verifies API Access Control is enabled and the Consumer Key/Secret are valid.',
    };
  }

  // ---- Typed New Platform endpoints (paths verified against a live domain) ----

  // Cursor-paged GET. Returns { items, count, nextCursor } — pass nextCursor
  // back as `cursor` to fetch the following page. `credential` selects the API
  // family credential (default 'default').
  async listPaged(path, { cursor, limit, credential } = {}) {
    const query = {};
    if (limit) query.pageLimit = String(limit);
    if (cursor) query.pageCursor = cursor;
    const { data } = await this.request('GET', path, { query, credential });
    const items = Array.isArray(data?.items) ? data.items : [];
    let nextCursor = null;
    const next = data?.paging?.next;
    if (next) { const m = /[?&]pageCursor=([^&]+)/.exec(next); nextCursor = m ? decodeURIComponent(m[1]) : null; }
    return { items, count: items.length, nextCursor };
  }

  // Circles — list / get / create / delete. No SOAP equivalent.
  listCircles(opts) { return this.listPaged('/circles/v1/domains/{domainId}/circles', opts); }
  async getCircle(id) {
    if (!id) throw new Five9RestError('circle_id is required.');
    const { data } = await this.request('GET', `/circles/v1/domains/{domainId}/circles/${encodeURIComponent(id)}`);
    return data;
  }
  async createCircle(fields) {
    if (!fields?.name) throw new Five9RestError('name is required.');
    const { data } = await this.request('POST', '/circles/v1/domains/{domainId}/circles', { body: fields });
    return { ok: true, created: fields.name, id: data?.id ?? null, circle: data };
  }
  async deleteCircle(id) {
    if (!id) throw new Five9RestError('circle_id is required.');
    await this.request('DELETE', `/circles/v1/domains/{domainId}/circles/${encodeURIComponent(id)}`);
    return { ok: true, deleted: id };
  }

  // New Platform voice prompts (read).
  listNpPrompts(opts) { return this.listPaged('/prompts/v1/domains/{domainId}/prompts', opts); }

  // Interaction dispositions (read-only via this API; richer than SOAP).
  listDispositions(opts) { return this.listPaged('/interactions/v1/domains/{domainId}/dispositions', opts); }
  async getDisposition(id) {
    if (!id) throw new Five9RestError('disposition_id is required.');
    const { data } = await this.request('GET', `/interactions/v1/domains/{domainId}/dispositions/${encodeURIComponent(id)}`);
    return data;
  }

  // Domain metadata (id, name, tenant, service endpoints).
  async getDomainInfo() {
    const { data } = await this.request('GET', '/domains/v1/domains/{domainId}');
    return data;
  }

  // Data Tables — structured lookup tables (uses the 'data-tables' credential).
  listDataTables(opts = {}) {
    return this.listPaged('/data-tables/v1/domains/{domainId}/data-tables', { ...opts, credential: 'data-tables' });
  }
  getDataTableRows(tableId, opts = {}) {
    if (!tableId) throw new Five9RestError('table_id is required.');
    return this.listPaged(`/data-tables/v1/domains/{domainId}/data-tables/${encodeURIComponent(tableId)}/data`, { ...opts, credential: 'data-tables' });
  }
}
