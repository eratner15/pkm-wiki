/**
 * Daybook volumes: one printable book per year at /journal/book/:year.
 * Server-rendered HTML with print CSS (6 x 9 in pages). The browser's
 * "Save as PDF" produces the volume.
 */
import { Env } from './types';
import { ensureJournalSchema } from './journal';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Roam/markdown inline syntax to safe HTML. */
export function inline(s: string): string {
  let t = s
    .replace(/\{\{\[\[TODO\]\]\}\}/g, '☐').replace(/\{\{\[\[DONE\]\]\}\}/g, '☑')
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/\(\([\w-]{6,}\)\)/g, '')
    .replace(/#?\[\[\[\[([^\]]+)\]\]\s*\]\]/g, '$1')
    .replace(/#\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/^\s*\[[ x]\]\s*/i, m => (/x/i.test(m) ? '☑ ' : '☐ '));
  t = esc(t)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_]+)__/g, '<i>$1</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1');
  return t.replace(/https?:\/\/\S{30,}/g, u => u.slice(0, 40) + '…');
}

// Roam label blocks that the parser already turned into Rose / Thorn / Wins / Lesson / Next fields.
const FIELD_LABELS = /^(rose|thorn|bud)( of the day| for the day)?$|^(key )?wins?( for the day| for today| of the day)?$|^biggest wins$|^(key learning|key learning today|lesson|lessons|lesson of the day)$|^(\d+ )?goals for tomorrow\b|^actions? for tomorrow$/;

