// IVR flow composer, validator, and renderer.
//
// Five9's IVR designer persists scripts as a proprietary XML graph. Letting a
// model freestyle that XML produces plausible-but-broken scripts, so this
// module takes a constrained JSON "flow spec" instead, validates it as a
// graph, and emits XML shaped exactly like real designer output (field order,
// boilerplate, and prompt encoding were all derived from scripts exported off
// a live domain).
//
// Flow spec:
// {
//   "entry": "greeting",
//   "nodes": {
//     "greeting":  { "type": "play", "prompt": PROMPT, "next": "hours" },
//     "hours":     { "type": "hours", "days": ["MON","FRI"] or ["MON","TUE",...],
//                    "open": "08:00", "close": "17:00",
//                    "during_hours": "menu1", "after_hours": "vm" },
//     "menu1":     { "type": "menu", "prompt": PROMPT, "max_attempts": 3,
//                    "options": [ { "digit": 1, "label": "Scheduling", "next": "sched" } ] },
//     "sched":     { "type": "skill_transfer", "skills": ["Scheduling"],
//                    "max_queue_seconds": 600, "next": "vm" },
//     "vm":        { "type": "voicemail", "skill": "Scheduling" },
//     "bye":       { "type": "hangup" }
//   }
// }
// PROMPT is { "tts": "text" } (Five9 built-in TTS voice) or
// { "prompt_name": "MyUploadedPrompt" } (a domain prompt, e.g. an AI voice WAV
// uploaded with generate_prompt_audio).
//
// "hours" days use three-letter names; the set must be a contiguous range in
// Five9 day order (SUN=1 .. SAT=7), e.g. MON..FRI. Times are 24h "HH:MM" in
// the domain's IVR time zone.

import { escapeXml, parseXml, toArray } from './five9.js';

export const IVR_NODE_TYPES = ['play', 'menu', 'hours', 'skill_transfer', 'voicemail', 'hangup'];

const DAY_NUM = { SUN: 1, MON: 2, TUE: 3, WED: 4, THU: 5, FRI: 6, SAT: 7 };

// Default event prompts present in every designer script. The gzip+base64
// payloads are byte-identical to the ones Five9's own designer writes.
const DEFAULT_PROMPTS = [
  { name: 'NoMatchPrompt', description: 'Default prompt for NoMatch event', blob: 'H4sIAAAAAAAAAIWRQYvCMBCF7/6KkLvO7k0krSis4Fnd+2gHCZtOpTMV++83VqimXdmcku+F9x4zbnkrg7lSLb7izH7OPqwhPlWF53NmD/vNdG6NKHKBoWLKbEtil/nEyYXw5ytQSaz5xMTjULX2x0ZJHqCDAfm8isITdZixpDxGL+66g+6Z/ujdvjE0tEYhc73fMks8PewsvIRAmuJgWMV5pfK1lmC7kqT+OFhgoAxMeq500z+9/vdMvd+Jx6po821cS13TSY3nS6MzBx0e14G3fRwM5wDjQfSfopgs+RfRtLpiLAIAAA==' },
  { name: 'ConfirmPromptWithoutVSR', description: 'Default prompt for user input confirmation with disabled voice recognition', blob: 'H4sIAAAAAAAAANVT0UrDMBR931eEvK9xPslIOypMGAwVtyk+lbS9bsE0GUla17837bA23YYg+GDJQ3PO5ZyTexM6OxQCVaANVzLEk+AKI5CZyrnchnizvhvfYGQskzkTSkKIazB4Fo2o2QN7nwsoQNpohNxHmbWap6UFcwRaUDC5jR3xDbWwZAVEznra8JS0W7+iU3tmooRbZgBVzV+IQY43K0x6JsR3oWQYhXILRT+WYXVsvPinxoYMmIFIh1s42LNaP2v62pfIVOV19KpKNxoLGvKpO2KLnWYhF8NQMmwCOd8FWjHNWSrgV/0Zgl9i982Ik2T1skiWi/X8KV4mCSUe20t2McJ/nFyAHjUYg/AEI/6G7I4b5FamtIbMBujB7kB/cHfD98e6a/xX8+2KHOm94E/oteYzCQQAAA==' },
  { name: 'ConfirmPrompt', description: 'Default prompt for user input confirmation', blob: 'H4sIAAAAAAAAANVTUWvCMBB+91ccebeZexqSVhw4EMTB1A2fSrQ3DWsTyaXO/vulHXNttQwGe1jIQ/J9ue++3CVidMpSOKIlZXTIBsENA9Rbkyi9C9lq+dC/Y0BO6kSmRmPICiQ2inqCDijfJilmqF3UAz+EdM6qTe6QPoEKTKXejT3xDVWwlhlGPvWw5AWvts0TZ7VnmeZ4LwnhWK5Chrq/WjBeS8KbWQRvWxHKYVa3RbIYU8P+ZWLiLaYlcsYdntxVrZ81m9pd5MYkRbQ2uW+NQ4vJ0F+xwi698E4zgreLwK9XQRylVXKT4q/q0wa/xOZli+N48TKNZ9Pl5Gk8i2PBG2zNWaeF/9i5ABayALb2XweMhYNFImADBuoV3F4R+Lk11uLWBfDo9mjflX/uVAbNTT3mlv1V48+HPNn42h9LoLssIgQAAA==' },
  { name: 'NoInputPrompt', description: 'Default prompt for NoInput event', blob: 'H4sIAAAAAAAAAIWRQYvCMBCF7/6KkHsdvS1LWnFhBc+7eh/toMV0Ip2p2H9vrVBNu7I5Je8b3ntM3OJaenOhSorAqZ1PZ9YQ70Ne8CG1m99V8mGNKHKOPjCltiGxi2zi5Ex4+vZUEms2Me1xqFoVu1pJHkIneuTDsgVPqZMZS8ra6M87d9A944nebYu+pi8UMpf7LbXEyebHwksIxCkOhlVcoVS+1hJslhLVHwcLDMjApNeVrvqn1/+esfc7uAt5k63NHpmDmiNhZZpQTx10YFwI3jZyMNwEjFfRD7Uw+uYbQw31uC4CAAA=' },
];

