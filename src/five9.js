// Five9 SOAP client — Configuration (admin) + Statistics (supervisor) Web Services.
// Zero dependencies: envelopes are built as strings, responses parsed with a
// minimal well-formed-XML parser (Workers have no DOMParser).

const NS = {
  admin: 'http://service.admin.ws.five9.com/',
  supervisor: 'http://service.supervisor.ws.five9.com/',
};

export function escapeXml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Parses well-formed XML into plain objects. Namespaces and attributes are
// dropped; repeated sibling elements become arrays; leaf elements become
// decoded strings. SOAP responses are regular enough that this is all we need.
export function parseXml(xml) {
  xml = xml
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, t) =>
      t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));

  const root = { children: {}, text: '' };
  const stack = [root];
  const re = /<([^>]+)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[1] !== undefined) {
      const tag = m[1].trim();
      if (tag.startsWith('/')) { if (stack.length > 1) stack.pop(); continue; }
      const selfClosing = tag.endsWith('/');
      const name = tag.replace(/\/$/, '').split(/[\s/]/)[0].replace(/^.*:/, '');
      const node = { children: {}, text: '' };
      const parent = stack[stack.length - 1];
      const existing = parent.children[name];
      if (existing === undefined) parent.children[name] = node;
      else if (Array.isArray(existing)) existing.push(node);
      else parent.children[name] = [existing, node];
      if (!selfClosing) stack.push(node);
    } else if (m[2].trim()) {
      stack[stack.length - 1].text += m[2];
    }
  }
  return simplify(root);
}

function simplify(node) {
  const keys = Object.keys(node.children);
  if (!keys.length) return decodeEntities(node.text.trim());
  const out = {};
  for (const k of keys) {
    const v = node.children[k];
    out[k] = Array.isArray(v) ? v.map(simplify) : simplify(v);
  }
  return out;
}

