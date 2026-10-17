/**
 * The keepsake book at /journal/keepsake: one printable volume for every year, laid out
 * for a 210 x 280 mm (8 x 11 in) portrait hardcover. On screen it is a review copy with
 * edit controls; printed (or saved as PDF) it is the book.
 */
import { Env } from './types';
import { esc, inline, notesToHtml } from './journal-book';
import { getKeepsake, keepsakeEstimate, KeepsakeState, loadEntries } from './journal-keepsake';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MAX_NOTES_CHARS = 6000;

const longDate = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayTitle = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const shortDate = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' });
const paras = (s: string) => String(s || '').split(/\n{2,}|\n(?=\S)/).map(p => p.trim()).filter(Boolean).map(p => `<p>${esc(p)}</p>`).join('');

async function loadPeopleIndex(env: Env) {
  try {
    return ((await env.DB.prepare(
      `SELECT p.name, GROUP_CONCAT(e.entry_date, ',') AS dates, COUNT(*) AS n
       FROM journal_mentions m JOIN journal_persons p ON p.id = m.person_id JOIN journal_entries e ON e.id = m.entry_id
       GROUP BY p.id ORDER BY p.name COLLATE NOCASE`
    ).all()).results || []) as any[];
  } catch { return []; }
}

/** Cut very long notes at a line break so one day cannot fill many pages. */
function trimNotes(body: string): { text: string; cut: boolean } {
  if (!body || body.length <= MAX_NOTES_CHARS) return { text: body || '', cut: false };
  const at = body.lastIndexOf('\n', MAX_NOTES_CHARS);
  return { text: body.slice(0, at > 2000 ? at : MAX_NOTES_CHARS), cut: true };
}

export async function keepsakeHTML(env: Env): Promise<string> {
  const k = await getKeepsake(env);
  const entries = await loadEntries(env);
  if (!k.years) return setupHTML(await keepsakeEstimate(env));
  const people = await loadPeopleIndex(env);
  return bookHTML(k, entries, people);
}

