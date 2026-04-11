// Vectorize — Semantic search over wiki pages using BGE embeddings

export async function indexPage(env: any, pageId: string, title: string, summary: string, tags: string[]) {
  if (!env.VECTORIZE) return; // Skip if binding not available
  try {
    const text = `${title}. ${summary}. Tags: ${tags.join(', ')}`;
    const embedding = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [text] });
    await env.VECTORIZE.upsert([{
      id: pageId,
      values: embedding.data[0],
      metadata: { title, pageId },
    }]);
  } catch (e) {
    console.error('Vectorize indexPage failed:', e);
  }
}

export async function searchSimilar(env: any, query: string, limit = 10) {
  if (!env.VECTORIZE) return [];
  const embedding = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [query] });
  const results = await env.VECTORIZE.query(embedding.data[0], { topK: limit, returnMetadata: 'all' });
  return results.matches;
}

export async function findSimilarPages(env: any, pageId: string, limit = 5) {
  if (!env.VECTORIZE) return [];
  const page = await env.DB.prepare('SELECT title, summary, tags FROM pages WHERE id = ?').bind(pageId).first();
  if (!page) return [];
  const text = `${page.title}. ${page.summary}`;
  const embedding = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [text] });
  const results = await env.VECTORIZE.query(embedding.data[0], { topK: limit + 1, returnMetadata: 'all' });
  return results.matches.filter((m: any) => m.id !== pageId);
}

export async function rebuildIndex(env: any) {
  if (!env.VECTORIZE) return { indexed: 0, error: 'VECTORIZE binding not available' };
  const pages = await env.DB.prepare('SELECT id, title, summary, tags FROM pages').all();
  let indexed = 0;
  const errors: string[] = [];
  // Process in batches of 10
  const batch: any[] = [];
  for (const p of pages.results as any[]) {
    const text = `${p.title}. ${p.summary || ''}. Tags: ${(() => { try { return JSON.parse(p.tags || '[]').join(', '); } catch { return ''; } })()}`;
    try {
      const embedding = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [text] });
      batch.push({
        id: p.id,
        values: embedding.data[0],
        metadata: { title: p.title, pageId: p.id },
      });
      if (batch.length >= 10) {
        await env.VECTORIZE.upsert(batch.splice(0));
        indexed += 10;
      }
    } catch (e: any) {
      errors.push(`${p.title}: ${e.message}`);
    }
  }
  if (batch.length > 0) {
    await env.VECTORIZE.upsert(batch);
    indexed += batch.length;
  }
  return { indexed, total: pages.results.length, errors: errors.slice(0, 10) };
}
