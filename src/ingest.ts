import { Env, ExtractedEntity, ExtractionResult, IngestResult } from './types';
import { runAIJSON, runAI } from './ai';
import { INGEST_PROMPT, UPDATE_PROMPT } from './prompts';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function countTokensEstimate(text: string): number {
  // Rough estimate: ~4 chars per token
  return Math.ceil(text.length / 4);
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function extractWikiLinks(content: string): string[] {
  const matches = content.match(/\[\[([^\]]+)\]\]/g) || [];
  return [...new Set(matches.map((m) => m.slice(2, -2)))];
}

export async function ingestSource(
  env: Env,
  filename: string,
  content: string,
  sourceType: string
): Promise<IngestResult> {
  const sourceId = crypto.randomUUID();
  const contentHash = await hashContent(content);

  // Check for duplicate
  const existing = await env.DB.prepare(
    'SELECT id FROM sources WHERE content_hash = ?'
  )
    .bind(contentHash)
    .first();

  if (existing) {
    return {
      source_id: existing.id as string,
      pages_created: [],
      pages_updated: [],
      entities_extracted: 0,
    };
  }

  // Store raw source in R2
  const r2Key = `sources/${sourceId}/${filename}`;
  await env.STORAGE.put(r2Key, content);

  // Register source in D1
  await env.DB.prepare(
    `INSERT INTO sources (id, filename, source_type, r2_key, content_hash, token_count)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(sourceId, filename, sourceType, r2Key, contentHash, countTokensEstimate(content))
    .run();

  // Get existing pages for context — build a slug lookup map
  const existingPages = await env.DB.prepare(
    'SELECT slug, title, page_type FROM pages LIMIT 300'
  ).all();

  const slugSet = new Set<string>(existingPages.results.map((p: any) => p.slug));

  const existingContext =
    existingPages.results.length > 0
      ? `\n\nExisting wiki pages — ALWAYS use these exact slugs for links_to:\n${existingPages.results
          .map((p: any) => `- [[${p.slug}]] (${p.title}, ${p.page_type})`)
          .join('\n')}`
      : '';

  // Call AI to extract entities
  let extraction: ExtractionResult;
  try {
    extraction = await runAIJSON<ExtractionResult>(
      env.AI,
      'ingest',
      INGEST_PROMPT + existingContext,
      `Source document (${filename}, type: ${sourceType}):\n\n${content}`,
      8000
    );
  } catch (extractErr) {
    // If AI fails, create a single page from the source as-is
    console.log('EXTRACTION_FAILED:', (extractErr as Error).message);
    const title = filename.replace(/\.md$/, '').replace(/[-_]/g, ' ');
    extraction = {
      entities: [{
        title,
        slug: slugify(title),
        page_type: sourceType === 'chat' ? 'daily' : 'concept',
        summary: content.slice(0, 200).replace(/\n/g, ' '),
        tags: [sourceType],
        content,
        links_to: [],
      }],
      source_summary: `Raw import of ${filename}`,
    };
  }

  // Ensure entities is an array
  if (!Array.isArray(extraction.entities)) {
    extraction.entities = [];
  }

  const pagesCreated: string[] = [];
  const pagesUpdated: string[] = [];

  // Process each extracted entity
  for (const entity of extraction.entities) {
    const slug = entity.slug || slugify(entity.title);

    // Normalize links_to: convert titles to slugs, validate against existing pages
    let linksFromAI = entity.links_to || [];
    const normalizedLinks: string[] = [];
    for (const link of linksFromAI) {
      const linkSlug = slugify(link);
      // Try exact match first, then slugified version
      if (slugSet.has(link)) {
        normalizedLinks.push(link);
      } else if (slugSet.has(linkSlug)) {
        normalizedLinks.push(linkSlug);
      }
      // Also add slugs of other entities being created in this batch
      else if (extraction.entities.some(e => (e.slug || slugify(e.title)) === linkSlug)) {
        normalizedLinks.push(linkSlug);
      }
    }

    // Check if page exists
    const existingPage = await env.DB.prepare(
      'SELECT id FROM pages WHERE slug = ?'
    )
      .bind(slug)
      .first();

    if (existingPage) {
      // Fetch existing content from R2
      const existingContent = await env.STORAGE.get(`wiki/${slug}.md`);
      const existingText = existingContent
        ? await existingContent.text()
        : '';

      // Merge with AI
      let updated: { content: string; summary: string; tags: string[]; links_to: string[]; changes: string };
      try {
        updated = await runAIJSON<typeof updated>(
          env.AI,
          'ingest',
          UPDATE_PROMPT,
          `Existing page (${slug}):\n\n${existingText}\n\nNew information:\n\n${entity.content}`
        );
      } catch {
        // If merge fails, just append
        updated = {
          content: existingText + '\n\n---\n\n' + entity.content,
          summary: entity.summary || '',
          tags: entity.tags || [],
          links_to: normalizedLinks,
          changes: 'Appended new content (merge failed)',
        };
      }

      // Store updated page
      await env.STORAGE.put(`wiki/${slug}.md`, updated.content);

      // Extract wiki links from the actual content as ground truth, merge with AI links
      const contentLinks = extractWikiLinks(updated.content);
      const aiLinks = (updated.links_to || []).map(l => slugify(l)).filter(l => slugSet.has(l));
      const allLinks = [...new Set([...contentLinks, ...aiLinks, ...normalizedLinks])];

      await env.DB.prepare(
        `UPDATE pages SET summary = ?, tags = ?, word_count = ?, links_to = ?, updated_at = datetime('now')
         WHERE slug = ?`
      )
        .bind(
          updated.summary,
          JSON.stringify(updated.tags),
          countWords(updated.content),
          JSON.stringify(allLinks),
          slug
        )
        .run();

      pagesUpdated.push(slug);
    } else {
      // Create new page
      const pageId = crypto.randomUUID();
      const pageContent = entity.content;

      // Extract wiki links from content as ground truth, merge with AI + normalized
      const contentLinks = extractWikiLinks(pageContent);
      const allLinks = [...new Set([...contentLinks, ...normalizedLinks])];

      // Store in R2
      await env.STORAGE.put(`wiki/${slug}.md`, pageContent);

      // Insert into D1
      await env.DB.prepare(
        `INSERT INTO pages (id, title, slug, page_type, summary, tags, word_count, links_to, linked_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]')`
      )
        .bind(
          pageId,
          entity.title,
          slug,
          entity.page_type || 'concept',
          entity.summary,
          JSON.stringify(entity.tags || []),
          countWords(pageContent),
          JSON.stringify(allLinks)
        )
        .run();

      pagesCreated.push(slug);
      slugSet.add(slug); // Add to set so subsequent entities can link to it
    }
  }

  // Update backlinks (linked_from) for all affected pages
  await updateBacklinks(env, [...pagesCreated, ...pagesUpdated]);

  // Mark source as ingested
  const allPageSlugs = [...pagesCreated, ...pagesUpdated];
  await env.DB.prepare(
    `UPDATE sources SET ingested = 1, summary = ?, pages_updated = ?, ingested_at = datetime('now')
     WHERE id = ?`
  )
    .bind(
      extraction.source_summary,
      JSON.stringify(allPageSlugs),
      sourceId
    )
    .run();

  // Log activity
  await env.DB.prepare(
    `INSERT INTO activity_log (action, details, pages_touched)
     VALUES ('ingest', ?, ?)`
  )
    .bind(
      JSON.stringify({
        source_id: sourceId,
        filename,
        source_type: sourceType,
        entities_extracted: extraction.entities.length,
        pages_created: pagesCreated,
        pages_updated: pagesUpdated,
      }),
      JSON.stringify(allPageSlugs)
    )
    .run();

  return {
    source_id: sourceId,
    pages_created: pagesCreated,
    pages_updated: pagesUpdated,
    entities_extracted: extraction.entities.length,
  };
}

