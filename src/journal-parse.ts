/**
 * Markdown journal parser. Runs in the browser (the /journal page injects
 * parseJournalMarkdown.toString()), so it must stay self-contained: no imports,
 * no references to anything outside the function body.
 *
 * Accepts any mix of:
 *   - Roam daily-note files named by date ("July 20th, 2021.md")
 *   - One large file with a heading per day ("## Tue, Jul 20, 2021")
 *   - Labelled fields: "Rose:: …" (Roam attribute), "**Rose:** …", "- Rose: …",
 *     a label line with nested bullets, a "### Goals for tomorrow" heading,
 *     or a "| Rose | … |" table row
 * Sections without a date are returned as `undated`; ones titled "Template" are
 * returned as `templates`.
 */

export interface ParsedEntry {
  id: string;
  date: string;
  title: string;
  body: string;
  [field: string]: unknown;
}

export interface ParseResult {
  entries: ParsedEntry[];
  templates: { name: string; body: string }[];
  undated: { title: string; chars: number }[];
}

export function parseJournalMarkdown(files: { name: string; text: string }[]): ParseResult {
  const MONTHS: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  };
  const LABELS: [string, RegExp][] = [
    ['rose_theme', /^rose[ _]theme$/],
    ['thorn_theme', /^thorn[ _]theme$/],
    ['thorn_cause', /^thorn[ _]cause$/],
    ['rose', /^(rose|roses?|rose of the day|rose for the day|best moment)$/],
    ['thorn', /^(thorn|thorns?|thorn of the day|thorn for the day|worst moment|hardest moment)$/],
    ['bud', /^(bud|looking forward to|something to look forward to)$/],
    ['key_wins', /^(key wins|wins|big wins|biggest wins|win|wins of the day|wins for the day|win for today|wins for today|win of the day)$/],
    ['lesson', /^(lesson|lessons|lesson learned|lessons learned|learned|what i learned|key learning|key learning today|key learnings|lesson of the day)$/],
    ['next_action', /^(next action|next actions|(\d+ )?goals for tomorrow|tomorrow|todo tomorrow|actions? for tomorrow)$/],
    ['summary', /^(summary|one[- ]line summary)$/],
    ['notable', /^(notable|quote|memorable|scene of the day)$/],
    ['tickers', /^tickers?$/],
    ['mood', /^(mood|mood \(inferred\)|inferred mood)$/],
    ['mood_confidence', /^mood confidence$/],
    ['day_score', /^(day score|score|rating)$/],
    ['energy', /^energy$/],
    ['tags', /^(tags|themes)$/],
    ['people', /^people$/],
    ['places', /^places$/],
    ['entry_type', /^(entry type|type)$/],
  ];
  const LIST_FIELDS = ['tags', 'people', 'places'];
  const NUMBER_FIELDS = ['mood', 'day_score'];

  const pad = (n: number) => (n < 10 ? '0' : '') + n;
  const clean = (s: string) => s
    .replace(/\{\{\[\[(TODO|DONE)\]\]\}\}/g, '{{$1}}') // Roam checkboxes, kept as markers
    .replace(/\{\{\[\[[^\]]*\]\][^}]*\}\}/g, '')     // other Roam widgets such as {{[[slider]]}}
    .replace(/\(\([\w-]{6,}\)\)/g, '')                // block references
    .replace(/#?\[\[\[\[([^\]]+)\]\]\s*\]\]/g, '$1')   // nested links: [[[[Day in Review]] ]]
    .replace(/#\[\[([^\]]+)\]\]/g, '$1')               // tags: #[[day score]]
    .replace(/\[\[([^\]]+)\]\]/g, '$1')                // page links
    .replace(/\*\*|__/g, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^>\s*/, '')
    .trim();

  function parseDate(raw: string): string | null {
    const s = clean(raw).replace(/\s+[0-9a-f]{32}$/i, '').replace(/\.md$/i, '').trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return m[3] + '-' + pad(+m[1]) + '-' + pad(+m[2]);
    // "Tue, Jul 20, 2021" · "Tuesday, July 20th, 2021" · "July 20th, 2021" · "Jul 20 2021"
    m = s.match(/^(?:[A-Za-z]+,?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
    if (m) {
      const mon = MONTHS[m[1].slice(0, 4).toLowerCase()] || MONTHS[m[1].slice(0, 3).toLowerCase()];
      const day = +m[2];
      if (mon && day >= 1 && day <= 31) return m[3] + '-' + pad(mon) + '-' + pad(day);
    }
    // "20 July 2021"
    m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
    if (m) {
      const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
      if (mon) return m[3] + '-' + pad(mon) + '-' + pad(+m[1]);
    }
    return null;
  }

  function labelOf(raw: string): string | null {
    const full = clean(raw).replace(/^#/, '').replace(/[:：]+$/, '').toLowerCase().trim();
    const head = full.split(/\s+\|\s+|\s+goals\b(?!.*tomorrow)/)[0].replace(/[:：]+$/, '').trim();
    for (const l of [full, head]) for (const [field, re] of LABELS) if (re.test(l)) return field;
    return null;
  }

  function indentOf(line: string): number {
    const m = line.match(/^(\s*)/);
    return m ? m[1].replace(/\t/g, '  ').length : 0;
  }

  function extractFields(text: string): Record<string, unknown> {
    const out: Record<string, string[]> = {};
    const add = (field: string, value: string) => {
      if (/\{\{\[\[DONE\]\]\}\}|\{\{DONE\}\}/.test(value)) return; // finished items are not open actions
      const v = clean(value).replace(/^\{\{TODO\}\}\s*/, '').trim();
      if (!v || /^[-–—]$/.test(v) || /^(none|n\/a|null)$/i.test(v)) return;
      (out[field] = out[field] || []).push(v);
    };
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;

      // Table row: | Rose | swimming |
      const row = line.match(/^\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*$/);
      if (row) { const f = labelOf(row[1]); if (f) add(f, row[2]); continue; }

      // Heading used as a label: "### Goals for tomorrow" → lines below until the next heading
      const h = line.match(/^#{1,6}\s+(.*)$/);
      if (h) {
        const f = labelOf(h[1]);
        if (f) {
          for (i = i + 1; i < lines.length && !/^#{1,6}\s/.test(lines[i]); i++) {
            const item = lines[i];
            if (!item.trim() || /^\s*[-*+]\s+\[x\]/i.test(item)) continue; // skip done checkboxes
            add(f, item.replace(/^\s*[-*+]\s+\[ \]\s*/, ''));
          }
          i--;
        }
        continue;
      }

      // "Rose:: text" · "**Rose:** text" · "- Rose: text" · "Rose — text"
      const body = clean(line);
      const kv = body.match(/^([A-Za-z][A-Za-z ()_]{1,30}?)\s*(?:::|:|：|\s[-–—]\s)\s*(.*)$/);
      if (kv) {
        const f = labelOf(kv[1]);
        if (f) {
          if (kv[2].trim()) { add(f, kv[2]); continue; }
          // Label with nested children
          const base = indentOf(line);
          for (i = i + 1; i < lines.length && lines[i].trim() && indentOf(lines[i]) > base; i++) add(f, lines[i]);
          i--;
          continue;
        }
      }
      // Bare label line ("- Rose") with nested children
      const bare = labelOf(line);
      if (bare && /^[A-Za-z#]/.test(body)) {
        const base = indentOf(line);
        let j = i + 1;
        for (; j < lines.length && lines[j].trim() && indentOf(lines[j]) > base; j++) add(bare, lines[j]);
        if (j > i + 1) i = j - 1;
      }
    }

    const fields: Record<string, unknown> = {};
    for (const k in out) {
      const vals = out[k];
      if (LIST_FIELDS.indexOf(k) >= 0) {
        fields[k] = vals.join(',').split(/\s*[,;·]\s*/).map(s => s.replace(/\s*\(https?:[^)]*\)$/, '').trim()).filter(Boolean);
      } else if (NUMBER_FIELDS.indexOf(k) >= 0) {
        const n = parseFloat(vals[0]);
        if (!isNaN(n)) fields[k] = n;
      } else if (k === 'energy' || k === 'mood_confidence') {
        const v = vals[0].toLowerCase();
        fields[k] = v.indexOf('high') >= 0 ? 'High' : v.indexOf('low') >= 0 ? 'Low' : v.indexOf('med') >= 0 ? 'Medium' : null;
      } else {
        fields[k] = vals.join(' · ');
      }
    }
    return fields;
  }

  const entries: ParsedEntry[] = [];
  const templates: { name: string; body: string }[] = [];
  const undated: { title: string; chars: number }[] = [];
  const seen: Record<string, number> = {};

  function addEntry(date: string, title: string, body: string) {
    const trimmed = body.replace(/^\s+|\s+$/g, '');
    seen[date] = (seen[date] || 0) + 1;
    const id = 'md' + date.replace(/-/g, '') + (seen[date] > 1 ? '-' + seen[date] : '');
    entries.push({ ...extractFields(trimmed), id, date, title: clean(title), body: trimmed, source: 'Roam' } as ParsedEntry);
  }

  function addUndated(title: string, body: string) {
    const t = clean(title) || 'Untitled';
    if (/template/i.test(t) && body.trim()) templates.push({ name: t.replace(/\s*templates?\s*/i, ' ').trim() || t, body: body.trim() });
    else if (body.trim()) undated.push({ title: t, chars: body.trim().length });
  }

  for (const file of files) {
    const text = file.text.replace(/\r\n?/g, '\n');
    const base = file.name.split('/').pop() || file.name;
    const fileDate = parseDate(base);
    if (fileDate) { addEntry(fileDate, base.replace(/\.md$/i, ''), text.replace(/^#\s+.*\n/, '')); continue; }

    // Roam template pages: "Investment Memo Template.md", "[[Template]]/day.md", "roam/templates/…"
    if (/template/i.test(file.name.replace(/\[|\]/g, '')) && text.trim()) {
      const stem = clean(base.replace(/\.(md|markdown|txt)$/i, ''));
      const name = stem.replace(/\s*templates?\s*/i, ' ').trim() || stem;
      templates.push({ name: name.charAt(0).toUpperCase() + name.slice(1), body: text.trim() });
      continue;
    }

    // Split one file into sections at date headings. A day ends at the next heading
    // of the same or a higher level.
    const lines = text.split('\n');
    let cur: { date: string | null; title: string; level: number; lines: string[] } | null = null;
    const flush = () => {
      if (!cur) return;
      if (cur.date) addEntry(cur.date, cur.title, cur.lines.join('\n'));
      else addUndated(cur.title, cur.lines.join('\n'));
    };
    for (const line of lines) {
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const level = h[1].length;
        const d = parseDate(h[2]);
        if (d || !cur || level <= cur.level) {
          flush();
          cur = { date: d, title: h[2], level, lines: [] };
          continue;
        }
      }
      if (!cur) cur = { date: null, title: base.replace(/\.md$/i, ''), level: 7, lines: [] }; // preamble: any heading ends it
      cur.lines.push(line);
    }
    flush();
  }

  entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { entries, templates, undated };
}
