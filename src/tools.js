// MCP tool definitions + dispatch. Each tool maps to one or two Five9 SOAP
// calls and returns plain JSON for the model.

import { Five9Client, Five9Error } from './five9.js';
import { Five9RestClient, Five9RestError } from './five9rest.js';
import { restCallRefusal, redactSecrets } from './rest-rules.js';
import { ABOUT } from './about.js';
import { validateFlow, collectFlowRefs, composeIvrXml, flowToMermaid, scriptXmlToMermaid, IVR_NODE_TYPES } from './ivr.js';
import { synthesizeUlawWav } from './tts.js';

export const TOOLS = [
  {
    name: 'about',
    description: 'Who operates this server, why it exists, and how to work with it. Call this when you need context about the operator or ground rules.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    five9: false,
    handler: () => ABOUT,
  },
  {
    name: 'check_connection',
    description: 'Verify that the Worker can authenticate to Five9. Returns the number of skills visible to the configured user. Run this first if other tools are failing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (f9) => {
      const skills = await f9.getSkills('.*');
      return { ok: true, host: f9.host, adminVersion: f9.adminVersion, skillsVisible: skills.length };
    },
  },
  {
    name: 'list_campaigns',
    description: 'List Five9 campaigns (name, type, state, mode). Optional regex pattern filters by campaign name.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Java-style regex on campaign name (default ".*" = all)' } },
      additionalProperties: false,
    },
    handler: (f9, a) => f9.getCampaigns(a.pattern || '.*'),
  },
  {
    name: 'control_campaign',
    description: 'Control a Five9 campaign\'s runtime state by exact name: start, stop (graceful), force_stop (drops active calls), reset (re-enables dialed records), or reset_list_positions (restart lists from the top).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'force_stop', 'reset', 'reset_list_positions'] },
        campaign_name: { type: 'string', description: 'Exact campaign name' },
      },
      required: ['action', 'campaign_name'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.controlCampaign(a.action, a.campaign_name),
  },
  {
    name: 'get_campaign_details',
    description: 'Get a campaign\'s FULL configuration (dialing mode, ratios, recording, wrap-up, timeouts, etc.). Works for outbound, inbound, and autodial campaigns. Use before modify_campaign to see current values.',
    inputSchema: {
      type: 'object',
      properties: { campaign_name: { type: 'string', description: 'Exact campaign name' } },
      required: ['campaign_name'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.getCampaignDetails(a.campaign_name),
  },
  {
    name: 'create_campaign',
    description: 'Create a new Five9 campaign. type outbound or inbound; mode BASIC (default) or ADVANCED (requires profile_name from list_campaign_profiles). Outbound extras: dialing_mode (PREDICTIVE/PROGRESSIVE/PREVIEW/POWER), auto_record. Inbound extras: max_lines. The campaign is created NOT_RUNNING — attach lists/skills/DNIS, then start it with control_campaign.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['outbound', 'inbound'] },
        name: { type: 'string' },
        mode: { type: 'string', enum: ['BASIC', 'ADVANCED'] },
        profile_name: { type: 'string', description: 'Campaign profile (required for ADVANCED mode)' },
        description: { type: 'string' },
        dialing_mode: { type: 'string', enum: ['PREDICTIVE', 'PROGRESSIVE', 'PREVIEW', 'POWER'], description: 'Outbound only' },
        auto_record: { type: 'boolean' },
        max_lines: { type: 'number', description: 'Inbound only: max concurrent lines (default 10)' },
        ivr_script: { type: 'string', description: 'Inbound only (required): IVR script that answers calls — see list_ivr_scripts' },
        training_mode: { type: 'boolean' },
      },
      required: ['type', 'name'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.createCampaign(a.type, {
      name: a.name, mode: a.mode, profileName: a.profile_name, description: a.description,
      dialingMode: a.dialing_mode, autoRecord: a.auto_record, maxNumOfLines: a.max_lines,
      ivrScript: a.ivr_script, trainingMode: a.training_mode,
    }),
  },
  {
    name: 'modify_campaign',
    description: 'Edit an existing campaign\'s configuration. Fetches the full campaign, merges your changes, and writes it back — so you only pass the fields you want to change (field names as returned by get_campaign_details, e.g. {"description": "...", "dialingMode": "PREVIEW", "autoRecord": true, "profileName": "..."}).',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_name: { type: 'string', description: 'Exact campaign name' },
        changes: { type: 'object', description: 'Field → new value, using get_campaign_details field names', additionalProperties: true },
      },
      required: ['campaign_name', 'changes'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.modifyCampaign(a.campaign_name, a.changes),
  },
  {
    name: 'rename_campaign',
    description: 'Rename a Five9 campaign.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_name: { type: 'string' },
        new_name: { type: 'string' },
      },
      required: ['campaign_name', 'new_name'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.renameCampaign(a.campaign_name, a.new_name),
  },
  {
    name: 'delete_campaign',
    description: 'Permanently delete a Five9 campaign. Irreversible — confirm with the user first.',
    inputSchema: {
      type: 'object',
      properties: { campaign_name: { type: 'string', description: 'Exact campaign name' } },
      required: ['campaign_name'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.deleteCampaign(a.campaign_name),
  },
  {
    name: 'manage_campaign_skills',
    description: 'Add or remove routing skills on a campaign (controls which agents get its calls).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'remove'] },
        campaign_name: { type: 'string' },
        skills: { type: 'array', items: { type: 'string' }, description: 'Skill names' },
      },
      required: ['action', 'campaign_name', 'skills'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.manageCampaignSkills(a.action, a.campaign_name, a.skills),
  },
  {
    name: 'manage_campaign_dnis',
    description: 'Attach or detach DNIS (inbound numbers) on an inbound campaign. Use list_dnis to see available numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'remove'] },
        campaign_name: { type: 'string' },
        dnis: { type: 'array', items: { type: 'string' }, description: 'DNIS numbers' },
      },
      required: ['action', 'campaign_name', 'dnis'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.manageCampaignDnis(a.action, a.campaign_name, a.dnis),
  },
  {
    name: 'manage_campaign_dispositions',
    description: 'Add or remove dispositions available to agents on a campaign.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'remove'] },
        campaign_name: { type: 'string' },
        dispositions: { type: 'array', items: { type: 'string' }, description: 'Disposition names' },
      },
      required: ['action', 'campaign_name', 'dispositions'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.manageCampaignDispositions(a.action, a.campaign_name, a.dispositions),
  },
  {
    name: 'list_campaign_profiles',
    description: 'List campaign profiles (ANI, dialing timeout, attempts, call priority). ADVANCED campaigns require one. Optional regex pattern filters by name.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Java-style regex on profile name (default ".*")' } },
      additionalProperties: false,
    },
    handler: (f9, a) => f9.getCampaignProfiles(a.pattern || '.*'),
  },
  {
    name: 'manage_campaign_profile',
    description: 'Create, modify, or delete a campaign profile. For create: fields like {"name": "...", "description": "...", "ANI": "5551234567", "numberOfAttempts": 3, "dialingTimeout": 30}. For modify: pass name plus only the fields to change.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'modify', 'delete'] },
        name: { type: 'string', description: 'Profile name' },
        fields: { type: 'object', description: 'Profile fields (create/modify)', additionalProperties: true },
      },
      required: ['action', 'name'],
      additionalProperties: false,
    },
    handler: (f9, a) => {
      if (a.action === 'create') return f9.createCampaignProfile({ name: a.name, ...(a.fields || {}) });
      if (a.action === 'modify') return f9.modifyCampaignProfile(a.name, a.fields || {});
      return f9.deleteCampaignProfile(a.name);
    },
  },
  {
    name: 'get_skill_details',
    description: 'Get skills with their assigned users. Optional regex pattern filters by skill name.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Java-style regex on skill name (default ".*")' } },
      additionalProperties: false,
    },
    handler: (f9, a) => f9.getSkillDetails(a.pattern || '.*'),
  },
  {
    name: 'manage_skill',
    description: 'Create, modify, or delete a routing skill. Create: {"name": "..."} plus optional description, routeVoiceMails. Modify: pass name and only the fields to change.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'modify', 'delete'] },
        name: { type: 'string', description: 'Skill name' },
        fields: { type: 'object', description: 'Skill fields (create/modify): description, messageOfTheDay, routeVoiceMails', additionalProperties: true },
      },
      required: ['action', 'name'],
      additionalProperties: false,
    },
    handler: (f9, a) => {
      if (a.action === 'create') return f9.createSkill({ name: a.name, ...(a.fields || {}) });
      if (a.action === 'modify') return f9.modifySkill(a.name, a.fields || {});
      return f9.deleteSkill(a.name);
    },
  },
  {
    name: 'manage_user_skills',
    description: 'Assign a skill to a user (add), change their level (set_level), or unassign it (remove). Level 1 is highest priority.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'set_level', 'remove'] },
        user_name: { type: 'string' },
        skill_name: { type: 'string' },
        level: { type: 'number', description: 'Skill level (default 1)' },
      },
      required: ['action', 'user_name', 'skill_name'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.manageUserSkill(a.action, a.user_name, a.skill_name, a.level),
  },
  {
    name: 'get_user_details',
    description: 'Get one user\'s full record: general info, roles, skills, and agent groups.',
    inputSchema: {
      type: 'object',
      properties: { user_name: { type: 'string', description: 'Exact Five9 username' } },
      required: ['user_name'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.getUserDetails(a.user_name),
  },
  {
    name: 'create_user',
    description: 'Create a Five9 user. Required: user_name, password, first_name, last_name, email. roles defaults to ["agent"]; also accepts admin, supervisor, reporting. Optional: extension, user_profile_name, skills (names, assigned at level 1), agent_groups. New users must change their password on first login by default.',
    inputSchema: {
      type: 'object',
      properties: {
        user_name: { type: 'string' },
        password: { type: 'string' },
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        email: { type: 'string' },
        roles: { type: 'array', items: { type: 'string', enum: ['agent', 'admin', 'supervisor', 'reporting'] } },
        extension: { type: 'string' },
        user_profile_name: { type: 'string' },
        skills: { type: 'array', items: { type: 'string' } },
        agent_groups: { type: 'array', items: { type: 'string' } },
        active: { type: 'boolean' },
      },
      required: ['user_name', 'password', 'first_name', 'last_name', 'email'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.createUser({
      userName: a.user_name, password: a.password, firstName: a.first_name, lastName: a.last_name,
      email: a.email, roles: a.roles, extension: a.extension, userProfileName: a.user_profile_name,
      skills: a.skills, agentGroups: a.agent_groups, active: a.active,
    }),
  },
  {
    name: 'modify_user',
    description: 'Edit a user\'s general info. Pass only fields to change, using Five9 field names from list_users (e.g. {"EMail": "...", "extension": "1234", "active": false, "firstName": "..."}).',
    inputSchema: {
      type: 'object',
      properties: {
        user_name: { type: 'string' },
        changes: { type: 'object', description: 'Field → new value', additionalProperties: true },
      },
      required: ['user_name', 'changes'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.modifyUser(a.user_name, a.changes),
  },
  {
    name: 'delete_user',
    description: 'Permanently delete a Five9 user. Irreversible — confirm with the user first.',
    inputSchema: {
      type: 'object',
      properties: { user_name: { type: 'string' } },
      required: ['user_name'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.deleteUser(a.user_name),
  },
  {
    name: 'list_user_profiles',
    description: 'List user profiles (role/permission templates users can be assigned to). Optional regex pattern.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Java-style regex on profile name (default ".*")' } },
      additionalProperties: false,
    },
    handler: (f9, a) => f9.getUserProfiles(a.pattern || '.*'),
  },
  {
    name: 'manage_disposition',
    description: 'Create, modify, rename, or delete a call disposition. Create needs fields.name and fields.type (e.g. FinalDisp, FinalApplyToCampaigns, AddActiveNumber, DoNotDial, RedialNumber). RedialNumber dispositions take typeParameters: {"allowChangeTimer": false, "attempts": 3, "timer": {"days": 0, "hours": 1, "minutes": 0, "seconds": 0}, "useTimer": true}. Modify merges your fields into the existing disposition.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'modify', 'rename', 'delete'] },
        name: { type: 'string', description: 'Disposition name' },
        new_name: { type: 'string', description: 'For rename' },
        fields: { type: 'object', description: 'Disposition fields (create/modify)', additionalProperties: true },
      },
      required: ['action', 'name'],
      additionalProperties: false,
    },
    handler: (f9, a) => {
      if (a.action === 'create') return f9.createDisposition({ name: a.name, ...(a.fields || {}) });
      if (a.action === 'modify') return f9.modifyDisposition(a.name, a.fields || {});
      if (a.action === 'rename') return f9.renameDisposition(a.name, a.new_name);
      return f9.deleteDisposition(a.name);
    },
  },
  {
    name: 'manage_contact_field',
    description: 'Create, modify, or delete a CRM contact field. Create: name + type (STRING, NUMBER, DATE, PHONE, EMAIL, BOOLEAN, etc.), optional displayAs (Short/Long/Invisible). Modify: name + the fields to change (e.g. display_as, or changes: {"displayAs": "Invisible"}) — read-modify-write, so unspecified fields are preserved. System fields cannot be modified.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'modify', 'delete'] },
        name: { type: 'string' },
        type: { type: 'string', enum: ['STRING', 'NUMBER', 'DATE', 'TIME', 'DATE_TIME', 'CURRENCY', 'BOOLEAN', 'PERCENT', 'EMAIL', 'URL', 'PHONE', 'TIME_PERIOD'] },
        display_as: { type: 'string', enum: ['Short', 'Long', 'Invisible'] },
        changes: { type: 'object', description: 'For modify: field → new value using contactField field names (displayAs, type, mapTo)', additionalProperties: true },
      },
      required: ['action', 'name'],
      additionalProperties: false,
    },
    handler: (f9, a) => {
      if (a.action === 'create') return f9.createContactField({ name: a.name, type: a.type, displayAs: a.display_as });
      if (a.action === 'modify') return f9.modifyContactField(a.name, a.changes || { ...(a.display_as ? { displayAs: a.display_as } : {}), ...(a.type ? { type: a.type } : {}) });
      return f9.deleteContactField(a.name);
    },
  },
  {
    name: 'delete_contact',
    description: 'Delete a CRM contact matching the criteria exactly, e.g. {"number1": "5551234567"}. Safety: only deletes when exactly one contact matches. Irreversible — confirm with the user first.',
    inputSchema: {
      type: 'object',
      properties: {
        criteria: { type: 'object', description: 'Field → value identifying one contact', additionalProperties: { type: 'string' } },
      },
      required: ['criteria'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.deleteContact(a.criteria),
  },
  {
    name: 'list_prompts',
    description: 'List all voice prompts on the domain (name, type, languages).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (f9) => f9.getPrompts(),
  },
  {
    name: 'manage_tts_prompt',
    description: 'Create, modify, or delete a text-to-speech voice prompt. Create/modify need name + text (what the prompt says); optional voice and language (default en-US).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'modify', 'delete'] },
        name: { type: 'string', description: 'Prompt name' },
        text: { type: 'string', description: 'What the prompt says (create/modify)' },
        voice: { type: 'string' },
        language: { type: 'string', description: 'e.g. en-US' },
        description: { type: 'string' },
      },
      required: ['action', 'name'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.manageTtsPrompt(a.action, a),
  },
  {
    name: 'get_ivr_script',
    description: 'Get one IVR script including its full XML definition (large). Use list_ivr_scripts to browse names first.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Exact IVR script name' } },
      required: ['name'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.getIVRScript(a.name),
  },
  {
    name: 'manage_agent_group',
    description: 'Create or delete an agent group, or add/remove agents in one. add_agents/remove_agents take agents (usernames).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'delete', 'add_agents', 'remove_agents'] },
        name: { type: 'string', description: 'Group name' },
        agents: { type: 'array', items: { type: 'string' }, description: 'Usernames (for add/remove)' },
        description: { type: 'string', description: 'For create' },
      },
      required: ['action', 'name'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.manageAgentGroup(a.action, a.name, { agents: a.agents, description: a.description }),
  },
  {
    name: 'list_call_variables',
    description: 'List call variables (optionally filtered by regex pattern and/or group), or pass groups_only to list the variable groups instead.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Java-style regex on variable name' },
        group: { type: 'string', description: 'Variable group name, e.g. Call' },
        groups_only: { type: 'boolean', description: 'List variable groups instead of variables' },
      },
      additionalProperties: false,
    },
    handler: (f9, a) => (a.groups_only ? f9.getCallVariableGroups() : f9.getCallVariables(a.pattern || '.*', a.group)),
  },
  {
    name: 'manage_call_variable',
    description: 'Create or delete a custom call variable. Create: name, group, optional type (STRING default), description, default_value, reporting.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'delete'] },
        name: { type: 'string' },
        group: { type: 'string', description: 'Variable group (required)' },
        type: { type: 'string', enum: ['STRING', 'NUMBER', 'DATE', 'TIME', 'DATE_TIME', 'CURRENCY', 'BOOLEAN', 'PERCENT', 'EMAIL', 'URL', 'PHONE', 'TIME_PERIOD'] },
        description: { type: 'string' },
        default_value: { type: 'string' },
        reporting: { type: 'boolean', description: 'Include in reports' },
      },
      required: ['action', 'name', 'group'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.manageCallVariable(a.action, { name: a.name, group: a.group, type: a.type, description: a.description, defaultValue: a.default_value, reporting: a.reporting }),
  },
  {
    name: 'list_web_connectors',
    description: 'List web connectors (URL pop / webhook-style integrations agents trigger). Optional regex pattern.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Java-style regex on connector name (default ".*")' } },
      additionalProperties: false,
    },
    handler: (f9, a) => f9.getWebConnectors(a.pattern || '.*'),
  },
  {
    name: 'manage_speed_dial',
    description: 'List, create, or delete domain speed-dial numbers. Create: code (what agents dial) + number (where it goes).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'delete'] },
        code: { type: 'string' },
        number: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.manageSpeedDial(a.action, a),
  },
  {
    name: 'manage_reason_code',
    description: 'Get, create, modify, or delete Not Ready / Logout reason codes. Five9 looks these up by exact name (no list-all API). Create/modify: name + type (NotReady | Logout), optional enabled, paidTime, shortcut.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'create', 'modify', 'delete'] },
        name: { type: 'string', description: 'Exact reason code name' },
        type: { type: 'string', enum: ['NotReady', 'Logout'] },
        enabled: { type: 'boolean' },
        paid_time: { type: 'boolean' },
        shortcut: { type: 'number' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.manageReasonCode(a.action, { name: a.name, type: a.type, enabled: a.enabled, paidTime: a.paid_time, shortcut: a.shortcut }),
  },
  {
    name: 'get_dialing_rules',
    description: 'Get the domain\'s dialing rules (time/state restrictions applied to outbound dialing).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (f9) => f9.getDialingRules(),
  },
  {
    name: 'get_vcc_configuration',
    description: 'Get domain-level VCC configuration (timezone, password policies, default settings).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (f9) => f9.getVCCConfiguration(),
  },
  {
    name: 'get_api_usage',
    description: 'Get current Five9 API usage counters vs limits for this domain (how close you are to API rate caps).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (f9) => f9.getApiUsage(),
  },
  {
    name: 'list_dialing_lists',
    description: 'List Five9 outbound dialing lists with their record counts. Optional regex pattern filters by list name.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Java-style regex on list name (default ".*" = all)' } },
      additionalProperties: false,
    },
    handler: (f9, a) => f9.getLists(a.pattern || '.*'),
  },
  {
    name: 'add_record_to_list',
    description: 'Add one record (lead) to a Five9 dialing list. "fields" maps Five9 contact field names to values, e.g. {"number1": "5551234567", "first_name": "Jane", "last_name": "Doe"}. number1 is the primary phone field. The import is processed asynchronously by Five9.',
    inputSchema: {
      type: 'object',
      properties: {
        list_name: { type: 'string', description: 'Exact dialing list name' },
        fields: {
          type: 'object',
          description: 'Contact field name → value. Must include at least one field; number1 is the standard primary phone field.',
          additionalProperties: { type: 'string' },
        },
        key_field: { type: 'string', description: 'Field used to match existing contacts (default: number1)' },
      },
      required: ['list_name', 'fields'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.addRecordToList(a.list_name, a.fields, a.key_field),
  },
  {
    name: 'search_contacts',
    description: 'Look up contact records in the Five9 CRM by exact field values, e.g. {"number1": "5551234567"} or {"last_name": "Doe"}. Returns matching records as field→value objects.',
    inputSchema: {
      type: 'object',
      properties: {
        criteria: {
          type: 'object',
          description: 'Contact field name → exact value to match. At least one entry required.',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['criteria'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.searchContacts(a.criteria),
  },
  {
    name: 'list_users',
    description: 'List Five9 users (agents, supervisors, admins) with their general info. Optional regex pattern filters by username.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Java-style regex on username (default ".*" = all)' } },
      additionalProperties: false,
    },
    handler: (f9, a) => f9.getUsers(a.pattern || '.*'),
  },
  {
    name: 'list_skills',
    description: 'List Five9 skills (routing queues). Optional regex pattern filters by skill name.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Java-style regex on skill name (default ".*" = all)' } },
      additionalProperties: false,
    },
    handler: (f9, a) => f9.getSkills(a.pattern || '.*'),
  },
  {
    name: 'list_dispositions',
    description: 'List Five9 call dispositions and their settings. Optional regex pattern filters by disposition name.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Java-style regex on disposition name (default ".*" = all)' } },
      additionalProperties: false,
    },
    handler: (f9, a) => f9.getDispositions(a.pattern || '.*'),
  },
  {
    name: 'run_report',
    description: 'Start a Five9 report run by folder and report name (as shown in the Five9 reporting UI, e.g. folder "Call Log Reports", report "Call Log"). Returns an identifier to poll with get_report_result. Optional ISO-8601 start/end narrow the time range.',
    inputSchema: {
      type: 'object',
      properties: {
        folder_name: { type: 'string', description: 'Report folder name in Five9' },
        report_name: { type: 'string', description: 'Report name within the folder' },
        start: { type: 'string', description: 'ISO-8601 start time, e.g. 2026-07-21T00:00:00.000Z (requires end)' },
        end: { type: 'string', description: 'ISO-8601 end time (requires start)' },
      },
      required: ['folder_name', 'report_name'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.runReport(a.folder_name, a.report_name, a.start, a.end),
  },
  {
    name: 'get_report_result',
    description: 'Fetch the result of a report started with run_report. Returns {ready: false} while Five9 is still generating it; when ready, returns the report as CSV text.',
    inputSchema: {
      type: 'object',
      properties: { identifier: { type: 'string', description: 'Identifier returned by run_report' } },
      required: ['identifier'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.getReportResult(a.identifier),
  },
  {
    name: 'list_contact_fields',
    description: 'List the contact field definitions on this Five9 domain (name, type, restrictions). Call this to learn valid field names before add_record_to_list, update_contact, or search_contacts.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Java-style regex on field name (default ".*" = all)' } },
      additionalProperties: false,
    },
    handler: (f9, a) => f9.getContactFields(a.pattern || '.*'),
  },
  {
    name: 'update_contact',
    description: 'Update an existing Five9 CRM contact. "key" identifies the contact (e.g. {"number1": "5551234567"}), "fields" holds the new values. Does not create contacts (use add_record_to_list for that). Default update_mode UPDATE_SOLE_MATCHES only updates when exactly one contact matches the key.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'object', description: 'Field name → value identifying the contact', additionalProperties: { type: 'string' } },
        fields: { type: 'object', description: 'Field name → new value', additionalProperties: { type: 'string' } },
        update_mode: { type: 'string', enum: ['UPDATE_SOLE_MATCHES', 'UPDATE_FIRST', 'UPDATE_ALL'], description: 'How to handle multiple matches (default UPDATE_SOLE_MATCHES)' },
      },
      required: ['key', 'fields'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.updateContact(a.key, a.fields, a.update_mode || 'UPDATE_SOLE_MATCHES'),
  },
  {
    name: 'delete_record_from_list',
    description: 'Remove records matching the given field values from a Five9 dialing list, e.g. {"number1": "5551234567"}. Only removes them from the list — CRM contacts are untouched.',
    inputSchema: {
      type: 'object',
      properties: {
        list_name: { type: 'string', description: 'Exact dialing list name' },
        fields: { type: 'object', description: 'Field name → value to match', additionalProperties: { type: 'string' } },
      },
      required: ['list_name', 'fields'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.deleteRecordFromList(a.list_name, a.fields),
  },
  {
    name: 'get_import_result',
    description: 'Check the outcome of an asynchronous Five9 import started by add_record_to_list (type "list") or a CRM update (type "crm"). Pass the importIdentifier returned by that call. Returns {ready: false} while Five9 is still processing — poll again shortly; when done, returns {ready: true} plus the import result (records inserted/updated, errors).',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: 'Import identifier (UUID) returned by the import call' },
        type: { type: 'string', enum: ['list', 'crm'], description: 'Which import pipeline to query (default list)' },
      },
      required: ['identifier'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.getImportResult(a.identifier, a.type || 'list'),
  },
  {
    name: 'create_list',
    description: 'Create a new (empty) Five9 dialing list.',
    inputSchema: {
      type: 'object',
      properties: { list_name: { type: 'string', description: 'Name for the new list' } },
      required: ['list_name'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.createList(a.list_name),
  },
  {
    name: 'delete_list',
    description: 'Permanently delete a Five9 dialing list (its records leave the list; CRM contacts are untouched). Confirm with the user before calling.',
    inputSchema: {
      type: 'object',
      properties: { list_name: { type: 'string', description: 'Exact name of the list to delete' } },
      required: ['list_name'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.deleteList(a.list_name),
  },
  {
    name: 'inspect_campaign',
    description: 'Get a campaign\'s current state plus its attached dialing lists (outbound) and DNIS numbers (inbound) in one call.',
    inputSchema: {
      type: 'object',
      properties: { campaign_name: { type: 'string', description: 'Exact campaign name' } },
      required: ['campaign_name'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.inspectCampaign(a.campaign_name),
  },
  {
    name: 'manage_campaign_lists',
    description: 'Attach a dialing list to an outbound campaign (action "add", with optional priority) or detach it (action "remove"). Changes what the campaign will dial — confirm with the user first.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'remove'] },
        campaign_name: { type: 'string', description: 'Exact outbound campaign name' },
        list_name: { type: 'string', description: 'Exact dialing list name' },
        priority: { type: 'number', description: 'Dialing priority when adding (default 1; lower = dialed first)' },
      },
      required: ['action', 'campaign_name', 'list_name'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.manageCampaignLists(a.action, a.campaign_name, a.list_name, a.priority),
  },
  {
    name: 'manage_dnc',
    description: 'Work with the domain Do-Not-Call list: action "check" returns which of the given numbers are on the DNC, "add" adds numbers (compliance-safe), "remove" takes them off. Removing from DNC has compliance implications — confirm with the user first.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['check', 'add', 'remove'] },
        numbers: { type: 'array', items: { type: 'string' }, description: 'Phone numbers (digits only, e.g. "5551234567")' },
      },
      required: ['action', 'numbers'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.dnc(a.action, a.numbers),
  },
  {
    name: 'list_agent_groups',
    description: 'List Five9 agent groups and their member usernames. Optional regex pattern filters by group name.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Java-style regex on group name (default ".*" = all)' } },
      additionalProperties: false,
    },
    handler: (f9, a) => f9.getAgentGroups(a.pattern || '.*'),
  },
  {
    name: 'list_ivr_scripts',
    description: 'List IVR scripts on the domain (metadata only — script XML bodies are omitted). Optional regex pattern filters by script name.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Java-style regex on script name (default ".*" = all)' } },
      additionalProperties: false,
    },
    handler: (f9, a) => f9.getIVRScripts(a.pattern || '.*'),
  },
  {
    name: 'list_dnis',
    description: 'List the DNIS (inbound phone numbers) provisioned on this Five9 domain. Set unassigned_only to true to see only numbers not attached to any campaign.',
    inputSchema: {
      type: 'object',
      properties: { unassigned_only: { type: 'boolean', description: 'Only return DNIS not assigned to a campaign' } },
      additionalProperties: false,
    },
    handler: (f9, a) => f9.getDNISList(a.unassigned_only),
  },
  {
    name: 'get_realtime_stats',
    description: 'Get real-time contact center statistics from the Five9 Statistics API. statistic_type picks the view: AgentState (who is on a call / ready / not ready right now), ACDStatus (queue depth and wait times per skill), CampaignState, InboundCampaignStatistics, OutboundCampaignStatistics, OutboundCampaignManager (list/dialer manager view), AutodialCampaignStatistics, AgentStatistics (per-agent daily performance).',
    inputSchema: {
      type: 'object',
      properties: {
        statistic_type: {
          type: 'string',
          enum: ['AgentState', 'ACDStatus', 'CampaignState', 'InboundCampaignStatistics', 'OutboundCampaignStatistics', 'OutboundCampaignManager', 'AutodialCampaignStatistics', 'AgentStatistics'],
        },
      },
      required: ['statistic_type'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.getRealtimeStats(a.statistic_type),
  },
  {
    name: 'add_records_to_list',
    description: 'Bulk-add many records (leads) to a Five9 dialing list in one async import. records is an array of contact field→value objects (e.g. [{"number1":"5551230001","first_name":"A"},{"number1":"5551230002"}]); columns are the union of all records\' fields. number1 is the standard primary phone field and default key. Returns an importIdentifier to poll with get_import_result. Inserts real leads that may be dialed — confirm with the user first.',
    inputSchema: {
      type: 'object',
      properties: {
        list_name: { type: 'string', description: 'Exact dialing list name' },
        records: {
          type: 'array',
          description: 'Array of contact field→value objects (one per lead).',
          items: { type: 'object', additionalProperties: { type: 'string' } },
          minItems: 1,
        },
        key_field: { type: 'string', description: 'Field used to match existing contacts (default: number1)' },
        crm_add_mode: { type: 'string', enum: ['ADD_NEW', 'DONT_ADD'], description: 'How to handle new CRM contacts (default ADD_NEW)' },
        crm_update_mode: { type: 'string', enum: ['UPDATE_FIRST', 'UPDATE_ALL', 'UPDATE_SOLE_MATCHES'], description: 'How to update matching CRM contacts (default UPDATE_FIRST)' },
        list_add_mode: { type: 'string', enum: ['ADD_FIRST', 'ADD_ALL', 'ADD_IF_SOLE_CRM_MATCH'], description: 'How records join the list (default ADD_FIRST)' },
        clean_list_before_update: { type: 'boolean', description: 'Empty the list before importing (default false)' },
      },
      required: ['list_name', 'records'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.addRecordsToList(a.list_name, a.records, {
      keyField: a.key_field, crmAddMode: a.crm_add_mode, crmUpdateMode: a.crm_update_mode,
      listAddMode: a.list_add_mode, cleanListBeforeUpdate: a.clean_list_before_update,
    }),
  },
  {
    name: 'bulk_update_contacts',
    description: 'Update many Five9 CRM contacts in one async import. records is an array of field→value objects; key_fields names the field(s) that identify which contact each row updates (e.g. ["number1"]). Every non-key field is written. Does not create contacts by default (crm_add_mode DONT_ADD). Returns an importIdentifier — poll get_import_result with type "crm".',
    inputSchema: {
      type: 'object',
      properties: {
        records: {
          type: 'array',
          description: 'Array of field→value objects; each must include the key field(s).',
          items: { type: 'object', additionalProperties: { type: 'string' } },
          minItems: 1,
        },
        key_fields: {
          type: 'array',
          description: 'Field name(s) that identify the contact to update (e.g. ["number1"]).',
          items: { type: 'string' },
          minItems: 1,
        },
        crm_add_mode: { type: 'string', enum: ['DONT_ADD', 'ADD_NEW'], description: 'Whether to insert rows with no match (default DONT_ADD)' },
        crm_update_mode: { type: 'string', enum: ['UPDATE_FIRST', 'UPDATE_ALL', 'UPDATE_SOLE_MATCHES'], description: 'How to update matching contacts (default UPDATE_FIRST)' },
      },
      required: ['records', 'key_fields'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.updateContactsBulk(a.records, a.key_fields, {
      crmAddMode: a.crm_add_mode, crmUpdateMode: a.crm_update_mode,
    }),
  },
  {
    name: 'set_user_roles',
    description: 'Grant and/or revoke Five9 roles on a user. add enables roles (agent, admin, supervisor, reporting, crmManager); remove revokes them. The supervisor role requires at least one viewable tab — by default it grants Agents/Campaigns/CallMonitoring, or pass permissions.supervisor with an explicit list of tabs (Users, Agents, CallMonitoring, Stations, Campaigns, CampaignManagement, AllSkills, BargeInMonitor, WhisperMonitor, ReviewVoiceRecordings, …). Use get_user_details to see current roles.',
    inputSchema: {
      type: 'object',
      properties: {
        user_name: { type: 'string', description: 'Exact Five9 username' },
        add: { type: 'array', items: { type: 'string', enum: ['agent', 'admin', 'supervisor', 'reporting', 'crmManager'] }, description: 'Roles to enable' },
        remove: { type: 'array', items: { type: 'string', enum: ['agent', 'admin', 'supervisor', 'reporting', 'crmManager'] }, description: 'Roles to revoke' },
        permissions: { type: 'object', description: 'Optional per-role permission tabs, e.g. {"supervisor": ["Agents","Campaigns"]}', additionalProperties: true },
      },
      required: ['user_name'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.setUserRoles(a.user_name, { add: a.add, remove: a.remove, permissions: a.permissions }),
  },
  {
    name: 'manage_web_connector',
    description: 'Create or delete a web connector (URL pop / webhook agents trigger). Create: name + url, optional description, trigger (OnCallAccepted, OnCallDisconnected, ManuallyStarted [default], ManuallyStartedAllowDuringPreviews, OnPreview), agent_application (EmbeddedBrowser [default] or ExternalBrowser), post_method, execute_in_browser.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'delete'] },
        name: { type: 'string', description: 'Connector name' },
        url: { type: 'string', description: 'Target URL (create)' },
        description: { type: 'string' },
        trigger: { type: 'string', enum: ['OnCallAccepted', 'OnCallDisconnected', 'ManuallyStarted', 'ManuallyStartedAllowDuringPreviews', 'OnPreview'] },
        agent_application: { type: 'string', enum: ['EmbeddedBrowser', 'ExternalBrowser'] },
        post_method: { type: 'boolean' },
        execute_in_browser: { type: 'boolean' },
      },
      required: ['action', 'name'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.manageWebConnector(a.action, { name: a.name, url: a.url, description: a.description, trigger: a.trigger, agentApplication: a.agent_application, postMethod: a.post_method, executeInBrowser: a.execute_in_browser }),
  },
  {
    name: 'manage_campaign_profile_filter',
    description: 'Read or edit a campaign profile\'s CRM record-selection filter and dialing order. action "get" returns the current filter. "set_criteria" adds/removes filter conditions and sets grouping: add_criteria is an array of {compareOperator, leftValue, rightValue} (operators: Contains, Equals, NotEqual, Greater, Less, IsNull, StartsWith, …); grouping is {expression, type} where type is All, Any, or Custom (Custom uses a numbered boolean expression like "1 AND (2 OR 3)"). "set_order" manages order-by fields: add_order_by is an array of {fieldName, descending, rank}; remove_order_by is a list of field names.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set_criteria', 'set_order'] },
        profile_name: { type: 'string', description: 'Exact campaign profile name' },
        grouping: { type: 'object', description: '{expression, type} (set_criteria)', additionalProperties: true },
        add_criteria: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '{compareOperator, leftValue, rightValue} conditions to add' },
        remove_criteria: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Conditions to remove' },
        add_order_by: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '{fieldName, descending, rank} order-by fields to add' },
        remove_order_by: { type: 'array', items: { type: 'string' }, description: 'Order-by field names to remove' },
      },
      required: ['action', 'profile_name'],
      additionalProperties: false,
    },
    handler: (f9, a) => {
      if (a.action === 'get') return f9.getCampaignProfileFilter(a.profile_name);
      if (a.action === 'set_criteria') return f9.modifyCampaignProfileCrmCriteria(a.profile_name, { grouping: a.grouping, addCriteria: a.add_criteria, removeCriteria: a.remove_criteria });
      return f9.modifyCampaignProfileFilterOrder(a.profile_name, { addOrderByField: a.add_order_by, removeOrderByField: a.remove_order_by });
    },
  },
  {
    name: 'manage_ivr_script',
    description: 'Create, modify, or delete an IVR script. Create makes an empty script by name (optionally pushing an xml_definition); modify replaces the script body with xml_definition (the full IVR XML, as returned by get_ivr_script); delete removes it. Editing IVR XML is advanced — fetch the current definition with get_ivr_script first.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'modify', 'delete'] },
        name: { type: 'string', description: 'IVR script name' },
        xml_definition: { type: 'string', description: 'Full IVR script XML (create optional, modify required)' },
        description: { type: 'string' },
      },
      required: ['action', 'name'],
      additionalProperties: false,
    },
    handler: (f9, a) => {
      if (a.action === 'create') return f9.createIVRScript(a.name, a.xml_definition, a.description);
      if (a.action === 'modify') return f9.modifyIVRScript(a.name, a.xml_definition, a.description);
      return f9.deleteIVRScript(a.name);
    },
  },
  {
    name: 'manage_wav_prompt',
    description: 'Create, modify, or delete a pre-recorded WAV voice prompt. Create/modify need name + wav_base64 (the base64-encoded WAV file; Five9 requires G.711 u-law, 8kHz, mono), optional language (default en-US) and description. Use manage_tts_prompt instead for text-to-speech prompts.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'modify', 'delete'] },
        name: { type: 'string', description: 'Prompt name' },
        wav_base64: { type: 'string', description: 'Base64-encoded WAV (G.711 u-law, 8kHz, mono)' },
        language: { type: 'string', description: 'e.g. en-US' },
        description: { type: 'string' },
      },
      required: ['action', 'name'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.managePromptWav(a.action, { name: a.name, wavBase64: a.wav_base64, description: a.description, language: a.language }),
  },

  // ---- New Platform REST APIs (OAuth 2.0) — see five9rest.js ----
  {
    name: 'rest_check_connection',
    description: 'Verify the Worker can obtain an OAuth 2.0 bearer token from the Five9 New Platform APIs. Confirms API Access Control is enabled and the Consumer Key/Secret are valid, and lists which named credentials are configured. Optional credential selects which one to test (default "default"; e.g. "data-tables"). Separate from check_connection, which tests the SOAP username/password.',
    inputSchema: {
      type: 'object',
      properties: { credential: { type: 'string', description: 'Named credential to test (default "default"; e.g. "data-tables")' } },
      additionalProperties: false,
    },
    rest: true,
    handler: (r, a) => r.checkConnection(a.credential || 'default'),
  },
  {
    name: 'rest_call',
    description: 'Make an authenticated call to any Five9 New Platform REST API endpoint (OAuth bearer token handled automatically, with rate-limit/backoff and ETag/If-Match concurrency support). Use this to explore endpoints before typed tools exist. path must start with "/", e.g. "/interactions/v1/domains/{domainId}/dispositions" ({domainId} is substituted from config); segments use letters, digits, and . _ ~ : - only (no percent-encoding, no "." or ".."), and query parameters go in query. credential must be a configured credential name (default "default"; e.g. "data-tables"). base_url may only name an official regional Five9 API host (e.g. https://api.prod.eu.five9.net); the token is never sent anywhere else. Non-GET calls touching campaigns, calls, dialing, sessions, or live interactions are refused (use control_campaign). Secret-looking fields in responses are redacted. For writes, pass if_match with the ETag from a prior read.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method (default GET)' },
        path: { type: 'string', description: 'Endpoint path relative to the base URL, e.g. "/interactions/v1/domains/{domainId}/dispositions". {domainId} is substituted automatically.' },
        query: { type: 'object', description: 'Query-string parameters', additionalProperties: { type: 'string' } },
        body: { type: 'object', description: 'JSON request body (for POST/PUT/PATCH)', additionalProperties: true },
        if_match: { type: 'string', description: 'ETag value for optimistic-concurrency writes (sent as If-Match)' },
        credential: { type: 'string', description: 'Named credential / API family to use (default "default"; e.g. "data-tables")' },
        base_url: { type: 'string', description: 'Official regional Five9 API origin to use instead of the configured one, e.g. "https://api.prod.eu.five9.net". Any other host is refused.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    rest: true,
    handler: async (r, a) => {
      const method = String(a.method || 'GET').toUpperCase();
      const credential = a.credential || 'default';
      const refusal = restCallRefusal({ method, path: a.path, query: a.query, body: a.body, credential, credentials: r.credentialNames() });
      if (refusal) throw new Five9RestError(refusal);
      const res = await r.request(method, a.path, { query: a.query, body: a.body, ifMatch: a.if_match, credential, baseUrl: a.base_url });
      return { ...res, data: redactSecrets(res.data) };
    },
  },
  {
    name: 'manage_circle',
    description: 'Manage Five9 Circles via the OAuth New Platform API — there is NO SOAP equivalent, so this is the way to work with circles. action: "list" (paginated), "get" (by circle_id), "create" (name + optional fields), "delete" (by circle_id). Requires an OAuth API Access Control credential (Consumer Key/Secret) — run rest_check_connection first. This is NOT the SOAP username/password used by the other tools.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'create', 'delete'] },
        circle_id: { type: 'string', description: 'Circle id (for get/delete)' },
        name: { type: 'string', description: 'Circle name (for create)' },
        fields: { type: 'object', description: 'Additional circle fields for create (e.g. useTags)', additionalProperties: true },
        cursor: { type: 'string', description: 'Pagination cursor from a prior list (nextCursor)' },
        limit: { type: 'number', description: 'Page size (default 100)' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    rest: true,
    handler: (r, a) => {
      if (a.action === 'list') return r.listCircles({ cursor: a.cursor, limit: a.limit });
      if (a.action === 'get') return r.getCircle(a.circle_id);
      if (a.action === 'create') return r.createCircle({ name: a.name, ...(a.fields || {}) });
      return r.deleteCircle(a.circle_id);
    },
  },
  {
    name: 'list_np_prompts',
    description: 'List voice prompts via the OAuth New Platform prompts API (paginated; returns richer objects than the SOAP list_prompts). Requires an OAuth API Access Control credential — see rest_check_connection. Pass cursor (from a prior nextCursor) to page.',
    inputSchema: {
      type: 'object',
      properties: {
        cursor: { type: 'string', description: 'Pagination cursor (nextCursor from a prior call)' },
        limit: { type: 'number', description: 'Page size (default 100)' },
      },
      additionalProperties: false,
    },
    rest: true,
    handler: (r, a) => r.listNpPrompts({ cursor: a.cursor, limit: a.limit }),
  },
  {
    name: 'list_interaction_dispositions',
    description: 'List call dispositions via the OAuth New Platform interactions API (paginated; richer fields than the SOAP list_dispositions). Pass disposition_id to fetch a single disposition (with its notification settings). Read-only. Requires an OAuth API Access Control credential — see rest_check_connection.',
    inputSchema: {
      type: 'object',
      properties: {
        disposition_id: { type: 'string', description: 'Fetch one disposition by id instead of listing' },
        cursor: { type: 'string', description: 'Pagination cursor (nextCursor from a prior call)' },
        limit: { type: 'number', description: 'Page size (default 100)' },
      },
      additionalProperties: false,
    },
    rest: true,
    handler: (r, a) => (a.disposition_id ? r.getDisposition(a.disposition_id) : r.listDispositions({ cursor: a.cursor, limit: a.limit })),
  },
  {
    name: 'get_domain_info',
    description: 'Get New Platform domain metadata (domainId, name, tenant, and the domain\'s service endpoints) via the OAuth API. Requires an OAuth API Access Control credential — see rest_check_connection.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    rest: true,
    handler: (r) => r.getDomainInfo(),
  },
  {
    name: 'list_data_tables',
    description: 'List Five9 Data Tables (structured lookup tables used in routing/IVR logic) via the OAuth New Platform API — no SOAP equivalent. Returns each table\'s id, name, description, and row count. Uses a SEPARATE "data-tables" credential (FIVE9_DT_CONSUMER_KEY/SECRET) in the "Data Tables access" API family — verify with rest_check_connection credential "data-tables". Paginated.',
    inputSchema: {
      type: 'object',
      properties: {
        cursor: { type: 'string', description: 'Pagination cursor (nextCursor from a prior call)' },
        limit: { type: 'number', description: 'Page size (default 100)' },
      },
      additionalProperties: false,
    },
    rest: true,
    handler: (r, a) => r.listDataTables({ cursor: a.cursor, limit: a.limit }),
  },
  {
    name: 'get_data_table_rows',
    description: 'Get the rows of a Five9 Data Table by table_id (paginated) via the OAuth New Platform API. Get table_id from list_data_tables. Read-only. Uses the "data-tables" credential.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'Data table id (dataTableId from list_data_tables)' },
        cursor: { type: 'string', description: 'Pagination cursor (nextCursor from a prior call)' },
        limit: { type: 'number', description: 'Page size (default 100)' },
      },
      required: ['table_id'],
      additionalProperties: false,
    },
    rest: true,
    handler: (r, a) => r.getDataTableRows(a.table_id, { cursor: a.cursor, limit: a.limit }),
  },

  // ---- IVR builder: compose whole call flows from a JSON spec ----
  //
  // The flow spec (documented in ivr.js and in the validate/build tool
  // descriptions) is deliberately constrained: the model designs the flow,
  // deterministic code guarantees the XML. Recommended workflow:
  //   1. validate_ivr_flow -> fix anything it flags
  //   2. render_ivr_flow -> SHOW the user the mermaid diagram, get approval
  //   3. generate_prompt_audio for each AI-voiced prompt (optional)
  //   4. build_ivr_script (dry_run first if you want to inspect the XML)
  {
    name: 'validate_ivr_flow',
    description: 'Validate an IVR flow spec BEFORE building: graph checks (entry, wiring, digits, reachability) plus, by default, domain checks that every referenced skill and prompt exists. Flow spec: { entry, nodes: { key: node } } where node types are ' + IVR_NODE_TYPES.join(', ') + '. play: {prompt, next}. menu: {prompt, options: [{digit, label, next}], max_attempts?}. hours: {days: ["MON".."FRI"], open: "08:00", close: "17:00", during_hours, after_hours}. skill_transfer: {skills: [...], next (queue-timeout fallback), max_queue_seconds?}. voicemail: {skill}. hangup: {}. Prompts are {tts: "text"} (robot voice) or {prompt_name: "X"} (domain prompt, e.g. AI voice from generate_prompt_audio).',
    inputSchema: {
      type: 'object',
      properties: {
        flow: { type: 'object', description: 'The IVR flow spec' },
        check_domain: { type: 'boolean', description: 'Also verify referenced skills/prompts exist on the domain (default true)' },
      },
      required: ['flow'],
      additionalProperties: false,
    },
    handler: async (f9, a) => {
      const result = validateFlow(a.flow);
      const refs = collectFlowRefs(a.flow);
      const out = { ...result, references: refs };
      if (Object.values(a.flow?.nodes || {}).some((n) => n?.type === 'hours')) {
        out.timezone_note = 'hours nodes compare __DAY__/__TIME__ in the DOMAIN default time zone, which the SOAP API does not expose. State your assumption to the user in one line instead of spending calls trying to derive it (see the about tool for this domain\'s time zone).';
      }
      if (a.check_domain !== false && (refs.skills.length || refs.prompts.length)) {
        const skills = new Set((await f9.getSkills('.*')).map((s) => String(s.name).toLowerCase()));
        const prompts = new Set((await f9.getPrompts()).map((p) => String(p.name).toLowerCase()));
        out.missing_skills = refs.skills.filter((s) => !skills.has(s.toLowerCase()));
        out.missing_prompts = refs.prompts.filter((p) => !prompts.has(p.toLowerCase()));
        if (out.missing_skills.length || out.missing_prompts.length) {
          out.ok = false;
          out.note = 'Create missing skills with manage_skill and missing prompts with generate_prompt_audio (or switch those prompts to {tts}).';
        }
      }
      return out;
    },
  },
  {
    name: 'render_ivr_flow',
    description: 'Render an IVR call flow as a Mermaid flowchart. Pass either flow (a flow spec, to preview BEFORE building) or script_name (an existing IVR script on the domain). ALWAYS show the returned mermaid to the user in a ```mermaid code fence so they can see the flow before you deploy it.',
    inputSchema: {
      type: 'object',
      properties: {
        flow: { type: 'object', description: 'Flow spec to render (see validate_ivr_flow)' },
        script_name: { type: 'string', description: 'Existing IVR script name to render instead' },
      },
      additionalProperties: false,
    },
    handler: async (f9, a) => {
      if (a.script_name) {
        const script = await f9.getIVRScript(a.script_name);
        return { script: a.script_name, mermaid: scriptXmlToMermaid(script.xmlDefinition) };
      }
      if (!a.flow) throw new Error('Pass flow or script_name.');
      const check = validateFlow(a.flow);
      if (!check.ok) return { ok: false, errors: check.errors, note: 'Fix the flow before rendering.' };
      return { mermaid: flowToMermaid(a.flow), warnings: check.warnings };
    },
  },
  {
    name: 'build_ivr_script',
    description: 'Build a COMPLETE Five9 IVR script from a flow spec (see validate_ivr_flow for the format) and create it on the domain. Validates the graph, resolves skill/prompt names to domain ids, and emits designer-shaped XML. Set dry_run true to get the XML back without touching the domain; set overwrite true to replace an existing script of the same name. After building, attach the script to an inbound campaign (create_campaign / modify_campaign).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'IVR script name' },
        flow: { type: 'object', description: 'The IVR flow spec' },
        description: { type: 'string', description: 'Script description shown in the Five9 admin' },
        overwrite: { type: 'boolean', description: 'Replace the script if it already exists (default false)' },
        dry_run: { type: 'boolean', description: 'Return the composed XML without creating anything (default false)' },
      },
      required: ['name', 'flow'],
      additionalProperties: false,
    },
    handler: async (f9, a) => {
      const refs = collectFlowRefs(a.flow);
      const resolved = { skills: new Map(), prompts: new Map() };
      if (refs.skills.length) {
        for (const s of await f9.getSkills('.*')) resolved.skills.set(String(s.name).toLowerCase(), { id: s.id, name: s.name });
      }
      if (refs.prompts.length) {
        // The SOAP prompt list carries no ids; Five9 accepts file-prompt refs
        // with id 0 + the prompt NAME and normalizes ids server-side
        // (verified by round-trip against a live domain).
        for (const p of await f9.getPrompts()) {
          resolved.prompts.set(String(p.name).toLowerCase(), { id: p.id ?? 0, name: p.name });
        }
      }
      const { xml, warnings, moduleCount } = await composeIvrXml(a.flow, resolved);
      const mermaid = flowToMermaid(a.flow);
      if (a.dry_run) return { dry_run: true, moduleCount, warnings, mermaid, xml };
      const existing = (await f9.getIVRScripts(a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).find((s) => s.name === a.name);
      if (existing && !a.overwrite) {
        throw new Error(`IVR script "${a.name}" already exists. Pass overwrite: true to replace it.`);
      }
      const result = existing
        ? await f9.modifyIVRScript(a.name, xml, a.description)
        : await f9.createIVRScript(a.name, xml, a.description);
      return { ...result, moduleCount, warnings, mermaid, note: 'Show the mermaid diagram to the user. Go-live chain: create_campaign (type inbound, ivr_script set) -> manage_campaign_dnis add (pick from list_dnis select_unassigned) -> control_campaign start.' };
    },
  },
  {
    name: 'generate_prompt_audio',
    description: 'Generate a voice prompt with a MODERN AI voice and upload it to Five9 as a WAV prompt (auto-converted to the required G.711 u-law 8kHz mono). Default provider is Cloudflare Workers AI (Deepgram Aura-2) built into this Worker: no external TTS account or API key needed, ~40 voices (default "luna"; try asteria, orion, athena, zeus). ElevenLabs/OpenAI are optional alternatives when their API-key secrets are set. Use instead of manage_tts_prompt when the prompt should sound human. The uploaded prompt can then be referenced from flows as {prompt_name}.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Prompt name to create/update on Five9' },
        text: { type: 'string', description: 'What the prompt says' },
        provider: { type: 'string', enum: ['workers-ai', 'elevenlabs', 'openai'], description: 'TTS provider (default workers-ai, which needs no key)' },
        voice: { type: 'string', description: 'Voice: Aura-2 speaker for workers-ai (default "luna"), or the provider-specific voice id for elevenlabs/openai' },
        model: { type: 'string', description: 'TTS model override' },
        description: { type: 'string', description: 'Prompt description in Five9' },
        language: { type: 'string', description: 'Prompt language tag (default en-US)' },
        overwrite: { type: 'boolean', description: 'Update the prompt if it already exists (default false)' },
      },
      required: ['name', 'text'],
      additionalProperties: false,
    },
    handler: async (f9, a, cfg) => {
      const provider = a.provider || (cfg?.ai ? 'workers-ai' : (cfg?.ttsKeys?.elevenlabs ? 'elevenlabs' : (cfg?.ttsKeys?.openai ? 'openai' : 'workers-ai')));
      const apiKey = cfg?.ttsKeys?.[provider] || '';
      const audio = await synthesizeUlawWav({ provider, apiKey, ai: cfg?.ai, text: a.text, voice: a.voice, model: a.model });
      const existing = (await f9.getPrompts()).some((p) => p.name === a.name);
      if (existing && !a.overwrite) {
        throw new Error(`Prompt "${a.name}" already exists. Pass overwrite: true to replace it.`);
      }
      const result = await f9.managePromptWav(existing ? 'modify' : 'create', {
        name: a.name, wavBase64: audio.wavBase64, description: a.description, language: a.language,
      });
      return { ...result, provider, approxSeconds: audio.approxSeconds, bytes: audio.bytes };
    },
  },
];

