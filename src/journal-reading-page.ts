/**
 * Reading pages: /journal/reading (the library) and /journal/reading/:id (one book).
 * Server-rendered; the only scripts run the one-time wiki import and the Readwise sync.
 */
import { Env } from './types';
import { esc, inline, notesToHtml } from './journal-book';
import { todayLocal } from './journal';
import { getBook, highlightOfTheDay, listBooks } from './journal-reading';

const fmtDate = (d?: string | null) => (d ? new Date(d.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');

/** A typographic cover with a stable colour from the title, for books without a cover image. */
function cover(b: { title: string; author?: string | null; cover_url?: string | null }, big = false): string {
  let h = 0;
  for (const c of b.title) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hues = [18, 38, 152, 200, 222, 262, 340, 8];
  const hue = hues[h % hues.length];
  const img = b.cover_url && /^https:\/\//.test(b.cover_url) ? `<img src="${esc(b.cover_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : '';
  return `<div class="cover${big ? ' big' : ''}" style="--h:${hue}">${img}<span class="ct">${esc(b.title)}</span>${b.author ? `<span class="ca">${esc(b.author)}</span>` : ''}</div>`;
}

export async function readingLibraryHTML(env: Env, url: URL): Promise<string> {
  const q = (url.searchParams.get('q') || '').slice(0, 100);
  const sort = url.searchParams.get('sort') || 'recent';
  const data = await listBooks(env, { q, sort });
  const today = await highlightOfTheDay(env, todayLocal()).catch(() => null);
  const t = data.totals as any || { books: 0, highlights: 0 };
  const empty = !t.books;
  const sortLink = (s: string, label: string) => `<a href="?${new URLSearchParams({ ...(q ? { q } : {}), sort: s })}" class="${sort === s ? 'on' : ''}">${label}</a>`;
  const cards = data.books.map((b: any) => `<a class="card" href="/journal/reading/${esc(b.id)}">${cover(b)}
    <div class="meta"><b>${esc(b.title)}</b>${b.author ? `<span>${esc(b.author)}</span>` : ''}
    <span class="nums">${b.num_highlights} ${b.num_highlights === 1 ? 'highlight' : 'highlights'}${b.mentions ? ` · ${b.mentions} journal ${b.mentions === 1 ? 'day' : 'days'}` : ''}${b.notes_slug ? ' · notes' : ''}</span></div></a>`).join('');
  return page('Reading', `
<header class="top"><a href="/journal" class="back">← Journal</a><h1>Reading</h1>
  <p class="sub">${t.books} books · ${Number(t.highlights).toLocaleString('en-US')} highlights${data.last_sync ? ` · Readwise synced ${esc(fmtDate(data.last_sync))}` : ''}</p>
  <div class="actions">
    ${data.readwise ? `<button onclick="sync(this)">Sync Readwise now</button>` : `<span class="hint">Readwise sync is off. Add the READWISE_TOKEN secret to turn it on.</span>`}
    <button onclick="importWiki(this)">${empty ? 'Import highlights from the wiki' : 'Re-import wiki highlights'}</button>
  </div>
  <p id="status" class="hint"></p>
</header>
${today ? `<section class="hotd"><div class="kicker">Highlight of the day</div><blockquote>${esc(today.text)}</blockquote>
  <a href="/journal/reading/${esc(today.book_id)}">${esc(today.title)}${today.author ? ` · ${esc(today.author)}` : ''}</a></section>` : ''}
${empty ? `<section class="emptyst"><p>No books yet. Press <b>Import highlights from the wiki</b> to load the Readwise pages already in your wiki. It runs in a few steps.</p></section>` : `
<form class="tools" method="get"><input name="q" value="${esc(q)}" placeholder="Search titles, authors and highlights" aria-label="Search"><input type="hidden" name="sort" value="${esc(sort)}">
  <nav>${sortLink('recent', 'Recent')} ${sortLink('count', 'Most highlighted')} ${sortLink('title', 'A–Z')}</nav></form>
<section class="grid">${cards || `<p class="hint">No books match “${esc(q)}”.</p>`}</section>`}
<script>
async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(function () { return {}; });
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
async function importWiki(btn) {
  const s = document.getElementById('status'); btn.disabled = true;
  let offset = 0, books = 0, hl = 0;
  try {
    for (;;) {
      const r = await post('/api/journal/reading/import-wiki', { offset: offset });
      books += r.books; hl += r.highlights;
      s.textContent = 'Imported ' + books + ' books, ' + hl + ' highlights (' + Math.min(r.total, offset + r.read) + ' of ' + r.total + ' pages)…';
      if (r.next_offset == null) break;
      offset = r.next_offset;
    }
    location.reload();
  } catch (e) { s.textContent = 'Stopped: ' + e.message; btn.disabled = false; }
}
async function sync(btn) {
  const s = document.getElementById('status'); btn.disabled = true; s.textContent = 'Syncing with Readwise…';
  try { const r = await post('/api/journal/reading/sync', {}); s.textContent = 'Synced ' + (r.highlights || 0) + ' highlights from ' + (r.books || 0) + ' books.'; setTimeout(function () { location.reload(); }, 900); }
  catch (e) { s.textContent = 'Sync failed: ' + e.message; btn.disabled = false; }
}
</script>`);
}

export async function readingBookHTML(env: Env, id: string): Promise<string | null> {
  const data = await getBook(env, id);
  if (!data) return null;
  const { book, highlights, days, notes } = data;
  const tags = [...new Set(highlights.flatMap((h: any) => h.tags).filter((t: string) => !/^(blue|yellow|orange|pink|purple|green|red|favorite)$/.test(t)))];
  return page(book.title, `
<header class="top"><a href="/journal/reading" class="back">← Reading</a></header>
<section class="bookhead">${cover(book, true)}
  <div><h1>${esc(book.title)}</h1>${book.author ? `<p class="by">${esc(book.author)}</p>` : ''}
  <p class="sub">${highlights.length} ${highlights.length === 1 ? 'highlight' : 'highlights'}${book.first_highlight_at ? ` · first ${esc(fmtDate(book.first_highlight_at))}` : ''}${book.last_highlight_at && book.last_highlight_at !== book.first_highlight_at ? ` · last ${esc(fmtDate(book.last_highlight_at))}` : ''}${days.length ? ` · in ${days.length} journal ${days.length === 1 ? 'day' : 'days'}` : ''}</p>
  ${tags.length ? `<p class="tags">${tags.slice(0, 12).map(t => `<span>${esc(t)}</span>`).join('')}</p>` : ''}
  ${book.source_url && /^https:\/\//.test(book.source_url) ? `<p class="links"><a href="${esc(book.source_url)}" rel="noopener noreferrer" target="_blank">Source</a></p>` : ''}</div>
</section>
${notes ? `<section class="block"><h2>Your notes</h2><div class="notes">${notesToHtml(notes)}</div></section>` : ''}
${days.length ? `<section class="block"><h2>In your journal</h2><ul class="days">${days.map((d: any) => `<li><a href="/journal?entry=${esc(d.id)}">${esc(fmtDate(d.date))}</a><span>${esc(d.excerpt)}</span></li>`).join('')}</ul></section>` : ''}
<section class="block"><h2>Highlights</h2>
  ${highlights.length > 8 ? `<input class="filter" placeholder="Filter highlights" oninput="filterH(this.value)" aria-label="Filter highlights">` : ''}
  <ol class="hl">${highlights.map((h: any) => `<li${h.favorite ? ' class="fav"' : ''}><p>${inline(h.text)}</p>${h.note ? `<p class="note">${inline(h.note)}</p>` : ''}<span class="loc">${h.location != null ? `${h.location_type === 'page' ? 'Page' : 'Location'} ${h.location}` : ''}</span></li>`).join('')}</ol>
</section>
<script>
function filterH(v) { v = v.toLowerCase(); document.querySelectorAll('.hl li').forEach(function (li) { li.style.display = li.textContent.toLowerCase().indexOf(v) >= 0 ? '' : 'none'; }); }
</script>`);
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Instrument+Sans:wght@400;500;600&family=Newsreader:ital,opsz,wght@0,6..72,400;1,6..72,400&display=swap" rel="stylesheet">
<style>
:root { --ink: #1C1B19; --dim: #5F5C55; --faint: #8F8C84; --rule: #E2DFD8; --accent: #9C7A2B; --bg: #F7F5F0; --card: #FFFFFF; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); color: var(--ink); font: 15px/1.5 'Instrument Sans', sans-serif; padding: 0 16px 80px; }
main { max-width: 1080px; margin: 0 auto; }
a { color: inherit; }
.top { padding: 28px 0 10px; }
.back { font-size: 13px; color: var(--dim); text-decoration: none; }
h1 { font: 400 44px/1.05 'Instrument Serif', serif; margin: 8px 0 4px; }
h2 { font: 600 11px 'Instrument Sans', sans-serif; letter-spacing: .16em; text-transform: uppercase; color: var(--dim); margin: 0 0 12px; }
.sub { color: var(--dim); font-size: 14px; }
.hint { color: var(--faint); font-size: 13px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; }
button { font: 500 13px 'Instrument Sans', sans-serif; border: 1px solid #ccc; background: #fff; border-radius: 6px; padding: 6px 12px; cursor: pointer; color: var(--ink); }
button:disabled { opacity: .5; cursor: progress; }
.kicker { font: 600 11px 'Instrument Sans', sans-serif; letter-spacing: .2em; text-transform: uppercase; color: var(--accent); }
.hotd { background: var(--card); border: 1px solid var(--rule); border-radius: 12px; padding: 22px 24px; margin: 18px 0; }
.hotd blockquote { font: italic 21px/1.45 'Newsreader', serif; margin: 10px 0; }
.hotd a { font-size: 13px; color: var(--dim); }
.emptyst { background: var(--card); border: 1px dashed var(--rule); border-radius: 12px; padding: 24px; color: var(--dim); }
.tools { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; margin: 18px 0 14px; }
.tools input { flex: 1 1 260px; font: 15px 'Instrument Sans', sans-serif; padding: 9px 12px; border: 1px solid var(--rule); border-radius: 8px; background: #fff; }
.tools nav a { font-size: 13px; color: var(--dim); text-decoration: none; margin-right: 10px; } .tools nav a.on { color: var(--ink); font-weight: 600; border-bottom: 2px solid var(--accent); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 22px 18px; }
.card { text-decoration: none; display: block; }
.card .meta { padding-top: 8px; font-size: 13px; line-height: 1.35; } .card .meta b { display: block; font-weight: 600; }
.card .meta span { display: block; color: var(--dim); } .card .meta .nums { color: var(--faint); font-size: 12px; margin-top: 2px; }
.cover { position: relative; aspect-ratio: 2 / 3; border-radius: 4px 8px 8px 4px; overflow: hidden; padding: 14px 12px; display: flex; flex-direction: column; justify-content: space-between;
  background: linear-gradient(160deg, hsl(var(--h) 38% 30%), hsl(var(--h) 42% 20%)); color: #fff; box-shadow: inset 4px 0 0 rgba(0,0,0,.18), 0 2px 8px rgba(0,0,0,.14); }
.cover img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.cover .ct { font: 400 17px/1.15 'Instrument Serif', serif; position: relative; display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical; overflow: hidden; }
.cover .ca { font-size: 10px; letter-spacing: .1em; text-transform: uppercase; opacity: .8; position: relative; }
.cover img ~ .ct, .cover img ~ .ca { visibility: hidden; }
.cover.big { width: 170px; flex: none; } .cover.big .ct { font-size: 22px; }
.card:hover .cover { transform: translateY(-2px); transition: transform .15s; }
.bookhead { display: flex; gap: 26px; align-items: flex-start; margin: 10px 0 26px; }
.bookhead h1 { margin-top: 0; } .by { font: italic 18px 'Newsreader', serif; color: var(--dim); margin-bottom: 6px; }
.tags span { display: inline-block; font-size: 12px; border: 1px solid var(--rule); border-radius: 10px; padding: 1px 8px; margin: 6px 4px 0 0; color: var(--dim); }
.links a { font-size: 13px; color: var(--accent); margin-right: 14px; } .links { margin-top: 10px; }
.block { background: var(--card); border: 1px solid var(--rule); border-radius: 12px; padding: 22px 24px; margin-bottom: 16px; }
.notes { font: 15px/1.55 'Newsreader', serif; } .notes ul { padding-left: 20px; } .notes h5 { font: 600 11px 'Instrument Sans', sans-serif; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); margin: 10px 0 4px; }
ul.days { list-style: none; } ul.days li { display: grid; grid-template-columns: 110px 1fr; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--rule); font-size: 14px; }
ul.days a { color: var(--accent); text-decoration: none; font-weight: 500; } ul.days span { color: var(--dim); }
.filter { width: 100%; font: 14px 'Instrument Sans', sans-serif; padding: 8px 12px; border: 1px solid var(--rule); border-radius: 8px; margin-bottom: 8px; }
ol.hl { list-style: none; } ol.hl li { padding: 14px 0 12px 16px; border-bottom: 1px solid var(--rule); border-left: 2px solid transparent; }
ol.hl li.fav { border-left-color: var(--accent); }
ol.hl p { font: 17px/1.5 'Newsreader', serif; } ol.hl .note { font: 14px 'Instrument Sans', sans-serif; color: var(--accent); margin-top: 6px; }
ol.hl .loc { font-size: 11px; color: var(--faint); letter-spacing: .06em; text-transform: uppercase; }
@media (max-width: 640px) { h1 { font-size: 34px; } .bookhead { flex-direction: column; } .cover.big { width: 130px; } ul.days li { grid-template-columns: 1fr; gap: 2px; } .block { padding: 18px 16px; } }
</style></head><body><main>${body}</main></body></html>`;
}
