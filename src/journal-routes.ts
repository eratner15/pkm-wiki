import { Env } from './types';
import {
  askJournal, captureEntry, generateInsight, getEntry, getInsight, importEntries, InsightPeriod,
  journalStats, listEntries, syncJournalFromNotion,
} from './journal';
import { journalPageHTML } from './journal-page';

const PERIODS: InsightPeriod[] = ['week', 'month', 'quarter', 'all'];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Handles /journal and /api/journal/*. Returns null for paths it does not own. */
export async function handleJournalRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname.replace(/\/$/, '') || '/';
  const method = request.method;

  if (method === 'GET' && path === '/journal') {
    return new Response(journalPageHTML(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
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
      return json(await captureEntry(env, {
        text: body.text.slice(0, 20_000),
        date: body.date,
        day_score: score != null && score >= 1 && score <= 10 ? score : null,
        energy: ['High', 'Medium', 'Low'].includes(body.energy) ? body.energy : null,
      }));
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
      return json(await importEntries(env, body.entries.slice(0, 500)));
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

/** Cron: hourly Notion sync; Monday weekly insight. */
export async function runJournalCron(cron: string, env: Env): Promise<void> {
  if (cron === '10 12 * * 1') {
    if (env.ANTHROPIC_API_KEY) await generateInsight(env, 'week').catch(e => console.error('JOURNAL_WEEKLY', e?.message));
    return;
  }
  if (env.NOTION_TOKEN) {
    const r = await syncJournalFromNotion(env, { bodyLimit: 25 }).catch(e => { console.error('JOURNAL_SYNC', e?.message); return null; });
    if (r) console.log('JOURNAL_SYNC', JSON.stringify(r));
  }
}
