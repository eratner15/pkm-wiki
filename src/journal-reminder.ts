/**
 * Nightly journal reminder over the existing Telegram bot, plus filing replies.
 * The reminder carries "on this day" entries from past years and open next actions.
 * A reply to the reminder (or "/j <text>") is filed as that day's entry.
 */
import { Env } from './types';
import { captureEntry, ensureJournalSchema, todayLocal } from './journal';
import { rebuildMentions } from './journal-people';
import { highlightOfTheDay } from './journal-reading';

const MARK = 'Evening check-in';

function short(s: unknown, n = 160): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').replace(/\[\[|\]\]|#\[\[|\{\{[^}]*\}\}|\(\([\w-]+\)\)/g, '').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

export async function buildReminder(env: Env, today = todayLocal()): Promise<string> {
  await ensureJournalSchema(env);
  const [past, logged, actions] = await env.DB.batch([
    env.DB.prepare(
      `SELECT entry_date, summary, rose, thorn, lesson, notable FROM journal_entries
       WHERE substr(entry_date, 6) = ? AND entry_date < ? ORDER BY entry_date DESC LIMIT 5`
    ).bind(today.slice(5), today),
    env.DB.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE entry_date = ?').bind(today),
    env.DB.prepare(
      `SELECT entry_date, next_action FROM journal_entries WHERE next_action IS NOT NULL AND entry_date >= date(?, '-7 days')
       ORDER BY entry_date DESC LIMIT 4`
    ).bind(today),
  ]);
  const day = new Date(today + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const lines = [`${MARK}, ${day}.`];
  lines.push(((logged.results?.[0] as any)?.n || 0) > 0
    ? 'Today is already logged. Reply to add more.'
    : 'Reply to this message with your day: rose, thorn, bud, wins. I file it as today’s entry.');

  const otd = (past.results || []) as any[];
  if (otd.length) {
    lines.push('', 'On this day:');
    for (const e of otd) {
      const what = e.rose ? `Rose: ${e.rose}` : e.summary || e.notable || e.thorn || e.lesson;
      lines.push(`• ${e.entry_date.slice(0, 4)}: ${short(what)}`);
      if (e.lesson) lines.push(`  Lesson: ${short(e.lesson, 120)}`);
    }
  }
  const open = (actions.results || []) as any[];
  if (open.length) {
    lines.push('', 'Open next actions:');
    for (const a of open) lines.push(`• ${short(a.next_action, 120)} (${a.entry_date.slice(5)})`);
  }
  const hl = await highlightOfTheDay(env, today).catch(() => null);
  if (hl) lines.push('', 'From your library:', `“${short(hl.text, 280)}”`, `— ${hl.title}${hl.author ? `, ${hl.author}` : ''}`);
  lines.push('', 'Journal: https://pkm.cafecito-ai.com/journal');
  return lines.join('\n');
}

async function telegram(env: Env, method: string, body: unknown): Promise<any> {
  const token = (env as any).TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json() as any;
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
  return data.result;
}

export async function sendNightlyReminder(env: Env): Promise<{ sent: boolean; text: string }> {
  const chat = (env as any).TELEGRAM_CHAT_ID;
  const text = await buildReminder(env);
  if (!chat) return { sent: false, text };
  await telegram(env, 'sendMessage', { chat_id: chat, text, disable_web_page_preview: true });
  return { sent: true, text };
}

/**
 * Telegram webhook hook. Returns a reply when the message is a journal entry
 * (a reply to the reminder, or "/j …"), "/onthisday", or null to let the
 * existing wiki handling run.
 */
export async function handleTelegramJournal(env: Env, message: any): Promise<string | null> {
  const text = String(message?.text || '').trim();
  if (text === '/onthisday') return buildReminder(env);

  const replyTo = String(message?.reply_to_message?.text || '');
  const isReply = replyTo.startsWith(MARK) && message?.reply_to_message?.from?.is_bot;
  const cmd = text.match(/^\/j(?:ournal)?(?:@\w+)?\s+([\s\S]+)/);
  if (!isReply && !cmd) return null;

  const entryText = cmd ? cmd[1] : text;
  const date = todayLocal(new Date((message?.date || Date.now() / 1000) * 1000));
  try {
    const r = await captureEntry(env, { text: entryText, date });
    await rebuildMentions(env).catch(() => null);
    const e = r.entry || {};
    const parts = [`Filed for ${date}.`];
    if (e.rose) parts.push(`Rose: ${short(e.rose, 100)}`);
    if (e.thorn) parts.push(`Thorn: ${short(e.thorn, 100)}`);
    if (r.missing?.length) parts.push(`Missing: ${r.missing.map((m: string) => m.replace('_', ' ')).join(', ')}. Reply again to add them.`);
    if (r.suggest_template) parts.push(`This thorn repeats. Try the ${r.suggest_template} on /journal.`);
    return parts.join('\n');
  } catch (err: any) {
    return `Could not file the entry: ${err?.message || err}. Your text is safe here; send it again later.`;
  }
}
