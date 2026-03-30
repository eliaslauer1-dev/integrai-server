'use strict';

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const Anthropic  = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const https      = require('https');
const crypto     = require('crypto');

const app  = express();

// ── Clients — lazy so server starts even if env vars missing ──
function getAnthropic() {
  if (!process.env.ANTHROPIC_KEY) throw new Error('ANTHROPIC_KEY not set in Railway environment variables');
  return new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });
}

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
  : null;

// ── Middleware ─────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key'],
  preflightContinue: false,
  optionsSuccessStatus: 204,
}));
app.options('*', cors());
app.use(express.json({ limit: '2mb' }));

// Rate limiting — generous for authenticated product use
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests, please try again shortly.' },
});
app.use('/api/', limiter);

// ── Health check ──────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ══════════════════════════════════════════════════════════════
//  ANALYSE — reads repo + fetches docs, returns blueprint JSON
// ══════════════════════════════════════════════════════════════
app.post('/api/analyse', async (req, res) => {
  const { repo, language, docsUrl, intent, token } = req.body;
  if (!repo || !docsUrl || !intent) {
    return res.status(400).json({ error: 'repo, docsUrl and intent are required' });
  }

  const ghHeaders = { Authorization: `token ${token || process.env.GITHUB_TOKEN || ''}` };

  // 1. Read key repo files
  const filesToTry = [
    'package.json','requirements.txt','go.mod','.env.example',
    'index.html','README.md',
    'src/app/layout.tsx','app/layout.tsx',
    'pages/_app.tsx','pages/_app.js',
    'src/App.tsx','src/App.jsx','src/main.tsx',
    'src/index.ts','src/index.js','src/app.ts','src/app.js',
    'app.py','main.py','main.go','server.js',
  ];
  const repoFiles = {};
  await Promise.all(filesToTry.map(async (path) => {
    try {
      const r = await ghFetch(`https://api.github.com/repos/${repo}/contents/${path}`, ghHeaders);
      if (r.ok) {
        const d = await r.json();
        if (d.content) repoFiles[path] = Buffer.from(d.content, 'base64').toString('utf8').slice(0, 4000);
      }
    } catch (_) {}
  }));

  // 2. Full file tree
  let srcTree = '';
  try {
    const r = await ghFetch(`https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`, ghHeaders);
    if (r.ok) {
      const d = await r.json();
      srcTree = (d.tree || []).filter(f => f.type === 'blob').map(f => f.path).slice(0, 80).join('\n');
    }
  } catch (_) {}

  // 3. Fetch API docs
  let docsContent = '';
  try {
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(docsUrl)}`;
    const r = await fetch(proxyUrl);
    const j = await r.json();
    docsContent = (j.contents || '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000);
  } catch (_) {
    docsContent = `Could not fetch ${docsUrl}`;
  }

  // 4. Claude analysis
  const systemPrompt = `You are a senior integration engineer. Analyse a developer's codebase and API docs and return a precise integration blueprint as JSON only. No markdown, no explanation.`;
  const userPrompt = `Analyse this codebase and API docs to plan a complete, production-ready integration.

REPO: ${repo}
LANGUAGE: ${language || 'Unknown'}
GOAL: ${intent}

FILE TREE:
${srcTree}

REPO FILES:
${Object.entries(repoFiles).map(([p, c]) => `--- ${p} ---\n${c}`).join('\n\n')}

API DOCS (${docsUrl}):
${docsContent}

Return this exact JSON:
{
  "repo_summary": "2-3 sentence description",
  "render_target": "nextjs-app-router | nextjs-pages-router | react-spa | vue-spa | express-static | static-html | django | rails | laravel | other",
  "stack": { "language": "", "framework": "", "db": "", "orm": "", "package_manager": "npm|pip|go|cargo|composer" },
  "entry_point": "for static-html always index.html. for nextjs-pages e.g. pages/_app.tsx. for react-spa e.g. src/App.tsx.",
  "static_dir": "public | static | assets | null",
  "existing_patterns": ["pattern1"],
  "widget_route": "/integration",
  "api_name": "API name",
  "api_base_url": "https://...",
  "auth_method": "Bearer token | API key | OAuth2 | Basic auth",
  "key_endpoints": [{ "method": "POST", "path": "/v1/resources", "purpose": "Create resource", "request_body": {}, "response_key_fields": ["id"] }],
  "webhooks": [{ "event": "resource.created", "description": "Fires when created" }],
  "packages_to_add": [{ "name": "stripe", "version": "latest", "reason": "official SDK" }],
  "credentials": [{ "env_var": "API_KEY", "label": "API Key", "hint": "Dashboard → Developers", "type": "password", "required": true }],
  "approach": "2-3 sentences on strategy"
}`;

  try {
    const message = await getAnthropic().messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const raw = message.content.filter(c => c.type === 'text').map(c => c.text).join('').trim();
    const analysis = JSON.parse(raw.replace(/^```[a-z]*\n?/, '').replace(/```$/, '').trim());
    analysis._repoFiles = repoFiles;
    return res.json({ analysis });
  } catch (err) {
    console.error('[analyse] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  GENERATE — produces the integration code files
// ══════════════════════════════════════════════════════════════
app.post('/api/generate', async (req, res) => {
  const { analysis, credValues, intent, repo, docsUrl } = req.body;
  if (!analysis || !intent) return res.status(400).json({ error: 'analysis and intent are required' });

  const a            = analysis;
  const repoFiles    = a._repoFiles || {};
  const renderTarget = a.render_target || 'static-html';
  const entryPoint   = a.entry_point  || 'index.html';
  const apiName      = a.api_name     || 'Integration';
  const apiBase      = a.api_base_url || '';
  const authMethod   = a.auth_method  || 'Bearer token';
  const apiSlug      = apiName.toLowerCase().replace(/\s+/g, '-');
  const creds        = credValues || {};
  const credEnvVars  = Object.keys(creds);
  const firstCred    = credEnvVars[0] || 'API_KEY';
  const webhooks     = a.webhooks || [];

  // Stream headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (type, data) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

  try {
    // ── For static-html: build most files deterministically, only use Claude for API handler ──
    if (renderTarget === 'static-html' || renderTarget === 'express-static') {

      // 1. Inject widget div into existing index.html or create new one
      const existingHtml = repoFiles['index.html'] || repoFiles[entryPoint] || '';
      const widgetDiv = '\n\n<!-- IntegrAI: ' + apiName + ' Widget -->\n<div id="integration-widget" style="max-width:520px;margin:40px auto;padding:0 24px"></div>\n<script src="/integration-widget.js"><\\/script>';
      let indexContent;
      if (existingHtml && existingHtml.includes('</body>')) {
        indexContent = existingHtml.replace('</body>', widgetDiv + '\n</body>');
      } else if (existingHtml) {
        indexContent = existingHtml + widgetDiv.replace('<\\/script>', '</script>');
      } else {
        indexContent = '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width,initial-scale=1">\n  <title>' + apiName + '</title>\n  <style>body{font-family:system-ui,sans-serif;background:#f8fafc;padding:40px 24px;margin:0}h1{text-align:center;color:#1a202c}</style>\n</head>\n<body>\n  <h1>' + apiName + '</h1>\n  <div id="integration-widget" style="max-width:520px;margin:0 auto"></div>\n  <script src="/integration-widget.js"></script>\n</body>\n</html>';
      }
      // Fix escaped script tag
      indexContent = indexContent.replace('<\\/script>', '</script>');

      // 2. Build widget JS deterministically (always correct, no hallucinations)
      const widgetJs = buildWidgetJs(apiName, apiSlug, intent, a.credentials || []);

      // 3. vercel.json — always correct
      const vercelJson = JSON.stringify({
        version: 2,
        outputDirectory: '.',
        routes: [
          { src: '^/api/(.*)', dest: '/api/$1' },
          { src: '^/integration-widget\\.js$', dest: '/integration-widget.js' },
          { src: '^/(.*)', dest: '/index.html' }
        ]
      }, null, 2);

      // 4. package.json — minimal, no hallucinated packages
      const packageJson = JSON.stringify({
        name: (repo || 'app').split('/').pop().toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        version: '1.0.0',
        scripts: { build: 'echo done' }
      }, null, 2);

      // 5. Use Claude ONLY for the API handler — focused, constrained prompt
      send('progress', { text: 'Generating API handler…' });

      const handlerPrompt = `Write a Vercel serverless function (Node.js, CommonJS, module.exports = async function handler(req, res)) that:
- Accepts POST requests
- Reads credentials from process.env (${credEnvVars.join(', ')})
- Calls the ${apiName} API at ${apiBase} using ${authMethod}
- Goal: ${intent}
- Key endpoints: ${(a.key_endpoints || []).map(e => e.method + ' ' + e.path + ' — ' + e.purpose).join('; ')}
- Sets CORS headers (Access-Control-Allow-Origin: *)
- Handles OPTIONS preflight
- Returns JSON response

Return ONLY the JavaScript code, no markdown, no explanation.`;

      const handlerRes = await getAnthropic().messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3000,
        messages: [{ role: 'user', content: handlerPrompt }],
      });

      let handlerCode = (handlerRes.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
      handlerCode = handlerCode.replace(/^```[a-z]*\n?/i, '').replace(/```$/,'').trim();

      // 6. INTEGRATION.md
      const credRows = (a.credentials || []).map(c => `| \`${c.env_var}\` | ${c.label} | ${c.hint} |`).join('\n');
      const integrationMd = `# ${apiName} Integration\n\n**Goal:** ${intent}\n\n## After merging\n\n1. Add environment variables in Vercel dashboard:\n\n| Variable | Label | Where to find |\n|---|---|---|\n${credRows}\n\n2. The widget renders automatically at the root URL\n3. Webhook URL: \`https://your-domain.com/api/integration/webhook\`\n`;

      const files = [
        { path: 'index.html',                    is_new: !existingHtml, description: 'HTML with widget injected',     content: indexContent },
        { path: 'integration-widget.js',          is_new: true,          description: 'Self-invoking widget UI',       content: widgetJs },
        { path: 'api/integration/index.js',       is_new: true,          description: apiName + ' API handler',        content: handlerCode },
        { path: 'vercel.json',                    is_new: true,          description: 'Vercel routing config',         content: vercelJson },
        { path: 'package.json',                   is_new: true,          description: 'Minimal package.json',          content: packageJson },
        { path: 'INTEGRATION.md',                 is_new: true,          description: 'Setup guide',                   content: integrationMd },
      ];

      send('done', { files });
      res.end();
      return;
    }

    // ── For Next.js / React / other frameworks: use Claude for full generation ──
    const apiSlugFull  = (a.api_name || 'integration').toLowerCase().replace(/\s+/g, '-');
    const compName     = (a.api_name || 'Integration').replace(/\s+/g, '');
    const widgetRoute  = a.widget_route || '/integration';
    const fileListMap  = {
      'nextjs-app-router':   `1. app${widgetRoute}/page.tsx\n2. app/api${widgetRoute}/route.ts — GET+POST proxy\n3. app/api${widgetRoute}/webhook/route.ts — webhook\n4. components/${compName}Widget.tsx — 'use client' IIFE-style widget\n5. package.json — MODIFIED\n6. INTEGRATION.md`,
      'nextjs-pages-router': `1. pages${widgetRoute}.tsx\n2. pages/api/${apiSlugFull}/index.ts — GET+POST proxy\n3. pages/api/${apiSlugFull}/webhook.ts — webhook\n4. components/${compName}Widget.tsx\n5. package.json — MODIFIED\n6. INTEGRATION.md`,
      'react-spa':           `1. src/pages/${compName}Page.tsx\n2. src/components/${compName}Widget.tsx\n3. src/services/${apiSlugFull}.service.ts\n4. ${entryPoint} — MODIFIED with route\n5. package.json — MODIFIED\n6. INTEGRATION.md`,
    };
    const fileList = fileListMap[renderTarget] || `1. ${entryPoint} — MODIFIED\n2. api/${apiSlugFull}/index.ts\n3. package.json — MODIFIED\n4. INTEGRATION.md`;
    const existingEntry = repoFiles[entryPoint] || '';
    const existingPkg   = repoFiles['package.json'] || '';
    const endpointDocs  = (a.key_endpoints || []).map(e => `${e.method} ${e.path} — ${e.purpose}`).join('\n');

    const systemPrompt = `You are a senior full-stack engineer. Generate complete, production-ready integration files. No TODOs, no stubs. Credentials always from process.env. In package.json use "latest" for ALL versions. Respond ONLY with a valid JSON array, no markdown.`;
    const userPrompt = `Generate integration files.\nRENDER TARGET: ${renderTarget}\nGOAL: ${intent}\nSTACK: ${JSON.stringify(a.stack)}\nAPI: ${apiName} at ${apiBase}\nAUTH: ${authMethod}\nCREDENTIALS: ${credEnvVars.join(', ')}\nENDPOINTS:\n${endpointDocs}\nEXISTING ${entryPoint}:\n${existingEntry}\nEXISTING package.json:\n${existingPkg}\nFiles:\n${fileList}\nReturn JSON: [{"path","content","description","is_new":true|false}]`;

    let fullText = '';
    const stream = await getAnthropic().messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        fullText += chunk.delta.text;
        send('progress', { text: chunk.delta.text });
      }
    }

    const raw = fullText.trim().replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/\s*```$/,'').replace(/\\(?!["\\/bfnrtu])/g,'\\\\').trim();
    let files;
    try { files = JSON.parse(raw); }
    catch(e) {
      const m = raw.match(/\[[\s\S]*\]/);
      if (m) { try { files = JSON.parse(m[0]); } catch(e2) { files = JSON.parse(m[0].replace(/\\(?!["\\/bfnrtu])/g,'\\\\')); } }
      else throw new Error('Could not parse files: ' + e.message);
    }

    // Sanitize package versions
    files = files.map(f => {
      if (f.path === 'package.json' || f.path.endsWith('/package.json')) {
        try {
          const pkg = JSON.parse(f.content);
          ['dependencies','devDependencies'].forEach(k => {
            if (pkg[k]) Object.keys(pkg[k]).forEach(dep => { pkg[k][dep] = 'latest'; });
          });
          f = { ...f, content: JSON.stringify(pkg, null, 2) };
        } catch(e) {}
      }
      return f;
    });

    send('done', { files });
    res.end();
  } catch (err) {
    console.error('[generate] error:', err.message);
    if (!res.headersSent) return res.status(500).json({ error: err.message });
    send('error', { message: err.message });
    res.end();
  }
});

// ── Widget JS builder — deterministic, data-driven, no dynamic var names ──
function buildWidgetJs(apiName, apiSlug, intent, credentials) {
  // Serialize credentials as a JSON array embedded in the widget
  const credsJson = JSON.stringify(credentials.map(c => ({
    key:   c.env_var || '',
    label: c.label  || '',
    hint:  c.hint   || '',
    type:  c.type   || 'password',
  })));

  return `(function () {
  var CREDS = ${credsJson};
  var API_NAME = ${JSON.stringify(String(apiName))};
  var INTENT   = ${JSON.stringify(String(intent))};

  function mk(tag, css) {
    var el = document.createElement(tag);
    if (css) el.style.cssText = css;
    return el;
  }
  function txt(el, t) { el.textContent = t; return el; }

  function mount() {
    var root = document.getElementById('integration-widget');
    if (!root) { console.warn('[IntegrAI] No #integration-widget found'); return; }

    var card = mk('div', 'font-family:system-ui,-apple-system,sans-serif;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)');

    /* Header */
    var hdr = mk('div', 'padding:16px 20px;background:linear-gradient(135deg,#0061ff,#60a5fa);display:flex;align-items:center;gap:12px');
    txt(mk('div', 'font-size:1.3rem;flex-shrink:0'), '\u26A1');
    var hicon = mk('div', 'font-size:1.3rem;flex-shrink:0');
    hicon.textContent = '\u26A1';
    var htxt  = mk('div');
    txt(mk('div', 'color:#fff;font-weight:700;font-size:.95rem'), API_NAME);
    var htitle = mk('div', 'color:#fff;font-weight:700;font-size:.95rem');
    htitle.textContent = API_NAME;
    var hsub = mk('div', 'color:rgba(255,255,255,.8);font-size:.75rem;margin-top:1px');
    hsub.textContent = INTENT;
    htxt.appendChild(htitle);
    htxt.appendChild(hsub);
    hdr.appendChild(hicon);
    hdr.appendChild(htxt);

    /* Body */
    var body = mk('div', 'padding:20px');

    /* Credential fields */
    var inputs = {};
    CREDS.forEach(function(c) {
      var group = mk('div', 'margin-bottom:12px');
      var lbl = mk('label', 'display:block;font-size:.75rem;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px');
      lbl.textContent = c.label;
      var inp = document.createElement('input');
      inp.type = c.type === 'password' ? 'password' : 'text';
      inp.placeholder = c.key;
      inp.setAttribute('data-key', c.key);
      inp.style.cssText = 'width:100%;padding:9px 12px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:.875rem;box-sizing:border-box;outline:none;display:block';
      inp.addEventListener('focus', function() { inp.style.borderColor = '#0061ff'; });
      inp.addEventListener('blur',  function() { inp.style.borderColor = '#e2e8f0'; });
      if (c.hint) {
        var hint = mk('div', 'font-size:.72rem;color:#94a3b8;margin-top:3px');
        hint.textContent = c.hint;
        group.appendChild(hint);
      }
      group.insertBefore(lbl, group.firstChild);
      group.insertBefore(inp, group.lastChild || null);
      body.appendChild(group);
      inputs[c.key] = inp;
    });

    /* Button */
    var btn = document.createElement('button');
    btn.textContent = 'Connect';
    btn.style.cssText = 'width:100%;padding:11px;background:#0061ff;color:#fff;border:none;border-radius:8px;font-size:.9rem;font-weight:600;cursor:pointer;margin-top:4px';

    /* Status */
    var status = mk('div', 'margin-top:12px;font-size:.85rem;display:none;padding:10px 14px;border-radius:8px');

    /* Result */
    var result  = mk('div', 'margin-top:16px;display:none');
    var rtitle  = mk('div', 'font-size:.8rem;font-weight:700;color:#374151;margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em');
    rtitle.textContent = 'Response';
    var rbody = mk('pre', 'background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;font-size:.78rem;color:#334155;overflow-x:auto;margin:0;white-space:pre-wrap;word-break:break-all');
    result.appendChild(rtitle);
    result.appendChild(rbody);

    body.appendChild(btn);
    body.appendChild(status);
    body.appendChild(result);
    card.appendChild(hdr);
    card.appendChild(body);
    root.appendChild(card);

    btn.addEventListener('click', function() {
      var payload = {};
      CREDS.forEach(function(c) { payload[c.key] = (inputs[c.key] && inputs[c.key].value.trim()) || ''; });
      btn.disabled = true;
      btn.textContent = 'Connecting\u2026';
      status.style.display = 'none';
      result.style.display = 'none';

      fetch('/api/integration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      .then(function(r) {
        if (!r.ok) throw new Error('Server error ' + r.status);
        return r.json();
      })
      .then(function(d) {
        showStatus('\u2713 Connected', true);
        rbody.textContent = JSON.stringify(d, null, 2);
        result.style.display = 'block';
      })
      .catch(function(e) { showStatus('\u2717 ' + e.message, false); })
      .finally(function() { btn.disabled = false; btn.textContent = 'Connect'; });
    });

    function showStatus(msg, ok) {
      status.style.display = 'block';
      status.style.cssText = 'margin-top:12px;font-size:.85rem;display:block;padding:10px 14px;border-radius:8px;background:' + (ok ? '#f0fdf4' : '#fef2f2') + ';color:' + (ok ? '#16a34a' : '#dc2626') + ';border:1px solid ' + (ok ? '#bbf7d0' : '#fecaca');
      status.textContent = msg;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
`;
}

  // Build file list instruction based on render target — handled above per render target
  // (old code removed — see new generate endpoint above)

// ══════════════════════════════════════════════════════════════
//  PUSH — commits files to GitHub via Git Trees API
// ══════════════════════════════════════════════════════════════
app.post('/api/push', async (req, res) => {
  let { token, repo, defaultBranch, files, intent, apiName, docsUrl, credentials } = req.body;
  if (!token || !repo || !files?.length) {
    return res.status(400).json({ error: 'token, repo and files are required' });
  }

  // Auto-fix repo if missing owner — get it from the token
  if (!repo.includes('/')) {
    try {
      const userRes = await ghFetch('https://api.github.com/user', {
        Authorization: `token ${token}`,
        'User-Agent': 'IntegrAI/1.0',
      });
      const userData = await userRes.json();
      repo = `${userData.login}/${repo}`;
      console.log(`[push] auto-fixed repo to: ${repo}`);
    } catch(e) {
      return res.status(400).json({ error: `repo must be in format owner/name, got: ${repo}` });
    }
  }

  console.log(`[push] pushing ${files.length} files to ${repo}`);

  const hdrs = {
    Authorization: `token ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'IntegrAI/1.0',
  };
  const branch = `integrai/integration-${Date.now().toString(36)}`;
  const base   = defaultBranch || 'main';

  try {
    // Get base commit — try defaultBranch then fallback to main/master
    let baseSha, treeSha;
    const branchesToTry = [base, 'main', 'master'].filter((b, i, a) => a.indexOf(b) === i);
    let usedBase = base;

    for (const b of branchesToTry) {
      const refRes = await ghFetch(`https://api.github.com/repos/${repo}/git/ref/heads/${b}`, hdrs);
      if (refRes.ok) {
        const refData = await refRes.json();
        if (refData.object?.sha) {
          baseSha = refData.object.sha;
          usedBase = b;
          const cmRes  = await ghFetch(`https://api.github.com/repos/${repo}/git/commits/${baseSha}`, hdrs);
          const cmData = await cmRes.json();
          treeSha = cmData.tree.sha;
          break;
        }
      }
    }

    if (!baseSha) {
      return res.status(400).json({ error: `Could not find branch in repo ${repo}. Tried: ${branchesToTry.join(', ')}` });
    }

    // Create blobs in parallel — use base64 to handle any unicode characters
    const blobs = await Promise.all(files.map(async (f) => {
      const content64 = Buffer.from(f.content || '', 'utf-8').toString('base64');
      const bRes = await ghFetch(`https://api.github.com/repos/${repo}/git/blobs`, {
        method: 'POST',
        headers: hdrs,
        body: JSON.stringify({ content: content64, encoding: 'base64' }),
      });
      if (!bRes.ok) {
        const err = await bRes.text();
        throw new Error(`Blob creation failed for ${f.path}: ${bRes.status} ${err}`);
      }
      const bData = await bRes.json();
      if (!bData.sha) throw new Error(`No SHA returned for blob ${f.path}: ${JSON.stringify(bData)}`);
      return { path: f.path, mode: '100644', type: 'blob', sha: bData.sha };
    }));

    // Create tree
    const treeRes = await ghFetch(`https://api.github.com/repos/${repo}/git/trees`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ base_tree: treeSha, tree: blobs }),
    });
    if (!treeRes.ok) {
      const err = await treeRes.text();
      throw new Error(`Tree creation failed: ${treeRes.status} ${err}`);
    }
    const treeData = await treeRes.json();

    // Create commit
    const commitRes = await ghFetch(`https://api.github.com/repos/${repo}/git/commits`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({
        message: `feat: IntegrAI integration — ${intent}`,
        tree: treeData.sha,
        parents: [baseSha],
      }),
    });
    if (!commitRes.ok) {
      const err = await commitRes.text();
      throw new Error(`Commit creation failed: ${commitRes.status} ${err}`);
    }
    const newCommit = await commitRes.json();

    // Create branch
    const branchRes = await ghFetch(`https://api.github.com/repos/${repo}/git/refs`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: newCommit.sha }),
    });
    if (!branchRes.ok) {
      const err = await branchRes.text();
      throw new Error(`Branch creation failed: ${branchRes.status} ${err}`);
    }

    // Build PR body
    const fileList  = files.map(f => `- \`${f.path}\` (${f.is_new ? 'new' : 'modified'}) — ${f.description}`).join('\n');
    const credTable = (credentials || []).map(c => `| \`${c.env_var}\` | ${c.label} | ${c.hint} |`).join('\n');
    const prBody = `## ${apiName || 'API'} Integration\n\n**Goal:** ${intent}\n**Docs:** ${docsUrl || ''}\n\n### Files (${files.length})\n\n${fileList}\n\n### Before merging\n\nAdd these in your hosting platform's env var settings:\n\n| Variable | Label | Where to find it |\n|---|---|---|\n${credTable}\n\n> Merge → env vars set → widget live`;

    const prRes = await ghFetch(`https://api.github.com/repos/${repo}/pulls`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({
        title: `feat: ${apiName || 'API'} integration — ${intent}`,
        head: branch,
        base: usedBase,
        body: prBody,
      }),
    });
    if (!prRes.ok) {
      const err = await prRes.text();
      throw new Error(`PR creation failed: ${prRes.status} ${err}`);
    }
    const prData = await prRes.json();

    return res.json({
      pr:    prData.html_url,
      prNum: prData.number,
      branch,
      files: files.length,
    });
  } catch (err) {
    console.error('[push] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  LEADS — waitlist + partner applications via Supabase
// ══════════════════════════════════════════════════════════════
app.post('/api/leads/waitlist', async (req, res) => {
  const { name, email, company, source } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });

  if (supabase) {
    try {
      const { error } = await supabase.from('waitlist').insert({ name, email, company, source });
      if (error && error.code !== '23505') throw error; // ignore duplicate
    } catch (err) {
      console.error('[waitlist] supabase error:', err.message);
    }
  }

  // Always attempt Formspree if configured
  if (process.env.FORMSPREE_WAITLIST) {
    try {
      await fetch(`https://formspree.io/f/${process.env.FORMSPREE_WAITLIST}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ name, email, company }),
      });
    } catch (_) {}
  }

  return res.json({ ok: true });
});

app.post('/api/leads/partner', async (req, res) => {
  const data = req.body;
  if (!data.email) return res.status(400).json({ error: 'email is required' });

  if (supabase) {
    try {
      await supabase.from('partner_applications').insert({
        company:       data.company,
        contact_name:  data.name,
        email:         data.email,
        portal_url:    data.portal,
        products:      data.products ? [data.products] : [],
        brand_color:   data.brandColor,
        isv_volume:    data.isvCount,
        plan_interest: data.plan,
      });
    } catch (err) {
      console.error('[partner] supabase error:', err.message);
    }
  }

  if (process.env.FORMSPREE_PARTNER) {
    try {
      await fetch(`https://formspree.io/f/${process.env.FORMSPREE_PARTNER}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(data),
      });
    } catch (_) {}
  }

  return res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════
//  WEBHOOK — receives and verifies integration webhooks
// ══════════════════════════════════════════════════════════════
app.post('/api/webhook/:integrationId', express.raw({ type: '*/*' }), (req, res) => {
  const sig    = req.headers['x-webhook-signature'] || '';
  const secret = process.env.WEBHOOK_SECRET || '';

  if (secret) {
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.body).digest('hex');
    const sigBuf   = Buffer.from(sig.padEnd(128, '0').slice(0, 128));
    const expBuf   = Buffer.from(expected.padEnd(128, '0').slice(0, 128));
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  let payload;
  try { payload = JSON.parse(req.body.toString()); }
  catch (_) { return res.status(400).json({ error: 'Invalid JSON' }); }

  console.log('[webhook]', req.params.integrationId, payload.type, payload.data?.id);

  // Store in Supabase if configured
  if (supabase) {
    supabase.from('integration_runs').insert({
      org_id: req.params.integrationId,
      status: payload.type,
    }).catch(err => console.error('[webhook] store error:', err.message));
  }

  return res.json({ received: true });
});

// ══════════════════════════════════════════════════════════════
//  ADMIN — protected stats endpoint
// ══════════════════════════════════════════════════════════════
app.get('/api/admin/stats', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (key !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });

  if (!supabase) return res.json({ waitlist: 0, partners: 0, runs: 0 });

  try {
    const [wl, pa, ir] = await Promise.all([
      supabase.from('waitlist').select('id', { count: 'exact', head: true }),
      supabase.from('partner_applications').select('id', { count: 'exact', head: true }),
      supabase.from('integration_runs').select('id', { count: 'exact', head: true }),
    ]);
    return res.json({ waitlist: wl.count, partners: pa.count, runs: ir.count });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Helpers ────────────────────────────────────────────────────
async function ghFetch(url, headersOrOpts) {
  let opts;
  if (typeof headersOrOpts === 'object' && (headersOrOpts.method || headersOrOpts.body || headersOrOpts.headers)) {
    // Full options object passed
    opts = { ...headersOrOpts };
    if (!opts.headers) opts.headers = {};
  } else {
    // Plain headers object passed
    opts = { headers: headersOrOpts || {} };
  }
  if (!opts.headers['User-Agent']) opts.headers['User-Agent'] = 'IntegrAI/1.0';
  return fetch(url, opts);
}

// ── Start ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`IntegrAI server running on 0.0.0.0:${PORT}`);
  console.log(`Anthropic key: ${process.env.ANTHROPIC_KEY ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`Supabase: ${supabase ? 'configured' : 'not configured (optional)'}`);
  console.log(`CORS: open to all origins`);
});