export function toArray(v) {
  if (v === undefined || v === null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

export class Five9Error extends Error {}

// SOAP operations allowed in read-only mode. setSessionParameters only scopes
// the supervisor stats session; it changes no configuration.
const READ_ONLY_METHOD = /^(get\w*|is\w*|checkDncForNumbers|runReport|setSessionParameters)$/;

// ---- Generic ordered XML serialization ----
//
// Five9's JAXB endpoints validate child-element order against the WSDL
// <xs:sequence>. ELEMENT_ORDERS pins the order for every complex type we
// write, keyed by the ELEMENT NAME as it appears in the request. Objects
// parsed from Five9 responses already arrive in schema order, so
// read-modify-write round-trips stay valid automatically.

const TIMER = ['days', 'hours', 'minutes', 'seconds'];
const CAMPAIGN_BASE = ['description', 'mode', 'name', 'profileName', 'state', 'trainingMode', 'type'];
const CAMPAIGN_GENERAL = ['autoRecord', 'callWrapup', 'ftpHost', 'ftpPassword', 'ftpUser', 'recordingNameAsSid', 'useFtp'];
const CAMPAIGN_BASE_OUTBOUND = ['analyzeLevel', 'CRMRedialTimeout', 'dnisAsAni', 'enableListDialingRatios', 'listDialingMode', 'noOutOfNumbersAlert', 'stateDialingRule', 'timeZoneAssignment'];
const CAMPAIGN_OUTBOUND_EXT = ['actionOnAnswerMachine', 'actionOnQueueExpiration', 'callAnalysisMode', 'callsAgentRatio', 'dialNumberOnTimeout', 'dialingMode', 'dialingPriority', 'dialingRatio', 'distributionAlgorithm', 'distributionTimeFrame', 'limitPreviewTime', 'maxDroppedCallsPercentage', 'maxPreviewTime', 'maxQueueTime', 'monitorDroppedCalls', 'previewDialImmediately', 'useTelemarketingMaxQueTimeEq1'];
export const OUTBOUND_CAMPAIGN_ORDER = [...CAMPAIGN_BASE, ...CAMPAIGN_GENERAL, ...CAMPAIGN_BASE_OUTBOUND, ...CAMPAIGN_OUTBOUND_EXT];
export const INBOUND_CAMPAIGN_ORDER = [...CAMPAIGN_BASE, ...CAMPAIGN_GENERAL, 'defaultIvrSchedule', 'maxNumOfLines'];

const ELEMENT_ORDERS = {
  defaultIvrSchedule: ['ivrSchedule', 'visualModeSettings'],
  ivrSchedule: ['name', 'scriptName', 'scriptParameters'],
  actionOnAnswerMachine: ['actionArgument', 'actionType', 'maxWaitTime'],
  actionOnQueueExpiration: ['actionArgument', 'actionType', 'maxWaitTime'],
  maxWaitTime: TIMER,
  timer: TIMER,
  timeout: TIMER,
  maxPreviewTime: TIMER,
  maxQueueTime: TIMER,
  CRMRedialTimeout: TIMER,
  callWrapup: ['agentNotReady', 'dispostionName', 'enabled', 'reasonCodeName', 'timeout'],
  typeParameters: ['allowChangeTimer', 'attempts', 'timer', 'useTimer'],
  campaignProfile: ['ANI', 'description', 'dialingSchedule', 'dialingTimeout', 'initialCallPriority', 'maxCharges', 'name', 'numberOfAttempts'],
  group: ['agents', 'description', 'id', 'name'],
  skill: ['description', 'id', 'messageOfTheDay', 'name', 'routeVoiceMails'],
  skillInfo: ['skill', 'users'],
  userSkill: ['id', 'level', 'skillName', 'userName'],
  users: ['id', 'level', 'skillName', 'userName'],
  generalInfo: ['active', 'canChangePassword', 'EMail', 'extension', 'federationId', 'firstName', 'fullName', 'IEXScheduled', 'id', 'lastName', 'locale', 'mediaTypeConfig', 'mustChangePassword', 'osLogin', 'password', 'phoneNumber', 'startDate', 'unifiedCommunicationId', 'userName', 'userProfileName'],
  userGeneralInfo: ['active', 'canChangePassword', 'EMail', 'extension', 'federationId', 'firstName', 'fullName', 'IEXScheduled', 'id', 'lastName', 'locale', 'mediaTypeConfig', 'mustChangePassword', 'osLogin', 'password', 'phoneNumber', 'startDate', 'unifiedCommunicationId', 'userName', 'userProfileName'],
  userInfo: ['agentGroups', 'cannedReports', 'generalInfo', 'roles', 'skills'],
  roles: ['admin', 'agent', 'crmManager', 'reporting', 'supervisor'],
  rolesToSet: ['admin', 'agent', 'crmManager', 'reporting', 'supervisor'],
  agent: ['alwaysRecorded', 'attachVmToEmail', 'permissions', 'sendEmailOnVm'],
  disposition: ['agentMustCompleteWorksheet', 'agentMustConfirm', 'description', 'name', 'resetAttemptsCounter', 'sendEmailNotification', 'sendIMNotification', 'trackAsFirstCallResolution', 'type', 'typeParameters'],
  field: ['displayAs', 'mapTo', 'name', 'restrictions', 'system', 'type'],
  prompt: ['description', 'languages', 'name', 'type'],
  ttsInfo: ['language', 'sayAs', 'sayAsFormat', 'text', 'voice'],
  scriptDef: ['description', 'name', 'xmlDefinition'],
  callVariable: ['applyToAllDispositions', 'defaultValue', 'description', 'dispositions', 'group', 'name', 'reporting', 'restrictions', 'sensitiveData', 'type'],
  variable: ['applyToAllDispositions', 'defaultValue', 'description', 'dispositions', 'group', 'name', 'reporting', 'restrictions', 'sensitiveData', 'type'],
  reasonCode: ['enabled', 'name', 'paidTime', 'shortcut', 'type'],
  speedDialNumber: ['code', 'description', 'number'],
  spd: ['code', 'description', 'number'],
  // Tier-2 types
  connector: ['addWorksheet', 'agentApplication', 'clearTriggerDispositions', 'constants', 'ctiWebServices', 'description', 'executeInBrowser', 'name', 'postConstants', 'postMethod', 'postVariables', 'startPageText', 'trigger', 'triggerDispositions', 'url', 'variables'],
  grouping: ['expression', 'type'],
  addCriteria: ['compareOperator', 'leftValue', 'rightValue'],
  removeCriteria: ['compareOperator', 'leftValue', 'rightValue'],
  addOrderByField: ['descending', 'fieldName', 'rank'],
};

// Serializes a plain JS value to XML under the given element name, applying
// the pinned child order when one is known for that element name.
export function xmlOf(value, name, order) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((v) => xmlOf(v, name)).join('');
  if (typeof value === 'object') {
    const ord = order || ELEMENT_ORDERS[name] || Object.keys(value);
    const keys = [...ord.filter((k) => k in value), ...Object.keys(value).filter((k) => !ord.includes(k))];
    const inner = keys.map((k) => xmlOf(value[k], k)).join('');
    return `<${name}>${inner}</${name}>`;
  }
  return `<${name}>${escapeXml(value)}</${name}>`;
}

// Merge scalar/nested changes into a fetched object (case-tolerant on keys).
export function mergeChanges(base, changes) {
  const out = { ...base };
  for (const [k, v] of Object.entries(changes || {})) {
    if (v === undefined) continue;
    const existing = Object.keys(out).find((x) => x.toLowerCase() === k.toLowerCase()) || k;
    out[existing] = (v && typeof v === 'object' && !Array.isArray(v) && typeof out[existing] === 'object' && out[existing] !== null)
      ? mergeChanges(out[existing], v)
      : v;
  }
  return out;
}

export class Five9Client {
  // cfg: { username, password, host, adminVersion, supervisorVersion } — see config.js
  constructor(cfg) {
    if (!cfg?.username || !cfg?.password) {
      throw new Five9Error('Five9 credentials are not configured — open /setup on this server, or set the FIVE9_USERNAME / FIVE9_PASSWORD Wrangler secrets.');
    }
    this.auth = 'Basic ' + btoa(`${cfg.username}:${cfg.password}`);
    this.host = cfg.host || 'api.five9.com';
    this.adminVersion = cfg.adminVersion || 'v13';
    this.supervisorVersion = cfg.supervisorVersion || 'v13';
    this.readOnly = Boolean(cfg.readOnly);
  }

  async soap(service, method, innerXml = '') {
    // Second line of defense behind the tool-level block: in read-only mode
    // only read operations reach Five9, whatever tool asked for them.
    if (this.readOnly && !READ_ONLY_METHOD.test(method)) {
      throw new Five9Error(`${method} is blocked: this server is in read-only mode (FIVE9_READ_ONLY).`);
    }
    const isAdmin = service === 'admin';
    const url = isAdmin
      ? `https://${this.host}/wsadmin/${this.adminVersion}/AdminWebService`
      : `https://${this.host}/wssupervisor/${this.supervisorVersion}/SupervisorWebService`;
    const envelope =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="${NS[service]}">` +
      `<soapenv:Header/><soapenv:Body><ser:${method}>${innerXml}</ser:${method}></soapenv:Body></soapenv:Envelope>`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '', Authorization: this.auth },
      body: envelope,
    });
    const text = await res.text();

    let parsed;
    try { parsed = parseXml(text); } catch { parsed = null; }
    const body = parsed?.Envelope?.Body;

    const fault = body?.Fault;
    if (fault) {
      throw new Five9Error(`Five9 SOAP fault on ${method}: ${fault.faultstring || JSON.stringify(fault)}`);
    }
    if (!res.ok) {
      throw new Five9Error(`Five9 HTTP ${res.status} on ${method}: ${text.slice(0, 300)}`);
    }
    if (!body) {
      throw new Five9Error(`Unexpected Five9 response on ${method}: ${text.slice(0, 300)}`);
    }
    const response = body[`${method}Response`];
    return response === undefined ? body : response;
  }

  admin(method, innerXml) { return this.soap('admin', method, innerXml); }
  supervisor(method, innerXml) { return this.soap('supervisor', method, innerXml); }

  // ---- Config (admin) API ----

  async getCampaigns(pattern = '.*') {
    const r = await this.admin('getCampaigns', `<campaignNamePattern>${escapeXml(pattern)}</campaignNamePattern>`);
    return toArray(r.return);
  }

  async controlCampaign(action, campaignName) {
    const methods = { start: 'startCampaign', stop: 'stopCampaign', force_stop: 'forceStopCampaign', reset: 'resetCampaign', reset_list_positions: 'resetListPosition' };
    const method = methods[action];
    if (!method) throw new Five9Error(`Unknown campaign action "${action}" — use start, stop, force_stop, reset, or reset_list_positions.`);
    await this.admin(method, `<campaignName>${escapeXml(campaignName)}</campaignName>`);
    return { ok: true, action, campaign: campaignName };
  }

  async getLists(pattern = '.*') {
    const r = await this.admin('getListsInfo', `<listNamePattern>${escapeXml(pattern)}</listNamePattern>`);
    return toArray(r.return);
  }

  // Bulk list import via addToListCsv (multi-row CSV). Returns an import
  // identifier to poll with get_import_result. `records` is an array of
  // field->value objects; all rows share the union of columns (first-seen order).
  async addRecordsToList(listName, records, opts = {}) {
    const rows = toArray(records).filter((r) => r && typeof r === 'object' && Object.keys(r).length);
    if (!rows.length) throw new Five9Error('records must contain at least one record (e.g. [{"number1": "5551234567"}]).');
    const names = [];
    for (const rec of rows) for (const n of Object.keys(rec)) if (!names.includes(n)) names.push(n);
    if (opts.keyField && !names.includes(opts.keyField)) {
      throw new Five9Error(`key_field "${opts.keyField}" is not present in any record — include it in the records or omit key_field.`);
    }
    const key = opts.keyField || (names.includes('number1') ? 'number1' : names[0]);
    const mappings = names.map((n, i) =>
      `<fieldsMapping><columnNumber>${i + 1}</columnNumber><fieldName>${escapeXml(n)}</fieldName>` +
      `<key>${n === key}</key></fieldsMapping>`).join('');
    const csv = rows.map((rec) => names.map((n) => {
      const v = String(rec[n] ?? '');
      return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(',')).join('\n');
    const crmAddMode = opts.crmAddMode || 'ADD_NEW';
    const crmUpdateMode = opts.crmUpdateMode || 'UPDATE_FIRST';
    const listAddMode = opts.listAddMode || 'ADD_FIRST';
    const cleanFirst = opts.cleanListBeforeUpdate ? 'true' : 'false';
    const r = await this.admin('addToListCsv',
      `<listName>${escapeXml(listName)}</listName>` +
      // listUpdateSettings order: basicImportSettings (fieldsMapping, separator,
      // skipHeaderLine), then the extension (cleanListBeforeUpdate, crmAddMode,
      // crmUpdateMode, listAddMode).
      `<listUpdateSettings>${mappings}<separator>,</separator><skipHeaderLine>false</skipHeaderLine>` +
      `<cleanListBeforeUpdate>${cleanFirst}</cleanListBeforeUpdate><crmAddMode>${escapeXml(crmAddMode)}</crmAddMode>` +
      `<crmUpdateMode>${escapeXml(crmUpdateMode)}</crmUpdateMode><listAddMode>${escapeXml(listAddMode)}</listAddMode></listUpdateSettings>` +
      `<csvData>${escapeXml(csv)}</csvData>`);
    return { submitted: true, list: listName, keyField: key, recordCount: rows.length,
      importIdentifier: r.return?.identifier ?? r.return ?? null,
      note: 'Five9 processes list imports asynchronously; poll get_import_result with the importIdentifier.' };
  }

  // Single-record convenience wrapper over addRecordsToList.
  async addRecordToList(listName, fields, keyField) {
    if (!fields || !Object.keys(fields).length) throw new Five9Error('fields must contain at least one field (e.g. {"number1": "5551234567"}).');
    return this.addRecordsToList(listName, [fields], { keyField });
  }

  // Bulk CRM contact update via updateContactsCsv (async import; poll
  // get_import_result with type "crm"). keyFields identify the contact(s) to
  // match; every other column is written.
  async updateContactsBulk(records, keyFields, opts = {}) {
    const rows = toArray(records).filter((r) => r && typeof r === 'object' && Object.keys(r).length);
    if (!rows.length) throw new Five9Error('records must contain at least one record.');
    const keys = toArray(keyFields).filter(Boolean);
    if (!keys.length) throw new Five9Error('key_fields must name at least one field used to match contacts (e.g. ["number1"]).');
    const names = [];
    for (const rec of rows) for (const n of Object.keys(rec)) if (!names.includes(n)) names.push(n);
    for (const k of keys) if (!names.includes(k)) throw new Five9Error(`key field "${k}" is not present in the records.`);
    const mappings = names.map((n, i) =>
      `<fieldsMapping><columnNumber>${i + 1}</columnNumber><fieldName>${escapeXml(n)}</fieldName>` +
      `<key>${keys.includes(n)}</key></fieldsMapping>`).join('');
    const csv = rows.map((rec) => names.map((n) => {
      const v = String(rec[n] ?? '');
      return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(',')).join('\n');
    const crmAddMode = opts.crmAddMode || 'DONT_ADD';
    const crmUpdateMode = opts.crmUpdateMode || 'UPDATE_FIRST';
    // crmUpdateSettings order: basicImportSettings (fieldsMapping, separator,
    // skipHeaderLine), then crmAddMode, crmUpdateMode.
    const r = await this.admin('updateContactsCsv',
      `<crmUpdateSettings>${mappings}<separator>,</separator><skipHeaderLine>false</skipHeaderLine>` +
      `<crmAddMode>${escapeXml(crmAddMode)}</crmAddMode><crmUpdateMode>${escapeXml(crmUpdateMode)}</crmUpdateMode></crmUpdateSettings>` +
      `<csvData>${escapeXml(csv)}</csvData>`);
    return { submitted: true, recordCount: rows.length, keyFields: keys,
      importIdentifier: r.return?.identifier ?? r.return ?? null,
      note: 'CRM update runs asynchronously; poll get_import_result with type "crm".' };
  }

  async searchContacts(criteria) {
    const entries = Object.entries(criteria || {});
    if (!entries.length) throw new Five9Error('criteria must contain at least one field (e.g. {"number1": "5551234567"}).');
    const crit = entries.map(([f, v]) =>
      `<criteria><field>${escapeXml(f)}</field><value>${escapeXml(v)}</value></criteria>`).join('');
    const r = await this.admin('getContactRecords', `<lookupCriteria>${crit}</lookupCriteria>`);
    const ret = r.return || {};
    const fields = toArray(ret.fields);
    const records = toArray(ret.records).map((rec) => {
      // Values arrive as <values><data>…</data><data>…</data></values>
      const values = toArray(rec.values?.data ?? rec.values);
      const obj = {};
      fields.forEach((f, i) => { obj[f] = values[i] ?? ''; });
      return obj;
    });
    return { fields, count: records.length, records };
  }

  async getUsers(pattern = '.*') {
    const r = await this.admin('getUsersGeneralInfo', `<userNamePattern>${escapeXml(pattern)}</userNamePattern>`);
    return toArray(r.return);
  }

  async getSkills(pattern = '.*') {
    const r = await this.admin('getSkills', `<skillNamePattern>${escapeXml(pattern)}</skillNamePattern>`);
    return toArray(r.return);
  }

  async getDispositions(pattern = '.*') {
    const r = await this.admin('getDispositions', `<dispositionNamePattern>${escapeXml(pattern)}</dispositionNamePattern>`);
    return toArray(r.return);
  }

  async runReport(folderName, reportName, start, end) {
    // JAXB-generated schema orders ReportTimeCriteria children as <end>, <start>.
    const criteria = start && end
      ? `<criteria><time><end>${escapeXml(end)}</end><start>${escapeXml(start)}</start></time></criteria>`
      : '';
    const r = await this.admin('runReport',
      `<folderName>${escapeXml(folderName)}</folderName><reportName>${escapeXml(reportName)}</reportName>${criteria}`);
    return { identifier: r.return, note: 'Poll get_report_result with this identifier until the CSV is ready.' };
  }

  async getReportResult(identifier) {
    const running = await this.admin('isReportRunning',
      `<identifier>${escapeXml(identifier)}</identifier><timeout>5</timeout>`);
    if (String(running.return) === 'true') {
      return { ready: false, note: 'Report is still running — call get_report_result again shortly.' };
    }
    const r = await this.admin('getReportResultCsv', `<identifier>${escapeXml(identifier)}</identifier>`);
    return { ready: true, csv: r.return ?? '' };
  }

  async getContactFields(pattern = '.*') {
    const r = await this.admin('getContactFields', `<namePattern>${escapeXml(pattern)}</namePattern>`);
    return toArray(r.return);
  }

  async updateContact(key, fields, updateMode = 'UPDATE_SOLE_MATCHES') {
    const keyNames = Object.keys(key || {});
    const dataNames = Object.keys(fields || {});
    if (!keyNames.length) throw new Five9Error('key must contain at least one field identifying the contact (e.g. {"number1": "5551234567"}).');
    if (!dataNames.length) throw new Five9Error('fields must contain at least one field to update.');
    const all = [...keyNames, ...dataNames.filter((n) => !keyNames.includes(n))];
    const mappings = all.map((n, i) =>
      `<fieldsMapping><columnNumber>${i + 1}</columnNumber><fieldName>${escapeXml(n)}</fieldName>` +
      `<key>${keyNames.includes(n)}</key></fieldsMapping>`).join('');
    const values = all.map((n) =>
      `<fields>${escapeXml(keyNames.includes(n) ? key[n] : fields[n])}</fields>`).join('');
    // crmUpdateSettings element order per WSDL: fieldsMapping, skipHeaderLine,
    // then the extension fields crmAddMode, crmUpdateMode.
    const r = await this.admin('updateCrmRecord',
      `<crmUpdateSettings>${mappings}<skipHeaderLine>false</skipHeaderLine>` +
      `<crmAddMode>DONT_ADD</crmAddMode><crmUpdateMode>${escapeXml(updateMode)}</crmUpdateMode></crmUpdateSettings>` +
      `<record>${values}</record>`);
    return { ok: true, updateMode, result: r.return ?? null };
  }

  async deleteRecordFromList(listName, fields) {
    const names = Object.keys(fields || {});
    if (!names.length) throw new Five9Error('fields must contain at least one field (e.g. {"number1": "5551234567"}).');
    const mappings = names.map((n, i) =>
      `<fieldsMapping><columnNumber>${i + 1}</columnNumber><fieldName>${escapeXml(n)}</fieldName><key>true</key></fieldsMapping>`).join('');
    const values = names.map((n) => `<fields>${escapeXml(fields[n])}</fields>`).join('');
    const r = await this.admin('deleteRecordFromList',
      `<listName>${escapeXml(listName)}</listName>` +
      `<listDeleteSettings>${mappings}<skipHeaderLine>false</skipHeaderLine><listDeleteMode>DELETE_ALL</listDeleteMode></listDeleteSettings>` +
      `<record>${values}</record>`);
    return { ok: true, list: listName, result: r.return ?? null,
      note: 'Removes matching records from the dialing list only — the CRM contact is not deleted.' };
  }

  async getImportResult(identifier, type = 'list') {
    const method = type === 'crm' ? 'getCrmImportResult' : 'getListImportResult';
    // Tolerate either the bare id string or the { identifier } object shape.
    const id = (identifier && typeof identifier === 'object') ? identifier.identifier : identifier;
    try {
      const r = await this.admin(method, `<identifier><identifier>${escapeXml(id)}</identifier></identifier>`);
      const result = r.return ?? null;
      return (result && typeof result === 'object') ? { ready: true, ...result } : { ready: true, result };
    } catch (e) {
      // Five9 faults with "Result is not ready due to process is not complete"
      // while the import is still running — surface that as a poll-again signal
      // (mirrors getReportResult's { ready: false }) instead of a raw error.
      if (/not ready|not complete|still (running|processing)|in progress/i.test(e.message)) {
        return { ready: false, note: 'Import is still processing — call get_import_result again shortly.' };
      }
      throw e;
    }
  }

  async createList(name) {
    await this.admin('createList', `<listName>${escapeXml(name)}</listName>`);
    return { ok: true, created: name };
  }

  async deleteList(name) {
    await this.admin('deleteList', `<listName>${escapeXml(name)}</listName>`);
    return { ok: true, deleted: name };
  }

  async inspectCampaign(name) {
    const out = { campaign: name };
    const state = await this.admin('getCampaignState', `<campaignName>${escapeXml(name)}</campaignName>`);
    out.state = state.return ?? null;
    // Lists only exist for outbound campaigns and DNIS only for inbound —
    // surface the Five9 error text instead of failing the whole call.
    try {
      out.lists = toArray((await this.admin('getListsForCampaign', `<campaignName>${escapeXml(name)}</campaignName>`)).return);
    } catch (e) { out.lists = e.message; }
    try {
      out.dnis = toArray((await this.admin('getCampaignDNISList', `<campaignName>${escapeXml(name)}</campaignName>`)).return);
    } catch (e) { out.dnis = e.message; }
    return out;
  }

  async manageCampaignLists(action, campaignName, listName, priority = 1) {
    if (action === 'add') {
      await this.admin('addListsToCampaign',
        `<campaignName>${escapeXml(campaignName)}</campaignName>` +
        `<lists><listName>${escapeXml(listName)}</listName><priority>${Number(priority) || 1}</priority></lists>`);
    } else if (action === 'remove') {
      await this.admin('removeListsFromCampaign',
        `<campaignName>${escapeXml(campaignName)}</campaignName><lists>${escapeXml(listName)}</lists>`);
    } else {
      throw new Five9Error(`Unknown action "${action}" — use add or remove.`);
    }
    return { ok: true, action, campaign: campaignName, list: listName };
  }

  async dnc(action, numbers) {
    const nums = toArray(numbers);
    if (!nums.length) throw new Five9Error('numbers must contain at least one phone number.');
    const inner = nums.map((n) => `<numbers>${escapeXml(n)}</numbers>`).join('');
    if (action === 'check') {
      const r = await this.admin('checkDncForNumbers', inner);
      return { checked: nums, onDnc: toArray(r.return) };
    }
    if (action === 'add') {
      const r = await this.admin('addNumbersToDnc', inner);
      return { ok: true, added: nums, result: r.return ?? null };
    }
    if (action === 'remove') {
      const r = await this.admin('removeNumbersFromDnc', inner);
      return { ok: true, removed: nums, result: r.return ?? null };
    }
    throw new Five9Error(`Unknown DNC action "${action}" — use check, add, or remove.`);
  }

  async getAgentGroups(pattern = '.*') {
    const r = await this.admin('getAgentGroups', `<groupNamePattern>${escapeXml(pattern)}</groupNamePattern>`);
    return toArray(r.return);
  }

  async getIVRScripts(pattern = '.*') {
    const r = await this.admin('getIVRScripts', `<namePattern>${escapeXml(pattern)}</namePattern>`);
    // Script XML bodies run to hundreds of KB — return metadata only.
    return toArray(r.return).map(({ xmlDefinition, ...rest }) =>
      ({ ...rest, xmlSize: xmlDefinition ? String(xmlDefinition).length : 0 }));
  }

  async getDNISList(selectUnassigned) {
    const inner = selectUnassigned === undefined ? '' : `<selectUnassigned>${!!selectUnassigned}</selectUnassigned>`;
    const r = await this.admin('getDNISList', inner);
    return toArray(r.return);
  }

  // ---- Campaign CRUD ----

  // Full campaign configuration. Tries outbound, then inbound, then autodial.
  async getCampaignDetails(name) {
    const arg = `<campaignName>${escapeXml(name)}</campaignName>`;
    for (const [kind, method] of [['outbound', 'getOutboundCampaign'], ['inbound', 'getInboundCampaign'], ['autodial', 'getAutodialCampaign']]) {
      try {
        const r = await this.admin(method, arg);
        return { campaignKind: kind, ...(r.return || {}) };
      } catch (e) {
        // Wrong-campaign-type faults vary by endpoint: getOutboundCampaign says
        // "is INBOUND but should be OUTBOUND", while other endpoints say
        // "should be one of [OUTBOUND]". Match the shared "but should be" so we
        // fall through to the next campaign type instead of failing.
        if (!/but should be|should be one of|WrongCampaignType/i.test(e.message)) throw e;
      }
    }
    throw new Five9Error(`Campaign "${name}" was not found as outbound, inbound, or autodial.`);
  }

  async createCampaign(type, fields) {
    const f = fields || {};
    if (!f.name) throw new Five9Error('name is required.');
    const mode = (f.mode || 'BASIC').toUpperCase();
    if (mode === 'ADVANCED' && !f.profileName) {
      throw new Five9Error('ADVANCED campaigns require profileName (see list_campaign_profiles).');
    }
    const base = {
      description: f.description, mode, name: f.name,
      profileName: f.profileName, trainingMode: f.trainingMode ?? false,
    };
    if (type === 'outbound') {
      const campaign = mergeChanges(base, {
        autoRecord: f.autoRecord,
        // Five9 requires answer-machine and queue-expiration actions on
        // create; default to DROP_CALL so no prompt is needed.
        actionOnAnswerMachine: f.actionOnAnswerMachine || { actionType: 'DROP_CALL' },
        actionOnQueueExpiration: f.actionOnQueueExpiration || { actionType: 'DROP_CALL', maxWaitTime: { days: 0, hours: 0, minutes: 0, seconds: 60 } },
        dialingMode: f.dialingMode,      // PREDICTIVE | PROGRESSIVE | PREVIEW | POWER
        callsAgentRatio: f.callsAgentRatio,
        maxDroppedCallsPercentage: f.maxDroppedCallsPercentage,
        monitorDroppedCalls: f.monitorDroppedCalls,
      });
      await this.admin('createOutboundCampaign', xmlOf(campaign, 'campaign', OUTBOUND_CAMPAIGN_ORDER));
    } else if (type === 'inbound') {
      if (!f.ivrScript) {
        throw new Five9Error('Inbound campaigns require ivr_script (the IVR script that answers calls) — pick one from list_ivr_scripts.');
      }
      const campaign = mergeChanges(base, {
        autoRecord: f.autoRecord,
        defaultIvrSchedule: { ivrSchedule: { scriptName: f.ivrScript } },
        maxNumOfLines: f.maxNumOfLines ?? 10,
      });
      await this.admin('createInboundCampaign', xmlOf(campaign, 'campaign', INBOUND_CAMPAIGN_ORDER));
    } else {
      throw new Five9Error(`Unsupported campaign type "${type}" — use outbound or inbound.`);
    }
    return { ok: true, created: f.name, type, mode };
  }

  // Read-modify-write: fetch the full campaign, merge the changes, send the
  // whole object back in schema order.
  async modifyCampaign(name, changes) {
    const details = await this.getCampaignDetails(name);
    const { campaignKind, ...current } = details;
    if (campaignKind === 'autodial') throw new Five9Error('Editing autodial campaigns is not supported yet.');
    delete current.state; // state changes go through control_campaign
    const merged = mergeChanges(current, changes);
    if (campaignKind === 'outbound') {
      await this.admin('modifyOutboundCampaign', xmlOf(merged, 'campaign', OUTBOUND_CAMPAIGN_ORDER));
    } else {
      await this.admin('modifyInboundCampaign', xmlOf(merged, 'campaign', INBOUND_CAMPAIGN_ORDER));
    }
    return { ok: true, campaign: name, kind: campaignKind, applied: Object.keys(changes || {}) };
  }

  async renameCampaign(name, newName) {
    await this.admin('renameCampaign', `<campaignName>${escapeXml(name)}</campaignName><campaignNewName>${escapeXml(newName)}</campaignNewName>`);
    return { ok: true, from: name, to: newName };
  }

  async deleteCampaign(name) {
    await this.admin('deleteCampaign', `<campaignName>${escapeXml(name)}</campaignName>`);
    return { ok: true, deleted: name };
  }

  // ---- Campaign associations ----

  async manageCampaignSkills(action, campaignName, skills) {
    const method = { add: 'addSkillsToCampaign', remove: 'removeSkillsFromCampaign' }[action];
    if (!method) throw new Five9Error(`Unknown action "${action}" — use add or remove.`);
    const inner = `<campaignName>${escapeXml(campaignName)}</campaignName>` + toArray(skills).map((s) => `<skills>${escapeXml(s)}</skills>`).join('');
    await this.admin(method, inner);
    return { ok: true, action, campaign: campaignName, skills: toArray(skills) };
  }

  async manageCampaignDnis(action, campaignName, dnis) {
    const method = { add: 'addDNISToCampaign', remove: 'removeDNISFromCampaign' }[action];
    if (!method) throw new Five9Error(`Unknown action "${action}" — use add or remove.`);
    const inner = `<campaignName>${escapeXml(campaignName)}</campaignName>` + toArray(dnis).map((d) => `<DNISList>${escapeXml(d)}</DNISList>`).join('');
    await this.admin(method, inner);
    return { ok: true, action, campaign: campaignName, dnis: toArray(dnis) };
  }

  async manageCampaignDispositions(action, campaignName, dispositions) {
    const method = { add: 'addDispositionsToCampaign', remove: 'removeDispositionsFromCampaign' }[action];
    if (!method) throw new Five9Error(`Unknown action "${action}" — use add or remove.`);
    const inner = `<campaignName>${escapeXml(campaignName)}</campaignName>` + toArray(dispositions).map((d) => `<dispositions>${escapeXml(d)}</dispositions>`).join('');
    await this.admin(method, inner);
    return { ok: true, action, campaign: campaignName, dispositions: toArray(dispositions) };
  }

  // ---- Campaign profiles ----

  async getCampaignProfiles(pattern = '.*') {
    const r = await this.admin('getCampaignProfiles', `<namePattern>${escapeXml(pattern)}</namePattern>`);
    return toArray(r.return);
  }

  async createCampaignProfile(fields) {
    if (!fields?.name) throw new Five9Error('name is required.');
    await this.admin('createCampaignProfile', xmlOf(fields, 'campaignProfile'));
    return { ok: true, created: fields.name };
  }

  async modifyCampaignProfile(name, changes) {
    const all = await this.getCampaignProfiles(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const current = all.find((p) => p.name === name);
    if (!current) throw new Five9Error(`Campaign profile "${name}" not found.`);
    const merged = mergeChanges(current, changes);
    await this.admin('modifyCampaignProfile', xmlOf(merged, 'campaignProfile'));
    return { ok: true, profile: name, applied: Object.keys(changes || {}) };
  }

  async deleteCampaignProfile(name) {
    await this.admin('deleteCampaignProfile', `<profileName>${escapeXml(name)}</profileName>`);
    return { ok: true, deleted: name };
  }

  // ---- Skills ----

  async getSkillDetails(pattern = '.*') {
    const r = await this.admin('getSkillsInfo', `<skillNamePattern>${escapeXml(pattern)}</skillNamePattern>`);
    return toArray(r.return);
  }

  async createSkill(fields) {
    if (!fields?.name) throw new Five9Error('name is required.');
    const skill = { description: fields.description, messageOfTheDay: fields.messageOfTheDay, name: fields.name, routeVoiceMails: fields.routeVoiceMails ?? false };
    await this.admin('createSkill', xmlOf({ skill }, 'skillInfo'));
    return { ok: true, created: fields.name };
  }

  async modifySkill(name, changes) {
    const skills = await this.getSkills(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const current = skills.find((s) => s.name === name);
    if (!current) throw new Five9Error(`Skill "${name}" not found.`);
    const merged = mergeChanges(current, changes);
    await this.admin('modifySkill', xmlOf(merged, 'skill'));
    return { ok: true, skill: name, applied: Object.keys(changes || {}) };
  }

  async deleteSkill(name) {
    await this.admin('deleteSkill', `<skillName>${escapeXml(name)}</skillName>`);
    return { ok: true, deleted: name };
  }

  async manageUserSkill(action, userName, skillName, level = 1) {
    const method = { add: 'userSkillAdd', set_level: 'userSkillModify', remove: 'userSkillRemove' }[action];
    if (!method) throw new Five9Error(`Unknown action "${action}" — use add, set_level, or remove.`);
    const userSkill = { level: Number(level) || 1, skillName, userName };
    await this.admin(method, xmlOf(userSkill, 'userSkill'));
    return { ok: true, action, user: userName, skill: skillName, level: userSkill.level };
  }

  // ---- Users ----

  async getUserDetails(userName) {
    const r = await this.admin('getUserInfo', `<userName>${escapeXml(userName)}</userName>`);
    return r.return || {};
  }

  async createUser(fields) {
    const f = fields || {};
    if (!f.userName || !f.password || !f.firstName || !f.lastName || !f.email) {
      throw new Five9Error('userName, password, firstName, lastName, and email are required.');
    }
    const generalInfo = {
      active: f.active ?? true, canChangePassword: true, EMail: f.email,
      extension: f.extension, firstName: f.firstName, lastName: f.lastName,
      mustChangePassword: f.mustChangePassword ?? true, password: f.password,
      phoneNumber: f.phoneNumber, userName: f.userName, userProfileName: f.userProfileName,
    };
    const roles = {};
    const wanted = toArray(f.roles?.length ? f.roles : ['agent']).map((x) => String(x).toLowerCase());
    if (wanted.includes('admin')) roles.admin = { permissions: [] };
    if (wanted.includes('agent')) roles.agent = { alwaysRecorded: false, attachVmToEmail: false, sendEmailOnVm: false };
    if (wanted.includes('reporting')) roles.reporting = { permissions: [] };
    if (wanted.includes('supervisor')) roles.supervisor = { permissions: [] };
    const userInfo = { generalInfo, roles };
    if (f.agentGroups) userInfo.agentGroups = toArray(f.agentGroups);
    if (f.skills) userInfo.skills = toArray(f.skills).map((s) => (typeof s === 'string' ? { level: 1, skillName: s, userName: f.userName } : { level: s.level ?? 1, skillName: s.name || s.skillName, userName: f.userName }));
    const r = await this.admin('createUser', xmlOf(userInfo, 'userInfo'));
    return { ok: true, created: f.userName, roles: Object.keys(roles), result: r.return ? { userName: r.return.generalInfo?.userName, id: r.return.generalInfo?.id } : null };
  }

  async modifyUser(userName, changes) {
    const r = await this.admin('getUserGeneralInfo', `<userName>${escapeXml(userName)}</userName>`);
    const current = r.return;
    if (!current) throw new Five9Error(`User "${userName}" not found.`);
    const merged = mergeChanges(current, changes);
    delete merged.fullName; // derived field — Five9 rejects it on modify
    await this.admin('modifyUser', xmlOf(merged, 'userGeneralInfo'));
    return { ok: true, user: userName, applied: Object.keys(changes || {}) };
  }

  async deleteUser(userName) {
    await this.admin('deleteUser', `<userName>${escapeXml(userName)}</userName>`);
    return { ok: true, deleted: userName };
  }

  async getUserProfiles(pattern = '.*') {
    const r = await this.admin('getUserProfiles', `<userProfileNamePatern>${escapeXml(pattern)}</userProfileNamePatern>`);
    return toArray(r.return);
  }

  // ---- Dispositions ----

  async createDisposition(fields) {
    if (!fields?.name || !fields?.type) throw new Five9Error('name and type are required (see list_dispositions for type examples like FinalDisp, RedialNumber, DoNotDial).');
    await this.admin('createDisposition', xmlOf(fields, 'disposition'));
    return { ok: true, created: fields.name, type: fields.type };
  }

  async modifyDisposition(name, changes) {
    const r = await this.admin('getDisposition', `<dispositionName>${escapeXml(name)}</dispositionName>`);
    const current = r.return;
    if (!current) throw new Five9Error(`Disposition "${name}" not found.`);
    // Five9 rejects round-tripped system fields here — send a sparse object:
    // the identifying name + type plus only the changed fields.
    const merged = mergeChanges({ name: current.name, type: current.type, typeParameters: current.typeParameters }, changes);
    await this.admin('modifyDisposition', xmlOf(merged, 'disposition'));
    return { ok: true, disposition: name, applied: Object.keys(changes || {}) };
  }

  async renameDisposition(name, newName) {
    await this.admin('renameDisposition', `<dispositionName>${escapeXml(name)}</dispositionName><dispositionNewName>${escapeXml(newName)}</dispositionNewName>`);
    return { ok: true, from: name, to: newName };
  }

  async deleteDisposition(name) {
    await this.admin('removeDisposition', `<dispositionName>${escapeXml(name)}</dispositionName>`);
    return { ok: true, deleted: name };
  }

  // ---- Contact fields & CRM delete ----

  async createContactField(fields) {
    if (!fields?.name || !fields?.type) throw new Five9Error('name and type are required.');
    const field = { displayAs: fields.displayAs || 'Short', mapTo: fields.mapTo, name: fields.name, system: false, type: fields.type };
    await this.admin('createContactField', xmlOf(field, 'field'));
    return { ok: true, created: fields.name, type: fields.type };
  }

  async deleteContactField(name) {
    await this.admin('deleteContactField', `<fieldName>${escapeXml(name)}</fieldName>`);
    return { ok: true, deleted: name };
  }

  // Modify a CRM contact field (read-modify-write; e.g. change displayAs).
  async modifyContactField(name, changes) {
    const all = await this.getContactFields(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const current = all.find((f) => f.name === name);
    if (!current) throw new Five9Error(`Contact field "${name}" not found.`);
    const merged = mergeChanges(current, changes);
    await this.admin('modifyContactField', xmlOf(merged, 'field'));
    return { ok: true, field: name, applied: Object.keys(changes || {}) };
  }

  async deleteContact(criteria) {
    const names = Object.keys(criteria || {});
    if (!names.length) throw new Five9Error('criteria must contain at least one field (e.g. {"number1": "5551234567"}).');
    const mappings = names.map((n, i) =>
      `<fieldsMapping><columnNumber>${i + 1}</columnNumber><fieldName>${escapeXml(n)}</fieldName><key>true</key></fieldsMapping>`).join('');
    const csvLine = names.map((n) => {
      const v = String(criteria[n] ?? '');
      return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(',');
    const r = await this.admin('deleteFromContactsCsv',
      `<crmDeleteSettings>${mappings}<skipHeaderLine>false</skipHeaderLine>` +
      `<crmDeleteMode>DELETE_SOLE_MATCHES</crmDeleteMode></crmDeleteSettings>` +
      `<csvData>${escapeXml(csvLine)}</csvData>`);
    return { ok: true, result: r.return ?? null, note: 'DELETE_SOLE_MATCHES: contacts are only deleted when exactly one record matches the criteria.' };
  }

  // ---- Prompts ----

  async getPrompts() {
    // getPromptsResponse returns repeated <prompts> elements, not <return>.
    const r = await this.admin('getPrompts', '');
    return toArray(r.prompts);
  }

  async manageTtsPrompt(action, fields) {
    if (action === 'delete') {
      await this.admin('deletePrompt', `<promptName>${escapeXml(fields.name)}</promptName>`);
      return { ok: true, deleted: fields.name };
    }
    if (!fields?.name || !fields?.text) throw new Five9Error('name and text are required.');
    const method = { create: 'addPromptTTS', modify: 'modifyPromptTTS' }[action];
    if (!method) throw new Five9Error(`Unknown action "${action}" — use create, modify, or delete.`);
    const prompt = { description: fields.description, languages: fields.language || 'en-US', name: fields.name, type: 'TTSGenerated' };
    const ttsInfo = { language: fields.language || 'en-US', text: fields.text, voice: fields.voice };
    await this.admin(method, xmlOf(prompt, 'prompt') + xmlOf(ttsInfo, 'ttsInfo'));
    return { ok: true, action, prompt: fields.name };
  }

  // ---- IVR scripts ----

  async getIVRScript(name) {
    const r = await this.admin('getIVRScripts', `<namePattern>${escapeXml(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))}</namePattern>`);
    const script = toArray(r.return).find((s) => s.name === name);
    if (!script) throw new Five9Error(`IVR script "${name}" not found.`);
    return script;
  }

  // ---- Agent groups ----

  async manageAgentGroup(action, name, opts = {}) {
    if (action === 'create') {
      await this.admin('createAgentGroup', xmlOf({ description: opts.description, name }, 'group'));
      return { ok: true, created: name };
    }
    if (action === 'delete') {
      await this.admin('deleteAgentGroup', `<groupName>${escapeXml(name)}</groupName>`);
      return { ok: true, deleted: name };
    }
    if (action === 'add_agents' || action === 'remove_agents') {
      const groups = await this.getAgentGroups(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const group = groups.find((g) => g.name === name);
      if (!group) throw new Five9Error(`Agent group "${name}" not found.`);
      const agents = toArray(opts.agents);
      if (!agents.length) throw new Five9Error('agents must contain at least one username.');
      const tag = action === 'add_agents' ? 'addAgents' : 'removeAgents';
      await this.admin('modifyAgentGroup', xmlOf(group, 'group') + agents.map((a) => `<${tag}>${escapeXml(a)}</${tag}>`).join(''));
      return { ok: true, action, group: name, agents };
    }
    throw new Five9Error(`Unknown action "${action}" — use create, delete, add_agents, or remove_agents.`);
  }

  // ---- Call variables ----

  async getCallVariables(namePattern, groupName) {
    const inner = (namePattern ? `<namePattern>${escapeXml(namePattern)}</namePattern>` : '') +
      (groupName ? `<groupName>${escapeXml(groupName)}</groupName>` : '');
    const r = await this.admin('getCallVariables', inner);
    return toArray(r.return);
  }

  async getCallVariableGroups() {
    const r = await this.admin('getCallVariableGroups', '');
    return toArray(r.return);
  }

  async manageCallVariable(action, fields) {
    if (action === 'delete') {
      await this.admin('deleteCallVariable', `<name>${escapeXml(fields.name)}</name><groupName>${escapeXml(fields.group)}</groupName>`);
      return { ok: true, deleted: `${fields.group}.${fields.name}` };
    }
    if (!fields?.name || !fields?.group) throw new Five9Error('name and group are required.');
    if (action === 'create') {
      const variable = { defaultValue: fields.defaultValue, description: fields.description, group: fields.group, name: fields.name, reporting: fields.reporting ?? false, type: fields.type || 'STRING' };
      await this.admin('createCallVariable', xmlOf(variable, 'variable'));
      return { ok: true, created: `${fields.group}.${fields.name}` };
    }
    throw new Five9Error(`Unknown action "${action}" — use create or delete.`);
  }

  // ---- Domain odds & ends ----

  async getWebConnectors(pattern = '.*') {
    const r = await this.admin('getWebConnectors', `<namePattern>${escapeXml(pattern)}</namePattern>`);
    return toArray(r.return);
  }

  async manageSpeedDial(action, fields = {}) {
    if (action === 'list') {
      const r = await this.admin('getSpeedDialNumbers', '');
      return toArray(r.return);
    }
    if (action === 'create') {
      if (!fields.code || !fields.number) throw new Five9Error('code and number are required.');
      // createSpeedDialNumber takes bare code/number/description elements.
      await this.admin('createSpeedDialNumber',
        `<code>${escapeXml(fields.code)}</code><number>${escapeXml(fields.number)}</number>` +
        (fields.description ? `<description>${escapeXml(fields.description)}</description>` : ''));
      return { ok: true, created: fields.code };
    }
    if (action === 'delete') {
      await this.admin('removeSpeedDialNumber', `<code>${escapeXml(fields.code)}</code>`);
      return { ok: true, deleted: fields.code };
    }
    throw new Five9Error(`Unknown action "${action}" — use list, create, or delete.`);
  }

  async manageReasonCode(action, fields = {}) {
    if (action === 'get') {
      if (!fields.name) throw new Five9Error('name is required — Five9 looks up reason codes by exact name (there is no list-all API).');
      const types = fields.type ? [fields.type] : ['NotReady', 'Logout'];
      const out = [];
      for (const t of types) {
        try {
          const r = await this.admin('getReasonCodeByType',
            `<reasonCodeName>${escapeXml(fields.name)}</reasonCodeName><type>${escapeXml(t)}</type>`);
          out.push(...toArray(r.return).map((rc) => ({ ...rc, type: rc.type ?? t })));
        } catch (e) {
          if (!/doesn't exist/i.test(e.message)) throw e;
        }
      }
      return { found: out.length > 0, reasonCodes: out };
    }
    if (action === 'create' || action === 'modify') {
      if (!fields.name || !fields.type) throw new Five9Error('name and type (NotReady | Logout) are required.');
      const rc = { enabled: fields.enabled ?? true, name: fields.name, paidTime: fields.paidTime ?? false, shortcut: fields.shortcut, type: fields.type };
      await this.admin(action === 'create' ? 'createReasonCode' : 'modifyReasonCode', xmlOf(rc, 'reasonCode'));
      return { ok: true, action, reasonCode: fields.name };
    }
    if (action === 'delete') {
      await this.admin('deleteReasonCode', `<reasonCodeName>${escapeXml(fields.name)}</reasonCodeName>`);
      return { ok: true, deleted: fields.name };
    }
    throw new Five9Error(`Unknown action "${action}" — use list, create, modify, or delete.`);
  }

  async getDialingRules() {
    const r = await this.admin('getDialingRules', '');
    return toArray(r.return);
  }

  async getVCCConfiguration() {
    const r = await this.admin('getVCCConfiguration', '');
    return r.return || {};
  }

  async getApiUsage() {
    const r = await this.admin('getCallCountersState', '');
    return toArray(r.return);
  }

  // ---- Tier-2: roles, web connectors, campaign-profile filters, IVR, WAV ----

  // Grant/revoke user roles. modifyUser element order is userGeneralInfo,
  // rolesToSet, rolesToRemove. The supervisor role requires >=1 viewable tab,
  // so it defaults to a sensible view set unless permissions.supervisor is given.
  async setUserRoles(userName, { add, remove, permissions } = {}) {
    const gi = (await this.admin('getUserGeneralInfo', `<userName>${escapeXml(userName)}</userName>`)).return;
    if (!gi) throw new Five9Error(`User "${userName}" not found.`);
    delete gi.fullName;
    const wantAdd = toArray(add).map((x) => String(x).toLowerCase());
    const perms = permissions || {};
    const permList = (list) => ({ permissions: toArray(list).map((t) => (typeof t === 'string' ? { type: t, value: true } : { type: t.type, value: t.value ?? true })) });
    const rolesToSet = {};
    if (wantAdd.includes('agent')) rolesToSet.agent = { alwaysRecorded: false, attachVmToEmail: false, sendEmailOnVm: false };
    if (wantAdd.includes('admin')) rolesToSet.admin = permList(perms.admin);
    if (wantAdd.includes('crmmanager')) rolesToSet.crmManager = permList(perms.crmManager);
    if (wantAdd.includes('reporting')) rolesToSet.reporting = permList(perms.reporting);
    if (wantAdd.includes('supervisor')) {
      const tabs = (perms.supervisor && toArray(perms.supervisor).length) ? perms.supervisor : ['Agents', 'Campaigns', 'CallMonitoring'];
      rolesToSet.supervisor = permList(tabs);
    }
    // rolesToRemove uses the userRoleType enum values.
    const removeMap = { admin: 'DomainAdmin', domainadmin: 'DomainAdmin', agent: 'Agent', supervisor: 'Supervisor', reporting: 'Reporting', crmmanager: 'CrmManager' };
    const rm = toArray(remove).map((x) => removeMap[String(x).toLowerCase()]).filter(Boolean);
    if (!Object.keys(rolesToSet).length && !rm.length) throw new Five9Error('Provide at least one role to add or remove (agent, admin, supervisor, reporting, crmManager).');
    const xml = xmlOf(gi, 'userGeneralInfo')
      + (Object.keys(rolesToSet).length ? xmlOf(rolesToSet, 'rolesToSet') : '')
      + rm.map((r) => `<rolesToRemove>${escapeXml(r)}</rolesToRemove>`).join('');
    await this.admin('modifyUser', xml);
    return { ok: true, user: userName, added: Object.keys(rolesToSet), removed: rm };
  }

  // Web connectors — create/delete. (modifyWebConnector's read-modify-write
  // round-trip is finicky about nested keyValuePair fields; left out for now.)
  async manageWebConnector(action, fields = {}) {
    if (action === 'delete') {
      if (!fields.name) throw new Five9Error('name is required.');
      await this.admin('deleteWebConnector', `<name>${escapeXml(fields.name)}</name>`);
      return { ok: true, deleted: fields.name };
    }
    if (action === 'create') {
      if (!fields.name || !fields.url) throw new Five9Error('name and url are required.');
      const connector = {
        addWorksheet: fields.addWorksheet ?? false,
        agentApplication: fields.agentApplication || 'EmbeddedBrowser',
        description: fields.description,
        executeInBrowser: fields.executeInBrowser ?? true,
        name: fields.name,
        postMethod: fields.postMethod ?? false,
        trigger: fields.trigger || 'ManuallyStarted',
        url: fields.url,
      };
      await this.admin('createWebConnector', xmlOf(connector, 'connector'));
      return { ok: true, created: fields.name };
    }
    throw new Five9Error(`Unknown action "${action}" — use create or delete.`);
  }

  // Campaign-profile CRM filter criteria + result ordering.
  async getCampaignProfileFilter(profileName) {
    const r = await this.admin('getCampaignProfileFilter', `<profileName>${escapeXml(profileName)}</profileName>`);
    return r.return || {};
  }

  async modifyCampaignProfileCrmCriteria(profileName, { grouping, addCriteria, removeCriteria } = {}) {
    let xml = `<profileName>${escapeXml(profileName)}</profileName>`;
    if (grouping) xml += xmlOf(grouping, 'grouping');
    xml += toArray(addCriteria).map((c) => xmlOf(c, 'addCriteria')).join('');
    xml += toArray(removeCriteria).map((c) => xmlOf(c, 'removeCriteria')).join('');
    await this.admin('modifyCampaignProfileCrmCriteria', xml);
    return { ok: true, profile: profileName };
  }

  async modifyCampaignProfileFilterOrder(campaignProfile, { addOrderByField, removeOrderByField } = {}) {
    let xml = `<campaignProfile>${escapeXml(campaignProfile)}</campaignProfile>`;
    xml += toArray(addOrderByField).map((f) => xmlOf(f, 'addOrderByField')).join('');
    xml += toArray(removeOrderByField).map((f) => `<removeOrderByField>${escapeXml(f)}</removeOrderByField>`).join('');
    await this.admin('modifyCampaignProfileFilterOrder', xml);
    return { ok: true, profile: campaignProfile };
  }

  // IVR scripts — create (empty), modify (push xmlDefinition), delete. The
  // caller supplies the full xmlDefinition string.
  async createIVRScript(name, xmlDefinition, description) {
    await this.admin('createIVRScript', `<name>${escapeXml(name)}</name>`);
    if (xmlDefinition) await this.admin('modifyIVRScript', xmlOf({ description, name, xmlDefinition }, 'scriptDef'));
    return { ok: true, created: name, definitionPushed: Boolean(xmlDefinition) };
  }

  async modifyIVRScript(name, xmlDefinition, description) {
    if (!xmlDefinition) throw new Five9Error('xml_definition is required to modify an IVR script.');
    await this.admin('modifyIVRScript', xmlOf({ description, name, xmlDefinition }, 'scriptDef'));
    return { ok: true, modified: name };
  }

  async deleteIVRScript(name) {
    await this.admin('deleteIVRScript', `<name>${escapeXml(name)}</name>`);
    return { ok: true, deleted: name };
  }

  // Pre-recorded WAV prompts — create/modify/delete. wavBase64 is the
  // base64-encoded WAV file (Five9 requires G.711 u-law, 8kHz, mono).
  async managePromptWav(action, { name, wavBase64, description, language } = {}) {
    if (action === 'delete') {
      if (!name) throw new Five9Error('name is required.');
      await this.admin('deletePrompt', `<promptName>${escapeXml(name)}</promptName>`);
      return { ok: true, deleted: name };
    }
    if (!name || !wavBase64) throw new Five9Error('name and wav_base64 are required.');
    const method = { create: 'addPromptWavInline', modify: 'modifyPromptWavInline' }[action];
    if (!method) throw new Five9Error(`Unknown action "${action}" — use create, modify, or delete.`);
    const prompt = { description, languages: language || 'en-US', name, type: 'PreRecorded' };
    await this.admin(method, xmlOf(prompt, 'prompt') + `<wavFile>${escapeXml(wavBase64)}</wavFile>`);
    return { ok: true, action, prompt: name };
  }

  // ---- Statistics (supervisor) API ----

  async getRealtimeStats(statisticType) {
    await this.supervisor('setSessionParameters',
      `<viewSettings><forceLogoutSession>true</forceLogoutSession><rollingPeriod>Minutes30</rollingPeriod>` +
      `<statisticsRange>CurrentDay</statisticsRange><shiftStart>0</shiftStart><timeZone>0</timeZone></viewSettings>`);
    const r = await this.supervisor('getStatistics', `<statisticType>${escapeXml(statisticType)}</statisticType>`);
    const ret = r.return || {};
    const columns = toArray(ret.columns?.values?.data);
    const rows = toArray(ret.rows).map((row) => {
      const values = toArray(row.values?.data);
      const obj = {};
      columns.forEach((c, i) => { obj[c] = values[i] ?? ''; });
      return obj;
    });
    return { statisticType, timestamp: ret.timestamp ?? null, columns, count: rows.length, rows };
  }
}