export function bookHTML(k: KeepsakeState, entries: any[], people: any[]): string {
  const byId = new Map(entries.map(e => [e.id, e]));
  const edits = k.edits || {};
  const excluded = new Set(edits.excluded || []);
  const years = k.years!.data.years;
  const c = k.connections?.data;
  const first = entries[0]?.entry_date || '', last = entries[entries.length - 1]?.entry_date || '';
  const span = first && last ? `${first.slice(0, 4)}–${last.slice(0, 4)}` : '';
  const title = edits.title || c?.title_options?.[0] || 'The Daybook';
  const subtitle = edits.subtitle || `Five years in my own words, ${span}`;
  const quote = (q: { entry_id: string; text: string }) => {
    const e = byId.get(q.entry_id);
    return `<blockquote><p>${esc(q.text)}</p><cite>${e ? esc(longDate(e.entry_date)) : ''}</cite></blockquote>`;
  };
  const byDate = <T extends { entry_id: string }>(list: T[]) => [...list].sort((a, b) => (byId.get(a.entry_id)?.entry_date || '').localeCompare(byId.get(b.entry_id)?.entry_date || ''));

  // Five years at a glance: days written per month, roses, people.
  const yearsList = [...new Set(entries.map(e => e.entry_date.slice(0, 4)))].sort();
  const perMonth = new Map<string, number>();
  for (const e of entries) perMonth.set(e.entry_date.slice(0, 7), (perMonth.get(e.entry_date.slice(0, 7)) || 0) + 1);
  const maxMonth = Math.max(1, ...perMonth.values());
  const grid = yearsList.map(y => {
    const total = entries.filter(e => e.entry_date.startsWith(y)).length;
    const cells = MONTHS.map((m, i) => {
      const n = perMonth.get(`${y}-${String(i + 1).padStart(2, '0')}`) || 0;
      const a = n ? 0.12 + 0.88 * (n / maxMonth) : 0;
      return `<span class="cell" style="--a:${a.toFixed(2)}" title="${m} ${y}: ${n} days">${n || ''}</span>`;
    }).join('');
    return `<div class="grow"><b>${y}</b>${cells}<i>${total}</i></div>`;
  }).join('');
  const words = entries.reduce((s, e) => s + String(e.body || '').split(/\s+/).filter(Boolean).length, 0);
  const roses = entries.filter(e => e.rose);
  const topPeople = [...people].sort((a, b) => b.n - a.n).slice(0, 10);
  const maxP = Math.max(1, ...topPeople.map(p => p.n));

  const toc: string[] = [];
  const part = (id: string, label: string) => { toc.push(`<li><a href="#${id}">${esc(label)}</a></li>`); return id; };

  const letter = c?.letter ? `<section class="sheet prose" id="${part('letter', 'A letter to you')}"><div class="kicker">A letter to you</div>${paras(c.letter)}</section>` : '';

  const glance = `<section class="sheet" id="${part('glance', 'Five years at a glance')}">
    <div class="kicker">Five years at a glance</div><h2>The shape of it</h2>
    <div class="stats"><div><b>${entries.length}</b><span>days written</span></div><div><b>${words.toLocaleString('en-US')}</b><span>words</span></div><div><b>${roses.length}</b><span>roses</span></div><div><b>${people.length}</b><span>people</span></div></div>
    <h3>Days written, by month</h3>
    <div class="grid"><div class="grow head"><b></b>${MONTHS.map(m => `<span>${m[0]}</span>`).join('')}<i>Total</i></div>${grid}</div>
    ${topPeople.length ? `<h3>Who appears most</h3><div class="bars">${topPeople.map(p => `<div class="bar"><span>${esc(p.name)}</span><div><i style="width:${(100 * p.n / maxP).toFixed(1)}%"></i></div><b>${p.n}</b></div>`).join('')}</div>` : ''}
  </section>`;

  const threads = c?.threads?.length ? `<section class="sheet opener" id="${part('threads', 'Threads')}"><div class="kicker">Part one</div><h1>Threads</h1><p class="lede">What kept coming back.</p></section>
    ${c.threads.map(t => `<section class="sheet piece"><h2>${esc(t.title)}</h2><div class="prose">${paras(t.essay)}</div>${byDate(t.quotes).map(quote).join('')}</section>`).join('')}` : '';

  const peoplePart = c?.people?.length ? `<section class="sheet opener" id="${part('people', 'People')}"><div class="kicker">Part two</div><h1>People</h1><p class="lede">Who was there.</p></section>
    ${c.people.map(p => {
      const row = people.find(x => x.name.toLowerCase() === p.name.toLowerCase());
      const ds = row ? String(row.dates).split(',').sort() : [];
      return `<section class="sheet piece"><h2>${esc(p.name)}</h2>${row ? `<p class="meta">${row.n} days · first ${esc(longDate(ds[0]))} · last ${esc(longDate(ds[ds.length - 1]))}</p>` : ''}<div class="prose">${paras(p.essay)}</div>${byDate(p.quotes).map(quote).join('')}</section>`;
    }).join('')}` : '';

  const yearParts = years.map((y, i) => {
    const days = y.days.filter(d => byId.has(d.entry_id))
      .sort((a, b) => byId.get(a.entry_id).entry_date.localeCompare(byId.get(b.entry_id).entry_date));
    const dayHTML = days.map(d => {
      const e = byId.get(d.entry_id);
      const out = excluded.has(e.id);
      const notes = trimNotes(e.body);
      const f = (label: string, v: unknown, cls = '') => (v ? `<div class="f ${cls}"><span>${label}</span><div>${inline(String(v))}</div></div>` : '');
      return `<article class="day${out ? ' out' : ''}" data-id="${esc(e.id)}">
        <header><h4>${esc(dayTitle(e.entry_date))}</h4><span class="yr">${e.entry_date.slice(0, 4)}</span>
          <button class="toggle screen" onclick="toggleDay('${esc(e.id)}', this)">${out ? 'Put back in the book' : 'Remove from book'}</button></header>
        ${d.why ? `<p class="why">${esc(d.why)}</p>` : ''}
        ${f('Rose', e.rose, 'rose')}${f('Thorn', e.thorn, 'thorn')}${f('Wins', e.key_wins)}${f('Lesson', e.lesson)}
        ${notes.text ? `<div class="notes">${notesToHtml(notes.text)}${notes.cut ? '<p class="cut">The rest of this day stays in the journal.</p>' : ''}</div>` : ''}
      </article>`;
    }).join('');
    return `<section class="sheet opener" id="${part(`y${i}`, `${y.year}: ${y.title}`)}"><div class="kicker">${esc(y.year)}</div><h1>${esc(y.title)}</h1></section>
      <section class="sheet prose">${paras(y.essay)}
        ${y.months?.length ? `<h3>Month by month</h3><dl class="months">${y.months.map(m => `<dt>${esc(MONTHS[Number(m.month.slice(5, 7)) - 1] || m.month)}${y.year.length > 4 ? ` ${esc(m.month.slice(0, 4))}` : ''}</dt><dd>${esc(m.line)}</dd>`).join('')}</dl>` : ''}
        ${y.quotes?.length ? `<h3>Lines worth keeping</h3>${byDate(y.quotes).map(quote).join('')}` : ''}
      </section>
      <section class="sheet days">${dayHTML}</section>`;
  }).join('');

  const echoes = c?.echoes?.length ? `<section class="sheet opener" id="${part('echoes', 'Echoes')}"><div class="kicker">Part four</div><h1>Echoes</h1><p class="lede">Moments that answer each other across the years.</p></section>
    <section class="sheet">${c.echoes.map(e => `<div class="echo"><h3>${esc(e.title)}</h3><div class="pair">${quote(e.first)}${quote(e.second)}</div><p class="note">${esc(e.note)}</p></div>`).join('')}</section>` : '';

  const roseLedger = roses.length ? `<section class="sheet" id="${part('roses', 'Every rose')}"><div class="kicker">Ledger</div><h2>Every rose</h2>
    <ol class="ledger">${roses.map(e => `<li><span>${esc(shortDate(e.entry_date))}</span>${inline(String(e.rose).replace(/\n+/g, ' · '))}</li>`).join('')}</ol></section>` : '';

  const questions = c?.questions?.length ? `<section class="sheet prose" id="${part('questions', 'For the next five years')}"><div class="kicker">For the next five years</div><h2>Questions to carry</h2><ol class="questions">${c.questions.map(q => `<li>${esc(q)}</li>`).join('')}</ol></section>` : '';

  const index = people.length ? `<section class="sheet" id="${part('index', 'Index of people')}"><div class="kicker">Index</div><h2>People and their days</h2>
    <dl class="index">${people.map(p => `<dt>${esc(p.name)} <span>${p.n}</span></dt><dd>${String(p.dates).split(',').sort().map(shortDate).join(', ')}</dd>`).join('')}</dl></section>` : '';

  const dedication = edits.dedication ? `<section class="sheet dedication"><p>${esc(edits.dedication).replace(/\n/g, '<br>')}</p></section>` : '';
  const pending = !c ? `<div class="notice screen">The threads, people, echoes and letter are not written yet. <button onclick="writeStep('connections', this)">Write them with Claude</button></div>` : '';
  const dropped = (k.years?.dropped_quotes || 0) + (k.connections?.dropped_quotes || 0);

  return page(`${title}`, `
<div class="toolbar screen">
  <div><b>Review copy</b> · ${entries.length} days · ${years.reduce((s, y) => s + y.days.filter(d => byId.has(d.entry_id) && !excluded.has(d.entry_id)).length, 0)} printed in full${dropped ? ` · ${dropped} ${dropped === 1 ? 'quote' : 'quotes'} removed because they did not match your notes` : ''}</div>
  <div class="actions">
    <button onclick="document.getElementById('edit').showModal()">Edit title and dedication</button>
    <button onclick="if(confirm('Write the year chapters again? This replaces them and costs about half the original run.')) writeStep('years', this)">Rewrite years</button>
    ${c ? `<button onclick="if(confirm('Write the threads, people, echoes and letter again?')) writeStep('connections', this)">Rewrite connections</button>` : ''}
    <button class="primary" onclick="window.print()">Print or save as PDF</button>
  </div>
</div>
<p class="hint screen">Size 210 × 280 mm (8 × 11 in). In the print dialog, turn on background graphics and set margins to Default. Gelato prints 30 to 200 pages.</p>
${pending}
<dialog id="edit"><form method="dialog" onsubmit="saveEdits(event)">
  <h3>Title and dedication</h3>
  <label>Title<input name="k_title" value="${esc(title)}"></label>
  ${c?.title_options?.length ? `<p class="opts">Ideas: ${c.title_options.map(t => `<a href="#" onclick="this.closest('form').elements.k_title.value=this.textContent;return false">${esc(t)}</a>`).join(' · ')}</p>` : ''}
  <label>Subtitle<input name="k_subtitle" value="${esc(subtitle)}"></label>
  <label>Dedication<textarea name="k_dedication" rows="4">${esc(edits.dedication || '')}</textarea></label>
  <div class="actions"><button value="cancel" formnovalidate>Cancel</button><button class="primary">Save</button></div>
</form></dialog>
<main class="book">
  <section class="sheet cover"><div class="kicker">${esc(span)}</div><h1 class="title">${esc(title)}</h1><p class="sub">${esc(subtitle)}</p></section>
  ${dedication}
  <section class="sheet contents"><div class="kicker">Contents</div><ol class="toc">${toc.join('')}</ol></section>
  ${letter}${glance}${threads}${peoplePart}
  ${years.length ? `<section class="sheet opener"><div class="kicker">Part three</div><h1>The years</h1><p class="lede">${years.length} chapters, with the days that carried them.</p></section>` : ''}
  ${yearParts}${echoes}${roseLedger}${questions}${index}
  <section class="sheet colophon"><p>${entries.length} days of notes, ${esc(longDate(first))} to ${esc(longDate(last))}, kept in Roam and gathered in the Living Journal. Chapters and connections drafted with Claude from those notes; every quotation is the writer's own words.</p></section>
</main>`);
}

