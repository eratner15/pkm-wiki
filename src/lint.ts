import { Env, LintResult } from './types';
import { runAIJSON } from './ai';
import { LINT_PROMPT } from './prompts';

interface GemmaLintResponse {
  contradictions: { pages: string[]; issue: string }[];
  stale_claims: { page: string; claim: string; reason: string }[];
  missing_crossrefs: {
    from: string;
    suggested_link: string;
    reason: string;
  }[];
  suggestions: string[];
}

export async function lintWiki(env: Env): Promise<LintResult> {
  // Get all pages
  const allPages = await env.DB.prepare(
    'SELECT slug, title, page_type, summary, tags, links_to, linked_from, word_count FROM pages ORDER BY title'
  ).all();

  if (allPages.results.length === 0) {
    return {
      contradictions: [],
      stale_claims: [],
      orphan_pages: [],
      missing_crossrefs: [],
      health_score: 100,
    };
  }

  // Find orphan pages (no inbound links)
  const orphanPages: string[] = [];
  for (const page of allPages.results as any[]) {
    const linkedFrom: string[] = JSON.parse(page.linked_from || '[]');
    if (linkedFrom.length === 0) {
      orphanPages.push(page.slug);
    }
  }

  // Fetch content for up to 20 pages for Gemma analysis
  const pageContents: string[] = [];
  const pagesToCheck = allPages.results.slice(0, 20) as any[];

  for (const page of pagesToCheck) {
    const obj = await env.STORAGE.get(`wiki/${page.slug}.md`);
    if (obj) {
      const text = await obj.text();
      pageContents.push(
        `--- Page: ${page.title} (${page.slug}, type: ${page.page_type}) ---\n${text}\n`
      );
    }
  }

  // Call Gemma for content analysis
  let gemmaResult: GemmaLintResponse = {
    contradictions: [],
    stale_claims: [],
    missing_crossrefs: [],
    suggestions: [],
  };

  if (pageContents.length > 0) {
    try {
      gemmaResult = await runAIJSON<GemmaLintResponse>(
        env.AI,
        'query',
        LINT_PROMPT,
        `Wiki pages to audit:\n\n${pageContents.join('\n\n')}`
      );
    } catch {
      // If Gemma fails, continue with structural checks only
    }
  }

  // Calculate health score
  const totalPages = allPages.results.length;
  const issueCount =
    (gemmaResult.contradictions?.length || 0) +
    (gemmaResult.stale_claims?.length || 0) +
    orphanPages.length +
    (gemmaResult.missing_crossrefs?.length || 0);

  // Score: 100 - (issues / pages * 20), clamped to [0, 100]
  const healthScore = Math.max(
    0,
    Math.min(100, Math.round(100 - (issueCount / Math.max(totalPages, 1)) * 20))
  );

  const result: LintResult = {
    contradictions: gemmaResult.contradictions || [],
    stale_claims: gemmaResult.stale_claims || [],
    orphan_pages: orphanPages,
    missing_crossrefs: gemmaResult.missing_crossrefs || [],
    health_score: healthScore,
  };

  // Log activity
  await env.DB.prepare(
    `INSERT INTO activity_log (action, details, pages_touched)
     VALUES ('lint', ?, ?)`
  )
    .bind(
      JSON.stringify({
        pages_checked: pagesToCheck.length,
        orphans: orphanPages.length,
        contradictions: result.contradictions.length,
        stale: result.stale_claims.length,
        missing_refs: result.missing_crossrefs.length,
        health_score: healthScore,
      }),
      JSON.stringify(pagesToCheck.map((p: any) => p.slug))
    )
    .run();

  return result;
}
