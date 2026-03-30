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

  const a             = analysis;
  const repoFiles     = a._repoFiles || {};
  const renderTarget  = a.render_target || 'static-html';
  const widgetRoute   = a.widget_route  || '/integration';
  const entryPoint    = a.entry_point   || 'index.html';
  const apiSlug       = (a.api_name || 'integration').toLowerCase().replace(/\s+/g, '-');
  const compName      = (a.api_name || 'Integration').replace(/\s+/g, '');
  const creds         = Object.keys(credValues || {}).join(', ');

  // Build file list instruction based on render target
  const fileListMap = {
    'nextjs-app-router':
      `1. app${widgetRoute}/page.tsx — page component\n2. app/api${widgetRoute}/route.ts — GET+POST proxy\n3. app/api${widgetRoute}/webhook/route.ts — webhook with HMAC\n4. components/${compName}Widget.tsx — 'use client' UI\n5. package.json — MODIFIED full file\n6. INTEGRATION.md`,
    'nextjs-pages-router':
      `1. pages${widgetRoute}.tsx — page component\n2. pages/api/${apiSlug}/index.ts — GET+POST proxy\n3. pages/api/${apiSlug}/webhook.ts — webhook with HMAC\n4. components/${compName}Widget.tsx — UI component\n5. package.json — MODIFIED full file\n6. INTEGRATION.md`,
    'react-spa':
      `1. src/pages/${compName}Page.tsx — page component\n2. src/components/${compName}Widget.tsx — UI\n3. src/services/${apiSlug}.service.ts — API service\n4. ${entryPoint} — MODIFIED with new route\n5. package.json — MODIFIED full file\n6. INTEGRATION.md`,
    'static-html':
      `1. index.html — MODIFIED, widget injected before </body>\n2. integration-widget.js — CSP-safe vanilla JS widget at root\n3. api/integration/index.js — Vercel serverless function (exports default async handler)\n4. vercel.json — MUST set outputDirectory to "." and routes: [{"src":"^/api/(.*)","dest":"/api/$1"},{"src":"^/(.*)","dest":"/index.html"}]\n5. INTEGRATION.md`,
  };
  const fileList = fileListMap[renderTarget] ||
    `1. ${entryPoint} — MODIFIED\n2. integration-widget.js — CSP-safe vanilla JS\n3. api/integration/index.js — backend handler\n4. vercel.json — outputDirectory "." with api routing\n5. INTEGRATION.md`;

  const existingEntry = repoFiles[entryPoint] || '';
  const existingPkg   = repoFiles['package.json'] || '';

  const endpointDocs = (a.key_endpoints || []).map(e =>
    `${e.method} ${e.path} — ${e.purpose}` +
    (e.request_body && Object.keys(e.request_body).length ? `\n  Body: ${JSON.stringify(e.request_body)}` : '') +
    (e.response_key_fields ? `\n  Response fields: ${e.response_key_fields.join(', ')}` : '')
  ).join('\n');

  const systemPrompt = `You are a senior full-stack engineer. Generate complete, production-ready integration files. No TODOs, no stubs. Files must be native to the detected framework. For any frontend widget JS: use document.createElement() and DOM APIs only — no innerHTML, no eval(). Credentials always from process.env server-side. For static-html render target: ALWAYS include a vercel.json with outputDirectory set to "." and routes that send /api/* to serverless functions and everything else to index.html. The package.json for static sites must have build script "echo done" not a real build. CRITICAL: In package.json, ALWAYS use "latest" for ALL dependency versions — never use specific version numbers like "^2.0.0" as they may not exist. Use: "package-name": "latest". Respond ONLY with a valid JSON array, no markdown fences.`;

  const userPrompt = 'Generate a production-ready integration.\n\n' +
    'RENDER TARGET: ' + renderTarget + '\n' +
    'WIDGET ROUTE: ' + widgetRoute + '\n' +
    'ENTRY POINT: ' + entryPoint + ' — MUST be included modified\n\n' +
    'REPO: ' + (repo || '') + '\n' +
    'GOAL: ' + intent + '\n' +
    'STACK: ' + JSON.stringify(a.stack) + '\n' +
    'PATTERNS: ' + (a.existing_patterns || []).join(', ') + '\n\n' +
    'API: ' + (a.api_name || '') + '\n' +
    'BASE URL: ' + (a.api_base_url || '') + '\n' +
    'AUTH: ' + (a.auth_method || '') + '\n' +
    'CREDENTIALS (process.env only): ' + creds + '\n\n' +
    'KEY ENDPOINTS:\n' + endpointDocs + '\n\n' +
    'WEBHOOKS:\n' + (a.webhooks || []).map(w => w.event + ': ' + w.description).join('\n') + '\n\n' +
    'PACKAGES TO ADD: ' + (a.packages_to_add || []).map(p => p.name).join(', ') + '\n\n' +
    'EXISTING ' + entryPoint + ':\n' + existingEntry + '\n\n' +
    'EXISTING package.json:\n' + existingPkg + '\n\n' +
    'Files to generate:\n' + fileList + '\n\n' +
    'Requirements:\n' +
    '1. Widget UI matches the goal exactly: "' + intent + '"\n' +
    '2. Frontend calls your own backend — never the external API directly\n' +
    '3. Backend adds auth headers from process.env\n' +
    '4. Webhook verifies HMAC-SHA256\n' +
    '5. Modified files include COMPLETE content\n' +
    '6. No innerHTML, no eval — CSP-safe DOM APIs only\n\n' +
    'Return JSON: [{"path","content","description","is_new":true|false}]';

  try {
    // Stream the response for long generations
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

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
        res.write(`data: ${JSON.stringify({ type: 'progress', text: chunk.delta.text })}\n\n`);
      }
    }

    const raw = fullText.trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/i, '')
      .replace(/\s*```$/, '')
      .replace(/\\(?!["\\/bfnrtu])/g, '\\\\')  // fix unescaped backslashes
      .trim();

    let files;
    try {
      files = JSON.parse(raw);
    } catch (parseErr) {
      // Try to extract JSON array from anywhere in the text
      const match = raw.match(/\[[\s\S]*\]/);
      if (match) {
        try {
          files = JSON.parse(match[0]);
        } catch(e2) {
          // Last resort: try replacing bad backslashes in the match
          files = JSON.parse(match[0].replace(/\\(?!["\\/bfnrtu])/g, '\\\\'));
        }
      } else {
        throw new Error('Could not parse generated files: ' + parseErr.message);
      }
    }

    // Sanitize package.json files — replace hallucinated versions with "latest"
    files = files.map(f => {
      if (f.path === 'package.json' || f.path.endsWith('/package.json')) {
        try {
          const pkg = JSON.parse(f.content);
          ['dependencies', 'devDependencies', 'peerDependencies'].forEach(key => {
            if (pkg[key]) {
              Object.keys(pkg[key]).forEach(dep => {
                // Force "latest" for any obscure SDK that might be hallucinated
                const v = pkg[key][dep];
                if (typeof v === 'string' && v.match(/\^\d+\.\d+\.\d+/) && !['express','cors','helmet','dotenv','axios','node-fetch','stripe','twilio','sendgrid'].some(k => dep.includes(k))) {
                  pkg[key][dep] = 'latest';
                }
              });
            }
          });
          f = { ...f, content: JSON.stringify(pkg, null, 2) };
        } catch(e) { /* leave as-is if parse fails */ }
      }
      return f;
    });

    res.write(`data: ${JSON.stringify({ type: 'done', files })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[generate] error:', err.message);
    if (!res.headersSent) return res.status(500).json({ error: err.message });
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
    res.end();
  }
});

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
