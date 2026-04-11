import { Env } from './types';
import { runAIJSON } from './ai';

const BUILD_PROMPT = `You are an expert Cloudflare Workers developer. Given a project idea, generate a COMPLETE working project in a single response.

Output JSON with this exact schema:
{
  "name": "project-name",
  "description": "What it does",
  "needs_d1": true,
  "d1_name": "project-db",
  "needs_r2": false,
  "r2_name": "",
  "files": {
    "wrangler.toml": "full file content here",
    "src/index.ts": "full file content here",
    "schema.sql": "full file content here (if needs_d1)",
    "package.json": "full file content here"
  },
  "routes": [
    {"method": "GET", "path": "/", "description": "Main page"}
  ],
  "deploy_steps": ["step 1", "step 2"]
}

Rules:
- Use TypeScript for src/ files
- Use raw Request/Response for routing (no frameworks)
- Include CORS headers on API routes
- For HTML pages, include complete inline CSS and JS (dark theme, modern design)
- wrangler.toml: use compatibility_date "2026-04-04", include [ai] binding if using AI
- package.json: include wrangler and @cloudflare/workers-types
- Make it production-ready but minimal
- Generate ALL files in the "files" object — every file needed to deploy
- File contents must be complete, working code — not pseudocode`;

interface BuildResult {
  project_slug: string;
  name: string;
  description: string;
  files_generated: string[];
  r2_prefix: string;
  status: 'complete' | 'partial';
  deploy_ready: boolean;
  routes: { method: string; path: string; description: string }[];
}

