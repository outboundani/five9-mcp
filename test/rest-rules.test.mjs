// rest_call hardening: the OAuth bearer token may only reach official Five9
// hosts, paths and queries are validated before a URL is built, live-dialing
// writes are refused, and secret-looking response fields are redacted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRestBase, pathRefusal, queryRefusal, liveControlRefusal, credentialRefusal, restCallRefusal, redactSecrets, REGION_BASE_URLS } from '../src/rest-rules.js';
import { Five9RestClient, Five9RestError } from '../src/five9rest.js';
import { callTool } from '../src/tools.js';

const US = REGION_BASE_URLS.US;

test('base_url: exfiltration attempts are refused', () => {
  for (const b of [
    'http://evil.com',
    'https://evil.com',
    'http://api.prod.us.five9.net',
    'https://api.prod.us.five9.net.evil.com',
    'https://api.five9.com.evil.com',
    'https://api.prod.us.five9.net@evil.com',
    'https://api.five9.com@evil.com',
    'https://user:pass@api.prod.us.five9.net',
    'https://evil.com/api.prod.us.five9.net',
    'https://evil.com?x=api.prod.us.five9.net',
    'https://evil.com#api.prod.us.five9.net',
    'https://api.prod.us.five9.net\\@evil.com',
    'https://api.prod.us.five9.net:8443',
    'https://api.prod.us.five9.net/some/path',
    'https://api.prod.us.five9.net.',
    'https://1.2.3.4',
    'https://[::1]',
    'https://2130706433',
    'https://evilfive9.net',
    'https://attacker.five9.net',
    'https://api.five9.com',
    'https://api.prod.us.five9.net %0d',
    'javascript:alert(1)',
    'not a url',
  ]) {
    const r = resolveRestBase(b, US);
    assert.ok(r.error && !r.origin, b);
  }
});

test('base_url: official regional hosts and the configured host are allowed', () => {
  assert.deepEqual(resolveRestBase(undefined, US), { origin: US });
  assert.deepEqual(resolveRestBase('', US), { origin: US });
  for (const u of Object.values(REGION_BASE_URLS)) assert.deepEqual(resolveRestBase(u, US), { origin: u });
  assert.deepEqual(resolveRestBase('https://API.PROD.EU.FIVE9.NET/', US), { origin: REGION_BASE_URLS.EU });
  // An operator-pinned five9 host is honored, and may be named explicitly.
  assert.deepEqual(resolveRestBase(undefined, 'https://api.prod.au.five9.net'), { origin: 'https://api.prod.au.five9.net' });
  assert.deepEqual(resolveRestBase('https://api.prod.au.five9.net', 'https://api.prod.au.five9.net'), { origin: 'https://api.prod.au.five9.net' });
});

test('configured base URL must itself be an https Five9 origin', () => {
  for (const c of ['https://evil.com', 'http://api.prod.us.five9.net', 'https://api.prod.us.five9.net@evil.com', 'https://api.prod.us.five9.net/x']) {
    assert.ok(resolveRestBase(undefined, c).error, c);
  }
});

test('path: traversal and encoding tricks are refused', () => {
  for (const p of [
    '', 'interactions/v1/x', '/', '//evil.com/x', '/a//b', '/a/./b', '/a/../b', '/..', '/a/..',
    '/a/%2e%2e/b', '/a/%2E%2E', '/a%2fb', '/a/b%00', '/a;b=c', '/a\\b', '/a?x=1', '/a#frag',
    '/a b', '/a\tb', '/a\nb', '/a/{other}', '/a/{domainId}x', '/a/b@c', '/a/<b>',
  ]) {
    assert.ok(pathRefusal(p), JSON.stringify(p));
  }
});

test('path: normal New Platform paths are allowed', () => {
  for (const p of [
    '/interactions/v1/domains/{domainId}/dispositions',
    '/circles/v1/domains/{domainId}/circles/abc-123',
    '/data-tables/v1/domains/{domainId}/data-tables/1f2e_3d.4c~5b/data',
    '/domains/v1/domains/{domainId}',
    '/prompts/v1/domains/{domainId}/prompts',
  ]) {
    assert.equal(pathRefusal(p), null, p);
  }
});

