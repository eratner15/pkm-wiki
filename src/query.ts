import { Env, QueryResult } from './types';
import { runAIJSON } from './ai';
import { QUERY_PROMPT } from './prompts';

interface GemmaQueryResponse {
  answer: string;
  citations: { slug: string; title: string; excerpt: string }[];
  suggested_pages: string[];
}

function sanitizeFTS(query: string): string {
  // Extract words, remove special chars, join with OR for broad matching
  const words = query.replace(/[^a-zA-Z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  if (words.length === 0) return '';
  return words.join(' OR ');
}

export async function queryWiki(
  env: Env,
  question: string
): Promise<QueryResult> {
  const ftsQuery = sanitizeFTS(question);

  // Search pages via FTS
  let ftsResults = { results: [] as any[] };
  if (ftsQuery) {
    try {
      ftsResults = await env.DB.prepare(
        `SELECT p.slug, p.title, p.summary, p.page_type, p.tags
         FROM pages_fts fts
         JOIN pages p ON fts.rowid = p.rowid
         WHERE pages_fts MATCH ?
         ORDER BY rank
         LIMIT 10`
      )
        .bind(ftsQuery)
        .all();
    } catch {
      // FTS failed, fall through to fallback
    }
  }

  // If FTS returns nothing, fall back to scanning all pages
  let relevantPages = ftsResults.results;
  if (relevantPages.length === 0) {
    const allPages = await env.DB.prepare(
      'SELECT slug, title, summary, page_type, tags FROM pages ORDER BY updated_at DESC LIMIT 20'
    ).all();
    relevantPages = allPages.results;
  }

  if (relevantPages.length === 0) {
    return {
      answer:
        'The wiki is empty. Ingest some sources first to build your knowledge base.',
      citations: [],
      pages_created: [],
    };
  }

  // Fetch top-N page contents from R2
  const pageContents: string[] = [];
  const topN = Math.min(relevantPages.length, 5);

  for (let i = 0; i < topN; i++) {
    const page = relevantPages[i] as any;
    const obj = await env.STORAGE.get(`wiki/${page.slug}.md`);
    if (obj) {
      const text = await obj.text();
      pageContents.push(
        `--- Page: ${page.title} (${page.slug}) ---\n${text}\n`
      );
    }
  }

  const context = pageContents.join('\n\n');

  // Call Gemma
  const response = await runAIJSON<GemmaQueryResponse>(
    env.AI,
    'query',
    QUERY_PROMPT,
    `Wiki context:\n\n${context}\n\nQuestion: ${question}`
  );

  // Log activity
  await env.DB.prepare(
    `INSERT INTO activity_log (action, details, pages_touched)
     VALUES ('query', ?, ?)`
  )
    .bind(
      JSON.stringify({
        question,
        pages_searched: relevantPages.length,
        citations: response.citations?.length || 0,
      }),
      JSON.stringify(
        (response.citations || []).map((c: { slug: string }) => c.slug)
      )
    )
    .run();

  return {
    answer: response.answer,
    citations: response.citations || [],
    pages_created: [],
  };
}
