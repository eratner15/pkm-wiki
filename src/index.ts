import { Env } from './types';
import { ingestSource, ingestBatch } from './ingest';
import { buildFromSpark, getBuildFiles } from './builder';
import { queryWiki } from './query';
import { lintWiki } from './lint';
import { searchSimilar, findSimilarPages, rebuildIndex, indexPage } from './vectorize';
import { getCachedPage, getCachedSearch, setCachedSearch, invalidatePage } from './kv-cache';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // --- Public API endpoints (no auth required) ---
    if (method === 'GET' && path === '/api/graph') {
      const pages = await env.DB.prepare(
        'SELECT slug, title, page_type, summary, links_to, linked_from FROM pages'
      ).all();
      const nodes: any[] = [];
      const edges: any[] = [];
      const slugSet = new Set<string>();
      for (const p of pages.results as any[]) {
        const linksTo = JSON.parse((p as any).links_to || '[]');
        const linkedFrom = JSON.parse((p as any).linked_from || '[]');
        slugSet.add((p as any).slug);
        nodes.push({ id: (p as any).slug, label: (p as any).title, type: (p as any).page_type, summary: ((p as any).summary || '').slice(0, 120), connections: linksTo.length + linkedFrom.length, outlinks: linksTo.length, backlinks: linkedFrom.length });
      }
      for (const p of pages.results as any[]) {
        const linksTo = JSON.parse((p as any).links_to || '[]');
        for (const target of linksTo) { if (slugSet.has(target)) edges.push({ source: (p as any).slug, target }); }
      }
      return json({ nodes, edges, total_nodes: nodes.length, total_edges: edges.length });
    }

    // --- Public: recompute-backlinks (temporary) ---
    if (method === 'POST' && path === '/api/recompute-backlinks') {
      const pages = await env.DB.prepare('SELECT slug, links_to FROM pages').all();
      const backlinks: Record<string, Set<string>> = {};
      const slugSet = new Set<string>();
      for (const p of pages.results as any[]) { slugSet.add(p.slug); backlinks[p.slug] = new Set(); }
      for (const p of pages.results as any[]) {
        const linksTo = JSON.parse((p as any).links_to || '[]');
        for (const target of linksTo) { if (slugSet.has(target) && backlinks[target]) backlinks[target].add((p as any).slug); }
      }
      let linksFixed = 0;
      for (const p of pages.results as any[]) {
        const obj = await env.STORAGE.get(`wiki/${(p as any).slug}.md`);
        if (!obj) continue;
        const content = await obj.text();
        const wikiLinks = (content.match(/\[\[([^\]]+)\]\]/g) || []).map((m: string) => m.slice(2, -2));
        const existingLinksTo: string[] = JSON.parse((p as any).links_to || '[]');
        const combined = [...new Set([...existingLinksTo, ...wikiLinks.filter((l: string) => slugSet.has(l))])];
        if (combined.length !== existingLinksTo.length) {
          await env.DB.prepare('UPDATE pages SET links_to = ? WHERE slug = ?').bind(JSON.stringify(combined), (p as any).slug).run();
          linksFixed++;
          for (const target of combined) { if (slugSet.has(target) && backlinks[target]) backlinks[target].add((p as any).slug); }
        }
      }
      let updated = 0;
      for (const [slug, fromSet] of Object.entries(backlinks)) {
        const arr = [...fromSet].sort();
        await env.DB.prepare('UPDATE pages SET linked_from = ? WHERE slug = ?').bind(JSON.stringify(arr), slug).run();
        updated++;
      }
      return json({ pages_updated: updated, links_fixed: linksFixed });
    }

    // --- Public: people scan + project radar (temporary for setup) ---
    if (method === 'POST' && path === '/api/people/scan') {
      const entities = await env.DB.prepare(
        `SELECT slug, title, tags FROM pages WHERE page_type = 'entity' AND (tags NOT LIKE '%person%' OR tags IS NULL)`
      ).all();
      const personPatterns = /^[A-Z][a-z]+ [A-Z][a-z]/;
      const companyWords = ['inc', 'corp', 'llc', 'fund', 'capital', 'group', 'partners', 'ventures', 'holdings', 'bank', 'financial', 'technologies', 'solutions', 'restaurant', 'club'];
      let tagged = 0;
      for (const p of entities.results as any[]) {
        const title = p.title || '';
        const slug = p.slug || '';
        const isCompany = companyWords.some(w => slug.includes(w) || title.toLowerCase().includes(w));
        const isPerson = personPatterns.test(title) && !isCompany;
        if (isPerson) {
          const tags: string[] = JSON.parse(p.tags || '[]');
          if (!tags.includes('person')) { tags.push('person'); await env.DB.prepare('UPDATE pages SET tags = ? WHERE slug = ?').bind(JSON.stringify(tags), slug).run(); tagged++; }
        }
      }
      return json({ scanned: entities.results.length, tagged });
    }

    if (method === 'GET' && path === '/api/projects/radar') {
      const projects = await env.DB.prepare(
        `SELECT slug, title, summary, tags, updated_at, links_to, linked_from FROM pages WHERE page_type = 'project' ORDER BY updated_at DESC`
      ).all();
      const now = Date.now();
      const radar = projects.results.map((p: any) => {
        const dsu = Math.floor((now - new Date(p.updated_at + 'Z').getTime()) / 86400000);
        const tags = JSON.parse(p.tags || '[]');
        let status = 'active'; if (dsu > 30) status = 'stalled'; if (dsu > 90) status = 'archived';
        if (p.slug.startsWith('spark-') && !p.slug.startsWith('build-')) status = 'sparked';
        if (tags.includes('archived')) status = 'archived'; if (tags.includes('active')) status = 'active';
        return { slug: p.slug, title: p.title, summary: (p.summary || '').slice(0, 150), status, days_since_update: dsu, last_updated: p.updated_at, connections: JSON.parse(p.linked_from || '[]').length + JSON.parse(p.links_to || '[]').length };
      });
      const counts: any = { active: 0, stalled: 0, sparked: 0, archived: 0 };
      radar.forEach((p: any) => { counts[p.status] = (counts[p.status] || 0) + 1; });
      return json({ counts, projects: radar });
    }

    if (method === 'GET' && path === '/api/people') {
      const people = await env.DB.prepare(
        `SELECT slug, title, summary, tags, updated_at, linked_from, links_to FROM pages WHERE page_type = 'entity' AND tags LIKE '%person%' ORDER BY updated_at ASC`
      ).all();
      const results = people.results.map((p: any) => {
        const dsu = Math.floor((Date.now() - new Date(p.updated_at + 'Z').getTime()) / 86400000);
        return { slug: p.slug, title: p.title, summary: (p.summary || '').slice(0, 150), last_updated: p.updated_at, days_since_update: dsu, connections: JSON.parse(p.linked_from || '[]').length + JSON.parse(p.links_to || '[]').length, needs_followup: dsu > 30 };
      });
      return json({ total: results.length, needs_followup: results.filter((p: any) => p.needs_followup).length, people: results });
    }

    // --- Public: Telegram webhook (must be before auth) ---
    if (method === 'POST' && path === '/api/telegram/webhook') {
      try {
        const update = await request.json() as any;
        const message = update.message;
        if (!message || !message.text) return json({ ok: true });
        const chatId = message.chat.id;
        const text = message.text.trim();
        const username = message.from?.username || message.from?.first_name || 'unknown';
        const allowedChat = (env as any).TELEGRAM_CHAT_ID;
        if (allowedChat && String(chatId) !== String(allowedChat)) return json({ ok: true });
        const botToken = (env as any).TELEGRAM_BOT_TOKEN;
        if (!botToken) return json({ ok: true });

        const isURL = /^https?:\/\//.test(text);
        const isQuestion = /\?\s*$/.test(text);
        let replyText = '';

        if (text === '/start') {
          replyText = 'PKM Wiki Bot ready.\n\nSend me:\n- A URL to ingest\n- A thought to capture\n- A question? to query your wiki\n- /briefing for morning briefing\n- /stats for wiki stats';
        } else if (text === '/briefing') {
          const stats = await env.DB.prepare('SELECT COUNT(*) as count FROM pages').first();
          const recent = await env.DB.prepare('SELECT title FROM pages ORDER BY updated_at DESC LIMIT 3').all();
          const stale = await env.DB.prepare(`SELECT title FROM pages WHERE updated_at < datetime('now','-30 days') AND json_array_length(COALESCE(linked_from,'[]')) >= 3 ORDER BY json_array_length(COALESCE(linked_from,'[]')) DESC LIMIT 3`).all();
          replyText = `Your wiki has ${(stats as any)?.count || 0} pages.\n\nRecently updated:\n${recent.results.map((p:any) => '- ' + p.title).join('\n')}\n\nNeeds attention:\n${stale.results.map((p:any) => '- ' + p.title).join('\n') || 'All good!'}`;
        } else if (text === '/stats') {
          const pages = await env.DB.prepare('SELECT COUNT(*) as count FROM pages').first();
          const sources = await env.DB.prepare('SELECT COUNT(*) as count FROM sources').first();
          const orphans = await env.DB.prepare(`SELECT COUNT(*) as count FROM pages WHERE linked_from = '[]'`).first();
          replyText = `Wiki Stats:\n- ${(pages as any)?.count} pages\n- ${(sources as any)?.count} sources\n- ${(orphans as any)?.count} orphan pages`;
        } else if (isQuestion) {
          const fts = await env.DB.prepare(`SELECT slug, title, summary FROM pages WHERE slug IN (SELECT slug FROM pages_fts WHERE pages_fts MATCH ?) LIMIT 5`).bind(text.replace(/[?'"]/g, '')).all();
          if (fts.results.length === 0) { replyText = 'No matching pages found.'; }
          else {
            const context = [];
            for (const p of fts.results as any[]) {
              const obj = await env.STORAGE.get(`wiki/${p.slug}.md`);
              context.push(`## ${p.title}\n${obj ? (await obj.text()).slice(0,1000) : p.summary || ''}`);
            }
            try {
              const { runAIJSON } = await import('./ai');
              const { QUERY_PROMPT } = await import('./prompts');
              const answer = await runAIJSON<any>(env.AI, 'query', QUERY_PROMPT, `Question: ${text}\n\nContext:\n${context.join('\n\n')}`, 2000);
              replyText = (answer.answer || 'Could not answer.').slice(0,4000);
            } catch { replyText = `Found: ${fts.results.map((p:any) => p.title).join(', ')}. Check pkm.cafecito-ai.com`; }
          }
        } else if (isURL) {
          try {
            const res = await fetch(text, { headers: { 'User-Agent': 'PKM-Wiki/1.0' }, redirect: 'follow' });
            const html = await res.text();
            const cleaned = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,30000);
            const urlObj = new URL(text);
            const filename = (urlObj.hostname + urlObj.pathname).replace(/[^a-z0-9]+/gi,'-').slice(0,60) + '.md';
            const { ingestSource } = await import('./ingest');
            const result = await ingestSource(env, filename, `# ${text}\n\n${cleaned}`, 'url');
            replyText = `Ingested! Created ${result.pages_created.length} pages, updated ${result.pages_updated.length}.${result.pages_created.length > 0 ? '\n' + result.pages_created.map(s => '- ' + s).join('\n') : ''}`;
          } catch (e:any) { replyText = 'Failed to ingest: ' + e.message; }
        } else {
          const { ingestSource } = await import('./ingest');
          const result = await ingestSource(env, `telegram-${Date.now()}.md`, `# Telegram Note\n\nFrom: ${username}\nDate: ${new Date().toISOString()}\n\n${text}`, 'note');
          replyText = result.pages_created.length > 0 ? 'Captured: ' + result.pages_created.join(', ') : result.pages_updated.length > 0 ? 'Updated: ' + result.pages_updated.join(', ') : 'Saved as source.';
        }

        if (replyText) {
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: replyText }),
          });
        }
      } catch (e:any) { console.log('TELEGRAM_ERROR:', e.message); }
      return json({ ok: true });
    }

    // --- Auth: password gate ---
    if (env.PKM_PASSWORD) {
      // Allow bearer token auth for API imports
      const authHeader = request.headers.get('Authorization') || '';
      const bearerToken = authHeader.replace('Bearer ', '');
      const hasBearerAuth = bearerToken === env.PKM_PASSWORD;

      if (!hasBearerAuth) {
        // Login endpoint
        if (method === 'POST' && path === '/api/login') {
          const body = await request.json() as any;
          if (body.password === env.PKM_PASSWORD) {
            const token = await generateToken(env.PKM_PASSWORD);
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: {
                'Content-Type': 'application/json',
                'Set-Cookie': `pkm_auth=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`,
                ...CORS_HEADERS,
              },
            });
          }
          return error('Wrong password', 401);
        }

        // Check auth cookie on all other routes
        const cookies = request.headers.get('Cookie') || '';
        const authMatch = cookies.match(/pkm_auth=([^;]+)/);
        const token = authMatch?.[1];
        const validToken = await generateToken(env.PKM_PASSWORD);

        if (token !== validToken) {
          // Show login page for GET /, redirect API calls
          if (method === 'GET' && (path === '/' || path === '/pkm/' || path === '/pkm')) {
            return new Response(loginPageHTML(), {
              status: 401,
              headers: { 'Content-Type': 'text/html' },
            });
          }
          return error('Unauthorized', 401);
        }
      }
    }

    try {
      // --- API Routes ---

      // POST /api/ingest
      if (method === 'POST' && path === '/api/ingest') {
        const body = await request.json() as any;
        const { filename, content, source_type } = body;

        if (!filename || !content) {
          return error('filename and content are required');
        }

        const result = await ingestSource(
          env,
          filename,
          content,
          source_type || 'note'
        );

        // Index newly created pages in vectorize
        for (const slug of result.pages_created || []) {
          const page = await env.DB.prepare('SELECT id, title, summary, tags FROM pages WHERE slug = ?').bind(slug).first();
          if (page) {
            const parsedTags = (() => { try { return JSON.parse((page as any).tags || '[]'); } catch { return []; } })();
            await indexPage(env, (page as any).id, (page as any).title, (page as any).summary || '', parsedTags);
          }
        }

        return json(result);
      }

      // POST /api/ingest/batch
      if (method === 'POST' && path === '/api/ingest/batch') {
        const body = await request.json() as any;
        const { sources } = body;

        if (!Array.isArray(sources) || sources.length === 0) {
          return error('sources array is required');
        }

        const results = await ingestBatch(env, sources);
        return json({ results });
      }

      // POST /api/spark — generate a build plan from content or wiki page
      if (method === 'POST' && path === '/api/spark') {
        const { runAIJSON } = await import('./ai');
        const { SPARK_PROMPT } = await import('./prompts');
        const body = await request.json() as any;
        let sourceContent = '';
        let sourceTitle = '';

        if (body.slug) {
          // Spark from existing wiki page
          const page = await env.DB.prepare('SELECT title, slug FROM pages WHERE slug = ?').bind(body.slug).first();
          if (!page) return error('Page not found', 404);
          const obj = await env.STORAGE.get(`wiki/${body.slug}.md`);
          sourceContent = obj ? await obj.text() : '';
          sourceTitle = page.title as string;
        } else if (body.content) {
          // Spark from raw content (tweet, idea, etc.)
          sourceContent = body.content;
          sourceTitle = body.title || 'Spark Input';
        } else if (body.url) {
          // Spark from URL — fetch first
          try {
            const res = await fetch(body.url, {
              headers: { 'User-Agent': 'PKM-Wiki/1.0' },
              redirect: 'follow',
            });
            const html = await res.text();
            sourceContent = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30000);
            sourceTitle = body.url;
          } catch { return error('Failed to fetch URL'); }
        } else {
          return error('Provide slug, content, or url');
        }

        // Generate build plan with Nemotron
        const plan = await runAIJSON<any>(
          env.AI,
          'spark',
          SPARK_PROMPT,
          `Source: "${sourceTitle}"\n\n${sourceContent}`,
          8000
        );

        // Save the build plan as a wiki page
        const planSlug = 'spark-' + (plan.slug || sourceTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50));
        const planContent = `# Spark: ${plan.name || sourceTitle}\n\n` +
          `> ${plan.summary || ''}\n\n` +
          `## Why\n${plan.why || ''}\n\n` +
          `## Stack\n${(plan.stack || []).map((s: string) => '- ' + s).join('\n')}\n\n` +
          `## MVP\n${plan.mvp || ''}\n\n` +
          `## Build Steps\n${(plan.steps || []).map((s: any) => `${s.step}. **${s.action}** — ${s.details}`).join('\n')}\n\n` +
          `## Claude Code Prompt\n\`\`\`\n${plan.claude_prompt || ''}\n\`\`\`\n\n` +
          `---\n*Sparked from: ${sourceTitle}*`;

        // Store in R2 + D1
        await env.STORAGE.put(`wiki/${planSlug}.md`, planContent);
        const existing = await env.DB.prepare('SELECT id FROM pages WHERE slug = ?').bind(planSlug).first();
        if (existing) {
          await env.DB.prepare(
            `UPDATE pages SET summary = ?, tags = ?, word_count = ?, updated_at = datetime('now') WHERE slug = ?`
          ).bind(plan.summary || '', JSON.stringify(['spark', 'build-plan']), planContent.split(/\s+/).length, planSlug).run();
        } else {
          await env.DB.prepare(
            `INSERT INTO pages (id, title, slug, page_type, summary, tags, word_count, links_to, linked_from)
             VALUES (?, ?, ?, 'project', ?, ?, ?, '[]', '[]')`
          ).bind(crypto.randomUUID(), `Spark: ${plan.name || sourceTitle}`, planSlug,
            plan.summary || '', JSON.stringify(['spark', 'build-plan']),
            planContent.split(/\s+/).length).run();
        }

        // Log
        await env.DB.prepare(
          `INSERT INTO activity_log (action, details, pages_touched) VALUES ('spark', ?, ?)`
        ).bind(JSON.stringify({ source: sourceTitle, plan_slug: planSlug }), JSON.stringify([planSlug])).run();

        return json({
          plan_slug: planSlug,
          name: plan.name,
          summary: plan.summary,
          mvp: plan.mvp,
          steps: plan.steps,
          claude_prompt: plan.claude_prompt,
          stack: plan.stack,
        });
      }

      // POST /api/ideas — generate ideas from wiki connections
      if (method === 'POST' && path === '/api/ideas') {
        const { runAIJSON } = await import('./ai');
        const { IDEAS_PROMPT } = await import('./prompts');
        const body = await request.json() as any;
        const exclude = body.exclude || [];

        // Get pages with backlink counts, prioritizing most connected
        // Limit to 15 to keep prompt size manageable for Gemma rate limits
        const pagesResult = await env.DB.prepare(
          `SELECT slug, title, summary, page_type, tags, links_to, linked_from
           FROM pages ORDER BY
           json_array_length(COALESCE(linked_from, '[]')) DESC
           LIMIT 15`
        ).all();

        const pages = pagesResult.results.map((p: any) => ({
          slug: p.slug,
          title: p.title,
          summary: p.summary,
          page_type: p.page_type,
          tags: JSON.parse(p.tags || '[]'),
          links_to: JSON.parse(p.links_to || '[]'),
          linked_from: JSON.parse(p.linked_from || '[]'),
        }));

        if (pages.length < 3) {
          return error('Need at least 3 wiki pages to generate ideas');
        }

        // Find second-order connections (friends-of-friends)
        const slugToPage: Record<string, any> = {};
        pages.forEach((p: any) => { slugToPage[p.slug] = p; });

        const secondOrder: any[] = [];
        for (const p of pages) {
          for (const linked of p.links_to) {
            const bridgePage = slugToPage[linked];
            if (!bridgePage) continue;
            for (const friendOfFriend of bridgePage.links_to) {
              if (friendOfFriend !== p.slug && slugToPage[friendOfFriend] && !p.links_to.includes(friendOfFriend)) {
                secondOrder.push({
                  from: p.slug,
                  to: friendOfFriend,
                  via: linked,
                  fromTitle: p.title,
                  toTitle: slugToPage[friendOfFriend]?.title || friendOfFriend,
                  viaTitle: bridgePage.title,
                });
              }
            }
          }
        }

        // Deduplicate second-order connections
        const seen = new Set<string>();
        const uniqueConnections = secondOrder.filter((c: any) => {
          const key = [c.from, c.to].sort().join('|');
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }).slice(0, 10);

        // Build context for Gemma
        const pageContext = pages.map((p: any) =>
          `- **${p.title}** [${p.page_type}]: ${(p.summary || '').slice(0, 100)} | Tags: ${p.tags.slice(0, 3).join(', ')} | ${p.linked_from.length} backlinks`
        ).join('\n');

        const connectionContext = uniqueConnections.length > 0
          ? '\n\nSecond-order connections found:\n' + uniqueConnections.map((c: any) =>
            `- "${c.fromTitle}" connects to "${c.toTitle}" via "${c.viaTitle}"`
          ).join('\n')
          : '';

        const excludeNote = exclude.length > 0
          ? `\n\nDo NOT generate ideas with these titles (already seen): ${exclude.join(', ')}`
          : '';

        const userPrompt = `Here are the wiki pages in this knowledge base:\n\n${pageContext}${connectionContext}${excludeNote}\n\nGenerate 3 creative, actionable ideas that combine insights from different domains in this wiki. Focus on non-obvious connections.`;

        const result = await runAIJSON<any>(env.AI, 'ideas', IDEAS_PROMPT, userPrompt, 6000);

        // Log
        await env.DB.prepare(
          `INSERT INTO activity_log (action, details, pages_touched) VALUES ('ideas', ?, ?)`
        ).bind(
          JSON.stringify({ ideas_count: (result.ideas || []).length }),
          JSON.stringify((result.ideas || []).flatMap((i: any) => i.inspiration || []))
        ).run();

        return json({
          ideas: result.ideas || [],
          connections_found: result.connections_found || uniqueConnections.map((c: any) => ({
            from: c.from,
            to: c.to,
            via: c.via,
            insight: `"${c.fromTitle}" and "${c.toTitle}" are connected through "${c.viaTitle}"`
          })),
        });
      }

      // POST /api/ideas/refresh — just an alias for /api/ideas with exclude
      // (handled by the /api/ideas endpoint above — client sends exclude list directly to /api/ideas)

      // POST /api/ideas/expand — expand an idea into a full spark plan
      if (method === 'POST' && path === '/api/ideas/expand') {
        const { runAIJSON } = await import('./ai');
        const { SPARK_PROMPT } = await import('./prompts');
        const body = await request.json() as any;
        const { idea } = body;

        if (!idea) return error('idea object is required');

        const sourceContent = `# Idea: ${idea.title}\n\n${idea.tagline}\n\n${idea.description}\n\n` +
          `## Second-Order Connection\n${idea.second_order_connection}\n\n` +
          `## Inspiration\nInspired by wiki pages: ${(idea.inspiration || []).join(', ')}\n\n` +
          `## First Step\n${idea.first_step}`;

        const plan = await runAIJSON<any>(env.AI, 'spark', SPARK_PROMPT, `Source: "${idea.title}"\n\n${sourceContent}`, 8000);

        // Save as wiki page
        const planSlug = 'spark-' + (plan.slug || idea.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50));
        const planContent = `# Spark: ${plan.name || idea.title}\n\n` +
          `> ${plan.summary || idea.tagline}\n\n` +
          `## Why\n${plan.why || idea.description}\n\n` +
          `## Stack\n${(plan.stack || []).map((s: string) => '- ' + s).join('\n')}\n\n` +
          `## MVP\n${plan.mvp || ''}\n\n` +
          `## Build Steps\n${(plan.steps || []).map((s: any) => `${s.step}. **${s.action}** — ${s.details}`).join('\n')}\n\n` +
          `## Claude Code Prompt\n\`\`\`\n${plan.claude_prompt || ''}\n\`\`\`\n\n` +
          `---\n*Sparked from Ideas Lab: ${idea.title}*\n*Inspired by: ${(idea.inspiration || []).join(', ')}*`;

        await env.STORAGE.put(`wiki/${planSlug}.md`, planContent);
        const existing = await env.DB.prepare('SELECT id FROM pages WHERE slug = ?').bind(planSlug).first();
        if (existing) {
          await env.DB.prepare(
            `UPDATE pages SET summary = ?, tags = ?, word_count = ?, updated_at = datetime('now') WHERE slug = ?`
          ).bind(plan.summary || '', JSON.stringify(['spark', 'ideas-lab']), planContent.split(/\s+/).length, planSlug).run();
        } else {
          await env.DB.prepare(
            `INSERT INTO pages (id, title, slug, page_type, summary, tags, word_count, links_to, linked_from)
             VALUES (?, ?, ?, 'project', ?, ?, ?, '[]', '[]')`
          ).bind(crypto.randomUUID(), `Spark: ${plan.name || idea.title}`, planSlug,
            plan.summary || '', JSON.stringify(['spark', 'ideas-lab']),
            planContent.split(/\s+/).length).run();
        }

        await env.DB.prepare(
          `INSERT INTO activity_log (action, details, pages_touched) VALUES ('spark', ?, ?)`
        ).bind(JSON.stringify({ source: idea.title, plan_slug: planSlug, from_ideas_lab: true }), JSON.stringify([planSlug])).run();

        return json({
          plan_slug: planSlug,
          name: plan.name,
          summary: plan.summary,
          mvp: plan.mvp,
          steps: plan.steps,
          claude_prompt: plan.claude_prompt,
          stack: plan.stack,
        });
      }

      // POST /api/build — auto-build a project from a spark plan
      if (method === 'POST' && path === '/api/build') {
        const body = await request.json() as any;
        const { spark_slug } = body;
        if (!spark_slug) return error('spark_slug is required');

        const result = await buildFromSpark(env, spark_slug);
        return json(result);
      }

      // GET /api/build/:project — get generated files for a build
      if (method === 'GET' && path.startsWith('/api/build/')) {
        const projectSlug = path.replace('/api/build/', '');
        if (!projectSlug) return error('project slug is required');

        const files = await getBuildFiles(env, projectSlug);
        return json({ project: projectSlug, files });
      }

      // POST /api/ingest/url — fetch a URL and ingest its content
      if (method === 'POST' && path === '/api/ingest/url') {
        const body = await request.json() as any;
        const { url } = body;
        if (!url) return error('url is required');

        try {
          // Fetch the URL content
          const res = await fetch(url, {
            headers: { 'User-Agent': 'PKM-Wiki/1.0 (knowledge-base)' },
            redirect: 'follow',
          });
          if (!res.ok) return error(`Failed to fetch URL: ${res.status}`, 502);

          const html = await res.text();

          // Extract text content from HTML (strip tags)
          let text = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 50000); // Cap at 50KB

          // Browser Rendering fallback — if basic fetch returned minimal content (JS-heavy sites)
          if (text.length < 200 && env.BROWSER) {
            try {
              const puppeteer = await import('@cloudflare/puppeteer');
              const browser = await (puppeteer as any).default.launch(env.BROWSER);
              const page = await browser.newPage();
              await page.goto(url, { waitUntil: 'networkidle0', timeout: 15000 });
              const renderedHtml = await page.content();
              await browser.close();
              text = renderedHtml
                .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 50000);
            } catch (browserErr: any) {
              console.warn('Browser rendering fallback failed:', browserErr.message);
              // Continue with basic fetch result
            }
          }

          if (text.length < 50) return error('URL returned no meaningful content');

          // Determine source type from URL
          let sourceType = 'url';
          if (url.includes('twitter.com') || url.includes('x.com')) sourceType = 'tweet';
          else if (url.includes('github.com')) sourceType = 'document';
          else if (url.includes('reddit.com')) sourceType = 'note';

          // Build a filename from the URL
          const urlObj = new URL(url);
          const filename = (urlObj.hostname + urlObj.pathname)
            .replace(/[^a-z0-9]+/gi, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 80) + '.md';

          const content = `# ${url}\n\nSource: ${url}\nFetched: ${new Date().toISOString()}\n\n${text}`;

          const result = await ingestSource(env, filename, content, sourceType);
          return json(result);
        } catch (err: any) {
          return error(`URL fetch failed: ${err.message}`, 502);
        }
      }

      // POST /api/query
      if (method === 'POST' && path === '/api/query') {
        const body = await request.json() as any;
        const { question } = body;

        if (!question) {
          return error('question is required');
        }

        const result = await queryWiki(env, question);
        return json(result);
      }

      // POST /api/lint
      if (method === 'POST' && path === '/api/lint') {
        const result = await lintWiki(env);
        return json(result);
      }

      // GET /api/search?q= — full-text search over wiki
      if (method === 'GET' && path === '/api/search') {
        const q = url.searchParams.get('q');
        if (!q) return error('q parameter required');
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 50);

        // Check KV cache first
        const cachedResult = await getCachedSearch(env, `fts:${q}:${limit}`);
        if (cachedResult) return json(cachedResult);

        // FTS search
        let ftsResults: any = { results: [] };
        try {
          ftsResults = await env.DB.prepare(
            `SELECT p.slug, p.title, p.page_type, p.summary, p.tags, p.word_count,
                    json_array_length(COALESCE(p.linked_from, '[]')) as backlinks
             FROM pages_fts fts JOIN pages p ON fts.rowid = p.rowid
             WHERE pages_fts MATCH ? ORDER BY rank LIMIT ?`
          ).bind(q, limit).all();
        } catch {
          // FTS table may not exist; fallback to LIKE
          ftsResults = await env.DB.prepare(
            `SELECT slug, title, page_type, summary, tags, word_count,
                    json_array_length(COALESCE(linked_from, '[]')) as backlinks
             FROM pages WHERE title LIKE ? OR summary LIKE ? OR slug LIKE ?
             ORDER BY json_array_length(COALESCE(linked_from, '[]')) DESC LIMIT ?`
          ).bind(`%${q}%`, `%${q}%`, `%${q}%`, limit).all();
        }

        const searchResponse = {
          query: q,
          results: ftsResults.results.map((p: any) => ({
            slug: p.slug, title: p.title, type: p.page_type,
            summary: (p.summary || '').slice(0, 200),
            tags: JSON.parse(p.tags || '[]'),
            word_count: p.word_count, backlinks: p.backlinks,
          })),
          total: ftsResults.results.length,
        };

        // Cache the search results (5 min TTL)
        await setCachedSearch(env, `fts:${q}:${limit}`, searchResponse);

        return json(searchResponse);
      }

      // POST /api/compile — LLM-driven wiki maintenance (create index pages, fill gaps, enhance connections)
      if (method === 'POST' && path === '/api/compile') {
        const { runAIJSON } = await import('./ai');
        const { COMPILE_PROMPT } = await import('./prompts');

        // Get a batch of pages with content (focus on most connected)
        const pagesResult = await env.DB.prepare(
          `SELECT slug, title, page_type, summary, tags, links_to, linked_from, word_count
           FROM pages ORDER BY json_array_length(COALESCE(linked_from, '[]')) DESC LIMIT 40`
        ).all();

        // Fetch content for top 15 pages
        const pageContexts: string[] = [];
        for (const p of pagesResult.results.slice(0, 15) as any[]) {
          const obj = await env.STORAGE.get(`wiki/${p.slug}.md`);
          const content = obj ? (await obj.text()).slice(0, 2000) : '';
          pageContexts.push(`--- ${p.title} (${p.slug}, ${p.page_type}) ---\nSummary: ${p.summary}\nLinks to: ${JSON.parse(p.links_to || '[]').join(', ')}\nLinked from: ${JSON.parse(p.linked_from || '[]').join(', ')}\n\n${content}`);
        }

        // Add page list for context (all 40)
        const pageList = (pagesResult.results as any[]).map((p: any) =>
          `- [[${p.slug}]] (${p.title}, ${p.page_type}, ${p.word_count}w, ${JSON.parse(p.linked_from || '[]').length} backlinks)`
        ).join('\n');

        const compile = await runAIJSON<any>(
          env.AI,
          'research',
          COMPILE_PROMPT,
          `Wiki has ${pagesResult.results.length} pages total.\n\nAll pages:\n${pageList}\n\nDetailed content for top pages:\n\n${pageContexts.join('\n\n')}`,
          8000
        );

        // Apply: create index pages and missing pages
        let created = 0, linked = 0;
        const allNewPages = [...(compile.index_pages || []), ...(compile.missing_pages || [])];
        for (const p of allNewPages) {
          if (!p.slug || !p.content) continue;
          const existing = await env.DB.prepare('SELECT id FROM pages WHERE slug = ?').bind(p.slug).first();
          if (existing) continue; // Don't overwrite
          const pageId = crypto.randomUUID();
          const contentLinks = (p.content.match(/\[\[([^\]]+)\]\]/g) || []).map((m: string) => m.slice(2, -2));
          await env.STORAGE.put(`wiki/${p.slug}.md`, p.content);
          await env.DB.prepare(
            'INSERT INTO pages (id, title, slug, page_type, summary, tags, word_count, links_to, linked_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, \'[]\')'
          ).bind(pageId, p.title, p.slug, p.slug.startsWith('index-') ? 'index' : 'concept',
            p.summary || '', JSON.stringify(['compiled', 'auto-generated']),
            p.content.split(/\s+/).length, JSON.stringify(contentLinks)).run();
          created++;
        }

        // Apply: add new connections
        for (const conn of (compile.new_connections || []).slice(0, 10)) {
          if (!conn.from_slug || !conn.to_slug) continue;
          const page = await env.DB.prepare('SELECT links_to FROM pages WHERE slug = ?').bind(conn.from_slug).first();
          if (!page) continue;
          const linksTo: string[] = JSON.parse((page.links_to as string) || '[]');
          if (!linksTo.includes(conn.to_slug)) {
            linksTo.push(conn.to_slug);
            await env.DB.prepare('UPDATE pages SET links_to = ? WHERE slug = ?')
              .bind(JSON.stringify(linksTo), conn.from_slug).run();
            // Update backlinks
            const target = await env.DB.prepare('SELECT linked_from FROM pages WHERE slug = ?').bind(conn.to_slug).first();
            if (target) {
              const linkedFrom: string[] = JSON.parse((target.linked_from as string) || '[]');
              if (!linkedFrom.includes(conn.from_slug)) {
                linkedFrom.push(conn.from_slug);
                await env.DB.prepare('UPDATE pages SET linked_from = ? WHERE slug = ?')
                  .bind(JSON.stringify(linkedFrom), conn.to_slug).run();
              }
            }
            linked++;
          }
        }

        // Log
        await env.DB.prepare('INSERT INTO activity_log (action, details, pages_touched) VALUES (\'compile\', ?, \'[]\')')
          .bind(JSON.stringify({ pages_created: created, connections_added: linked, thin_pages: (compile.thin_pages || []).length, synthesis_candidates: (compile.synthesis_candidates || []).length })).run();

        return json({
          pages_created: created,
          connections_added: linked,
          index_pages: (compile.index_pages || []).map((p: any) => p.slug),
          missing_pages: (compile.missing_pages || []).map((p: any) => p.slug),
          new_connections: compile.new_connections || [],
          thin_pages: compile.thin_pages || [],
          synthesis_candidates: compile.synthesis_candidates || [],
        });
      }

      // GET /api/pages
      if (method === 'GET' && path === '/api/pages') {
        const q = url.searchParams.get('q');
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        const offset = parseInt(url.searchParams.get('offset') || '0', 10);

        let results;
        if (q) {
          results = await env.DB.prepare(
            `SELECT p.* FROM pages_fts fts
             JOIN pages p ON fts.rowid = p.rowid
             WHERE pages_fts MATCH ?
             ORDER BY rank
             LIMIT ? OFFSET ?`
          )
            .bind(q, limit, offset)
            .all();
        } else {
          results = await env.DB.prepare(
            'SELECT * FROM pages ORDER BY updated_at DESC LIMIT ? OFFSET ?'
          )
            .bind(limit, offset)
            .all();
        }

        // Parse JSON fields
        const pages = results.results.map(parsePageRow);
        return json({ pages, total: pages.length });
      }

      // GET /api/pages/:slug
      if (method === 'GET' && path.startsWith('/api/pages/')) {
        const slug = path.replace('/api/pages/', '');
        if (!slug) return error('slug is required');

        const page = await env.DB.prepare(
          'SELECT * FROM pages WHERE slug = ?'
        )
          .bind(slug)
          .first();

        if (!page) return error('Page not found', 404);

        // Fetch markdown content from R2
        const obj = await env.STORAGE.get(`wiki/${slug}.md`);
        const content = obj ? await obj.text() : '';

        return json({ ...parsePageRow(page), content });
      }

      // PUT /api/pages/:slug
      if (method === 'PUT' && path.startsWith('/api/pages/')) {
        const slug = path.replace('/api/pages/', '');
        if (!slug) return error('slug is required');

        const existing = await env.DB.prepare(
          'SELECT id FROM pages WHERE slug = ?'
        )
          .bind(slug)
          .first();

        if (!existing) return error('Page not found', 404);

        const body = await request.json() as any;
        const { content, title, summary, tags, page_type } = body;

        if (content !== undefined) {
          await env.STORAGE.put(`wiki/${slug}.md`, content);

          // Extract links
          const links = extractWikiLinks(content);
          const wordCount = content.split(/\s+/).filter(Boolean).length;

          await env.DB.prepare(
            `UPDATE pages SET word_count = ?, links_to = ?, updated_at = datetime('now') WHERE slug = ?`
          )
            .bind(wordCount, JSON.stringify(links), slug)
            .run();
        }

        if (title !== undefined) {
          await env.DB.prepare('UPDATE pages SET title = ? WHERE slug = ?')
            .bind(title, slug)
            .run();
        }
        if (summary !== undefined) {
          await env.DB.prepare('UPDATE pages SET summary = ? WHERE slug = ?')
            .bind(summary, slug)
            .run();
        }
        if (tags !== undefined) {
          await env.DB.prepare('UPDATE pages SET tags = ? WHERE slug = ?')
            .bind(JSON.stringify(tags), slug)
            .run();
        }
        if (page_type !== undefined) {
          await env.DB.prepare('UPDATE pages SET page_type = ? WHERE slug = ?')
            .bind(page_type, slug)
            .run();
        }

        // Update timestamp
        await env.DB.prepare(
          `UPDATE pages SET updated_at = datetime('now') WHERE slug = ?`
        )
          .bind(slug)
          .run();

        // Log edit
        await env.DB.prepare(
          `INSERT INTO activity_log (action, details, pages_touched)
           VALUES ('edit', ?, ?)`
        )
          .bind(
            JSON.stringify({ slug, manual: true }),
            JSON.stringify([slug])
          )
          .run();

        const updated = await env.DB.prepare(
          'SELECT * FROM pages WHERE slug = ?'
        )
          .bind(slug)
          .first();

        // Invalidate KV cache for this page
        await invalidatePage(env, slug);

        // Update vectorize index for this page
        if (updated) {
          const parsedTags = (() => { try { return JSON.parse((updated as any).tags || '[]'); } catch { return []; } })();
          await indexPage(env, (updated as any).id, (updated as any).title, (updated as any).summary || '', parsedTags);
        }

        return json(parsePageRow(updated!));
      }

      // DELETE /api/pages/:slug
      if (method === 'DELETE' && path.startsWith('/api/pages/')) {
        const slug = path.replace('/api/pages/', '');
        if (!slug) return error('slug is required');

        const existing = await env.DB.prepare(
          'SELECT id FROM pages WHERE slug = ?'
        )
          .bind(slug)
          .first();

        if (!existing) return error('Page not found', 404);

        // Delete from R2
        await env.STORAGE.delete(`wiki/${slug}.md`);

        // Delete from D1
        await env.DB.prepare('DELETE FROM pages WHERE slug = ?')
          .bind(slug)
          .run();

        // Log
        await env.DB.prepare(
          `INSERT INTO activity_log (action, details, pages_touched)
           VALUES ('edit', ?, ?)`
        )
          .bind(
            JSON.stringify({ slug, action: 'delete' }),
            JSON.stringify([slug])
          )
          .run();

        return json({ deleted: slug });
      }

      // GET /api/sources
      if (method === 'GET' && path === '/api/sources') {
        const results = await env.DB.prepare(
          'SELECT * FROM sources ORDER BY created_at DESC LIMIT 100'
        ).all();

        const sources = results.results.map((s: any) => ({
          ...s,
          ingested: Boolean(s.ingested),
          pages_updated: JSON.parse(s.pages_updated || '[]'),
        }));

        return json({ sources });
      }

      // GET /api/log
      if (method === 'GET' && path === '/api/log') {
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        const results = await env.DB.prepare(
          'SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?'
        )
          .bind(limit)
          .all();

        const log = results.results.map((l: any) => ({
          ...l,
          details: JSON.parse(l.details || '{}'),
          pages_touched: JSON.parse(l.pages_touched || '[]'),
        }));

        return json({ log });
      }

      // GET /api/stats
      if (method === 'GET' && path === '/api/stats') {
        const pageCount = await env.DB.prepare(
          'SELECT COUNT(*) as count FROM pages'
        ).first();
        const sourceCount = await env.DB.prepare(
          'SELECT COUNT(*) as count FROM sources'
        ).first();
        const lastIngest = await env.DB.prepare(
          "SELECT created_at FROM activity_log WHERE action = 'ingest' ORDER BY created_at DESC LIMIT 1"
        ).first();
        const totalWords = await env.DB.prepare(
          'SELECT SUM(word_count) as total FROM pages'
        ).first();
        const recentActivity = await env.DB.prepare(
          'SELECT COUNT(*) as count FROM activity_log WHERE created_at > datetime("now", "-7 days")'
        ).first();

        // Calculate a simple health score
        const orphans = await env.DB.prepare(
          `SELECT COUNT(*) as count FROM pages WHERE linked_from = '[]' OR linked_from IS NULL`
        ).first();

        const totalPages = (pageCount?.count as number) || 0;
        const orphanCount = (orphans?.count as number) || 0;
        const orphanRatio = totalPages > 0 ? orphanCount / totalPages : 0;
        const healthScore = Math.round(100 - orphanRatio * 30);

        return json({
          pages: totalPages,
          sources: (sourceCount?.count as number) || 0,
          total_words: (totalWords?.total as number) || 0,
          last_ingest: lastIngest?.created_at || null,
          recent_activity_7d: (recentActivity?.count as number) || 0,
          orphan_pages: orphanCount,
          health_score: Math.max(0, Math.min(100, healthScore)),
        });
      }

      // POST /api/recompute-backlinks — repair all linked_from fields
      if (method === 'POST' && path === '/api/recompute-backlinks') {
        const pages = await env.DB.prepare('SELECT slug, links_to FROM pages').all();
        const backlinks: Record<string, Set<string>> = {};
        const slugSet = new Set<string>();

        // Collect all slugs
        for (const p of pages.results as any[]) {
          slugSet.add(p.slug);
          backlinks[p.slug] = new Set();
        }

        // Build backlink map
        for (const p of pages.results as any[]) {
          const linksTo = JSON.parse(p.links_to || '[]');
          for (const target of linksTo) {
            if (slugSet.has(target) && backlinks[target]) {
              backlinks[target].add(p.slug);
            }
          }
        }

        // Also scan R2 content for [[wiki-links]] and add to links_to
        let linksFixed = 0;
        for (const p of pages.results as any[]) {
          const obj = await env.STORAGE.get(`wiki/${p.slug}.md`);
          if (!obj) continue;
          const content = await obj.text();
          const wikiLinks = (content.match(/\[\[([^\]]+)\]\]/g) || []).map((m: string) => m.slice(2, -2));
          const existingLinksTo: string[] = JSON.parse(p.links_to || '[]');
          const combined = [...new Set([...existingLinksTo, ...wikiLinks.filter((l: string) => slugSet.has(l))])];

          if (combined.length !== existingLinksTo.length) {
            await env.DB.prepare('UPDATE pages SET links_to = ? WHERE slug = ?')
              .bind(JSON.stringify(combined), p.slug).run();
            linksFixed++;
            // Update backlinks for new links
            for (const target of combined) {
              if (slugSet.has(target) && backlinks[target]) {
                backlinks[target].add(p.slug);
              }
            }
          }
        }

        // Write all backlinks
        let updated = 0;
        for (const [slug, fromSet] of Object.entries(backlinks)) {
          const arr = [...fromSet].sort();
          await env.DB.prepare('UPDATE pages SET linked_from = ? WHERE slug = ?')
            .bind(JSON.stringify(arr), slug).run();
          updated++;
        }

        return json({ pages_updated: updated, links_fixed: linksFixed });
      }

      // POST /api/flywheel — combined ingest + spark in one action
      if (method === 'POST' && path === '/api/flywheel') {
        const { runAIJSON } = await import('./ai');
        const { SPARK_PROMPT } = await import('./prompts');
        const body = await request.json() as any;
        let content = '';
        let title = '';

        // Step 1: Get content (from URL, text, or slug)
        if (body.url) {
          try {
            const res = await fetch(body.url, {
              headers: { 'User-Agent': 'PKM-Wiki/1.0' },
              redirect: 'follow',
            });
            const html = await res.text();
            content = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30000);
            title = body.url;
          } catch { return error('Failed to fetch URL'); }
        } else if (body.content) {
          content = body.content;
          title = body.title || 'Quick intake';
        } else {
          return error('Provide url or content');
        }

        if (content.length < 20) return error('Content too short');

        // Step 2: Ingest into wiki
        let ingestResult;
        try {
          const sourceType = body.url ? (body.url.includes('x.com') || body.url.includes('twitter.com') ? 'tweet' : 'url') : 'note';
          const filename = body.url
            ? new URL(body.url).hostname.replace(/[^a-z0-9]/gi, '-').slice(0, 40) + '-' + Date.now() + '.md'
            : 'intake-' + Date.now() + '.md';
          ingestResult = await ingestSource(env, filename, `# ${title}\n\n${content}`, sourceType);
        } catch (e: any) {
          ingestResult = { source_id: 'failed', pages_created: [], pages_updated: [], entities_extracted: 0 };
        }

        // Step 3: Spark — generate build plan
        let sparkResult = null;
        try {
          const plan = await runAIJSON<any>(
            env.AI,
            'spark',
            SPARK_PROMPT,
            `Source: "${title}"\n\n${content.slice(0, 10000)}`,
            8000
          );

          // Save spark page
          const planSlug = 'spark-' + (plan.slug || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40));
          const planContent = `# Spark: ${plan.name || title}\n\n> ${plan.summary || ''}\n\n## Why\n${plan.why || ''}\n\n## Stack\n${(plan.stack || []).map((s: string) => '- ' + s).join('\n')}\n\n## MVP\n${plan.mvp || ''}\n\n## Build Steps\n${(plan.steps || []).map((s: any) => `${s.step}. **${s.action}** — ${s.details}`).join('\n')}\n\n## Claude Code Prompt\n\`\`\`\n${plan.claude_prompt || ''}\n\`\`\`\n\n---\n*Sparked from: ${title}*`;

          await env.STORAGE.put(`wiki/${planSlug}.md`, planContent);
          const existing = await env.DB.prepare('SELECT id FROM pages WHERE slug = ?').bind(planSlug).first();
          if (!existing) {
            await env.DB.prepare(
              `INSERT INTO pages (id, title, slug, page_type, summary, tags, word_count, links_to, linked_from) VALUES (?, ?, ?, 'project', ?, ?, ?, '[]', '[]')`
            ).bind(crypto.randomUUID(), `Spark: ${plan.name || title}`, planSlug, plan.summary || '', JSON.stringify(['spark', 'build-plan']), planContent.split(/\s+/).length).run();
          }

          sparkResult = { plan_slug: planSlug, name: plan.name, summary: plan.summary, claude_prompt: plan.claude_prompt, steps: plan.steps };
        } catch {
          // Spark failed (rate limit likely) — that's ok, ingest still worked
        }

        return json({
          ingest: {
            entities: ingestResult.entities_extracted,
            pages_created: ingestResult.pages_created.length,
            pages_updated: ingestResult.pages_updated.length,
          },
          spark: sparkResult,
        });
      }

      // POST /api/research — unified ingest + synthesis (autoresearch-inspired)
      if (method === 'POST' && path === '/api/research') {
        const { runAIJSON } = await import('./ai');
        const { RESEARCH_PROMPT } = await import('./prompts');
        const body = await request.json() as any;
        let content = '';
        let title = '';

        // Step 1: Get content (from URL, text, or slug)
        if (body.url) {
          try {
            const res = await fetch(body.url, {
              headers: { 'User-Agent': 'PKM-Wiki/1.0' },
              redirect: 'follow',
            });
            const html = await res.text();
            content = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30000);
            title = body.url;
          } catch { return error('Failed to fetch URL'); }
        } else if (body.content) {
          content = body.content;
          title = body.title || 'Research input';
        } else if (body.slug) {
          const page = await env.DB.prepare('SELECT title, slug FROM pages WHERE slug = ?').bind(body.slug).first();
          if (!page) return error('Page not found', 404);
          const obj = await env.STORAGE.get(`wiki/${body.slug}.md`);
          content = obj ? await obj.text() : '';
          title = page.title as string;
        } else {
          return error('Provide url, content, or slug');
        }

        if (content.length < 20) return error('Content too short');

        // Step 2: Get existing pages for context
        const existingPages = await env.DB.prepare(
          'SELECT slug, title, page_type FROM pages LIMIT 300'
        ).all();
        const slugSet = new Set<string>(existingPages.results.map((p: any) => p.slug));
        const existingContext = existingPages.results.length > 0
          ? `\n\nExisting wiki pages (use these slugs for connections/links_to):\n${existingPages.results
              .map((p: any) => `- [[${p.slug}]] (${p.title}, ${p.page_type})`)
              .join('\n')}`
          : '';

        // Step 3: Run unified research prompt
        const sourceType = body.url ? (body.url.includes('x.com') || body.url.includes('twitter.com') ? 'tweet' : 'url') : 'note';
        let result: any;
        try {
          result = await runAIJSON<any>(
            env.AI,
            'research',
            RESEARCH_PROMPT + existingContext,
            `Source: "${title}" (type: ${sourceType})\n\n${content}`,
            8000
          );
        } catch (e: any) {
          return error('Research failed: ' + e.message, 500);
        }

        // Step 4: Process extracted entities (same as ingest)
        const pagesCreated: string[] = [];
        const pagesUpdated: string[] = [];
        const entities = Array.isArray(result.entities) ? result.entities : [];

        for (const entity of entities) {
          const slug = entity.slug || entity.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          const normalizedLinks = (entity.links_to || []).filter((l: string) => slugSet.has(l) || entities.some((e: any) => (e.slug || e.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')) === l));

          const existingPage = await env.DB.prepare('SELECT id FROM pages WHERE slug = ?').bind(slug).first();

          if (existingPage) {
            const existingContent = await env.STORAGE.get(`wiki/${slug}.md`);
            const existingText = existingContent ? await existingContent.text() : '';
            const { UPDATE_PROMPT } = await import('./prompts');
            let updated: any;
            try {
              updated = await runAIJSON<any>(env.AI, 'ingest', UPDATE_PROMPT, `Existing page (${slug}):\n\n${existingText}\n\nNew information:\n\n${entity.content}`);
            } catch {
              updated = { content: existingText + '\n\n---\n\n' + entity.content, summary: entity.summary || '', tags: entity.tags || [], links_to: normalizedLinks, changes: 'Appended' };
            }
            await env.STORAGE.put(`wiki/${slug}.md`, updated.content);
            const contentLinks = (updated.content.match(/\[\[([^\]]+)\]\]/g) || []).map((m: string) => m.slice(2, -2));
            const allLinks = [...new Set([...contentLinks, ...(updated.links_to || []).filter((l: string) => slugSet.has(l)), ...normalizedLinks])];
            await env.DB.prepare('UPDATE pages SET summary = ?, tags = ?, word_count = ?, links_to = ?, updated_at = datetime(\'now\') WHERE slug = ?')
              .bind(updated.summary, JSON.stringify(updated.tags), updated.content.split(/\s+/).length, JSON.stringify(allLinks), slug).run();
            pagesUpdated.push(slug);
          } else {
            const pageId = crypto.randomUUID();
            const pageContent = entity.content || '';
            const contentLinks = (pageContent.match(/\[\[([^\]]+)\]\]/g) || []).map((m: string) => m.slice(2, -2));
            const allLinks = [...new Set([...contentLinks, ...normalizedLinks])];
            await env.STORAGE.put(`wiki/${slug}.md`, pageContent);
            await env.DB.prepare('INSERT INTO pages (id, title, slug, page_type, summary, tags, word_count, links_to, linked_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, \'[]\')')
              .bind(pageId, entity.title, slug, entity.page_type || 'concept', entity.summary, JSON.stringify(entity.tags || []), pageContent.split(/\s+/).length, JSON.stringify(allLinks)).run();
            pagesCreated.push(slug);
            slugSet.add(slug);
          }
        }

        // Step 5: Update backlinks
        const allSlugs = [...pagesCreated, ...pagesUpdated];
        for (const slug of allSlugs) {
          const page = await env.DB.prepare('SELECT links_to FROM pages WHERE slug = ?').bind(slug).first();
          if (!page) continue;
          const linksTo: string[] = JSON.parse((page.links_to as string) || '[]');
          for (const targetSlug of linksTo) {
            const target = await env.DB.prepare('SELECT linked_from FROM pages WHERE slug = ?').bind(targetSlug).first();
            if (!target) continue;
            const linkedFrom: string[] = JSON.parse((target.linked_from as string) || '[]');
            if (!linkedFrom.includes(slug)) {
              linkedFrom.push(slug);
              await env.DB.prepare('UPDATE pages SET linked_from = ? WHERE slug = ?').bind(JSON.stringify(linkedFrom), targetSlug).run();
            }
          }
        }

        // Step 6: Store source
        const sourceId = crypto.randomUUID();
        const filename = body.url
          ? new URL(body.url).hostname.replace(/[^a-z0-9]/gi, '-').slice(0, 40) + '-' + Date.now() + '.md'
          : 'research-' + Date.now() + '.md';
        await env.STORAGE.put(`sources/${sourceId}/${filename}`, `# ${title}\n\n${content}`);
        const encoder = new TextEncoder();
        const hashData = encoder.encode(content);
        const hashBuf = await crypto.subtle.digest('SHA-256', hashData);
        const contentHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
        await env.DB.prepare('INSERT INTO sources (id, filename, source_type, r2_key, content_hash, token_count, ingested, summary, pages_updated, ingested_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, datetime(\'now\'))')
          .bind(sourceId, filename, sourceType, `sources/${sourceId}/${filename}`, contentHash, Math.ceil(content.length / 4), result.source_summary || '', JSON.stringify(allSlugs)).run();

        // Step 7: Log activity
        await env.DB.prepare('INSERT INTO activity_log (action, details, pages_touched) VALUES (\'research\', ?, ?)')
          .bind(JSON.stringify({ source: title, entities: entities.length, pages_created: pagesCreated, pages_updated: pagesUpdated, frontier_score: result.research?.frontier_score }), JSON.stringify(allSlugs)).run();

        return json({
          entities: entities.length,
          pages_created: pagesCreated.length,
          pages_updated: pagesUpdated.length,
          research: result.research || null,
          source_summary: result.source_summary || '',
        });
      }

      // POST /api/import/roam — bulk import Roam markdown pages (lightweight, no AI)
      if (method === 'POST' && path === '/api/import/roam') {
        const body = await request.json() as any;
        const pages = body.pages;
        if (!Array.isArray(pages)) return error('pages array required');

        let created = 0, updated = 0, skipped = 0;
        for (const p of pages) {
          if (!p.title || !p.content || p.content.length < 20) { skipped++; continue; }
          const slug = p.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
          if (!slug) { skipped++; continue; }

          // Extract wiki links from content
          const wikiLinks = (p.content.match(/\[\[([^\]]+)\]\]/g) || [])
            .map((m: string) => m.slice(2, -2).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
          const linksTo = [...new Set(wikiLinks)];

          // Detect page type
          let pageType = 'concept';
          const tags = p.tags || [];
          if (/^\w+ \d{1,2}(st|nd|rd|th), \d{4}$/.test(p.title)) { pageType = 'daily'; tags.push('daily-note'); }
          else if (p.title.includes('(highlights)')) { pageType = 'concept'; tags.push('book-highlights', 'readwise'); }
          else if (/^@/.test(p.title)) { pageType = 'entity'; tags.push('twitter', 'person'); }

          const existing = await env.DB.prepare('SELECT id FROM pages WHERE slug = ?').bind(slug).first();
          if (existing) {
            // Append content
            const obj = await env.STORAGE.get(`wiki/${slug}.md`);
            const existingContent = obj ? await obj.text() : '';
            const merged = existingContent + '\n\n---\n*Imported from Roam*\n\n' + p.content;
            await env.STORAGE.put(`wiki/${slug}.md`, merged);
            await env.DB.prepare('UPDATE pages SET word_count = ?, links_to = ?, tags = ?, updated_at = datetime(\'now\') WHERE slug = ?')
              .bind(merged.split(/\s+/).length, JSON.stringify(linksTo), JSON.stringify(tags), slug).run();
            updated++;
          } else {
            const pageId = crypto.randomUUID();
            await env.STORAGE.put(`wiki/${slug}.md`, p.content);
            await env.DB.prepare('INSERT INTO pages (id, title, slug, page_type, summary, tags, word_count, links_to, linked_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, \'[]\')')
              .bind(pageId, p.title, slug, pageType, (p.content || '').slice(0, 200).replace(/\n/g, ' '), JSON.stringify(tags), p.content.split(/\s+/).length, JSON.stringify(linksTo)).run();
            created++;
          }
        }

        // Log
        await env.DB.prepare('INSERT INTO activity_log (action, details, pages_touched) VALUES (\'import\', ?, \'[]\')')
          .bind(JSON.stringify({ source: 'roam', created, updated, skipped, total: pages.length })).run();

        return json({ created, updated, skipped, total: pages.length });
      }

      // POST /api/import/content — bulk upload page content to R2 (bearer auth)
      if (method === 'POST' && path === '/api/import/content') {
        const body = await request.json() as any;
        const pages = body.pages;
        if (!Array.isArray(pages)) return error('pages array required');
        let uploaded = 0;
        for (const p of pages) {
          if (!p.slug || !p.content) continue;
          await env.STORAGE.put(`wiki/${p.slug}.md`, p.content);
          uploaded++;
        }
        return json({ uploaded });
      }

      // GET /intake — redirect to dashboard (intake merged into Research Agent)
      if (method === 'GET' && (path === '/intake' || path === '/intake/')) {
        return new Response(null, {
          status: 302,
          headers: { 'Location': '/', ...CORS_HEADERS },
        });
      }

      // GET /share/:slug — Shareable page with OG tags + Unsplash image
      if (method === 'GET' && path.startsWith('/share/')) {
        const slug = path.replace('/share/', '');
        if (slug) {
          const page = await env.DB.prepare('SELECT title, slug, page_type, summary, tags FROM pages WHERE slug = ?').bind(slug).first();
          if (page) {
            const title = page.title as string;
            const summary = (page.summary as string || '').slice(0, 200);
            const tags = JSON.parse(page.tags as string || '[]');
            const pageType = page.page_type as string;
            // Build Unsplash query from tags + page type
            const imgQuery = encodeURIComponent(
              (tags.slice(0, 2).join(' ') || pageType || 'knowledge').replace(/[^a-zA-Z0-9\s]/g, '')
            );
            const ogImage = `https://source.unsplash.com/1200x630/?${imgQuery}`;

            return new Response(sharePageHTML(title, summary, ogImage, slug), {
              headers: { 'Content-Type': 'text/html', ...CORS_HEADERS },
            });
          }
        }
      }

      // GET / — Dashboard
      if (method === 'GET' && path === '/') {
        return new Response(dashboardHTML(), {
          headers: { 'Content-Type': 'text/html', ...CORS_HEADERS },
        });
      }

      // ===== NEW FEATURES: Templates, Briefing, Quick Create =====

      // GET /api/briefing — morning briefing: what to know today
      if (method === 'GET' && path === '/api/briefing') {
        const today = new Date().toISOString().split('T')[0];
        const dayOfWeek = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date().getDay()];

        // Recent activity (last 7 days)
        const recentActivity = await env.DB.prepare(
          `SELECT action, details, created_at FROM activity_log
           WHERE created_at > datetime('now', '-7 days')
           ORDER BY created_at DESC LIMIT 10`
        ).all();

        // Recently updated pages
        const recentPages = await env.DB.prepare(
          `SELECT slug, title, page_type, updated_at FROM pages
           WHERE updated_at > datetime('now', '-7 days')
           ORDER BY updated_at DESC LIMIT 10`
        ).all();

        // Stale high-value pages (many connections, not updated in 30+ days)
        const stalePages = await env.DB.prepare(
          `SELECT slug, title, page_type, updated_at,
           json_array_length(COALESCE(linked_from, '[]')) as backlinks
           FROM pages
           WHERE updated_at < datetime('now', '-30 days')
           AND json_array_length(COALESCE(linked_from, '[]')) >= 3
           ORDER BY json_array_length(COALESCE(linked_from, '[]')) DESC
           LIMIT 5`
        ).all();

        // Orphan pages (no incoming links)
        const orphanCount = await env.DB.prepare(
          `SELECT COUNT(*) as count FROM pages WHERE linked_from = '[]' OR linked_from IS NULL`
        ).first();

        // Random interesting connection (for serendipity)
        const allConnected = await env.DB.prepare(
          `SELECT slug, title, page_type, summary, links_to, linked_from FROM pages
           WHERE json_array_length(COALESCE(links_to, '[]')) >= 2
           AND json_array_length(COALESCE(linked_from, '[]')) >= 2
           ORDER BY RANDOM() LIMIT 1`
        ).first();

        let randomInsight = null;
        if (allConnected) {
          const linksTo = JSON.parse((allConnected as any).links_to || '[]').slice(0, 3);
          const linkedFrom = JSON.parse((allConnected as any).linked_from || '[]').slice(0, 3);
          randomInsight = {
            page: { slug: (allConnected as any).slug, title: (allConnected as any).title, type: (allConnected as any).page_type },
            summary: ((allConnected as any).summary || '').slice(0, 150),
            connects_to: linksTo,
            connected_from: linkedFrom,
          };
        }

        // Stats
        const totalPages = await env.DB.prepare('SELECT COUNT(*) as count FROM pages').first();
        const totalSources = await env.DB.prepare('SELECT COUNT(*) as count FROM sources').first();

        // People pages (entities that might need follow-up)
        const people = await env.DB.prepare(
          `SELECT slug, title, updated_at FROM pages
           WHERE page_type = 'entity'
           AND (tags LIKE '%person%' OR tags LIKE '%people%' OR title LIKE '%Person/%')
           ORDER BY updated_at ASC LIMIT 5`
        ).all();

        return json({
          date: today,
          day: dayOfWeek,
          greeting: `Good morning! It's ${dayOfWeek}, ${today}.`,
          stats: {
            total_pages: (totalPages as any)?.count || 0,
            total_sources: (totalSources as any)?.count || 0,
            orphan_pages: (orphanCount as any)?.count || 0,
          },
          recent_activity: recentActivity.results.map((a: any) => ({
            action: a.action,
            details: JSON.parse(a.details || '{}'),
            when: a.created_at,
          })),
          recently_updated: recentPages.results,
          stale_but_important: stalePages.results,
          random_insight: randomInsight,
          people_to_revisit: people.results,
        });
      }

      // GET /api/templates — list available templates
      if (method === 'GET' && path === '/api/templates') {
        const templates = [
          {
            id: 'weekly-review', name: 'Weekly Review', icon: '\uD83D\uDCCB',
            description: 'LCS Week Ahead: 3 ideas, learnings, retrospective',
            page_type: 'daily', tags: ['weekly-review', 'reflection'],
          },
          {
            id: 'research-note', name: 'Research Note', icon: '\uD83D\uDD0D',
            description: 'Filter & Sift investment research process',
            page_type: 'concept', tags: ['research', 'investment'],
          },
          {
            id: 'person', name: 'New Person', icon: '\uD83D\uDC64',
            description: 'Track a person: role, context, last contact',
            page_type: 'entity', tags: ['person'],
          },
          {
            id: 'project', name: 'New Project', icon: '\uD83D\uDE80',
            description: 'Project tracker: goals, stack, status, milestones',
            page_type: 'project', tags: ['project'],
          },
          {
            id: 'book', name: 'Book Note', icon: '\uD83D\uDCDA',
            description: 'Inspectional reading: thesis, key ideas, verdict',
            page_type: 'concept', tags: ['book', 'reading'],
          },
          {
            id: 'decision', name: 'Decision Log', icon: '\u2696\uFE0F',
            description: 'Algorithm of Thought: structured decision framework',
            page_type: 'concept', tags: ['decision', 'algorithm-of-thought'],
          },
          {
            id: 'pain-button', name: 'Pain Button', icon: '\uD83D\uDD34',
            description: 'Dalio: record pain, reflect later, find patterns',
            page_type: 'daily', tags: ['pain-button', 'reflection'],
          },
          {
            id: 'question', name: 'Research Question', icon: '\u2753',
            description: 'CPQ: open question that drives research',
            page_type: 'concept', tags: ['question', 'cpq'],
          },
          {
            id: 'claim', name: 'Claim / Proposition', icon: '\uD83D\uDCA1',
            description: 'CPQ: assertion with supporting evidence',
            page_type: 'concept', tags: ['claim', 'cpq'],
          },
        ];
        return json(templates);
      }

      // POST /api/templates/create — create a page from a template
      if (method === 'POST' && path === '/api/templates/create') {
        const body = await request.json() as any;
        const { template_id, title, extra } = body;
        if (!template_id || !title) return error('template_id and title required');

        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const today = new Date().toISOString().split('T')[0];
        const dayOfWeek = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date().getDay()];

        // Check for duplicate
        const existing = await env.DB.prepare('SELECT id FROM pages WHERE slug = ?').bind(slug).first();
        if (existing) return error('Page already exists: ' + slug, 409);

        let content = '';
        let pageType = 'concept';
        let tags: string[] = [];

        switch (template_id) {
          case 'weekly-review':
            pageType = 'daily';
            tags = ['weekly-review', 'reflection', 'lcs'];
            content = `# Weekly Review — ${today}\n\n` +
              `## Three Ideas for Next Week\n1. \n2. \n3. \n\n` +
              `## Last Week Review\n\n### Biggest Learnings\n- \n\n### What Will I Keep, Improve, Start, or Stop?\n- **Keep:** \n- **Improve:** \n- **Start:** \n- **Stop:** \n\n` +
              `### What Worked? What Didn't?\n- \n\n### Progress on Last Week's Three Ideas\n1. \n2. \n3. \n\n` +
              `## Most Actionable New Money Idea Right Now\n\n\n` +
              `---\n*Template: [[lcs-week-ahead]] | [[research-process-template]]*`;
            break;

          case 'research-note':
            pageType = 'concept';
            tags = ['research', 'investment', 'sift'];
            content = `# Research: ${title}\n\n` +
              `## Filter\n- **Business quality:** \n- **Free cash flow:** \n- **Gross margins / Rule of 40:** \n- **Sector attractiveness:** \n\n` +
              `## Sift\n- **Thesis (1-2 sentences):** \n- **Why is the stock down?** \n  - Out of favor? Structural or cyclical?\n- **Catalysts:** \n  - What events will unlock value?\n  - Timeline and impact on valuation?\n- **Valuation:** \n  - P/FCF: \n  - EV/EBITDA: \n  - ROIC → book value multiple: \n- **Downside / What can go wrong:** \n- **Recent news flow:** \n- **Position sizing:** \n\n` +
              `## Verdict\n- [ ] Worth pursuing further\n- [ ] Pass — reason: \n\n` +
              `---\n*Template: [[research-process-template]]*`;
            break;

          case 'person':
            pageType = 'entity';
            tags = ['person'];
            content = `# ${title}\n\n` +
              `## Overview\n- **Role:** \n- **Organization:** \n- **How we met:** \n- **Last contact:** ${today}\n\n` +
              `## Context\n\n\n## Notes\n- ${today}: \n\n` +
              `## Follow-up\n- [ ] \n\n` +
              `---\n*Template: [[people-template]]*`;
            break;

          case 'project':
            pageType = 'project';
            tags = ['project', 'active'];
            content = `# ${title}\n\n` +
              `## Overview\n- **Goal:** \n- **Status:** Active\n- **Stack:** \n- **Started:** ${today}\n\n` +
              `## Milestones\n- [ ] MVP: \n- [ ] V1: \n\n` +
              `## Decisions\n\n## Notes\n- ${today}: Started\n\n` +
              `---\n*Template: [[project-template]]*`;
            break;

          case 'book':
            pageType = 'concept';
            tags = ['book', 'reading', 'inspectional'];
            content = `# ${title}\n\n` +
              `## Inspectional Reading\n- **Author:** \n- **Year:** \n- **Main thesis (1-2 sentences):** \n- **Key topics:** \n\n` +
              `## Verdict\n- [ ] Read deeper (analytical reading)\n- [ ] Skip — reason: \n\n` +
              `## Key Ideas\n1. \n2. \n3. \n\n` +
              `## Quotes\n> \n\n` +
              `## Connections\n- Related to: \n\n` +
              `---\n*Template: [[book-template]] | Reading level: Inspectional*`;
            break;

          case 'decision':
            pageType = 'concept';
            tags = ['decision', 'algorithm-of-thought'];
            const framework = extra?.framework || 'difference-engine';
            if (framework === 'regret-minimization') {
              content = `# Decision: ${title}\n\n` +
                `## Regret Minimization Framework (Bezos)\n\n` +
                `**Option A:** \n**Option B:** \n\n` +
                `At age 80, would I regret not trying Option A? \nAt age 80, would I regret the downside of Option A? \n\n` +
                `**Decision:** \n\n---\n*Algorithm: [[regret-minimization]]*`;
            } else if (framework === 'want-impediment-remedy') {
              content = `# Decision: ${title}\n\n` +
                `## Want / Impediment / Remedy\n\n` +
                `**I want:** \n\n` +
                `**Impediment 1:** \n  - Remedy: \n\n` +
                `**Impediment 2:** \n  - Remedy: \n\n` +
                `**Action Items:**\n- [ ] \n\n---\n*Algorithm: [[want-impediment-remedy]]*`;
            } else {
              content = `# Decision: ${title}\n\n` +
                `## Difference Engine (Minsky)\n\n` +
                `**Current Situation:** \n**Desired Future:** \n\n` +
                `**Differences:**\n1. \n2. \n3. \n\n` +
                `**Most Serious Difference:** \n**Technique to Reduce It:** \n**Result:** \n\n---\n*Algorithm: [[difference-engine]]*`;
            }
            break;

          case 'pain-button':
            pageType = 'daily';
            tags = ['pain-button', 'reflection', 'dalio'];
            content = `# Pain Button — ${today}\n\n` +
              `## Pain Event\n- **What happened:** \n- **Emotion:** \n- **Date:** ${today}\n\n` +
              `## Reflection (return later)\n- **Root cause:** \n- **What I will do differently:** \n- **Pattern (link to previous):** \n\n` +
              `## Follow-through\n- [ ] Action taken\n\n` +
              `---\n*Template: [[pain-button]] | Pain + Reflection = Progress*`;
            break;

          case 'question':
            pageType = 'concept';
            tags = ['question', 'cpq', 'open'];
            content = `# QUE/ ${title}\n\n` +
              `## The Question\n${title}\n\n` +
              `## Why This Matters\n\n\n## Related Propositions\n- \n\n` +
              `## Status\n- [ ] Open\n- [ ] Answered\n- [ ] Revised\n\n` +
              `---\n*Type: Question (CPQ Framework) | [[galaxy-brain-cpq-framework]]*`;
            break;

          case 'claim':
            pageType = 'concept';
            tags = ['claim', 'cpq', 'proposition'];
            content = `# CLM/ ${title}\n\n` +
              `## Claim\n${title}\n\n` +
              `## Supporting Evidence\n1. \n\n## Opposing Evidence\n1. \n\n` +
              `## Confidence Level\n- [ ] High — strong evidence, multiple sources\n- [ ] Medium — some evidence, plausible\n- [ ] Low — speculative, needs more data\n\n` +
              `## Sources\n- \n\n` +
              `---\n*Type: Proposition (CPQ Framework) | [[galaxy-brain-cpq-framework]]*`;
            break;

          default:
            return error('Unknown template: ' + template_id);
        }

        // Store in R2
        await env.STORAGE.put(`wiki/${slug}.md`, content);

        // Insert into D1
        const pageId = crypto.randomUUID();
        const wikiLinks = (content.match(/\[\[([^\]]+)\]\]/g) || []).map((m: string) => m.slice(2, -2));
        await env.DB.prepare(
          `INSERT INTO pages (id, title, slug, page_type, summary, tags, word_count, links_to, linked_from)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]')`
        ).bind(
          pageId, title, slug, pageType,
          `${template_id} template page created ${today}`,
          JSON.stringify(tags),
          content.split(/\s+/).length,
          JSON.stringify(wikiLinks)
        ).run();

        // Log
        await env.DB.prepare(
          `INSERT INTO activity_log (action, details, pages_touched) VALUES ('create', ?, ?)`
        ).bind(JSON.stringify({ template: template_id, title }), JSON.stringify([slug])).run();

        return json({ slug, title, template: template_id, page_type: pageType });
      }

      // ===== PEOPLE CRM =====

      // GET /api/people — list all people with CRM data
      if (method === 'GET' && path === '/api/people') {
        const people = await env.DB.prepare(
          `SELECT slug, title, summary, tags, updated_at, linked_from, links_to
           FROM pages WHERE page_type = 'entity'
           AND (tags LIKE '%person%' OR tags LIKE '%people%')
           ORDER BY updated_at ASC`
        ).all();

        const results = people.results.map((p: any) => {
          const linkedFrom = JSON.parse(p.linked_from || '[]');
          const linksTo = JSON.parse(p.links_to || '[]');
          const tags = JSON.parse(p.tags || '[]');
          const daysSinceUpdate = Math.floor((Date.now() - new Date(p.updated_at + 'Z').getTime()) / 86400000);
          return {
            slug: p.slug,
            title: p.title,
            summary: (p.summary || '').slice(0, 150),
            tags,
            last_updated: p.updated_at,
            days_since_update: daysSinceUpdate,
            connections: linkedFrom.length + linksTo.length,
            needs_followup: daysSinceUpdate > 30,
          };
        });

        return json({
          total: results.length,
          needs_followup: results.filter((p: any) => p.needs_followup).length,
          people: results,
        });
      }

      // POST /api/people/scan — auto-detect people from entity pages
      if (method === 'POST' && path === '/api/people/scan') {
        // Find entities that look like people (name patterns, not companies)
        const entities = await env.DB.prepare(
          `SELECT slug, title, tags FROM pages WHERE page_type = 'entity' AND (tags NOT LIKE '%person%' OR tags IS NULL)`
        ).all();
        const personPatterns = /^[A-Z][a-z]+ [A-Z][a-z]/; // "First Last" pattern
        const companyWords = ['inc', 'corp', 'llc', 'fund', 'capital', 'group', 'partners', 'ventures', 'holdings', 'bank', 'financial', 'technologies', 'solutions', 'restaurant', 'club'];
        let tagged = 0;
        for (const p of entities.results as any[]) {
          const title = p.title || '';
          const slug = p.slug || '';
          const isCompany = companyWords.some(w => slug.includes(w) || title.toLowerCase().includes(w));
          const isPerson = personPatterns.test(title) && !isCompany;
          if (isPerson) {
            const tags: string[] = JSON.parse(p.tags || '[]');
            if (!tags.includes('person')) {
              tags.push('person');
              await env.DB.prepare('UPDATE pages SET tags = ? WHERE slug = ?').bind(JSON.stringify(tags), slug).run();
              tagged++;
            }
          }
        }
        return json({ scanned: entities.results.length, tagged });
      }

      // POST /api/people/tag — bulk-tag entity pages as people
      if (method === 'POST' && path === '/api/people/tag') {
        const body = await request.json() as any;
        const { slugs } = body;
        if (!Array.isArray(slugs)) return error('slugs array required');
        let tagged = 0;
        for (const slug of slugs) {
          const page = await env.DB.prepare('SELECT tags FROM pages WHERE slug = ? AND page_type = ?').bind(slug, 'entity').first();
          if (!page) continue;
          const tags: string[] = JSON.parse((page as any).tags || '[]');
          if (!tags.includes('person')) {
            tags.push('person');
            await env.DB.prepare('UPDATE pages SET tags = ? WHERE slug = ?').bind(JSON.stringify(tags), slug).run();
            tagged++;
          }
        }
        return json({ tagged });
      }

      // POST /api/people/touch — update "last contact" for a person
      if (method === 'POST' && path === '/api/people/touch') {
        const body = await request.json() as any;
        const { slug, note } = body;
        if (!slug) return error('slug required');
        // Append a contact note to the page content
        const obj = await env.STORAGE.get(`wiki/${slug}.md`);
        if (!obj) return error('Page not found', 404);
        const content = await obj.text();
        const today = new Date().toISOString().split('T')[0];
        const updated = content + `\n- ${today}: ${note || 'Touched base'}\n`;
        await env.STORAGE.put(`wiki/${slug}.md`, updated);
        await env.DB.prepare("UPDATE pages SET updated_at = datetime('now') WHERE slug = ?").bind(slug).run();
        await env.DB.prepare(
          `INSERT INTO activity_log (action, details, pages_touched) VALUES ('touch', ?, ?)`
        ).bind(JSON.stringify({ person: slug, note }), JSON.stringify([slug])).run();
        return json({ ok: true, slug, touched: today });
      }

      // ===== PROJECT RADAR =====

      // GET /api/projects/radar — active, stalled, and sparked projects
      if (method === 'GET' && path === '/api/projects/radar') {
        const projects = await env.DB.prepare(
          `SELECT slug, title, summary, tags, updated_at, links_to, linked_from
           FROM pages WHERE page_type = 'project'
           ORDER BY updated_at DESC`
        ).all();

        const now = Date.now();
        const radar = projects.results.map((p: any) => {
          const daysSinceUpdate = Math.floor((now - new Date((p as any).updated_at + 'Z').getTime()) / 86400000);
          const tags = JSON.parse((p as any).tags || '[]');
          const isSpark = (p as any).slug.startsWith('spark-');
          const isBuild = (p as any).slug.startsWith('build-');
          let status = 'active';
          if (daysSinceUpdate > 30) status = 'stalled';
          if (daysSinceUpdate > 90) status = 'archived';
          if (isSpark && !isBuild) status = 'sparked';
          if (tags.includes('archived')) status = 'archived';
          if (tags.includes('active')) status = 'active';
          return {
            slug: (p as any).slug,
            title: (p as any).title,
            summary: ((p as any).summary || '').slice(0, 150),
            status,
            days_since_update: daysSinceUpdate,
            last_updated: (p as any).updated_at,
            is_spark: isSpark,
            is_build: isBuild,
            connections: JSON.parse((p as any).linked_from || '[]').length + JSON.parse((p as any).links_to || '[]').length,
          };
        });

        const counts = { active: 0, stalled: 0, sparked: 0, archived: 0 };
        radar.forEach((p: any) => { counts[p.status as keyof typeof counts]++; });

        return json({ counts, projects: radar });
      }

      // ===== TELEGRAM WEBHOOK =====

      // POST /api/telegram/webhook — receive messages from Telegram bot
      if (method === 'POST' && path === '/api/telegram/webhook') {
        try {
          const update = await request.json() as any;
          const message = update.message;
          if (!message || !message.text) return json({ ok: true });

          const chatId = message.chat.id;
          const text = message.text.trim();
          const username = message.from?.username || message.from?.first_name || 'unknown';

          // Verify this is from an allowed chat (check env var)
          const allowedChat = (env as any).TELEGRAM_CHAT_ID;
          if (allowedChat && String(chatId) !== String(allowedChat)) {
            return json({ ok: true }); // silently ignore unauthorized chats
          }

          const botToken = (env as any).TELEGRAM_BOT_TOKEN;
          if (!botToken) return json({ ok: true });

          // Determine what to do with the message
          const isURL = /^https?:\/\//.test(text);
          const isQuestion = /\?\s*$/.test(text);

          let replyText = '';

          if (text === '/start') {
            replyText = 'PKM Wiki Bot ready. Send me:\n- A URL to ingest\n- A thought/note to capture\n- A question to query your wiki\n- /briefing for your morning briefing\n- /stats for wiki stats';
          } else if (text === '/briefing') {
            const stats = await env.DB.prepare('SELECT COUNT(*) as count FROM pages').first();
            const recent = await env.DB.prepare(
              `SELECT title, slug FROM pages ORDER BY updated_at DESC LIMIT 3`
            ).all();
            const stale = await env.DB.prepare(
              `SELECT title FROM pages
               WHERE updated_at < datetime('now', '-30 days')
               AND json_array_length(COALESCE(linked_from, '[]')) >= 3
               ORDER BY json_array_length(COALESCE(linked_from, '[]')) DESC LIMIT 3`
            ).all();
            replyText = `Good morning! Your wiki has ${(stats as any)?.count || 0} pages.\n\n` +
              `Recently updated:\n${recent.results.map((p: any) => `- ${p.title}`).join('\n')}\n\n` +
              `Needs attention:\n${stale.results.map((p: any) => `- ${p.title}`).join('\n') || 'All good!'}`;
          } else if (text === '/stats') {
            const pages = await env.DB.prepare('SELECT COUNT(*) as count FROM pages').first();
            const sources = await env.DB.prepare('SELECT COUNT(*) as count FROM sources').first();
            const orphans = await env.DB.prepare(`SELECT COUNT(*) as count FROM pages WHERE linked_from = '[]'`).first();
            replyText = `Wiki Stats:\n- ${(pages as any)?.count} pages\n- ${(sources as any)?.count} sources\n- ${(orphans as any)?.count} orphan pages`;
          } else if (isQuestion) {
            // Query the wiki
            const { runAIJSON } = await import('./ai');
            const { QUERY_PROMPT } = await import('./prompts');
            const fts = await env.DB.prepare(
              `SELECT slug, title, summary FROM pages WHERE slug IN (SELECT slug FROM pages_fts WHERE pages_fts MATCH ?) LIMIT 5`
            ).bind(text.replace(/[?'"]/g, '')).all();

            if (fts.results.length === 0) {
              replyText = 'No matching pages found in your wiki for that question.';
            } else {
              const context = [];
              for (const p of fts.results as any[]) {
                const obj = await env.STORAGE.get(`wiki/${p.slug}.md`);
                const content = obj ? (await obj.text()).slice(0, 1000) : p.summary || '';
                context.push(`## ${p.title}\n${content}`);
              }
              try {
                const answer = await runAIJSON<any>(env.AI, 'query', QUERY_PROMPT, `Question: ${text}\n\nContext:\n${context.join('\n\n')}`, 2000);
                replyText = (answer.answer || 'Could not generate an answer.').slice(0, 4000);
              } catch {
                replyText = `Found ${fts.results.length} pages: ${fts.results.map((p: any) => p.title).join(', ')}. Check pkm.cafecito-ai.com for details.`;
              }
            }
          } else if (isURL) {
            // Ingest URL
            try {
              const res = await fetch(text, { headers: { 'User-Agent': 'PKM-Wiki/1.0' }, redirect: 'follow' });
              const html = await res.text();
              const cleaned = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30000);

              const urlObj = new URL(text);
              const filename = (urlObj.hostname + urlObj.pathname).replace(/[^a-z0-9]+/gi, '-').slice(0, 60) + '.md';
              const { ingestSource } = await import('./ingest');
              const result = await ingestSource(env, filename, `# ${text}\n\n${cleaned}`, 'url');
              replyText = `Ingested! Created ${result.pages_created.length} pages, updated ${result.pages_updated.length}.\n${result.pages_created.map(s => `- ${s}`).join('\n')}`;
            } catch (e: any) {
              replyText = `Failed to ingest URL: ${e.message}`;
            }
          } else {
            // Capture as a quick note
            const { ingestSource } = await import('./ingest');
            const filename = `telegram-${Date.now()}.md`;
            const result = await ingestSource(env, filename, `# Telegram Note\n\nFrom: ${username}\nDate: ${new Date().toISOString()}\n\n${text}`, 'note');
            replyText = `Captured! ${result.pages_created.length > 0 ? 'Created: ' + result.pages_created.join(', ') : result.pages_updated.length > 0 ? 'Updated: ' + result.pages_updated.join(', ') : 'Saved as source.'}`;
          }

          // Send reply
          if (replyText) {
            await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, text: replyText, parse_mode: 'Markdown' }),
            });
          }
        } catch (teleErr: any) {
          console.log('TELEGRAM_ERROR:', teleErr.message);
        }
        return json({ ok: true });
      }

      // GET /api/debug/gemma — test raw Gemma output
      if (method === 'GET' && path === '/api/debug/gemma') {
        const model = '@cf/google/gemma-4-26b-a4b-it';
        try {
          const result = await env.AI.run(model, {
            messages: [
              { role: 'user', content: 'Say hello in JSON format: {"greeting":"hello"}' },
            ],
            max_tokens: 100,
          });
          return json({ model, result, result_type: typeof result, keys: result ? Object.keys(result) : null });
        } catch (aiErr: any) {
          return json({ model, error: aiErr.message, stack: aiErr.stack?.slice(0, 300) }, 500);
        }
      }

      // --- Semantic Search & Vectorize endpoints ---

      // GET /api/search/semantic?q= — vector semantic search
      if (method === 'GET' && path === '/api/search/semantic') {
        const q = url.searchParams.get('q');
        if (!q) return error('q parameter required');
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10), 50);

        // Check KV cache first
        const cacheKey = `semantic:${q}:${limit}`;
        const cached = await getCachedSearch(env, cacheKey);
        if (cached) return json(cached);

        try {
          const matches = await searchSimilar(env, q, limit);
          // Enrich with page data
          const results = [];
          for (const m of matches as any[]) {
            const page = await env.DB.prepare(
              'SELECT slug, title, page_type, summary, tags FROM pages WHERE id = ?'
            ).bind(m.id).first();
            if (page) {
              results.push({
                slug: page.slug, title: page.title, type: page.page_type,
                summary: ((page.summary as string) || '').slice(0, 200),
                tags: JSON.parse((page.tags as string) || '[]'),
                score: m.score,
              });
            }
          }
          const response = { query: q, results, total: results.length };
          await setCachedSearch(env, cacheKey, response);
          return json(response);
        } catch (e: any) {
          return error(`Semantic search failed: ${e.message}`, 500);
        }
      }

      // GET /api/pages/:slug/similar — find similar pages via vectorize
      if (method === 'GET' && path.match(/^\/api\/pages\/[^/]+\/similar$/)) {
        const slug = path.replace('/api/pages/', '').replace('/similar', '');
        const page = await env.DB.prepare('SELECT id FROM pages WHERE slug = ?').bind(slug).first();
        if (!page) return error('Page not found', 404);
        try {
          const similar = await findSimilarPages(env, page.id as string, 5);
          const results = [];
          for (const m of similar as any[]) {
            const p = await env.DB.prepare(
              'SELECT slug, title, page_type, summary FROM pages WHERE id = ?'
            ).bind(m.id).first();
            if (p) results.push({ slug: p.slug, title: p.title, type: p.page_type, summary: ((p.summary as string) || '').slice(0, 150), score: m.score });
          }
          return json({ slug, similar: results });
        } catch (e: any) {
          return error(`Similar pages failed: ${e.message}`, 500);
        }
      }

      // POST /api/vectorize/rebuild — re-index all pages (admin)
      if (method === 'POST' && path === '/api/vectorize/rebuild') {
        try {
          const result = await rebuildIndex(env);
          return json(result);
        } catch (e: any) {
          return error(`Rebuild failed: ${e.message}`, 500);
        }
      }

      // POST /api/queue/enqueue — enqueue a job (admin)
      if (method === 'POST' && path === '/api/queue/enqueue') {
        if (!env.JOBS_QUEUE) return error('Queue not configured', 501);
        const body = await request.json() as any;
        const { action, payload } = body;
        if (!action) return error('action is required');
        await env.JOBS_QUEUE.send({ action, payload: payload || {} });
        return json({ queued: true, action });
      }

      return error('Not found', 404);
    } catch (err: any) {
      console.error('PKM Wiki error:', err);
      return error(err.message || 'Internal server error', 500);
    }
  },

  // Queue consumer handler
  async queue(batch: MessageBatch, env: Env) {
    for (const msg of batch.messages) {
      const { action, payload } = msg.body as any;
      try {
        switch (action) {
          case 'ingest': {
            // Process ingest async
            if (payload.filename && payload.content) {
              await ingestSource(env, payload.filename, payload.content, payload.source_type || 'note');
            }
            break;
          }
          case 'compile': {
            // Run wiki compilation
            const { runAIJSON } = await import('./ai');
            const { COMPILE_PROMPT } = await import('./prompts');
            // Lightweight compile — just log that it ran
            console.log('Queue: compile job executed');
            break;
          }
          case 'lint': {
            // Run wiki lint
            await lintWiki(env);
            break;
          }
          case 'index': {
            // Re-index a single page in vectorize
            if (payload.pageId && payload.title) {
              await indexPage(env, payload.pageId, payload.title, payload.summary || '', payload.tags || []);
            }
            break;
          }
          case 'build': {
            // Generate project from spark
            if (payload.sparkContent && env.ANTHROPIC_API_KEY) {
              await buildFromSpark(env, env.ANTHROPIC_API_KEY, payload.sparkContent);
            }
            break;
          }
          default:
            console.warn(`Unknown queue action: ${action}`);
        }
        msg.ack();
      } catch (e) {
        console.error(`Queue job ${action} failed:`, e);
        msg.retry();
      }
    }
  },
};

