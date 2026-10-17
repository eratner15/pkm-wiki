/**
 * Keepsake: a curated, printable book of the whole journal (one volume for all years).
 * Two Claude passes read every day once: "years" writes a chapter per year and picks the
 * days to print in full; "connections" finds threads across years, people, echoes, a
 * letter and closing questions. Every quote is checked against the notes word for word,
 * and quotes that do not match are dropped. Results live in journal_state 'keepsake'.
 */
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { Env } from './types';
import { claudeClient, DEFAULT_MODEL, ensureJournalSchema, getState, logActivity, PRICES, setState } from './journal';

const STATE_KEY = 'keepsake';
const MAX_ENTRY_CHARS = 6000;
const OUTPUT_TOKENS = 32000;

export type KeepsakeStep = 'years' | 'connections';

const Quote = z.object({
  entry_id: z.string().describe('The id shown in the entry header, for example md20210314'),
  text: z.string().describe('Exact words copied from that entry. Use "..." to join two exact pieces of the same entry.'),
});

const YearsSchema = z.object({
  years: z.array(z.object({
    year: z.string().describe('Four-digit year, or a range such as "2022–2024" for thin years grouped together'),
    title: z.string().describe('A chapter title of two to six words, specific to this year'),
    essay: z.string().describe('250 to 450 words, second person, warm and specific, built from what the notes say'),
    months: z.array(z.object({
      month: z.string().describe('YYYY-MM'),
      line: z.string().describe('One sentence on what this month held, from the notes'),
    })),
    days: z.array(z.object({
      entry_id: z.string(),
      why: z.string().describe('One short sentence on why this day belongs in the book'),
    })),
    quotes: z.array(Quote),
  })),
});

const ConnectionsSchema = z.object({
  title_options: z.array(z.string()).describe('Three to five possible book titles'),
  letter: z.string().describe('A letter to the writer, 400 to 600 words, second person, plain and warm'),
  threads: z.array(z.object({
    title: z.string(),
    essay: z.string().describe('150 to 300 words tracing the thread through the years'),
    quotes: z.array(Quote).describe('Three to six quotes from at least two different years'),
  })),
  people: z.array(z.object({
    name: z.string().describe('Exactly as listed in the people list'),
    essay: z.string().describe('100 to 200 words on this person across the notes'),
    quotes: z.array(Quote),
  })),
  echoes: z.array(z.object({
    title: z.string(),
    first: Quote,
    second: Quote,
    note: z.string().describe('One or two sentences on how the two moments speak to each other'),
  })),
  questions: z.array(z.string()).describe('Five to eight questions for the next five years, drawn from the notes'),
});

export type YearsData = z.infer<typeof YearsSchema>;
export type ConnectionsData = z.infer<typeof ConnectionsSchema>;

export interface KeepsakeEdits { title?: string; subtitle?: string; dedication?: string; excluded?: string[] }
export interface KeepsakeState {
  years?: { data: YearsData; at: string; model: string; cost_usd: number; dropped_quotes: number };
  connections?: { data: ConnectionsData; at: string; model: string; cost_usd: number; dropped_quotes: number };
  edits?: KeepsakeEdits;
}

