import { Env } from './types';
import {
  askJournal, captureEntry, enrichEntries, enrichEstimate, generateInsight, getEntry, getInsight, importEntries,
  InsightPeriod, journalStats, listEntries, listTemplates, saveTemplates, syncJournalFromNotion,
} from './journal';
import { journalPageHTML, peoplePageHTML } from './journal-page';
import { deletePerson, getPerson, listPeople, rebuildMentions, suggestPeople, upsertPerson } from './journal-people';
import { bookHTML, bookYears } from './journal-book';
import { importJournalFromWiki, importLibrary } from './journal-library';
import { buildReminder, sendNightlyReminder } from './journal-reminder';

const PERIODS: InsightPeriod[] = ['week', 'month', 'quarter', 'all'];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Handles /journal and /api/journal/*. Returns null for paths it does not own. */
export async function handleJournalRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname.replace(/\/$/, '') || '/';
  const method = request.method;

  const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  if (method === 'GET' && path === '/journal') return html(journalPageHTML());
  if (method === 'GET' && (path === '/journal/people' || path.startsWith('/journal/people/'))) return html(peoplePageHTML());
  const book = path.match(/^\/journal\/book\/(\d{4})$/);
  if (method === 'GET' && book) {
    const page = await bookHTML(env, book[1]);
    return page ? html(page) : html('<p style="font-family:sans-serif;padding:24px">No entries for that year. <a href="/journal">Back</a></p>', 404);
  }
  if (!path.startsWith('/api/journal')) return null;

  try {
    if (method === 'GET' && path === '/api/journal/stats') {
      return json(await journalStats(env));
    }

    if (method === 'GET' && path === '/api/journal/entries') {
      const entries = await listEntries(env, {
        from: url.searchParams.get('from') || undefined,
        to: url.searchParams.get('to') || undefined,
        q: url.searchParams.get('q') || undefined,
        limit: Number(url.searchParams.get('limit')) || undefined,
      });
      return json({ entries });
    }

    const entryMatch = path.match(/^\/api\/journal\/entries\/([\w-]+)$/);
    if (method === 'GET' && entryMatch) {
      const entry = await getEntry(env, entryMatch[1]);
      return entry ? json({ entry }) : json({ error: 'Entry not found' }, 404);
    }

    if (method === 'POST' && path === '/api/journal/capture') {
      const body = await request.json() as any;
      if (!body?.text || typeof body.text !== 'string') return json({ error: 'text is required' }, 400);
      const score = body.day_score == null ? null : Number(body.day_score);
      const captured = await captureEntry(env, {
        text: body.text.slice(0, 20_000),
        date: body.date,
        day_score: score != null && score >= 1 && score <= 10 ? score : null,
        energy: ['High', 'Medium', 'Low'].includes(body.energy) ? body.energy : null,
      });
      await rebuildMentions(env);
      return json(captured);
    }

    if (method === 'POST' && path === '/api/journal/sync') {
      const body = await request.json().catch(() => ({})) as any;
      return json(await syncJournalFromNotion(env, {
        full: !!body.full,
        bodyLimit: Math.min(Number(body.bodies) || 20, 80),
      }));
    }

    if (method === 'POST' && path === '/api/journal/import') {
      const body = await request.json() as any;
      if (!Array.isArray(body?.entries)) return json({ error: 'entries array is required' }, 400);
      const result = await importEntries(env, body.entries.slice(0, 500));
      if (body.last !== false) await rebuildMentions(env);
      return json(result);
    }

    if (path === '/api/journal/insights') {
      if (method === 'GET') {
        const period = (url.searchParams.get('period') || 'week') as InsightPeriod;
        if (!PERIODS.includes(period)) return json({ error: 'bad period' }, 400);
        return json({ insight: await getInsight(env, period) });
      }
      if (method === 'POST') {
        const body = await request.json().catch(() => ({})) as any;
        const period = (body.period || 'week') as InsightPeriod;
        if (!PERIODS.includes(period)) return json({ error: 'bad period' }, 400);
        return json(await generateInsight(env, period, { force: !!body.force }));
      }
    }

    if (path === '/api/journal/templates') {
      if (method === 'GET') return json({ templates: await listTemplates(env) });
      if (method === 'POST') {
        const body = await request.json() as any;
        if (!Array.isArray(body?.templates)) return json({ error: 'templates array is required' }, 400);
        return json({ templates: await saveTemplates(env, body.templates.slice(0, 30)) });
      }
    }

    if (path === '/api/journal/enrich') {
      if (method === 'GET') return json(await enrichEstimate(env));
      if (method === 'POST') return json(await enrichEntries(env));
    }

    // People
    if (path === '/api/journal/people') {
      if (method === 'GET') return json(await listPeople(env));
      if (method === 'POST') {
        const body = await request.json() as any;
        return json({ person: await upsertPerson(env, { name: body.name, aliases: body.aliases, circle: body.circle, note: body.note, id: body.id }) });
      }
    }
    if (method === 'GET' && path === '/api/journal/people/suggest') return json({ suggestions: await suggestPeople(env) });
    if (method === 'POST' && path === '/api/journal/people/rebuild') return json(await rebuildMentions(env));
    const person = path.match(/^\/api\/journal\/people\/([a-z0-9-]+)$/);
    if (person && method === 'GET') {
      const p = await getPerson(env, person[1]);
      return p ? json({ person: p }) : json({ error: 'Person not found' }, 404);
    }
    if (person && method === 'DELETE') { await deletePerson(env, person[1]); return json({ ok: true }); }

    // Daybook volumes
    if (method === 'GET' && path === '/api/journal/books') return json({ years: await bookYears(env) });

    // Nightly reminder
    if (method === 'GET' && path === '/api/journal/reminder') return json({ text: await buildReminder(env) });
    if (method === 'POST' && path === '/api/journal/reminder') return json(await sendNightlyReminder(env));

    // Backfill from Roam daily notes already stored in the wiki
    if (method === 'POST' && path === '/api/journal/import-wiki') {
      const body = await request.json().catch(() => ({})) as any;
      const r = await importJournalFromWiki(env, { offset: Number(body.offset) || 0, limit: Number(body.limit) || 60 });
      if (r.next_offset == null) await rebuildMentions(env);
      return json(r);
    }

    // Library (Roam knowledge pages into the wiki)
    if (method === 'POST' && path === '/api/journal/library') {
      const body = await request.json() as any;
      if (!Array.isArray(body?.pages)) return json({ error: 'pages array is required' }, 400);
      return json(await importLibrary(env, body.pages.slice(0, 100), { dryRun: !!body.dry_run }));
    }

    if (method === 'POST' && path === '/api/journal/ask') {
      const body = await request.json() as any;
      if (!body?.question) return json({ error: 'question is required' }, 400);
      return json(await askJournal(env, String(body.question).slice(0, 500)));
    }

    return json({ error: 'Not found' }, 404);
  } catch (e: any) {
    console.error('JOURNAL_ERROR', path, e?.message);
    return json({ error: e?.message || 'Journal error' }, 500);
  }
}

/** Cron: hourly Notion sync; Monday weekly insight; nightly reminder. */
export async function runJournalCron(cron: string, env: Env): Promise<void> {
  if (cron === '7 1 * * *') {
    await sendNightlyReminder(env).catch(e => console.error('JOURNAL_REMINDER', e?.message));
    return;
  }
  if (cron === '10 12 * * 1') {
    if (env.ANTHROPIC_API_KEY) await generateInsight(env, 'week').catch(e => console.error('JOURNAL_WEEKLY', e?.message));
    return;
  }
  if (env.NOTION_TOKEN) {
    const r = await syncJournalFromNotion(env, { bodyLimit: 25 }).catch(e => { console.error('JOURNAL_SYNC', e?.message); return null; });
    if (r) console.log('JOURNAL_SYNC', JSON.stringify(r));
  }
}
