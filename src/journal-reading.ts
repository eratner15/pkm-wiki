/**
 * Reading library: one record per book with its highlights, your notes page and the
 * journal days that mention it. Highlights come from two places:
 *  - the Readwise pages already in the wiki (imported from Roam), read from R2 once;
 *  - the Readwise export API (READWISE_TOKEN), synced incrementally by the hourly cron.
 * A highlight's id is a hash of its book and normalized text, so the same highlight
 * from both sources is stored once.
 */
import { Env } from './types';
import { ensureJournalSchema, getState, setState } from './journal';
import { librarySlug } from './journal-library';

export const READING_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS reading_books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT,
    category TEXT,
    source TEXT,
    readwise_id INTEGER,
    asin TEXT,
    cover_url TEXT,
    source_url TEXT,
    highlights_slug TEXT,
    notes_slug TEXT,
    num_highlights INTEGER DEFAULT 0,
    first_highlight_at TEXT,
    last_highlight_at TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS reading_highlights (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    text TEXT NOT NULL,
    note TEXT,
    location INTEGER,
    location_type TEXT,
    highlighted_at TEXT,
    tags TEXT DEFAULT '[]',
    readwise_id INTEGER,
    favorite INTEGER DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_reading_highlights_book ON reading_highlights(book_id, location)`,
  `CREATE TABLE IF NOT EXISTS reading_mentions (
    book_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    PRIMARY KEY (book_id, entry_id)
  )`,
];

let ready = false;
export async function ensureReadingSchema(env: Env): Promise<void> {
  if (ready) return;
  await ensureJournalSchema(env);
  await env.DB.batch(READING_SCHEMA.map(s => env.DB.prepare(s)));
  ready = true;
}

const normText = (s: string) => s.toLowerCase().replace(/[‘’`]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

async function highlightId(bookId: string, text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(bookId + '\n' + normText(text)));
  return [...new Uint8Array(buf)].slice(0, 10).map(b => b.toString(16).padStart(2, '0')).join('');
}

export const bookIdFor = (title: string) => librarySlug(String(title || '').replace(/\s*\(highlights\)\s*$/i, '')) || 'untitled';

export interface ParsedBook {
  title: string; author: string | null; category: string;
  highlights: { text: string; note: string | null; location: number | null; tags: string[] }[];
  firstSynced: string | null;
}

const ROAM_DATE = /\[\[(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2})(?:st|nd|rd|th), (\d{4})\]\]/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Parse a Roam page written by the Readwise export ("Title (highlights)"). */
export function parseReadwisePage(title: string, md: string): ParsedBook {
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  const author = (md.match(/^\s*-\s*Author::\s*(.*)$/m)?.[1] || '').replace(/\[\[|\]\]/g, '').trim() || null;
  const cat = (md.match(/^\s*-\s*(?:Category|Tags)::\s*(.*)$/m)?.[1] || '');
  const category = /#?\[?\[?Articles/i.test(cat) ? 'articles' : /Tweets/i.test(cat) ? 'tweets' : /Podcasts/i.test(cat) ? 'podcasts' : 'books';
  const synced = md.match(ROAM_DATE);
  const firstSynced = synced ? `${synced[3]}-${String(MONTHS.indexOf(synced[1]) + 1).padStart(2, '0')}-${synced[2].padStart(2, '0')}` : null;
  const highlights: ParsedBook['highlights'] = [];
  let inHighlights = false, base = -1;
  for (const raw of lines) {
    // Each Readwise sync adds a heading ("Highlights first synced…", "New highlights added…").
    if (/^\s*-\s*#{1,6}\s/.test(raw)) { inHighlights = /highlights/i.test(raw); base = -1; continue; }
    if (!inHighlights) continue;
    const m = raw.match(/^(\s*)-\s+(.*)$/);
    if (!m) continue;
    const ind = m[1].replace(/\t/g, '    ').length;
    if (base < 0) base = ind;
    if (ind < base) { inHighlights = false; continue; }
    const body = m[2];
    if (ind <= base) {
      // Readwise writes a non-breaking space in "Location 123", so match any space.
      const loc = body.match(/\(\[(?:Location|Page)\s(\d+)\]\([^)]*\)\)\s*$/);
      const text = body.replace(/\s*\(\[(?:Location|Page)\s[^\]]*\]\([^)]*\)\)\s*$/, '').replace(/\s*\(\[View\sHighlight\]\([^)]*\)\)\s*$/, '').trim();
      if (text) highlights.push({ text, note: null, location: loc ? Number(loc[1]) : null, tags: [] });
    } else if (highlights.length) {
      const h = highlights[highlights.length - 1];
      const tagLine = body.match(/^\*\*Tags\*\*:\s*(.*)$/);
      const noteLine = body.match(/^\*\*Note\*\*:\s*(.*)$/);
      if (tagLine) h.tags = [...tagLine[1].matchAll(/#\[\[([^\]]+)\]\]|#([\w-]+)/g)].map(t => (t[1] || t[2]).toLowerCase());
      else if (noteLine) h.note = noteLine[1].trim() || null;
    }
  }
  return { title: title.replace(/\s*\(highlights\)\s*$/i, '').trim(), author, category, highlights, firstSynced };
}