test('path (encoded mode, typed tools): %XX ok, encoded traversal is not', () => {
  assert.equal(pathRefusal('/circles/v1/domains/131109/circles/a%20b'), 'Refused: percent-encoding is not allowed in the path.');
  assert.equal(pathRefusal('/circles/v1/domains/131109/circles/a%20b', { encoded: true }), null);
  for (const p of ['/c/..', '/c/%2e%2E', '/c/.', '/c/a%2Fb', '/c/a%5Cb', '/c/%252e%252e', '/c/%zz', '/c//d']) {
    assert.ok(pathRefusal(p, { encoded: true }), p);
  }
});

test('query: identifiers, no duplicates, scalar values', () => {
  assert.equal(queryRefusal(undefined), null);
  assert.equal(queryRefusal({ pageLimit: '10', pageCursor: 'abc', flag: true, n: 5 }), null);
  assert.ok(queryRefusal({ 'a b': '1' }));
  assert.ok(queryRefusal({ 'x[0]': '1' }));
  assert.ok(queryRefusal({ '1a': '1' }));
  assert.ok(queryRefusal({ limit: '1', LIMIT: '2' }));
  assert.ok(queryRefusal({ a: ['1', '2'] }));
  assert.ok(queryRefusal({ a: { b: 1 } }));
  assert.ok(queryRefusal({ a: null }));
  assert.ok(queryRefusal({ a: NaN }));
  assert.ok(queryRefusal(['a']));
  assert.ok(queryRefusal('a=1'));
});

test('live control: non-GET dialing / live-interaction endpoints are refused', () => {
  for (const [m, p] of [
    ['POST', '/campaigns/v1/domains/{domainId}/campaigns/42/start'],
    ['PUT', '/campaigns/v1/domains/{domainId}/campaigns/42/state'],
    ['PATCH', '/x/v1/domains/{domainId}/campaign/42'],
    ['POST', '/interactions/v1/domains/{domainId}/interactions/9/transfer'],
    ['DELETE', '/interactions/v1/domains/{domainId}/interactions/9'],
    ['POST', '/voice/v1/domains/{domainId}/calls'],
    ['POST', '/agent-sessions/v1/domains/{domainId}/sessions'],
    ['POST', '/x/v1/domains/{domainId}/outbound/dial'],
    ['POST', '/x/v1/domains/{domainId}/callbacks'],
  ]) {
    assert.ok(liveControlRefusal(m, p), `${m} ${p}`);
  }
  assert.equal(liveControlRefusal('GET', '/campaigns/v1/domains/{domainId}/campaigns/42/state'), null);
  assert.equal(liveControlRefusal('POST', '/interactions/v1/domains/{domainId}/dispositions'), null);
  assert.equal(liveControlRefusal('DELETE', '/circles/v1/domains/{domainId}/circles/7'), null);
});

test('credential: only configured names', () => {
  assert.equal(credentialRefusal('default', ['default', 'data-tables']), null);
  assert.equal(credentialRefusal('data-tables', ['default', 'data-tables']), null);
  for (const n of ['data-tables', '__proto__', 'constructor', 'toString', '', undefined, 7]) {
    assert.ok(credentialRefusal(n, ['default']), String(n));
  }
});

test('restCallRefusal: methods and bodies', () => {
  const base = { path: '/circles/v1/domains/{domainId}/circles', credential: 'default', credentials: ['default'] };
  assert.equal(restCallRefusal({ ...base, method: 'GET' }), null);
  assert.equal(restCallRefusal({ ...base, method: 'post', body: { name: 'x' } }), null);
  assert.equal(restCallRefusal({ ...base, method: 'DELETE', path: '/circles/v1/domains/{domainId}/circles/7' }), null);
  assert.ok(restCallRefusal({ ...base, method: 'TRACE' }));
  assert.ok(restCallRefusal({ ...base, method: 'CONNECT' }));
  assert.ok(restCallRefusal({ ...base, method: 'GET', body: { a: 1 } }));
  assert.ok(restCallRefusal({ ...base, method: 'POST', body: [1] }));
  assert.ok(restCallRefusal({ ...base, method: 'POST', body: 'raw' }));
});

test('redactSecrets scrubs secret-looking keys at any depth, case-insensitive', () => {
  const out = redactSecrets({
    name: 'ok', password: 'p', Password: 'p', clientSecret: 's', CLIENT_SECRET: 's', access_token: 't', refreshToken: 't',
    apiKey: 'k', api_key: 'k', credentials: { user: 'u' }, nested: [{ sipPwd: 'x', label: 'keep' }], emptyToken: '', nullSecret: null,
  });
  assert.deepEqual(out, {
    name: 'ok', password: '[redacted]', Password: '[redacted]', clientSecret: '[redacted]', CLIENT_SECRET: '[redacted]',
    access_token: '[redacted]', refreshToken: '[redacted]', apiKey: '[redacted]', api_key: '[redacted]', credentials: '[redacted]',
    nested: [{ sipPwd: '[redacted]', label: 'keep' }], emptyToken: '', nullSecret: null,
  });
  assert.equal(redactSecrets('plain text'), 'plain text');
  assert.equal(redactSecrets(null), null);
});

