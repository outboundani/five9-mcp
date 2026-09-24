// Read-only mode (FIVE9_READ_ONLY) must hide and refuse every write tool, and
// the SOAP client must refuse non-read operations before any network call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolDefs, callTool, WRITE_TOOLS } from '../src/tools.js';
import { Five9Client, Five9Error } from '../src/five9.js';
import { loadConfig } from '../src/config.js';

const ro = { username: 'u', password: 'p', readOnly: true };

test('FIVE9_READ_ONLY parses truthy values only', async () => {
  for (const v of ['true', 'TRUE', '1', 'yes', ' true ']) {
    assert.equal((await loadConfig({ FIVE9_READ_ONLY: v })).readOnly, true, v);
  }
  for (const v of [undefined, '', 'false', '0', 'no']) {
    assert.equal((await loadConfig({ FIVE9_READ_ONLY: v })).readOnly, false, String(v));
  }
});

test('read-only tools/list hides every write tool', () => {
  const names = toolDefs(ro).map((t) => t.name);
  assert.deepEqual(names.filter((n) => WRITE_TOOLS.has(n)), []);
  assert.ok(names.includes('get_ivr_script'));
  assert.equal(toolDefs().length, names.length + WRITE_TOOLS.size);
});

test('read-only callTool refuses every write tool', async () => {
  for (const name of WRITE_TOOLS) {
    await assert.rejects(callTool(ro, name, {}), (e) => e instanceof Five9Error && /read-only/.test(e.message), name);
  }
});

test('read-only SOAP client blocks write operations before fetching', async () => {
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; throw new Error('network'); };
  try {
    const f9 = new Five9Client(ro);
    for (const m of ['modifyIVRScript', 'createCampaign', 'deleteList', 'startCampaign', 'forceStopCampaign', 'addToListCsv', 'renameCampaign', 'updateCrmRecord']) {
      await assert.rejects(f9.admin(m, ''), /read-only/, m);
    }
    assert.equal(fetched, 0);
    for (const m of ['getIVRScripts', 'getCampaignState', 'isReportRunning', 'runReport']) {
      await assert.rejects(f9.admin(m, ''), /network/, m);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});