async function upsertBook(env: Env, b: { id: string; title: string; author?: string | null; category?: string | null; source: string; readwise_id?: number | null; asin?: string | null; cover_url?: string | null; source_url?: string | null; highlights_slug?: string | null }) {
  return env.DB.prepare(
    `INSERT INTO reading_books (id, title, author, category, source, readwise_id, asin, cover_url, source_url, highlights_slug)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       author = COALESCE(excluded.author, reading_books.author),
       category = COALESCE(excluded.category, reading_books.category),
       source = CASE WHEN reading_books.source = excluded.source THEN excluded.source ELSE 'readwise' END,
       readwise_id = COALESCE(excluded.readwise_id, reading_books.readwise_id),
       asin = COALESCE(excluded.asin, reading_books.asin),
       cover_url = COALESCE(excluded.cover_url, reading_books.cover_url),
       source_url = COALESCE(excluded.source_url, reading_books.source_url),
       highlights_slug = COALESCE(excluded.highlights_slug, reading_books.highlights_slug),
       updated_at = datetime('now')`
  ).bind(b.id, b.title, b.author ?? null, b.category ?? null, b.source, b.readwise_id ?? null, b.asin ?? null, b.cover_url ?? null, b.source_url ?? null, b.highlights_slug ?? null);
}

function highlightStmt(env: Env, id: string, bookId: string, h: { text: string; note: string | null; location: number | null; location_type?: string | null; highlighted_at?: string | null; tags: string[]; readwise_id?: number | null; favorite?: boolean }) {
  return env.DB.prepare(
    `INSERT INTO reading_highlights (id, book_id, text, note, location, location_type, highlighted_at, tags, readwise_id, favorite)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       note = COALESCE(excluded.note, reading_highlights.note),
       location = COALESCE(excluded.location, reading_highlights.location),
       location_type = COALESCE(excluded.location_type, reading_highlights.location_type),
       highlighted_at = COALESCE(excluded.highlighted_at, reading_highlights.highlighted_at),
       tags = CASE WHEN excluded.tags != '[]' THEN excluded.tags ELSE reading_highlights.tags END,
       readwise_id = COALESCE(excluded.readwise_id, reading_highlights.readwise_id),
       favorite = MAX(excluded.favorite, reading_highlights.favorite)`
  ).bind(id, bookId, h.text, h.note, h.location, h.location_type ?? null, h.highlighted_at ?? null, JSON.stringify(h.tags || []), h.readwise_id ?? null, h.favorite ? 1 : 0);
}

