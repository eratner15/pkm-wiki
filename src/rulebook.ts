/**
 * The wiki rulebook: one editable page of rules that every AI prompt reads first
 * (the CLAUDE.md idea from "How I use Claude as my second brain"). It lives at
 * wiki/wiki-rulebook.md with a `pages` row, so it is also an ordinary wiki page.
 * Until it is saved once, the default below applies.
 */
import { Env } from './types';
import { setRulebook } from './ai';

export const RULEBOOK_SLUG = 'wiki-rulebook';
const CACHE_MS = 5 * 60 * 1000;
let cached: { text: string; at: number } | null = null;

export const DEFAULT_RULEBOOK = `# Wiki Rulebook

Read these rules before every task. They override any other instruction about how to write the wiki.

## Purpose
This is a personal knowledge wiki. The owner adds sources and asks questions. You keep the wiki accurate, linked and useful.

## Ownership
- Sources (imported files, URLs, Roam exports, daily notes, journal entries) are the record. Read them; never rewrite or delete them.
- Wiki pages (concepts, entities, projects, topic hubs, the index) are yours to write and maintain.
- Saved answers (tag "answer") are kept as written. Add to them only when asked.

## Pages
- Slugs are lowercase words joined by hyphens. Titles use the common name of the thing.
- Every page starts with a two or three sentence summary, then the details.
- Use [[Page Title]] links for every other page you mention, and end with a "Related" list of the closest pages.
- A topic hub page has three parts: the pages in the topic, the key facts at a glance, and a one-paragraph view of what matters most.
- Prefer updating an existing page to creating a near-duplicate.

## Sources and truth
- Rank sources: (1) the owner's own notes and journal; (2) primary documents such as filings, papers and official pages; (3) reputable reporting and transcripts; (4) social posts, newsletters and opinion.
- When sources disagree, keep both claims, say which source says what, and prefer the higher rank. Never silently overwrite.
- Every number and date carries its source. Say "unknown" rather than guess.
- For investing pages, tag each claim VERIFIED (primary source), DIRECTIONAL (credible but not exact), or UNVERIFIED (leave it out of conclusions).

## Answers
- Answer from the wiki first and cite the pages you used.
- Say plainly when the wiki does not hold the answer.
- A good answer is worth saving; it then becomes a page that later answers can build on.

## Checks
- A quality check (lint) reports contradictions, stale numbers, orphan pages and gaps as a list. It does not fix them; the owner decides.

## Style
- Plain, short sentences. One fact per sentence where possible. Active voice.
- Never store passwords, keys, tokens, account numbers or wallet recovery phrases. Replace them with [removed].
`;

/** Read the rulebook (cached for five minutes) and hand it to the AI layer. */
export async function primeRulebook(env: Env): Promise<string> {
  if (cached && Date.now() - cached.at < CACHE_MS) { setRulebook(cached.text); return cached.text; }
  let text = DEFAULT_RULEBOOK;
  try {
    const obj = await env.STORAGE.get(`wiki/${RULEBOOK_SLUG}.md`);
    if (obj) text = (await obj.text()).trim() || DEFAULT_RULEBOOK;
  } catch { /* fall back to the default */ }
  cached = { text, at: Date.now() };
  setRulebook(text);
  return text;
}

export async function getRulebook(env: Env): Promise<{ text: string; saved: boolean }> {
  const obj = await env.STORAGE.get(`wiki/${RULEBOOK_SLUG}.md`);
  return obj ? { text: await obj.text(), saved: true } : { text: DEFAULT_RULEBOOK, saved: false };
}

export async function saveRulebook(env: Env, text: string): Promise<void> {
  const body = String(text || '').replace(/\r/g, '').trim().slice(0, 20000);
  if (body.length < 40) throw new Error('The rulebook is too short to save.');
  await env.STORAGE.put(`wiki/${RULEBOOK_SLUG}.md`, body + '\n');
  const words = body.split(/\s+/).length;
  const summary = 'The rules every AI task in this wiki follows: ownership, page structure, source ranking, answers, checks and style.';
  await env.DB.prepare(
    `INSERT INTO pages (id, title, slug, page_type, summary, tags, word_count, links_to, linked_from)
     VALUES (?, 'Wiki Rulebook', ?, 'index', ?, '["rulebook"]', ?, '[]', '[]')
     ON CONFLICT(slug) DO UPDATE SET word_count = excluded.word_count, updated_at = datetime('now')`
  ).bind(crypto.randomUUID(), RULEBOOK_SLUG, summary, words).run();
  await env.DB.prepare(`INSERT INTO activity_log (action, details, pages_touched) VALUES ('rulebook', ?, ?)`)
    .bind(JSON.stringify({ words }), JSON.stringify([RULEBOOK_SLUG])).run();
  cached = { text: body, at: Date.now() };
  setRulebook(body);
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function rulebookPageHTML(text: string, saved: boolean): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wiki Rulebook</title>
<style>
:root { --ink: #1C1B19; --dim: #5F5C55; --rule: #E2DFD8; --accent: #9C7A2B; --bg: #F7F5F0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); color: var(--ink); font: 15px/1.5 -apple-system, system-ui, sans-serif; padding: 24px 16px 60px; }
main { max-width: 860px; margin: 0 auto; }
a { color: var(--dim); font-size: 13px; text-decoration: none; }
h1 { font: 600 30px/1.1 Georgia, serif; margin: 10px 0 6px; }
p { color: var(--dim); margin-bottom: 14px; max-width: 640px; }
textarea { width: 100%; min-height: 62vh; font: 14px/1.55 ui-monospace, Menlo, monospace; padding: 14px; border: 1px solid var(--rule); border-radius: 10px; background: #fff; color: var(--ink); }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; }
button { font: 500 14px system-ui, sans-serif; border: 1px solid #ccc; background: #fff; border-radius: 7px; padding: 8px 14px; cursor: pointer; }
button.primary { background: var(--ink); color: #fff; border-color: var(--ink); }
#status { font-size: 13px; color: var(--dim); }
</style></head><body><main>
<a href="/">← Wiki</a>
<h1>Wiki Rulebook</h1>
<p>Every AI task in the wiki reads these rules first: ingest, research, answers, checks and ideas. Edit them like any document. Changes apply within five minutes.${saved ? '' : ' <b>This is the default text; it applies until you save.</b>'}</p>
<textarea id="t" spellcheck="true" aria-label="Rulebook text">${esc(text)}</textarea>
<div class="row"><button class="primary" onclick="save()">Save rulebook</button><button onclick="reset()">Load the default text</button><span id="status"></span></div>
<script>
const DEFAULT = ${JSON.stringify(DEFAULT_RULEBOOK).replace(/</g, '\\u003c')};
async function save() {
  const s = document.getElementById('status'); s.textContent = 'Saving…';
  try {
    const r = await fetch('/api/rulebook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: document.getElementById('t').value }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status);
    s.textContent = 'Saved. Every AI task now follows this version.';
  } catch (e) { s.textContent = 'Not saved: ' + e.message; }
}
function reset() { if (confirm('Replace the text in the editor with the default? Nothing is saved until you press Save.')) document.getElementById('t').value = DEFAULT; }
</script>
</main></body></html>`;
}