/** Indented bullets become nested lists; headings become small caps lines. */
export function notesToHtml(body: string): string {
  const out: string[] = [];
  const stack: number[] = [];
  const close = (to: number) => { while (stack.length && stack[stack.length - 1] >= to) { out.push('</li></ul>'); stack.pop(); } };
  let skipBelow = -1; // indent of a label block whose content is already shown as a field
  for (const raw of String(body || '').replace(/\r/g, '').split('\n')) {
    if (!raw.trim() || /^\s*---\s*$/.test(raw)) continue;
    const ind = (raw.match(/^(\s*)/)?.[1] || '').replace(/\t/g, '    ').length;
    if (skipBelow >= 0 && ind > skipBelow) continue;
    skipBelow = -1;
    const label = inline(raw.replace(/^\s*[-*+]\s+/, '')).replace(/<[^>]+>/g, '').replace(/[:\s]+$/, '').trim().toLowerCase();
    if (FIELD_LABELS.test(label)) { skipBelow = ind; continue; }
    if (/^day in review$/.test(label)) continue;
    const h = raw.match(/^#{1,6}\s+(.*)$/);
    if (h) { close(0); out.push(`<h5>${inline(h[1])}</h5>`); continue; }
    const b = raw.match(/^(\s*)[-*+]\s+(.*)$/);
    const indent = b ? b[1].replace(/\t/g, '    ').length : 0;
    const text = b ? b[2] : raw.trim();
    if (!text.trim() || !inline(text).trim()) continue;
    if (!b) { close(0); out.push(`<p>${inline(text)}</p>`); continue; }
    if (stack.length && indent <= stack[stack.length - 1]) {
      close(indent + 1);
      if (stack.length && stack[stack.length - 1] === indent) { out.push(`</li><li>${inline(text)}`); continue; }
      if (stack.length && stack[stack.length - 1] > indent) close(indent);
    }
    if (!stack.length || indent > stack[stack.length - 1]) { out.push(`<ul><li>${inline(text)}`); stack.push(indent); }
    else out.push(`</li><li>${inline(text)}`);
  }
  close(0);
  return out.join('');
}

export async function bookYears(env: Env): Promise<{ year: string; days: number }[]> {
  await ensureJournalSchema(env);
  const r = await env.DB.prepare(
    `SELECT substr(entry_date, 1, 4) AS year, COUNT(*) AS days FROM journal_entries GROUP BY year ORDER BY year`
  ).all();
  return (r.results || []) as any[];
}

export async function bookHTML(env: Env, year: string): Promise<string | null> {
  await ensureJournalSchema(env);
  if (!/^\d{4}$/.test(year)) return null;
  const rows = ((await env.DB.prepare(
    `SELECT * FROM journal_entries WHERE entry_date BETWEEN ? AND ? ORDER BY entry_date, id`
  ).bind(`${year}-01-01`, `${year}-12-31`).all()).results || []) as any[];
  if (!rows.length) return null;

  // People of the year, if the people index exists.
  let people: any[] = [];
  try {
    people = ((await env.DB.prepare(
      `SELECT p.name, COUNT(*) AS n FROM journal_mentions m JOIN journal_entries e ON e.id = m.entry_id
       JOIN journal_persons p ON p.id = m.person_id WHERE e.entry_date BETWEEN ? AND ? GROUP BY p.id ORDER BY n DESC LIMIT 10`
    ).bind(`${year}-01-01`, `${year}-12-31`).all()).results || []) as any[];
  } catch { /* no people index yet */ }

  const scored = rows.filter(r => r.day_score != null || r.mood != null);
  const val = (r: any) => (r.day_score != null ? r.day_score : r.mood);
  const avg = scored.length ? scored.reduce((s, r) => s + val(r), 0) / scored.length : null;
  const best = [...scored].sort((a, b) => val(b) - val(a)).slice(0, 5);
  const worst = [...scored].sort((a, b) => val(a) - val(b)).slice(0, 3);
  const lessons = rows.filter(r => r.lesson).slice(0, 14);
  const byMonth: any[][] = MONTHS.map(() => []);
  for (const r of rows) byMonth[Number(r.entry_date.slice(5, 7)) - 1].push(r);

  const dayLine = (r: any) => {
    const d = new Date(r.entry_date + 'T12:00:00Z');
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  };
  const field = (label: string, v: unknown, cls = '') => (v ? `<div class="f ${cls}"><span>${label}</span>${inline(String(v))}</div>` : '');
  const dayHTML = (r: any) => {
    const score = r.day_score != null ? `score ${r.day_score}` : r.mood != null ? `mood ${r.mood}` : '';
    return `<article class="day" id="d${r.entry_date}">
      <header><h4>${esc(dayLine(r))}</h4>${score ? `<span class="pill">${esc(score)}</span>` : ''}</header>
      ${r.summary ? `<p class="sum">${inline(r.summary)}</p>` : ''}
      ${field('Rose', r.rose, 'rose')}${field('Thorn', r.thorn, 'thorn')}${field('Bud', r.bud)}
      ${field('Wins', r.key_wins)}${field('Lesson', r.lesson)}${field('Next', r.next_action)}
      ${r.body ? `<div class="notes">${notesToHtml(r.body)}</div>` : ''}
    </article>`;
  };

  const months = byMonth.map((list, i) => {
    if (!list.length) return '';
    const ms = list.filter(r => r.mood != null || r.day_score != null);
    const mAvg = ms.length ? (ms.reduce((s, r) => s + val(r), 0) / ms.length).toFixed(1) : null;
    const themes: Record<string, number> = {};
    for (const r of list) if (r.rose_theme) themes[r.rose_theme] = (themes[r.rose_theme] || 0) + 1;
    const top = Object.entries(themes).sort((a, b) => b[1] - a[1]).slice(0, 3).map(t => t[0]).join(', ');
    return `<section class="month" id="m${i + 1}">
      <div class="month-head"><div class="kicker">${year}</div><h2>${MONTHS[i]}</h2>
      <p>${list.length} ${list.length === 1 ? 'day' : 'days'}${mAvg ? ` · average ${mAvg}` : ''}${top ? ` · roses from ${esc(top)}` : ''}</p></div>
      ${list.map(dayHTML).join('')}
    </section>`;
  }).join('');

  const toc = byMonth.map((l, i) => (l.length ? `<li><a href="#m${i + 1}">${MONTHS[i]}</a><span>${l.length}</span></li>` : '')).join('');
  const listDays = (list: any[]) => list.map(r => `<li><a href="#d${r.entry_date}">${esc(dayLine(r))}</a> <span class="pill">${esc(val(r))}</span><br><span class="muted">${inline(r.summary || r.rose || r.thorn || '')}</span></li>`).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Daybook ${year}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Instrument+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root { --ink: #1A1918; --dim: #6B6860; --faint: #9A9890; --rule: #E0DED8; --accent: #B8922F; --rose: #2E8A5C; --thorn: #B23A4A; --paper: #FFFFFF; --desk: #E9E7E1; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--desk); color: var(--ink); font-family: 'Instrument Sans', sans-serif; font-size: 10pt; line-height: 1.45; }
.bar { position: sticky; top: 0; background: var(--ink); color: #fff; padding: 10px 16px; display: flex; gap: 12px; align-items: center; justify-content: space-between; z-index: 2; font-size: 13px; }
.bar a, .bar button { color: #fff; background: none; border: 1px solid #555; border-radius: 6px; padding: 5px 10px; font: inherit; cursor: pointer; text-decoration: none; }
.bar button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.book { max-width: 6in; margin: 24px auto 80px; }
.page, .month { background: var(--paper); padding: 0.6in 0.55in 0.7in; margin-bottom: 18px; box-shadow: 0 2px 14px rgba(0,0,0,.12); }
.cover { min-height: 8.6in; display: flex; flex-direction: column; justify-content: space-between; }
.cover .kicker, .month-head .kicker { font-size: 8pt; letter-spacing: .2em; text-transform: uppercase; color: var(--accent); font-weight: 600; }
.cover h1 { font-family: 'Instrument Serif', serif; font-weight: 400; font-size: 64pt; line-height: .95; margin-top: 1.2in; }
.cover h1 em { color: var(--accent); }
.cover p { color: var(--dim); font-size: 10.5pt; max-width: 3.6in; }
h2 { font-family: 'Instrument Serif', serif; font-weight: 400; font-size: 34pt; line-height: 1; margin: 4px 0 6px; }
h3 { font-size: 8pt; letter-spacing: .14em; text-transform: uppercase; color: var(--dim); margin: 18px 0 6px; }
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 14px 0; }
.stats div { border-top: 2px solid var(--ink); padding-top: 6px; }
.stats b { display: block; font-family: 'Instrument Serif', serif; font-size: 26pt; font-weight: 400; line-height: 1; }
.stats span { font-size: 8pt; color: var(--dim); text-transform: uppercase; letter-spacing: .08em; }
ol.toc { list-style: none; columns: 2; }
ol.toc li { display: flex; justify-content: space-between; border-bottom: 1px dotted var(--rule); padding: 3px 0; break-inside: avoid; }
ol.toc a, .page a { color: inherit; text-decoration: none; }
ul.list { list-style: none; } ul.list li { padding: 5px 0; border-bottom: 1px solid var(--rule); }
.month-head { border-bottom: 1px solid var(--ink); padding-bottom: 8px; margin-bottom: 14px; }
.month-head p { color: var(--dim); font-size: 9pt; }
.day { padding: 10px 0 12px; border-bottom: 1px solid var(--rule); break-inside: avoid-page; }
.day header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.day h4 { font-family: 'Instrument Serif', serif; font-weight: 400; font-size: 15pt; }
.pill { font-size: 7.5pt; border: 1px solid var(--rule); border-radius: 9px; padding: 0 6px; color: var(--dim); white-space: nowrap; }
.sum { font-style: italic; color: var(--dim); margin: 2px 0 6px; }
.f { margin: 2px 0; } .f span { display: inline-block; width: 0.55in; font-size: 7.5pt; text-transform: uppercase; letter-spacing: .08em; color: var(--faint); }
.f.rose span { color: var(--rose); } .f.thorn span { color: var(--thorn); }
.notes { margin-top: 6px; font-size: 9pt; color: #333; }
.notes ul { padding-left: 1.1em; } .notes li { margin: 1px 0; } .notes p { margin: 3px 0; }
.notes h5 { font-size: 7.5pt; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); margin: 6px 0 2px; }
.muted { color: var(--dim); font-size: 9pt; }
@page { size: 6in 9in; margin: 0.55in 0.5in 0.6in; }
@media print {
  body { background: #fff; }
  .bar { display: none; }
  .book { max-width: none; margin: 0; }
  .page, .month { box-shadow: none; padding: 0; margin: 0; break-after: page; }
  .cover { min-height: 7.6in; }
  a { color: inherit; }
}
</style></head><body>
<div class="bar"><span>Daybook ${esc(year)} · ${rows.length} days</span><span><a href="/journal">Journal</a> <button class="primary" onclick="window.print()">Print or save as PDF</button></span></div>
<main class="book">
  <section class="page cover">
    <div class="kicker">Daybook · Volume ${esc(year)}</div>
    <h1>${esc(year)}<br><em>in days</em></h1>
    <p>${rows.length} days, from ${esc(dayLine(rows[0]))} to ${esc(dayLine(rows[rows.length - 1]))}. Roses, thorns, wins and lessons, in your own words.</p>
  </section>
  <section class="page">
    <div class="kicker">${esc(year)} at a glance</div><h2>The year</h2>
    <div class="stats"><div><b>${rows.length}</b><span>days written</span></div><div><b>${avg != null ? avg.toFixed(1) : '–'}</b><span>average mood</span></div><div><b>${rows.filter(r => r.rose).length}</b><span>roses</span></div></div>
    ${best.length ? `<h3>Best days</h3><ul class="list">${listDays(best)}</ul>` : ''}
    ${worst.length ? `<h3>Hardest days</h3><ul class="list">${listDays(worst)}</ul>` : ''}
    ${people.length ? `<h3>People of the year</h3><p>${people.map(p => `${esc(p.name)} <span class="muted">(${p.n})</span>`).join(' · ')}</p>` : ''}
    ${lessons.length ? `<h3>Lessons</h3><ul class="list">${lessons.map(r => `<li>${inline(r.lesson)} <span class="muted">${esc(r.entry_date.slice(5))}</span></li>`).join('')}</ul>` : ''}
    <h3>Contents</h3><ol class="toc">${toc}</ol>
  </section>
  ${months}
</main></body></html>`;
}