async function runBatches(env: Env, stmts: D1PreparedStatement[]) {
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
}

/** Import the Readwise pages already in the wiki, in pages of `limit` (each page is one R2 read). */
export async function importReadingFromWiki(env: Env, opts: { offset?: number; limit?: number } = {}) {
  await ensureReadingSchema(env);
  const limit = Math.min(opts.limit || 40, 80), offset = opts.offset || 0;
  const where = `tags LIKE '%book-highlights%' OR title LIKE '%(highlights)'`;
  const total = ((await env.DB.prepare(`SELECT COUNT(*) AS n FROM pages WHERE ${where}`).first()) as any)?.n || 0;
  const rows = ((await env.DB.prepare(`SELECT slug, title FROM pages WHERE ${where} ORDER BY slug LIMIT ? OFFSET ?`).bind(limit, offset).all()).results || []) as any[];
  let books = 0, highlights = 0;
  for (const r of rows) {
    const obj = await env.STORAGE.get(`wiki/${r.slug}.md`);
    if (!obj) continue;
    const p = parseReadwisePage(r.title, (await obj.text()).split('\n---\n*Imported from Roam*')[0]);
    if (!p.highlights.length) continue;
    const id = bookIdFor(p.title);
    const stmts = [await upsertBook(env, { id, title: p.title, author: p.author, category: p.category, source: 'wiki', highlights_slug: r.slug })];
    for (const h of p.highlights) stmts.push(highlightStmt(env, await highlightId(id, h.text), id, { ...h, highlighted_at: p.firstSynced }));
    await runBatches(env, stmts);
    books++; highlights += p.highlights.length;
  }
  const next = offset + rows.length;
  const done = next >= total;
  if (done) await refreshReading(env);
  return { books, highlights, read: rows.length, total, next_offset: done ? null : next };
}

/** Pull new and changed highlights from Readwise since the last sync. */
export async function syncReadwise(env: Env, opts: { full?: boolean; maxPages?: number } = {}) {
  const token = (env as any).READWISE_TOKEN as string | undefined;
  if (!token) return { skipped: 'READWISE_TOKEN is not set' };
  await ensureReadingSchema(env);
  const since = opts.full ? null : await getState(env, 'readwise_last_sync');
  const started = new Date().toISOString();
  let cursor: string | null = null, pages = 0, books = 0, highlights = 0, removed = 0;
  do {
    const url = new URL('https://readwise.io/api/v2/export/');
    if (since) url.searchParams.set('updatedAfter', since);
    if (cursor) url.searchParams.set('pageCursor', cursor);
    url.searchParams.set('includeDeleted', 'true');
    const res = await fetch(url, { headers: { Authorization: `Token ${token}` } });
    if (res.status === 429) throw new Error(`Readwise rate limit; retry after ${res.headers.get('Retry-After') || '60'} s`);
    if (!res.ok) throw new Error(`Readwise export failed: HTTP ${res.status}`);
    const data = await res.json() as any;
    const stmts: D1PreparedStatement[] = [];
    for (const b of data.results || []) {
      if (b.is_deleted) continue;
      const id = bookIdFor(b.readable_title || b.title);
      stmts.push(await upsertBook(env, {
        id, title: b.readable_title || b.title, author: b.author, category: b.category, source: 'readwise',
        readwise_id: b.user_book_id, asin: b.asin, cover_url: b.cover_image_url, source_url: b.source_url || b.unique_url,
      }));
      books++;
      for (const h of b.highlights || []) {
        const hid = await highlightId(id, h.text || '');
        if (h.is_deleted || h.is_discard) { stmts.push(env.DB.prepare('DELETE FROM reading_highlights WHERE id = ? OR readwise_id = ?').bind(hid, h.id)); removed++; continue; }
        if (!h.text) continue;
        stmts.push(highlightStmt(env, hid, id, {
          text: h.text, note: h.note || null, location: typeof h.location === 'number' ? h.location : null, location_type: h.location_type,
          highlighted_at: h.highlighted_at || h.created_at, tags: (h.tags || []).map((t: any) => String(t.name).toLowerCase()), readwise_id: h.id, favorite: !!h.is_favorite,
        }));
        highlights++;
      }
    }
    await runBatches(env, stmts);
    cursor = data.nextPageCursor || null;
    pages++;
  } while (cursor && pages < (opts.maxPages || 20));
  if (!cursor) await setState(env, 'readwise_last_sync', started);
  await refreshReading(env);
  return { books, highlights, removed, pages, complete: !cursor };
}

