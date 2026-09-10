// Web UI — a landing/setup page (GET /) and an interactive tool console
// (GET /console). Pure server-rendered HTML with inline CSS/JS, no assets.
//
// Grouping + write-flag metadata lives in tools.js (next to the tools) and is
// imported here — adding a tool and giving it a UI home happen in one file.
import { TOOL_GROUPS as GROUPS, WRITE_TOOLS } from './tools.js';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shortDesc(d) {
  return d.replace(/e\.g\./g, '§').split('. ')[0].replace(/§/g, 'e.g.').replace(/\.$/, '');
}

function grouped(tools) {
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const seen = new Set();
  const out = GROUPS.map((g) => ({
    ...g,
    items: g.tools.filter((n) => byName[n]).map((n) => { seen.add(n); return byName[n]; }),
  })).filter((g) => g.items.length);
  const rest = tools.filter((t) => !seen.has(t.name));
  if (rest.length) out.push({ name: 'Other', icon: '🧩', items: rest });
  return out;
}

const BASE_CSS = `
  :root{--bg:#f7f8fb;--card:#ffffff;--ink:#151b26;--muted:#5b6779;--line:#e4e8ef;--accent:#4f46e5;--accent2:#0ea5e9;--ok:#16a34a;--warn:#d97706;--err:#dc2626;--code:#eef1f6;--shadow:0 1px 2px rgba(16,24,40,.05),0 4px 16px rgba(16,24,40,.06)}
  @media (prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#161c26;--ink:#e6ebf2;--muted:#93a1b3;--line:#232b38;--accent:#818cf8;--accent2:#38bdf8;--code:#1e2733;--shadow:0 1px 2px rgba(0,0,0,.4)}}
  *{box-sizing:border-box}
  body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink);line-height:1.6;-webkit-font-smoothing:antialiased}
  a{color:var(--accent);text-decoration:none} a:hover{text-decoration:underline}
  code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.86em}
  code{background:var(--code);padding:.12em .4em;border-radius:5px}
  pre{background:var(--code);padding:.85rem 1rem;border-radius:10px;overflow-x:auto;line-height:1.5}
  pre code{background:none;padding:0}
  .pill{display:inline-flex;align-items:center;gap:.35em;font-size:.78rem;font-weight:600;padding:.18em .65em;border-radius:999px;border:1px solid var(--line);background:var(--card)}
  .dot{width:.5em;height:.5em;border-radius:50%;background:var(--muted)}
  .dot.ok{background:var(--ok)} .dot.err{background:var(--err)}
  .badge{font-size:.7rem;font-weight:700;letter-spacing:.03em;padding:.1em .5em;border-radius:999px}
  .badge.read{color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,transparent)}
  .badge.write{color:var(--warn);background:color-mix(in srgb,var(--warn) 14%,transparent)}
  .btn{display:inline-flex;align-items:center;gap:.4em;padding:.55em 1.1em;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);font-weight:600;font-size:.92rem;cursor:pointer;box-shadow:var(--shadow)}
  .btn:hover{border-color:var(--accent);text-decoration:none}
  .btn.primary{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border:0}
  .btn.primary:hover{filter:brightness(1.08)}
`;