export async function buildFromSpark(
  env: Env,
  sparkSlug: string
): Promise<BuildResult> {
  // Read the spark plan page
  const obj = await env.STORAGE.get(`wiki/${sparkSlug}.md`);
  if (!obj) throw new Error('Spark page not found: ' + sparkSlug);
  const sparkContent = await obj.text();

  // Single Gemma call to generate everything
  let result: any;
  const anthropicKey = (env as any).ANTHROPIC_API_KEY;

  try {
    if (anthropicKey) {
      result = await callClaude(anthropicKey, sparkContent);
    } else {
      result = await runAIJSON<any>(
        env.AI,
        'code',
        BUILD_PROMPT,
        `Build this project:\n\n${sparkContent.slice(0, 8000)}`,
        8000
      );
    }
  } catch (buildErr: any) {
    console.log('BUILD_ERROR:', buildErr.message);
    // Return a partial result with the error
    return {
      project_slug: 'build-failed',
      name: 'Build Failed',
      description: `Build generation failed: ${buildErr.message}`,
      files_generated: [],
      r2_prefix: '',
      status: 'partial' as const,
      deploy_ready: false,
      routes: [],
    };
  }

  const projectSlug = (result.name || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const r2Prefix = `builds/${projectSlug}/`;
  const filesGenerated: string[] = [];

  // Store all generated files in R2
  const files = result.files || {};
  for (const [path, content] of Object.entries(files)) {
    if (typeof content === 'string' && content.length > 0) {
      await env.STORAGE.put(r2Prefix + path, content as string);
      filesGenerated.push(path);
    }
  }

  // Generate deploy script
  const deployScript = `#!/bin/bash
set -e
echo "Deploying ${result.name || projectSlug}..."
${result.needs_d1 ? `echo "Creating D1: ${result.d1_name}"\nnpx wrangler d1 create ${result.d1_name}\necho "Update wrangler.toml with database_id, then run:"\necho "npx wrangler d1 execute ${result.d1_name} --remote --file=schema.sql"` : ''}
${result.needs_r2 ? `echo "Creating R2: ${result.r2_name}"\nnpx wrangler r2 bucket create ${result.r2_name}` : ''}
npm install
npx wrangler deploy
echo "Done!"
`;
  await env.STORAGE.put(r2Prefix + 'deploy.sh', deployScript);
  filesGenerated.push('deploy.sh');

  // README
  const routeLines = (result.routes || []).map((r: any) => '- `' + r.method + ' ' + r.path + '` — ' + r.description).join('\n');
  const engine = anthropicKey ? 'Claude' : 'Gemma 4';
  const readme = '# ' + (result.name || projectSlug) + '\n\n' + (result.description || '') +
    '\n\n## Deploy\n```bash\nbash deploy.sh\n```\n\n## Routes\n' + routeLines +
    '\n\n---\n*Auto-built by PKM Wiki using ' + engine + '*\n';
  await env.STORAGE.put(r2Prefix + 'README.md', readme);
  filesGenerated.push('README.md');

  // Save build record as wiki page
  const buildPageSlug = 'build-' + projectSlug;
  const fileLines = filesGenerated.map(f => '- `' + f + '`').join('\n');
  const buildContent = '# Build: ' + (result.name || projectSlug) + '\n\n' + (result.description || '') +
    '\n\n## Files Generated\n' + fileLines +
    '\n\n## Routes\n' + routeLines +
    '\n\n## Deploy\n```bash\nbash deploy.sh\n```\n\n---\n*Sparked from [[' + sparkSlug + ']]*';

  await env.STORAGE.put(`wiki/${buildPageSlug}.md`, buildContent);

  const existingBuild = await env.DB.prepare('SELECT id FROM pages WHERE slug = ?').bind(buildPageSlug).first();
  if (!existingBuild) {
    await env.DB.prepare(
      `INSERT INTO pages (id, title, slug, page_type, summary, tags, word_count, links_to, linked_from)
       VALUES (?, ?, ?, 'project', ?, ?, ?, ?, '[]')`
    ).bind(
      crypto.randomUUID(), `Build: ${result.name || projectSlug}`, buildPageSlug,
      result.description || '', JSON.stringify(['build', 'auto-generated']),
      buildContent.split(/\s+/).length, JSON.stringify([sparkSlug])
    ).run();
  }

  await env.DB.prepare(
    `INSERT INTO activity_log (action, details, pages_touched) VALUES ('build', ?, ?)`
  ).bind(
    JSON.stringify({ project: result.name, files: filesGenerated.length, engine: anthropicKey ? 'claude' : 'gemma' }),
    JSON.stringify([buildPageSlug])
  ).run();

  return {
    project_slug: projectSlug,
    name: result.name || projectSlug,
    description: result.description || '',
    files_generated: filesGenerated,
    r2_prefix: r2Prefix,
    status: filesGenerated.length >= 3 ? 'complete' : 'partial',
    deploy_ready: filesGenerated.includes('src/index.ts') && filesGenerated.includes('wrangler.toml'),
    routes: result.routes || [],
  };
}

async function callClaude(apiKey: string, sparkContent: string): Promise<any> {
  const { ANTHROPIC_API_URL } = await import('./ai-gateway');
  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16000,
      temperature: 0.2,
      system: BUILD_PROMPT + '\n\nIMPORTANT: Respond with ONLY valid JSON. No markdown fences. Start with { and end with }.',
      messages: [{ role: 'user', content: `Build this project:\n\n${sparkContent.slice(0, 12000)}` }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Claude API error: ${response.status} ${errText.slice(0, 200)}`);
  }

  const data = await response.json() as any;
  const text = data.content?.[0]?.text || '';

  if (!text) throw new Error('Claude returned empty response');

  // Extract JSON — use the same robust extractor from ai.ts
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  const firstBrace = cleaned.indexOf('{');
  if (firstBrace < 0) throw new Error('No JSON object found in Claude response');
  if (firstBrace > 0) cleaned = cleaned.slice(firstBrace);

  // Find matching closing brace (handle nested braces)
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    if (ch === '}') { depth--; if (depth === 0) { cleaned = cleaned.slice(0, i + 1); break; } }
  }

  // If still unclosed, try to close it
  if (depth > 0) {
    cleaned = cleaned.replace(/,\s*$/, '');
    while (depth > 0) { cleaned += '}'; depth--; }
  }

  return JSON.parse(cleaned);
}

export async function getBuildFiles(
  env: Env,
  projectSlug: string
): Promise<{ path: string; content: string }[]> {
  const prefix = `builds/${projectSlug}/`;
  const list = await env.STORAGE.list({ prefix });
  const files: { path: string; content: string }[] = [];

  for (const obj of list.objects) {
    const content = await env.STORAGE.get(obj.key);
    if (content) {
      files.push({
        path: obj.key.slice(prefix.length),
        content: await content.text(),
      });
    }
  }

  return files;
}