// ---------- end to end through the client and the tool, fetch mocked ----------

const cfg = { restCredentials: { default: { key: 'k', secret: 's' } }, restDomainId: '131109', restRegion: 'US' };

async function withFetch(respond, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/oauth2/v1/token')) {
      return new Response(JSON.stringify({ access_token: 'LIVE-TOKEN', expires_in: 3600 }), { headers: { 'Content-Type': 'application/json' } });
    }
    return respond(String(url), init);
  };
  try { await fn(calls); } finally { globalThis.fetch = real; }
}

const json = (obj) => new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } });

test('client: a hostile base_url never triggers a fetch', async () => {
  await withFetch(() => json({}), async (calls) => {
    const r = new Five9RestClient(cfg);
    for (const b of ['https://evil.com', 'https://api.five9.com@evil.com', 'https://api.prod.us.five9.net.evil.com', 'http://api.prod.us.five9.net']) {
      await assert.rejects(r.request('GET', '/domains/v1/domains/{domainId}', { baseUrl: b }), Five9RestError, b);
    }
    assert.equal(calls.length, 0);
  });
});

test('client: typed-tool ids cannot traverse (circle_id "..")', async () => {
  await withFetch(() => json({}), async (calls) => {
    const r = new Five9RestClient(cfg);
    await assert.rejects(r.deleteCircle('..'), /"\.\." path segments/);
    await assert.rejects(r.getCircle('../../domains'), /may not encode/);
    assert.equal(calls.length, 0);
  });
});

test('client: read-only mode refuses non-GET before any fetch', async () => {
  await withFetch(() => json({}), async (calls) => {
    const r = new Five9RestClient({ ...cfg, readOnly: true });
    await assert.rejects(r.deleteCircle('7'), /read-only/);
    await assert.rejects(r.request('POST', '/circles/v1/domains/{domainId}/circles', { body: { name: 'x' } }), /read-only/);
    assert.equal(calls.length, 0);
  });
});

test('client: normal call goes to the pinned host with redirects disabled', async () => {
  await withFetch(() => json({ items: [] }), async (calls) => {
    const r = new Five9RestClient(cfg);
    await r.request('GET', '/interactions/v1/domains/{domainId}/dispositions', { query: { pageLimit: '5' } });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, `${US}/oauth2/v1/token`);
    assert.equal(calls[1].url, `${US}/interactions/v1/domains/131109/dispositions?pageLimit=5`);
    assert.ok(calls.every((c) => c.init.redirect === 'manual'));
    assert.equal(calls[1].init.headers.Authorization, 'Bearer LIVE-TOKEN');
  });
});

test('rest_call tool: refuses before fetching, redacts on success', async () => {
  await withFetch(() => json({ id: 1, clientSecret: 'shh', nested: { apiKey: 'k' } }), async (calls) => {
    for (const args of [
      { path: '/x/v1/y', base_url: 'https://evil.com' },
      { path: '/x/v1/../y' },
      { path: 'x/v1/y' },
      { path: '/x/v1/y', credential: 'nope' },
      { path: '/x/v1/y', method: 'TRACE' },
      { path: '/campaigns/v1/domains/{domainId}/campaigns/1/start', method: 'POST' },
      { path: '/x/v1/y', query: { a: '1', A: '2' } },
    ]) {
      await assert.rejects(callTool(cfg, 'rest_call', args), Five9RestError, JSON.stringify(args));
    }
    assert.equal(calls.length, 0);

    const out = await callTool(cfg, 'rest_call', { path: '/domains/v1/domains/{domainId}', base_url: REGION_BASE_URLS.EU });
    assert.deepEqual(out.data, { id: 1, clientSecret: '[redacted]', nested: { apiKey: '[redacted]' } });
    // The token comes from the configured host; the call goes to the named region.
    assert.deepEqual(calls.map((c) => c.url), [`${US}/oauth2/v1/token`, `${REGION_BASE_URLS.EU}/domains/v1/domains/131109`]);
  });
});