function setupHTML(est: { days: number; corpus_tokens: number; estimated_cost_usd: number; model: string }): string {
  return page('Keepsake', `
<main class="setup">
  <div class="kicker">Keepsake</div>
  <h1 class="title">Five years, one book</h1>
  <p>Claude reads all ${est.days} days once and drafts the book: a chapter for each year with the days to print in full, the threads that run across years, the people, moments that echo each other, and a letter to you. Every quotation is checked against your notes word for word.</p>
  <p>It runs in two steps of a few minutes each. Estimated cost: <b>about $${est.estimated_cost_usd.toFixed(2)}</b> (${est.corpus_tokens.toLocaleString('en-US')} tokens of notes, read twice with caching).</p>
  <p><button class="primary" onclick="writeAll(this)">Write the book with Claude</button> <a href="/journal">Back to the journal</a></p>
  <p id="status" class="hint"></p>
</main>`);
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Instrument+Sans:wght@400;500;600&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400&display=swap" rel="stylesheet">
<style>
:root { --ink: #1C1B19; --dim: #5F5C55; --faint: #8F8C84; --rule: #DDDAD2; --accent: #9C7A2B; --rose: #2E7A55; --thorn: #A23646; --paper: #FFFFFF; --desk: #E6E3DC; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--desk); color: var(--ink); font-family: 'Newsreader', Georgia, serif; font-size: 11pt; line-height: 1.5; }
button { font: 500 13px 'Instrument Sans', sans-serif; border: 1px solid #bbb; background: #fff; border-radius: 6px; padding: 6px 12px; cursor: pointer; color: var(--ink); }
button.primary { background: var(--ink); color: #fff; border-color: var(--ink); }
button:disabled { opacity: .5; cursor: progress; }
.toolbar { position: sticky; top: 0; z-index: 3; background: var(--ink); color: #fff; padding: 10px 16px; display: flex; flex-wrap: wrap; gap: 10px; justify-content: space-between; align-items: center; font: 13px 'Instrument Sans', sans-serif; }
.toolbar .actions { display: flex; flex-wrap: wrap; gap: 6px; }
.toolbar button { background: transparent; color: #fff; border-color: #666; }
.toolbar button.primary { background: var(--accent); border-color: var(--accent); }
.hint { font: 12px 'Instrument Sans', sans-serif; color: var(--dim); text-align: center; margin: 10px 16px; }
.notice { max-width: 210mm; margin: 12px auto; background: #FFF8E6; border: 1px solid #E8D9A8; padding: 10px 14px; border-radius: 8px; font: 13px 'Instrument Sans', sans-serif; display: flex; gap: 10px; align-items: center; justify-content: space-between; }
dialog { border: none; border-radius: 12px; padding: 20px; width: min(520px, 92vw); font-family: 'Instrument Sans', sans-serif; }
dialog label { display: block; font-size: 12px; color: var(--dim); margin: 10px 0 0; }
dialog input, dialog textarea { display: block; width: 100%; font: 15px 'Newsreader', serif; padding: 6px 8px; border: 1px solid var(--rule); border-radius: 6px; margin-top: 4px; }
dialog .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
dialog .opts { font-size: 12px; margin-top: 6px; } dialog .opts a { color: var(--accent); }
.book { width: 210mm; max-width: 100%; margin: 16px auto 80px; }
.sheet { background: var(--paper); padding: 22mm 20mm 24mm 24mm; margin-bottom: 14px; box-shadow: 0 2px 14px rgba(0,0,0,.12); }
.kicker { font: 600 8pt 'Instrument Sans', sans-serif; letter-spacing: .22em; text-transform: uppercase; color: var(--accent); margin-bottom: 6mm; }
h1, h2, .title { font-family: 'Instrument Serif', serif; font-weight: 400; }
h1 { font-size: 46pt; line-height: 1; }
h2 { font-size: 26pt; line-height: 1.05; margin-bottom: 5mm; }
h3 { font: 600 8pt 'Instrument Sans', sans-serif; letter-spacing: .16em; text-transform: uppercase; color: var(--dim); margin: 8mm 0 3mm; }
.cover { min-height: 280mm; display: flex; flex-direction: column; justify-content: center; text-align: center; }
.cover .title { font-size: 60pt; line-height: .98; margin: 6mm 0; }
.cover .sub { font-style: italic; color: var(--dim); font-size: 14pt; }
.dedication { min-height: 200mm; display: flex; align-items: center; justify-content: center; text-align: center; font-style: italic; font-size: 14pt; color: var(--dim); }
.opener { min-height: 200mm; display: flex; flex-direction: column; justify-content: flex-end; padding-bottom: 50mm; }
.opener .lede { font-style: italic; color: var(--dim); font-size: 14pt; margin-top: 4mm; }
.prose p { margin: 0 0 3.5mm; text-align: justify; hyphens: auto; }
.prose > p:first-of-type::first-letter { font-family: 'Instrument Serif', serif; float: left; font-size: 40pt; line-height: .8; margin: 2mm 2mm 0 0; color: var(--accent); }
.meta { font: 9pt 'Instrument Sans', sans-serif; color: var(--faint); margin: -3mm 0 5mm; }
blockquote { margin: 5mm 0 5mm 8mm; padding-left: 5mm; border-left: 2px solid var(--accent); break-inside: avoid; }
blockquote p { font-style: italic; font-size: 12pt; }
blockquote cite { display: block; font: normal 8pt 'Instrument Sans', sans-serif; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); margin-top: 1.5mm; }
ol.toc { list-style: none; font-size: 13pt; } ol.toc li { padding: 2.2mm 0; border-bottom: 1px solid var(--rule); } ol.toc a { color: inherit; text-decoration: none; }
.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5mm; margin: 4mm 0 2mm; }
.stats div { border-top: 2px solid var(--ink); padding-top: 2mm; }
.stats b { display: block; font: 400 26pt 'Instrument Serif', serif; line-height: 1; }
.stats span { font: 8pt 'Instrument Sans', sans-serif; color: var(--dim); text-transform: uppercase; letter-spacing: .08em; }
.grid { font: 8pt 'Instrument Sans', sans-serif; }
.grow { display: grid; grid-template-columns: 12mm repeat(12, 1fr) 12mm; gap: 1.2mm; align-items: center; margin-bottom: 1.2mm; }
.grow b { font-weight: 600; } .grow i { font-style: normal; text-align: right; color: var(--dim); }
.grow.head span { text-align: center; color: var(--faint); }
.cell { height: 9mm; border-radius: 1.5mm; background: rgba(156, 122, 43, var(--a)); border: 1px solid var(--rule); display: flex; align-items: center; justify-content: center; font-size: 7pt; color: var(--ink); }
.bars { font: 9pt 'Instrument Sans', sans-serif; }
.bar { display: grid; grid-template-columns: 34mm 1fr 10mm; gap: 3mm; align-items: center; margin: 1.6mm 0; }
.bar div { background: #F1EFEA; height: 4mm; border-radius: 1mm; } .bar div i { display: block; height: 100%; background: var(--accent); border-radius: 1mm; }
.bar b { text-align: right; font-weight: 500; }
dl.months { display: grid; grid-template-columns: 26mm 1fr; gap: 1.6mm 4mm; font-size: 10.5pt; }
dl.months dt { font: 600 8pt 'Instrument Sans', sans-serif; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); padding-top: 1mm; }
.day { padding: 6mm 0; border-bottom: 1px solid var(--rule); break-inside: avoid-page; }
.day header { display: flex; align-items: baseline; gap: 3mm; }
.day h4 { font: 400 17pt 'Instrument Serif', serif; }
.day .yr { font: 8pt 'Instrument Sans', sans-serif; color: var(--faint); letter-spacing: .1em; }
.day .toggle { margin-left: auto; font-size: 11px; padding: 3px 8px; }
.day.out { opacity: .35; } .day.out .toggle { opacity: 1; }
.why { font-style: italic; color: var(--dim); margin: 1mm 0 3mm; }
.f { display: grid; grid-template-columns: 16mm 1fr; gap: 3mm; margin: 1.2mm 0; }
.f span { font: 600 7.5pt 'Instrument Sans', sans-serif; text-transform: uppercase; letter-spacing: .1em; color: var(--faint); padding-top: 1mm; }
.f.rose span { color: var(--rose); } .f.thorn span { color: var(--thorn); }
.notes { margin-top: 3mm; font-size: 10pt; color: #2C2B28; }
.notes ul { padding-left: 5mm; } .notes li { margin: .6mm 0; } .notes p { margin: 1.5mm 0; }
.notes h5 { font: 600 7.5pt 'Instrument Sans', sans-serif; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); margin: 3mm 0 1mm; }
.cut { font-style: italic; color: var(--faint); }
.echo { padding: 4mm 0 6mm; border-bottom: 1px solid var(--rule); break-inside: avoid; }
.echo h3 { margin-top: 2mm; color: var(--ink); }
.echo .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; }
.echo .pair blockquote { margin: 0; }
.echo .note { font-size: 10.5pt; color: var(--dim); margin-top: 2mm; }
ol.ledger { list-style: none; columns: 2; column-gap: 8mm; font-size: 9.5pt; }
ol.ledger li { break-inside: avoid; padding: 1.4mm 0; border-bottom: 1px solid #EEECE6; }
ol.ledger span, dl.index dt span { font: 7.5pt 'Instrument Sans', sans-serif; color: var(--faint); margin-right: 2mm; }
ol.questions { padding-left: 6mm; font-size: 13pt; } ol.questions li { margin: 0 0 4mm; padding-left: 2mm; }
dl.index { font-size: 9pt; columns: 2; column-gap: 8mm; }
dl.index dt { font-weight: 500; break-after: avoid; margin-top: 2.5mm; }
dl.index dd { color: var(--dim); font-size: 8pt; break-inside: avoid; }
.colophon { min-height: 120mm; display: flex; align-items: flex-end; font-size: 9.5pt; color: var(--dim); font-style: italic; }
.setup { max-width: 640px; margin: 10vh auto; padding: 0 16px; }
.setup p { margin: 4mm 0; font-size: 13pt; } .setup .title { font-size: 44pt; line-height: 1; }
.setup a { color: var(--dim); font: 13px 'Instrument Sans', sans-serif; margin-left: 10px; }
@media (max-width: 820px) {
  .sheet { padding: 14mm 8mm; } .cover .title { font-size: 40pt; } h1 { font-size: 34pt; }
  .stats { grid-template-columns: repeat(2, 1fr); } .echo .pair { grid-template-columns: 1fr; } ol.ledger, dl.index { columns: 1; }
}
@page { size: 210mm 280mm; margin: 20mm 18mm 22mm 22mm;
  @bottom-center { content: counter(page); font: 8pt 'Instrument Sans', sans-serif; color: #8F8C84; } }
@page :left { margin: 20mm 22mm 22mm 18mm; }
@page :first { @bottom-center { content: none; } }
@media print {
  body { background: #fff; }
  .screen { display: none !important; }
  .book { width: auto; margin: 0; }
  .sheet { box-shadow: none; padding: 0; margin: 0; break-after: page; }
  .sheet.days { break-after: page; }
  .cover { min-height: 236mm; } .opener { min-height: 236mm; padding-bottom: 40mm; } .dedication { min-height: 236mm; }
  .day.out { display: none; }
  a { color: inherit; text-decoration: none; }
}
</style></head><body>${body}
<script>
async function api(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(function () { return {}; });
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
async function writeStep(step, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Writing… a few minutes'; }
  try { await api('/api/journal/keepsake/write', { step: step }); location.reload(); }
  catch (e) { alert('Could not write ' + step + ': ' + e.message); if (btn) { btn.disabled = false; btn.textContent = 'Try again'; } }
}
async function writeAll(btn) {
  const s = document.getElementById('status');
  btn.disabled = true;
  let yearsDone = false;
  try {
    s.textContent = 'Step 1 of 2: reading every day and writing the year chapters. This takes a few minutes.';
    await api('/api/journal/keepsake/write', { step: 'years' });
    yearsDone = true;
    s.textContent = 'Step 2 of 2: finding threads, people, echoes, and writing your letter.';
    await api('/api/journal/keepsake/write', { step: 'connections' });
    location.reload();
  } catch (e) {
    if (yearsDone) { location.reload(); return; }
    s.textContent = 'Stopped: ' + e.message + '. Press the button to try again.'; btn.disabled = false;
  }
}
async function toggleDay(id, btn) {
  const day = btn.closest('.day');
  const out = !day.classList.contains('out');
  btn.disabled = true;
  try { await api('/api/journal/keepsake/edits', out ? { exclude: id } : { include: id }); day.classList.toggle('out', out); btn.textContent = out ? 'Put back in the book' : 'Remove from book'; }
  catch (e) { alert(e.message); }
  btn.disabled = false;
}
async function saveEdits(ev) {
  const f = ev.target;
  if (ev.submitter && ev.submitter.value === 'cancel') return;
  ev.preventDefault();
  try { await api('/api/journal/keepsake/edits', { title: f.elements.k_title.value, subtitle: f.elements.k_subtitle.value, dedication: f.elements.k_dedication.value }); location.reload(); }
  catch (e) { alert(e.message); }
}
</script></body></html>`;
}