// ---- Web-UI display metadata (consumed by ui.js) ----
//
// Grouping + write-flag metadata lives here, next to the tools, so adding a
// tool and giving it a UI home happen in one file. The console and landing
// page derive their layout from this; any tool missing from TOOL_GROUPS falls
// into an "Other" bucket, and a CI check (npm test) fails if that happens.

export const TOOL_GROUPS = [
  { name: 'Connection & context', icon: '🔌', tools: ['about', 'check_connection', 'get_api_usage', 'rest_check_connection'] },
  { name: 'Campaigns', icon: '📞', tools: ['list_campaigns', 'inspect_campaign', 'get_campaign_details', 'create_campaign', 'modify_campaign', 'rename_campaign', 'delete_campaign', 'control_campaign', 'manage_campaign_lists', 'manage_campaign_skills', 'manage_campaign_dnis', 'manage_campaign_dispositions', 'list_campaign_profiles', 'manage_campaign_profile', 'manage_campaign_profile_filter'] },
  { name: 'Dialing lists & leads', icon: '📋', tools: ['list_dialing_lists', 'create_list', 'delete_list', 'add_record_to_list', 'add_records_to_list', 'delete_record_from_list', 'get_import_result'] },
  { name: 'CRM contacts', icon: '👤', tools: ['search_contacts', 'update_contact', 'bulk_update_contacts', 'delete_contact', 'list_contact_fields', 'manage_contact_field'] },
  { name: 'Compliance', icon: '🚫', tools: ['manage_dnc', 'get_dialing_rules'] },
  { name: 'Users & skills', icon: '🧑‍💼', tools: ['list_users', 'get_user_details', 'create_user', 'modify_user', 'delete_user', 'set_user_roles', 'list_user_profiles', 'list_skills', 'get_skill_details', 'manage_skill', 'manage_user_skills', 'list_agent_groups', 'manage_agent_group', 'manage_reason_code'] },
  { name: 'Domain configuration', icon: '🏢', tools: ['list_dispositions', 'manage_disposition', 'list_ivr_scripts', 'get_ivr_script', 'manage_ivr_script', 'list_prompts', 'manage_tts_prompt', 'manage_wav_prompt', 'list_dnis', 'list_call_variables', 'manage_call_variable', 'list_web_connectors', 'manage_web_connector', 'manage_speed_dial', 'get_vcc_configuration'] },
  { name: 'Reporting & real-time', icon: '📈', tools: ['run_report', 'get_report_result', 'get_realtime_stats'] },
  { name: 'New Platform (REST)', icon: '🆕', tools: ['rest_call', 'manage_circle', 'list_np_prompts', 'list_interaction_dispositions', 'get_domain_info', 'list_data_tables', 'get_data_table_rows'] },
  { name: 'IVR builder', icon: '🧩', tools: ['validate_ivr_flow', 'render_ivr_flow', 'build_ivr_script', 'generate_prompt_audio'] },
];

