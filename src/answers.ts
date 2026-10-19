/**
 * Saved answers: a good answer from "Ask" is kept as a wiki page, word for word,
 * with the question, the date and links to the pages it used. Saved answers are
 * ordinary pages (tag "answer"), so search and later answers can build on them.
 */
import { Env } from './types';
import { librarySlug } from './journal-library';

export interface Citation { slug: string; title?: string; excerpt?: string }

export function answerMarkdown(question: string, answer: string, citations: Citation[], date: string): string {
  const sources = citations.filter(c => c.slug);
  return [
    `# ${question}`,
    '',
    `*Saved answer · ${date}${sources.length ? ` · from ${sources.map(c => `[[${c.title || c.slug}]]`).join(', ')}` : ''}*`,
    '',
    answer.trim(),
    '',
    ...(sources.length ? ['## Sources', '', ...sources.map(c => `- [[${c.title || c.slug}]]${c.excerpt ? ` — ${c.excerpt.replace(/\s+/g, ' ').trim()}` : ''}`), ''] : []),
  ].join('\n');
}

export async function saveAnswer(env: Env, input: { question: string; answer: string; citations?: Citation[] }) {
  const question = String(input.question || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const answer = String(input.answer || '').trim().slice(0, 40000);
  if (!question || answer.length < 20) throw new Error('A question and an answer are required.');
  const citations = (Array.isArray(input.citations) ? input.citations : [])
    .filter(c => c && typeof c.slug === 'string' && /^[a-z0-9-]{1,120}$/.test(c.slug)).slice(0, 20);

  // Unique slug: "answer-<question words>", then -2, -3 … if taken.
  const base = ('answer-' + librarySlug(question)).slice(0, 80).replace(/-$/, '');
  let slug = base;
  for (let n = 2; await env.DB.prepare('SELECT 1 FROM pages WHERE slug = ?').bind(slug).first(); n++) slug = `${base}-${n}`;

  const date = new Date().toISOString().slice(0, 10);
  const md = answerMarkdown(question, answer, citations, date);
  const plain = answer.replace(/[#*_>`\[\]]/g, '').replace(/\s+/g, ' ').trim();
  const links = [...new Set(citations.map(c => c.slug))];
  await env.STORAGE.put(`wiki/${slug}.md`, md);
  await env.DB.prepare(
    `INSERT INTO pages (id, title, slug, page_type, summary, tags, word_count, links_to, linked_from)
     VALUES (?, ?, ?, 'concept', ?, '["answer","output"]', ?, ?, '[]')`
  ).bind(crypto.randomUUID(), question, slug, plain.slice(0, 240), plain.split(' ').length, JSON.stringify(links)).run();

  // Backlinks on the pages the answer used.
  const stmts: D1PreparedStatement[] = [];
  for (const target of links) {
    const row = await env.DB.prepare('SELECT linked_from FROM pages WHERE slug = ?').bind(target).first() as any;
    if (!row) continue;
    let from: string[] = [];
    try { from = JSON.parse(row.linked_from || '[]'); } catch { /* bad JSON: start over */ }
    if (!from.includes(slug)) stmts.push(env.DB.prepare('UPDATE pages SET linked_from = ? WHERE slug = ?').bind(JSON.stringify([...from, slug]), target));
  }
  stmts.push(env.DB.prepare(`INSERT INTO activity_log (action, details, pages_touched) VALUES ('save_answer', ?, ?)`)
    .bind(JSON.stringify({ question, sources: links.length }), JSON.stringify([slug, ...links])));
  await env.DB.batch(stmts);
  return { slug, title: question };
}

export async function listAnswers(env: Env) {
  return ((await env.DB.prepare(
    `SELECT slug, title, summary, created_at, links_to FROM pages WHERE tags LIKE '%"answer"%' ORDER BY created_at DESC LIMIT 300`
  ).all()).results || []) as any[];
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function answersPageHTML(rows: any[]): string {
  const items = rows.map(r => {
    let n = 0; try { n = JSON.parse(r.links_to || '[]').length; } catch { /* none */ }
    return `<li><a href="/#/page/${esc(r.slug)}"><b>${esc(r.title)}</b></a><span class="meta">${esc(String(r.created_at || '').slice(0, 10))}${n ? ` · ${n} ${n === 1 ? 'source' : 'sources'}` : ''}</span><p>${esc(r.summary)}</p></li>`;
  }).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Saved Answers</title>
<style>
:root { --ink: #1C1B19; --dim: #5F5C55; --rule: #E2DFD8; --bg: #F7F5F0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); color: var(--ink); font: 15px/1.5 -apple-system, system-ui, sans-serif; padding: 24px 16px 60px; }
main { max-width: 820px; margin: 0 auto; }
a { color: inherit; } .back { color: var(--dim); font-size: 13px; text-decoration: none; }
h1 { font: 600 30px/1.1 Georgia, serif; margin: 10px 0 6px; }
.sub { color: var(--dim); margin-bottom: 18px; }
ul { list-style: none; } li { background: #fff; border: 1px solid var(--rule); border-radius: 10px; padding: 14px 16px; margin-bottom: 10px; }
li a { text-decoration: none; } .meta { display: block; font-size: 12px; color: var(--dim); margin: 2px 0 6px; } li p { color: #3B3A36; font-size: 14px; }
</style></head><body><main>
<a class="back" href="/">← Wiki</a>
<h1>Saved Answers</h1>
<p class="sub">${rows.length ? `${rows.length} ${rows.length === 1 ? 'answer' : 'answers'}, newest first. Each one is a wiki page that later answers can use.` : 'No saved answers yet. Ask a question on the wiki home page, then press <b>Save answer</b>.'}</p>
<ul>${items}</ul>
</main></body></html>`;
}
