// Security regressions. Each test reproduces an exploit against a fake Five9
// (globalThis.fetch is replaced; nothing leaves the machine) and proves it is
// refused before anything is sent, or that what is sent is safe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callTool } from '../src/tools.js';
import { xmlOf, mergeChanges, WRITABLE_FIELDS } from '../src/five9.js';

const cfg = { username: 'u', password: 'p', host: 'api.five9.com', restConsumerKey: 'k', restConsumerSecret: 's', restDomainId: 'd' };

const env = (method, inner) => `<?xml version="1.0"?><env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body><ns2:${method}Response xmlns:ns2="http://service.admin.ws.five9.com/">${inner}</ns2:${method}Response></env:Body></env:Envelope>`;

// Fake Five9: answers every SOAP method with `fixtures[method]` (or an empty
// response) and every REST path with `rest[key]`. Records what was sent.
async function withFive9(fixtures, run, rest = {}) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = typeof init.body === 'string' ? init.body : '';
    const soap = /<ser:(\w+)>/.exec(body)?.[1] || null;
    calls.push({ url: url.href, method: init.method, soap, body });
    if (soap) {
      const h = fixtures[soap];
      const out = typeof h === 'function' ? h(body) : h ?? env(soap, '<return>ok</return>');
      return new Response(out, { status: 200, headers: { 'Content-Type': 'text/xml' } });
    }
    const h = rest[`${init.method || 'GET'} ${url.pathname}`];
    if (typeof h === 'function') return h(url, init);
    return new Response(JSON.stringify(h ?? { access_token: 'tok', expires_in: 3600 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try { await run(calls); } finally { globalThis.fetch = realFetch; }
}

const outbound = (name) => env('getOutboundCampaign', `<return><description>d</description><mode>BASIC</mode><name>${name}</name><state>NOT_RUNNING</state><type>OUTBOUND</type><dialingMode>PREDICTIVE</dialingMode></return>`);

// ---------- 1. XML injection through object keys ----------

const INJECT = 'description></description><resetAttemptsCounter>true</resetAttemptsCounter><!--';

test('object keys can never inject XML into a SOAP body', async () => {
  const cases = [
    ['manage_disposition', { action: 'modify', name: 'Scratch', fields: { [INJECT]: 'x' } }],
    ['manage_disposition', { action: 'create', name: 'Scratch', fields: { type: 'FinalDisp', [INJECT]: 'x' } }],
    ['modify_campaign', { campaign_name: 'Stopped Test', changes: { 'dialingMode></dialingMode><x>1</x><!--': 'PREVIEW' } }],
    ['modify_campaign', { campaign_name: 'Stopped Test', changes: { callWrapup: { 'timeout><a/><!--': 1 } } }],
    ['manage_contact_field', { action: 'modify', name: 'F1', changes: { 'displayAs></displayAs><type>NUMBER</type><!--': 'Long' } }],
    ['manage_campaign_profile_filter', { action: 'set_criteria', profile_name: 'P1', add_criteria: [{ compareOperator: 'Equals', leftValue: 'a', 'rightValue></rightValue></addCriteria><x/><!--': 'b' }] }],
    ['manage_campaign_profile_filter', { action: 'set_criteria', profile_name: 'P1', grouping: { 'type></type><y/><!--': 'All' } }],
    ['manage_campaign_profile_filter', { action: 'set_order', profile_name: 'P1', add_order_by: [{ 'fieldName></fieldName><z/><!--': 'x' }] }],
    ['manage_campaign_profile', { action: 'modify', name: 'P1', fields: { 'ANI></ANI><numberOfAttempts>99</numberOfAttempts><!--': '1' } }],
    ['manage_campaign_profile', { action: 'create', name: 'P1', fields: { 'ANI></ANI><x/><!--': '1' } }],
    ['manage_skill', { action: 'modify', name: 'S1', fields: { 'description></description><routeVoiceMails>true</routeVoiceMails><!--': 'x' } }],
    ['modify_user', { user_name: 'u1', changes: { 'active></active><!--': true } }],
    ['set_user_roles', { user_name: 'u1', add: ['supervisor'], permissions: { 'supervisor></supervisor><admin/><!--': ['Agents'] } }],
    ['set_user_roles', { user_name: 'u1', add: ['supervisor'], permissions: { supervisor: [{ type: 'Agents', 'value></value><x/><!--': true }] } }],
    ['manage_disposition', { action: 'modify', name: 'Scratch', fields: { someUnknownField: 'x' } }],
    ['modify_campaign', { campaign_name: 'Stopped Test', changes: JSON.parse('{"__proto__":{"name":"Live Production"}}') }],
  ];
  for (const [tool, args] of cases) {
    await withFive9({ getOutboundCampaign: outbound('Stopped Test') }, async (calls) => {
      await assert.rejects(() => callTool(cfg, tool, args), /not allowed|cannot be an object|must be/i, tool);
      assert.deepEqual(calls.map((c) => c.soap), [], `${tool} sent something`);
    });
  }
  assert.throws(() => xmlOf({ [INJECT]: 'x' }, 'disposition'), /not allowed/);
  assert.throws(() => xmlOf('x', 'a b'), /not allowed/);
  assert.throws(() => mergeChanges({}, { 'a<b': 1 }), /not allowed/);
  assert.equal(xmlOf({ name: '<x>&' }, 'skill'), '<skill><name>&lt;x&gt;&amp;</name></skill>');
});

test('legitimate changes still serialize in WSDL order', async () => {
  await withFive9({ getOutboundCampaign: outbound('Stopped Test') }, async (calls) => {
    await callTool(cfg, 'modify_campaign', { campaign_name: 'Stopped Test', changes: { dialingMode: 'PREVIEW', callWrapup: { enabled: true, timeout: { minutes: 1 } } } });
    const sent = calls.find((c) => c.soap === 'modifyOutboundCampaign').body;
    assert.match(sent, /<dialingMode>PREVIEW<\/dialingMode>/);
    assert.match(sent, /<callWrapup><enabled>true<\/enabled><timeout><minutes>1<\/minutes><\/timeout><\/callWrapup>/);
  });
  for (const list of Object.values(WRITABLE_FIELDS)) for (const k of list) assert.match(k, /^[A-Za-z_][A-Za-z0-9_]*$/);
});