/** Recount highlights, link notes pages, and rebuild journal mentions. */
export async function refreshReading(env: Env) {
  await ensureReadingSchema(env);
  await env.DB.prepare(
    `UPDATE reading_books SET
       num_highlights = (SELECT COUNT(*) FROM reading_highlights h WHERE h.book_id = reading_books.id),
       first_highlight_at = (SELECT MIN(highlighted_at) FROM reading_highlights h WHERE h.book_id = reading_books.id),
       last_highlight_at = (SELECT MAX(highlighted_at) FROM reading_highlights h WHERE h.book_id = reading_books.id)`
  ).run();
  const books = ((await env.DB.prepare('SELECT id, title, highlights_slug FROM reading_books').all()).results || []) as any[];
  // A wiki page whose slug matches the book (and is not the highlights page) holds your own notes.
  const slugs = books.map(b => b.id);
  const notes = new Set<string>();
  for (let i = 0; i < slugs.length; i += 90) {
    const part = slugs.slice(i, i + 90);
    const r = await env.DB.prepare(`SELECT slug FROM pages WHERE slug IN (${part.map(() => '?').join(',')}) AND tags NOT LIKE '%book-highlights%'`).bind(...part).all();
    for (const row of (r.results || []) as any[]) notes.add(row.slug);
  }
  const stmts = books.map(b => env.DB.prepare('UPDATE reading_books SET notes_slug = ? WHERE id = ?').bind(notes.has(b.id) ? b.id : null, b.id));
  // Journal mentions: the title (or its part before ":") as a phrase, at least two words or eight letters.
  const entries = ((await env.DB.prepare(`SELECT id, lower(coalesce(body, '') || ' ' || coalesce(rose, '') || ' ' || coalesce(lesson, '')) AS t FROM journal_entries`).all()).results || []) as any[];
  stmts.push(env.DB.prepare('DELETE FROM reading_mentions'));
  for (const b of books) {
    const key = String(b.title).split(/[:(]/)[0].trim().toLowerCase();
    if (key.length < 8 && !/\s/.test(key)) continue;
    const re = new RegExp(`(^|[^a-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`);
    for (const e of entries) if (re.test(e.t)) stmts.push(env.DB.prepare('INSERT OR IGNORE INTO reading_mentions (book_id, entry_id) VALUES (?, ?)').bind(b.id, e.id));
  }
  await runBatches(env, stmts);
}

export async function listBooks(env: Env, opts: { q?: string; sort?: string } = {}) {
  await ensureReadingSchema(env);
  const order = opts.sort === 'title' ? 'b.title COLLATE NOCASE' : opts.sort === 'count' ? 'b.num_highlights DESC' : 'COALESCE(b.last_highlight_at, b.updated_at) DESC';
  const q = (opts.q || '').trim();
  const where = q ? `WHERE b.title LIKE ?1 OR b.author LIKE ?1 OR b.id IN (SELECT book_id FROM reading_highlights WHERE text LIKE ?1 OR note LIKE ?1)` : '';
  const stmt = env.DB.prepare(
    `SELECT b.id, b.title, b.author, b.category, b.cover_url, b.num_highlights, b.first_highlight_at, b.last_highlight_at, b.notes_slug,
       (SELECT COUNT(*) FROM reading_mentions m WHERE m.book_id = b.id) AS mentions
     FROM reading_books b ${where} ORDER BY ${order} LIMIT 500`
  );
  const books = ((await (q ? stmt.bind(`%${q}%`) : stmt).all()).results || []) as any[];
  const totals = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM reading_books) AS books, (SELECT COUNT(*) FROM reading_highlights) AS highlights`).first();
  return { books, totals, last_sync: await getState(env, 'readwise_last_sync'), readwise: !!(env as any).READWISE_TOKEN };
}

export async function getBook(env: Env, id: string) {
  await ensureReadingSchema(env);
  const book = await env.DB.prepare('SELECT * FROM reading_books WHERE id = ?').bind(id).first() as any;
  if (!book) return null;
  const highlights = ((await env.DB.prepare(
    'SELECT id, text, note, location, location_type, highlighted_at, tags, favorite FROM reading_highlights WHERE book_id = ? ORDER BY location IS NULL, location, highlighted_at'
  ).bind(id).all()).results || []) as any[];
  for (const h of highlights) { try { h.tags = JSON.parse(h.tags || '[]'); } catch { h.tags = []; } }
  const mentions = ((await env.DB.prepare(
    `SELECT e.id, e.entry_date, e.body, e.rose, e.lesson FROM reading_mentions m JOIN journal_entries e ON e.id = m.entry_id WHERE m.book_id = ? ORDER BY e.entry_date`
  ).bind(id).all()).results || []) as any[];
  const key = String(book.title).split(/[:(]/)[0].trim().toLowerCase();
  const days = mentions.map(e => {
    const t = [e.body, e.rose, e.lesson].filter(Boolean).join('\n')
      .replace(/\{\{[^}]*\}\}|\(\([\w-]+\)\)/g, '').replace(/#?\[\[([^\]]+)\]\]/g, '$1').replace(/\*\*|__/g, '')
      .split('\n').map(l => l.replace(/^\s*[-*+]\s*/, '').trim()).filter(Boolean).join(' · ');
    const at = Math.max(0, t.toLowerCase().indexOf(key));
    // Start and end the excerpt on word boundaries.
    let from = Math.max(0, at - 90); if (from) from = t.indexOf(' ', from) + 1 || from;
    let to = Math.min(t.length, at + key.length + 160); if (to < t.length) to = t.lastIndexOf(' ', to) > at ? t.lastIndexOf(' ', to) : to;
    return { id: e.id, date: e.entry_date, excerpt: (from ? '…' : '') + t.slice(from, to).trim() + (to < t.length ? '…' : '') };
  });
  let notes: string | null = null;
  if (book.notes_slug) {
    const obj = await env.STORAGE.get(`wiki/${book.notes_slug}.md`);
    if (obj) notes = (await obj.text()).split('\n---\n*Imported from Roam*')[0].replace(/^#\s+.*\n+/, '');
  }
  return { book, highlights, days, notes };
}

/** One highlight per day, the same all day, cycling through the library. */
export async function highlightOfTheDay(env: Env, date: string) {
  await ensureReadingSchema(env);
  const n = ((await env.DB.prepare(`SELECT COUNT(*) AS n FROM reading_highlights WHERE length(text) BETWEEN 40 AND 400`).first()) as any)?.n || 0;
  if (!n) return null;
  const day = Math.floor(Date.parse(date + 'T00:00:00Z') / 86400000);
  const offset = (day * 7919) % n; // a large prime step so neighbouring days come from different books
  return await env.DB.prepare(
    `SELECT h.text, h.note, b.id AS book_id, b.title, b.author FROM reading_highlights h JOIN reading_books b ON b.id = h.book_id
     WHERE length(h.text) BETWEEN 40 AND 400 ORDER BY h.id LIMIT 1 OFFSET ?`
  ).bind(offset).first() as any;
}