// Constant TCPA consent boilerplate the designer writes into skillTransfer.
const TCPA_CONSENT_BLOB = 'H4sIAAAAAAAAADWOwQ3DMAwDV+EARYboL58uUPSh2EwjwJYCy878TVDkS/IOnJHcgtbRHY2JehBJSgmszSvezxFqjMBLKj+Qc7gRnYX75kbYqAsb9uaHZmbI4gcfUEtlZLXv1VTv6iblL54wY1hmiy6WT93pvE9owLxDriDrRcFX7KOlTYLTD1kSDbGuAAAA';

export function ivrGuid() {
  return crypto.randomUUID().replace(/-/g, '').toUpperCase();
}

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

// gzip+base64, matching the encoding the designer uses for TTS payloads.
export async function gzipBase64(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return b64(new Uint8Array(await new Response(stream).arrayBuffer()));
}

// The inner document of a TTS payload: a speakElement saying plain text.
export function speakXml(text, language = 'en-US') {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<speakElement><attributes><langAttr><name>xml:lang</name><attributeValueBase value="${escapeXml(language)}"/></langAttr></attributes>` +
    `<items><sayAsElement><attributes/><items><textElement><attributes/><items/><body>${escapeXml(text)}</body></textElement></items></sayAsElement></items></speakElement>`;
}

const minutesOf = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

// ---- Validation ----

// Node keys are looked up as OWN properties only: "toString" or "constructor"
// as an entry or a next target must not resolve to a prototype member.
const hasNode = (nodes, k) => typeof k === 'string' && Object.hasOwn(nodes, k) && Boolean(nodes[k]);

export function validateFlow(flow) {
  const errors = [];
  const warnings = [];
  const nodes = flow?.nodes || {};
  const keys = Object.keys(nodes);
  const bad = (msg) => errors.push(msg);

  if (!keys.length) bad('flow.nodes is empty.');
  if (!flow?.entry) bad('flow.entry is required (the node the call starts at).');
  else if (!hasNode(nodes, flow.entry)) bad(`flow.entry "${flow.entry}" is not a node.`);

  const edgeTargets = (node) => {
    switch (node.type) {
      case 'play': return node.next ? [node.next] : [];
      case 'hours': return [node.during_hours, node.after_hours].filter(Boolean);
      case 'menu': return toArray(node.options).map((o) => o?.next).filter(Boolean);
      case 'skill_transfer': return node.next ? [node.next] : [];
      default: return [];
    }
  };

  for (const [key, node] of Object.entries(nodes)) {
    if (!node || typeof node !== 'object') { bad(`node "${key}" must be an object.`); continue; }
    if (!IVR_NODE_TYPES.includes(node.type)) { bad(`node "${key}": unknown type "${node.type}" (use ${IVR_NODE_TYPES.join(', ')}).`); continue; }

    for (const t of edgeTargets(node)) {
      if (!hasNode(nodes, t)) bad(`node "${key}" points at "${t}", which does not exist.`);
    }

    if (node.type === 'play') {
      if (!validPrompt(node.prompt)) bad(`node "${key}": play needs prompt { tts } or { prompt_name }.`);
      if (!node.next) bad(`node "${key}": play needs next (what happens after the message).`);
    }
    if (node.type === 'menu') {
      if (!validPrompt(node.prompt)) bad(`node "${key}": menu needs prompt { tts } or { prompt_name }.`);
      const opts = toArray(node.options);
      if (!opts.length) bad(`node "${key}": menu needs at least one option.`);
      const digits = new Set();
      const labels = new Set();
      for (const o of opts) {
        if (!o || !Number.isInteger(o.digit) || o.digit < 0 || o.digit > 9) bad(`node "${key}": every option needs digit 0-9.`);
        else if (digits.has(o.digit)) bad(`node "${key}": digit ${o.digit} is used twice.`);
        else digits.add(o.digit);
        const label = String(o?.label || '').trim();
        if (!label) bad(`node "${key}": every option needs a label.`);
        else if (label.toLowerCase() === 'no match') bad(`node "${key}": "No Match" is a reserved branch name.`);
        else if (labels.has(label)) bad(`node "${key}": option label "${label}" is used twice.`);
        else labels.add(label);
        if (!o?.next) bad(`node "${key}": option "${label || o?.digit}" needs next.`);
      }
      const ma = node.max_attempts ?? 3;
      if (!Number.isInteger(ma) || ma < 1 || ma > 9) bad(`node "${key}": max_attempts must be 1-9.`);
    }
    if (node.type === 'hours') {
      const days = toArray(node.days).map((d) => String(d).toUpperCase());
      if (!days.length || days.some((d) => !(d in DAY_NUM))) {
        bad(`node "${key}": days must use SUN MON TUE WED THU FRI SAT.`);
      } else {
        const nums = [...new Set(days.map((d) => DAY_NUM[d]))].sort((a, b) => a - b);
        if (nums[nums.length - 1] - nums[0] !== nums.length - 1) {
          bad(`node "${key}": days must be a contiguous range in SUN..SAT order (e.g. MON-FRI). Split other patterns into two hours nodes.`);
        }
      }
      const open = minutesOf(node.open);
      const close = minutesOf(node.close);
      if (open === null || close === null) bad(`node "${key}": open/close must be "HH:MM" 24h times.`);
      else if (open >= close) bad(`node "${key}": open must be before close (overnight windows are not supported yet).`);
      if (!node.during_hours) bad(`node "${key}": during_hours target is required.`);
      if (!node.after_hours) bad(`node "${key}": after_hours target is required.`);
    }
    if (node.type === 'skill_transfer') {
      if (!toArray(node.skills).length) bad(`node "${key}": skill_transfer needs at least one skill name.`);
      if (!node.next) bad(`node "${key}": skill_transfer needs next (where the call goes if the queue times out, e.g. a voicemail node).`);
      const mq = node.max_queue_seconds ?? 600;
      if (!Number.isInteger(mq) || mq < 10 || mq > 18000) bad(`node "${key}": max_queue_seconds must be 10-18000.`);
    }
    if (node.type === 'voicemail' && !node.skill) {
      bad(`node "${key}": voicemail needs skill (the skill voicemail box to leave the message in).`);
    }
  }

  // Reachability from entry.
  if (flow?.entry && hasNode(nodes, flow.entry)) {
    const seen = new Set();
    const queue = [flow.entry];
    while (queue.length) {
      const k = queue.shift();
      if (seen.has(k) || !hasNode(nodes, k)) continue;
      seen.add(k);
      queue.push(...edgeTargets(nodes[k]));
    }
    const orphans = keys.filter((k) => !seen.has(k));
    if (orphans.length) warnings.push(`unreachable nodes (nothing routes to them): ${orphans.join(', ')}`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

const validPrompt = (p) => p && typeof p === 'object' &&
  (typeof p.tts === 'string' && p.tts.trim() !== '' || typeof p.prompt_name === 'string' && p.prompt_name.trim() !== '');

// Names referenced by the flow that must exist on the domain before compose.
export function collectFlowRefs(flow) {
  const skills = new Set();
  const prompts = new Set();
  for (const node of Object.values(flow?.nodes || {})) {
    if (!node) continue;
    if (node.type === 'skill_transfer') for (const s of toArray(node.skills)) skills.add(String(s));
    if (node.type === 'voicemail' && node.skill) skills.add(String(node.skill));
    if (node.prompt?.prompt_name) prompts.add(String(node.prompt.prompt_name));
  }
  return { skills: [...skills], prompts: [...prompts] };
}

// ---- Composition ----

// Emit XML for one prompt slot. flags follow observed designer output: file
// prompts keep ttsEnumed false, inline TTS marks both TTS flags true.
function compoundPromptXml(prompt, resolved, ttsXmlBlob) {
  const flags = (tts) =>
    `<interruptible>false</interruptible><canChangeInterruptableOption>true</canChangeInterruptableOption>` +
    `<ttsEnumed>${tts}</ttsEnumed><exitModuleOnException>false</exitModuleOnException>`;
  if (prompt.prompt_name) {
    const p = resolved.prompts.get(prompt.prompt_name.toLowerCase());
    return `<filePrompt><promptData><promptSelected>true</promptSelected>` +
      `<prompt><id>${p.id}</id><name>${escapeXml(p.name)}</name></prompt>` +
      `<isRecordedMessage>false</isRecordedMessage></promptData></filePrompt>${flags(false)}`;
  }
  return `<ttsPrompt><xml>${ttsXmlBlob}</xml><promptTTSEnumed>true</promptTTSEnumed></ttsPrompt>${flags(true)}`;
}

const promptChannelBoilerplate =
  '<vivrPrompts><interruptible>false</interruptible><canChangeInterruptableOption>true</canChangeInterruptableOption><ttsEnumed>false</ttsEnumed><exitModuleOnException>false</exitModuleOnException></vivrPrompts>' +
  '<vivrHeader><interruptible>false</interruptible><canChangeInterruptableOption>true</canChangeInterruptableOption><ttsEnumed>false</ttsEnumed><exitModuleOnException>false</exitModuleOnException></vivrHeader>' +
  '<textChannelData><textPrompts><interruptible>false</interruptible><canChangeInterruptableOption>true</canChangeInterruptableOption><ttsEnumed>false</ttsEnumed><exitModuleOnException>false</exitModuleOnException></textPrompts><isUsedVivrPrompts>true</isUsedVivrPrompts><isTextOnly>true</isTextOnly></textChannelData>';

const disposXml = (id, name) => `<dispo><id>${id}</id><name>${escapeXml(name)}</name></dispo>`;

const errBoilerplate =
  '<errCode><isVarSelected>false</isVarSelected><integerValue><value>0</value></integerValue></errCode>' +
  '<errDescription><isVarSelected>false</isVarSelected><stringValue><value></value><id>0</id></stringValue></errDescription>';

function moduleEnvelope({ tag, ascendants = [], singleDescendant, exceptionalDescendant, name, x, y, id, data }) {
  return `<${tag}>` +
    ascendants.map((a) => `<ascendants>${a}</ascendants>`).join('') +
    (singleDescendant ? `<singleDescendant>${singleDescendant}</singleDescendant>` : '') +
    (exceptionalDescendant ? `<exceptionalDescendant>${exceptionalDescendant}</exceptionalDescendant>` : '') +
    `<moduleName>${escapeXml(name)}</moduleName>` +
    `<locationX>${x}</locationX><locationY>${y}</locationY>` +
    `<moduleId>${id}</moduleId>` +
    `<data>${data}</data>` +
    `</${tag}>`;
}

// Compose the full xmlDefinition. `resolved` carries domain lookups:
//   { skills: Map(lowerName -> {id, name}), prompts: Map(lowerName -> {id, name}) }
export async function composeIvrXml(flow, resolved) {
  const check = validateFlow(flow);
  if (!check.ok) throw new Error(`Flow is invalid: ${check.errors.join(' | ')}`);

  const missingSkills = collectFlowRefs(flow).skills.filter((s) => !resolved.skills.has(s.toLowerCase()));
  const missingPrompts = collectFlowRefs(flow).prompts.filter((p) => !resolved.prompts.has(p.toLowerCase()));
  if (missingSkills.length) throw new Error(`Skills not found on the domain: ${missingSkills.join(', ')}. Create them first (manage_skill) or fix the names.`);
  if (missingPrompts.length) throw new Error(`Prompts not found on the domain: ${missingPrompts.join(', ')}. Upload them first (generate_prompt_audio / manage_wav_prompt) or use { tts } prompts.`);

  const nodes = flow.nodes;
  const ids = Object.fromEntries(Object.keys(nodes).map((k) => [k, ivrGuid()]));
  const incomingId = ivrGuid();

  // Edges (from -> to) drive both ascendant lists and the BFS layout.
  const edges = [['__incoming__', flow.entry]];
  for (const [key, node] of Object.entries(nodes)) {
    if (node.type === 'play' && node.next) edges.push([key, node.next]);
    if (node.type === 'hours') edges.push([key, node.during_hours], [key, node.after_hours]);
    if (node.type === 'menu') {
      for (const o of toArray(node.options)) edges.push([key, o.next]);
      edges.push([key, key]); // No Match branch loops back to the menu itself
    }
    if (node.type === 'skill_transfer' && node.next) edges.push([key, node.next]);
  }
  const idOf = (k) => (k === '__incoming__' ? incomingId : ids[k]);
  const ascendantsOf = (key) => edges.filter(([, to]) => to === key).map(([from]) => idOf(from));

  // Layered layout: BFS depth -> column, order of discovery -> row.
  const depth = { __incoming__: 0 };
  const order = ['__incoming__'];
  {
    const queue = ['__incoming__'];
    while (queue.length) {
      const k = queue.shift();
      for (const [from, to] of edges) {
        if (from !== k || to in depth) continue;
        depth[to] = depth[k] + 1;
        order.push(to);
        queue.push(to);
      }
    }
  }
  const rows = {};
  const posOf = (k) => {
    const d = depth[k] ?? 1;
    rows[d] = (rows[d] ?? 0) + 1;
    return { x: 20 + d * 220, y: 10 + (rows[d] - 1) * 110 };
  };

  // Per-script GUIDs for the default event prompts.
  const defaults = DEFAULT_PROMPTS.map((p) => ({ ...p, guid: ivrGuid() }));
  const defaultGuid = (name) => defaults.find((p) => p.name === name).guid;

  const moduleXml = [];
  {
    const { x, y } = posOf('__incoming__');
    moduleXml.push(moduleEnvelope({
      tag: 'incomingCall', singleDescendant: ids[flow.entry],
      name: 'IncomingCall1', x, y, id: incomingId, data: '',
    }));
  }

  // Reachable nodes first (BFS order drives layout); unreachable nodes are
  // still emitted so the designer shows what the spec author wrote.
  const emitOrder = [...order.filter((k) => k !== '__incoming__'), ...Object.keys(nodes).filter((k) => !(k in depth))];
  for (const key of emitOrder) {
    const node = nodes[key];
    const { x, y } = posOf(key);
    const base = { ascendants: ascendantsOf(key), name: moduleLabel(key), x, y, id: ids[key] };
    const ttsBlob = node.prompt?.tts ? await gzipBase64(speakXml(node.prompt.tts, flow.language || 'en-US')) : null;

    if (node.type === 'play') {
      moduleXml.push(moduleEnvelope({
        ...base, tag: 'play', singleDescendant: ids[node.next],
        data:
          `<prompt>${compoundPromptXml(node.prompt, resolved, ttsBlob)}</prompt>` +
          disposXml(-17, 'Caller Disconnected') +
          promptChannelBoilerplate +
          '<numberOfDigits>0</numberOfDigits><terminateDigit>N/A</terminateDigit><clearDigitBuffer>false</clearDigitBuffer><collapsible>false</collapsible>' +
          '<emailReplySubject><interruptible>false</interruptible><canChangeInterruptableOption>true</canChangeInterruptableOption><ttsEnumed>false</ttsEnumed><exitModuleOnException>false</exitModuleOnException></emailReplySubject>' +
          '<emailReplyBody><interruptible>false</interruptible><canChangeInterruptableOption>true</canChangeInterruptableOption><ttsEnumed>false</ttsEnumed><exitModuleOnException>false</exitModuleOnException></emailReplyBody>',
      }));
    }

    if (node.type === 'menu') {
      const opts = toArray(node.options);
      const branchEntry = (name, target) =>
        `<entry><key>${escapeXml(name)}</key><value><name>${escapeXml(name)}</name><desc>${target}</desc></value></entry>`;
      const recoEvent = (event, promptGuid, action) =>
        `<recoEvents><event>${event}</event><count>1</count><compoundPrompt>` +
        `<multiLanguagesPromptItem><prompt>${promptGuid}</prompt></multiLanguagesPromptItem>` +
        '<interruptible>false</interruptible><canChangeInterruptableOption>true</canChangeInterruptableOption><ttsEnumed>true</ttsEnumed><exitModuleOnException>false</exitModuleOnException>' +
        `</compoundPrompt><action>${action}</action></recoEvents>`;
      const item = (o) =>
        `<items><choice><type>VALUE</type><value>${escapeXml(o.label)}</value><showInVivr>true</showInVivr></choice>` +
        '<match>APPR</match><thumbnail><type>VALUE</type><value></value><showInVivr>true</showInVivr></thumbnail>' +
        `<dtmf>DTMF_${o.digit}</dtmf><actionType>BRANCH</actionType><actionName>${escapeXml(o.label)}</actionName></items>`;
      moduleXml.push(moduleEnvelope({
        ...base, tag: 'menu',
        data:
          disposXml(-17, 'Caller Disconnected') +
          promptChannelBoilerplate +
          `<branches>${branchEntry('No Match', ids[key])}${opts.map((o) => branchEntry(o.label, ids[o.next])).join('')}</branches>` +
          '<useSpeechRecognition>false</useSpeechRecognition><useDTMF>true</useDTMF><recordUserInput>false</recordUserInput>' +
          `<maxAttempts>${node.max_attempts ?? 3}</maxAttempts><confidenceTreshold>60</confidenceTreshold><saveInput/><saveConfidenceLevel/>` +
          recoEvent('NO_MATCH', defaultGuid('NoMatchPrompt'), 'CONTINUE') +
          recoEvent('NO_INPUT', defaultGuid('NoInputPrompt'), 'REPROMPT') +
          `<prompts><prompt>${compoundPromptXml(node.prompt, resolved, ttsBlob)}</prompt><count>1</count></prompts>` +
          '<confirmData><confirmRequired>NOT_REQUIRED</confirmRequired><requiredConfidence>75</requiredConfidence><maxAttemptsToConfirm>3</maxAttemptsToConfirm>' +
          '<noInputTimeout>3</noInputTimeout><maxTimeToEnter>3</maxTimeToEnter><completeTimeout>0</completeTimeout><confidenceTreshold>75</confidenceTreshold>' +
          '<sensitivity>0</sensitivity><incompleteTimeout>0</incompleteTimeout><swirecNbestListLength>0</swirecNbestListLength>' +
          '<recognizeConfigParameters><recognizeConfigParameter>NO_INPUT_TIMEOUT</recognizeConfigParameter><recognizeConfigParameter>CONFIDENCE_TRESHOLD</recognizeConfigParameter><recognizeConfigParameter>MAX_TIME_TO_ENTER</recognizeConfigParameter></recognizeConfigParameters>' +
          `<prompt><multiLanguagesPromptItem><prompt>${defaultGuid('ConfirmPrompt')}</prompt></multiLanguagesPromptItem>` +
          '<interruptible>true</interruptible><canChangeInterruptableOption>true</canChangeInterruptableOption><ttsEnumed>true</ttsEnumed><exitModuleOnException>false</exitModuleOnException></prompt>' +
          recoEvent('NO_MATCH', defaultGuid('NoMatchPrompt'), 'REPROMPT') +
          recoEvent('NO_INPUT', defaultGuid('NoInputPrompt'), 'REPROMPT') +
          '</confirmData>' +
          opts.map(item).join('') +
          '<maxTimeToEnter>5</maxTimeToEnter><noInputTimeout>5</noInputTimeout><speechCompleteTimeout>1</speechCompleteTimeout>' +
          '<collapsible>false</collapsible><sensitivity>50</sensitivity><incompleteTimeout>2</incompleteTimeout><swirecNbestListLength>2</swirecNbestListLength>' +
          '<recognizeConfigParameters><recognizeConfigParameter>COMPLETE_TIMEOUT</recognizeConfigParameter><recognizeConfigParameter>NO_INPUT_TIMEOUT</recognizeConfigParameter><recognizeConfigParameter>CONFIDENCE_TRESHOLD</recognizeConfigParameter><recognizeConfigParameter>MAX_TIME_TO_ENTER</recognizeConfigParameter></recognizeConfigParameters>',
      }));
    }

    if (node.type === 'hours') {
      const days = toArray(node.days).map((d) => DAY_NUM[String(d).toUpperCase()]).sort((a, b) => a - b);
      const cond = (cmp, variable, rightXml) =>
        `<conditions><comparisonType>${cmp}</comparisonType><joinMode>AND</joinMode>` +
        `<rightOperand><isVarSelected>false</isVarSelected>${rightXml}</rightOperand>` +
        `<leftOperand><isVarSelected>true</isVarSelected><variableName>${variable}</variableName></leftOperand></conditions>`;
      const intVal = (n) => `<integerValue><value>${n}</value></integerValue>`;
      const timeVal = (m) => `<timeValue><minutes>${m}</minutes></timeValue>`;
      moduleXml.push(moduleEnvelope({
        ...base, tag: 'ifElse',
        data:
          `<branches><entry><key>IF</key><value><name>IF</name><desc>${ids[node.during_hours]}</desc></value></entry>` +
          `<entry><key>ELSE</key><value><name>ELSE</name><desc>${ids[node.after_hours]}</desc></value></entry></branches>` +
          '<customCondition>1</customCondition><conditionGrouping>ALL</conditionGrouping>' +
          cond('MORE_THAN', '__DAY__', intVal(days[0] - 1)) +
          cond('LESS_THAN', '__DAY__', intVal(days[days.length - 1] + 1)) +
          cond('MORE_THAN', '__TIME__', timeVal(minutesOf(node.open) - 1)) +
          cond('LESS_THAN', '__TIME__', timeVal(minutesOf(node.close))),
      }));
    }

    if (node.type === 'skill_transfer') {
      const skills = toArray(node.skills).map((s) => resolved.skills.get(String(s).toLowerCase()));
      moduleXml.push(moduleEnvelope({
        ...base, tag: 'skillTransfer', singleDescendant: ids[node.next],
        data:
          disposXml(-5, 'Abandon') +
          `<maxQueueTime>${node.max_queue_seconds ?? 600}</maxQueueTime>` +
          '<queueIfOnCall>true</queueIfOnCall><onCallQueueTime>600</onCallQueueTime>' +
          '<queueIfOnBreakOrLoggedOut>false</queueIfOnBreakOrLoggedOut><onBreakOrLoggedOutQueueTime>600</onBreakOrLoggedOutQueueTime>' +
          '<onQueueTimeoutExpiration>false</onQueueTimeoutExpiration><pauseBeforeTransfer>0</pauseBeforeTransfer><maxRingTime>15</maxRingTime>' +
          '<placeOnBreakIfNoAnswer>true</placeOnBreakIfNoAnswer><vmTransferOnQueueTimeout>false</vmTransferOnQueueTimeout><vmTransferOnDigit>false</vmTransferOnDigit>' +
          '<vmBoxType>SKILL</vmBoxType><clearDigitBuffer>true</clearDigitBuffer><enableMusicOnHold>true</enableMusicOnHold>' +
          '<priorityChangeType>INCREASE</priorityChangeType><priorityChangeValue><isVarSelected>false</isVarSelected><integerValue><value>10</value></integerValue></priorityChangeValue>' +
          `<listOfSkillsEx>${skills.map((s) => `<extrnalObj><id>${s.id}</id><name>${escapeXml(s.name)}</name></extrnalObj>`).join('')}<varSelected>false</varSelected></listOfSkillsEx>` +
          '<taskType>0</taskType><transferAlgorithm><algorithmType>LongestReadyTime</algorithmType><statAlgorithmTimeWindow>E15minutes</statAlgorithmTimeWindow></transferAlgorithm>' +
          '<recordedFilesAction>KEEP_AS_RECORDINGD</recordedFilesAction>' +
          '<callbackPhoneNumberPrompt><id>-26</id><name>CallbackPhoneNumberPrompt</name></callbackPhoneNumberPrompt>' +
          '<callbackConfirmingPhoneNumberPrompt><id>-27</id><name>CallbackConfirmingPhoneNumberPrompt</name></callbackConfirmingPhoneNumberPrompt>' +
          '<callbackEnteringPhoneNumberPrompt><id>-28</id><name>CallbackEnteringPhoneNumberPrompt</name></callbackEnteringPhoneNumberPrompt>' +
          '<callbackRecordingCallerNamePrompt><id>-36</id><name>CallbackRecordingCallerNamePrompt</name></callbackRecordingCallerNamePrompt>' +
          '<callbackConfirmationPrompt><id>-29</id><name>CallbackConfirmationPrompt</name></callbackConfirmationPrompt>' +
          '<callbackQueueTimeoutSec>18000</callbackQueueTimeoutSec><callbackEnterDigitsMaxTimeSec>5</callbackEnterDigitsMaxTimeSec><callbackAllowInternational>false</callbackAllowInternational>' +
          `<isTcpaConsentEnabled>false</isTcpaConsentEnabled><tcpaConsentText>${TCPA_CONSENT_BLOB}</tcpaConsentText>` +
          '<ignoreSkillsOrder>false</ignoreSkillsOrder><recordCallerNameOnQueueCallback>false</recordCallerNameOnQueueCallback>',
      }));
    }

    if (node.type === 'voicemail') {
      const skill = resolved.skills.get(String(node.skill).toLowerCase());
      moduleXml.push(moduleEnvelope({
        ...base, tag: 'voiceMailTransfer',
        data:
          disposXml(-20, 'Sent To Voicemail') +
          `<vmPersonalBox/><vmSkillBox><id>${skill.id}</id><name>${escapeXml(skill.name)}</name></vmSkillBox>` +
          '<isBoxDefinedInVariable>false</isBoxDefinedInVariable><vmBoxType>SKILL</vmBoxType><recordedFilesAction>KEEP_AS_RECORDINGD</recordedFilesAction>',
      }));
    }

    if (node.type === 'hangup') {
      moduleXml.push(moduleEnvelope({
        ...base, tag: 'hangup',
        data:
          disposXml(-17, 'Caller Disconnected') +
          '<returnToCallingModule>true</returnToCallingModule>' + errBoilerplate +
          '<overwriteDisposition>false</overwriteDisposition>',
      }));
    }
  }

  // On-hangup lane: the designer always writes a StartOnHangup -> Hangup pair.
  const onHangupStart = ivrGuid();
  const onHangupEnd = ivrGuid();
  const modulesOnHangup =
    `<startOnHangup><singleDescendant>${onHangupEnd}</singleDescendant><moduleName>StartOnHangup1</moduleName><locationX>20</locationX><locationY>10</locationY><moduleId>${onHangupStart}</moduleId></startOnHangup>` +
    `<hangup><ascendants>${onHangupStart}</ascendants><moduleName>Hangup1</moduleName><locationX>120</locationX><locationY>10</locationY><moduleId>${onHangupEnd}</moduleId>` +
    `<data>${disposXml(-17, 'Caller Disconnected')}<returnToCallingModule>true</returnToCallingModule>${errBoilerplate}<overwriteDisposition>false</overwriteDisposition></data></hangup>`;

  const promptsXml = defaults.map((p) =>
    `<entry><key>${p.guid}</key><value><promptId>${p.guid}</promptId><name>${p.name}</name><description>${escapeXml(p.description)}</description><type>AUDIO</type>` +
    `<prompts><entry key="en-US"><ttsPrompt><xml>${p.blob}</xml><promptTTSEnumed>false</promptTTSEnumed></ttsPrompt></entry></prompts>` +
    `<defaultLanguage>en-US</defaultLanguage><isPersistent>true</isPersistent></value></entry>`).join('');

  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<ivrScript>' +
    '<properties/>' +
    `<modules>${moduleXml.join('')}</modules>` +
    `<modulesOnHangup>${modulesOnHangup}</modulesOnHangup>` +
    '<userVariables/>' +
    `<multiLanguagesPrompts>${promptsXml}</multiLanguagesPrompts>` +
    '<multiLanguagesVIVRPrompts/><multiLanguagesTextPrompts/><multiLanguagesMenuChoices/><multiLanguagesEwtAnnouncement/>' +
    '<languages/><functions/>' +
    `<defaultLanguage>${escapeXml(flow.language || 'en-US')}</defaultLanguage>` +
    '<defaultMethod>GET</defaultMethod><defaultFetchTimeout>5</defaultFetchTimeout><showLabelNames>true</showLabelNames>' +
    '<defaultVivrTimeout>5</defaultVivrTimeout><unicodeEncoding>true</unicodeEncoding><useShortcut>false</useShortcut>' +
    '<resetErrorCode>true</resetErrorCode><showAllChannelPrompts>false</showAllChannelPrompts>' +
    '<extContactFieldsInput>true</extContactFieldsInput><extContactFieldsOutput>true</extContactFieldsOutput>' +
    '<useIvrTimeZoneInAssignment>true</useIvrTimeZoneInAssignment><timeoutInMilliseconds>3600000</timeoutInMilliseconds>' +
    '<version>1200006</version>' +
    '</ivrScript>';

  return { xml, warnings: check.warnings, moduleCount: moduleXml.length + 2 };
}

const moduleLabel = (key) => String(key).replace(/[^A-Za-z0-9 _-]+/g, ' ').trim().slice(0, 50) || 'Module';

// ---- Rendering (Mermaid) ----

const mermaidText = (s) => String(s ?? '').replace(/["`\\]/g, "'").slice(0, 60);

