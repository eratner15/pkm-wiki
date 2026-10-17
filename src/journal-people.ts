/**
 * People index for the Living Journal. A person has a name and aliases; every
 * journal day that mentions one of them is linked through journal_mentions.
 * Names live in D1, never in code (this repository is public).
 */
import { Env } from './types';
import { ensureJournalSchema } from './journal';

const PEOPLE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS journal_persons (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    aliases TEXT DEFAULT '[]',
    circle TEXT,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS journal_mentions (
    person_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    PRIMARY KEY (person_id, entry_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_journal_mentions_entry ON journal_mentions(entry_id)`,
];

let ready = false;
async function ensurePeopleSchema(env: Env) {
  if (ready) return;
  await ensureJournalSchema(env);
  await env.DB.batch(PEOPLE_SCHEMA.map(s => env.DB.prepare(s)));
  ready = true;
}

export function personId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word, case-sensitive match on each name form, so "Bob" does not match "bobbing". */
function matcher(names: string[]): RegExp {
  const forms = names.filter(Boolean).map(n => escapeRe(n.trim())).filter(n => n.length >= 2);
  return new RegExp(`(^|[^A-Za-z0-9])(${forms.join('|')})(?![A-Za-z0-9])`);
}

const TEXT_COLS = ['title', 'summary', 'rose', 'thorn', 'bud', 'key_wins', 'lesson', 'next_action', 'notable', 'body', 'people'];

/** Recompute mentions for all people (or one). About 450 days by 30 people runs in well under a second. */
export async function rebuildMentions(env: Env, onlyPersonId?: string): Promise<{ people: number; mentions: number }> {
  await ensurePeopleSchema(env);
  const persons = ((await env.DB.prepare(
    onlyPersonId ? 'SELECT * FROM journal_persons WHERE id = ?' : 'SELECT * FROM journal_persons'
  ).bind(...(onlyPersonId ? [onlyPersonId] : [])).all()).results || []) as any[];
  if (!persons.length) return { people: 0, mentions: 0 };

  const matchers = persons.map(p => {
    let aliases: string[] = [];
    try { aliases = JSON.parse(p.aliases || '[]'); } catch {}
    return { id: p.id as string, re: matcher([p.name, ...aliases]) };
  });

  const stmts: D1PreparedStatement[] = [];
  stmts.push(onlyPersonId
    ? env.DB.prepare('DELETE FROM journal_mentions WHERE person_id = ?').bind(onlyPersonId)
    : env.DB.prepare('DELETE FROM journal_mentions'));

  let offset = 0;
  for (;;) {
    const rows = ((await env.DB.prepare(
      `SELECT id, ${TEXT_COLS.join(', ')} FROM journal_entries ORDER BY id LIMIT 300 OFFSET ?`
    ).bind(offset).all()).results || []) as any[];
    if (!rows.length) break;
    for (const r of rows) {
      const text = TEXT_COLS.map(c => r[c] || '').join('\n');
      for (const m of matchers) if (m.re.test(text)) {
        stmts.push(env.DB.prepare('INSERT OR IGNORE INTO journal_mentions (person_id, entry_id) VALUES (?, ?)').bind(m.id, r.id));
      }
    }
    offset += rows.length;
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return { people: persons.length, mentions: stmts.length - 1 };
}

export async function upsertPerson(env: Env, input: { name: string; aliases?: string[]; circle?: string | null; note?: string | null; id?: string }) {
  await ensurePeopleSchema(env);
  const name = String(input.name || '').trim().slice(0, 80);
  if (!name) throw new Error('name is required');
  const id = input.id || personId(name);
  const aliases = (input.aliases || []).map(a => String(a).trim()).filter(a => a && a !== name).slice(0, 20);
  await env.DB.prepare(
    `INSERT INTO journal_persons (id, name, aliases, circle, note) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, aliases = excluded.aliases,
       circle = COALESCE(excluded.circle, journal_persons.circle), note = COALESCE(excluded.note, journal_persons.note)`
  ).bind(id, name, JSON.stringify(aliases), input.circle ?? null, input.note ?? null).run();
  await rebuildMentions(env, id);
  return getPerson(env, id);
}

export async function deletePerson(env: Env, id: string) {
  await ensurePeopleSchema(env);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM journal_mentions WHERE person_id = ?').bind(id),
    env.DB.prepare('DELETE FROM journal_persons WHERE id = ?').bind(id),
  ]);
}

export async function listPeople(env: Env) {
  await ensurePeopleSchema(env);
  const [people, overall] = await env.DB.batch([
    env.DB.prepare(
      `SELECT p.id, p.name, p.aliases, p.circle, COUNT(e.id) AS days, MIN(e.entry_date) AS first, MAX(e.entry_date) AS last,
              ROUND(AVG(e.mood), 2) AS mood
       FROM journal_persons p
       LEFT JOIN journal_mentions m ON m.person_id = p.id
       LEFT JOIN journal_entries e ON e.id = m.entry_id
       GROUP BY p.id ORDER BY days DESC, p.name`
    ),
    env.DB.prepare('SELECT ROUND(AVG(mood), 2) AS mood FROM journal_entries WHERE mood IS NOT NULL'),
  ]);
  const avg = (overall.results?.[0] as any)?.mood ?? null;
  return {
    average_mood: avg,
    people: ((people.results || []) as any[]).map(p => ({
      ...p,
      aliases: JSON.parse(p.aliases || '[]'),
      mood_delta: p.mood != null && avg != null ? Math.round((p.mood - avg) * 100) / 100 : null,
    })),
  };
}

export async function getPerson(env: Env, id: string) {
  await ensurePeopleSchema(env);
  const p = await env.DB.prepare('SELECT * FROM journal_persons WHERE id = ?').bind(id).first() as any;
  if (!p) return null;
  const [days, themes, also] = await env.DB.batch([
    env.DB.prepare(
      `SELECT e.id, e.entry_date, e.title, e.summary, e.rose, e.thorn, e.mood, e.day_score, e.body
       FROM journal_mentions m JOIN journal_entries e ON e.id = m.entry_id
       WHERE m.person_id = ? ORDER BY e.entry_date DESC`
    ).bind(id),
    env.DB.prepare(
      `SELECT 'rose' AS kind, e.rose_theme AS theme, COUNT(*) AS n FROM journal_mentions m JOIN journal_entries e ON e.id = m.entry_id
       WHERE m.person_id = ? AND e.rose_theme IS NOT NULL GROUP BY 2
       UNION ALL
       SELECT 'thorn', e.thorn_theme, COUNT(*) FROM journal_mentions m JOIN journal_entries e ON e.id = m.entry_id
       WHERE m.person_id = ? AND e.thorn_theme IS NOT NULL GROUP BY 2 ORDER BY 3 DESC`
    ).bind(id, id),
    env.DB.prepare(
      `SELECT p.id, p.name, COUNT(*) AS n FROM journal_mentions a JOIN journal_mentions b ON a.entry_id = b.entry_id AND b.person_id != a.person_id
       JOIN journal_persons p ON p.id = b.person_id WHERE a.person_id = ? GROUP BY p.id ORDER BY n DESC LIMIT 8`
    ).bind(id),
  ]);
  const aliases: string[] = JSON.parse(p.aliases || '[]');
  const re = matcher([p.name, ...aliases]);
  const rows = ((days.results || []) as any[]).map(d => {
    // A short excerpt around the first mention, so the page shows why the day is linked.
    const text = [d.rose, d.thorn, d.summary, d.body].filter(Boolean).join(' · ')
      .replace(/\{\{[^}]*\}\}|\(\([\w-]{6,}\)\)/g, '').replace(/#?\[\[|\]\]/g, '')
      .replace(/^\s*[-*+]\s+/gm, '').replace(/\s[-*+]\s/g, ' ').replace(/\*\*/g, '').replace(/\s+/g, ' ');
    const m = text.match(re);
    const at = m && m.index != null ? m.index : 0;
    const excerpt = (at > 60 ? '…' : '') + text.slice(Math.max(0, at - 60), at + 140) + (text.length > at + 140 ? '…' : '');
    delete d.body;
    return { ...d, excerpt };
  });
  return { ...p, aliases, days: rows, themes: themes.results || [], seen_with: also.results || [] };
}

/** People-like names that recur in the journal but are not in the registry yet. */
export async function suggestPeople(env: Env, limit = 30) {
  await ensurePeopleSchema(env);
  const known = new Set<string>();
  for (const p of ((await env.DB.prepare('SELECT name, aliases FROM journal_persons').all()).results || []) as any[]) {
    known.add(String(p.name).toLowerCase());
    for (const a of JSON.parse(p.aliases || '[]')) known.add(String(a).toLowerCase());
  }
  const counts = new Map<string, Set<string>>();
  const add = (name: string, entryId: string) => {
    const n = name.trim();
    if (!/^[A-Z][a-zA-Z'’.-]+( [A-Z][a-zA-Z'’.-]+){0,2}$/.test(n) && !/^[A-Z]{2,4}$/.test(n)) return;
    if (known.has(n.toLowerCase()) || STOP.has(n.toLowerCase())) return;
    if (/^(January|February|March|April|May|June|July|August|September|October|November|December)\b/.test(n)) return;
    if (!counts.has(n)) counts.set(n, new Set());
    counts.get(n)!.add(entryId);
  };
  let offset = 0;
  for (;;) {
    const rows = ((await env.DB.prepare('SELECT id, body, people FROM journal_entries ORDER BY id LIMIT 300 OFFSET ?')
      .bind(offset).all()).results || []) as any[];
    if (!rows.length) break;
    for (const r of rows) {
      for (const m of String(r.body || '').matchAll(/\[\[([^\[\]]{2,40})\]\]/g)) add(m[1], r.id);
      try { for (const n of JSON.parse(r.people || '[]')) add(String(n), r.id); } catch {}
    }
    offset += rows.length;
  }
  return [...counts.entries()]
    .map(([name, ids]) => ({ name, days: ids.size }))
    .filter(s => s.days >= 3)
    .sort((a, b) => b.days - a.days)
    .slice(0, limit);
}

// Roam page links that are labels, places or topics rather than people.
const STOP = new Set([
  'day in review', 'rose of the day', 'thorn of the day', 'wins for the day', 'goals', 'todo', 'done', 'template', 'breakfast',
  'lunch', 'dinner', 'weekly preview', 'daily stuff', 'deep work', 'golf', 'gym', 'peloton', 'spac', 'spacs', 'roam', 'notion',
  'twitter', 'tiktok', 'zoom', 'miami', 'nyc', 'new york', 'florida', 'office', 'home', 'work', 'family', 'kids', 'health',
  'investing', 'markets', 'learning', 'writing', 'reading', 'books', 'book', 'podcast', 'podcasts', 'ideas', 'idea', 'meeting',
  'call', 'calls', 'journal', 'mindset', 'planning', 'travel', 'food', 'money', 'faith', 'social', 'friends', 'marriage',
  'scene of the day', 'key learning today', 'day score', 'slider', 'big three', 'covid', 'covid-19',
]);
