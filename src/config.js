// Configuration resolution. Two sources, env wins:
//   1. Wrangler secrets / vars (FIVE9_USERNAME, FIVE9_PASSWORD, MCP_AUTH_TOKEN)
//   2. The KV-stored config written by the in-browser setup wizard (/setup)

const KV_KEY = 'five9-config';

export async function loadConfig(env) {
  let stored = null;
  if (env.CONFIG) {
    try { stored = await env.CONFIG.get(KV_KEY, 'json'); } catch { /* KV unavailable */ }
  }
  const envManaged = Boolean(env.FIVE9_USERNAME || env.FIVE9_PASSWORD);
  const cfg = {
    username: env.FIVE9_USERNAME || stored?.username || '',
    password: env.FIVE9_PASSWORD || stored?.password || '',
    host: env.FIVE9_API_HOST_OVERRIDE || stored?.host || env.FIVE9_API_HOST || 'api.five9.com',
    adminVersion: env.FIVE9_ADMIN_VERSION || 'v13',
    supervisorVersion: env.FIVE9_SUPERVISOR_VERSION || 'v13',
    authToken: env.MCP_AUTH_TOKEN || stored?.authToken || '',
    // New Platform REST APIs (OAuth 2.0 client-credentials) — separate creds
    // from the SOAP username/password. See five9rest.js.
    restConsumerKey: env.FIVE9_CONSUMER_KEY || stored?.restConsumerKey || '',
    restConsumerSecret: env.FIVE9_CONSUMER_SECRET || stored?.restConsumerSecret || '',
    restDomainId: env.FIVE9_DOMAIN_ID || stored?.restDomainId || '',
    restRegion: env.FIVE9_REST_REGION || stored?.restRegion || 'US',
    restBaseUrl: env.FIVE9_REST_BASE_URL || stored?.restBaseUrl || '',
    // FIVE9_READ_ONLY=true hides and refuses every write tool, and the SOAP
    // client refuses any non-read operation. For audits on production domains.
    readOnly: /^(1|true|yes)$/i.test(String(env.FIVE9_READ_ONLY || '').trim()),
    source: envManaged ? 'env' : (stored ? 'kv' : 'none'),
    hasKv: Boolean(env.CONFIG),
    // TTS for generate_prompt_audio. Default is the Workers AI binding (no
    // account, no key); ElevenLabs/OpenAI keys are optional extras (env-only).
    ai: env.AI || null,
    ttsKeys: {
      elevenlabs: env.ELEVENLABS_API_KEY || '',
      openai: env.OPENAI_API_KEY || '',
    },
  };
  cfg.configured = Boolean(cfg.username && cfg.password);
  cfg.restConfigured = Boolean(cfg.restConsumerKey && cfg.restConsumerSecret);
  // Named New Platform credentials (different API families). 'default' is the
  // all-apis-access credential; extras like 'data-tables' use their own key.
  cfg.restCredentials = {};
  if (cfg.restConsumerKey && cfg.restConsumerSecret) {
    cfg.restCredentials.default = { key: cfg.restConsumerKey, secret: cfg.restConsumerSecret };
  }
  const dtKey = env.FIVE9_DT_CONSUMER_KEY || stored?.restDtConsumerKey || '';
  const dtSecret = env.FIVE9_DT_CONSUMER_SECRET || stored?.restDtConsumerSecret || '';
  if (dtKey && dtSecret) cfg.restCredentials['data-tables'] = { key: dtKey, secret: dtSecret };
  return cfg;
}

export async function saveConfig(env, { username, password, host, authToken }) {
  await env.CONFIG.put(KV_KEY, JSON.stringify({ username, password, host, authToken }));
}

export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