export async function getKeepsake(env: Env): Promise<KeepsakeState> {
  await ensureJournalSchema(env);
  const raw = await getState(env, STATE_KEY);
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

async function saveKeepsake(env: Env, k: KeepsakeState): Promise<void> {
  await setState(env, STATE_KEY, JSON.stringify(k));
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

/** Roam markup to plain text, keeping bullet indentation. */
export function plainNotes(body: string): string {
  return String(body || '')
    .replace(/\r/g, '')
    .replace(/\{\{\[\[TODO\]\]\}\}/g, '[ ]').replace(/\{\{\[\[DONE\]\]\}\}/g, '[x]')
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/\(\([\w-]{6,}\)\)/g, '')
    .replace(/#?\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1')
    .split('\n').filter(l => l.trim() && !/^\s*---\s*$/.test(l)).join('\n');
}

const FIELDS: [string, string][] = [['rose', 'Rose'], ['thorn', 'Thorn'], ['bud', 'Bud'], ['key_wins', 'Wins'], ['lesson', 'Lesson'], ['next_action', 'Next']];

/** The text a quote may come from: the fields and the notes of one entry. */
export function entrySource(e: any): string {
  const parts = FIELDS.filter(([k]) => e[k]).map(([k, label]) => `${label}: ${plainNotes(e[k])}`);
  if (e.body) parts.push(plainNotes(e.body));
  return parts.join('\n');
}

function weekday(date: string): string {
  return new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}

export async function loadEntries(env: Env): Promise<any[]> {
  await ensureJournalSchema(env);
  return ((await env.DB.prepare(
    `SELECT id, entry_date, rose, thorn, bud, key_wins, lesson, next_action, summary, mood, day_score, body
     FROM journal_entries ORDER BY entry_date, id`
  ).all()).results || []) as any[];
}

async function loadPeople(env: Env): Promise<{ name: string; aliases: string; n: number; first: string; last: string }[]> {
  try {
    return ((await env.DB.prepare(
      `SELECT p.name, p.aliases, COUNT(*) AS n, MIN(e.entry_date) AS first, MAX(e.entry_date) AS last
       FROM journal_mentions m JOIN journal_persons p ON p.id = m.person_id JOIN journal_entries e ON e.id = m.entry_id
       GROUP BY p.id ORDER BY n DESC`
    ).all()).results || []) as any[];
  } catch { return []; }
}

export function buildCorpus(entries: any[]): string {
  return entries.map(e => {
    const src = entrySource(e);
    const text = src.length > MAX_ENTRY_CHARS ? src.slice(0, MAX_ENTRY_CHARS) + '\n[…entry continues]' : src;
    return `### ${e.id} · ${e.entry_date} (${weekday(e.entry_date)})\n${text}`;
  }).join('\n\n');
}

// ---------------------------------------------------------------------------
// Quote check
// ---------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase()
  .replace(/[‘’`]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
  .replace(/[*_#\[\]]/g, '')
  .replace(/\s+/g, ' ').trim();

/** True when every piece of the quote (split on "...") appears in the source, in order. */
export function quoteMatches(quote: string, source: string): boolean {
  const pieces = quote.split(/\.\.\.|…/).map(p => norm(p).replace(/^[\s"'.,;:-]+|[\s"'.,;:-]+$/g, '')).filter(p => p.length > 0);
  if (!pieces.length || pieces.join('').length < 8) return false;
  const hay = norm(source);
  let from = 0;
  for (const p of pieces) {
    const at = hay.indexOf(p, from);
    if (at < 0) return false;
    from = at + p.length;
  }
  return true;
}

type Q = { entry_id: string; text: string };

export function makeChecker(entries: any[]) {
  const byId = new Map(entries.map(e => [e.id, e]));
  const sources = new Map<string, string>();
  let dropped = 0;
  const ok = (q: Q | null | undefined): boolean => {
    if (!q?.entry_id || !q.text) return false;
    const e = byId.get(q.entry_id);
    if (!e) return false;
    if (!sources.has(e.id)) sources.set(e.id, entrySource(e));
    return quoteMatches(q.text, sources.get(e.id)!);
  };
  const keep = <T extends Q>(list: T[]): T[] => list.filter(q => (ok(q) ? true : (dropped++, false)));
  return { ok, keep, has: (id: string) => byId.has(id), dropped: () => dropped, countDrop: () => { dropped++; } };
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

const SYSTEM = `You are editing a private keepsake book. The writer kept a daily journal from 2020 to 2024 (most of it in Roam) and is giving themselves a printed book of it as a gift.

Your job is to help them see their own five years: the threads that run through them, the people in them, the moments that echo each other across years, and how they changed.

Rules:
- Use only what the notes say. Do not invent events, feelings, names or outcomes. If the notes are thin, say less.
- Write to the writer in the second person ("you"), plainly and warmly, without flattery, therapy language or clichés.
- Quotes must be exact words from one entry, copied character for character. Use "..." only to join two exact pieces from the same entry. Every quote carries the id from that entry's header. A quote that does not match is removed from the book.
- Refer to days by date in prose (for example "on 14 March 2021"), never by id.
- Leave out passwords, account numbers, addresses and anything that reads like a private credential.

The journal follows. Each entry starts with "### <id> · <date> (<weekday>)".`;

function stepPrompt(step: KeepsakeStep, entries: any[], people: Awaited<ReturnType<typeof loadPeople>>): string {
  const perYear = new Map<string, number>();
  for (const e of entries) perYear.set(e.entry_date.slice(0, 4), (perYear.get(e.entry_date.slice(0, 4)) || 0) + 1);
  const yearsLine = [...perYear].map(([y, n]) => `${y}: ${n} days`).join(', ');
  if (step === 'years') {
    return `Write the year chapters. Days per year: ${yearsLine}.

- One chapter per year. Group years with fewer than 15 days into one chapter with a range such as "2022–2024".
- For each chapter: a specific title, an essay, one line per month that has entries, and the days to print in full.
- Pick days to print in full: about 22 for a year with 150+ days, about 18 for 100–150, about 10 for 30–100, and every day for thinner years. Choose days that carry the year: turning points, roses, hard days that taught something, firsts and lasts, days about the people who matter. Prefer days with real writing over days with only tasks.
- Add six to ten exact quotes per chapter, the lines most worth keeping.`;
  }
  const aliasList = (raw: string) => { try { return (JSON.parse(raw || '[]') as string[]).join(', '); } catch { return ''; } };
  const names = people.slice(0, 12).map(p => `${p.name} (${p.n} days, ${p.first} to ${p.last}${aliasList(p.aliases) ? `, also written as ${aliasList(p.aliases)}` : ''})`).join('; ');
  return `Find the connections across the whole journal.

- threads: six to eight themes that come back across years (work, health, money, family, faith, a project, a habit, a fear). Trace each one through time with exact quotes from at least two different years.
- people: one short piece each for the people below who appear on at least eight days. Use their names exactly as listed. People: ${names || 'none indexed'}.
- echoes: eight to twelve pairs of moments from different years that speak to each other: a plan and what happened, a worry and its answer, the same date a year apart, the same feeling in a new place. Each side is an exact quote.
- letter: a letter to the writer about these five years, from what the notes show.
- questions: questions for the next five years, drawn from what the notes left open.
- title_options: possible titles for the book.`;
}

function costOf(model: string, u: any): number {
  const [pin, pout] = PRICES[model] || PRICES[DEFAULT_MODEL];
  const read = u.cache_read_input_tokens || 0, write = u.cache_creation_input_tokens || 0;
  return (u.input_tokens * pin + write * pin * 1.25 + read * pin * 0.1 + u.output_tokens * pout) / 1_000_000;
}

export async function keepsakeEstimate(env: Env) {
  const entries = await loadEntries(env);
  const corpusTokens = Math.round(buildCorpus(entries).length / 3.6);
  const [pin, pout] = PRICES[env.JOURNAL_MODEL || DEFAULT_MODEL] || PRICES[DEFAULT_MODEL];
  // First pass writes the cache, the second reads it; about 12k output tokens each.
  const est = (corpusTokens * pin * 1.25 + corpusTokens * pin * 0.1 + 2 * 12000 * pout) / 1_000_000;
  return { days: entries.length, corpus_tokens: corpusTokens, estimated_cost_usd: Math.round(est * 100) / 100, model: env.JOURNAL_MODEL || DEFAULT_MODEL };
}

export async function writeKeepsake(env: Env, step: KeepsakeStep) {
  const entries = await loadEntries(env);
  if (!entries.length) throw new Error('The journal is empty');
  const people = await loadPeople(env);
  const model = env.JOURNAL_MODEL || DEFAULT_MODEL;
  const schema = step === 'years' ? YearsSchema : ConnectionsSchema;
  // Streamed so the long read and write keep the connection through the AI Gateway alive.
  const response = await claudeClient(env).beta.messages.stream({
    model,
    max_tokens: OUTPUT_TOKENS,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'high', format: betaZodOutputFormat(schema) },
    system: [
      { type: 'text', text: SYSTEM },
      { type: 'text', text: buildCorpus(entries), cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: stepPrompt(step, entries, people) }],
  }, { timeout: 15 * 60 * 1000 }).finalMessage();
  if (response.stop_reason === 'refusal') throw new Error(`Claude declined this request (${response.stop_details?.category ?? 'no category'})`);
  if (response.stop_reason === 'max_tokens') throw new Error('Claude ran out of room before finishing. Try again.');
  if (!response.parsed_output) throw new Error(`Claude returned no structured output (stop: ${response.stop_reason})`);
  const cost_usd = costOf(model, response.usage);
  await logActivity(env, 'journal_ai', { purpose: `keepsake_${step}`, model: response.model, input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens, cost_usd });

  const check = makeChecker(entries);
  const k = await getKeepsake(env);
  const at = new Date().toISOString();
  if (step === 'years') {
    const data = response.parsed_output as YearsData;
    for (const y of data.years) {
      y.days = y.days.filter(d => check.has(d.entry_id));
      y.quotes = check.keep(y.quotes);
    }
    k.years = { data, at, model: response.model, cost_usd, dropped_quotes: check.dropped() };
  } else {
    const data = response.parsed_output as ConnectionsData;
    for (const t of data.threads) t.quotes = check.keep(t.quotes);
    for (const p of data.people) p.quotes = check.keep(p.quotes);
    data.echoes = data.echoes.filter(e => (check.ok(e.first) && check.ok(e.second)) || (check.countDrop(), false));
    k.connections = { data, at, model: response.model, cost_usd, dropped_quotes: check.dropped() };
  }
  await saveKeepsake(env, k);
  return { step, cost_usd: Math.round(cost_usd * 100) / 100, dropped_quotes: check.dropped() };
}

export async function updateKeepsakeEdits(env: Env, body: any): Promise<KeepsakeEdits> {
  const k = await getKeepsake(env);
  const edits: KeepsakeEdits = { ...(k.edits || {}) };
  const text = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
  if (body.title !== undefined) edits.title = text(body.title, 120);
  if (body.subtitle !== undefined) edits.subtitle = text(body.subtitle, 160);
  if (body.dedication !== undefined) edits.dedication = text(body.dedication, 1200);
  const excluded = new Set(edits.excluded || []);
  if (typeof body.exclude === 'string') excluded.add(body.exclude);
  if (typeof body.include === 'string') excluded.delete(body.include);
  edits.excluded = [...excluded].slice(0, 500);
  k.edits = edits;
  await saveKeepsake(env, k);
  return edits;
}