export function landingPage(tools, cfg = { configured: true }) {
  const groups = grouped(tools);
  const toolCards = groups.map((g) => `
    <section class="tgroup">
      <h3>${g.icon} ${esc(g.name)}</h3>
      <div class="tgrid">
        ${g.items.map((t) => `
        <div class="tcard">
          <div class="trow"><code>${esc(t.name)}</code>
          <span class="badge ${WRITE_TOOLS.has(t.name) ? 'write">WRITE' : 'read">READ'}</span></div>
          <p>${esc(shortDesc(t.description))}.</p>
        </div>`).join('')}
      </div>
    </section>`).join('');

  return page('five9-mcp — Five9 for AI, over MCP', `
  <style>
  header{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 85%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
  .nav{max-width:1060px;margin:0 auto;display:flex;align-items:center;gap:1.2rem;padding:.7rem 1.25rem}
  .nav .logo{font-weight:800;letter-spacing:-.02em;color:var(--ink)}
  .nav .logo span{background:linear-gradient(135deg,var(--accent),var(--accent2));-webkit-background-clip:text;background-clip:text;color:transparent}
  .nav a{color:var(--muted);font-size:.92rem;font-weight:500}
  .nav .sp{flex:1}
  main{max-width:1060px;margin:0 auto;padding:0 1.25rem 4rem}
  .hero{padding:4.5rem 0 3rem;text-align:center}
  .hero h1{font-size:clamp(2.1rem,5.5vw,3.4rem);margin:.2em 0;letter-spacing:-.03em;line-height:1.12}
  .hero h1 span{background:linear-gradient(135deg,var(--accent),var(--accent2));-webkit-background-clip:text;background-clip:text;color:transparent}
  .hero p.tag{font-size:1.15rem;color:var(--muted);max-width:620px;margin:.6rem auto 1.4rem}
  .hero .pills{display:flex;gap:.5rem;justify-content:center;flex-wrap:wrap;margin-bottom:1.6rem}
  .hero .ctas{display:flex;gap:.7rem;justify-content:center;flex-wrap:wrap}
  h2{font-size:1.55rem;letter-spacing:-.02em;margin:3.2rem 0 .4rem;scroll-margin-top:5rem}
  h2 + p.sub{color:var(--muted);margin:0 0 1.2rem}
  .steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem}
  .step{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1.1rem 1.2rem;box-shadow:var(--shadow)}
  .step .n{display:inline-flex;width:1.7em;height:1.7em;align-items:center;justify-content:center;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-weight:700;font-size:.9rem;margin-bottom:.5rem}
  .step h3{margin:.1rem 0 .4rem;font-size:1.02rem}
  .step p{margin:.3rem 0;font-size:.92rem;color:var(--muted)}
  .copywrap{position:relative}
  .copywrap button{position:absolute;top:.45rem;right:.45rem;font-size:.72rem;padding:.25em .7em;border-radius:7px;border:1px solid var(--line);background:var(--card);color:var(--muted);cursor:pointer}
  .copywrap button:hover{color:var(--ink);border-color:var(--accent)}
  .tabs{display:flex;gap:.4rem;flex-wrap:wrap;margin:1rem 0 0}
  .tabs button{padding:.5em 1em;border-radius:10px 10px 0 0;border:1px solid var(--line);border-bottom:0;background:transparent;color:var(--muted);font-weight:600;font-size:.92rem;cursor:pointer}
  .tabs button.on{background:var(--card);color:var(--ink);border-color:var(--line)}
  .tabpane{display:none;background:var(--card);border:1px solid var(--line);border-radius:0 12px 12px 12px;padding:1.2rem 1.4rem;box-shadow:var(--shadow)}
  .tabpane.on{display:block}
  .tabpane ol{padding-left:1.3rem;margin:.6rem 0} .tabpane li{margin:.45em 0}
  .note{border-left:3px solid var(--accent);background:color-mix(in srgb,var(--accent) 7%,transparent);padding:.6rem .9rem;border-radius:0 9px 9px 0;font-size:.92rem;margin:.8rem 0}
  .tgroup h3{margin:1.6rem 0 .6rem;font-size:1.08rem}
  .tgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:.7rem}
  .tcard{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:.75rem .95rem;box-shadow:var(--shadow)}
  .tcard .trow{display:flex;align-items:center;justify-content:space-between;gap:.5rem}
  .tcard p{margin:.35rem 0 0;font-size:.87rem;color:var(--muted)}
  footer{border-top:1px solid var(--line);margin-top:3rem;padding:1.6rem 0;color:var(--muted);font-size:.9rem;text-align:center}
  </style>
  <header><nav class="nav">
    <a class="logo" href="/">five9-<span>mcp</span></a><span class="sp"></span>
    <a href="#setup">Setup</a><a href="#connect">Connect</a><a href="#tools">Tools</a>
    <a href="/console">Console</a><a href="https://github.com/outboundani/five9-mcp">GitHub</a>
  </nav></header>
  <main>
  <div class="hero">
    <h1>Your Five9 contact center,<br><span>in your AI's hands</span></h1>
    <p class="tag">An open-source MCP server that connects Claude, ChatGPT, or any MCP client
    to Five9 — campaigns, dialing lists, contacts, DNC, reports, and real-time stats.</p>
    <div class="pills">
      <span class="pill"><span class="dot" id="statusdot"></span><span id="statustext">checking…</span></span>
      <span class="pill">🛠️ ${tools.length} tools</span>
      <span class="pill">📦 zero dependencies</span>
      <span class="pill">☁️ Cloudflare Workers</span>
    </div>
    <div class="ctas">
      ${cfg.configured
        ? '<a class="btn primary" href="/console">▶ Open the console</a>'
        : '<a class="btn primary" href="/setup">⚙️ Finish setup — connect your Five9 domain</a>'}
      <a class="btn" href="https://github.com/outboundani/five9-mcp">★ Star on GitHub</a>
    </div>
    ${cfg.configured ? '' : `<p style="margin-top:1rem"><span class="pill">👋 This server isn't connected to a Five9 domain yet — <a href="/setup">finish setup</a> (takes 1 minute, no terminal needed)</span></p>`}
  </div>

  <h2 id="setup">Set up your own in 3 steps</h2>
  <p class="sub">Runs on Cloudflare's free tier. You need a free Cloudflare account and a Five9 user with API access. <strong>No terminal required.</strong></p>
  <div class="steps">
    <div class="step"><span class="n">1</span><h3>Deploy to Cloudflare</h3>
      <p><a href="https://deploy.workers.cloudflare.com/?url=https://github.com/outboundani/five9-mcp"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" style="max-width:100%"></a></p>
      <p>Click the button, sign in to Cloudflare, and it deploys your own copy in your browser. You get a URL like <code>https://five9-mcp.you.workers.dev</code>.</p>
      <p><small>Prefer the CLI? <code>git clone</code> the repo and <code>npx wrangler deploy</code> works too.</small></p></div>
    <div class="step"><span class="n">2</span><h3>Run the setup wizard</h3>
      <p>Open <code>/setup</code> on your new server, enter your Five9 username &amp; password, and pick your region.</p>
      <p>The wizard <strong>tests the credentials live against Five9</strong>, then hands you your access key. Use a <strong>dedicated Five9 API user</strong>, not a personal admin login.</p></div>
    <div class="step"><span class="n">3</span><h3>Connect your AI</h3>
      <p>Point Claude or ChatGPT at <code>https://&lt;your-worker&gt;/mcp</code> and paste the access key when asked — full walkthroughs below.</p>
      <p>Then try: <em>"check the connection and list my campaigns."</em></p></div>
  </div>

  <h2 id="connect">Connect your AI</h2>
  <p class="sub">The MCP endpoint is <code>/mcp</code> on this server. Pick your client:</p>
  <div class="tabs" id="tabs">
    <button class="on" data-tab="claude">Claude (web & desktop)</button>
    <button data-tab="code">Claude Code</button>
    <button data-tab="chatgpt">ChatGPT</button>
    <button data-tab="any">Any MCP client</button>
  </div>
  <div class="tabpane on" data-pane="claude">
    <ol>
      <li>In <a href="https://claude.ai">claude.ai</a> (or the Claude desktop app), open <strong>Settings → Connectors</strong>.</li>
      <li>Click <strong>Add custom connector</strong>.</li>
      <li>Name it <em>Five9</em> and paste your server URL with the <code>/mcp</code> path:<br><code>https://&lt;your-worker&gt;.workers.dev/mcp</code></li>
      <li>Click <strong>Add</strong>, then <strong>Connect</strong>. Claude discovers this server's built-in OAuth and opens its authorization page.</li>
      <li>On the 🔐 five9-mcp screen, paste your <code>MCP_AUTH_TOKEN</code> as the access key and click <strong>Authorize</strong>.</li>
      <li>In a chat, open the <strong>search &amp; tools</strong> (＋) menu and make sure the Five9 connector is enabled. Ask away!</li>
    </ol>
    <div class="note">On Team/Enterprise plans an Owner adds the connector under <strong>Organization settings → Connectors</strong> first; members then hit <strong>Connect</strong> on their own settings page.</div>
  </div>
  <div class="tabpane" data-pane="code">
    <div class="copywrap"><pre><code>claude mcp add --transport http five9 https://&lt;your-worker&gt;.workers.dev/mcp \\
  --header "Authorization: Bearer &lt;your MCP_AUTH_TOKEN&gt;"</code></pre><button data-copy>Copy</button></div>
    <p>That's it — the raw access key works directly as a bearer token, no OAuth dance needed. Run <code>/mcp</code> inside Claude Code to check the connection.</p>
  </div>
  <div class="tabpane" data-pane="chatgpt">
    <ol>
      <li>In <a href="https://chatgpt.com">ChatGPT</a> (web), open <strong>Settings → Apps &amp; Connectors</strong> (may be labeled <strong>Connectors</strong>).</li>
      <li>Scroll to <strong>Advanced settings</strong> and switch on <strong>Developer mode</strong> (available on Plus/Pro; on Business/Enterprise an admin must allow custom connectors).</li>
      <li>Back on the Connectors page, click <strong>Create</strong>.</li>
      <li>Name it <em>Five9</em>, set the <strong>MCP server URL</strong> to <code>https://&lt;your-worker&gt;.workers.dev/mcp</code>, and choose <strong>OAuth</strong> authentication.</li>
      <li>Acknowledge the trust prompt and save — ChatGPT opens this server's authorization page. Paste your <code>MCP_AUTH_TOKEN</code> and click <strong>Authorize</strong>.</li>
      <li>In a new chat, open the ＋ / tools menu, enable the <em>Five9</em> connector under Developer mode, and confirm tool calls as they run.</li>
    </ol>
    <div class="note">ChatGPT asks you to confirm each tool call — that's by design for custom connectors, and honestly a good idea for anything that can start a dialer. 😄</div>
  </div>
  <div class="tabpane" data-pane="any">
    <p>Any MCP client that speaks <strong>streamable HTTP</strong> works. Point it at <code>/mcp</code> and either complete the OAuth flow or send the access key directly:</p>
    <div class="copywrap"><pre><code>curl -X POST https://&lt;your-worker&gt;.workers.dev/mcp \\
  -H "Authorization: Bearer &lt;MCP_AUTH_TOKEN&gt;" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check_connection","arguments":{}}}'</code></pre><button data-copy>Copy</button></div>
  </div>

  <h2 id="tools">The toolbox</h2>
  <p class="sub"><span class="badge read">READ</span> tools are always safe; <span class="badge write">WRITE</span> tools change your domain — the server tells AIs to confirm those with you first. Try any of them in the <a href="/console">console</a>.</p>
  ${toolCards}
  </main>
  <footer>MIT-licensed open source · <a href="https://github.com/outboundani/five9-mcp">github.com/outboundani/five9-mcp</a> · built by <a href="https://www.linkedin.com/in/ryanshatzkamer">Ryan Shatzkamer</a></footer>
  <script>
  document.querySelectorAll('[data-copy]').forEach(function(b){
    b.addEventListener('click', function(){
      var code = b.parentElement.querySelector('code');
      navigator.clipboard.writeText(code.innerText).then(function(){
        b.textContent = 'Copied!'; setTimeout(function(){ b.textContent = 'Copy'; }, 1400);
      });
    });
  });
  document.querySelectorAll('#tabs button').forEach(function(b){
    b.addEventListener('click', function(){
      document.querySelectorAll('#tabs button').forEach(function(x){ x.classList.toggle('on', x === b); });
      document.querySelectorAll('.tabpane').forEach(function(p){ p.classList.toggle('on', p.dataset.pane === b.dataset.tab); });
    });
  });
  fetch('/health').then(function(r){ return r.json(); }).then(function(h){
    document.getElementById('statusdot').className = 'dot ok';
    document.getElementById('statustext').textContent = 'server online · v' + h.server.version;
  }).catch(function(){
    document.getElementById('statusdot').className = 'dot err';
    document.getElementById('statustext').textContent = 'server unreachable';
  });
  </script>`);
}

export function consolePage(tools) {
  const groups = grouped(tools).map((g) => ({
    name: g.name, icon: g.icon,
    items: g.items.map((t) => ({ name: t.name, write: WRITE_TOOLS.has(t.name) })),
  }));
  const toolJson = JSON.stringify(Object.fromEntries(tools.map((t) => [t.name, t])));
  const groupJson = JSON.stringify(groups);

  return page('five9-mcp console', `
  <style>
  body{display:flex;flex-direction:column;height:100vh;overflow:hidden}
  header{display:flex;align-items:center;gap:1rem;padding:.6rem 1.1rem;border-bottom:1px solid var(--line);background:var(--card)}
  header .logo{font-weight:800;color:var(--ink)} header .logo span{color:var(--accent)}
  header input{flex:1;max-width:420px;padding:.45em .8em;border-radius:9px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font-family:ui-monospace,monospace;font-size:.85rem}
  header .sp{flex:1}
  .wrap{display:flex;flex:1;min-height:0}
  aside{width:250px;overflow-y:auto;border-right:1px solid var(--line);padding:.7rem .55rem;background:var(--card)}
  aside h4{margin:.8rem .4rem .25rem;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
  aside button{display:flex;justify-content:space-between;align-items:center;width:100%;text-align:left;padding:.35em .6em;margin:.06em 0;border:0;border-radius:8px;background:none;color:var(--ink);font-size:.86rem;font-family:ui-monospace,monospace;cursor:pointer}
  aside button:hover{background:var(--code)} aside button.on{background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--accent);font-weight:600}
  main{flex:1;overflow-y:auto;padding:1.3rem 1.6rem}
  main h1{margin:.1rem 0;font-size:1.35rem;font-family:ui-monospace,monospace;letter-spacing:-.01em}
  main p.desc{color:var(--muted);max-width:760px;margin:.4rem 0 1.1rem;font-size:.93rem}
  .field{margin:.7rem 0} .field label{display:block;font-weight:600;font-size:.86rem;margin-bottom:.25rem}
  .field label small{color:var(--muted);font-weight:400}
  .field input[type=text],.field textarea,.field select{width:100%;max-width:560px;padding:.5em .75em;border-radius:9px;border:1px solid var(--line);background:var(--card);color:var(--ink);font-family:ui-monospace,monospace;font-size:.88rem}
  .field textarea{min-height:5.2em;resize:vertical}
  .runrow{display:flex;align-items:center;gap:.8rem;margin:1.2rem 0}
  #out{border:1px solid var(--line);border-radius:12px;background:var(--card);margin-top:.4rem;overflow:hidden;display:none}
  #outhead{display:flex;align-items:center;gap:.7rem;padding:.5rem .9rem;border-bottom:1px solid var(--line);font-size:.85rem}
  #outbody{margin:0;border-radius:0;max-height:52vh;overflow:auto;background:var(--code);padding:1rem}
  .spin{display:inline-block;width:1em;height:1em;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:sp .7s linear infinite;vertical-align:-.15em}
  @keyframes sp{to{transform:rotate(360deg)}}
  .empty{color:var(--muted);text-align:center;margin-top:18vh}
  @media(max-width:720px){aside{display:none}}
  </style>
  <header>
    <a class="logo" href="/">five9-<span>mcp</span></a>
    <input id="token" type="password" placeholder="Access key (MCP_AUTH_TOKEN) — stored only in this browser" autocomplete="off">
    <span class="sp"></span><span class="pill"><span class="dot" id="dot"></span><span id="stat">no key</span></span>
  </header>
  <div class="wrap">
    <aside id="side"></aside>
    <main id="main"><div class="empty"><h2>⌁ five9-mcp console</h2><p>Paste your access key above, pick a tool on the left, and run it.<br>Results come straight from your Five9 domain.</p></div></main>
  </div>
  <script>
  var TOOLS = ${toolJson};
  var GROUPS = ${groupJson};
  var current = null;
  var token = localStorage.getItem('f9token') || '';
  var tokenEl = document.getElementById('token');
  tokenEl.value = token;
  tokenEl.addEventListener('input', function(){ token = tokenEl.value.trim(); localStorage.setItem('f9token', token); setStat(); });

  function setStat(ok, msg){
    var dot = document.getElementById('dot'), stat = document.getElementById('stat');
    if (msg === undefined){ dot.className = token ? 'dot' : 'dot'; stat.textContent = token ? 'key set' : 'no key'; return; }
    dot.className = ok ? 'dot ok' : 'dot err'; stat.textContent = msg;
  }
  setStat();

  var side = document.getElementById('side');
  GROUPS.forEach(function(g){
    var h = document.createElement('h4'); h.textContent = g.icon + ' ' + g.name; side.appendChild(h);
    g.items.forEach(function(it){
      var b = document.createElement('button');
      b.innerHTML = '<span>' + it.name + '</span>' + (it.write ? '<span class="badge write">W</span>' : '');
      b.addEventListener('click', function(){ select(it.name, b); });
      side.appendChild(b);
    });
  });

  function select(name, btn){
    current = name;
    document.querySelectorAll('aside button').forEach(function(x){ x.classList.toggle('on', x === btn); });
    var t = TOOLS[name];
    var props = (t.inputSchema && t.inputSchema.properties) || {};
    var req = (t.inputSchema && t.inputSchema.required) || [];
    var html = '<h1>' + name + '</h1><p class="desc">' + esch(t.description) + '</p>';
    Object.keys(props).forEach(function(k){
      var p = props[k];
      var must = req.indexOf(k) >= 0 ? ' <small>· required</small>' : ' <small>· optional</small>';
      html += '<div class="field"><label>' + k + must + (p.description ? ' <small>— ' + esch(p.description) + '</small>' : '') + '</label>';
      if (p.enum) {
        html += '<select data-k="' + k + '" data-t="string">' + (req.indexOf(k) < 0 ? '<option value="">(default)</option>' : '') +
          p.enum.map(function(v){ return '<option>' + v + '</option>'; }).join('') + '</select>';
      } else if (p.type === 'boolean') {
        html += '<select data-k="' + k + '" data-t="boolean"><option value="">(unset)</option><option>true</option><option>false</option></select>';
      } else if (p.type === 'object' || p.type === 'array') {
        var ph = p.type === 'object' ? '{"number1": "5551234567"}' : '["5551234567"]';
        html += '<textarea data-k="' + k + '" data-t="json" placeholder=\\'' + ph + '\\' spellcheck="false"></textarea>';
      } else if (p.type === 'number') {
        html += '<input type="text" inputmode="numeric" data-k="' + k + '" data-t="number">';
      } else {
        html += '<input type="text" data-k="' + k + '" data-t="string" spellcheck="false">';
      }
      html += '</div>';
    });
    if (!Object.keys(props).length) html += '<p class="desc"><em>No arguments.</em></p>';
    html += '<div class="runrow"><button class="btn primary" id="run">▶ Run tool</button><span id="runstat"></span></div>' +
      '<div id="out"><div id="outhead"></div><pre id="outbody"></pre></div>';
    document.getElementById('main').innerHTML = html;
    document.getElementById('run').addEventListener('click', run);
  }

  function esch(s){ var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  function run(){
    if (!token) { setStat(false, 'paste your access key first'); tokenEl.focus(); return; }
    var args = {}, bad = null;
    document.querySelectorAll('[data-k]').forEach(function(el){
      var v = el.value.trim(); if (!v) return;
      if (el.dataset.t === 'json') { try { args[el.dataset.k] = JSON.parse(v); } catch(e) { bad = el.dataset.k; } }
      else if (el.dataset.t === 'number') args[el.dataset.k] = Number(v);
      else if (el.dataset.t === 'boolean') args[el.dataset.k] = v === 'true';
      else args[el.dataset.k] = v;
    });
    var rs = document.getElementById('runstat');
    if (bad) { rs.textContent = '⚠ "' + bad + '" is not valid JSON'; return; }
    rs.innerHTML = '<span class="spin"></span> calling Five9…';
    var t0 = Date.now();
    fetch('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: current, arguments: args } })
    }).then(function(r){
      if (r.status === 401) throw new Error('Unauthorized — check your access key.');
      return r.json();
    }).then(function(j){
      var ms = Date.now() - t0; rs.textContent = '';
      var out = document.getElementById('out'), head = document.getElementById('outhead'), body = document.getElementById('outbody');
      out.style.display = 'block';
      if (j.error) { head.innerHTML = '<span class="dot err"></span> RPC error · ' + ms + ' ms'; body.textContent = JSON.stringify(j.error, null, 2); setStat(false, 'error'); return; }
      var isErr = j.result && j.result.isError;
      var text = (j.result && j.result.content && j.result.content[0] && j.result.content[0].text) || JSON.stringify(j.result, null, 2);
      head.innerHTML = '<span class="dot ' + (isErr ? 'err' : 'ok') + '"></span> ' + (isErr ? 'tool error' : 'success') + ' · ' + ms + ' ms · ' + current;
      body.textContent = text;
      setStat(!isErr, isErr ? 'tool error' : 'ok · ' + ms + ' ms');
    }).catch(function(e){
      rs.textContent = ''; setStat(false, e.message);
      var out = document.getElementById('out'); out.style.display = 'block';
      document.getElementById('outhead').innerHTML = '<span class="dot err"></span> request failed';
      document.getElementById('outbody').textContent = e.message;
    });
  }
  </script>`);
}

export function setupPage(cfg) {
  const envManaged = cfg.source === 'env';
  const reconfigure = !envManaged && cfg.configured;

  const inner = envManaged ? `
    <div class="card">
      <h1>🔒 Managed by Wrangler secrets</h1>
      <p>This server's Five9 credentials are set as Cloudflare Worker secrets, which override the setup wizard.
      To change them, the operator runs:</p>
      <pre><code>npx wrangler secret put FIVE9_USERNAME
npx wrangler secret put FIVE9_PASSWORD
npx wrangler secret put MCP_AUTH_TOKEN</code></pre>
      <p>To switch to browser-based setup instead, delete those secrets
      (<code>npx wrangler secret delete &lt;NAME&gt;</code>) and reload this page.</p>
      <p><a class="btn" href="/">← Back</a></p>
    </div>` : `
    <div class="card" id="formcard">
      <h1>${reconfigure ? '🔧 Update Five9 credentials' : '👋 Welcome! Let’s connect your Five9 domain'}</h1>
      <p>${reconfigure
        ? 'Enter the new credentials and this server’s current access key. Your access key stays the same.'
        : 'Enter the Five9 user this server should act as. We recommend a <strong>dedicated API user</strong> — the AI can only do what this user’s Five9 role allows. Credentials are checked against Five9 before anything is saved.'}</p>
      <div class="field"><label for="u">Five9 username</label>
        <input id="u" type="text" placeholder="apiuser@yourdomain" autocomplete="username" spellcheck="false"></div>
      <div class="field"><label for="p">Five9 password</label>
        <input id="p" type="password" autocomplete="current-password"></div>
      <div class="field"><label for="h">Region</label>
        <select id="h">
          <option value="api.five9.com">United States (api.five9.com)</option>
          <option value="api.eu.five9.com">Europe (api.eu.five9.com)</option>
          <option value="api.ca.five9.com">Canada (api.ca.five9.com)</option>
        </select></div>
      ${reconfigure ? `
      <div class="field"><label for="k">Current access key</label>
        <input id="k" type="password" placeholder="This server's existing access key" autocomplete="off"></div>` : ''}
      <div class="runrow">
        <button class="btn primary" id="go">✓ Test &amp; save</button>
        <span id="runstat"></span>
      </div>
      <div id="err" class="errbox" style="display:none"></div>
    </div>
    <div class="card" id="done" style="display:none">
      <h1>🎉 Connected!</h1>
      <p id="donemsg"></p>
      <div id="keywrap" style="display:none">
        <p><strong>Your access key</strong> — shown only this once. Store it in a password manager:</p>
        <div class="keybox"><code id="key"></code><button class="btn" id="copykey">Copy</button></div>
      </div>
      <p><strong>Next:</strong> connect your AI (walkthroughs on the <a href="/#connect">home page</a>)
      or try a tool right now in the <a href="/console">console</a>.</p>
    </div>
    <script>
    document.getElementById('go').addEventListener('click', function(){
      var stat = document.getElementById('runstat'), err = document.getElementById('err');
      err.style.display = 'none';
      var body = {
        username: document.getElementById('u').value.trim(),
        password: document.getElementById('p').value,
        host: document.getElementById('h').value
      };
      var k = document.getElementById('k'); if (k) body.current_key = k.value.trim();
      if (!body.username || !body.password) { err.textContent = 'Please fill in username and password.'; err.style.display = 'block'; return; }
      stat.innerHTML = '<span class="spin"></span> checking with Five9…';
      fetch('/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
        .then(function(res){
          stat.textContent = '';
          if (!res.ok) { err.textContent = res.j.error || 'Something went wrong.'; err.style.display = 'block'; return; }
          document.getElementById('formcard').style.display = 'none';
          var done = document.getElementById('done'); done.style.display = 'block';
          document.getElementById('donemsg').textContent =
            'Credentials verified — ' + res.j.skillsVisible + ' skills visible on your domain. ' + (res.j.note || '');
          if (res.j.accessKey) {
            document.getElementById('keywrap').style.display = 'block';
            document.getElementById('key').textContent = res.j.accessKey;
          }
        })
        .catch(function(e){ stat.textContent = ''; err.textContent = 'Request failed: ' + e.message; err.style.display = 'block'; });
    });
    var ck = document.getElementById('copykey');
    if (ck) ck.addEventListener('click', function(){
      navigator.clipboard.writeText(document.getElementById('key').textContent).then(function(){
        ck.textContent = 'Copied!'; setTimeout(function(){ ck.textContent = 'Copy'; }, 1400);
      });
    });
    </script>`;

  return page('Setup · five9-mcp', `
  <style>
  .wrap{max-width:560px;margin:0 auto;padding:3.5rem 1.25rem}
  .logo{font-weight:800;color:var(--ink);font-size:1.05rem} .logo span{color:var(--accent)}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:1.6rem 1.8rem;box-shadow:var(--shadow);margin-top:1rem}
  .card h1{font-size:1.35rem;letter-spacing:-.02em;margin:0 0 .5rem}
  .card p{font-size:.95rem;color:var(--muted)}
  .field{margin:1rem 0} .field label{display:block;font-weight:600;font-size:.88rem;margin-bottom:.3rem}
  .field input,.field select{width:100%;padding:.6em .8em;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font-size:.95rem}
  .runrow{display:flex;align-items:center;gap:.8rem;margin-top:1.3rem}
  .errbox{margin-top:1rem;background:color-mix(in srgb,var(--err) 10%,transparent);color:var(--err);border-radius:10px;padding:.7rem 1rem;font-size:.92rem}
  .keybox{display:flex;align-items:center;gap:.6rem;background:var(--code);border-radius:10px;padding:.7rem .9rem;flex-wrap:wrap}
  .keybox code{background:none;word-break:break-all;flex:1;min-width:200px}
  .spin{display:inline-block;width:1em;height:1em;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:sp .7s linear infinite;vertical-align:-.15em}
  @keyframes sp{to{transform:rotate(360deg)}}
  </style>
  <div class="wrap">
    <a class="logo" href="/">☎️ five9-<span>mcp</span></a>
    ${inner}
  </div>`);
}

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="Open-source MCP server for the Five9 cloud contact center — campaigns, lists, contacts, DNC, reports, and real-time stats for Claude, ChatGPT, and any MCP client.">
<style>${BASE_CSS}</style></head><body>${body}</body></html>`;
}