function mermaidNode(id, label, type) {
  const t = mermaidText(label);
  switch (type) {
    case 'incomingCall': case 'start': return `${id}(["📞 ${t}"])`;
    case 'menu': return `${id}{{"🔢 ${t}"}}`;
    case 'hours': case 'ifElse': return `${id}{"🕐 ${t}"}`;
    case 'skill_transfer': case 'skillTransfer': return `${id}[["🧑‍💼 ${t}"]]`;
    case 'voicemail': case 'voiceMailTransfer': return `${id}[/"📬 ${t}"/]`;
    case 'hangup': return `${id}((("☎️ ${t}")))`;
    default: return `${id}["${t}"]`;
  }
}

export function flowToMermaid(flow) {
  const lines = ['flowchart TD'];
  lines.push('  ' + mermaidNode('START', 'Incoming call', 'start'));
  const nid = {};
  Object.keys(flow.nodes || {}).forEach((k, i) => { nid[k] = `N${i}`; });
  for (const [key, node] of Object.entries(flow.nodes || {})) {
    lines.push('  ' + mermaidNode(nid[key], key, node.type));
  }
  lines.push(`  START --> ${nid[flow.entry]}`);
  for (const [key, node] of Object.entries(flow.nodes || {})) {
    if (node.type === 'play' && node.next) lines.push(`  ${nid[key]} --> ${nid[node.next]}`);
    if (node.type === 'hours') {
      lines.push(`  ${nid[key]} -->|"open"| ${nid[node.during_hours]}`);
      lines.push(`  ${nid[key]} -->|"closed"| ${nid[node.after_hours]}`);
    }
    if (node.type === 'menu') {
      for (const o of toArray(node.options)) lines.push(`  ${nid[key]} -->|"${o.digit}: ${mermaidText(o.label)}"| ${nid[o.next]}`);
    }
    if (node.type === 'skill_transfer' && node.next) lines.push(`  ${nid[key]} -->|"queue timeout"| ${nid[node.next]}`);
  }
  return lines.join('\n');
}

