#!/usr/bin/env node
/**
 * Import a Notion "Markdown & CSV" export of the Daily Journal database into the PKM.
 * Use this when you do not want to set up the Notion API token. The token sync is
 * still the better option for new entries.
 *
 * 1. In Notion: open Daily Journal → ••• → Export → Markdown & CSV, "Include subpages" on.
 * 2. Unzip the export (unzip nested zips too).
 * 3. node scripts/import-notion-export.mjs <export-folder> [--api https://pkm.cafecito-ai.com] [--dry-run]
 *    Set PKM_PASSWORD in the environment for the Bearer auth.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const args = process.argv.slice(2);
const apiAt = args.indexOf('--api');
const api = apiAt >= 0 ? args[apiAt + 1] : 'https://pkm.cafecito-ai.com';
const dir = args.find((a, i) => !a.startsWith('--') && !(apiAt >= 0 && i === apiAt + 1));
const dryRun = args.includes('--dry-run');
if (!dir) { console.error('Usage: node scripts/import-notion-export.mjs <export-folder> [--api URL] [--dry-run]'); process.exit(1); }

function walk(d) {
  return readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
}

function parseCSV(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h.replace(/^﻿/, ''), r[i] ?? ''])));
}

// "Nikki (https://www.notion.so/Nikki-3fb4...)" → "Nikki"
const names = v => (v || '').split(/,\s*(?![^()]*\))/).map(s => s.replace(/\s*\(https?:[^)]*\)\s*$/, '').trim()).filter(Boolean);
const toDate = v => { if (!v) return null; const d = new Date(v.split('→')[0].trim()); return isNaN(d) ? null : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const num = v => (v === '' || v == null ? null : Number(v));

const files = walk(dir);
const csv = files.find(f => /Daily Journal.*\.csv$/i.test(basename(f)) && !/_all\.csv$/i.test(f)) || files.find(f => f.endsWith('.csv'));
if (!csv) { console.error('No CSV found in the export.'); process.exit(1); }

// Page bodies: "<Title> <32-hex id>.md". Strip the "# Title" line and the "Property: value" header block.
const pagesByTitle = new Map();
for (const f of files.filter(f => f.endsWith('.md'))) {
  const m = basename(f).match(/^(.*) ([0-9a-f]{32})\.md$/);
  if (!m) continue;
  const lines = readFileSync(f, 'utf8').split('\n');
  let i = lines[0]?.startsWith('# ') ? 1 : 0;
  while (i < lines.length && (lines[i].trim() === '' || /^[A-Z][\w ()-]{0,40}: /.test(lines[i]))) i++;
  pagesByTitle.set(m[1], { id: m[2], body: lines.slice(i).join('\n').trim() });
}

const entries = parseCSV(readFileSync(csv, 'utf8')).map(r => {
  const page = pagesByTitle.get(r['Day']);
  return {
    id: page?.id,
    notion_id: page?.id,
    date: toDate(r['Date']),
    title: r['Day'],
    entry_type: r['Entry Type'] || null,
    source: r['Source'] || 'Notion',
    summary: r['Summary'], rose: r['Rose'], rose_theme: r['Rose Theme'], thorn: r['Thorn'], thorn_theme: r['Thorn Theme'],
    thorn_cause: r['Thorn Cause'], bud: r['Bud'], key_wins: r['Key Wins'], lesson: r['Lesson'], next_action: r['Next Action'],
    notable: r['Notable'], tickers: r['Tickers'],
    day_score: num(r['Day Score']), mood: num(r['Mood (inferred)']), mood_confidence: r['Mood Confidence'] || null,
    energy: r['Energy'] || null,
    tags: names(r['Tags']), people: names(r['People']), places: names(r['Places']),
    body: page?.body ?? undefined,
  };
}).filter(e => e.date);

console.log(`${entries.length} entries, ${entries.filter(e => e.body).length} with page bodies, from ${basename(csv)}`);
if (dryRun) { console.log(JSON.stringify(entries.slice(0, 2), null, 2)); process.exit(0); }

for (let i = 0; i < entries.length; i += 100) {
  const res = await fetch(`${api}/api/journal/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.PKM_PASSWORD || ''}` },
    body: JSON.stringify({ entries: entries.slice(i, i + 100) }),
  });
  console.log(`batch ${i / 100 + 1}:`, res.status, await res.text());
}
