// Cloudflare 530 "error code: 1016" (origin DNS) never reaches Five9, so the
// SOAP client retries it a couple of times before surfacing the error.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Five9Client, Five9Error } from '../src/five9.js';

const OK = '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:getSkillsResponse xmlns:ns2="http://service.admin.ws.five9.com/"><return><name>Sales</name></return></ns2:getSkillsResponse></soap:Body></soap:Envelope>';
const DNS = 'error code: 1016';

async function withFetch(responses, fn) {
  const realFetch = globalThis.fetch;
  const realDelays = Five9Client.dnsRetryDelaysMs;
  Five9Client.dnsRetryDelaysMs = [0, 0];
  let calls = 0;
  globalThis.fetch = async () => {
    const [status, body] = responses[Math.min(calls++, responses.length - 1)];
    return new Response(body, { status });
  };
  try { return await fn(() => calls); } finally {
    globalThis.fetch = realFetch;
    Five9Client.dnsRetryDelaysMs = realDelays;
  }
}

const client = () => new Five9Client({ username: 'u', password: 'p' });

test('retries a 1016 and returns the later success', async () => {
  await withFetch([[530, DNS], [530, DNS], [200, OK]], async (calls) => {
    const r = await client().admin('getSkills', '');
    assert.equal(r.return.name, 'Sales');
    assert.equal(calls(), 3);
  });
});

test('gives up after the retries and reports the 1016', async () => {
  await withFetch([[530, DNS]], async (calls) => {
    await assert.rejects(client().admin('getSkills', ''), (e) => e instanceof Five9Error && /530.*1016/.test(e.message));
    assert.equal(calls(), 3);
  });
});

test('does not retry other errors', async () => {
  await withFetch([[530, 'error code: 1033'], [200, OK]], async (calls) => {
    await assert.rejects(client().admin('getSkills', ''), /530/);
    assert.equal(calls(), 1);
  });
  await withFetch([[500, 'boom'], [200, OK]], async (calls) => {
    await assert.rejects(client().admin('getSkills', ''), /500/);
    assert.equal(calls(), 1);
  });
});