export const WRITE_TOOLS = new Set([
  'control_campaign', 'manage_campaign_lists', 'create_list', 'delete_list',
  'add_record_to_list', 'add_records_to_list', 'delete_record_from_list', 'update_contact',
  'bulk_update_contacts', 'manage_dnc', 'create_campaign', 'modify_campaign',
  'rename_campaign', 'delete_campaign', 'manage_campaign_skills', 'manage_campaign_dnis',
  'manage_campaign_dispositions', 'manage_campaign_profile', 'manage_campaign_profile_filter',
  'manage_skill', 'manage_user_skills', 'set_user_roles', 'create_user', 'modify_user',
  'delete_user', 'manage_disposition', 'manage_contact_field', 'delete_contact',
  'manage_tts_prompt', 'manage_wav_prompt', 'manage_ivr_script', 'manage_agent_group',
  'manage_call_variable', 'manage_web_connector', 'manage_speed_dial', 'manage_reason_code',
  'manage_circle', 'rest_call', 'build_ivr_script', 'generate_prompt_audio',
]);

export function toolDefs(cfg) {
  return TOOLS
    .filter((t) => !(cfg?.readOnly && WRITE_TOOLS.has(t.name)))
    .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export async function callTool(cfg, name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (cfg?.readOnly && WRITE_TOOLS.has(name)) {
    throw new Five9Error(`${name} is disabled: this server is in read-only mode (FIVE9_READ_ONLY).`);
  }
  if (tool.rest) return tool.handler(new Five9RestClient(cfg), args || {}, cfg);
  const f9 = tool.five9 === false ? null : new Five9Client(cfg);
  return tool.handler(f9, args || {}, cfg);
}
