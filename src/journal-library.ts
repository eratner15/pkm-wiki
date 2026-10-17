/**
 * Library import: Roam knowledge pages (books, frameworks, notes) into the wiki's
 * `pages` table, with the page text in R2 at wiki/<slug>.md. Unlike the older
 * /api/import/roam route, this never appends to or overwrites a page: a slug that
 * already exists is reported and skipped, so the import can run again safely.
 */
import { Env } from './types';

/** Same slug rule as /api/import/roam, so earlier Roam imports are recognized. */
export function librarySlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function plainText(md: string): string {
  return md
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/\(\([\w-]{6,}\)\)/g, ' ')
    .replace(/#?\[\[([^\]]+)\]\]/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface LibraryPage { title: string; body: string }

export async function importLibrary(env: Env, pages: LibraryPage[], opts: { dryRun?: boolean } = {}) {
  const clean = pages
    .map(p => ({ title: String(p.title || '').trim().slice(0, 200), body: String(p.body || '') }))
    .filter(p => p.title && plainText(p.body).length >= 20);
  const skippedEmpty = pages.length - clean.length;

  // Look up existing slugs in chunks (D1 caps bound parameters per statement).
  const slugs = [...new Set(clean.map(p => librarySlug(p.title)).filter(Boolean))];
  const existing = new Set<string>();
  for (let i = 0; i < slugs.length; i += 90) {
    const part = slugs.slice(i, i + 90);
    const r = await env.DB.prepare(`SELECT slug FROM pages WHERE slug IN (${part.map(() => '?').join(',')})`).bind(...part).all();
    for (const row of (r.results || []) as any[]) existing.add(row.slug);
  }

  const created: string[] = [];
  const skippedExisting: string[] = [];
  const seen = new Set<string>();
  const stmts: D1PreparedStatement[] = [];
  for (const p of clean) {
    const slug = librarySlug(p.title);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    if (existing.has(slug)) { skippedExisting.push(p.title); continue; }

    const text = plainText(p.body);
    const links = [...new Set([...p.body.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => librarySlug(m[1])).filter(Boolean))].slice(0, 200);
    const hashTags = [...p.body.matchAll(/#\[\[([^\]]+)\]\]|#([A-Za-z][\w-]{2,30})/g)]
      .map(m => (m[1] || m[2]).toLowerCase().replace(/[^a-z0-9]+/g, '-')).filter(Boolean);
    const tags = ['roam', 'library', ...(/\(highlights\)|\bbook\b/i.test(p.title) ? ['book'] : []), ...new Set(hashTags)].slice(0, 10);
    const type = /\(highlights\)|\bbook\b/i.test(p.title) ? 'concept' : /^@/.test(p.title) ? 'entity' : 'concept';

    created.push(p.title);
    if (opts.dryRun) continue;
    await env.STORAGE.put(`wiki/${slug}.md`, `# ${p.title}\n\n${p.body.trim()}\n`);
    stmts.push(env.DB.prepare(
      `INSERT INTO pages (id, title, slug, page_type, summary, tags, word_count, links_to, linked_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]')`
    ).bind(crypto.randomUUID(), p.title, slug, type, text.slice(0, 240), JSON.stringify(tags), text.split(' ').length, JSON.stringify(links)));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));

  if (!opts.dryRun && created.length) {
    await env.DB.prepare(`INSERT INTO activity_log (action, details, pages_touched) VALUES ('import', ?, '[]')`)
      .bind(JSON.stringify({ source: 'roam-library', created: created.length, skipped_existing: skippedExisting.length })).run();
  }
  return { created: created.length, skipped_existing: skippedExisting.length, skipped_empty: skippedEmpty, existing_titles: skippedExisting.slice(0, 50), dry_run: !!opts.dryRun };
}