async function updateBacklinks(env: Env, slugs: string[]): Promise<void> {
  // For each updated/created page, find what it links to and update those pages' linked_from
  for (const slug of slugs) {
    const page = await env.DB.prepare(
      'SELECT links_to FROM pages WHERE slug = ?'
    )
      .bind(slug)
      .first();

    if (!page) continue;

    const linksTo: string[] = JSON.parse((page.links_to as string) || '[]');

    for (const targetSlug of linksTo) {
      const target = await env.DB.prepare(
        'SELECT linked_from FROM pages WHERE slug = ?'
      )
        .bind(targetSlug)
        .first();

      if (!target) continue;

      const linkedFrom: string[] = JSON.parse(
        (target.linked_from as string) || '[]'
      );
      if (!linkedFrom.includes(slug)) {
        linkedFrom.push(slug);
        await env.DB.prepare(
          'UPDATE pages SET linked_from = ? WHERE slug = ?'
        )
          .bind(JSON.stringify(linkedFrom), targetSlug)
          .run();
      }
    }
  }
}

export async function ingestBatch(
  env: Env,
  sources: { filename: string; content: string; source_type: string }[]
): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (const source of sources) {
    const result = await ingestSource(
      env,
      source.filename,
      source.content,
      source.source_type
    );
    results.push(result);
  }
  return results;
}
