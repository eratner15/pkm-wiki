/**
 * Living Journal — daily journal entries stored in D1.
 *
 * Sources:
 *   - Notion sync (one integration token, no per-page prompts)
 *   - Bulk import (Notion "Markdown & CSV" export via scripts/import-notion-export.mjs)
 *   - Native capture in the PKM (Claude extracts Rose / Thorn / Bud / etc.)
 *
 * AI cost control: Claude runs only on explicit capture, on demand, or on the
 * weekly cron. Insights are cached in D1 and reused until new entries arrive.
 */

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { Env } from './types';
import { ANTHROPIC_GATEWAY_BASE } from './ai-gateway';

const NOTION_VERSION = '2022-06-28';
const DEFAULT_MODEL = 'claude-opus-5-5';

// $ per million tokens (input, output) for the cost readout on the dashboard
const PRICES: Record<string, [number, number]> = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};

export const THEMES = [
  'Family', 'Kids', 'Marriage', 'Friends', 'Work', 'Investing', 'Deals', 'Health', 'Fitness', 'Golf',
  'Learning', 'Writing', 'Travel', 'Food', 'Home', 'Money', 'Faith', 'Holidays', 'Mindset', 'Social', 'Planning',
] as const;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const JOURNAL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS journal_entries (
    id TEXT PRIMARY KEY,
    entry_date TEXT NOT NULL,
    title TEXT,
    entry_type TEXT,
    source TEXT,
    summary TEXT,
    rose TEXT,
    rose_theme TEXT,
    thorn TEXT,
    thorn_theme TEXT,
    thorn_cause TEXT,
    bud TEXT,
    key_wins TEXT,
    lesson TEXT,
    next_action TEXT,
    notable TEXT,
    tickers TEXT,
    day_score REAL,
    mood REAL,
    mood_confidence TEXT,
    energy TEXT,
    tags TEXT,
    people TEXT,
    places TEXT,
    body TEXT,
    notion_id TEXT,
    notion_edited_at TEXT,
    body_synced_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_journal_date ON journal_entries(entry_date)`,
  `CREATE TABLE IF NOT EXISTS journal_names (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    category TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS journal_insights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period TEXT NOT NULL,
    period_key TEXT NOT NULL,
    content TEXT NOT NULL,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd REAL,
    entries_through TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_journal_insights_period ON journal_insights(period, period_key)`,
  `CREATE TABLE IF NOT EXISTS journal_state (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS journal_fts USING fts5(
    title, summary, rose, thorn, bud, lesson, body, content='journal_entries', content_rowid='rowid'
  )`,
  `CREATE TRIGGER IF NOT EXISTS journal_ai AFTER INSERT ON journal_entries BEGIN
    INSERT INTO journal_fts(rowid, title, summary, rose, thorn, bud, lesson, body)
    VALUES (new.rowid, new.title, new.summary, new.rose, new.thorn, new.bud, new.lesson, new.body);
  END`,
  `CREATE TRIGGER IF NOT EXISTS journal_ad AFTER DELETE ON journal_entries BEGIN
    INSERT INTO journal_fts(journal_fts, rowid, title, summary, rose, thorn, bud, lesson, body)
    VALUES ('delete', old.rowid, old.title, old.summary, old.rose, old.thorn, old.bud, old.lesson, old.body);
  END`,
  `CREATE TRIGGER IF NOT EXISTS journal_au AFTER UPDATE ON journal_entries BEGIN
    INSERT INTO journal_fts(journal_fts, rowid, title, summary, rose, thorn, bud, lesson, body)
    VALUES ('delete', old.rowid, old.title, old.summary, old.rose, old.thorn, old.bud, old.lesson, old.body);
    INSERT INTO journal_fts(rowid, title, summary, rose, thorn, bud, lesson, body)
    VALUES (new.rowid, new.title, new.summary, new.rose, new.thorn, new.bud, new.lesson, new.body);
  END`,
];

let schemaReady = false;

export async function ensureJournalSchema(env: Env): Promise<void> {
  if (schemaReady) return;
  await env.DB.batch(JOURNAL_SCHEMA.map(sql => env.DB.prepare(sql)));
  schemaReady = true;
}

async function getState(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM journal_state WHERE key = ?').bind(key).first();
  return (row?.value as string) ?? null;
}

async function setState(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO journal_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(key, value).run();
}

// ---------------------------------------------------------------------------
// Entry model + upsert
// ---------------------------------------------------------------------------

export interface JournalEntry {
  id: string;
  entry_date: string;
  title?: string | null;
  entry_type?: string | null;
  source?: string | null;
  summary?: string | null;
  rose?: string | null;
  rose_theme?: string | null;
  thorn?: string | null;
  thorn_theme?: string | null;
  thorn_cause?: string | null;
  bud?: string | null;
  key_wins?: string | null;
  lesson?: string | null;
  next_action?: string | null;
  notable?: string | null;
  tickers?: string | null;
  day_score?: number | null;
  mood?: number | null;
  mood_confidence?: string | null;
  energy?: string | null;
  tags?: string[];
  people?: string[];
  places?: string[];
  body?: string | null;
  notion_id?: string | null;
  notion_edited_at?: string | null;
}

const FIELD_COLUMNS = [
  'entry_date', 'title', 'entry_type', 'source', 'summary', 'rose', 'rose_theme', 'thorn', 'thorn_theme',
  'thorn_cause', 'bud', 'key_wins', 'lesson', 'next_action', 'notable', 'tickers', 'day_score', 'mood',
  'mood_confidence', 'energy', 'tags', 'people', 'places', 'notion_id', 'notion_edited_at',
] as const;

function blank(v: unknown): unknown {
  if (v === undefined || v === '') return null;
  return v;
}

/** Upsert entry metadata. The body is written only when `withBody` is set, so a
 *  property-only Notion sync never erases a body that was already fetched. */
function upsertStatement(env: Env, e: JournalEntry, withBody: boolean): D1PreparedStatement {
  const cols = [...FIELD_COLUMNS, ...(withBody ? ['body'] : [])];
  const values = cols.map(c => {
    if (c === 'tags' || c === 'people' || c === 'places') return JSON.stringify((e as any)[c] || []);
    return blank((e as any)[c]);
  });
  const sql =
    `INSERT INTO journal_entries (id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
     ON CONFLICT(id) DO UPDATE SET ${cols.map(c => `${c} = excluded.${c}`).join(', ')}, updated_at = datetime('now')`;
  return env.DB.prepare(sql).bind(e.id, ...values);
}

function parseRow(row: any): any {
  if (!row) return row;
  for (const k of ['tags', 'people', 'places']) {
    try { row[k] = JSON.parse(row[k] || '[]'); } catch { row[k] = []; }
  }
  return row;
}

// ---------------------------------------------------------------------------
// Notion sync
// ---------------------------------------------------------------------------

class SubrequestBudget {
  used = 0;
  constructor(public limit: number) {}
  take(): boolean { if (this.used >= this.limit) return false; this.used++; return true; }
}

async function notion(env: Env, budget: SubrequestBudget, path: string, body?: unknown): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!budget.take()) throw new BudgetExhausted();
    const res = await fetch(`${env.NOTION_API_BASE || 'https://api.notion.com/v1'}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) {
      const wait = Number(res.headers.get('Retry-After') || 1) * 1000;
      await new Promise(r => setTimeout(r, Math.min(wait, 5000)));
      continue;
    }
    const text = await res.text().catch(() => '');
    throw new Error(`Notion ${res.status} on ${path}: ${text.slice(0, 200)}`);
  }
  throw new Error(`Notion kept failing on ${path}`);
}

class BudgetExhausted extends Error {
  constructor() { super('Notion request budget used for this run'); }
}

function plain(rich: any[] | undefined): string {
  return (rich || []).map((t: any) => t.plain_text || '').join('');
}

function propText(p: any): string | null {
  if (!p) return null;
  switch (p.type) {
    case 'title': return plain(p.title) || null;
    case 'rich_text': return plain(p.rich_text) || null;
    case 'select': return p.select?.name || null;
    case 'number': return p.number;
    case 'date': return p.date?.start || null;
    default: return null;
  }
}

function hex(id: string): string {
  return id.replace(/-/g, '');
}

function notionPageToEntry(page: any, names: Map<string, string>): JournalEntry | null {
  const p = page.properties || {};
  const date = propText(p['Date']);
  if (!date) return null;
  const rel = (name: string) =>
    (p[name]?.relation || []).map((r: any) => names.get(hex(r.id))).filter(Boolean) as string[];
  return {
    id: hex(page.id),
    entry_date: String(date).slice(0, 10),
    title: propText(p['Day']),
    entry_type: propText(p['Entry Type']),
    source: propText(p['Source']) || 'Notion',
    summary: propText(p['Summary']),
    rose: propText(p['Rose']),
    rose_theme: propText(p['Rose Theme']),
    thorn: propText(p['Thorn']),
    thorn_theme: propText(p['Thorn Theme']),
    thorn_cause: propText(p['Thorn Cause']),
    bud: propText(p['Bud']),
    key_wins: propText(p['Key Wins']),
    lesson: propText(p['Lesson']),
    next_action: propText(p['Next Action']),
    notable: propText(p['Notable']),
    tickers: propText(p['Tickers']),
    day_score: p['Day Score']?.number ?? null,
    mood: p['Mood (inferred)']?.number ?? null,
    mood_confidence: propText(p['Mood Confidence']),
    energy: propText(p['Energy']),
    tags: (p['Tags']?.multi_select || []).map((t: any) => t.name),
    people: rel('People'),
    places: rel('Places'),
    notion_id: hex(page.id),
    notion_edited_at: page.last_edited_time,
  };
}

async function queryAll(env: Env, budget: SubrequestBudget, dbId: string, filter?: unknown): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const res = await notion(env, budget, `/databases/${dbId}/query`, {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
      ...(filter ? { filter } : {}),
    });
    out.push(...(res.results || []));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

async function blocksToMarkdown(env: Env, budget: SubrequestBudget, blockId: string, depth = 0): Promise<string> {
  const lines: string[] = [];
  let cursor: string | undefined;
  let n = 0;
  do {
    const res = await notion(env, budget,
      `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`);
    for (const b of res.results || []) {
      const data = b[b.type] || {};
      const text = plain(data.rich_text);
      const pad = '  '.repeat(depth);
      switch (b.type) {
        case 'heading_1': lines.push(`# ${text}`); break;
        case 'heading_2': lines.push(`## ${text}`); break;
        case 'heading_3': lines.push(`### ${text}`); break;
        case 'bulleted_list_item': case 'toggle': lines.push(`${pad}- ${text}`); break;
        case 'numbered_list_item': lines.push(`${pad}${++n}. ${text}`); break;
        case 'to_do': lines.push(`${pad}- [${data.checked ? 'x' : ' '}] ${text}`); break;
        case 'quote': case 'callout': lines.push(`${pad}> ${text}`); break;
        case 'code': lines.push('```', text, '```'); break;
        case 'divider': lines.push('---'); break;
        case 'child_page': lines.push(`${pad}- [[${data.title || 'Untitled'}]]`); break;
        case 'paragraph': if (text) lines.push(`${pad}${text}`); break;
        default: if (text) lines.push(`${pad}${text}`);
      }
      if (b.type !== 'numbered_list_item') n = 0;
      if (b.has_children && depth < 4 && b.type !== 'child_page' && b.type !== 'child_database') {
        const child = await blocksToMarkdown(env, budget, b.id, depth + 1);
        if (child) lines.push(child);
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return lines.join('\n');
}

export interface SyncResult {
  entries_upserted: number;
  bodies_fetched: number;
  bodies_remaining: number;
  notion_requests: number;
  stopped_early: boolean;
}

/**
 * Pull changed journal pages from Notion. Properties sync in one pass; bodies
 * are fetched in small batches because each body costs one or more requests
 * (Workers cap subrequests per invocation). Hourly cron runs drain the queue.
 */
export async function syncJournalFromNotion(
  env: Env,
  opts: { full?: boolean; bodyLimit?: number; requestBudget?: number } = {}
): Promise<SyncResult> {
  if (!env.NOTION_TOKEN) throw new Error('NOTION_TOKEN is not set. See docs/JOURNAL.md for the one-time setup.');
  await ensureJournalSchema(env);
  const budget = new SubrequestBudget(opts.requestBudget ?? 400);
  const result: SyncResult = { entries_upserted: 0, bodies_fetched: 0, bodies_remaining: 0, notion_requests: 0, stopped_early: false };

  try {
    // 1. People and Places names, so relations resolve to readable names.
    const names = new Map<string, string>();
    const nameRows: D1PreparedStatement[] = [];
    for (const [kind, dbId, catProp] of [
      ['person', env.NOTION_PEOPLE_DB, 'Circle'],
      ['place', env.NOTION_PLACES_DB, 'Type'],
    ] as const) {
      if (!dbId) continue;
      for (const page of await queryAll(env, budget, dbId)) {
        const name = propText(page.properties?.['Name']);
        if (!name) continue;
        names.set(hex(page.id), name);
        nameRows.push(env.DB.prepare(
          `INSERT INTO journal_names (id, name, kind, category) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, category = excluded.category`
        ).bind(hex(page.id), name, kind, propText(page.properties?.[catProp])));
      }
    }
    if (nameRows.length) await env.DB.batch(nameRows);

    // 2. Changed journal pages (properties only).
    const since = opts.full ? null : await getState(env, 'notion_last_sync');
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const pages = await queryAll(env, budget, env.NOTION_JOURNAL_DB!,
      since ? { timestamp: 'last_edited_time', last_edited_time: { after: since } } : undefined);
    const stmts: D1PreparedStatement[] = [];
    for (const page of pages) {
      const entry = notionPageToEntry(page, names);
      if (entry) stmts.push(upsertStatement(env, entry, false));
    }
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    result.entries_upserted = stmts.length;
    await setState(env, 'notion_last_sync', startedAt);

    // 3. Bodies for new or edited pages, newest first.
    const stale = await env.DB.prepare(
      `SELECT notion_id FROM journal_entries
       WHERE notion_id IS NOT NULL AND (body_synced_at IS NULL OR body_synced_at < notion_edited_at)
       ORDER BY entry_date DESC LIMIT ?`
    ).bind(opts.bodyLimit ?? 20).all();
    for (const row of stale.results || []) {
      const id = row.notion_id as string;
      const body = await blocksToMarkdown(env, budget, id);
      await env.DB.prepare(
        `UPDATE journal_entries SET body = ?, body_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE notion_id = ?`
      ).bind(body, id).run();
      result.bodies_fetched++;
    }
  } catch (e) {
    if (!(e instanceof BudgetExhausted)) throw e;
    result.stopped_early = true;
  }

  const remaining = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM journal_entries
     WHERE notion_id IS NOT NULL AND (body_synced_at IS NULL OR body_synced_at < notion_edited_at)`
  ).first();
  result.bodies_remaining = (remaining?.n as number) || 0;
  result.notion_requests = budget.used;
  await logActivity(env, 'journal_sync', result);
  return result;
}

// ---------------------------------------------------------------------------
// Bulk import (Notion export or any JSON source)
// ---------------------------------------------------------------------------

export async function importEntries(env: Env, entries: any[]): Promise<{ imported: number; skipped: number }> {
  await ensureJournalSchema(env);
  const stmts: D1PreparedStatement[] = [];
  let skipped = 0;
  for (const raw of entries) {
    const date = String(raw.entry_date || raw.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { skipped++; continue; }
    const id = String(raw.id || raw.notion_id || `import-${date}-${await shortHash(raw.title || date)}`).replace(/-/g, '');
    const entry: JournalEntry = {
      ...raw,
      id,
      entry_date: date,
      tags: asList(raw.tags),
      people: asList(raw.people),
      places: asList(raw.places),
      day_score: asNumber(raw.day_score),
      mood: asNumber(raw.mood),
    };
    stmts.push(upsertStatement(env, entry, typeof raw.body === 'string'));
    if (typeof raw.body === 'string' && entry.notion_id) {
      stmts.push(env.DB.prepare(
        `UPDATE journal_entries SET body_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
      ).bind(id));
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  await logActivity(env, 'journal_import', { imported: entries.length - skipped, skipped });
  return { imported: entries.length - skipped, skipped };
}

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === 'string' && v.trim()) {
    try { const j = JSON.parse(v); if (Array.isArray(j)) return j.map(String); } catch {}
    return v.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function asNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function shortHash(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].slice(0, 4).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listEntries(env: Env, opts: { from?: string; to?: string; q?: string; limit?: number }) {
  await ensureJournalSchema(env);
  const limit = Math.min(opts.limit || 60, 500);
  if (opts.q) {
    const terms = opts.q.replace(/["*():^-]/g, ' ').trim().split(/\s+/).filter(Boolean).map(t => `"${t}"*`).join(' ');
    if (!terms) return [];
    const rows = await env.DB.prepare(
      `SELECT e.*, snippet(journal_fts, 6, '[', ']', '…', 12) AS snippet FROM journal_fts
       JOIN journal_entries e ON e.rowid = journal_fts.rowid
       WHERE journal_fts MATCH ? ORDER BY e.entry_date DESC LIMIT ?`
    ).bind(terms, limit).all();
    return (rows.results || []).map(parseRow);
  }
  const rows = await env.DB.prepare(
    `SELECT * FROM journal_entries WHERE entry_date >= ? AND entry_date <= ?
     ORDER BY entry_date DESC, updated_at DESC LIMIT ?`
  ).bind(opts.from || '0000-01-01', opts.to || '9999-12-31', limit).all();
  return (rows.results || []).map(parseRow);
}

export async function getEntry(env: Env, id: string) {
  await ensureJournalSchema(env);
  return parseRow(await env.DB.prepare('SELECT * FROM journal_entries WHERE id = ?').bind(id).first());
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Today's date (YYYY-MM-DD) in the journal's home time zone, so a 10 pm entry is not filed as tomorrow. */
export function todayLocal(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export async function journalStats(env: Env, today = todayLocal()) {
  await ensureJournalSchema(env);
  const q = (sql: string, ...b: unknown[]) => env.DB.prepare(sql).bind(...b);
  const yearAgo = isoDay(new Date(Date.parse(today) - 364 * 86400_000));
  const d90 = isoDay(new Date(Date.parse(today) - 90 * 86400_000));
  const d30 = isoDay(new Date(Date.parse(today) - 30 * 86400_000));
  const d14 = isoDay(new Date(Date.parse(today) - 14 * 86400_000));
  const mmdd = today.slice(5);

  const [totals, monthly, roseAll, thornAll, rose90, thorn90, causes, energy, weekday,
    heat, onThisDay, recent, actions, lessons, people, mood30, dates, usage] = await env.DB.batch([
    q(`SELECT COUNT(*) AS entries, MIN(entry_date) AS first, MAX(entry_date) AS last,
       SUM(CASE WHEN body IS NOT NULL AND body <> '' THEN 1 ELSE 0 END) AS with_body,
       SUM(CASE WHEN mood IS NOT NULL THEN 1 ELSE 0 END) AS with_mood,
       SUM(CASE WHEN day_score IS NOT NULL THEN 1 ELSE 0 END) AS with_score,
       SUM(CASE WHEN rose IS NOT NULL THEN 1 ELSE 0 END) AS with_rose FROM journal_entries`),
    q(`SELECT substr(entry_date, 1, 7) AS month, COUNT(*) AS entries,
       ROUND(AVG(mood), 2) AS mood, ROUND(AVG(day_score), 2) AS score
       FROM journal_entries GROUP BY month ORDER BY month`),
    q(`SELECT rose_theme AS theme, COUNT(*) AS n FROM journal_entries WHERE rose_theme IS NOT NULL GROUP BY 1 ORDER BY n DESC`),
    q(`SELECT thorn_theme AS theme, COUNT(*) AS n FROM journal_entries WHERE thorn_theme IS NOT NULL GROUP BY 1 ORDER BY n DESC`),
    q(`SELECT rose_theme AS theme, COUNT(*) AS n FROM journal_entries WHERE rose_theme IS NOT NULL AND entry_date >= ? GROUP BY 1 ORDER BY n DESC`, d90),
    q(`SELECT thorn_theme AS theme, COUNT(*) AS n FROM journal_entries WHERE thorn_theme IS NOT NULL AND entry_date >= ? GROUP BY 1 ORDER BY n DESC`, d90),
    q(`SELECT lower(trim(thorn_cause)) AS cause, COUNT(*) AS n, MAX(entry_date) AS last
       FROM journal_entries WHERE thorn_cause IS NOT NULL GROUP BY 1 ORDER BY n DESC, last DESC LIMIT 8`),
    q(`SELECT energy, COUNT(*) AS n, ROUND(AVG(mood), 2) AS mood FROM journal_entries WHERE energy IS NOT NULL GROUP BY 1`),
    q(`SELECT CAST(strftime('%w', entry_date) AS INTEGER) AS dow, COUNT(*) AS n, ROUND(AVG(mood), 2) AS mood
       FROM journal_entries WHERE mood IS NOT NULL GROUP BY 1 ORDER BY 1`),
    q(`SELECT entry_date AS date, MAX(mood) AS mood, MAX(day_score) AS score FROM journal_entries
       WHERE entry_date >= ? GROUP BY entry_date`, yearAgo),
    q(`SELECT id, entry_date, title, summary, rose, thorn, notable FROM journal_entries
       WHERE substr(entry_date, 6) = ? AND entry_date < ? ORDER BY entry_date DESC`, mmdd, today),
    q(`SELECT id, entry_date, title, entry_type, summary, rose, thorn, mood, day_score, energy, source
       FROM journal_entries ORDER BY entry_date DESC, updated_at DESC LIMIT 8`),
    q(`SELECT id, entry_date, next_action FROM journal_entries WHERE next_action IS NOT NULL AND entry_date >= ?
       ORDER BY entry_date DESC LIMIT 10`, d14),
    q(`SELECT id, entry_date, lesson FROM journal_entries WHERE lesson IS NOT NULL ORDER BY entry_date DESC LIMIT 8`),
    q(`SELECT value AS name, COUNT(*) AS n, MAX(entry_date) AS last FROM journal_entries, json_each(journal_entries.people)
       GROUP BY value ORDER BY n DESC, last DESC LIMIT 10`),
    q(`SELECT ROUND(AVG(mood), 2) AS mood, ROUND(AVG(day_score), 2) AS score, COUNT(*) AS n
       FROM journal_entries WHERE entry_date >= ?`, d30),
    q(`SELECT DISTINCT entry_date AS d FROM journal_entries WHERE entry_date <= ? ORDER BY d DESC LIMIT 400`, today),
    q(`SELECT details FROM activity_log WHERE action = 'journal_ai' AND created_at >= datetime('now', 'start of month')`),
  ]);

  const rows = (r: D1Result) => (r.results || []) as any[];

  // Streaks from distinct entry dates (descending).
  const days = rows(dates).map(r => r.d as string);
  const dayNum = (s: string) => Math.round(Date.parse(s) / 86400_000);
  let current = 0;
  if (days.length && dayNum(today) - dayNum(days[0]) <= 1) {
    current = 1;
    for (let i = 1; i < days.length && dayNum(days[i - 1]) - dayNum(days[i]) === 1; i++) current++;
  }
  let longest = days.length ? 1 : 0;
  for (let i = 1, run = 1; i < days.length; i++) {
    run = dayNum(days[i - 1]) - dayNum(days[i]) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }

  let aiCost = 0;
  for (const r of rows(usage)) {
    try { aiCost += JSON.parse(r.details).cost_usd || 0; } catch {}
  }

  // People from the people index (journal-people.ts) when it exists; else the Notion relation names.
  let peopleRows = rows(people);
  try {
    const idx = await env.DB.prepare(
      `SELECT p.id, p.name, COUNT(*) AS n, MAX(e.entry_date) AS last FROM journal_mentions m
       JOIN journal_persons p ON p.id = m.person_id JOIN journal_entries e ON e.id = m.entry_id
       GROUP BY p.id ORDER BY n DESC, last DESC LIMIT 10`
    ).all();
    if (idx.results?.length) peopleRows = idx.results as any[];
  } catch { /* people index not created yet */ }

  return {
    today,
    totals: { ...(rows(totals)[0] || {}), current_streak: current, longest_streak: longest },
    last30: rows(mood30)[0] || {},
    monthly: rows(monthly),
    themes: { rose: rows(roseAll), thorn: rows(thornAll), rose_90d: rows(rose90), thorn_90d: rows(thorn90) },
    thorn_causes: rows(causes),
    energy: rows(energy),
    weekday: rows(weekday),
    heatmap: rows(heat),
    on_this_day: rows(onThisDay),
    recent: rows(recent),
    next_actions: rows(actions),
    lessons: rows(lessons),
    people: peopleRows,
    ai_cost_month_usd: Math.round(aiCost * 1000) / 1000,
    model: env.JOURNAL_MODEL || DEFAULT_MODEL,
    notion_connected: !!env.NOTION_TOKEN,
    last_sync: await getState(env, 'notion_last_sync'),
  };
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

function claudeClient(env: Env): Anthropic {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: ANTHROPIC_GATEWAY_BASE });
}

function costOf(model: string, usage: { input_tokens: number; output_tokens: number }): number {
  const [pin, pout] = PRICES[model] || PRICES[DEFAULT_MODEL];
  return (usage.input_tokens * pin + usage.output_tokens * pout) / 1_000_000;
}

async function logActivity(env: Env, action: string, details: unknown): Promise<void> {
  try {
    await env.DB.prepare('INSERT INTO activity_log (action, details) VALUES (?, ?)')
      .bind(action, JSON.stringify(details)).run();
  } catch { /* logging is best-effort */ }
}

async function askClaude<T extends z.ZodType>(
  env: Env, purpose: string, system: string, user: string, schema: T, effort: 'low' | 'medium' | 'high'
): Promise<{ data: z.infer<T>; model: string; usage: { input_tokens: number; output_tokens: number }; cost_usd: number }> {
  const model = env.JOURNAL_MODEL || DEFAULT_MODEL;
  const response = await claudeClient(env).beta.messages.parse({
    model,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    cache_control: { type: 'ephemeral' },
    output_config: { effort, format: betaZodOutputFormat(schema) },
    system,
    messages: [{ role: 'user', content: user }],
  });
  if (response.stop_reason === 'refusal') {
    throw new Error(`Claude declined this request (${response.stop_details?.category ?? 'no category'})`);
  }
  if (!response.parsed_output) throw new Error(`Claude returned no structured output (stop: ${response.stop_reason})`);
  const usage = { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens };
  const cost_usd = costOf(model, usage);
  await logActivity(env, 'journal_ai', { purpose, model: response.model, ...usage, cost_usd });
  return { data: response.parsed_output as z.infer<T>, model: response.model, usage, cost_usd };
}

// --- Capture -----------------------------------------------------------------

const Theme = z.enum(THEMES).nullable();

const CaptureSchema = z.object({
  title: z.string().describe('Day title like "Fri, Oct 16, 2026"'),
  summary: z.string().describe('One-line summary of the day, third person'),
  rose: z.string().nullable().describe('Best moment, in the user words. Null if not stated.'),
  rose_theme: Theme,
  thorn: z.string().nullable().describe('Worst or hardest moment. Null if not stated.'),
  thorn_theme: Theme,
  thorn_cause: z.string().nullable().describe('Short root cause of the thorn, 2-6 words, reusable across days'),
  bud: z.string().nullable().describe('Something to look forward to. Null if not stated.'),
  key_wins: z.string().nullable().describe('Wins separated by " · "'),
  lesson: z.string().nullable(),
  next_action: z.string().nullable().describe('Action for tomorrow'),
  notable: z.string().nullable().describe('Most memorable detail or quote'),
  tickers: z.string().nullable().describe('Stock tickers mentioned, comma separated'),
  mood: z.number().int().min(1).max(10).describe('Mood 1-10 inferred from the text'),
  mood_confidence: z.enum(['High', 'Medium', 'Low']),
  energy: z.enum(['High', 'Medium', 'Low']).nullable(),
  tags: z.array(z.enum(THEMES)),
  people: z.array(z.string()).describe('People mentioned by name'),
  places: z.array(z.string()).describe('Named places'),
  entry_type: z.enum(['Daily', 'Weekly Preview', 'Work Notes', 'Other']),
  missing: z.array(z.enum(['rose', 'thorn', 'bud', 'key_wins', 'lesson', 'next_action'])).describe(
    'Fields the user did not give. Ask for these once; never invent them.'),
});

const CAPTURE_SYSTEM = `You file entries for a personal Living Journal.
Rules:
- Keep the user's own words for Rose, Thorn, Bud, Key Wins, Lesson. Fix only spelling.
- Never invent a Rose, Thorn, Bud, win, lesson or next action. If the user did not say it, return null and list it in "missing".
- Mood is your inference from tone (1 = awful, 10 = great). Day Score is the user's own and is not your job.
- Thorn Cause is a short reusable phrase (for example "lack of focus", "sleep deprivation") so recurring causes group together.
- Use only the listed themes. Pick the single best theme for Rose and Thorn.`;

export async function captureEntry(env: Env, input: { text: string; date?: string; day_score?: number | null; energy?: string | null }) {
  await ensureJournalSchema(env);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(input.date || '') ? input.date! : todayLocal();
  const id = `pkm${date.replace(/-/g, '')}`;
  const existing = await env.DB.prepare('SELECT body, day_score FROM journal_entries WHERE id = ?').bind(id).first();
  const body = existing?.body ? `${existing.body}\n\n${input.text.trim()}` : input.text.trim();

  const { data, cost_usd, model } = await askClaude(env, 'capture', CAPTURE_SYSTEM,
    `Date: ${date}\n\nJournal dump:\n${body}`, CaptureSchema, 'low');

  const entry: JournalEntry = {
    id,
    entry_date: date,
    source: 'PKM',
    ...data,
    energy: input.energy || data.energy,
    day_score: input.day_score ?? (existing?.day_score as number | null) ?? null,
    body,
  };
  await upsertStatement(env, entry, true).run();

  // Living Journal rule: a thorn that repeats a known cause gets a Thinking Template offer.
  let suggest_template: string | null = null;
  if (data.thorn_cause) {
    const repeat = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM journal_entries WHERE lower(trim(thorn_cause)) = lower(trim(?)) AND id != ?`
    ).bind(data.thorn_cause, id).first();
    if (((repeat?.n as number) || 0) >= 2) suggest_template = data.thorn_theme === 'Mindset' ? 'Pain Button' : 'Issue Log';
  }
  return { entry: await getEntry(env, id), missing: data.missing, suggest_template, model, cost_usd };
}

// --- Insights ----------------------------------------------------------------

const InsightSchema = z.object({
  headline: z.string().describe('One sentence: the most important thing this period shows'),
  patterns: z.array(z.object({
    title: z.string(),
    evidence: z.string().describe('Cite dates (YYYY-MM-DD) from the entries'),
  })).describe('2-4 patterns in mood, energy, roses and thorns'),
  energizers: z.array(z.string()).describe('What reliably lifts mood, with evidence'),
  drains: z.array(z.string()).describe('What reliably drains mood, with evidence'),
  experiments: z.array(z.object({
    action: z.string().describe('One concrete, small action for next week'),
    why: z.string().describe('Link to a pattern, and to a principle or goal from the wiki when one applies'),
  })).describe('1-3 experiments'),
  question: z.string().describe('One reflective question to journal on next'),
});

export type InsightPeriod = 'week' | 'month' | 'quarter' | 'all';

function periodRange(period: InsightPeriod, today: string): { from: string; key: string } {
  const t = Date.parse(today);
  const days = { week: 7, month: 30, quarter: 91, all: 36500 }[period];
  const from = isoDay(new Date(t - (days - 1) * 86400_000));
  return { from: period === 'all' ? '0000-01-01' : from, key: period === 'all' ? 'all' : `${from}..${today}` };
}

function entryLine(e: any, withBody: boolean): string {
  const parts = [
    e.entry_date,
    e.day_score != null ? `score ${e.day_score}` : null,
    e.mood != null ? `mood ${e.mood}` : null,
    e.energy ? `energy ${e.energy}` : null,
    e.summary ? `summary: ${e.summary}` : null,
    e.rose ? `rose(${e.rose_theme || '?'}): ${e.rose}` : null,
    e.thorn ? `thorn(${e.thorn_theme || '?'}; cause ${e.thorn_cause || '?'}): ${e.thorn}` : null,
    e.bud ? `bud: ${e.bud}` : null,
    e.key_wins ? `wins: ${e.key_wins}` : null,
    e.lesson ? `lesson: ${e.lesson}` : null,
  ].filter(Boolean);
  let line = parts.join(' | ');
  if (withBody && e.body) line += `\n  notes: ${String(e.body).replace(/\s+/g, ' ').slice(0, 1200)}`;
  return line;
}

/** Wiki pages that describe the owner's principles and goals, so suggestions tie back to them. */
async function principlesContext(env: Env): Promise<string> {
  try {
    const rows = await env.DB.prepare(
      `SELECT title, summary FROM pages
       WHERE title LIKE '%Principle%' OR title LIKE '%Goals%' OR title LIKE '%Two List%' OR title LIKE '%Pain Button%'
       ORDER BY updated_at DESC LIMIT 8`
    ).all();
    return (rows.results || []).map((r: any) => `- ${r.title}: ${String(r.summary || '').slice(0, 400)}`).join('\n');
  } catch { return ''; }
}

const INSIGHT_SYSTEM = `You are a candid, warm coach who reads a person's daily journal.
Find patterns the person may not see: what lifts or drains mood and energy, recurring thorn causes, and links between work, family and health.
Be specific. Cite entry dates as evidence. Do not moralize. Do not diagnose medical or mental-health conditions.
Mood is inferred by an AI from the entry text; Day Score is the person's own rating. Treat Day Score as the stronger signal when present.
Suggest small experiments the person can run next week, not life overhauls.`;

export async function getInsight(env: Env, period: InsightPeriod) {
  await ensureJournalSchema(env);
  const row = await env.DB.prepare(
    'SELECT * FROM journal_insights WHERE period = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(period).first();
  if (!row) return null;
  return { ...row, content: JSON.parse(row.content as string) };
}

export async function generateInsight(env: Env, period: InsightPeriod, opts: { force?: boolean; today?: string } = {}) {
  await ensureJournalSchema(env);
  const today = opts.today || todayLocal();
  const { from, key } = periodRange(period, today);

  const latest = await env.DB.prepare(
    'SELECT MAX(updated_at) AS u, COUNT(*) AS n FROM journal_entries WHERE entry_date >= ? AND entry_date <= ?'
  ).bind(from, today).first();
  if (!latest?.n) throw new Error(`No journal entries between ${from} and ${today}`);

  // Reuse the cached insight until an entry in this window changes.
  const cached = await env.DB.prepare(
    'SELECT * FROM journal_insights WHERE period = ? AND period_key = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(period, key).first();
  if (cached && !opts.force && (cached.entries_through as string) >= (latest.u as string)) {
    return { ...cached, content: JSON.parse(cached.content as string), cached: true };
  }

  const entries = (await env.DB.prepare(
    `SELECT * FROM journal_entries WHERE entry_date >= ? AND entry_date <= ? ORDER BY entry_date`
  ).bind(from, today).all()).results || [];

  // Short windows send full notes; long windows send one compact line per day.
  const withBody = period === 'week' || period === 'month';
  const meaningful = entries.filter((e: any) => e.summary || e.rose || e.thorn || e.key_wins || e.body);
  let lines = meaningful.map(e => entryLine(e, withBody));
  const MAX_CHARS = 120_000; // about 30K tokens; caps the cost of the "all" view
  while (lines.join('\n').length > MAX_CHARS && lines.length > 50) {
    lines = lines.filter((_, i) => i % 2 === 0); // thin evenly instead of cutting off recent history
  }
  const stats = await journalStats(env, today);
  const principles = await principlesContext(env);

  const user = [
    `Period: ${period} (${from === '0000-01-01' ? 'all time' : from} to ${today}), ${meaningful.length} entries with content.`,
    `Monthly averages: ${JSON.stringify(stats.monthly.slice(-24))}`,
    `Recurring thorn causes: ${JSON.stringify(stats.thorn_causes)}`,
    `Mood by weekday (0=Sun): ${JSON.stringify(stats.weekday)}`,
    principles ? `The person's own principles and goals from their wiki:\n${principles}` : '',
    `Entries:\n${lines.join('\n')}`,
  ].filter(Boolean).join('\n\n');

  const { data, model, usage, cost_usd } = await askClaude(env, `insight:${period}`, INSIGHT_SYSTEM, user, InsightSchema,
    period === 'week' ? 'low' : 'medium');

  await env.DB.prepare(
    `INSERT INTO journal_insights (period, period_key, content, model, input_tokens, output_tokens, cost_usd, entries_through)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(period, key, JSON.stringify(data), model, usage.input_tokens, usage.output_tokens, cost_usd, latest.u).run();

  return { period, period_key: key, content: data, model, cost_usd, created_at: new Date().toISOString(), cached: false };
}

// --- Templates -----------------------------------------------------------------

/** Daily Roam template plus the Thinking Templates (Cortex Futura and Dalio's Principles). */
export const BUILTIN_TEMPLATES: { name: string; body: string; hint: string }[] = [
  { name: 'Daily', hint: 'Rose, Thorn, Bud and the day in review',
    body: 'Rose:: \nThorn:: \nBud:: \nKey Wins:: \nLesson:: \n\n## Day in Review\n- \n\n### Goals for tomorrow\n- [ ] ' },
  { name: 'Issue Log', hint: 'Something went wrong; find the root cause',
    body: '## Issue Log\n1. What suboptimality did you experience?\n2. What is the mental map of how it was supposed to work?\n3. What should have happened? What did happen?\n4. What, if anything, broke? Was it the design or how the people in it behaved?\n5. Proximate causes: what was not done?\n6. Root causes (ask "why" five times; a root cause is a reason, not an action):\n7. Is this consistent with a prior pattern? (Yes / No / Unsure)\n8. What is the long-term fix? Does a machine design need to change?\n' },
  { name: 'Choice', hint: 'You face a decision',
    body: '## Choice\n- Constraints:\n- Options:\n- Decision:\n- Review on (date) and outcome:\n' },
  { name: 'Pain Button', hint: 'A strong negative emotion hit',
    body: '## Pain Button\n- Time:\n- Emotion:\n- Context:\n- Proximate cause:\n- Reflection:\n- Reflect on this again on (date):\n' },
  { name: 'Difference Engine', hint: 'You set a goal or feel stuck',
    body: '## Difference Engine\n- Current situation:\n- Future situation:\n- Differences between them:\n- Most serious difference:\n- Steps to reduce the difference:\n' },
  { name: 'I Want', hint: 'You want something and something blocks you',
    body: '## I Want\n- I want…\n- Impediment:\n- Remedy:\n- Action items:\n' },
  { name: 'Disagreement Check', hint: 'You disagree with someone, or with the market',
    body: '## Disagreement Check\n- Missing information?\n- Wrong information?\n- Reasoning errors? Non sequitur? Inconsistency?\n- Incomplete analysis?\n' },
];

export async function listTemplates(env: Env) {
  await ensureJournalSchema(env);
  let custom: { name: string; body: string }[] = [];
  try { custom = JSON.parse((await getState(env, 'templates')) || '[]'); } catch {}
  return [...BUILTIN_TEMPLATES.map(t => ({ ...t, builtin: true })), ...custom.map(t => ({ ...t, hint: 'Imported', builtin: false }))];
}

/** Save imported templates. Same-name templates are replaced; built-ins cannot be overwritten. */
export async function saveTemplates(env: Env, incoming: { name: string; body: string }[]) {
  await ensureJournalSchema(env);
  let custom: { name: string; body: string }[] = [];
  try { custom = JSON.parse((await getState(env, 'templates')) || '[]'); } catch {}
  const builtin = new Set(BUILTIN_TEMPLATES.map(t => t.name.toLowerCase()));
  for (const t of incoming) {
    const name = String(t.name || '').trim().slice(0, 60);
    const body = String(t.body || '').slice(0, 5000);
    if (!name || !body || builtin.has(name.toLowerCase())) continue;
    custom = custom.filter(c => c.name.toLowerCase() !== name.toLowerCase()).concat([{ name, body }]);
  }
  await setState(env, 'templates', JSON.stringify(custom.slice(-30)));
  return listTemplates(env);
}

// --- Enrich imported days -----------------------------------------------------------

const ENRICH_BATCH = 8;
const NEEDS_ENRICH = `summary IS NULL AND length(coalesce(body, '') || coalesce(rose, '') || coalesce(thorn, '')) > 40`;

const EnrichSchema = z.object({
  days: z.array(z.object({
    id: z.string(),
    summary: z.string().describe('One-line summary of the day, third person'),
    rose_theme: Theme,
    thorn_theme: Theme,
    thorn_cause: z.string().nullable().describe('Short reusable root cause of the thorn, 2-6 words'),
    mood: z.number().int().min(1).max(10),
    mood_confidence: z.enum(['High', 'Medium', 'Low']),
    energy: z.enum(['High', 'Medium', 'Low']).nullable(),
    tags: z.array(z.enum(THEMES)),
    notable: z.string().nullable(),
    entry_type: z.enum(['Daily', 'Weekly Preview', 'Work Notes', 'Other']),
  })),
});

/** How many imported days still lack a summary, and what enriching them would cost. */
export async function enrichEstimate(env: Env) {
  await ensureJournalSchema(env);
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n, SUM(min(length(coalesce(body, '')), 3000) + length(coalesce(rose, '') || coalesce(thorn, ''))) AS chars
     FROM journal_entries WHERE ${NEEDS_ENRICH}`
  ).first();
  const n = (row?.n as number) || 0;
  const model = env.JOURNAL_MODEL || DEFAULT_MODEL;
  const [pin, pout] = PRICES[model] || PRICES[DEFAULT_MODEL];
  const calls = Math.ceil(n / ENRICH_BATCH);
  const inTokens = ((row?.chars as number) || 0) / 4 + calls * 900;
  const outTokens = n * 220 + calls * 600; // fields per day plus thinking
  return { remaining: n, model, est_cost_usd: Math.round(((inTokens * pin + outTokens * pout) / 1e6) * 100) / 100 };
}

/** Fill summary, mood, themes and thorn cause for imported days. Never overwrites a filled field. */
export async function enrichEntries(env: Env) {
  await ensureJournalSchema(env);
  const rows = ((await env.DB.prepare(
    `SELECT id, entry_date, rose, thorn, bud, key_wins, lesson, body FROM journal_entries
     WHERE ${NEEDS_ENRICH} ORDER BY entry_date LIMIT ?`
  ).bind(ENRICH_BATCH).all()).results || []) as any[];
  if (!rows.length) return { enriched: 0, remaining: 0, cost_usd: 0 };

  const user = rows.map(r => [
    `### id=${r.id} date=${r.entry_date}`,
    r.rose ? `Rose: ${r.rose}` : '', r.thorn ? `Thorn: ${r.thorn}` : '', r.bud ? `Bud: ${r.bud}` : '',
    r.key_wins ? `Wins: ${r.key_wins}` : '', r.lesson ? `Lesson: ${r.lesson}` : '',
    r.body ? String(r.body).slice(0, 3000) : '',
  ].filter(Boolean).join('\n')).join('\n\n');

  const { data, cost_usd } = await askClaude(env, 'enrich', `${CAPTURE_SYSTEM}
You receive several past journal days. Return one item per day, with the same id.
Infer only summary, themes, thorn cause, mood, energy, tags, notable and entry type. Keep the person's words where you quote.`,
    user, EnrichSchema, 'low');

  const byId = new Map(data.days.map(d => [d.id, d]));
  const stmts = rows.map(r => {
    const d = byId.get(r.id);
    if (!d) return env.DB.prepare(`UPDATE journal_entries SET summary = '' WHERE id = ?`).bind(r.id); // do not retry forever
    return env.DB.prepare(
      `UPDATE journal_entries SET summary = ?, rose_theme = COALESCE(rose_theme, ?), thorn_theme = COALESCE(thorn_theme, ?),
         thorn_cause = COALESCE(thorn_cause, ?), mood = COALESCE(mood, ?), mood_confidence = COALESCE(mood_confidence, ?),
         energy = COALESCE(energy, ?), notable = COALESCE(notable, ?), entry_type = COALESCE(entry_type, ?),
         tags = CASE WHEN tags IS NULL OR tags = '[]' THEN ? ELSE tags END, updated_at = datetime('now')
       WHERE id = ?`
    ).bind(d.summary, d.rose_theme, d.thorn_theme, d.thorn_cause, d.mood, d.mood_confidence, d.energy, d.notable,
      d.entry_type, JSON.stringify(d.tags), r.id);
  });
  await env.DB.batch(stmts);
  const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM journal_entries WHERE ${NEEDS_ENRICH}`).first();
  return { enriched: rows.length, remaining: (left?.n as number) || 0, cost_usd };
}

// --- Ask your journal -----------------------------------------------------------

const AnswerSchema = z.object({
  answer: z.string().describe('Direct answer in 2-6 sentences'),
  dates: z.array(z.string()).describe('Entry dates (YYYY-MM-DD) that support the answer'),
});

export async function askJournal(env: Env, question: string) {
  const hits = await listEntries(env, { q: question, limit: 25 });
  const recent = hits.length < 8 ? await listEntries(env, { limit: 30 }) : [];
  const context = [...hits, ...recent.filter(r => !hits.some((h: any) => h.id === r.id))]
    .map(e => entryLine(e, true)).join('\n');
  const { data, cost_usd } = await askClaude(env, 'ask',
    'Answer questions about the person\'s own journal. Use only the entries given. Say so when the entries do not answer the question.',
    `Question: ${question}\n\nEntries:\n${context}`, AnswerSchema, 'low');
  return { ...data, cost_usd };
}