async function generateToken(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + '-pkm-wiki-auth-2026');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function loginPageHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PKM Wiki — Login</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background: #0C0C0E; color: #E8E6E1; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .login-card { background: #161619; border: 1px solid #2A2A2F; border-radius: 6px; padding: 48px 40px; max-width: 400px; width: 90%; text-align: center; }
    h1 { font-family: 'Instrument Serif', Georgia, serif; font-size: 32px; font-weight: 400; color: #E8E6E1; margin-bottom: 8px; letter-spacing: -0.02em; }
    h1 span { color: #D4A853; }
    .subtitle { color: #8A8880; font-size: 14px; margin-bottom: 32px; }
    input { width: 100%; padding: 14px 18px; background: #0C0C0E; border: 1px solid #2A2A2F; border-radius: 6px; color: #E8E6E1; font-size: 16px; font-family: 'Inter', sans-serif; outline: none; margin-bottom: 16px; }
    input:focus { border-color: #D4A853; }
    input::placeholder { color: #5A5850; }
    button { width: 100%; padding: 14px; background: #D4A853; border: none; border-radius: 6px; color: #0C0C0E; font-size: 16px; font-weight: 600; font-family: 'Inter', sans-serif; cursor: pointer; }
    button:hover { background: #C4983F; }
    button:disabled { background: #2A2A2F; color: #5A5850; cursor: wait; }
    .error { color: #CC4455; font-size: 13px; margin-top: 12px; display: none; }
  </style>
</head>
<body>
  <div class="login-card">
    <h1>PKM <span>Wiki</span></h1>
    <p class="subtitle">Personal knowledge base</p>
    <form onsubmit="login(event)">
      <input type="password" id="pw" placeholder="Enter password" autofocus />
      <button type="submit" id="btn">Unlock</button>
    </form>
    <div class="error" id="err"></div>
  </div>
  <script>
    async function login(e) {
      e.preventDefault();
      var btn = document.getElementById('btn');
      var err = document.getElementById('err');
      var pw = document.getElementById('pw').value;
      btn.disabled = true; btn.textContent = 'Checking...';
      err.style.display = 'none';
      try {
        var base = window.location.pathname.startsWith('/pkm') ? '/pkm' : '';
        var res = await fetch(base + '/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pw }),
        });
        if (res.ok) {
          window.location.reload();
        } else {
          err.textContent = 'Wrong password';
          err.style.display = 'block';
        }
      } catch (ex) {
        err.textContent = 'Connection error';
        err.style.display = 'block';
      }
      btn.disabled = false; btn.textContent = 'Unlock';
    }
  </script>
</body>
</html>`;
}

function intakePageHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PKM Intake</title>
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    :root { --bg:#0C0C0E; --card:#161619; --border:#2A2A2F; --text:#E8E6E1; --dim:#8A8880; --accent:#D4A853; --green:#4AAF7C; --purple:#9B7DCF; --red:#CC4455; }
    [data-theme="light"] { --bg:#F5F4F0; --card:#FFFFFF; --border:#E0DED8; --text:#1A1918; --dim:#6B6860; --accent:#B8922F; --green:#4AAF7C; --purple:#9B7DCF; --red:#CC4455; }
    body { font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif; background:var(--bg); color:var(--text); min-height:100vh; display:flex; flex-direction:column; align-items:center; padding:20px; }
    .header { display:flex; align-items:center; gap:12px; margin-bottom:24px; width:100%; max-width:600px; }
    .header h1 { font-family:'Instrument Serif',Georgia,serif; font-size:24px; font-weight:400; color:var(--text); flex:1; letter-spacing:-0.02em; }
    .header a { color:var(--dim); text-decoration:none; font-size:13px; }
    .header a:hover { color:var(--accent); }
    .header button { background:none; border:1px solid var(--border); border-radius:6px; padding:4px 8px; color:var(--dim); cursor:pointer; font-size:14px; }
    .intake-card { width:100%; max-width:600px; background:var(--card); border:1px solid var(--border); border-radius:6px; padding:24px; }
    .intake-input { width:100%; padding:16px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--text); font-size:16px; font-family:'Inter',sans-serif; outline:none; margin-bottom:12px; }
    .intake-input:focus { border-color:var(--accent); }
    .intake-input::placeholder { color:#5A5850; }
    textarea.intake-input { min-height:100px; resize:vertical; display:none; }
    .intake-actions { display:flex; gap:8px; margin-bottom:12px; }
    .btn { padding:12px 20px; border:none; border-radius:6px; font-size:15px; font-weight:600; font-family:'Inter',sans-serif; cursor:pointer; flex:1; transition:all .15s; }
    .btn:disabled { opacity:.5; cursor:wait; }
    .btn-save { background:var(--accent); color:#0C0C0E; }
    .btn-save:hover { background:#C4983F; }
    .btn-fly { background:var(--purple); color:#fff; }
    .btn-fly:hover { opacity:.9; }
    .toggle-row { display:flex; gap:8px; margin-bottom:12px; }
    .toggle-btn { flex:1; padding:8px; background:var(--bg); border:1px solid var(--border); border-radius:8px; color:var(--dim); font-size:13px; cursor:pointer; text-align:center; transition:all .15s; }
    .toggle-btn.active { border-color:var(--accent); color:var(--accent); background:rgba(212,168,83,.1); }
    .status { font-size:13px; padding:12px; border-radius:8px; display:none; margin-bottom:12px; line-height:1.5; }
    .status.ok { display:block; background:rgba(74,175,124,.1); color:var(--green); border:1px solid rgba(74,175,124,.2); }
    .status.err { display:block; background:rgba(204,68,85,.1); color:var(--red); border:1px solid rgba(204,68,85,.2); }
    .status.loading { display:block; background:rgba(212,168,83,.1); color:var(--accent); border:1px solid rgba(212,168,83,.2); }
    .spark-result { background:var(--bg); border:1px solid var(--border); border-radius:6px; padding:16px; margin-top:12px; display:none; }
    .spark-result h3 { color:var(--text); font-size:15px; margin-bottom:4px; }
    .spark-result p { color:var(--dim); font-size:13px; line-height:1.5; margin-bottom:8px; }
    .spark-result .prompt-box { background:var(--card); border:1px solid var(--border); border-radius:6px; padding:10px; font-size:12px; max-height:150px; overflow:auto; white-space:pre-wrap; color:var(--dim); }
    .spark-result button { padding:8px 16px; background:var(--accent); border:none; border-radius:6px; color:#fff; font-size:13px; font-weight:600; cursor:pointer; margin-top:8px; }
    .recent { width:100%; max-width:600px; margin-top:20px; }
    .recent h2 { font-size:14px; color:var(--dim); text-transform:uppercase; letter-spacing:.5px; margin-bottom:10px; }
    .recent-item { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:12px 14px; margin-bottom:6px; cursor:pointer; transition:border-color .15s; }
    .recent-item:hover { border-color:var(--accent); }
    .recent-item .ri-title { font-size:14px; font-weight:600; color:var(--text); }
    .recent-item .ri-meta { font-size:11px; color:var(--dim); margin-top:2px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>PKM Intake</h1>
    <a href="/">Full Dashboard</a>
    <button onclick="toggleTheme()" id="theme-btn">&#9790;</button>
  </div>

  <div class="intake-card">
    <input class="intake-input" type="text" id="url-input" placeholder="Paste a URL, tweet link, or type a quick thought..." autofocus />
    <textarea class="intake-input" id="note-input" placeholder="Add more detail or context (optional)..."></textarea>

    <div class="toggle-row">
      <div class="toggle-btn active" onclick="setMode('quick')" id="mode-quick">Quick Save</div>
      <div class="toggle-btn" onclick="setMode('detail')" id="mode-detail">Add Detail</div>
    </div>

    <div class="intake-actions">
      <button class="btn btn-save" onclick="doSave()" id="save-btn">Save to Wiki</button>
      <button class="btn btn-fly" onclick="doFlywheel()" id="fly-btn">&#9889; Full Flywheel</button>
    </div>

    <div class="status" id="status"></div>

    <div class="spark-result" id="spark-result">
      <h3 id="spark-name"></h3>
      <p id="spark-summary"></p>
      <div class="prompt-box" id="spark-prompt"></div>
      <button onclick="copyPrompt()">Copy Claude Code Prompt</button>
    </div>
  </div>

  <div class="recent" id="recent"></div>

  <script>
    var mode = 'quick';
    function setMode(m) {
      mode = m;
      document.getElementById('mode-quick').className = 'toggle-btn' + (m==='quick' ? ' active' : '');
      document.getElementById('mode-detail').className = 'toggle-btn' + (m==='detail' ? ' active' : '');
      document.getElementById('note-input').style.display = m==='detail' ? 'block' : 'none';
    }

    function toggleTheme() {
      var t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = t;
      document.getElementById('theme-btn').innerHTML = t==='light' ? '&#9728;' : '&#9790;';
      try { localStorage.setItem('pkm-theme', t); } catch(e) {}
    }
    (function() {
      try { var t = localStorage.getItem('pkm-theme') || 'dark'; document.documentElement.dataset.theme = t; document.getElementById('theme-btn').innerHTML = t==='light' ? '&#9728;' : '&#9790;'; } catch(e) {}
    })();

    function status(msg, type) {
      var el = document.getElementById('status');
      el.textContent = msg;
      el.className = 'status ' + type;
    }

    async function doSave() {
      var val = document.getElementById('url-input').value.trim();
      var note = document.getElementById('note-input').value.trim();
      if (!val && !note) { status('Enter a URL or note', 'err'); return; }

      var btn = document.getElementById('save-btn');
      btn.disabled = true;
      status('Saving to wiki...', 'loading');

      try {
        var isURL = /^https?:[/][/]/.test(val);
        var res;
        if (isURL) {
          res = await fetch('/api/ingest/url', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({url:val}) });
        } else {
          var content = val + (note ? '\\n\\n' + note : '');
          res = await fetch('/api/ingest', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({filename:'intake-'+Date.now()+'.md', content:content, source_type:'note'}) });
        }
        var data = await res.json();
        if (data.error) { status('Error: ' + data.error, 'err'); }
        else { status('Saved! ' + (data.entities_extracted||0) + ' entities extracted, ' + (data.pages_created||[]).length + ' pages created.', 'ok'); document.getElementById('url-input').value = ''; document.getElementById('note-input').value = ''; loadRecent(); }
      } catch(e) { status('Error: ' + e.message, 'err'); }
      btn.disabled = false;
    }

    async function doFlywheel() {
      var val = document.getElementById('url-input').value.trim();
      var note = document.getElementById('note-input').value.trim();
      if (!val && !note) { status('Enter a URL or note', 'err'); return; }

      var btn = document.getElementById('fly-btn');
      btn.disabled = true;
      btn.textContent = 'Processing...';
      status('Running flywheel: ingesting + sparking build plan...', 'loading');
      document.getElementById('spark-result').style.display = 'none';

      try {
        var isURL = /^https?:[/][/]/.test(val);
        var body = isURL ? { url: val } : { content: val + (note ? '\\n\\n' + note : ''), title: val.slice(0, 60) };
        var res = await fetch('/api/flywheel', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
        var data = await res.json();

        if (data.error) { status('Error: ' + data.error, 'err'); }
        else {
          var msg = 'Ingested: ' + (data.ingest?.entities||0) + ' entities, ' + (data.ingest?.pages_created||0) + ' pages created.';
          if (data.spark) {
            msg += ' Spark plan generated!';
            document.getElementById('spark-name').textContent = data.spark.name || 'Build Plan';
            document.getElementById('spark-summary').textContent = data.spark.summary || '';
            document.getElementById('spark-prompt').textContent = data.spark.claude_prompt || 'No prompt generated';
            document.getElementById('spark-result').style.display = 'block';
          } else {
            msg += ' (Spark skipped — rate limit, try again in a minute)';
          }
          status(msg, 'ok');
          document.getElementById('url-input').value = '';
          document.getElementById('note-input').value = '';
          loadRecent();
        }
      } catch(e) { status('Error: ' + e.message, 'err'); }
      btn.disabled = false;
      btn.textContent = '\\u26A1 Full Flywheel';
    }

    function copyPrompt() {
      var text = document.getElementById('spark-prompt').textContent;
      navigator.clipboard.writeText(text).then(function() { alert('Copied! Paste into Claude Code to build.'); });
    }

    async function loadRecent() {
      try {
        var res = await fetch('/api/log?limit=8');
        var data = await res.json();
        var el = document.getElementById('recent');
        if (!data.log || data.log.length === 0) { el.innerHTML = ''; return; }
        var items = data.log.filter(function(l) { return l.action === 'ingest' || l.action === 'spark' || l.action === 'flywheel'; }).slice(0, 5);
        if (items.length === 0) { el.innerHTML = ''; return; }
        el.innerHTML = '<h2>Recent Intakes</h2>' + items.map(function(l) {
          var pages = (l.pages_touched || []).slice(0, 3).join(', ') || 'processing';
          var d = l.created_at ? new Date(l.created_at + 'Z') : null;
          var time = d ? d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '';
          return '<div class="recent-item" onclick="window.location.href=&apos;/&apos;">' +
            '<div class="ri-title">' + l.action.toUpperCase() + ': ' + pages + '</div>' +
            '<div class="ri-meta">' + time + '</div></div>';
        }).join('');
      } catch(e) {}
    }

    document.getElementById('url-input').addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doFlywheel(); }
    });

    loadRecent();
  </script>
</body>
</html>`;
}

function sharePageHTML(title: string, summary: string, ogImage: string, slug: string): string {
  const siteUrl = 'https://pkm.cafecito-ai.com';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — PKM Wiki</title>
  <meta name="description" content="${summary.replace(/"/g, '&quot;')}" />
  <meta property="og:title" content="${title.replace(/"/g, '&quot;')}" />
  <meta property="og:description" content="${summary.replace(/"/g, '&quot;')}" />
  <meta property="og:image" content="${ogImage}" />
  <meta property="og:url" content="${siteUrl}/share/${slug}" />
  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="PKM Wiki" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title.replace(/"/g, '&quot;')}" />
  <meta name="twitter:description" content="${summary.replace(/"/g, '&quot;')}" />
  <meta name="twitter:image" content="${ogImage}" />
  <meta http-equiv="refresh" content="0;url=${siteUrl}/" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, sans-serif; background: #0a0a0a; color: #e0e0e0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { max-width: 600px; width: 90%; background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 16px; overflow: hidden; }
    .card img { width: 100%; height: 250px; object-fit: cover; }
    .card-body { padding: 24px; }
    .card-body h1 { font-size: 24px; color: #fff; margin-bottom: 8px; }
    .card-body p { color: #999; line-height: 1.6; margin-bottom: 16px; }
    .card-body a { color: #4a9eff; text-decoration: none; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <img src="${ogImage}" alt="${title.replace(/"/g, '&quot;')}" />
    <div class="card-body">
      <h1>${title}</h1>
      <p>${summary}</p>
      <a href="${siteUrl}/">Open in PKM Wiki &rarr;</a>
    </div>
  </div>
</body>
</html>`;
}

function parsePageRow(row: any) {
  return {
    ...row,
    tags: JSON.parse(row.tags || '[]'),
    links_to: JSON.parse(row.links_to || '[]'),
    linked_from: JSON.parse(row.linked_from || '[]'),
  };
}

function extractWikiLinks(content: string): string[] {
  const matches = content.match(/\[\[([^\]]+)\]\]/g) || [];
  return [...new Set(matches.map((m: string) => m.slice(2, -2)))];
}

function dashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PKM Wiki — Cockpit</title>
  <meta name="description" content="Personal knowledge base powered by Gemma 4 on Workers AI" />
  <meta property="og:title" content="PKM Wiki" />
  <meta property="og:description" content="Personal knowledge base — 1,000+ pages of compiled knowledge" />
  <meta property="og:image" content="https://source.unsplash.com/1200x630/?knowledge,library" />
  <meta property="og:url" content="https://pkm.cafecito-ai.com" />
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #0C0C0E; --bg-card: #161619; --bg-hover: #1E1E22; --border: #2A2A2F;
      --text: #E8E6E1; --text-dim: #8A8880; --text-faint: #5A5850; --white: #E8E6E1;
      --accent: #D4A853; --accent-hover: #C4983F;
      --green: #4AAF7C; --yellow: #D4A853; --red: #CC4455;
      --blue: #5B8DEF; --purple: #9B7DCF; --amber: #D4A853; --gray: #7A7870;
      --sidebar-w: 280px;
      --font: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      --font-serif: 'Instrument Serif', Georgia, serif;
      --font-mono: 'Geist Mono', 'SF Mono', 'Fira Code', monospace;
    }
    [data-theme="light"] {
      --bg: #F5F4F0; --bg-card: #FFFFFF; --bg-hover: #FAFAF8; --border: #E0DED8;
      --text: #1A1918; --text-dim: #6B6860; --text-faint: #9A9890; --white: #1A1918;
      --accent: #B8922F; --accent-hover: #A07D20;
    }
    html, body { height: 100%; }
    body { font-family: var(--font); font-size: 13px; line-height: 1.5; background: var(--bg); color: var(--text); display: flex; overflow: hidden; }

    /* Sidebar */
    .sidebar {
      width: var(--sidebar-w); min-width: var(--sidebar-w); height: 100vh; background: var(--bg-card);
      border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden;
      transition: transform 0.3s ease;
    }
    .sidebar-header { padding: 20px 16px 12px; border-bottom: 1px solid var(--border); }
    .sidebar-header h1 { font-family: var(--font-serif); font-size: 22px; font-weight: 400; color: var(--white); cursor: pointer; letter-spacing: -0.02em; }
    .sidebar-header h1:hover { color: var(--accent); }
    .sidebar-header .subtitle { font-size: 11px; color: var(--text-dim); margin-top: 2px; }
    .sidebar-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
    .sidebar-stat { text-align: center; }
    .sidebar-stat .val { font-size: 18px; font-weight: 700; color: var(--white); }
    .sidebar-stat .lbl { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; }
    .sidebar-search { padding: 12px 16px; border-bottom: 1px solid var(--border); }
    .sidebar-search input {
      width: 100%; padding: 8px 12px; background: var(--bg); border: 1px solid var(--border);
      border-radius: 6px; color: var(--white); font-size: 13px; outline: none;
    }
    .sidebar-search input:focus { border-color: var(--accent); }
    .sidebar-search input::placeholder { color: var(--text-faint); }
    .sidebar-sort { padding: 8px 16px; display: flex; gap: 4px; border-bottom: 1px solid var(--border); }
    .sort-btn {
      flex: 1; padding: 4px; background: none; border: 1px solid var(--border); border-radius: 4px;
      color: var(--text-dim); font-size: 10px; cursor: pointer; text-transform: uppercase; letter-spacing: 0.3px;
    }
    .sort-btn.active { background: var(--accent); color: #0C0C0E; border-color: var(--accent); }
    .page-list-container { flex: 1; overflow-y: auto; padding: 8px 0; }
    .page-list-container::-webkit-scrollbar { width: 4px; }
    .page-list-container::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
    .sidebar-page {
      padding: 10px 16px; cursor: pointer; border-left: 3px solid transparent;
      transition: all 0.15s ease;
    }
    .sidebar-page:hover { background: var(--bg-hover); }
    .sidebar-page.active { border-left-color: var(--accent); background: var(--bg-hover); }
    .sidebar-page .sp-title { font-size: 13px; font-weight: 600; color: var(--white); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sidebar-page .sp-meta { font-size: 10px; color: var(--text-dim); margin-top: 2px; display: flex; align-items: center; gap: 6px; }

    /* Type badges */
    .type-badge {
      display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px;
      font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px;
    }
    .type-concept { background: rgba(91,141,239,0.15); color: var(--blue); }
    .type-entity { background: rgba(74,175,124,0.15); color: var(--green); }
    .type-project { background: rgba(155,125,207,0.15); color: var(--purple); }
    .type-daily { background: rgba(212,168,83,0.15); color: var(--amber); }
    .type-index, .type-unknown { background: rgba(122,120,112,0.15); color: var(--gray); }

    /* Main content */
    .main { flex: 1; height: 100vh; overflow-y: auto; padding: 0; }
    .main::-webkit-scrollbar { width: 6px; }
    .main::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
    .main-inner { max-width: 860px; margin: 0 auto; padding: 32px 40px; }

    /* Hamburger */
    .hamburger {
      display: none; position: fixed; top: 12px; left: 12px; z-index: 1001;
      background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px;
      padding: 8px 10px; cursor: pointer; color: var(--white); font-size: 18px; line-height: 1;
    }
    .sidebar-overlay {
      display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 999;
    }

    /* Dashboard */
    .dash-title { font-family: var(--font-serif); font-size: 42px; font-weight: 400; color: var(--white); margin-bottom: 4px; letter-spacing: -0.03em; }
    .dash-subtitle { color: var(--text-dim); font-size: 13px; margin-bottom: 28px; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 14px; margin-bottom: 28px; }
    .stat-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px; padding: 20px; }
    .stat-card .value { font-family: var(--font-serif); font-size: 42px; font-weight: 400; color: var(--white); line-height: 1; letter-spacing: -0.02em; }
    .stat-card .label { font-size: 12px; color: var(--text-dim); margin-top: 6px; }
    .stat-card .delta { font-size: 11px; color: var(--green); margin-top: 4px; font-weight: 500; }
    .stat-card .delta.amber { color: var(--accent); }
    .health-bar { height: 5px; background: var(--border); border-radius: 3px; margin-top: 8px; overflow: hidden; }
    .health-fill { height: 100%; border-radius: 3px; transition: width 0.6s ease; }

    /* Q&A */
    .qa-section { margin-bottom: 28px; }
    .qa-section h2 { font-size: 14px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px; }
    .qa-form { display: flex; gap: 8px; }
    .qa-input {
      flex: 1; padding: 10px 14px; background: var(--bg-card); border: 1px solid var(--border);
      border-radius: 8px; color: var(--white); font-size: 14px; outline: none; font-family: var(--font);
    }
    .qa-input:focus { border-color: var(--accent); }
    .qa-input::placeholder { color: var(--text-faint); }
    .btn-primary {
      padding: 10px 20px; background: var(--accent); border: none; border-radius: 6px;
      color: #0C0C0E; font-weight: 600; cursor: pointer; font-size: 13px; white-space: nowrap;
      font-family: var(--font); transition: background 0.15s;
    }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-primary:disabled { background: #2A2A2F; color: #5A5850; cursor: wait; }
    .qa-answer {
      display: none; background: var(--bg-card); border: 1px solid var(--border);
      border-radius: 8px; padding: 16px; margin-top: 10px; line-height: 1.7; font-size: 14px;
    }
    .qa-answer h1, .qa-answer h2, .qa-answer h3 { color: var(--white); margin: 12px 0 6px; }
    .qa-answer code { background: var(--bg); padding: 2px 5px; border-radius: 3px; font-size: 13px; }
    .qa-answer pre { background: var(--bg); padding: 12px; border-radius: 6px; overflow-x: auto; margin: 8px 0; }
    .qa-answer pre code { background: none; padding: 0; }
    .qa-answer ul, .qa-answer ol { padding-left: 20px; margin: 6px 0; }
    .qa-answer a { color: var(--accent); text-decoration: none; }
    .qa-answer a:hover { text-decoration: underline; }

    /* Sections */
    .section { margin-bottom: 28px; }
    .section-header { font-family: var(--font-serif); font-size: 20px; font-weight: 400; color: var(--white); text-transform: none; letter-spacing: -0.01em; margin-bottom: 10px; }

    /* Activity feed */
    .activity-item { padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px; display: flex; align-items: center; gap: 8px; }
    .activity-action { font-weight: 600; color: var(--accent); text-transform: uppercase; font-size: 10px; letter-spacing: 0.3px; background: rgba(212,168,83,0.1); padding: 2px 6px; border-radius: 3px; }
    .activity-pages { color: var(--text); }
    .activity-time { color: var(--text-faint); font-size: 11px; margin-left: auto; white-space: nowrap; }

    /* Top entities */
    .entity-list { list-style: none; }
    .entity-item {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 12px; background: var(--bg-card); border: 1px solid var(--border);
      border-radius: 6px; margin-bottom: 6px; cursor: pointer; transition: border-color 0.15s;
    }
    .entity-item:hover { border-color: var(--accent); }
    .entity-name { font-size: 13px; font-weight: 600; color: var(--white); }
    .entity-count { font-size: 11px; color: var(--text-dim); background: var(--bg); padding: 2px 8px; border-radius: 10px; }

    /* Ingest form */
    .ingest-form { background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px; padding: 18px; }
    .ingest-form label { display: block; font-size: 12px; color: var(--text-dim); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.3px; }
    .ingest-form input, .ingest-form textarea, .ingest-form select {
      width: 100%; padding: 8px 12px; background: var(--bg); border: 1px solid var(--border);
      border-radius: 6px; color: var(--white); font-size: 13px; outline: none; font-family: var(--font);
      margin-bottom: 12px;
    }
    .ingest-form textarea { min-height: 120px; resize: vertical; }
    .ingest-form input:focus, .ingest-form textarea:focus, .ingest-form select:focus { border-color: var(--accent); }
    .ingest-row { display: flex; gap: 12px; }
    .ingest-row > div { flex: 1; }
    .ingest-status { font-size: 12px; margin-top: 8px; }
    .ingest-status.ok { color: var(--green); }
    .ingest-status.err { color: var(--red); }

    /* Page view */
    .page-header { margin-bottom: 24px; }
    .page-header-title { font-family: var(--font-serif); font-size: 32px; color: var(--white); font-weight: 400; letter-spacing: -0.02em; }
    .page-header-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 8px; font-size: 12px; color: var(--text-dim); }
    .page-header-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
    .page-tag { display: inline-block; background: var(--border); color: var(--text); padding: 3px 10px; border-radius: 4px; font-size: 11px; }
    .page-content { line-height: 1.8; font-size: 15px; }
    .page-content h1 { font-size: 24px; color: var(--white); margin: 24px 0 10px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
    .page-content h2 { font-size: 20px; color: var(--white); margin: 20px 0 8px; }
    .page-content h3 { font-size: 16px; color: var(--white); margin: 16px 0 6px; }
    .page-content p { margin: 8px 0; }
    .page-content ul, .page-content ol { padding-left: 24px; margin: 8px 0; }
    .page-content li { margin: 4px 0; }
    .page-content code { background: var(--bg); padding: 2px 5px; border-radius: 3px; font-size: 13px; color: var(--accent); }
    .page-content pre { background: var(--bg); padding: 14px; border-radius: 8px; overflow-x: auto; margin: 12px 0; border: 1px solid var(--border); }
    .page-content pre code { background: none; padding: 0; color: var(--text); }
    .page-content a { color: var(--accent); text-decoration: none; }
    .page-content a:hover { text-decoration: underline; }
    .page-content blockquote { border-left: 3px solid var(--accent); padding-left: 14px; color: var(--text-dim); margin: 10px 0; }
    .wiki-link { color: var(--accent); cursor: pointer; border-bottom: 1px dashed var(--accent); }
    .wiki-link:hover { color: var(--white); }

    /* Links sections */
    .page-links { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 24px; }
    .link-section { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 14px; }
    .link-section h3 { font-size: 12px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
    .link-item { font-size: 13px; color: var(--accent); cursor: pointer; padding: 3px 0; }
    .link-item:hover { color: var(--white); }

    /* Edit mode */
    .edit-area {
      width: 100%; min-height: 400px; padding: 14px; background: var(--bg); border: 1px solid var(--border);
      border-radius: 8px; color: var(--white); font-size: 14px; font-family: 'SF Mono', 'Fira Code', monospace;
      outline: none; resize: vertical; line-height: 1.6;
    }
    .edit-area:focus { border-color: var(--accent); }
    .edit-toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
    .btn-secondary {
      padding: 8px 16px; background: var(--border); border: 1px solid #3a3a3a; border-radius: 6px;
      color: var(--text); font-size: 13px; cursor: pointer; transition: all 0.15s;
    }
    .btn-secondary:hover { background: #3a3a3a; color: var(--white); }

    .empty { color: var(--text-faint); font-style: italic; padding: 16px 0; font-size: 13px; }

    /* Graph view */
    .graph-toolbar {
      display: flex; gap: 8px; align-items: center; padding: 12px 0; flex-wrap: wrap;
    }
    .graph-filter-btn {
      padding: 6px 14px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px;
      color: var(--text-dim); font-size: 12px; cursor: pointer; transition: all 0.15s;
    }
    .graph-filter-btn:hover { border-color: var(--text-dim); color: var(--text); }
    .graph-filter-btn.active { border-color: var(--accent); color: var(--accent); background: rgba(212,168,83,0.1); }
    .graph-stats-overlay {
      position: absolute; top: 12px; left: 12px; background: rgba(18,18,22,0.92);
      border: 1px solid var(--border); border-radius: 10px; padding: 16px 20px; font-size: 12px;
      pointer-events: none; z-index: 10; backdrop-filter: blur(8px); min-width: 180px;
    }
    .graph-stats-overlay .gs-row { display: flex; justify-content: space-between; gap: 20px; margin-bottom: 5px; }
    .graph-stats-overlay .gs-label { color: var(--text-dim); }
    .graph-stats-overlay .gs-val { color: var(--white); font-weight: 600; }
    .graph-tooltip {
      position: absolute; background: rgba(18,18,22,0.96); border: 1px solid var(--border);
      border-radius: 8px; padding: 10px 14px; font-size: 12px; pointer-events: none;
      z-index: 20; display: none; max-width: 260px; backdrop-filter: blur(8px);
      box-shadow: 0 4px 20px rgba(0,0,0,0.4);
    }
    .graph-tooltip .gt-title { color: var(--white); font-weight: 600; font-size: 13px; }
    .graph-tooltip .gt-meta { color: var(--text-dim); margin-top: 3px; }
    .graph-tooltip .gt-links { color: var(--accent); margin-top: 3px; font-size: 11px; }
    .graph-container { position: relative; width: 100%; flex: 1; overflow: hidden; background: #0C0C0E; }
    .graph-canvas { display: block; width: 100%; height: 100%; cursor: grab; }
    .graph-canvas:active { cursor: grabbing; }
    /* Graph controls panel */
    .graph-controls {
      position: absolute; top: 12px; right: 12px; background: rgba(18,18,22,0.92);
      border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; font-size: 12px;
      z-index: 10; backdrop-filter: blur(8px); min-width: 220px; max-width: 260px;
    }
    .graph-controls label { display: flex; align-items: center; gap: 6px; color: var(--text-dim); margin-bottom: 6px; cursor: pointer; }
    .graph-controls label:hover { color: var(--text); }
    .graph-controls input[type=checkbox] { accent-color: var(--accent); }
    .graph-controls input[type=range] { width: 100%; accent-color: var(--accent); }
    .graph-controls .gc-section { margin-bottom: 12px; }
    .graph-controls .gc-section-title { color: var(--text-dim); font-size: 10px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
    .graph-controls .gc-search { width: 100%; padding: 6px 10px; background: rgba(255,255,255,0.06); border: 1px solid var(--border); border-radius: 6px; color: var(--white); font-size: 12px; outline: none; }
    .graph-controls .gc-search:focus { border-color: var(--accent); }
    .graph-controls .gc-search::placeholder { color: var(--text-faint); }
    .graph-explore-badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; background: rgba(212,168,83,0.15); border: 1px solid var(--accent); border-radius: 6px; color: var(--accent); font-size: 11px; margin-top: 6px; }
    .graph-explore-badge button { background: none; border: none; color: var(--accent); cursor: pointer; font-size: 13px; padding: 0 2px; }
    /* Graph info panel (right slide-in) */
    .graph-info-panel {
      position: absolute; top: 0; right: 0; width: 320px; height: 100%; background: rgba(18,18,22,0.96);
      border-left: 1px solid var(--border); z-index: 30; padding: 20px; overflow-y: auto;
      transform: translateX(100%); transition: transform 0.25s ease; backdrop-filter: blur(12px);
      box-shadow: -4px 0 24px rgba(0,0,0,0.4);
    }
    .graph-info-panel.open { transform: translateX(0); }
    .graph-info-panel .gip-close { position: absolute; top: 12px; right: 12px; background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 18px; }
    .graph-info-panel .gip-close:hover { color: var(--white); }
    .graph-info-panel .gip-title { color: var(--white); font-size: 18px; font-weight: 700; margin-bottom: 4px; padding-right: 30px; }
    .graph-info-panel .gip-type { color: var(--text-dim); font-size: 12px; margin-bottom: 12px; }
    .graph-info-panel .gip-summary { color: var(--text); font-size: 13px; line-height: 1.5; margin-bottom: 16px; }
    .graph-info-panel .gip-section-title { color: var(--text-dim); font-size: 10px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; margin-top: 14px; }
    .graph-info-panel .gip-link { color: var(--accent); font-size: 12px; cursor: pointer; padding: 3px 0; display: block; }
    .graph-info-panel .gip-link:hover { text-decoration: underline; }
    .graph-info-panel .gip-actions { display: flex; gap: 8px; margin-top: 16px; }
    .graph-info-panel .gip-btn { padding: 8px 16px; border-radius: 6px; font-size: 12px; cursor: pointer; border: none; font-weight: 600; }
    .graph-info-panel .gip-btn-primary { background: var(--accent); color: #fff; }
    .graph-info-panel .gip-btn-primary:hover { background: #3d8ce8; }
    .graph-info-panel .gip-btn-secondary { background: rgba(255,255,255,0.08); color: var(--text); border: 1px solid var(--border); }
    .graph-info-panel .gip-btn-secondary:hover { background: rgba(255,255,255,0.12); }

    /* Two-column dashboard grid */
    .dash-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .dash-grid .full-width { grid-column: 1 / -1; }

    /* Search highlight */
    mark { background: rgba(212,168,83,0.25); color: var(--white); padding: 0 2px; border-radius: 2px; }

    /* Loading spinner */
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Ideas Lab */
    .ideas-grid { display: grid; grid-template-columns: 1fr; gap: 20px; margin-bottom: 28px; }
    @media (min-width: 900px) { .ideas-grid { grid-template-columns: 1fr 1fr 1fr; } }
    .idea-card {
      background: var(--bg-hover); border: none; border-radius: 0 6px 6px 0;
      padding: 20px; border-left: 3px solid var(--accent); position: relative;
      transition: box-shadow 0.2s;
    }
    .idea-card:hover { box-shadow: 0 4px 20px rgba(212,168,83,0.1); }
    .idea-card-title { font-family: var(--font-serif); font-size: 16px; font-weight: 400; color: var(--white); margin-bottom: 4px; }
    .idea-card-tagline { font-size: 13px; color: var(--accent); margin-bottom: 12px; font-style: italic; }
    .idea-card-desc { font-size: 13px; color: var(--text); line-height: 1.6; margin-bottom: 12px; }
    .idea-card-section { margin-bottom: 10px; }
    .idea-card-section-label { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
    .idea-card-connection { font-size: 12px; color: var(--text-dim); line-height: 1.5; padding: 8px 10px; background: var(--bg); border-radius: 6px; }
    .idea-badge {
      display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px;
      font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; margin-right: 6px;
    }
    .idea-badge-weekend { background: rgba(74,175,124,0.15); color: var(--green); }
    .idea-badge-week { background: rgba(212,168,83,0.15); color: var(--amber); }
    .idea-badge-month { background: rgba(204,68,85,0.15); color: var(--red); }
    .idea-badge-high { background: rgba(212,168,83,0.15); color: var(--accent); }
    .idea-badge-medium { background: rgba(91,141,239,0.15); color: var(--blue); }
    .idea-badge-low { background: rgba(74,175,124,0.15); color: var(--green); }
    .idea-inspiration { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
    .idea-inspiration-link {
      font-size: 11px; color: var(--accent); cursor: pointer; padding: 2px 8px;
      background: rgba(212,168,83,0.08); border-radius: 4px; border: 1px solid rgba(212,168,83,0.2);
    }
    .idea-inspiration-link:hover { background: rgba(212,168,83,0.15); }
    .idea-card-actions { display: flex; gap: 8px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
    .idea-first-step { font-size: 12px; color: var(--text); padding: 8px 10px; background: var(--bg); border-radius: 6px; border-left: 3px solid var(--green); }
    .connections-section { background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px; padding: 18px; }
    .connection-item { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
    .connection-item:last-child { border-bottom: none; }
    .connection-arrow { color: var(--text-faint); font-size: 11px; }
    .connection-via { color: var(--purple); font-size: 11px; padding: 1px 6px; background: rgba(155,125,207,0.1); border-radius: 3px; }
    .connection-insight { color: var(--text-dim); font-size: 12px; margin-left: auto; max-width: 50%; text-align: right; }

    /* Think Mode */
    .think-section { background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px; padding: 22px; margin-bottom: 20px; }
    .think-section h2 { font-family: var(--font-serif); font-size: 20px; font-weight: 400; color: var(--white); margin-bottom: 4px; }
    .think-section .think-sub { font-size: 12px; color: var(--text-dim); margin-bottom: 16px; }
    .algo-card {
      background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 16px;
      margin-bottom: 10px; cursor: pointer; transition: border-color 0.15s;
    }
    .algo-card:hover { border-color: var(--accent); }
    .algo-card-title { font-weight: 600; font-size: 14px; color: var(--white); margin-bottom: 4px; }
    .algo-card-desc { font-size: 12px; color: var(--text-dim); line-height: 1.5; }
    .algo-card-icon { font-size: 20px; float: left; margin-right: 12px; margin-top: 2px; }
    .resurface-card {
      background: rgba(212,168,83,0.06); border: 1px solid rgba(212,168,83,0.2); border-radius: 6px;
      padding: 14px 16px; margin-bottom: 8px; cursor: pointer; transition: all 0.15s;
    }
    .resurface-card:hover { background: rgba(212,168,83,0.12); border-color: var(--accent); }
    .resurface-title { font-weight: 600; font-size: 13px; color: var(--white); margin-bottom: 3px; }
    .resurface-excerpt { font-size: 12px; color: var(--text-dim); line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .resurface-reason { font-size: 11px; color: var(--accent); margin-top: 4px; font-style: italic; }
    .thought-input { width: 100%; padding: 12px 16px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; color: var(--white); font-size: 14px; font-family: var(--font); outline: none; min-height: 80px; resize: vertical; }
    .thought-input:focus { border-color: var(--accent); }
    .thought-input::placeholder { color: var(--text-faint); }

    /* Cockpit — Universal Input Bar */
    .cockpit-input-wrap {
      background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px;
      padding: 6px; margin-bottom: 28px; transition: border-color 0.15s;
    }
    .cockpit-input-wrap:hover { border-color: rgba(212,168,83,0.3); }
    .cockpit-input-wrap:focus-within { border-color: var(--accent); }
    .cockpit-input {
      width: 100%; height: 48px; padding: 0 18px; background: transparent; border: none;
      color: var(--white); font-size: 14px; font-family: var(--font); outline: none;
    }
    .cockpit-input::placeholder { color: var(--text-dim); }
    .cockpit-actions { display: flex; gap: 8px; padding: 6px 6px 2px; }
    .cockpit-actions .btn-primary { font-size: 13px; padding: 8px 16px; }
    .cockpit-status { font-size: 12px; padding: 4px 12px 2px; min-height: 20px; }
    .cockpit-status.ok { color: var(--green); }
    .cockpit-status.err { color: var(--red); }
    .cockpit-detect { font-size: 11px; color: var(--text-dim); padding: 2px 12px; }

    /* Cockpit — Ideas Preview */
    .cockpit-ideas-row { display: flex; flex-direction: column; gap: 0; margin-bottom: 28px; }
    .cockpit-idea-card {
      background: var(--bg-hover); border-left: 3px solid var(--accent); border-radius: 0 6px 6px 0;
      padding: 14px 16px; transition: box-shadow 0.2s;
    }
    .cockpit-idea-card:hover { box-shadow: 0 4px 20px rgba(212,168,83,0.08); }
    .cockpit-idea-title { font-family: var(--font-serif); font-size: 15px; font-weight: 400; color: var(--white); margin-bottom: 2px; }
    .cockpit-idea-tagline { font-size: 12px; color: var(--accent); font-style: italic; margin-bottom: 8px; }
    .cockpit-idea-desc { font-size: 12px; color: var(--text); line-height: 1.5; margin-bottom: 10px;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .cockpit-idea-badges { margin-bottom: 8px; }
    .cockpit-idea-actions { display: flex; gap: 6px; padding-top: 10px; border-top: 1px solid var(--border); }

    /* Cockpit — Knowledge Pulse 2-col */
    .cockpit-pulse { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 28px; }
    .cockpit-pulse-col { }
    .cockpit-stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 14px; }
    .cockpit-stat-card {
      background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px; padding: 20px;
    }
    .cockpit-stat-val { font-family: var(--font-serif); font-size: 42px; font-weight: 400; color: var(--white); line-height: 1; letter-spacing: -0.02em; }
    .cockpit-stat-lbl { font-size: 12px; color: var(--text-dim); margin-top: 6px; }
    .cockpit-stat-delta { font-size: 11px; color: var(--green); margin-top: 4px; font-weight: 500; }
    .cockpit-health-gauge { height: 6px; background: var(--border); border-radius: 3px; margin-top: 6px; overflow: hidden; }
    .cockpit-health-fill { height: 100%; border-radius: 3px; transition: width 0.6s ease; }
    .cockpit-changed-today { font-size: 12px; color: var(--text-dim); margin-top: 8px; padding: 8px 12px; background: var(--bg); border-radius: 6px; }

    /* Mini graph */
    .cockpit-mini-graph-wrap {
      background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
      overflow: hidden; cursor: pointer; position: relative;
    }
    [data-theme="light"] .cockpit-mini-graph-wrap { background: #FAFAF8; }
    .cockpit-mini-graph-canvas { display: block; width: 100%; height: 250px; }
    .cockpit-mini-graph-label {
      position: absolute; bottom: 8px; right: 10px; font-size: 10px; color: var(--text-faint);
      background: rgba(0,0,0,0.5); padding: 2px 8px; border-radius: 4px;
    }
    [data-theme="light"] .cockpit-mini-graph-label { background: rgba(255,255,255,0.7); }

    /* Discoveries */
    .cockpit-disc-card {
      display: flex; align-items: center; gap: 8px; padding: 10px 12px;
      background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px;
      margin-bottom: 8px; font-size: 13px; cursor: pointer; transition: border-color 0.15s;
    }
    .cockpit-disc-card:hover { border-color: var(--accent); }
    .cockpit-disc-arrow { color: var(--text-faint); }
    .cockpit-disc-via { color: var(--purple); font-size: 11px; padding: 1px 6px; background: rgba(155,125,207,0.1); border-radius: 3px; }

    /* Active sparks/builds */
    .cockpit-project-item {
      display: flex; align-items: center; gap: 10px; padding: 8px 12px;
      background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px;
      margin-bottom: 6px; cursor: pointer; transition: border-color 0.15s;
    }
    .cockpit-project-item:hover { border-color: var(--accent); }
    .cockpit-project-status {
      font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px;
      padding: 2px 8px; border-radius: 3px;
    }
    .cockpit-status-sparked { background: rgba(155,125,207,0.15); color: var(--purple); }
    .cockpit-status-building { background: rgba(212,168,83,0.15); color: var(--amber); }
    .cockpit-status-deployed { background: rgba(74,175,124,0.15); color: var(--green); }
    .cockpit-project-title { font-size: 13px; font-weight: 600; color: var(--white); }
    .cockpit-project-time { font-size: 11px; color: var(--text-faint); margin-left: auto; }

    /* Mobile */
    @media (max-width: 768px) {
      .hamburger { display: block; }
      .sidebar { position: fixed; left: 0; top: 0; z-index: 1000; transform: translateX(-100%); }
      .sidebar.open { transform: translateX(0); }
      .sidebar-overlay.open { display: block; }
      .main-inner { padding: 20px 16px; padding-top: 52px; }
      .dash-grid { grid-template-columns: 1fr; }
      .page-links { grid-template-columns: 1fr; }
      .stats-grid { grid-template-columns: 1fr 1fr; }
      .ideas-grid { grid-template-columns: 1fr !important; }
      .connection-item { flex-wrap: wrap; }
      .connection-insight { max-width: 100%; text-align: left; margin-left: 0; margin-top: 4px; }
      .qa-form { flex-direction: column; }
      .ingest-row { flex-direction: column; }
      .cockpit-ideas-row { flex-direction: column; }
      .cockpit-pulse { grid-template-columns: 1fr; }
      .cockpit-input { height: 42px; font-size: 16px; }
    }
  </style>
</head>
<body>
  <button class="hamburger" id="hamburger" onclick="toggleSidebar()">&#9776;</button>
  <div class="sidebar-overlay" id="sidebar-overlay" onclick="toggleSidebar()"></div>

  <aside class="sidebar" id="sidebar">
    <div class="sidebar-header">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <h1 onclick="navigateTo(null)">PKM <span style="color:var(--accent)">Wiki</span></h1>
        <button onclick="toggleTheme()" id="theme-toggle-btn" style="background:none;border:1px solid var(--border);border-radius:6px;padding:4px 8px;cursor:pointer;font-size:16px;color:var(--text);line-height:1" title="Toggle light/dark mode">&#9790;</button>
      </div>
      <div class="subtitle">Personal knowledge base</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:10px">
        <button class="sort-btn active" id="nav-dashboard" onclick="navTab('dashboard')" style="padding:6px 0;font-size:11px">&#9889; Research</button>
        <button class="sort-btn" id="nav-think" onclick="navTab('think')" style="padding:6px 0;font-size:11px">&#129504; Think</button>
        <button class="sort-btn" id="nav-graph" onclick="navTab('graph')" style="padding:6px 0;font-size:11px">&#128279; Graph</button>
        <button class="sort-btn" id="nav-ideas" onclick="navTab('ideas')" style="padding:6px 0;font-size:11px">&#128161; Ideas</button>
      </div>
    </div>
    <div class="sidebar-stats" id="sidebar-stats"></div>
    <div class="sidebar-search">
      <input type="text" id="sidebar-search-input" placeholder="Filter pages..." oninput="onSidebarSearch()" />
    </div>
    <div class="sidebar-sort">
      <button class="sort-btn active" data-sort="date" onclick="setSort('date')">Date</button>
      <button class="sort-btn" data-sort="name" onclick="setSort('name')">Name</button>
      <button class="sort-btn" data-sort="type" onclick="setSort('type')">Type</button>
    </div>
    <div class="page-list-container" id="page-list"></div>
  </aside>

  <main class="main" id="main">
    <div class="main-inner" id="main-inner"></div>
  </main>

  <script>
    // --- State ---
    let allPages = [];
    let currentSlug = null;
    let currentSort = 'date';
    let sidebarSearchQuery = '';
    let searchTimeout = null;
    let statsCache = null;
    let editMode = false;

    // --- Theme toggle ---
    function applyTheme(theme) {
      document.documentElement.dataset.theme = theme;
      var btn = document.getElementById('theme-toggle-btn');
      if (btn) btn.innerHTML = theme === 'light' ? '&#9728;' : '&#9790;';
    }
    function toggleTheme() {
      var current = document.documentElement.dataset.theme || 'dark';
      var next = current === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try { localStorage.setItem('pkm-theme', next); } catch(e) {}
    }
    (function() {
      var saved = 'dark';
      try { saved = localStorage.getItem('pkm-theme') || 'dark'; } catch(e) {}
      applyTheme(saved);
    })();

    // --- Nav tabs ---
    var currentNav = 'dashboard';
    function navTab(tab) {
      currentNav = tab;
      var nd = document.getElementById('nav-dashboard');
      var nt = document.getElementById('nav-think');
      var ng = document.getElementById('nav-graph');
      var ni = document.getElementById('nav-ideas');
      if (nd) nd.classList.toggle('active', tab === 'dashboard');
      if (nt) nt.classList.toggle('active', tab === 'think');
      if (ng) ng.classList.toggle('active', tab === 'graph');
      if (ni) ni.classList.toggle('active', tab === 'ideas');
      if (tab === 'graph') {
        loadGraphView();
      } else if (tab === 'ideas') {
        resetMainStyles();
        loadIdeasLab();
      } else if (tab === 'think') {
        resetMainStyles();
        loadThinkMode();
      } else {
        resetMainStyles();
        navigateTo(null);
      }
    }

    // Detect base path (e.g. '/pkm' when served via cafecito-ai.com/pkm/)
    var BASE = (function() {
      var p = window.location.pathname;
      // If path starts with /pkm, use /pkm as base
      if (p.startsWith('/pkm')) return '/pkm';
      return '';
    })();
    function api(path) { return BASE + path; }

    // --- Markdown Renderer ---
    // Pre-compiled regexes via RegExp constructor (avoids template literal double-escaping)
    var BT = String.fromCharCode(96);
    var RE_CODE_BLOCK = new RegExp(BT+BT+BT+'([\\\\s\\\\S]*?)'+BT+BT+BT, 'g');
    var RE_INLINE_CODE = new RegExp(BT+'([^'+BT+']+)'+BT, 'g');
    var RE_MD_LINK = new RegExp('\\\\[([^\\\\]]+)\\\\]\\\\(([^)]+)\\\\)', 'g');
    var RE_WIKI_LINK = new RegExp('\\\\[\\\\[([^\\\\]]+)\\\\]\\\\]', 'g');
    var RE_BOLD = new RegExp('[*][*](.+?)[*][*]', 'g');
    var RE_ITALIC = new RegExp('[*](.+?)[*]', 'g');
    var RE_LI_WRAP = new RegExp('(<li>.*</li>)', 'gs');
    var RE_UL_MERGE = new RegExp('</ul>\\\\s*<ul>', 'g');
    var RE_PARA = new RegExp('<p>([\\\\s\\\\S]*?)</p>', 'g');
    var RE_DOUBLE_NL = new RegExp('\\\\n\\\\n+');
    var RE_SINGLE_NL = new RegExp('\\\\n', 'g');

    function renderMarkdown(md) {
      if (!md) return '';
      var html = md;
      // Code blocks
      html = html.replace(RE_CODE_BLOCK, function(m, code) {
        return '<pre><code>' + escHtml(code.trim()) + '</code></pre>';
      });
      // Inline code
      html = html.replace(RE_INLINE_CODE, '<code>$1</code>');
      // Headers
      html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
      html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
      html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
      // Bold + Italic
      html = html.replace(RE_BOLD, '<strong>$1</strong>');
      html = html.replace(RE_ITALIC, '<em>$1</em>');
      // Links [text](url)
      html = html.replace(RE_MD_LINK, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      // Wiki links [[slug]]
      html = html.replace(RE_WIKI_LINK, function(m, slug) {
        var s = slug.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        return '<span class="wiki-link" onclick="navigateTo(' + "'" + s + "'" + ')">'+slug+'</span>';
      });
      // Blockquotes
      html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
      // Unordered lists
      html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
      html = html.replace(RE_LI_WRAP, '<ul>$1</ul>');
      html = html.replace(RE_UL_MERGE, '');
      // Paragraphs
      html = html.split(RE_DOUBLE_NL).map(function(block) {
        block = block.trim();
        if (!block) return '';
        if (/^<(h[1-3]|ul|ol|pre|blockquote|li)/.test(block)) return block;
        return '<p>' + block + '</p>';
      }).join(String.fromCharCode(10));
      // Single newlines to <br>
      html = html.replace(RE_PARA, function(m, inner) {
        return '<p>' + inner.replace(RE_SINGLE_NL, '<br>') + '</p>';
      });
      return html;
    }

    function escHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    // --- Badge helper ---
    function typeBadge(t) {
      var cls = 'type-' + (t || 'unknown');
      return '<span class="type-badge ' + cls + '">' + (t || 'page') + '</span>';
    }

    // --- Sidebar ---
    async function loadSidebarStats() {
      var res = await fetch(api('/api/stats'));
      statsCache = await res.json();
      var s = statsCache;
      document.getElementById('sidebar-stats').innerHTML =
        '<div class="sidebar-stat"><div class="val">' + s.pages + '</div><div class="lbl">Pages</div></div>' +
        '<div class="sidebar-stat"><div class="val">' + s.sources + '</div><div class="lbl">Sources</div></div>' +
        '<div class="sidebar-stat"><div class="val">' + (s.total_words||0).toLocaleString() + '</div><div class="lbl">Words</div></div>' +
        '<div class="sidebar-stat"><div class="val">' + s.health_score + '%</div><div class="lbl">Health</div></div>';
    }

    async function loadAllPages() {
      var res = await fetch(api('/api/pages?limit=500'));
      var data = await res.json();
      allPages = data.pages || [];
      renderSidebarPages();
    }

    function renderSidebarPages() {
      var pages = allPages.slice();
      // Filter
      if (sidebarSearchQuery) {
        var q = sidebarSearchQuery.toLowerCase();
        pages = pages.filter(function(p) {
          return (p.title||'').toLowerCase().includes(q) || (p.slug||'').toLowerCase().includes(q) ||
                 (p.summary||'').toLowerCase().includes(q) || (p.tags||[]).join(' ').toLowerCase().includes(q);
        });
      }
      // Sort
      if (currentSort === 'name') {
        pages.sort(function(a,b) { return (a.title||'').localeCompare(b.title||''); });
      } else if (currentSort === 'type') {
        pages.sort(function(a,b) { return (a.page_type||'').localeCompare(b.page_type||''); });
      } else {
        pages.sort(function(a,b) { return (b.updated_at||'').localeCompare(a.updated_at||''); });
      }
      var el = document.getElementById('page-list');
      if (pages.length === 0) {
        el.innerHTML = '<div class="empty" style="padding:16px">No pages found.</div>';
        return;
      }
      el.innerHTML = pages.map(function(p) {
        var active = currentSlug === p.slug ? ' active' : '';
        var title = p.title || p.slug;
        if (sidebarSearchQuery) {
          var re = new RegExp('(' + sidebarSearchQuery.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&') + ')', 'gi');
          title = title.replace(re, '<mark>$1</mark>');
        }
        return '<div class="sidebar-page' + active + '" onclick="navigateTo(&apos;' + p.slug + '&apos;)">' +
          '<div class="sp-title">' + title + '</div>' +
          '<div class="sp-meta">' + typeBadge(p.page_type) + ' <span>' + (p.word_count||0) + 'w</span></div>' +
          '</div>';
      }).join('');
    }

    function onSidebarSearch() {
      clearTimeout(searchTimeout);
      var q = document.getElementById('sidebar-search-input').value.trim();
      searchTimeout = setTimeout(function() {
        sidebarSearchQuery = q;
        renderSidebarPages();
      }, 300);
    }

    function setSort(s) {
      currentSort = s;
      document.querySelectorAll('.sort-btn').forEach(function(b) {
        b.classList.toggle('active', b.dataset.sort === s);
      });
      renderSidebarPages();
    }

    function toggleSidebar() {
      document.getElementById('sidebar').classList.toggle('open');
      document.getElementById('sidebar-overlay').classList.toggle('open');
    }

    // --- Navigation ---
    function navigateTo(slug) {
      currentSlug = slug;
      editMode = false;
      currentNav = 'dashboard';
      var navDash = document.getElementById('nav-dashboard');
      var navGraph = document.getElementById('nav-graph');
      var navIdeas = document.getElementById('nav-ideas');
      if (navDash) navDash.classList.add('active');
      if (navGraph) navGraph.classList.remove('active');
      if (navIdeas) navIdeas.classList.remove('active');
      if (slug) {
        loadPageView(slug);
      } else {
        loadDashboard();
      }
      renderSidebarPages();
      // Close mobile sidebar
      document.getElementById('sidebar').classList.remove('open');
      document.getElementById('sidebar-overlay').classList.remove('open');
      // Scroll main to top
      document.getElementById('main').scrollTop = 0;
    }

    // --- Dashboard View (Cockpit) ---
    async function loadDashboard() {
      var el = document.getElementById('main-inner');
      // Date string
      var now = new Date();
      var days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      var dateStr = days[now.getDay()] + ', ' + months[now.getMonth()] + ' ' + now.getDate() + ', ' + now.getFullYear();

      el.innerHTML =
        // 1. Header with date
        '<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:20px">' +
        '<h1 class="dash-title">Research Agent</h1>' +
        '<span style="font-size:13px;color:var(--text-dim)">' + dateStr + '</span>' +
        '</div>' +

        // 2. Input Bar (warm, clean)
        '<div class="cockpit-input-wrap">' +
        '<div style="display:flex;align-items:center;gap:12px;padding:8px 12px">' +
        '<span style="color:var(--accent);font-size:15px;flex-shrink:0">&#9672;</span>' +
        '<input class="cockpit-input" type="text" id="cockpit-input" placeholder="Paste a URL, tweet, article, idea, or service to research..." oninput="cockpitDetect()" />' +
        '</div>' +
        '<div class="cockpit-detect" id="cockpit-detect"></div>' +
        '<div class="cockpit-actions">' +
        '<button class="btn-primary" id="cockpit-research-btn" onclick="quickResearch()">&#9889; Research</button>' +
        '<button class="btn-primary" onclick="cockpitAsk()" style="background:var(--green);color:#0C0C0E">&#128269; Ask Wiki</button>' +
        '</div>' +
        '<div class="cockpit-status" id="quick-status"></div>' +
        '</div>' +
        '<div class="qa-answer" id="qa-answer" style="margin-bottom:24px"></div>' +

        // 2b. Quick Create Templates
        '<div style="margin-bottom:20px">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
        '<span style="font-size:12px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px">Quick Create</span>' +
        '<span id="briefing-toggle" class="wiki-link" style="font-size:11px;cursor:pointer" onclick="toggleBriefing()">Morning Briefing &#8594;</span>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px" id="template-grid">' +
        '</div></div>' +
        '<div id="briefing-panel" style="display:none;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:22px;margin-bottom:20px"></div>' +

        // 3. Stats Row (4 cards in a row)
        '<div class="stats-grid" style="grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:28px" id="cockpit-stats"><div class="spinner"></div></div>' +

        // 4. 60/40 Split: Ideas Lab + Knowledge Graph
        '<div style="display:grid;grid-template-columns:3fr 2fr;gap:14px;margin-bottom:28px">' +
        // Left: Connections & Second-Order Thinking
        '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:22px">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">' +
        '<h2 class="section-header" style="margin:0">Connections</h2>' +
        '<span class="wiki-link" onclick="navTab(&quot;ideas&quot;)" style="font-size:12px">Ideas Lab &#8594;</span>' +
        '</div>' +
        '<div style="font-size:12px;color:var(--text-dim);margin-bottom:16px">Pages that share hidden links through your knowledge graph</div>' +
        '<div id="cockpit-connections"></div></div>' +
        // Right: Knowledge Graph
        '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:22px">' +
        '<h2 class="section-header" style="margin:0;margin-bottom:4px">Your Knowledge Network</h2>' +
        '<div style="font-size:12px;color:var(--text-dim);margin-bottom:16px" id="graph-subtitle">Loading...</div>' +
        '<div class="cockpit-mini-graph-wrap" onclick="navTab(&quot;graph&quot;)" title="Click to expand full graph" style="margin-bottom:12px">' +
        '<canvas class="cockpit-mini-graph-canvas" id="mini-graph-canvas"></canvas>' +
        '<div class="cockpit-mini-graph-label">Click to expand</div>' +
        '</div>' +
        '<div style="display:flex;gap:16px;flex-wrap:wrap">' +
        '<div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text-dim)"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--blue)"></span>Concepts</div>' +
        '<div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text-dim)"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--green)"></span>Entities</div>' +
        '<div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text-dim)"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--purple)"></span>Projects</div>' +
        '<div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text-dim)"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--amber)"></span>Daily</div>' +
        '</div>' +
        '</div></div>' +

        // 5. Recent Activity (clean list in card)
        '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:22px;margin-bottom:28px">' +
        '<h2 class="section-header" style="margin:0;margin-bottom:4px">Recent Activity</h2>' +
        '<div style="font-size:12px;color:var(--text-dim);margin-bottom:12px">Latest changes across your wiki</div>' +
        '<div id="dash-activity"><div class="spinner"></div></div></div>' +

        // 6. Active Research & Builds
        '<div class="section"><h2 class="section-header">Active Research &amp; Builds</h2>' +
        '<div id="cockpit-projects"></div></div>' +

        // Hidden: discoveries (populated by ideas callback)
        '<div id="cockpit-discoveries" style="display:none"></div>';

      // Wire up enter key on universal input
      var cinput = document.getElementById('cockpit-input');
      if (cinput) {
        cinput.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') {
            var val = cinput.value.trim();
            if (!val) return;
            if (/\\?\\s*$/.test(val)) { cockpitAsk(); }
            else { quickResearch(); }
          }
        });
      }

      // Load all data in parallel (with error isolation)
      try {
        var statsP = loadCockpitStats().catch(function(e){console.error('stats:',e)});
        var actP = loadDashActivity().catch(function(e){console.error('activity:',e)});
        var projP = loadActiveProjects();
        var discP = loadDiscoveries();
        loadCockpitConnections();
        loadTemplates();

        await statsP;
        try { initMiniGraph(); } catch(e) { console.error('miniGraph:', e); }

        await Promise.all([actP, projP, discP].map(function(p){return p && p.catch ? p.catch(function(){}) : p}));
      } catch(e) { console.error('Dashboard data load:', e); }
    }

    function cockpitDetect() {
      var input = document.getElementById('cockpit-input');
      var detect = document.getElementById('cockpit-detect');
      var resBtn = document.getElementById('cockpit-research-btn');
      if (!input || !detect) return;
      var val = input.value.trim();
      if (!val) { detect.textContent = ''; if (resBtn) resBtn.innerHTML = '&#9889; Research'; return; }
      var isURL = /^https?:[/][/]/.test(val);
      var isQuestion = /\\?\\s*$/.test(val);
      if (isURL) {
        detect.textContent = 'URL detected — will extract knowledge + generate research synthesis';
        if (resBtn) resBtn.innerHTML = '&#9889; Research URL';
      } else if (isQuestion) {
        detect.textContent = 'Question detected — press Enter or click Ask Wiki';
        if (resBtn) resBtn.innerHTML = '&#9889; Research';
      } else {
        detect.textContent = 'Text detected — will extract entities + synthesize insights';
        if (resBtn) resBtn.innerHTML = '&#9889; Research Note';
      }
    }

    function cockpitAsk() {
      var cinput = document.getElementById('cockpit-input');
      if (!cinput) return;
      var q = cinput.value.trim();
      if (!q) return;
      // Reuse ask logic
      var box = document.getElementById('qa-answer');
      box.style.display = 'block';
      box.innerHTML = '<span class="spinner"></span> Searching wiki...';
      fetch(api('/api/query'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      }).then(function(r) { return r.json(); }).then(function(data) {
        window._lastQAAnswer = data.answer || '';
        window._lastQAQuestion = q;
        box.innerHTML = renderMarkdown(data.answer || data.error || 'No answer.') +
          (data.answer ? '<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border)"><button class="btn-secondary" onclick="fileToWiki(window._lastQAAnswer, &apos;Q&A: &apos; + window._lastQAQuestion)" style="font-size:11px">&#128190; File to Wiki</button></div>' : '');
      }).catch(function(e) {
        box.innerHTML = '<span style="color:var(--red)">Error: ' + e.message + '</span>';
      });
    }

    async function loadCockpitStats() {
      if (!statsCache) {
        var res = await fetch(api('/api/stats'));
        statsCache = await res.json();
      }
      var s = statsCache;
      var statsEl = document.getElementById('cockpit-stats');
      if (statsEl) {
        var connections = s.pages - (s.orphan_pages || 0);
        statsEl.innerHTML =
          '<div class="stat-card"><div class="value">' + s.pages.toLocaleString() + '</div><div class="label">Total Pages</div><div class="delta">+' + (s.recent_activity_7d || 0) + ' this week</div></div>' +
          '<div class="stat-card"><div class="value">' + connections.toLocaleString() + '</div><div class="label">Connections</div><div class="delta">Active links</div></div>' +
          '<div class="stat-card"><div class="value">' + s.sources + '</div><div class="label">Sources</div><div class="delta amber" style="color:var(--accent)">Ingested</div></div>' +
          '<div class="stat-card"><div class="value">' + (s.orphan_pages || 0) + '</div><div class="label">Orphan Pages</div><div class="delta" style="color:var(--text-dim)">Unlinked</div></div>';
      }
      // Update graph subtitle with page count
      var graphSub = document.getElementById('graph-subtitle');
      if (graphSub) graphSub.textContent = s.pages.toLocaleString() + ' pages. Size = connections. Color = type.';
      // no more cockpit-changed div needed
    }

    function loadCockpitConnections() {
      var el = document.getElementById('cockpit-connections');
      if (!el) return;

      // Find second-order connections from allPages (no API call)
      var slugMap = {};
      allPages.forEach(function(p) { slugMap[p.slug] = p; });

      var connections = [];
      var seen = {};

      allPages.forEach(function(p) {
        var links = p.links_to || [];
        links.forEach(function(linked) {
          var bridge = slugMap[linked];
          if (!bridge) return;
          (bridge.links_to || []).forEach(function(fof) {
            if (fof === p.slug || links.includes(fof) || !slugMap[fof]) return;
            var key = [p.slug, fof].sort().join('|');
            if (seen[key]) return;
            seen[key] = true;
            connections.push({
              from: p,
              to: slugMap[fof],
              via: bridge
            });
          });
        });
      });

      // Sort by combined backlink count (most connected first)
      connections.sort(function(a, b) {
        return ((b.from.linked_from||[]).length + (b.to.linked_from||[]).length) -
               ((a.from.linked_from||[]).length + (a.to.linked_from||[]).length);
      });

      var top = connections.slice(0, 5);

      if (top.length === 0) {
        el.innerHTML = '<div style="color:var(--text-faint);font-size:13px;padding:12px 0">Not enough connections yet. Keep ingesting content.</div>';
        return;
      }

      el.innerHTML = top.map(function(c) {
        return '<div style="padding:10px 0;border-bottom:1px solid var(--border);font-size:13px">' +
          '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
          '<span class="wiki-link" onclick="navigateTo(&quot;' + c.from.slug + '&quot;)" style="font-weight:600">' + (c.from.title||c.from.slug) + '</span>' +
          '<span style="color:var(--text-faint)">&#8596;</span>' +
          '<span class="wiki-link" onclick="navigateTo(&quot;' + c.to.slug + '&quot;)" style="font-weight:600">' + (c.to.title||c.to.slug) + '</span>' +
          '</div>' +
          '<div style="color:var(--text-dim);font-size:11px;margin-top:3px">via ' +
          '<span class="wiki-link" onclick="navigateTo(&quot;' + c.via.slug + '&quot;)">' + (c.via.title||c.via.slug) + '</span></div>' +
          '</div>';
      }).join('');
    }

    async function loadCockpitIdeas() {
      var grid = document.getElementById('cockpit-ideas');
      if (!grid) return;
      // If we already have ideas cached from Ideas Lab, use those
      if (ideasState.ideas && ideasState.ideas.length > 0) {
        renderCockpitIdeas(ideasState.ideas.slice(0, 3));
        return;
      }
      grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px"><span class="spinner"></span></div>';
      try {
        var res = await fetch(api('/api/ideas'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        var data = await res.json();
        if (data.error) throw new Error(data.error);
        ideasState.ideas = data.ideas || [];
        ideasState.connections = data.connections_found || [];
        renderCockpitIdeas(ideasState.ideas.slice(0, 3));
        renderDiscoveries(ideasState.connections);
      } catch(e) {
        grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px">' +
          '<p style="color:var(--text-dim);font-size:13px;margin-bottom:10px">' + escHtml(e.message) + '</p>' +
          '<button class="btn-primary" onclick="loadCockpitIdeas()">Generate Ideas</button></div>';
      }
    }

    function renderCockpitIdeas(ideas) {
      var grid = document.getElementById('cockpit-ideas');
      if (!grid) return;
      if (!ideas || ideas.length === 0) {
        grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:24px;color:var(--text-dim);font-size:13px">' +
          '<button class="btn-primary" onclick="loadCockpitIdeas()">Generate Ideas</button></div>';
        return;
      }
      var badgeClasses = { high: 'badge-high', medium: 'badge-med', low: 'badge-low' };
      grid.innerHTML = ideas.map(function(idea, i) {
        var badgeCls = badgeClasses[idea.potential] || 'badge-med';
        return '<div class="cockpit-idea-card" style="margin-bottom:10px">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">' +
          '<div class="cockpit-idea-title">' + escHtml(idea.title || '') + '</div>' +
          '<span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:4px;text-transform:uppercase;letter-spacing:0.04em;' +
          (idea.potential === 'high' ? 'background:rgba(212,168,83,0.15);color:var(--accent)' : idea.potential === 'low' ? 'background:rgba(74,175,124,0.15);color:var(--green)' : 'background:rgba(91,141,239,0.15);color:var(--blue)') +
          '">' + (idea.potential || 'Medium') + '</span></div>' +
          '<div style="font-size:12px;color:var(--text-dim);line-height:1.5">' + escHtml(idea.description || '') + '</div>' +
          '</div>';
      }).join('');
    }

    async function refreshCockpitIdea(index) {
      var exclude = ideasState.ideas.map(function(i) { return i.title; });
      try {
        var res = await fetch(api('/api/ideas'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ exclude: exclude }),
        });
        var data = await res.json();
        if (data.error) throw new Error(data.error);
        if (data.ideas && data.ideas.length > 0) {
          ideasState.ideas[index] = data.ideas[0];
          renderCockpitIdeas(ideasState.ideas.slice(0, 3));
        }
      } catch(e) { /* silent */ }
    }

    async function loadDiscoveries() {
      var el = document.getElementById('cockpit-discoveries');
      if (!el) return;
      // Use cached connections from ideas if available
      if (ideasState.connections && ideasState.connections.length > 0) {
        renderDiscoveries(ideasState.connections);
        return;
      }
      // Otherwise wait — they'll be populated after ideas load
      el.innerHTML = '<div class="empty">Generate ideas to discover connections.</div>';
    }

    function renderDiscoveries(connections) {
      var el = document.getElementById('cockpit-discoveries');
      if (!el) return;
      if (!connections || connections.length === 0) {
        el.innerHTML = '<div class="empty">No connections discovered yet.</div>';
        return;
      }
      var items = connections.slice(0, 5).map(function(c) {
        return '<div class="cockpit-disc-card">' +
          '<span class="wiki-link" onclick="navigateTo(&apos;' + c.from + '&apos;)">' + (c.fromTitle || c.from) + '</span>' +
          '<span class="cockpit-disc-arrow">&#8596;</span>' +
          '<span class="wiki-link" onclick="navigateTo(&apos;' + c.to + '&apos;)">' + (c.toTitle || c.to) + '</span>' +
          '<span class="cockpit-disc-via">via: ' + (c.viaTitle || c.via) + '</span>' +
          '</div>';
      }).join('');
      el.innerHTML = items +
        '<button class="btn-secondary" onclick="navTab(&quot;ideas&quot;)" style="margin-top:8px;font-size:12px">Find More Connections</button>';
    }

    function loadActiveProjects() {
      var el = document.getElementById('cockpit-projects');
      if (!el) return;
      var sparks = allPages.filter(function(p) {
        return p.slug.startsWith('spark-') || p.slug.startsWith('build-');
      }).sort(function(a, b) { return (b.updated_at || '').localeCompare(a.updated_at || ''); }).slice(0, 8);

      if (sparks.length === 0) {
        el.innerHTML = '<div class="empty">No active projects. Use Spark Agent to create one!</div>';
        return;
      }
      el.innerHTML = sparks.map(function(p) {
        var isBuild = p.slug.startsWith('build-');
        var statusClass = isBuild ? 'cockpit-status-building' : 'cockpit-status-sparked';
        var statusText = isBuild ? 'building' : 'sparked';
        var d = p.updated_at ? new Date(p.updated_at + 'Z') : null;
        var timeStr = d ? d.toLocaleDateString() : '';
        return '<div class="cockpit-project-item" onclick="navigateTo(&apos;' + p.slug + '&apos;)">' +
          '<span class="cockpit-project-status ' + statusClass + '">' + statusText + '</span>' +
          '<span class="cockpit-project-title">' + (p.title || p.slug) + '</span>' +
          '<span class="cockpit-project-time">' + timeStr + '</span></div>';
      }).join('');
    }

    // --- Template Quick Create ---
    async function loadTemplates() {
      var el = document.getElementById('template-grid');
      if (!el) return;
      try {
        var resp = await fetch('/api/templates');
        var templates = await resp.json();
        el.innerHTML = templates.map(function(t) {
          return '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:10px 8px;cursor:pointer;text-align:center;transition:border-color 0.15s" ' +
            'onmouseenter="this.style.borderColor=&apos;var(--accent)&apos;" onmouseleave="this.style.borderColor=&apos;var(--border)&apos;" ' +
            'onclick="createFromTemplate(&apos;' + t.id + '&apos;,&apos;' + t.name + '&apos;)">' +
            '<div style="font-size:20px;margin-bottom:4px">' + t.icon + '</div>' +
            '<div style="font-size:11px;font-weight:600;color:var(--white)">' + t.name + '</div>' +
            '</div>';
        }).join('');
      } catch(e) {
        el.innerHTML = '<div style="color:var(--text-dim);font-size:12px">Failed to load templates</div>';
      }
    }

    async function createFromTemplate(templateId, templateName) {
      var title = prompt('Title for new ' + templateName + ':');
      if (!title || !title.trim()) return;
      try {
        var resp = await fetch('/api/templates/create', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ template_id: templateId, title: title.trim() })
        });
        var result = await resp.json();
        if (result.slug) {
          navigateTo(result.slug);
        } else {
          alert(result.error || 'Failed to create page');
        }
      } catch(e) {
        alert('Error creating page: ' + e.message);
      }
    }
    window.createFromTemplate = createFromTemplate;

    // --- Morning Briefing ---
    var briefingLoaded = false;
    async function toggleBriefing() {
      var panel = document.getElementById('briefing-panel');
      if (!panel) return;
      if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
      panel.style.display = 'block';
      if (briefingLoaded) return;
      panel.innerHTML = '<div class="spinner"></div>';
      try {
        var resp = await fetch('/api/briefing');
        var b = await resp.json();
        briefingLoaded = true;
        var staleHtml = (b.stale_but_important || []).map(function(p) {
          return '<div style="display:flex;justify-content:space-between;padding:4px 0;cursor:pointer" onclick="navigateTo(&apos;' + p.slug + '&apos;)">' +
            '<span style="color:var(--white);font-size:13px">' + (p.title || p.slug).slice(0, 30) + '</span>' +
            '<span style="color:var(--text-dim);font-size:11px">' + p.backlinks + ' links, ' + (p.updated_at || '').slice(0, 10) + '</span></div>';
        }).join('') || '<div style="color:var(--text-dim);font-size:12px">All important pages are fresh</div>';

        var insightHtml = '';
        if (b.random_insight) {
          var ri = b.random_insight;
          insightHtml = '<div style="background:rgba(212,168,83,0.08);border:1px solid rgba(212,168,83,0.2);border-radius:6px;padding:12px;margin-bottom:14px">' +
            '<div style="font-size:11px;color:var(--amber);font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Random Insight</div>' +
            '<div style="font-size:14px;font-weight:600;color:var(--white);cursor:pointer" onclick="navigateTo(&apos;' + ri.page.slug + '&apos;)">' + ri.page.title + '</div>' +
            '<div style="font-size:12px;color:var(--text-dim);margin-top:4px">' + (ri.summary || '').slice(0, 120) + '</div>' +
            '<div style="font-size:11px;color:var(--text-dim);margin-top:6px">Connects to: ' + (ri.connects_to || []).slice(0, 3).join(', ') + '</div>' +
            '</div>';
        }

        var peopleHtml = (b.people_to_revisit || []).map(function(p) {
          return '<span style="font-size:12px;padding:3px 8px;background:var(--bg-hover);border-radius:10px;cursor:pointer;color:var(--white)" onclick="navigateTo(&apos;' + p.slug + '&apos;)">' + (p.title || p.slug).slice(0, 20) + '</span>';
        }).join(' ') || '<span style="color:var(--text-dim);font-size:12px">No people pages tagged yet</span>';

        panel.innerHTML =
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">' +
          '<div><div style="font-size:18px;font-weight:700;color:var(--white)">' + b.greeting + '</div>' +
          '<div style="font-size:12px;color:var(--text-dim);margin-top:2px">' + b.stats.total_pages + ' pages, ' + b.stats.total_sources + ' sources, ' + b.stats.orphan_pages + ' orphans</div></div>' +
          '<button style="background:none;border:none;color:var(--text-dim);font-size:18px;cursor:pointer" onclick="document.getElementById(&apos;briefing-panel&apos;).style.display=&apos;none&apos;">&times;</button></div>' +
          insightHtml +
          '<div style="margin-bottom:14px"><div style="font-size:11px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Stale but Important</div>' + staleHtml + '</div>' +
          '<div><div style="font-size:11px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">People to Revisit</div><div style="display:flex;flex-wrap:wrap;gap:6px">' + peopleHtml + '</div></div>';
      } catch(e) {
        panel.innerHTML = '<div style="color:var(--text-dim)">Failed to load briefing: ' + e.message + '</div>';
      }
    }
    window.toggleBriefing = toggleBriefing;

    function initMiniGraph() {
      var canvas = document.getElementById('mini-graph-canvas');
      if (!canvas) return;
      var wrap = canvas.parentElement;
      var W = wrap.clientWidth || 300;
      var H = 250;
      canvas.width = W * window.devicePixelRatio;
      canvas.height = H * window.devicePixelRatio;
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      var ctx = canvas.getContext('2d');
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

      var typeColors = { concept: '#5B8DEF', entity: '#4AAF7C', project: '#9B7DCF', daily: '#D4A853', index: '#7A7870' };
      var slugMap = {};

      // Top 50 most connected nodes
      var sorted = allPages.slice().sort(function(a, b) {
        return ((b.linked_from||[]).length + (b.links_to||[]).length) -
               ((a.linked_from||[]).length + (a.links_to||[]).length);
      }).slice(0, 50);

      var nodes = [];
      sorted.forEach(function(p, i) {
        var backlinks = (p.linked_from || []).length;
        var r = Math.max(3, Math.min(12, 3 + backlinks * 1.5));
        var angle = (i / sorted.length) * Math.PI * 2;
        var spread = Math.min(W, H) * 0.32;
        nodes.push({
          slug: p.slug, title: p.title || p.slug, type: p.page_type || 'unknown',
          linksTo: p.links_to || [],
          x: W / 2 + Math.cos(angle) * spread * (0.5 + Math.random() * 0.5),
          y: H / 2 + Math.sin(angle) * spread * (0.5 + Math.random() * 0.5),
          vx: 0, vy: 0, r: r,
          color: typeColors[p.page_type] || '#6b7280'
        });
        slugMap[p.slug] = nodes.length - 1;
      });

      var edges = [];
      var edgeSet = {};
      nodes.forEach(function(n) {
        (n.linksTo || []).forEach(function(link) {
          var ts = link.toLowerCase().replace(/\\s+/g, '-');
          if (slugMap[ts] !== undefined) {
            var key = n.slug < ts ? n.slug + '|' + ts : ts + '|' + n.slug;
            if (!edgeSet[key]) { edgeSet[key] = true; edges.push({ s: slugMap[n.slug], t: slugMap[ts] }); }
          }
        });
      });

      var frameCount = 0;
      function sim() {
        var alpha = Math.max(0.001, 1 - frameCount / 200);
        var N = nodes.length;
        for (var i = 0; i < N; i++) {
          for (var j = i + 1; j < N; j++) {
            var dx = nodes[j].x - nodes[i].x, dy = nodes[j].y - nodes[i].y;
            var d2 = dx * dx + dy * dy; if (d2 < 1) d2 = 1;
            var d = Math.sqrt(d2);
            var f = 400 / d2 * alpha;
            var fx = (dx / d) * f, fy = (dy / d) * f;
            nodes[i].vx -= fx; nodes[i].vy -= fy;
            nodes[j].vx += fx; nodes[j].vy += fy;
          }
        }
        edges.forEach(function(e) {
          var s = nodes[e.s], t = nodes[e.t];
          var dx = t.x - s.x, dy = t.y - s.y;
          var d = Math.sqrt(dx * dx + dy * dy) || 1;
          var f = (d - 50) * 0.004 * alpha;
          var fx = (dx / d) * f, fy = (dy / d) * f;
          s.vx += fx; s.vy += fy; t.vx -= fx; t.vy -= fy;
        });
        var cx = W / 2, cy = H / 2;
        nodes.forEach(function(n) {
          n.vx += (cx - n.x) * 0.001 * alpha;
          n.vy += (cy - n.y) * 0.001 * alpha;
          n.vx *= 0.85; n.vy *= 0.85;
          n.x += n.vx; n.y += n.vy;
          n.x = Math.max(n.r, Math.min(W - n.r, n.x));
          n.y = Math.max(n.r, Math.min(H - n.r, n.y));
        });
        frameCount++;
      }

      function draw() {
        ctx.clearRect(0, 0, W, H);
        ctx.lineWidth = 0.5;
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        edges.forEach(function(e) {
          ctx.beginPath();
          ctx.moveTo(nodes[e.s].x, nodes[e.s].y);
          ctx.lineTo(nodes[e.t].x, nodes[e.t].y);
          ctx.stroke();
        });
        nodes.forEach(function(n) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
          ctx.fillStyle = n.color;
          ctx.globalAlpha = 0.85;
          ctx.fill();
          // Glow
          ctx.shadowColor = n.color;
          ctx.shadowBlur = 6;
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.globalAlpha = 1;
        });
      }

      var miniActive = true;
      function loop() {
        if (!document.getElementById('mini-graph-canvas')) { miniActive = false; return; }
        if (frameCount < 220) sim();
        draw();
        if (miniActive) requestAnimationFrame(loop);
      }
      loop();
    }

    function statCard(val, label, extra) {
      return '<div class="stat-card"><div class="value">' + val + '</div><div class="label">' + label + '</div>' + (extra||'') + '</div>';
    }

    async function loadDashActivity() {
      var res = await fetch(api('/api/log?limit=10'));
      var data = await res.json();
      var el = document.getElementById('dash-activity');
      if (!el) return;
      if (!data.log || data.log.length === 0) {
        el.innerHTML = '<div class="empty">No activity yet.</div>';
        return;
      }
      el.innerHTML = data.log.map(function(l) {
        var pages = (l.pages_touched || []).map(function(p) {
          return '<span class="wiki-link" onclick="navigateTo(&apos;' + p + '&apos;)">' + p + '</span>';
        }).join(', ');
        var d = l.created_at ? new Date(l.created_at+'Z') : null;
        var timeStr = d ? d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '';
        return '<div class="activity-item"><span class="activity-action">' + l.action + '</span>' +
          '<span class="activity-pages">' + pages + '</span>' +
          '<span class="activity-time">' + timeStr + '</span></div>';
      }).join('');
    }

    function loadTopEntities() {
      var el = document.getElementById('dash-entities');
      if (!el) return;
      // Sort pages by backlink count
      var sorted = allPages.slice().sort(function(a,b) {
        return (b.linked_from||[]).length - (a.linked_from||[]).length;
      }).filter(function(p) { return (p.linked_from||[]).length > 0; }).slice(0, 10);
      if (sorted.length === 0) {
        el.innerHTML = '<div class="empty">No connected pages yet.</div>';
        return;
      }
      el.innerHTML = sorted.map(function(p) {
        return '<li class="entity-item" onclick="navigateTo(&apos;' + p.slug + '&apos;)">' +
          '<span class="entity-name">' + (p.title||p.slug) + '</span>' +
          '<span class="entity-count">' + (p.linked_from||[]).length + ' backlinks</span></li>';
      }).join('');
    }

    async function askQuestion() {
      var input = document.getElementById('qa-input') || document.getElementById('cockpit-input');
      var btn = document.getElementById('qa-btn');
      var box = document.getElementById('qa-answer');
      if (!input || !box) return;
      var q = input.value.trim();
      if (!q) return;
      if (btn) { btn.disabled = true; btn.textContent = 'Thinking...'; }
      box.style.display = 'block';
      box.innerHTML = '<span class="spinner"></span> Searching wiki...';
      try {
        var res = await fetch(api('/api/query'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: q }),
        });
        var data = await res.json();
        var answer = data.answer || data.error || 'No answer.';
        box.innerHTML = renderMarkdown(answer);
      } catch (e) {
        box.innerHTML = '<span style="color:var(--red)">Error: ' + e.message + '</span>';
      }
      if (btn) { btn.disabled = false; btn.textContent = 'Ask'; }
    }

    async function quickResearch() {
      var input = document.getElementById('cockpit-input') || document.getElementById('quick-url');
      var status = document.getElementById('quick-status');
      var resBtn = document.getElementById('cockpit-research-btn');
      var qaBox = document.getElementById('qa-answer');
      var val = input.value.trim();
      if (!val) { status.className = 'cockpit-status err'; status.textContent = 'Enter a URL, note, or idea.'; return; }

      if (resBtn) { resBtn.disabled = true; resBtn.innerHTML = '<span class="spinner"></span> Ingesting...'; }
      status.className = 'cockpit-status';
      status.innerHTML = '<span class="spinner"></span> Step 1/2: Extracting knowledge...';
      if (qaBox) qaBox.style.display = 'none';

      var isURL = /^https?:[/][/]/.test(val);

      try {
        // Step 1: Fast ingest (reliable — uses proven ingest pipeline)
        var ingestRes;
        if (isURL) {
          ingestRes = await fetch(api('/api/ingest/url'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: val }),
          });
        } else {
          var timestamp = new Date().toISOString().slice(0, 10);
          ingestRes = await fetch(api('/api/ingest'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              filename: 'intake-' + timestamp + '-' + Date.now() + '.md',
              content: val,
              source_type: 'note'
            }),
          });
        }
        var ingestData = await ingestRes.json();
        if (ingestData.error) {
          status.className = 'cockpit-status err';
          status.textContent = 'Ingest error: ' + ingestData.error;
          if (resBtn) { resBtn.disabled = false; resBtn.innerHTML = '&#9889; Research'; }
          return;
        }

        var created = (ingestData.pages_created || []);
        var updated = (ingestData.pages_updated || []);
        var allSlugs = created.concat(updated);
        status.innerHTML = '<span class="spinner"></span> Step 2/2: Finding connections to prior knowledge... (' + ingestData.entities_extracted + ' entities found)';
        if (resBtn) resBtn.innerHTML = '<span class="spinner"></span> Connecting...';

        // Step 2: Find related pages from prior knowledge
        var relatedHtml = '';
        if (allSlugs.length > 0) {
          // Fetch the created/updated pages to get their links
          var relatedPages = [];
          for (var si = 0; si < Math.min(allSlugs.length, 3); si++) {
            try {
              var pageRes = await fetch(api('/api/pages/' + allSlugs[si]));
              var pageData = await pageRes.json();
              if (pageData.links_to) {
                pageData.links_to.forEach(function(link) {
                  if (relatedPages.indexOf(link) === -1 && allSlugs.indexOf(link) === -1) relatedPages.push(link);
                });
              }
              if (pageData.linked_from) {
                pageData.linked_from.forEach(function(link) {
                  if (relatedPages.indexOf(link) === -1 && allSlugs.indexOf(link) === -1) relatedPages.push(link);
                });
              }
            } catch(e) {}
          }

          // Also find second-order connections from allPages cache
          var slugMap = {};
          allPages.forEach(function(p) { slugMap[p.slug] = p; });
          allSlugs.forEach(function(slug) {
            var page = slugMap[slug];
            if (!page) return;
            (page.links_to || []).forEach(function(linked) {
              var bridge = slugMap[linked];
              if (!bridge) return;
              (bridge.links_to || []).forEach(function(fof) {
                if (allSlugs.indexOf(fof) === -1 && relatedPages.indexOf(fof) === -1 && slugMap[fof]) {
                  relatedPages.push(fof);
                }
              });
            });
          });

          if (relatedPages.length > 0) {
            relatedHtml = '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">' +
              '<div style="font-size:12px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Connected Prior Knowledge</div>' +
              relatedPages.slice(0, 8).map(function(slug) {
                var p = slugMap[slug];
                var title = p ? (p.title || slug) : slug;
                var summary = p ? (p.summary || '').slice(0, 80) : '';
                return '<div style="padding:6px 0;border-bottom:1px solid var(--border);cursor:pointer" onclick="navigateTo(&apos;' + slug + '&apos;)">' +
                  '<div style="font-size:13px;font-weight:600;color:var(--white)">' + escHtml(title) + '</div>' +
                  (summary ? '<div style="font-size:11px;color:var(--text-dim)">' + escHtml(summary) + '</div>' : '') + '</div>';
              }).join('') + '</div>';
          }
        }

        // Show results
        var msg = (isURL ? 'URL ingested! ' : 'Note saved! ') + ingestData.entities_extracted + ' entities, ' + created.length + ' pages created, ' + updated.length + ' updated.';
        if (relatedPages && relatedPages.length > 0) msg += ' ' + relatedPages.length + ' prior connections found.';
        status.className = 'cockpit-status ok';
        status.textContent = msg;

        // Show created pages + related knowledge in the answer box
        if (qaBox && (allSlugs.length > 0 || relatedHtml)) {
          qaBox.style.display = 'block';
          qaBox.innerHTML =
            '<div style="margin-bottom:8px"><strong style="color:var(--green)">Pages Created/Updated:</strong></div>' +
            allSlugs.map(function(slug) {
              return '<div style="display:inline-flex;align-items:center;gap:6px;margin:0 6px 6px 0">' +
                '<span class="wiki-link" onclick="navigateTo(&apos;' + slug + '&apos;)" style="font-size:13px">' + slug + '</span>' +
                '<button onclick="sparkFromSlug(&apos;' + slug + '&apos;)" style="background:var(--purple);color:#fff;border:none;border-radius:4px;padding:2px 8px;font-size:11px;cursor:pointer" title="Generate build plan">&#9889; Spark</button></div>';
            }).join('') +
            relatedHtml;
        }

        input.value = '';
        await loadAllPages();
        loadSidebarStats();
        statsCache = null;
      } catch (e) {
        status.className = 'cockpit-status err';
        status.textContent = 'Error: ' + e.message;
      }
      if (resBtn) { resBtn.disabled = false; resBtn.innerHTML = '&#9889; Research'; }
    }

    // Spark from a slug (quick action from ingest results)
    async function sparkFromSlug(slug) {
      var status = document.getElementById('quick-status');
      if (status) status.innerHTML = '<span class="spinner"></span> Generating build plan for ' + slug + '...';
      try {
        var res = await fetch(api('/api/spark'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug: slug }),
        });
        var data = await res.json();
        if (data.error) {
          if (status) status.innerHTML = '<span style="color:var(--red)">Spark failed: ' + data.error + '</span>';
          return;
        }
        if (status) status.innerHTML = '<span style="color:var(--green)">Build plan created!</span>';
        loadAllPages();
        statsCache = null;
        setTimeout(function() { navigateTo(data.plan_slug); }, 300);
      } catch(e) {
        if (status) status.innerHTML = '<span style="color:var(--red)">Error: ' + e.message + '</span>';
      }
    }
    window.sparkFromSlug = sparkFromSlug;

    // Legacy aliases
    var quickAdd = quickResearch;
    var quickSpark = quickResearch;

    async function researchFromPage(slug) {
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:9999';
      overlay.innerHTML = '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:32px;text-align:center;max-width:400px">' +
        '<div class="spinner" style="width:24px;height:24px;margin:0 auto 16px"></div>' +
        '<div style="color:var(--white);font-size:16px;font-weight:600">Researching</div>' +
        '<div style="color:var(--text-dim);font-size:13px;margin-top:8px">Extracting knowledge + synthesizing research insights...</div></div>';
      document.body.appendChild(overlay);

      try {
        var res = await fetch(api('/api/research'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug: slug }),
        });
        var data = await res.json();
        document.body.removeChild(overlay);

        if (data.error) {
          alert('Research failed: ' + data.error);
          return;
        }

        var msg = 'Research complete! ' + data.entities + ' entities, ' + data.pages_created + ' created, ' + data.pages_updated + ' updated.';
        if (data.research && data.research.frontier_score) msg += ' Frontier: ' + data.research.frontier_score + '/10';
        alert(msg);

        loadAllPages();
        loadSidebarStats();
        statsCache = null;
        navigateTo(slug);
      } catch (e) {
        document.body.removeChild(overlay);
        alert('Research failed: ' + e.message);
      }
    }
    // Legacy alias
    var sparkFromPage = researchFromPage;

    async function buildFromSpark(sparkSlug) {
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:9999';
      overlay.innerHTML = '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:32px;text-align:center;max-width:440px">' +
        '<div class="spinner" style="width:24px;height:24px;margin:0 auto 16px"></div>' +
        '<div style="color:var(--white);font-size:16px;font-weight:600">Building Project</div>' +
        '<div style="color:var(--text-dim);font-size:13px;margin-top:8px">Gemma 4 is generating code files...<br>This may take 30-60 seconds.</div></div>';
      document.body.appendChild(overlay);

      try {
        var res = await fetch(api('/api/build'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ spark_slug: sparkSlug }),
        });
        var data = await res.json();
        document.body.removeChild(overlay);

        if (data.error) { alert('Build failed: ' + data.error); return; }

        loadAllPages();
        loadSidebarStats();
        statsCache = null;

        // Show result
        alert('Build complete!\\n\\n' +
          'Project: ' + data.project_slug + '\\n' +
          'Files: ' + data.files_generated.join(', ') + '\\n' +
          'Status: ' + data.status + '\\n' +
          'Deploy ready: ' + data.deploy_ready);

        navigateTo('build-' + data.project_slug);
      } catch (e) {
        document.body.removeChild(overlay);
        alert('Build failed: ' + e.message);
      }
    }

    async function viewBuildFiles(projectSlug) {
      var el = document.getElementById('main-inner');
      el.innerHTML = '<h1 class="dash-title">Build Files: ' + projectSlug + '</h1>' +
        '<p class="dash-subtitle"><span class="spinner"></span> Loading files from R2...</p>';

      try {
        var res = await fetch(api('/api/build/' + projectSlug));
        var data = await res.json();

        if (!data.files || data.files.length === 0) {
          el.innerHTML = '<h1 class="dash-title">Build: ' + projectSlug + '</h1>' +
            '<p class="dash-subtitle">No files found.</p>';
          return;
        }

        var filesHtml = data.files.map(function(f) {
          return '<div style="margin-bottom:20px">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg);padding:8px 14px;border:1px solid var(--border);border-bottom:none;border-radius:8px 8px 0 0">' +
            '<span style="font-weight:600;color:var(--white);font-size:13px">' + f.path + '</span>' +
            '<button class="btn-secondary" style="font-size:11px;padding:3px 10px" onclick="copyToClipboard(this)">Copy</button></div>' +
            '<pre style="margin:0;border-radius:0 0 8px 8px;max-height:400px;overflow:auto;font-size:12px;border:1px solid var(--border)"><code>' + escHtml(f.content) + '</code></pre></div>';
        }).join('');

        el.innerHTML = '<div style="display:flex;align-items:center;gap:16px;margin-bottom:16px">' +
          '<h1 class="dash-title">Build: ' + projectSlug + '</h1>' +
          '<button class="btn-secondary" onclick="navigateTo(&apos;build-' + projectSlug + '&apos;)">Back to Plan</button></div>' +
          '<p class="dash-subtitle">' + data.files.length + ' files generated</p>' + filesHtml;
      } catch (e) {
        el.innerHTML = '<h1 class="dash-title">Error</h1><p>' + e.message + '</p>';
      }
    }

    function copyToClipboard(btn) {
      var code = btn.parentElement.nextElementSibling.querySelector('code');
      navigator.clipboard.writeText(code.textContent).then(function() {
        btn.textContent = 'Copied!';
        setTimeout(function() { btn.textContent = 'Copy'; }, 1500);
      });
    }

    function sharePage(slug, title) {
      var shareUrl = 'https://pkm.cafecito-ai.com/share/' + slug;
      if (navigator.share) {
        navigator.share({ title: title + ' — PKM Wiki', url: shareUrl }).catch(function() {});
      } else {
        navigator.clipboard.writeText(shareUrl).then(function() {
          alert('Share link copied!\\n' + shareUrl);
        });
      }
    }

    async function ingestURL() {
      var urlInput = document.getElementById('ingest-url');
      var status = document.getElementById('url-status');
      var url = urlInput.value.trim();
      if (!url) {
        status.className = 'ingest-status err';
        status.textContent = 'URL is required.';
        return;
      }
      status.className = 'ingest-status';
      status.innerHTML = '<span class="spinner"></span> Fetching and ingesting URL...';
      try {
        var res = await fetch(api('/api/ingest/url'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: url }),
        });
        var data = await res.json();
        if (data.error) {
          status.className = 'ingest-status err';
          status.textContent = 'Error: ' + data.error;
        } else {
          var created = (data.pages_created || []).length;
          var updated = (data.pages_updated || []).length;
          status.className = 'ingest-status ok';
          status.textContent = 'Ingested! ' + data.entities_extracted + ' entities extracted, ' + created + ' pages created, ' + updated + ' updated.';
          urlInput.value = '';
          loadAllPages();
          loadSidebarStats();
          statsCache = null;
        }
      } catch (e) {
        status.className = 'ingest-status err';
        status.textContent = 'Error: ' + e.message;
      }
    }

    async function ingestContent() {
      var filename = document.getElementById('ingest-filename').value.trim();
      var content = document.getElementById('ingest-content').value.trim();
      var source_type = document.getElementById('ingest-type').value;
      var status = document.getElementById('ingest-status');
      if (!filename || !content) {
        status.className = 'ingest-status err';
        status.textContent = 'Filename and content are required.';
        return;
      }
      status.className = 'ingest-status';
      status.innerHTML = '<span class="spinner"></span> Ingesting...';
      try {
        var res = await fetch(api('/api/ingest'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: filename, content: content, source_type: source_type }),
        });
        var data = await res.json();
        if (data.error) {
          status.className = 'ingest-status err';
          status.textContent = 'Error: ' + data.error;
        } else {
          status.className = 'ingest-status ok';
          status.textContent = 'Ingested successfully! Pages: ' + (data.pages_updated || []).join(', ');
          document.getElementById('ingest-filename').value = '';
          document.getElementById('ingest-content').value = '';
          // Refresh
          loadAllPages();
          loadSidebarStats();
          statsCache = null;
        }
      } catch (e) {
        status.className = 'ingest-status err';
        status.textContent = 'Error: ' + e.message;
      }
    }

    // --- Page View ---
    async function loadPageView(slug) {
      var el = document.getElementById('main-inner');
      el.innerHTML = '<div class="spinner"></div> Loading...';
      try {
        var res = await fetch(api('/api/pages/' + encodeURIComponent(slug)));
        if (!res.ok) {
          el.innerHTML = '<div class="empty">Page not found.</div>';
          return;
        }
        var page = await res.json();
        renderPageView(page);
      } catch (e) {
        el.innerHTML = '<div class="empty">Error loading page: ' + e.message + '</div>';
      }
    }

    function renderPageView(page) {
      var el = document.getElementById('main-inner');
      var tags = (page.tags || []).map(function(t) { return '<span class="page-tag">' + t + '</span>'; }).join('');
      var created = page.created_at ? new Date(page.created_at+'Z').toLocaleDateString() : '';
      var updated = page.updated_at ? new Date(page.updated_at+'Z').toLocaleDateString() : '';

      var outlinks = (page.links_to || []).map(function(l) {
        return '<div class="link-item" onclick="navigateTo(&apos;' + l.toLowerCase().replace(/\\s+/g,'-') + '&apos;)">' + l + '</div>';
      }).join('') || '<div class="empty">None</div>';

      var backlinks = (page.linked_from || []).map(function(l) {
        return '<div class="link-item" onclick="navigateTo(&apos;' + l + '&apos;)">' + l + '</div>';
      }).join('') || '<div class="empty">None</div>';

      el.innerHTML =
        '<div class="page-header">' +
        '<div class="page-header-title">' + (page.title || page.slug) + '</div>' +
        '<div class="page-header-meta">' + typeBadge(page.page_type) +
        '<span>' + (page.word_count||0) + ' words</span>' +
        (created ? '<span>Created: ' + created + '</span>' : '') +
        (updated ? '<span>Updated: ' + updated + '</span>' : '') +
        '</div>' +
        (tags ? '<div class="page-header-tags">' + tags + '</div>' : '') +
        '</div>' +
        '<div class="edit-toolbar"><button class="btn-secondary" id="edit-toggle-btn" onclick="toggleEdit(&apos;' + page.slug + '&apos;)">' +
        (editMode ? 'Preview' : 'Edit') + '</button>' +
        '<button class="btn-primary" onclick="researchFromPage(&apos;' + page.slug + '&apos;)" style="background:var(--purple);font-size:12px">&#9889; Research</button>' +
        (page.slug.startsWith('spark-') ? '<button class="btn-primary" onclick="buildFromSpark(&apos;' + page.slug + '&apos;)" style="background:var(--green);color:#0C0C0E;font-size:12px">&#9889; Build It</button>' : '') +
        (page.slug.startsWith('build-') ? '<button class="btn-primary" onclick="viewBuildFiles(&apos;' + page.slug.replace('build-','') + '&apos;)" style="background:var(--amber);color:#0C0C0E;font-size:12px">View Files</button>' : '') +
        '<button class="btn-secondary" onclick="sharePage(&apos;' + page.slug + '&apos;,&apos;' + escHtml((page.title||'').replace(/'/g,'')) + '&apos;)" style="font-size:12px">&#128279; Share</button>' +
        '</div>' +
        '<div id="page-body">' + (editMode ?
          '<textarea class="edit-area" id="edit-area">' + escHtml(page.content||'') + '</textarea>' +
          '<div style="margin-top:10px"><button class="btn-primary" onclick="savePage(&apos;' + page.slug + '&apos;)">Save</button></div>'
          :
          '<div class="page-content">' + renderMarkdown(page.content || '') + '</div>'
        ) + '</div>' +
        '<div class="page-links">' +
        '<div class="link-section"><h3>Outlinks (' + (page.links_to||[]).length + ')</h3>' + outlinks + '</div>' +
        '<div class="link-section"><h3>Backlinks (' + (page.linked_from||[]).length + ')</h3>' + backlinks + '</div>' +
        '</div>' +
        // Second-order connections for this page
        '<div style="margin-top:20px;background:rgba(212,168,83,0.04);border:1px solid rgba(212,168,83,0.15);border-radius:6px;padding:18px">' +
        '<h3 style="font-size:13px;color:var(--accent);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px">&#129504; Related Thinking</h3>' +
        '<div id="page-related-thinking"><div class="spinner"></div></div></div>';

      // Load second-order connections for this page
      setTimeout(function() { loadPageRelatedThinking(page); }, 100);
    }

    function loadPageRelatedThinking(page) {
      var el = document.getElementById('page-related-thinking');
      if (!el) return;
      var slugMap = {};
      allPages.forEach(function(p) { slugMap[p.slug] = p; });

      // Find second-order connections FROM this page
      var myLinks = page.links_to || [];
      var myBacklinks = page.linked_from || [];
      var related = [];
      var seen = {};

      // Friends-of-friends via outlinks
      myLinks.forEach(function(linked) {
        var bridge = slugMap[linked];
        if (!bridge) return;
        (bridge.links_to || []).forEach(function(fof) {
          if (fof === page.slug || myLinks.includes(fof) || !slugMap[fof] || seen[fof]) return;
          seen[fof] = true;
          related.push({ page: slugMap[fof], via: bridge, reason: 'Connected through ' + (bridge.title || linked) });
        });
      });

      // Friends-of-friends via backlinks
      myBacklinks.forEach(function(linked) {
        var bridge = slugMap[linked];
        if (!bridge) return;
        (bridge.links_to || []).forEach(function(fof) {
          if (fof === page.slug || myLinks.includes(fof) || !slugMap[fof] || seen[fof]) return;
          seen[fof] = true;
          related.push({ page: slugMap[fof], via: bridge, reason: 'Shared link from ' + (bridge.title || linked) });
        });
      });

      if (related.length === 0) {
        el.innerHTML = '<div style="font-size:12px;color:var(--text-dim)">No second-order connections found. This page needs more links.</div>';
        return;
      }

      // Sort by connection count
      related.sort(function(a, b) { return ((b.page.linked_from||[]).length) - ((a.page.linked_from||[]).length); });

      el.innerHTML = related.slice(0, 5).map(function(r) {
        return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px">' +
          '<span class="wiki-link" onclick="navigateTo(&apos;' + r.page.slug + '&apos;)" style="font-weight:600">' + escHtml(r.page.title||r.page.slug) + '</span> ' +
          typeBadge(r.page.page_type) +
          '<span style="font-size:11px;color:var(--text-dim);margin-left:auto">' + r.reason + '</span></div>';
      }).join('');
    }

    function toggleEdit(slug) {
      editMode = !editMode;
      loadPageView(slug);
    }

    async function savePage(slug) {
      var content = document.getElementById('edit-area').value;
      try {
        var res = await fetch(api('/api/pages/' + encodeURIComponent(slug)), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: content }),
        });
        var data = await res.json();
        if (data.error) {
          alert('Save failed: ' + data.error);
        } else {
          editMode = false;
          loadPageView(slug);
          loadAllPages();
        }
      } catch (e) {
        alert('Save error: ' + e.message);
      }
    }

    // --- Knowledge Graph View (Clustered, Filterable, Explorable) ---
    function loadGraphView() {
      currentSlug = null;
      currentNav = 'graph';
      document.getElementById('nav-dashboard').classList.remove('active');
      document.getElementById('nav-graph').classList.add('active');
      editMode = false;
      renderSidebarPages();
      document.getElementById('sidebar').classList.remove('open');
      document.getElementById('sidebar-overlay').classList.remove('open');

      var el = document.getElementById('main-inner');
      el.style.maxWidth = 'none';
      el.style.padding = '0';
      el.style.height = '100vh';
      el.style.display = 'flex';
      el.style.flexDirection = 'column';

      el.innerHTML =
        '<div style="padding:12px 20px;display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--border);flex-shrink:0">' +
        '<button class="btn-secondary" onclick="navTab(&quot;dashboard&quot;)" style="font-size:12px;padding:5px 12px">Back to Dashboard</button>' +
        '<span style="font-size:16px;font-weight:700;color:var(--white)">Knowledge Graph</span>' +
        '</div>' +
        '<div class="graph-container" id="graph-container">' +
        '<canvas class="graph-canvas" id="graph-canvas"></canvas>' +
        '<div class="graph-stats-overlay" id="graph-stats"></div>' +
        '<div class="graph-controls" id="graph-controls"></div>' +
        '<div class="graph-tooltip" id="graph-tooltip"></div>' +
        '<div class="graph-info-panel" id="graph-info-panel"></div>' +
        '</div>';

      initGraph();
    }

    function resetMainStyles() {
      var el = document.getElementById('main-inner');
      el.style.maxWidth = '860px';
      el.style.padding = '32px 40px';
      el.style.height = '';
      el.style.display = '';
      el.style.flexDirection = '';
    }

    var graphState = null;

    function graphFilter() {}

    function initGraph() {
      var canvas = document.getElementById('graph-canvas');
      var container = document.getElementById('graph-container');
      if (!canvas || !container) return;

      var rect = container.getBoundingClientRect();
      var W = rect.width || 800;
      var H = rect.height || 600;
      canvas.width = W * window.devicePixelRatio;
      canvas.height = H * window.devicePixelRatio;
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      var ctx = canvas.getContext('2d');
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

      // --- Data preparation ---
      var typeColors = { concept: '#5B8DEF', entity: '#4AAF7C', project: '#9B7DCF', daily: '#D4A853', index: '#7A7870' };
      var typeLabels = { concept: 'Concepts', entity: 'Entities', project: 'Projects', daily: 'Daily', index: 'Index' };

      var pageBySlug = {};
      allPages.forEach(function(p) { pageBySlug[p.slug] = p; });

      var connectionCount = {};
      allPages.forEach(function(p) {
        connectionCount[p.slug] = (p.linked_from || []).length + (p.links_to || []).length;
      });

      var filters = {
        minConnections: 2,
        types: { concept: true, entity: true, project: true, daily: false, index: false },
        search: '',
        exploreNode: null
      };
      var NODE_CAP = 300;

      function renderControls() {
        var ctrl = document.getElementById('graph-controls');
        if (!ctrl) return;
        var typeChecks = ['concept', 'entity', 'project', 'daily', 'index'].map(function(t) {
          return '<label><input type="checkbox" data-type="' + t + '" ' + (filters.types[t] ? 'checked' : '') + '>' +
            '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + typeColors[t] + '"></span> ' +
            typeLabels[t] + '</label>';
        }).join('');
        ctrl.innerHTML =
          '<div class="gc-section">' +
          '<div class="gc-section-title">Search</div>' +
          '<input type="text" class="gc-search" id="graph-search" placeholder="Find a node..." value="' + (filters.search || '') + '">' +
          '</div>' +
          '<div class="gc-section">' +
          '<div class="gc-section-title">Min Connections</div>' +
          '<div style="display:flex;align-items:center;gap:8px">' +
          '<input type="range" id="graph-min-conn" min="1" max="10" value="' + filters.minConnections + '">' +
          '<span id="graph-min-conn-val" style="color:var(--white);font-weight:600;min-width:16px">' + filters.minConnections + '</span>' +
          '</div></div>' +
          '<div class="gc-section">' +
          '<div class="gc-section-title">Node Types</div>' +
          typeChecks +
          '</div>' +
          '<div class="gc-section" style="margin-bottom:0">' +
          '<button class="btn-secondary" onclick="graphResetView()" style="font-size:11px;padding:4px 12px;width:100%">Reset View</button>' +
          '</div>' +
          (filters.exploreNode ? '<div class="graph-explore-badge">Exploring: ' + ((pageBySlug[filters.exploreNode] || {}).title || filters.exploreNode).slice(0, 20) + ' <button onclick="graphExitExplore()">x</button></div>' : '');
        var slider = document.getElementById('graph-min-conn');
        if (slider) slider.addEventListener('input', function() {
          filters.minConnections = parseInt(this.value);
          document.getElementById('graph-min-conn-val').textContent = this.value;
          rebuildGraph();
        });
        var searchBox = document.getElementById('graph-search');
        if (searchBox) searchBox.addEventListener('input', function() {
          filters.search = this.value.toLowerCase();
          rebuildGraph();
        });
        ctrl.querySelectorAll('input[data-type]').forEach(function(cb) {
          cb.addEventListener('change', function() {
            filters.types[this.dataset.type] = this.checked;
            rebuildGraph();
          });
        });
      }

      window.graphResetView = function() {
        filters.exploreNode = null; filters.minConnections = 2; filters.search = '';
        cam.x = 0; cam.y = 0; cam.zoom = 1;
        renderControls(); rebuildGraph();
      };
      window.graphExitExplore = function() {
        filters.exploreNode = null; renderControls(); rebuildGraph();
      };
      window.graphExploreNode = function(slug) {
        filters.exploreNode = slug; cam.x = 0; cam.y = 0; cam.zoom = 1;
        renderControls(); rebuildGraph(); closeInfoPanel();
      };
      window.graphOpenPage = function(slug) {
        resetMainStyles(); navigateTo(slug);
      };

      var nodes = [];
      var edges = [];
      var slugToIdx = {};
      var clusterBubbles = [];

      function rebuildGraph() {
        nodes = []; edges = []; slugToIdx = {}; clusterBubbles = [];
        var candidatePages;
        if (filters.exploreNode) {
          var center = pageBySlug[filters.exploreNode];
          if (!center) { filters.exploreNode = null; return rebuildGraph(); }
          var hop1 = {}; hop1[center.slug] = true;
          (center.links_to || []).forEach(function(s) { hop1[s] = true; });
          (center.linked_from || []).forEach(function(s) { hop1[s] = true; });
          var hop2 = {};
          Object.keys(hop1).forEach(function(slug) {
            var p = pageBySlug[slug]; if (!p) return;
            (p.links_to || []).forEach(function(s) { if (!hop1[s]) hop2[s] = true; });
            (p.linked_from || []).forEach(function(s) { if (!hop1[s]) hop2[s] = true; });
          });
          candidatePages = [];
          Object.keys(hop1).forEach(function(s) { if (pageBySlug[s]) candidatePages.push(Object.assign({}, pageBySlug[s], { _hop: s === filters.exploreNode ? 0 : 1 })); });
          Object.keys(hop2).forEach(function(s) { if (pageBySlug[s]) candidatePages.push(Object.assign({}, pageBySlug[s], { _hop: 2 })); });
        } else {
          candidatePages = allPages.filter(function(p) {
            if (!filters.types[p.page_type || 'index']) return false;
            return connectionCount[p.slug] >= filters.minConnections;
          }).map(function(p) { return Object.assign({}, p, { _hop: -1 }); });
        }
        if (filters.search) {
          var q = filters.search;
          candidatePages = candidatePages.filter(function(p) { return (p.title || p.slug).toLowerCase().indexOf(q) !== -1; });
        }
        candidatePages.sort(function(a, b) {
          if (a._hop !== b._hop) return a._hop - b._hop;
          return (connectionCount[b.slug] || 0) - (connectionCount[a.slug] || 0);
        });
        if (candidatePages.length > NODE_CAP) candidatePages = candidatePages.slice(0, NODE_CAP);

        candidatePages.forEach(function(p, i) {
          var conns = connectionCount[p.slug] || 0;
          var r;
          if (filters.exploreNode) {
            if (p._hop === 0) r = 28;
            else if (p._hop === 1) r = Math.max(8, 8 + Math.sqrt(conns) * 3);
            else r = Math.max(4, 4 + Math.sqrt(conns) * 1.5);
          } else {
            r = Math.max(5, 5 + Math.sqrt(conns) * 2.5);
            if (conns >= 10) r = Math.max(r, 18 + (conns - 10) * 0.5);
            r = Math.min(r, 40);
          }
          var angle = (i / (candidatePages.length || 1)) * Math.PI * 2;
          var spread = Math.min(W, H) * 0.35;
          nodes.push({
            slug: p.slug, title: p.title || p.slug, type: p.page_type || 'unknown',
            summary: p.summary || '', conns: conns,
            backlinks: (p.linked_from || []).length, outlinks: (p.links_to || []).length,
            linksTo: p.links_to || [], linkedFrom: p.linked_from || [],
            hop: p._hop,
            x: W / 2 + Math.cos(angle) * spread * (0.3 + Math.random() * 0.7),
            y: H / 2 + Math.sin(angle) * spread * (0.3 + Math.random() * 0.7),
            vx: 0, vy: 0, r: r, color: typeColors[p.page_type] || '#6b7280'
          });
          slugToIdx[p.slug] = nodes.length - 1;
        });

        var edgeSet = {};
        nodes.forEach(function(n) {
          (n.linksTo || []).forEach(function(targetSlug) {
            if (slugToIdx[targetSlug] !== undefined) {
              var key = n.slug < targetSlug ? n.slug + '|' + targetSlug : targetSlug + '|' + n.slug;
              if (!edgeSet[key]) { edgeSet[key] = true; edges.push({ source: slugToIdx[n.slug], target: slugToIdx[targetSlug] }); }
            }
          });
        });

        frameCount = 0;
        selectedNode = null;
        closeInfoPanel();
        updateStats();
      }

      function updateStats() {
        var topHubs = nodes.slice().sort(function(a, b) { return b.conns - a.conns; }).slice(0, 5);
        var typeCounts = {};
        nodes.forEach(function(n) { typeCounts[n.type] = (typeCounts[n.type] || 0) + 1; });
        var statsEl = document.getElementById('graph-stats');
        if (statsEl) {
          var legendHtml = Object.keys(typeColors).map(function(t) {
            var cnt = typeCounts[t] || 0;
            if (cnt === 0) return '';
            return '<div style="display:flex;align-items:center;gap:4px;font-size:10px;color:rgba(255,255,255,0.6)">' +
              '<span style="width:6px;height:6px;border-radius:50%;background:' + typeColors[t] + ';flex-shrink:0"></span>' +
              '<span>' + (typeLabels[t] || t) + '</span><span style="color:rgba(255,255,255,0.3)">' + cnt + '</span></div>';
          }).filter(Boolean).join('');
          var hubsHtml = topHubs.map(function(n, i) {
            return '<div style="display:flex;align-items:center;gap:4px;font-size:10px;cursor:pointer;padding:2px 0" onclick="graphExploreNode(&apos;' + n.slug + '&apos;)">' +
              '<span style="color:' + n.color + ';font-weight:700;min-width:12px">' + (i + 1) + '</span>' +
              '<span style="color:rgba(255,255,255,0.7);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + n.title.slice(0, 18) + '</span>' +
              '<span style="color:rgba(255,255,255,0.35)">' + n.conns + '</span></div>';
          }).join('');
          statsEl.innerHTML =
            '<div class="gs-row"><span class="gs-label">Nodes</span><span class="gs-val">' + nodes.length + '</span></div>' +
            '<div class="gs-row"><span class="gs-label">Edges</span><span class="gs-val">' + edges.length + '</span></div>' +
            '<div style="margin-top:6px;border-top:1px solid rgba(255,255,255,0.06);padding-top:6px">' + legendHtml + '</div>' +
            '<div style="margin-top:6px;border-top:1px solid rgba(255,255,255,0.06);padding-top:6px">' +
            '<div style="font-size:9px;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Top Hubs</div>' + hubsHtml + '</div>';
        }
      }

      var selectedNode = null;

      function showInfoPanel(n) {
        selectedNode = n;
        var panel = document.getElementById('graph-info-panel');
        if (!panel) return;

        // Compute bridging score: how many pairs of neighbors aren't connected to each other
        var neighbors = new Set((n.linksTo || []).concat(n.linkedFrom || []));
        var bridgeScore = 0;
        var neighborArr = Array.from(neighbors);
        for (var bi = 0; bi < neighborArr.length; bi++) {
          for (var bj = bi + 1; bj < neighborArr.length; bj++) {
            var pi = pageBySlug[neighborArr[bi]], pj = pageBySlug[neighborArr[bj]];
            if (pi && pj) {
              var piLinks = (pi.links_to || []).concat(pi.linked_from || []);
              if (piLinks.indexOf(neighborArr[bj]) === -1) bridgeScore++;
            }
          }
        }
        var isBridge = bridgeScore > neighborArr.length * 0.6 && neighborArr.length >= 4;

        var outHtml = (n.linksTo || []).slice(0, 15).map(function(s) {
          var p = pageBySlug[s]; var label = p ? p.title : s;
          var c = p ? (typeColors[p.page_type] || '#6b7280') : '#6b7280';
          return '<span class="gip-link" onclick="graphOpenPage(&apos;' + s + '&apos;)" style="border-left:2px solid ' + c + ';padding-left:6px">' + label + '</span>';
        }).join('');
        var inHtml = (n.linkedFrom || []).slice(0, 15).map(function(s) {
          var p = pageBySlug[s]; var label = p ? p.title : s;
          var c = p ? (typeColors[p.page_type] || '#6b7280') : '#6b7280';
          return '<span class="gip-link" onclick="graphOpenPage(&apos;' + s + '&apos;)" style="border-left:2px solid ' + c + ';padding-left:6px">' + label + '</span>';
        }).join('');

        // Rank badge
        var rank = nodes.slice().sort(function(a, b) { return b.conns - a.conns; }).findIndex(function(x) { return x.slug === n.slug; }) + 1;
        var rankBadge = rank <= 10 ? '<span style="background:' + n.color + ';color:#000;font-size:10px;font-weight:700;padding:2px 6px;border-radius:10px;margin-left:6px">#' + rank + '</span>' : '';

        panel.innerHTML =
          '<button class="gip-close" onclick="closeInfoPanel()">&times;</button>' +
          '<div class="gip-title">' + n.title + rankBadge + '</div>' +
          '<div class="gip-type"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + n.color + ';margin-right:4px"></span>' + n.type + ' &middot; ' + n.conns + ' connections' +
          (isBridge ? ' &middot; <span style="color:#FFD700">Bridge Node</span>' : '') + '</div>' +
          '<div style="display:flex;gap:8px;margin:8px 0">' +
          '<div style="flex:1;text-align:center;padding:6px;background:rgba(255,255,255,0.03);border-radius:6px"><div style="font-size:18px;font-weight:800;color:' + n.color + '">' + n.outlinks + '</div><div style="font-size:9px;color:rgba(255,255,255,0.4);text-transform:uppercase">Out</div></div>' +
          '<div style="flex:1;text-align:center;padding:6px;background:rgba(255,255,255,0.03);border-radius:6px"><div style="font-size:18px;font-weight:800;color:' + n.color + '">' + n.backlinks + '</div><div style="font-size:9px;color:rgba(255,255,255,0.4);text-transform:uppercase">In</div></div>' +
          '</div>' +
          (n.summary ? '<div class="gip-summary">' + n.summary.slice(0, 200) + '</div>' : '') +
          (outHtml ? '<div class="gip-section-title">Links to (' + n.outlinks + ')</div>' + outHtml : '') +
          (inHtml ? '<div class="gip-section-title">Linked from (' + n.backlinks + ')</div>' + inHtml : '') +
          '<div class="gip-actions">' +
          '<button class="gip-btn gip-btn-primary" onclick="graphOpenPage(&apos;' + n.slug + '&apos;)">Open Page</button>' +
          '<button class="gip-btn gip-btn-secondary" onclick="graphExploreNode(&apos;' + n.slug + '&apos;)">Explore</button>' +
          '</div>';
        panel.classList.add('open');
      }

      window.closeInfoPanel = function() {
        var panel = document.getElementById('graph-info-panel');
        if (panel) panel.classList.remove('open');
      };

      var cam = { x: 0, y: 0, zoom: 1 };
      var drag = { active: false, startX: 0, startY: 0, camStartX: 0, camStartY: 0 };
      var hoveredNode = null;
      var frameCount = 0;
      var lastClickTime = 0;

      function simulate() {
        var alpha = Math.max(0.001, 1 - frameCount / 250);
        var N = nodes.length;
        if (N === 0) return;

        var repStr = N > 150 ? 600 : 1000;
        for (var i = 0; i < N; i++) {
          for (var j = i + 1; j < N; j++) {
            var dx = nodes[j].x - nodes[i].x;
            var dy = nodes[j].y - nodes[i].y;
            var d2 = dx * dx + dy * dy;
            if (d2 > 250000) continue;
            if (d2 < 1) d2 = 1;
            var d = Math.sqrt(d2);
            var force = repStr / d2 * alpha;
            var fx = (dx / d) * force;
            var fy = (dy / d) * force;
            nodes[i].vx -= fx; nodes[i].vy -= fy;
            nodes[j].vx += fx; nodes[j].vy += fy;
          }
        }

        var idealLen = filters.exploreNode ? 120 : 100;
        edges.forEach(function(e) {
          var s = nodes[e.source]; var t = nodes[e.target];
          var dx = t.x - s.x; var dy = t.y - s.y;
          var d = Math.sqrt(dx * dx + dy * dy) || 1;
          var force = (d - idealLen) * 0.006 * alpha;
          var fx = (dx / d) * force; var fy = (dy / d) * force;
          s.vx += fx; s.vy += fy; t.vx -= fx; t.vy -= fy;
        });

        if (!filters.exploreNode) {
          var typeCenters = {}; var typeCnts = {};
          nodes.forEach(function(n) {
            if (!typeCenters[n.type]) { typeCenters[n.type] = { x: 0, y: 0 }; typeCnts[n.type] = 0; }
            typeCenters[n.type].x += n.x; typeCenters[n.type].y += n.y; typeCnts[n.type]++;
          });
          Object.keys(typeCenters).forEach(function(t) {
            typeCenters[t].x /= typeCnts[t]; typeCenters[t].y /= typeCnts[t];
          });
          nodes.forEach(function(n) {
            var tc = typeCenters[n.type];
            if (tc) { n.vx += (tc.x - n.x) * 0.0003 * alpha; n.vy += (tc.y - n.y) * 0.0003 * alpha; }
          });
        }

        var cx = W / 2, cy = H / 2;
        nodes.forEach(function(n) {
          n.vx += (cx - n.x) * 0.0008 * alpha;
          n.vy += (cy - n.y) * 0.0008 * alpha;
          n.vx *= 0.82; n.vy *= 0.82;
          n.x += n.vx; n.y += n.vy;
        });
        frameCount++;
        if (frameCount === 200 && !filters.exploreNode) computeClusterBubbles();
      }

      function computeClusterBubbles() {
        clusterBubbles = [];
        // Louvain-style community detection: group nodes by shared neighbors
        var communities = louvainCommunities(nodes, edges);
        var commGroups = {};
        communities.forEach(function(c, i) {
          if (!commGroups[c]) commGroups[c] = [];
          commGroups[c].push(nodes[i]);
        });
        Object.keys(commGroups).forEach(function(c) {
          var arr = commGroups[c]; if (arr.length < 3) return;
          var cx = 0, cy = 0;
          arr.forEach(function(n) { cx += n.x; cy += n.y; });
          cx /= arr.length; cy /= arr.length;
          var maxDist = 0;
          arr.forEach(function(n) { var d = Math.sqrt((n.x - cx) * (n.x - cx) + (n.y - cy) * (n.y - cy)); if (d > maxDist) maxDist = d; });
          // Pick dominant type color for the community
          var typeCounts = {};
          arr.forEach(function(n) { typeCounts[n.type] = (typeCounts[n.type] || 0) + 1; });
          var domType = Object.keys(typeCounts).sort(function(a, b) { return typeCounts[b] - typeCounts[a]; })[0];
          // Find most-connected node as community label
          var hub = arr.sort(function(a, b) { return b.conns - a.conns; })[0];
          clusterBubbles.push({
            type: domType, cx: cx, cy: cy, r: maxDist + 40, count: arr.length,
            color: typeColors[domType] || '#6b7280',
            label: hub.title.slice(0, 18) + ' +' + (arr.length - 1)
          });
        });
      }

      // Simple Louvain-inspired community detection
      function louvainCommunities(nodes, edges) {
        var N = nodes.length;
        var comm = []; for (var i = 0; i < N; i++) comm.push(i);
        var adj = []; for (var i = 0; i < N; i++) adj.push([]);
        edges.forEach(function(e) { adj[e.source].push(e.target); adj[e.target].push(e.source); });
        // Iterative label propagation (simplified Louvain)
        for (var iter = 0; iter < 10; iter++) {
          var changed = false;
          var order = []; for (var i = 0; i < N; i++) order.push(i);
          // Shuffle
          for (var i = order.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var tmp = order[i]; order[i] = order[j]; order[j] = tmp; }
          order.forEach(function(i) {
            if (adj[i].length === 0) return;
            var neighborComms = {};
            adj[i].forEach(function(j) { var c = comm[j]; neighborComms[c] = (neighborComms[c] || 0) + 1; });
            var bestComm = comm[i], bestCount = 0;
            Object.keys(neighborComms).forEach(function(c) { if (neighborComms[c] > bestCount) { bestCount = neighborComms[c]; bestComm = parseInt(c); } });
            if (bestComm !== comm[i]) { comm[i] = bestComm; changed = true; }
          });
          if (!changed) break;
        }
        // Normalize community IDs to 0..K
        var unique = {}; var id = 0;
        comm.forEach(function(c) { if (unique[c] === undefined) unique[c] = id++; });
        return comm.map(function(c) { return unique[c]; });
      }

      function render() {
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#0C0C0E';
        ctx.fillRect(0, 0, W, H);
        ctx.save();
        ctx.translate(cam.x, cam.y);
        ctx.scale(cam.zoom, cam.zoom);

        var gridSize = 60;
        ctx.strokeStyle = 'rgba(255,255,255,0.025)';
        ctx.lineWidth = 0.5 / cam.zoom;
        var sX = Math.floor((-cam.x / cam.zoom - 200) / gridSize) * gridSize;
        var sY = Math.floor((-cam.y / cam.zoom - 200) / gridSize) * gridSize;
        var eX = sX + (W / cam.zoom) + 400;
        var eY = sY + (H / cam.zoom) + 400;
        for (var gx = sX; gx < eX; gx += gridSize) { ctx.beginPath(); ctx.moveTo(gx, sY); ctx.lineTo(gx, eY); ctx.stroke(); }
        for (var gy = sY; gy < eY; gy += gridSize) { ctx.beginPath(); ctx.moveTo(sX, gy); ctx.lineTo(eX, gy); ctx.stroke(); }

        clusterBubbles.forEach(function(cb) {
          ctx.beginPath(); ctx.arc(cb.cx, cb.cy, cb.r, 0, Math.PI * 2);
          ctx.fillStyle = cb.color; ctx.globalAlpha = 0.04; ctx.fill();
          ctx.globalAlpha = 0.12; ctx.strokeStyle = cb.color; ctx.lineWidth = 1.5 / cam.zoom;
          ctx.setLineDash([4 / cam.zoom, 4 / cam.zoom]); ctx.stroke(); ctx.setLineDash([]);
          ctx.globalAlpha = 1;
          ctx.font = 'bold ' + (11 / cam.zoom) + 'px -apple-system, sans-serif';
          ctx.fillStyle = cb.color; ctx.globalAlpha = 0.5; ctx.textAlign = 'center';
          ctx.fillText(cb.label, cb.cx, cb.cy - cb.r - 6 / cam.zoom); ctx.globalAlpha = 1;
        });

        var vL = -cam.x / cam.zoom - 100, vT = -cam.y / cam.zoom - 100;
        var vR = vL + W / cam.zoom + 200, vB = vT + H / cam.zoom + 200;

        // Draw edges — gradient from source to target color, highlight on hover
        edges.forEach(function(e) {
          var s = nodes[e.source]; var t = nodes[e.target];
          if (Math.max(s.x, t.x) < vL || Math.min(s.x, t.x) > vR || Math.max(s.y, t.y) < vT || Math.min(s.y, t.y) > vB) return;
          var isHov = hoveredNode && (s === hoveredNode || t === hoveredNode);
          var isSel = selectedNode && (s.slug === selectedNode.slug || t.slug === selectedNode.slug);
          var highlight = isHov || isSel;
          ctx.beginPath();
          var mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
          var dx = t.x - s.x, dy = t.y - s.y;
          var dist = Math.sqrt(dx * dx + dy * dy) || 1;
          var curveOff = Math.min(dist * 0.12, 25);
          ctx.moveTo(s.x, s.y);
          ctx.quadraticCurveTo(mx + (-dy / dist) * curveOff, my + (dx / dist) * curveOff, t.x, t.y);
          if (highlight) {
            // Gradient edge from source to target color
            try {
              var grad = ctx.createLinearGradient(s.x, s.y, t.x, t.y);
              grad.addColorStop(0, s.color + (isHov ? 'AA' : '88'));
              grad.addColorStop(1, t.color + (isHov ? 'AA' : '88'));
              ctx.strokeStyle = grad;
            } catch(ge) { ctx.strokeStyle = 'rgba(212,168,83,0.5)'; }
            ctx.lineWidth = (isHov ? 2 : 1.5) / cam.zoom;
          } else {
            ctx.strokeStyle = 'rgba(255,255,255,0.08)';
            ctx.lineWidth = 0.6 / cam.zoom;
          }
          ctx.stroke();
        });

        nodes.forEach(function(n) {
          if (n.x < vL || n.x > vR || n.y < vT || n.y > vB) return;
          var isHov = n === hoveredNode;
          var isSel = selectedNode && n.slug === selectedNode.slug;
          var isSrch = filters.search && (n.title.toLowerCase().indexOf(filters.search) !== -1);

          if (n.conns >= 8 || isHov || isSel) {
            ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 6, 0, Math.PI * 2);
            var grd = ctx.createRadialGradient(n.x, n.y, n.r * 0.5, n.x, n.y, n.r + 8);
            grd.addColorStop(0, n.color); grd.addColorStop(1, 'transparent');
            ctx.fillStyle = grd;
            ctx.globalAlpha = isHov ? 0.4 : (isSel ? 0.35 : 0.15);
            ctx.fill(); ctx.globalAlpha = 1;
          }

          ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
          ctx.fillStyle = (isHov || isSel) ? '#ffffff' : (isSrch ? '#ffdd57' : n.color);
          ctx.globalAlpha = (n.hop === 2) ? 0.4 : ((n.hop === 1) ? 0.75 : 0.9);
          ctx.fill(); ctx.globalAlpha = 1;

          if (isHov || isSel || n.conns >= 5 || isSrch || (n.hop === 0 && filters.exploreNode)) {
            var fs = Math.max(10, Math.min(14, n.r * 0.9)) / cam.zoom;
            ctx.font = ((n.conns >= 10 || isHov) ? 'bold ' : '') + fs + 'px -apple-system, sans-serif';
            ctx.fillStyle = isSrch ? '#ffdd57' : '#ffffff';
            ctx.textAlign = 'center';
            ctx.globalAlpha = (isHov || isSel || n.conns >= 8) ? 1 : 0.7;
            ctx.fillText(n.title.length > 28 ? n.title.slice(0, 26) + '..' : n.title, n.x, n.y - n.r - 5 / cam.zoom);
            ctx.globalAlpha = 1;
          }
        });

        ctx.restore();
      }

      function loop() {
        if (frameCount < 250) simulate();
        render();
        if (graphState && graphState.canvas === canvas) requestAnimationFrame(loop);
      }

      function canvasToWorld(mx, my) { return { x: (mx - cam.x) / cam.zoom, y: (my - cam.y) / cam.zoom }; }

      function nodeAt(wx, wy) {
        var best = null, bestD2 = Infinity;
        for (var i = nodes.length - 1; i >= 0; i--) {
          var n = nodes[i]; var dx = wx - n.x, dy = wy - n.y; var d2 = dx * dx + dy * dy;
          var hitR = Math.max(n.r, 8);
          if (d2 < hitR * hitR && d2 < bestD2) { best = n; bestD2 = d2; }
        }
        return best;
      }

      canvas.addEventListener('mousedown', function(e) {
        var brect = canvas.getBoundingClientRect();
        drag.active = true;
        drag.startX = e.clientX - brect.left; drag.startY = e.clientY - brect.top;
        drag.camStartX = cam.x; drag.camStartY = cam.y;
      });

      canvas.addEventListener('mousemove', function(e) {
        var brect = canvas.getBoundingClientRect();
        var mx = e.clientX - brect.left, my = e.clientY - brect.top;
        if (drag.active) { cam.x = drag.camStartX + (mx - drag.startX); cam.y = drag.camStartY + (my - drag.startY); return; }
        var w = canvasToWorld(mx, my); var n = nodeAt(w.x, w.y);
        hoveredNode = n; canvas.style.cursor = n ? 'pointer' : 'grab';
        var tooltip = document.getElementById('graph-tooltip');
        if (n && tooltip) {
          tooltip.style.display = 'block';
          tooltip.style.left = Math.min(mx + 14, W - 270) + 'px';
          tooltip.style.top = Math.min(my + 14, H - 80) + 'px';
          tooltip.innerHTML = '<div class="gt-title">' + n.title + '</div>' +
            '<div class="gt-meta">' + n.type + ' &middot; ' + n.conns + ' connections</div>' +
            '<div class="gt-links">Click for details &middot; Double-click to open</div>';
        } else if (tooltip) { tooltip.style.display = 'none'; }
      });

      canvas.addEventListener('mouseup', function(e) {
        if (!drag.active) return;
        var brect = canvas.getBoundingClientRect();
        var mx = e.clientX - brect.left, my = e.clientY - brect.top;
        var moved = Math.abs(mx - drag.startX) + Math.abs(my - drag.startY);
        drag.active = false;
        if (moved < 4) {
          var now = Date.now(); var w = canvasToWorld(mx, my); var n = nodeAt(w.x, w.y);
          if (n) {
            if (now - lastClickTime < 350 && selectedNode && selectedNode.slug === n.slug) {
              resetMainStyles(); navigateTo(n.slug);
            } else { showInfoPanel(n); }
            lastClickTime = now;
          } else { closeInfoPanel(); selectedNode = null; }
        }
      });

      canvas.addEventListener('contextmenu', function(e) {
        e.preventDefault();
        var brect = canvas.getBoundingClientRect();
        var w = canvasToWorld(e.clientX - brect.left, e.clientY - brect.top);
        var n = nodeAt(w.x, w.y);
        if (n) graphExploreNode(n.slug);
      });

      canvas.addEventListener('mouseleave', function() {
        drag.active = false; hoveredNode = null;
        var tooltip = document.getElementById('graph-tooltip');
        if (tooltip) tooltip.style.display = 'none';
      });

      canvas.addEventListener('wheel', function(e) {
        e.preventDefault();
        var brect = canvas.getBoundingClientRect();
        var mx = e.clientX - brect.left, my = e.clientY - brect.top;
        var factor = e.deltaY < 0 ? 1.08 : 0.93;
        var newZoom = Math.max(0.15, Math.min(6, cam.zoom * factor));
        cam.x = mx - (mx - cam.x) * (newZoom / cam.zoom);
        cam.y = my - (my - cam.y) * (newZoom / cam.zoom);
        cam.zoom = newZoom;
      }, { passive: false });

      window.addEventListener('resize', function() {
        if (!graphState || graphState.canvas !== canvas) return;
        var r2 = container.getBoundingClientRect();
        W = r2.width || 800; H = r2.height || 600;
        canvas.width = W * window.devicePixelRatio; canvas.height = H * window.devicePixelRatio;
        canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
      });

      renderControls();
      rebuildGraph();
      graphState = { canvas: canvas };
      loop();
    }

    // --- Ideas Lab ---
    var ideasState = { ideas: [], connections: [], loading: false };

    // === THINK MODE ===
    var ALGORITHMS_OF_THOUGHT = [
      {
        id: 'differences-engine',
        icon: '&#9881;',
        title: 'Differences Engine',
        desc: 'Compare mental models. What does X look like through the lens of different frameworks? Surface contradictions and complementary perspectives.',
        prompt: 'Apply the Differences Engine: take the concept and analyze it through at least 3 different mental models or frameworks. For each lens, explain what it reveals that the others miss. Then identify where the models contradict and where they complement each other.',
      },
      {
        id: 'pre-mortem',
        icon: '&#128128;',
        title: 'Pre-Mortem',
        desc: 'Imagine this already failed. What went wrong? Work backward from failure to surface hidden risks and assumptions.',
        prompt: 'Run a Pre-Mortem: Imagine this concept/project has completely failed 12 months from now. Write the postmortem. What were the 5 biggest reasons it failed? What assumptions proved wrong? What did we ignore? Then: which of these failure modes can we prevent right now?',
      },
      {
        id: 'variant-perception',
        icon: '&#128300;',
        title: 'Variant Perception',
        desc: 'What does the consensus believe? Where is consensus wrong? What do you see that others miss?',
        prompt: 'Apply Variant Perception analysis: (1) What is the consensus view on this topic? (2) Why might the consensus be wrong? (3) What specific evidence or insight do you have that others lack? (4) What would need to be true for the variant view to play out? (5) What is the asymmetry — upside vs downside?',
      },
      {
        id: 'second-order',
        icon: '&#128279;',
        title: 'Second-Order Thinking',
        desc: 'Go beyond "and then what?" Surface hidden connections, unintended consequences, and opportunities that emerge from change.',
        prompt: 'Apply Second-Order Thinking: (1) What is the first-order effect of this? (2) What are 3 second-order effects — consequences of the consequences? (3) Who benefits indirectly? Who is hurt indirectly? (4) What new opportunities emerge from these second-order effects? (5) Connect this to at least 2 other concepts in the wiki using [[slug]] notation.',
      },
      {
        id: 'inversion',
        icon: '&#128260;',
        title: 'Inversion (Munger)',
        desc: '"Invert, always invert." Instead of asking how to succeed, ask how to fail. Avoid the failure modes.',
        prompt: 'Apply Inversion (Charlie Munger): Instead of asking "how do I achieve X?", ask "what would guarantee failure?" List the top 5 ways to fail at this. Then invert each one into a principle for success. Which of these inverted principles is most non-obvious?',
      },
      {
        id: 'circle-competence',
        icon: '&#11044;',
        title: 'Circle of Competence',
        desc: 'Map what you truly know vs. what you think you know. Where are the edges? Where should you defer to experts?',
        prompt: "Map the Circle of Competence for this topic: (1) What do I genuinely know from direct experience? (2) What do I know from reading/study but have not practiced? (3) What am I blind to - gaps I might not even recognize? (4) Who are the true experts and what do they know that I do not? (5) Given this map, what action should I take vs. what should I delegate?",
      },
    ];

    async function loadThinkMode() {
      currentSlug = null;
      var el = document.getElementById('main-inner');

      // Date
      var now = new Date();
      var days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      var dateStr = days[now.getDay()] + ', ' + months[now.getMonth()] + ' ' + now.getDate();

      el.innerHTML =
        '<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:20px">' +
        '<h1 class="dash-title">Think</h1>' +
        '<span style="font-size:13px;color:var(--text-dim)">' + dateStr + '</span></div>' +

        // Atomic Thought Capture
        '<div class="think-section">' +
        '<h2>Capture a Thought</h2>' +
        '<div class="think-sub">Write one atomic, reusable idea. Keep it self-contained. Link to existing knowledge with [[slug]].</div>' +
        '<textarea class="thought-input" id="thought-input" placeholder="One clear thought. Make it atomic — self-contained and reusable across contexts..."></textarea>' +
        '<div style="display:flex;gap:8px;margin-top:10px">' +
        '<button class="btn-primary" onclick="saveThought()">Save Thought</button>' +
        '<button class="btn-primary" onclick="saveAndApplyAlgo()" style="background:var(--purple)">Save + Apply Algorithm</button>' +
        '</div>' +
        '<div id="thought-status" style="font-size:12px;margin-top:6px;min-height:18px"></div></div>' +

        // Resurface: Random Knowledge
        '<div class="think-section">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">' +
        '<h2>Resurface</h2>' +
        '<button class="btn-secondary" onclick="loadResurface()" style="font-size:11px;padding:4px 12px">&#x21BB; Refresh</button></div>' +
        '<div class="think-sub">Forgotten knowledge pulled from your wiki. Read, connect, or update.</div>' +
        '<div id="resurface-list"><div class="spinner"></div></div></div>' +

        // Algorithms of Thought
        '<div class="think-section">' +
        '<h2>Algorithms of Thought</h2>' +
        '<div class="think-sub">Structured thinking frameworks. Apply any algorithm to a wiki page or new thought.</div>' +
        '<div id="algo-list">' +
        ALGORITHMS_OF_THOUGHT.map(function(a) {
          return '<div class="algo-card" onclick="runAlgorithm(&apos;' + a.id + '&apos;)">' +
            '<span class="algo-card-icon">' + a.icon + '</span>' +
            '<div class="algo-card-title">' + a.title + '</div>' +
            '<div class="algo-card-desc">' + a.desc + '</div></div>';
        }).join('') +
        '</div></div>' +

        // Wiki Search
        '<div class="think-section">' +
        '<h2>Search</h2>' +
        '<div class="think-sub">Full-text search across all wiki pages.</div>' +
        '<div style="display:flex;gap:8px">' +
        '<input type="text" id="wiki-search-input" class="thought-input" style="min-height:auto;padding:10px 14px" placeholder="Search your wiki..." />' +
        '<button class="btn-primary" onclick="wikiSearch()" style="white-space:nowrap">Search</button></div>' +
        '<div id="wiki-search-results" style="margin-top:10px"></div></div>' +

        // Wiki Maintenance (Compile + Lint)
        '<div class="think-section">' +
        '<h2>Wiki Maintenance</h2>' +
        '<div class="think-sub">Karpathy-style: compile index pages, fill gaps, lint for quality, enhance connections.</div>' +
        '<div style="display:flex;gap:8px;margin-bottom:12px">' +
        '<button class="btn-primary" onclick="runCompile()" id="compile-btn" style="background:var(--purple)">&#9881; Compile Wiki</button>' +
        '<button class="btn-primary" onclick="runLint()" id="lint-btn" style="background:var(--amber);color:#0C0C0E">&#128269; Lint / Health Check</button></div>' +
        '<div id="maintenance-status" style="font-size:12px;min-height:18px"></div>' +
        '<div id="maintenance-results" style="margin-top:10px"></div></div>' +

        // Second-Order Connections (elevated from dashboard)
        '<div class="think-section">' +
        '<h2>Second-Order Connections</h2>' +
        '<div class="think-sub">Pages that do not link directly but share hidden paths through your knowledge graph.</div>' +
        '<div id="think-connections"><div class="spinner"></div></div></div>';

      loadResurface();
      loadThinkConnections();

      // Wire search enter key
      setTimeout(function() {
        var si = document.getElementById('wiki-search-input');
        if (si) si.addEventListener('keydown', function(e) { if (e.key === 'Enter') wikiSearch(); });
      }, 100);
    }

    async function loadResurface() {
      var el = document.getElementById('resurface-list');
      if (!el) return;
      el.innerHTML = '<div class="spinner"></div>';

      // Get random pages with preference for older, more connected ones
      try {
        var res = await fetch(api('/api/pages?limit=500'));
        var data = await res.json();
        var pages = data.pages || [];

        // Score by staleness + connection count (resurface important forgotten knowledge)
        var now = Date.now();
        var scored = pages.map(function(p) {
          var backlinks = (p.linked_from || []).length;
          var outlinks = (p.links_to || []).length;
          var updatedMs = p.updated_at ? new Date(p.updated_at + 'Z').getTime() : 0;
          var daysSinceUpdate = (now - updatedMs) / (1000 * 60 * 60 * 24);
          // Higher score = more worth resurfacing
          var score = (backlinks + outlinks) * Math.log2(Math.max(1, daysSinceUpdate));
          return { page: p, score: score };
        }).filter(function(s) { return s.page.word_count > 30; });

        // Shuffle top 30, pick 5
        scored.sort(function(a, b) { return b.score - a.score; });
        var top = scored.slice(0, 30);
        for (var i = top.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var temp = top[i]; top[i] = top[j]; top[j] = temp;
        }
        var picked = top.slice(0, 5);

        if (picked.length === 0) {
          el.innerHTML = '<div style="color:var(--text-faint);font-size:13px">Not enough wiki content yet. Add more knowledge first.</div>';
          return;
        }

        el.innerHTML = picked.map(function(s) {
          var p = s.page;
          var backlinks = (p.linked_from || []).length;
          var daysSince = Math.floor((now - new Date((p.updated_at || '') + 'Z').getTime()) / (1000 * 60 * 60 * 24));
          var reason = daysSince > 30
            ? 'Last touched ' + daysSince + ' days ago, ' + backlinks + ' connections'
            : backlinks + ' connections, worth revisiting';
          return '<div class="resurface-card" onclick="navigateTo(&apos;' + p.slug + '&apos;)">' +
            '<div class="resurface-title">' + escHtml(p.title || p.slug) + ' ' + typeBadge(p.page_type) + '</div>' +
            '<div class="resurface-excerpt">' + escHtml((p.summary || '').slice(0, 150)) + '</div>' +
            '<div class="resurface-reason">' + reason + '</div></div>';
        }).join('');
      } catch(e) {
        el.innerHTML = '<div style="color:var(--red);font-size:12px">Failed to load: ' + e.message + '</div>';
      }
    }

    function loadThinkConnections() {
      var el = document.getElementById('think-connections');
      if (!el) return;

      var slugMap = {};
      allPages.forEach(function(p) { slugMap[p.slug] = p; });

      var connections = [];
      var seen = {};

      allPages.forEach(function(p) {
        var links = p.links_to || [];
        links.forEach(function(linked) {
          var bridge = slugMap[linked];
          if (!bridge) return;
          (bridge.links_to || []).forEach(function(fof) {
            if (fof === p.slug || links.includes(fof) || !slugMap[fof]) return;
            var key = [p.slug, fof].sort().join('|');
            if (seen[key]) return;
            seen[key] = true;
            connections.push({ from: p, to: slugMap[fof], via: bridge });
          });
        });
      });

      connections.sort(function(a, b) {
        return ((b.from.linked_from||[]).length + (b.to.linked_from||[]).length) -
               ((a.from.linked_from||[]).length + (a.to.linked_from||[]).length);
      });

      var top = connections.slice(0, 10);
      if (top.length === 0) {
        el.innerHTML = '<div style="color:var(--text-faint);font-size:13px">Need more cross-linked pages to find second-order connections.</div>';
        return;
      }

      el.innerHTML = top.map(function(c) {
        return '<div style="padding:10px 0;border-bottom:1px solid var(--border);font-size:13px">' +
          '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
          '<span class="wiki-link" onclick="navigateTo(&quot;' + c.from.slug + '&quot;)" style="font-weight:600">' + escHtml(c.from.title||c.from.slug) + '</span>' +
          '<span style="color:var(--text-faint)">&#8596;</span>' +
          '<span class="wiki-link" onclick="navigateTo(&quot;' + c.to.slug + '&quot;)" style="font-weight:600">' + escHtml(c.to.title||c.to.slug) + '</span></div>' +
          '<div style="color:var(--text-dim);font-size:11px;margin-top:3px">via ' +
          '<span class="wiki-link" onclick="navigateTo(&quot;' + c.via.slug + '&quot;)">' + escHtml(c.via.title||c.via.slug) + '</span></div></div>';
      }).join('');
    }

    async function saveThought() {
      var input = document.getElementById('thought-input');
      var status = document.getElementById('thought-status');
      if (!input || !input.value.trim()) { if (status) status.innerHTML = '<span style="color:var(--red)">Write a thought first.</span>'; return; }

      if (status) status.innerHTML = '<span class="spinner"></span> Saving thought...';

      try {
        var res = await fetch(api('/api/research'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: input.value.trim(), title: 'Thought: ' + input.value.trim().slice(0, 50) }),
        });
        var data = await res.json();
        if (data.error) { if (status) status.innerHTML = '<span style="color:var(--red)">Error: ' + data.error + '</span>'; return; }
        if (status) status.innerHTML = '<span style="color:var(--green)">Thought saved! ' + data.entities + ' entities extracted, ' + data.pages_created + ' pages created.</span>';
        input.value = '';
        loadAllPages();
        loadSidebarStats();
        statsCache = null;
      } catch(e) {
        if (status) status.innerHTML = '<span style="color:var(--red)">Error: ' + e.message + '</span>';
      }
    }

    async function saveAndApplyAlgo() {
      await saveThought();
      // After saving, show algorithm picker
      runAlgorithm(null);
    }

    async function runAlgorithm(algoId) {
      var algo = algoId ? ALGORITHMS_OF_THOUGHT.find(function(a) { return a.id === algoId; }) : null;

      // Build page picker
      var picker = '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:9999" id="algo-overlay">' +
        '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:28px;max-width:500px;width:90%;max-height:80vh;overflow-y:auto">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">' +
        '<div style="font-size:18px;font-weight:700;color:var(--white)">' + (algo ? algo.icon + ' ' + algo.title : 'Choose an Algorithm') + '</div>' +
        '<button onclick="document.getElementById(&apos;algo-overlay&apos;).remove()" style="background:none;border:none;color:var(--text-dim);font-size:20px;cursor:pointer">&times;</button></div>';

      if (!algo) {
        // Show algorithm chooser
        picker += ALGORITHMS_OF_THOUGHT.map(function(a) {
          return '<div class="algo-card" onclick="document.getElementById(&apos;algo-overlay&apos;).remove();runAlgorithm(&apos;' + a.id + '&apos;)">' +
            '<span class="algo-card-icon">' + a.icon + '</span>' +
            '<div class="algo-card-title">' + a.title + '</div>' +
            '<div class="algo-card-desc">' + a.desc + '</div></div>';
        }).join('');
        picker += '</div></div>';
        document.body.insertAdjacentHTML('beforeend', picker);
        return;
      }

      // Show page picker for the selected algorithm
      picker += '<div style="font-size:13px;color:var(--text-dim);margin-bottom:12px">' + algo.desc + '</div>' +
        '<input type="text" id="algo-page-filter" placeholder="Filter pages..." oninput="filterAlgoPages()" style="width:100%;padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--white);font-size:13px;outline:none;margin-bottom:12px" />' +
        '<div id="algo-page-list" style="max-height:300px;overflow-y:auto">';

      var sorted = allPages.slice().sort(function(a, b) {
        return ((b.linked_from||[]).length) - ((a.linked_from||[]).length);
      }).slice(0, 50);

      picker += sorted.map(function(p) {
        return '<div class="algo-page-option" data-slug="' + p.slug + '" data-title="' + escHtml(p.title||p.slug).toLowerCase() + '" ' +
          'onclick="applyAlgorithm(&apos;' + algoId + '&apos;,&apos;' + p.slug + '&apos;)" ' +
          'style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border);font-size:13px;transition:background 0.1s">' +
          '<span style="font-weight:600;color:var(--white)">' + escHtml(p.title||p.slug) + '</span> ' +
          typeBadge(p.page_type) + ' <span style="font-size:11px;color:var(--text-dim)">' + (p.linked_from||[]).length + ' links</span></div>';
      }).join('');
      picker += '</div></div></div>';
      document.body.insertAdjacentHTML('beforeend', picker);
    }
    window.runAlgorithm = runAlgorithm;

    function filterAlgoPages() {
      var q = (document.getElementById('algo-page-filter') || {}).value || '';
      q = q.toLowerCase();
      var items = document.querySelectorAll('.algo-page-option');
      items.forEach(function(el) {
        el.style.display = (el.dataset.title || '').includes(q) ? '' : 'none';
      });
    }
    window.filterAlgoPages = filterAlgoPages;

    async function applyAlgorithm(algoId, slug) {
      var overlay = document.getElementById('algo-overlay');
      if (overlay) overlay.remove();

      var algo = ALGORITHMS_OF_THOUGHT.find(function(a) { return a.id === algoId; });
      if (!algo) return;

      // Show loading
      var loader = document.createElement('div');
      loader.id = 'algo-loader';
      loader.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:9999';
      loader.innerHTML = '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:32px;text-align:center;max-width:400px">' +
        '<div class="spinner" style="width:24px;height:24px;margin:0 auto 16px"></div>' +
        '<div style="color:var(--white);font-size:16px;font-weight:600">' + algo.icon + ' ' + algo.title + '</div>' +
        '<div style="color:var(--text-dim);font-size:13px;margin-top:8px">Applying algorithm to the selected page...</div></div>';
      document.body.appendChild(loader);

      try {
        // Fetch page content
        var pageRes = await fetch(api('/api/pages/' + slug));
        var pageData = await pageRes.json();
        var pageContent = pageData.content || pageData.summary || '';

        // Run the algorithm via query endpoint with the algorithm prompt
        var res = await fetch(api('/api/query'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question: algo.prompt + '\\n\\nApply this to the following wiki page:\\n\\nTitle: ' + (pageData.title || slug) + '\\n\\n' + pageContent.slice(0, 5000),
          }),
        });
        var data = await res.json();

        loader.remove();

        // Show result
        var resultDiv = document.createElement('div');
        resultDiv.id = 'algo-result';
        resultDiv.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:9999';
        resultDiv.innerHTML = '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:28px;max-width:600px;width:90%;max-height:80vh;overflow-y:auto">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">' +
          '<div style="font-size:18px;font-weight:700;color:var(--white)">' + algo.icon + ' ' + algo.title + '</div>' +
          '<button onclick="document.getElementById(&apos;algo-result&apos;).remove()" style="background:none;border:none;color:var(--text-dim);font-size:20px;cursor:pointer">&times;</button></div>' +
          '<div style="font-size:12px;color:var(--text-dim);margin-bottom:12px">Applied to: ' + escHtml(pageData.title || slug) + '</div>' +
          '<div class="page-content" style="font-size:14px">' + renderMarkdown(data.answer || 'No result generated.') + '</div>' +
          '<div style="display:flex;gap:8px;margin-top:16px">' +
          '<button class="btn-primary" onclick="saveAlgoResult(&apos;' + slug + '&apos;,&apos;' + algoId + '&apos;)">Save to Wiki</button>' +
          '<button class="btn-secondary" onclick="document.getElementById(&apos;algo-result&apos;).remove()">Close</button></div></div>';
        document.body.appendChild(resultDiv);

        // Store result temporarily for saving
        window._algoResult = data.answer || '';
      } catch(e) {
        loader.remove();
        alert('Algorithm failed: ' + e.message);
      }
    }
    window.applyAlgorithm = applyAlgorithm;

    async function saveAlgoResult(slug, algoId) {
      var content = window._algoResult || '';
      if (!content) return;
      var algo = ALGORITHMS_OF_THOUGHT.find(function(a) { return a.id === algoId; });
      var algoName = algo ? algo.title : algoId;

      try {
        await fetch(api('/api/research'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: '# ' + algoName + ' — Applied to [[' + slug + ']]\\n\\n' + content,
            title: algoName + ' on ' + slug,
          }),
        });
        var resultEl = document.getElementById('algo-result');
        if (resultEl) resultEl.remove();
        loadAllPages();
        loadSidebarStats();
        statsCache = null;
      } catch(e) {
        alert('Failed to save: ' + e.message);
      }
    }
    window.saveAlgoResult = saveAlgoResult;
    window.saveThought = saveThought;
    window.saveAndApplyAlgo = saveAndApplyAlgo;
    window.loadResurface = loadResurface;

    // Wiki Search
    async function wikiSearch() {
      var input = document.getElementById('wiki-search-input');
      var results = document.getElementById('wiki-search-results');
      if (!input || !results) return;
      var q = input.value.trim();
      if (!q) return;

      results.innerHTML = '<div class="spinner"></div>';
      try {
        var res = await fetch(api('/api/search?q=' + encodeURIComponent(q) + '&limit=15'));
        var data = await res.json();
        if (!data.results || data.results.length === 0) {
          results.innerHTML = '<div style="color:var(--text-dim);font-size:13px">No results for "' + escHtml(q) + '"</div>';
          return;
        }
        results.innerHTML = data.results.map(function(r) {
          return '<div class="resurface-card" onclick="navigateTo(&apos;' + r.slug + '&apos;)">' +
            '<div class="resurface-title">' + escHtml(r.title) + ' ' + typeBadge(r.type) +
            ' <span style="font-size:11px;color:var(--text-dim)">' + r.word_count + 'w, ' + r.backlinks + ' links</span></div>' +
            '<div class="resurface-excerpt">' + escHtml(r.summary || '') + '</div></div>';
        }).join('');
      } catch(e) {
        results.innerHTML = '<div style="color:var(--red);font-size:12px">Search failed: ' + e.message + '</div>';
      }
    }
    window.wikiSearch = wikiSearch;

    // Wiki Compile
    async function runCompile() {
      var btn = document.getElementById('compile-btn');
      var status = document.getElementById('maintenance-status');
      var results = document.getElementById('maintenance-results');
      if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Compiling...'; }
      if (status) status.innerHTML = '<span class="spinner"></span> LLM is analyzing wiki, creating index pages, filling gaps, enhancing connections...';
      if (results) results.innerHTML = '';

      try {
        var res = await fetch(api('/api/compile'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        var data = await res.json();
        if (data.error) { if (status) status.innerHTML = '<span style="color:var(--red)">Error: ' + data.error + '</span>'; return; }

        if (status) status.innerHTML = '<span style="color:var(--green)">Compile complete! ' + data.pages_created + ' pages created, ' + data.connections_added + ' connections added.</span>';

        var html = '';
        if (data.index_pages && data.index_pages.length > 0) {
          html += '<div style="margin-bottom:12px"><strong style="color:var(--accent)">Index Pages Created:</strong> ' +
            data.index_pages.map(function(s) { return '<span class="wiki-link" onclick="navigateTo(&apos;' + s + '&apos;)">' + s + '</span>'; }).join(', ') + '</div>';
        }
        if (data.missing_pages && data.missing_pages.length > 0) {
          html += '<div style="margin-bottom:12px"><strong style="color:var(--green)">Gap Pages Created:</strong> ' +
            data.missing_pages.map(function(s) { return '<span class="wiki-link" onclick="navigateTo(&apos;' + s + '&apos;)">' + s + '</span>'; }).join(', ') + '</div>';
        }
        if (data.new_connections && data.new_connections.length > 0) {
          html += '<div style="margin-bottom:12px"><strong style="color:var(--blue)">New Connections:</strong><ul style="margin-top:4px;font-size:12px">' +
            data.new_connections.slice(0, 5).map(function(c) { return '<li><span class="wiki-link" onclick="navigateTo(&apos;' + c.from_slug + '&apos;)">' + c.from_slug + '</span> &#8594; <span class="wiki-link" onclick="navigateTo(&apos;' + c.to_slug + '&apos;)">' + c.to_slug + '</span> — ' + escHtml(c.reason || '') + '</li>'; }).join('') + '</ul></div>';
        }
        if (data.synthesis_candidates && data.synthesis_candidates.length > 0) {
          html += '<div style="margin-bottom:12px"><strong style="color:var(--purple)">Synthesis Opportunities:</strong><ul style="margin-top:4px;font-size:12px">' +
            data.synthesis_candidates.map(function(s) { return '<li><strong>' + escHtml(s.title || '') + '</strong>: ' + escHtml(s.thesis || '') + ' <span style="color:var(--text-dim)">(' + (s.pages||[]).join(', ') + ')</span></li>'; }).join('') + '</ul></div>';
        }
        if (data.thin_pages && data.thin_pages.length > 0) {
          html += '<div><strong style="color:var(--amber)">Thin Pages to Improve:</strong><ul style="margin-top:4px;font-size:12px">' +
            data.thin_pages.map(function(p) { return '<li><span class="wiki-link" onclick="navigateTo(&apos;' + p.slug + '&apos;)">' + p.slug + '</span> — ' + escHtml(p.suggestion || '') + '</li>'; }).join('') + '</ul></div>';
        }

        if (results) results.innerHTML = html || '<div style="color:var(--text-dim);font-size:12px">Wiki is well-maintained. No changes needed.</div>';
        loadAllPages();
        loadSidebarStats();
        statsCache = null;
      } catch(e) {
        if (status) status.innerHTML = '<span style="color:var(--red)">Compile failed: ' + e.message + '</span>';
      }
      if (btn) { btn.disabled = false; btn.innerHTML = '&#9881; Compile Wiki'; }
    }
    window.runCompile = runCompile;

    // Wiki Lint
    async function runLint() {
      var btn = document.getElementById('lint-btn');
      var status = document.getElementById('maintenance-status');
      var results = document.getElementById('maintenance-results');
      if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Linting...'; }
      if (status) status.innerHTML = '<span class="spinner"></span> Running wiki health check...';
      if (results) results.innerHTML = '';

      try {
        var res = await fetch(api('/api/lint'), { method: 'POST' });
        var data = await res.json();
        if (data.error) { if (status) status.innerHTML = '<span style="color:var(--red)">Error: ' + data.error + '</span>'; return; }

        var score = data.health_score || 0;
        var scoreColor = score >= 80 ? 'var(--green)' : score >= 50 ? 'var(--amber)' : 'var(--red)';
        if (status) status.innerHTML = '<span style="color:' + scoreColor + ';font-weight:700;font-size:16px">' + score + '%</span> <span style="color:var(--text-dim)">health score</span>';

        var html = '';
        if (data.orphan_pages && data.orphan_pages.length > 0) {
          html += '<div style="margin-bottom:12px"><strong style="color:var(--amber)">Orphan Pages (' + data.orphan_pages.length + '):</strong> ' +
            '<span style="font-size:12px;color:var(--text-dim)">' + data.orphan_pages.slice(0, 10).map(function(s) {
              return '<span class="wiki-link" onclick="navigateTo(&apos;' + s + '&apos;)">' + s + '</span>';
            }).join(', ') + (data.orphan_pages.length > 10 ? '... +' + (data.orphan_pages.length - 10) + ' more' : '') + '</span></div>';
        }
        if (data.contradictions && data.contradictions.length > 0) {
          html += '<div style="margin-bottom:12px"><strong style="color:var(--red)">Contradictions:</strong><ul style="margin-top:4px;font-size:12px">' +
            data.contradictions.map(function(c) { return '<li>' + escHtml(c.issue || '') + ' (pages: ' + (c.pages||[]).join(', ') + ')</li>'; }).join('') + '</ul></div>';
        }
        if (data.missing_crossrefs && data.missing_crossrefs.length > 0) {
          html += '<div style="margin-bottom:12px"><strong style="color:var(--blue)">Missing Cross-references:</strong><ul style="margin-top:4px;font-size:12px">' +
            data.missing_crossrefs.map(function(c) { return '<li>' + c.from + ' &#8594; ' + c.suggested_link + ' — ' + escHtml(c.reason || '') + '</li>'; }).join('') + '</ul></div>';
        }
        if (data.suggestions && data.suggestions.length > 0) {
          html += '<div><strong style="color:var(--text-dim)">Suggestions:</strong><ul style="margin-top:4px;font-size:12px">' +
            data.suggestions.map(function(s) { return '<li>' + escHtml(s) + '</li>'; }).join('') + '</ul></div>';
        }

        if (results) results.innerHTML = html || '<div style="color:var(--green);font-size:12px">Wiki is healthy! No issues found.</div>';
      } catch(e) {
        if (status) status.innerHTML = '<span style="color:var(--red)">Lint failed: ' + e.message + '</span>';
      }
      if (btn) { btn.disabled = false; btn.innerHTML = '&#128269; Lint / Health Check'; }
    }
    window.runLint = runLint;

    // File Q&A answer back to wiki
    async function fileToWiki(content, title) {
      if (!content) return;
      try {
        var res = await fetch(api('/api/research'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: content, title: title || 'Q&A: ' + content.slice(0, 40) }),
        });
        var data = await res.json();
        if (data.error) { alert('Failed: ' + data.error); return; }
        alert('Filed to wiki! ' + data.entities + ' entities extracted, ' + data.pages_created + ' pages created.');
        loadAllPages();
        loadSidebarStats();
        statsCache = null;
      } catch(e) { alert('Error: ' + e.message); }
    }
    window.fileToWiki = fileToWiki;

    async function loadIdeasLab() {
      currentSlug = null;
      var el = document.getElementById('main-inner');
      el.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">' +
        '<div><h1 class="dash-title">Ideas Lab</h1>' +
        '<p class="dash-subtitle">AI-generated ideas from your knowledge base</p></div>' +
        '<div style="display:flex;gap:8px">' +
        '<button class="btn-primary" id="ideas-generate-btn" onclick="generateIdeas()">Generate Ideas</button>' +
        '<button class="btn-secondary" id="ideas-refresh-all-btn" onclick="refreshAllIdeas()" style="font-size:12px">Refresh All</button>' +
        '</div></div>' +
        '<div class="ideas-grid" id="ideas-grid">' +
        (ideasState.ideas.length > 0 ? ideasState.ideas.map(function(idea, i) { return renderIdeaCard(idea, i); }).join('') :
        '<div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--text-dim)">' +
        '<div style="font-size:48px;margin-bottom:16px">&#128161;</div>' +
        '<div style="font-size:16px;margin-bottom:8px">No ideas generated yet</div>' +
        '<div style="font-size:13px">Click "Generate Ideas" to discover surprising connections in your wiki</div>' +
        '</div>') +
        '</div>' +
        '<div id="ideas-connections-section">' +
        (ideasState.connections.length > 0 ? renderConnectionsSection(ideasState.connections) : '') +
        '</div>';
    }

    function renderIdeaCard(idea, index) {
      var complexityClass = 'idea-badge-' + (idea.build_complexity || 'week');
      var potentialClass = 'idea-badge-' + (idea.potential || 'medium');
      var borderColors = { high: 'var(--green)', medium: 'var(--amber)', low: 'var(--gray)' };
      var borderColor = borderColors[idea.potential] || 'var(--accent)';

      var inspirationLinks = (idea.inspiration || []).map(function(slug) {
        return '<span class="idea-inspiration-link" onclick="resetMainStyles();navigateTo(&apos;' + slug + '&apos;)">' + slug + '</span>';
      }).join('');

      return '<div class="idea-card" style="border-left-color:' + borderColor + '">' +
        '<div class="idea-card-title">' + escHtml(idea.title || '') + '</div>' +
        '<div class="idea-card-tagline">' + escHtml(idea.tagline || '') + '</div>' +
        '<div style="margin-bottom:10px">' +
        '<span class="idea-badge ' + complexityClass + '">' + (idea.build_complexity || 'week') + '</span>' +
        '<span class="idea-badge ' + potentialClass + '">' + (idea.potential || 'medium') + ' potential</span>' +
        '</div>' +
        '<div class="idea-card-desc">' + escHtml(idea.description || '') + '</div>' +
        '<div class="idea-card-section">' +
        '<div class="idea-card-section-label">Inspired by</div>' +
        '<div class="idea-inspiration">' + (inspirationLinks || '<span style="color:var(--text-faint);font-size:11px">None</span>') + '</div>' +
        '</div>' +
        '<div class="idea-card-section">' +
        '<div class="idea-card-section-label">Second-order connection</div>' +
        '<div class="idea-card-connection">' + escHtml(idea.second_order_connection || '') + '</div>' +
        '</div>' +
        '<div class="idea-card-section">' +
        '<div class="idea-card-section-label">First step</div>' +
        '<div class="idea-first-step">' + escHtml(idea.first_step || '') + '</div>' +
        '</div>' +
        '<div class="idea-card-actions">' +
        '<button class="btn-secondary" onclick="refreshSingleIdea(' + index + ')" style="font-size:11px;padding:5px 12px">&#128260; Refresh</button>' +
        '<button class="btn-primary" onclick="expandIdea(' + index + ')" style="font-size:11px;padding:5px 12px;background:var(--purple)">&#9889; Expand &amp; Build</button>' +
        '</div></div>';
    }

    function renderConnectionsSection(connections) {
      if (!connections || connections.length === 0) return '';
      var items = connections.map(function(c) {
        return '<div class="connection-item">' +
          '<span class="wiki-link" onclick="resetMainStyles();navigateTo(&apos;' + c.from + '&apos;)">' + c.from + '</span>' +
          '<span class="connection-arrow">&#8594;</span>' +
          '<span class="connection-via">' + c.via + '</span>' +
          '<span class="connection-arrow">&#8594;</span>' +
          '<span class="wiki-link" onclick="resetMainStyles();navigateTo(&apos;' + c.to + '&apos;)">' + c.to + '</span>' +
          '<span class="connection-insight">' + escHtml(c.insight || '') + '</span>' +
          '</div>';
      }).join('');
      return '<div class="connections-section">' +
        '<h2 class="section-header" style="margin-bottom:12px">Second-Order Connections Discovered</h2>' +
        items + '</div>';
    }

    async function generateIdeas() {
      if (ideasState.loading) return;
      ideasState.loading = true;
      var btn = document.getElementById('ideas-generate-btn');
      if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Thinking...'; }
      var grid = document.getElementById('ideas-grid');
      if (grid) grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px"><span class="spinner" style="width:24px;height:24px"></span><div style="margin-top:12px;color:var(--text-dim);font-size:13px">Gemma 4 is analyzing your wiki and finding connections...</div></div>';

      try {
        var res = await fetch(api('/api/ideas'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        var data = await res.json();
        if (data.error) throw new Error(data.error);
        ideasState.ideas = data.ideas || [];
        ideasState.connections = data.connections_found || [];
        loadIdeasLab();
      } catch (e) {
        if (grid) grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--red)">Error: ' + e.message + '</div>';
      }
      ideasState.loading = false;
      if (btn) { btn.disabled = false; btn.textContent = 'Generate Ideas'; }
    }

    async function refreshAllIdeas() {
      var exclude = ideasState.ideas.map(function(i) { return i.title; });
      ideasState.loading = true;
      var btn = document.getElementById('ideas-refresh-all-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Refreshing...'; }
      var grid = document.getElementById('ideas-grid');
      if (grid) grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px"><span class="spinner" style="width:24px;height:24px"></span><div style="margin-top:12px;color:var(--text-dim);font-size:13px">Generating fresh ideas...</div></div>';

      try {
        var res = await fetch(api('/api/ideas'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ exclude: exclude }),
        });
        var data = await res.json();
        if (data.error) throw new Error(data.error);
        ideasState.ideas = data.ideas || [];
        ideasState.connections = data.connections_found || [];
        loadIdeasLab();
      } catch (e) {
        if (grid) grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--red)">Error: ' + e.message + '</div>';
      }
      ideasState.loading = false;
      if (btn) { btn.disabled = false; btn.textContent = 'Refresh All'; }
    }

    async function refreshSingleIdea(index) {
      var exclude = ideasState.ideas.map(function(i) { return i.title; });
      var grid = document.getElementById('ideas-grid');
      var cards = grid ? grid.querySelectorAll('.idea-card') : [];
      if (cards[index]) {
        cards[index].style.opacity = '0.5';
        cards[index].innerHTML = '<div style="text-align:center;padding:40px"><span class="spinner"></span><div style="margin-top:8px;color:var(--text-dim);font-size:12px">Refreshing...</div></div>';
      }

      try {
        var res = await fetch(api('/api/ideas'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ exclude: exclude }),
        });
        var data = await res.json();
        if (data.error) throw new Error(data.error);
        if (data.ideas && data.ideas.length > 0) {
          ideasState.ideas[index] = data.ideas[0];
          if (data.connections_found) ideasState.connections = data.connections_found;
          loadIdeasLab();
        }
      } catch (e) {
        if (cards[index]) {
          cards[index].style.opacity = '1';
          cards[index].innerHTML = '<div style="color:var(--red);font-size:12px">Error: ' + e.message + '</div>';
        }
      }
    }

    async function expandIdea(index) {
      var idea = ideasState.ideas[index];
      if (!idea) return;

      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:9999';
      overlay.innerHTML = '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:32px;text-align:center;max-width:400px">' +
        '<div class="spinner" style="width:24px;height:24px;margin:0 auto 16px"></div>' +
        '<div style="color:var(--white);font-size:16px;font-weight:600">Expanding Idea</div>' +
        '<div style="color:var(--text-dim);font-size:13px;margin-top:8px">Gemma 4 is turning "' + escHtml(idea.title) + '" into a full build plan...</div></div>';
      document.body.appendChild(overlay);

      try {
        var res = await fetch(api('/api/ideas/expand'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idea: idea }),
        });
        var data = await res.json();
        document.body.removeChild(overlay);

        if (data.error) { alert('Expand failed: ' + data.error); return; }

        loadAllPages();
        loadSidebarStats();
        statsCache = null;
        resetMainStyles();
        navigateTo(data.plan_slug);
      } catch (e) {
        document.body.removeChild(overlay);
        alert('Expand failed: ' + e.message);
      }
    }

    // --- Init ---
    async function init() {
      try {
        await Promise.all([loadSidebarStats().catch(function(){}), loadAllPages().catch(function(){})]);
      } catch(e) { console.error('Init data load failed:', e); }
      try {
        loadDashboard();
      } catch(e) { console.error('Dashboard render failed:', e); document.getElementById('main-inner').innerHTML = '<div style="padding:40px;color:#CC4455">Dashboard failed to load: ' + e.message + '</div>'; }
    }
    init();
  </script>
</body>
</html>`;
}