// Render an EXISTING script's xmlDefinition (as returned by get_ivr_script).
export function scriptXmlToMermaid(xmlDefinition) {
  const doc = parseXml(xmlDefinition);
  const modules = doc?.ivrScript?.modules;
  if (!modules || typeof modules !== 'object') throw new Error('No <modules> found in the script XML.');
  const nodes = [];
  for (const [type, val] of Object.entries(modules)) {
    for (const m of toArray(val)) {
      if (!m || typeof m !== 'object' || !m.moduleId) continue;
      const edges = [];
      if (m.singleDescendant) edges.push({ to: m.singleDescendant, label: '' });
      if (m.exceptionalDescendant) edges.push({ to: m.exceptionalDescendant, label: 'error' });
      for (const e of toArray(m.data?.branches?.entry)) {
        if (e?.value?.desc) edges.push({ to: e.value.desc, label: e.key ?? e.value.name ?? '' });
      }
      nodes.push({ id: m.moduleId, name: m.moduleName || type, type, edges });
    }
  }
  if (!nodes.length) throw new Error('Script has no modules to render.');
  const nid = {};
  nodes.forEach((n, i) => { nid[n.id] = `M${i}`; });
  const lines = ['flowchart TD'];
  for (const n of nodes) lines.push('  ' + mermaidNode(nid[n.id], n.name, n.type));
  for (const n of nodes) {
    for (const e of n.edges) {
      if (!nid[e.to]) continue;
      lines.push(e.label && e.label !== 'No Match'
        ? `  ${nid[n.id]} -->|"${mermaidText(e.label)}"| ${nid[e.to]}`
        : (e.label === 'No Match'
          ? `  ${nid[n.id]} -.->|"no match"| ${nid[e.to]}`
          : `  ${nid[n.id]} --> ${nid[e.to]}`));
    }
  }
  return lines.join('\n');
}
