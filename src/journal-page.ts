// Living Journal dashboard — served at /journal. Client code is plain JS inside String.raw,
// so it must not contain backticks or "${".
import { parseJournalMarkdown } from './journal-parse';

// The markdown parser runs in the browser. The shim covers esbuild's keep-names helper.
const PARSER_JS = 'var __name = function (f) { return f; };\n' + parseJournalMarkdown.toString();

export function journalPageHTML(): string {
  return PAGE.replace('/*JOURNAL_PARSER*/', () => PARSER_JS);
}

const PAGE = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Living Journal</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Instrument+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  --bg: #0C0C0E; --card: #161619; --raised: #1E1E22; --border: #2A2A2F;
  --text: #E8E6E1; --dim: #8A8880; --faint: #5A5850;
  --accent: #D4A853; --accent-hover: #C4983F; --on-accent: #0C0C0E;
  --rose: #4AAF7C; --thorn: #CC4455; --score: #5B8DEF;
  --heat-0: #2A2A2F; --heat-1: #4A3F26; --heat-2: #7A6230; --heat-3: #A9853C; --heat-4: #D4A853; --heat-5: #F0CB7A;
  --serif: 'Instrument Serif', Georgia, serif;
  --sans: 'Instrument Sans', -apple-system, BlinkMacSystemFont, sans-serif;
  --mono: 'Geist Mono', 'SF Mono', ui-monospace, monospace;
}
:root[data-theme="light"] {
  --bg: #F5F4F0; --card: #FFFFFF; --raised: #FAFAF8; --border: #E0DED8;
  --text: #1A1918; --dim: #6B6860; --faint: #9A9890;
  --accent: #B8922F; --accent-hover: #A07D20; --on-accent: #FFFFFF;
  --rose: #2E8A5C; --thorn: #B23A4A; --score: #3F6FD1;
  --heat-0: #ECEAE4; --heat-1: #F3E3BC; --heat-2: #E6C77E; --heat-3: #CFA54A; --heat-4: #B8922F; --heat-5: #8A6A1C;
}
html { -webkit-text-size-adjust: 100%; }
body { font-family: var(--sans); font-size: 14px; line-height: 1.5; background: var(--bg); color: var(--text); }
a { color: var(--accent); text-decoration: none; }
button { font-family: inherit; }
.wrap { max-width: 1080px; margin: 0 auto; padding: 24px 16px 80px; }
header.top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
header.top h1 { font-family: var(--serif); font-weight: 400; font-size: 34px; letter-spacing: -0.02em; }
header.top h1 span { color: var(--accent); }
.top-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.muted { color: var(--dim); }
.faint { color: var(--faint); }
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.btn { background: var(--accent); color: var(--on-accent); border: 0; border-radius: 6px; padding: 8px 14px; font-weight: 600; font-size: 13px; cursor: pointer; }
.btn:hover { background: var(--accent-hover); }
.btn:disabled { opacity: .5; cursor: progress; }
.btn-ghost { background: none; color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 7px 12px; font-size: 13px; cursor: pointer; }
.btn-ghost:hover { border-color: var(--accent); }
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.seg button { background: none; border: 0; color: var(--dim); padding: 4px 10px; font-size: 12px; cursor: pointer; }
.seg button.on { background: var(--raised); color: var(--text); }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 20px; }
.card h2 { font-family: var(--serif); font-weight: 400; font-size: 22px; letter-spacing: -0.01em; }
.card .sub { font-size: 12px; color: var(--dim); margin-top: 2px; }
.card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.grid { display: grid; gap: 14px; margin-bottom: 14px; }
.g2 { grid-template-columns: 1fr 1fr; }
.g3 { grid-template-columns: repeat(3, 1fr); }
.g4 { grid-template-columns: repeat(4, 1fr); }
@media (max-width: 860px) { .g2, .g3 { grid-template-columns: 1fr; } .g4 { grid-template-columns: 1fr 1fr; } }
.kpi .label { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); font-weight: 600; }
.kpi .value { font-family: var(--serif); font-size: 40px; line-height: 1.1; margin-top: 6px; }
.kpi .note { font-size: 12px; color: var(--dim); }
/* Capture */
textarea { width: 100%; min-height: 110px; resize: vertical; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 12px; font: inherit; font-size: 15px; line-height: 1.55; }
textarea:focus, input:focus { outline: none; border-color: var(--accent); }
input[type=text], input[type=date] { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 7px 10px; font: inherit; font-size: 13px; }
.cap-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
.chips { display: flex; gap: 4px; flex-wrap: wrap; }
.chip { min-width: 30px; height: 30px; border-radius: 6px; border: 1px solid var(--border); background: none; color: var(--dim); cursor: pointer; font-size: 12px; font-family: var(--mono); padding: 0 8px; }
.chip.on { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
.result { margin-top: 14px; border-top: 1px dashed var(--border); padding-top: 14px; display: none; }
.fields { display: grid; grid-template-columns: 110px 1fr; gap: 6px 12px; font-size: 13px; }
.fields dt { color: var(--dim); }
.ask-missing { margin-top: 10px; padding: 10px 12px; border-radius: 6px; background: var(--raised); font-size: 13px; }
/* Charts */
.chart { position: relative; width: 100%; }
.chart svg { display: block; width: 100%; overflow: visible; }
.axis text { fill: var(--dim); font-size: 11px; font-family: var(--mono); }
.grid-line { stroke: var(--border); stroke-width: 1; }
.tip { position: absolute; pointer-events: none; background: var(--raised); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; font-size: 12px; white-space: nowrap; opacity: 0; transition: opacity .05s; z-index: 5; box-shadow: 0 4px 16px rgba(0,0,0,.25); }
.tip b { font-weight: 600; }
.legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--dim); margin-top: 8px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
.bars .row { display: grid; grid-template-columns: 92px 1fr 34px; align-items: center; gap: 10px; padding: 3px 0; font-size: 13px; }
.bars .track { height: 12px; border-radius: 0 4px 4px 0; }
.bars .fill { height: 100%; border-radius: 0 4px 4px 0; }
.bars .n { text-align: right; color: var(--dim); font-family: var(--mono); font-size: 12px; }
.heat { overflow-x: auto; padding-bottom: 4px; }
.heat svg { width: auto; }
/* Lists */
.list { list-style: none; }
.list li { padding: 10px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.list li:last-child { border-bottom: 0; }
.list .date { font-family: var(--mono); font-size: 11px; color: var(--dim); }
.list .clickable { cursor: pointer; }
.list .clickable:hover .ttl { color: var(--accent); }
.pill { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 10px; border: 1px solid var(--border); color: var(--dim); margin-right: 4px; }
.rose-t { color: var(--rose); }
.thorn-t { color: var(--thorn); }
/* Insight */
.insight-head { font-family: var(--serif); font-size: 24px; line-height: 1.25; margin: 6px 0 14px; }
.insight h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); margin: 16px 0 6px; }
.insight ul { padding-left: 18px; }
.insight li { margin: 4px 0; }
.experiment { background: var(--raised); border-radius: 8px; padding: 10px 12px; margin: 6px 0; }
.question { font-family: var(--serif); font-style: italic; font-size: 19px; margin-top: 16px; color: var(--accent); }
/* Drawer */
.drawer-bg { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: none; z-index: 20; }
.drawer { position: fixed; top: 0; right: 0; height: 100%; width: min(640px, 100%); background: var(--card); border-left: 1px solid var(--border); overflow-y: auto; padding: 24px 20px 60px; display: none; z-index: 21; }
.drawer h2 { font-family: var(--serif); font-weight: 400; font-size: 28px; }
.drawer pre { white-space: pre-wrap; font-family: var(--sans); font-size: 14px; line-height: 1.6; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); }
.status { font-size: 12px; color: var(--dim); min-height: 18px; }
.setup ol { padding-left: 20px; } .setup li { margin: 6px 0; }
.setup code { font-family: var(--mono); font-size: 12px; background: var(--raised); padding: 1px 5px; border-radius: 4px; }
.skeleton { color: var(--faint); padding: 20px 0; text-align: center; }
.drop { display: block; border: 1px dashed var(--border); border-radius: 8px; padding: 26px 16px; text-align: center; color: var(--dim); cursor: pointer; }
.drop.over, .drop:hover { border-color: var(--accent); color: var(--text); }
table.prev { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 10px; }
table.prev td, table.prev th { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
table.prev th { color: var(--dim); font-weight: 600; }
.tpl { height: auto; padding: 4px 10px; font-family: var(--sans); }
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <h1>Living <span>Journal</span></h1>
    <div class="top-actions">
      <span class="status" id="sync-status"></span>
      <button class="btn-ghost" onclick="toggleImport(true)">Import</button>
      <button class="btn-ghost" id="sync-btn" onclick="syncNow()" style="display:none">Sync Notion</button>
      <a class="btn-ghost" href="/">Wiki</a>
      <button class="btn-ghost" onclick="toggleTheme()" id="theme-btn" aria-label="Toggle theme">&#9790;</button>
    </div>
  </header>

  <div id="setup"></div>

  <section class="card" id="import-card" style="display:none;margin-bottom:14px;border-color:var(--accent)">
    <div class="card-head">
      <div><h2>Import your journal</h2><div class="sub">Markdown files or a Roam export .zip. Your file is read in this browser and sent only to your own wiki. Importing the same file again updates the same days.</div></div>
      <button class="btn-ghost" onclick="toggleImport(false)">Close</button>
    </div>
    <label class="drop" id="drop">
      <input type="file" id="import-file" multiple accept=".md,.markdown,.txt,.zip" style="display:none" onchange="readFiles(this.files); this.value = ''">
      <b>Drop files here</b> or click to choose · .md, .txt or .zip
    </label>
    <div id="import-preview"></div>
  </section>

  <!-- Capture -->
  <section class="card" style="margin-bottom:14px">
    <div class="card-head">
      <div><h2>Tell me about today</h2><div class="sub">Dump your day in any order. Claude files the Rose, Thorn, Bud, wins and people. Missing parts get asked once, never invented.</div></div>
      <input type="date" id="cap-date">
    </div>
    <div class="chips" id="tpl-chips" style="margin-bottom:8px"></div>
    <textarea id="cap-text" placeholder="Morning: … Rose: … Thorn: … Looking forward to …"></textarea>
    <div class="cap-row">
      <span class="muted" style="font-size:12px">Day score</span>
      <div class="chips" id="score-chips"></div>
      <span class="muted" style="font-size:12px;margin-left:8px">Energy</span>
      <div class="chips" id="energy-chips"></div>
      <span style="flex:1"></span>
      <button class="btn" id="cap-btn" onclick="capture()">File entry</button>
    </div>
    <div class="status" id="cap-status" style="margin-top:6px"></div>
    <div class="result" id="cap-result"></div>
  </section>

  <!-- KPIs -->
  <section class="grid g4" id="kpis"></section>

  <!-- Trend -->
  <section class="card" style="margin-bottom:14px">
    <div class="card-head">
      <div><h2>Mood over time</h2><div class="sub">Monthly average, 1–10. Mood is inferred by Claude from each entry. Day Score is your own rating.</div></div>
      <div class="seg" id="trend-range"><button data-r="12">1Y</button><button data-r="36">3Y</button><button data-r="0" class="on">All</button></div>
    </div>
    <div class="chart" id="trend"></div>
    <div class="legend" id="trend-legend"></div>
  </section>

  <!-- Themes -->
  <section class="card" style="margin-bottom:14px">
    <div class="card-head">
      <div><h2>What lifts you, what drains you</h2><div class="sub">Count of days by Rose theme and Thorn theme</div></div>
      <div class="seg" id="theme-range"><button data-r="90d">Last 90 days</button><button data-r="all" class="on">All time</button></div>
    </div>
    <div class="grid g2" style="margin:0">
      <div><div style="font-weight:600;margin-bottom:8px" class="rose-t">&#127801; Roses</div><div class="bars" id="rose-bars"></div></div>
      <div><div style="font-weight:600;margin-bottom:8px" class="thorn-t">&#127797; Thorns</div><div class="bars" id="thorn-bars"></div></div>
    </div>
  </section>

  <section class="grid g2">
    <div class="card">
      <h2>Recurring thorn causes</h2><div class="sub">Causes that repeat are where a fix pays off most</div>
      <ul class="list" id="causes" style="margin-top:8px"></ul>
    </div>
    <div class="card">
      <h2>Mood by weekday</h2><div class="sub">Average inferred mood</div>
      <div class="chart" id="weekday" style="margin-top:12px"></div>
      <div id="energy-note" class="sub" style="margin-top:10px"></div>
    </div>
  </section>

  <!-- Heatmap -->
  <section class="card" style="margin-bottom:14px">
    <div class="card-head"><div><h2>The last year</h2><div class="sub">One square per day. Darker amber = better mood. Outlined = journaled, no mood yet.</div></div></div>
    <div class="heat chart" id="heat"></div>
    <div class="legend" id="heat-legend"></div>
  </section>

  <!-- Insight -->
  <section class="card insight" style="margin-bottom:14px">
    <div class="card-head">
      <div><h2>Claude's read</h2><div class="sub" id="insight-meta">Patterns, energizers, drains and small experiments, tied to your own principles in the wiki</div></div>
      <div class="top-actions">
        <div class="seg" id="insight-range"><button data-p="week" class="on">Week</button><button data-p="month">Month</button><button data-p="quarter">Quarter</button><button data-p="all">All time</button></div>
        <button class="btn" id="insight-btn" onclick="generateInsight(false)">Generate</button>
      </div>
    </div>
    <div id="insight"><div class="skeleton">No insight for this period yet. Generate one; it is cached until new entries arrive.</div></div>
  </section>

  <!-- Ask -->
  <section class="card" style="margin-bottom:14px">
    <h2>Ask your journal</h2>
    <div class="cap-row"><input type="text" id="ask-q" placeholder="When was I happiest at work? What helps my anxiety?" style="flex:1;min-width:200px"><button class="btn" id="ask-btn" onclick="ask()">Ask</button></div>
    <div id="ask-a" style="margin-top:12px"></div>
  </section>

  <section class="grid g3">
    <div class="card"><h2>On this day</h2><ul class="list" id="otd"></ul></div>
    <div class="card"><h2>Next actions</h2><div class="sub">From the last 14 days</div><ul class="list" id="actions"></ul></div>
    <div class="card"><h2>Lessons</h2><ul class="list" id="lessons"></ul></div>
  </section>

  <section class="grid g2">
    <div class="card">
      <div class="card-head"><h2>Entries</h2><input type="text" id="search" placeholder="Search entries" oninput="searchSoon()"></div>
      <ul class="list" id="recent"></ul>
    </div>
    <div class="card"><h2>People</h2><div class="sub">Most mentioned across your days</div><ul class="list" id="people"></ul></div>
  </section>
  <p class="faint" style="font-size:12px;margin-top:20px" id="foot"></p>
</div>

<div class="drawer-bg" id="drawer-bg" onclick="closeDrawer()"></div>
<aside class="drawer" id="drawer" aria-label="Journal entry"></aside>

<script>
var S = null, scoreSel = null, energySel = null, insightPeriod = 'week', trendMonths = 0, themeRange = 'all';
var DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function $(id) { return document.getElementById(id); }
function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function api(path, opts) {
  return fetch(path, opts).then(function(r) {
    return r.json().then(function(j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
  });
}
function post(path, body) { return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); }
function fmtDate(d) { var t = new Date(d + 'T12:00:00'); return t.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }); }
function money(x) { return '$' + (x < 0.01 ? x.toFixed(4) : x.toFixed(2)); }

// --- Theme -----------------------------------------------------------------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('theme-btn').innerHTML = t === 'light' ? '&#9728;' : '&#9790;';
  if (S) renderCharts();
}
function toggleTheme() {
  var t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  try { localStorage.setItem('pkm-theme', t); } catch (e) {}
  applyTheme(t);
}
(function() { var t = 'dark'; try { t = localStorage.getItem('pkm-theme') || 'dark'; } catch (e) {} applyTheme(t); })();

// --- Capture ---------------------------------------------------------------
(function initCapture() {
  $('cap-date').value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  var sc = $('score-chips');
  for (var i = 1; i <= 10; i++) {
    (function(n) {
      var b = document.createElement('button'); b.className = 'chip'; b.textContent = n;
      b.onclick = function() { scoreSel = scoreSel === n ? null : n; Array.prototype.forEach.call(sc.children, function(c, k) { c.classList.toggle('on', k + 1 === scoreSel); }); };
      sc.appendChild(b);
    })(i);
  }
  var ec = $('energy-chips');
  ['Low', 'Medium', 'High'].forEach(function(e) {
    var b = document.createElement('button'); b.className = 'chip'; b.textContent = e;
    b.onclick = function() { energySel = energySel === e ? null : e; Array.prototype.forEach.call(ec.children, function(c) { c.classList.toggle('on', c.textContent === energySel); }); };
    ec.appendChild(b);
  });
  try { var d = localStorage.getItem('journal-draft'); if (d) $('cap-text').value = d; } catch (e) {}
  $('cap-text').addEventListener('input', function() { try { localStorage.setItem('journal-draft', this.value); } catch (e) {} });
})();

function capture() {
  var text = $('cap-text').value.trim();
  if (!text) { $('cap-status').textContent = 'Write something first.'; return; }
  $('cap-btn').disabled = true; $('cap-status').textContent = 'Claude is filing your entry…';
  post('/api/journal/capture', { text: text, date: $('cap-date').value, day_score: scoreSel, energy: energySel })
    .then(function(r) {
      var e = r.entry;
      $('cap-text').value = ''; try { localStorage.removeItem('journal-draft'); } catch (x) {}
      $('cap-status').textContent = 'Filed ' + fmtDate(e.entry_date) + ' · ' + money(r.cost_usd || 0);
      var rows = [['Summary', e.summary], ['Rose', e.rose], ['Thorn', e.thorn ? e.thorn + (e.thorn_cause ? ' (' + e.thorn_cause + ')' : '') : null],
        ['Bud', e.bud], ['Wins', e.key_wins], ['Lesson', e.lesson], ['Next action', e.next_action], ['Mood', e.mood], ['People', (e.people || []).join(', ')]];
      var html = '<dl class="fields">' + rows.filter(function(r) { return r[1]; }).map(function(r) { return '<dt>' + r[0] + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('') + '</dl>';
      if (r.missing && r.missing.length) {
        html += '<div class="ask-missing">Not in today’s entry: <b>' + r.missing.map(function(m) { return m.replace('_', ' '); }).join(', ') +
          '</b>. Add a line above and file again; it appends to the same day.</div>';
      }
      if (r.suggest_template) {
        html += '<div class="ask-missing">This thorn repeats a cause you have logged before. <button class="btn-ghost" style="margin-left:6px" onclick="useTemplate(\'' + esc(r.suggest_template) + '\')">Run ' + esc(r.suggest_template) + '</button></div>';
      }
      $('cap-result').innerHTML = html; $('cap-result').style.display = 'block';
      load();
    })
    .catch(function(err) { $('cap-status').textContent = 'Could not file: ' + err.message; })
    .then(function() { $('cap-btn').disabled = false; });
}

// --- Sync ------------------------------------------------------------------
function syncNow() {
  $('sync-btn').disabled = true; $('sync-status').textContent = 'Syncing from Notion…';
  post('/api/journal/sync', { bodies: 40 })
    .then(function(r) {
      $('sync-status').textContent = r.entries_upserted + ' entries, ' + r.bodies_fetched + ' page bodies' +
        (r.bodies_remaining ? ' · ' + r.bodies_remaining + ' bodies left (click again or wait for the hourly sync)' : ' · up to date');
      load();
    })
    .catch(function(e) { $('sync-status').textContent = e.message; })
    .then(function() { $('sync-btn').disabled = false; });
}

// --- Load ------------------------------------------------------------------
function load() {
  return api('/api/journal/stats').then(function(s) { S = s; render(); }).catch(function(e) {
    $('kpis').innerHTML = '<div class="card" style="grid-column:1/-1">Could not load the journal: ' + esc(e.message) + '</div>';
  });
}

function render() {
  var t = S.totals;
  $('setup').innerHTML = !t.entries ? setupHTML() : '';
  $('sync-btn').style.display = S.notion_connected ? '' : 'none';
  var m30 = S.last30 || {};
  var kp = [
    ['Entries', t.entries || 0, t.first ? 'since ' + fmtDate(t.first) : 'none yet'],
    ['Streak', (t.current_streak || 0) + 'd', 'longest ' + (t.longest_streak || 0) + ' days'],
    ['Mood, 30 days', m30.mood != null ? Number(m30.mood).toFixed(1) : '–', (m30.n || 0) + ' entries' + (m30.score != null ? ' · your score ' + Number(m30.score).toFixed(1) : '')],
    ['Open actions', (S.next_actions || []).length, 'from the last 14 days'],
  ];
  $('kpis').innerHTML = kp.map(function(k) {
    return '<div class="card kpi"><div class="label">' + k[0] + '</div><div class="value mono">' + esc(k[1]) + '</div><div class="note">' + esc(k[2]) + '</div></div>';
  }).join('');

  $('causes').innerHTML = (S.thorn_causes || []).map(function(c) {
    return '<li><div style="display:flex;justify-content:space-between;gap:8px"><span>' + esc(c.cause) + '</span><span class="mono muted">' + c.n + '×</span></div><div class="date">last ' + esc(c.last) + '</div></li>';
  }).join('') || empty('No thorn causes yet');

  $('otd').innerHTML = (S.on_this_day || []).map(function(e) {
    return '<li class="clickable" onclick="openEntry(\'' + e.id + '\')"><div class="date">' + e.entry_date.slice(0, 4) + '</div><div class="ttl">' + esc(e.summary || e.rose || e.notable || e.title) + '</div></li>';
  }).join('') || empty('Nothing from this date in past years');

  $('actions').innerHTML = (S.next_actions || []).map(function(e) {
    return '<li class="clickable" onclick="openEntry(\'' + e.id + '\')"><div class="date">' + e.entry_date + '</div><div class="ttl">' + esc(e.next_action) + '</div></li>';
  }).join('') || empty('No next actions in the last 14 days');

  $('lessons').innerHTML = (S.lessons || []).map(function(e) {
    return '<li class="clickable" onclick="openEntry(\'' + e.id + '\')"><div class="date">' + e.entry_date + '</div><div class="ttl">' + esc(e.lesson) + '</div></li>';
  }).join('') || empty('No lessons logged yet');

  $('people').innerHTML = (S.people || []).map(function(p) {
    return '<li style="display:flex;justify-content:space-between"><span>' + esc(p.name) + '</span><span class="mono muted">' + p.n + ' days · last ' + esc(p.last) + '</span></li>';
  }).join('') || empty('No people linked yet');

  renderRecent(S.recent);
  var w = (S.energy || []);
  var hi = w.filter(function(e) { return e.energy === 'High'; })[0], lo = w.filter(function(e) { return e.energy === 'Low'; })[0];
  $('energy-note').textContent = hi && lo && hi.mood != null && lo.mood != null
    ? 'High-energy days average mood ' + Number(hi.mood).toFixed(1) + ' vs ' + Number(lo.mood).toFixed(1) + ' on low-energy days.' : '';
  $('foot').textContent = 'AI spend this month: ' + money(S.ai_cost_month_usd || 0) + ' · model ' + S.model +
    (S.last_sync ? ' · last Notion sync ' + new Date(S.last_sync).toLocaleString() : '') +
    ' · ' + (t.with_body || 0) + ' of ' + (t.entries || 0) + ' entries have full notes';
  renderCharts();
  loadInsight();
}

function empty(msg) { return '<li class="faint">' + msg + '</li>'; }

function renderRecent(rows) {
  $('recent').innerHTML = (rows || []).map(function(e) {
    var bits = [];
    if (e.mood != null) bits.push('<span class="pill">mood ' + e.mood + '</span>');
    if (e.day_score != null) bits.push('<span class="pill">score ' + e.day_score + '</span>');
    if (e.source) bits.push('<span class="pill">' + esc(e.source) + '</span>');
    return '<li class="clickable" onclick="openEntry(\'' + e.id + '\')"><div class="date">' + fmtDate(e.entry_date) + '</div>' +
      '<div class="ttl">' + esc(e.snippet || e.summary || e.rose || e.title || '(no summary yet)') + '</div><div style="margin-top:4px">' + bits.join('') + '</div></li>';
  }).join('') || empty('No entries match');
}

var searchTimer = null;
function searchSoon() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(function() {
    var q = $('search').value.trim();
    if (!q) { renderRecent(S.recent); return; }
    api('/api/journal/entries?q=' + encodeURIComponent(q) + '&limit=30').then(function(r) { renderRecent(r.entries); });
  }, 250);
}

function setupHTML() {
  return '<section class="card setup" style="margin-bottom:14px;border-color:var(--accent)"><h2>Bring your journal in</h2>' +
    '<div class="sub" style="margin-bottom:10px">No Notion needed. Use the markdown you exported from Roam or from your other chat.</div><ol>' +
    '<li>Click <b>Import</b> and drop the markdown file, or the Roam export .zip.</li>' +
    '<li>Check the preview: number of days, date range, and the fields that were found.</li>' +
    '<li>Click <b>Import</b>. Templates in the file are saved too.</li>' +
    '<li>If some days have notes but no summary or mood, you can let Claude fill them in. It shows the cost first.</li></ol>' +
    '<button class="btn" style="margin-top:10px" onclick="toggleImport(true)">Import</button></section>';
}

// --- Charts ----------------------------------------------------------------
function svgEl(tag, attrs) { var e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }

function renderCharts() { renderTrend(); renderThemes(); renderWeekday(); renderHeat(); }

function monthsBetween(a, b) { var out = []; var y = +a.slice(0, 4), m = +a.slice(5, 7); var ey = +b.slice(0, 4), em = +b.slice(5, 7);
  while (y < ey || (y === ey && m <= em)) { out.push(y + '-' + (m < 10 ? '0' : '') + m); m++; if (m > 12) { m = 1; y++; } } return out; }

function renderTrend() {
  var host = $('trend'); host.innerHTML = '';
  var data = (S.monthly || []).filter(function(r) { return r.mood != null || r.score != null; });
  if (!data.length) { host.innerHTML = '<div class="skeleton">Mood appears here once entries have a mood or a day score.</div>'; $('trend-legend').innerHTML = ''; return; }
  var by = {}; data.forEach(function(r) { by[r.month] = r; });
  var months = monthsBetween(data[0].month, S.today.slice(0, 7));
  if (trendMonths) months = months.slice(-trendMonths);
  var hasScore = data.some(function(r) { return r.score != null; });
  var W = host.clientWidth || 800, H = 220, L = 28, R = 12, T = 10, B = 24;
  var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img', 'aria-label': 'Monthly mood line chart' });
  var x = function(i) { return L + (months.length < 2 ? 0 : i * (W - L - R) / (months.length - 1)); };
  var y = function(v) { return T + (10 - v) * (H - T - B) / 9; };
  var g = svgEl('g', { class: 'axis' });
  [1, 4, 7, 10].forEach(function(v) {
    g.appendChild(svgEl('line', { class: 'grid-line', x1: L, x2: W - R, y1: y(v), y2: y(v) }));
    var t = svgEl('text', { x: L - 8, y: y(v) + 4, 'text-anchor': 'end' }); t.textContent = v; g.appendChild(t);
  });
  var step = Math.max(1, Math.ceil(months.length / 8));
  var yearStep = Math.max(1, Math.ceil(months.length / 12 / ((W - L - R) / 60)));
  months.forEach(function(mo, i) {
    var label = '';
    if (months.length > 18) { if (mo.slice(5) === '01' && (+mo.slice(0, 4)) % yearStep === 0) label = mo.slice(0, 4); }
    else if (i % step === 0 || i === months.length - 1) label = mo.slice(2).replace('-', '/');
    if (!label) return;
    var t = svgEl('text', { x: x(i), y: H - 6, 'text-anchor': 'middle' });
    t.textContent = label;
    g.appendChild(t);
  });
  svg.appendChild(g);
  function line(key, color) {
    var d = '', pen = false;
    months.forEach(function(mo, i) { var r = by[mo]; if (r && r[key] != null) { d += (pen ? 'L' : 'M') + x(i) + ' ' + y(r[key]); pen = true; } else pen = false; });
    svg.appendChild(svgEl('path', { d: d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    months.forEach(function(mo, i) { var r = by[mo]; var prev = by[months[i - 1]], next = by[months[i + 1]];
      if (r && r[key] != null && !(prev && prev[key] != null) && !(next && next[key] != null))
        svg.appendChild(svgEl('circle', { cx: x(i), cy: y(r[key]), r: 3, fill: color })); });
  }
  line('mood', css('--accent'));
  if (hasScore) line('score', css('--score'));
  var cross = svgEl('line', { x1: 0, x2: 0, y1: T, y2: H - B, stroke: css('--dim'), 'stroke-width': 1, opacity: 0 });
  var dot = svgEl('circle', { r: 5, fill: css('--accent'), stroke: css('--card'), 'stroke-width': 2, opacity: 0 });
  svg.appendChild(cross); svg.appendChild(dot);
  var tip = document.createElement('div'); tip.className = 'tip';
  host.appendChild(svg); host.appendChild(tip);
  svg.addEventListener('mousemove', function(ev) {
    var rect = svg.getBoundingClientRect(); var px = (ev.clientX - rect.left) * W / rect.width;
    var i = Math.max(0, Math.min(months.length - 1, Math.round((px - L) / ((W - L - R) / Math.max(1, months.length - 1)))));
    var r = by[months[i]]; cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('opacity', 1);
    if (r && r.mood != null) { dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(r.mood)); dot.setAttribute('opacity', 1); } else dot.setAttribute('opacity', 0);
    tip.innerHTML = '<b>' + months[i] + '</b><br>' + (r ? (r.mood != null ? 'Mood ' + r.mood : 'No mood') + (r.score != null ? ' · Score ' + r.score : '') + '<br>' + r.entries + ' entries' : 'No entries');
    tip.style.opacity = 1; var left = x(i) * rect.width / W; tip.style.left = Math.min(rect.width - 140, Math.max(0, left + 10)) + 'px'; tip.style.top = '8px';
  });
  svg.addEventListener('mouseleave', function() { tip.style.opacity = 0; cross.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); });
  $('trend-legend').innerHTML = '<span><i style="background:' + css('--accent') + '"></i>Mood (inferred)</span>' + (hasScore ? '<span><i style="background:' + css('--score') + '"></i>Day Score (yours)</span>' : '');
}

function bars(host, rows, color) {
  var max = Math.max.apply(null, rows.map(function(r) { return r.n; }).concat([1]));
  host.innerHTML = rows.slice(0, 8).map(function(r) {
    return '<div class="row" title="' + esc(r.theme) + ': ' + r.n + ' days"><span>' + esc(r.theme) + '</span><div class="track"><div class="fill" style="width:' + Math.max(2, 100 * r.n / max) + '%;background:' + color + '"></div></div><span class="n">' + r.n + '</span></div>';
  }).join('') || '<div class="faint">No themes yet</div>';
}
function renderThemes() {
  var th = S.themes || {};
  bars($('rose-bars'), themeRange === 'all' ? th.rose || [] : th.rose_90d || [], css('--rose'));
  bars($('thorn-bars'), themeRange === 'all' ? th.thorn || [] : th.thorn_90d || [], css('--thorn'));
}

function renderWeekday() {
  var host = $('weekday'); host.innerHTML = '';
  var rows = S.weekday || []; if (!rows.length) { host.innerHTML = '<div class="skeleton">Needs entries with mood</div>'; return; }
  var by = {}; rows.forEach(function(r) { by[r.dow] = r; });
  var vals = rows.map(function(r) { return r.mood; }); var best = Math.max.apply(null, vals), worst = Math.min.apply(null, vals);
  var W = host.clientWidth || 400, H = 150, B = 22, T = 18, bw = (W / 7) * 0.56;
  var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img', 'aria-label': 'Average mood by weekday' });
  var tip = document.createElement('div'); tip.className = 'tip';
  for (var d = 0; d < 7; d++) {
    var cx = (d + 0.5) * W / 7, r = by[d];
    var lbl = svgEl('text', { x: cx, y: H - 6, 'text-anchor': 'middle', fill: css('--dim'), 'font-size': 11 }); lbl.textContent = DOW[d]; svg.appendChild(lbl);
    if (!r) continue;
    var h = (r.mood / 10) * (H - B - T);
    var path = 'M' + (cx - bw / 2) + ' ' + (H - B) + 'V' + (H - B - h + 4) + 'q0 -4 4 -4H' + (cx + bw / 2 - 4) + 'q4 0 4 4V' + (H - B) + 'Z';
    var bar = svgEl('path', { d: path, fill: css('--accent'), opacity: r.mood === best ? 1 : 0.55 });
    (function(rr, x0) {
      bar.addEventListener('mousemove', function() { tip.innerHTML = '<b>' + DOW[rr.dow] + '</b><br>Mood ' + rr.mood + ' · ' + rr.n + ' days'; tip.style.opacity = 1; tip.style.left = Math.min(W - 120, x0) * host.clientWidth / W + 'px'; tip.style.top = '0px'; });
      bar.addEventListener('mouseleave', function() { tip.style.opacity = 0; });
    })(r, cx);
    svg.appendChild(bar);
    if (r.mood === best || r.mood === worst) {
      var v = svgEl('text', { x: cx, y: H - B - h - 5, 'text-anchor': 'middle', fill: css('--text'), 'font-size': 11, 'font-family': css('--mono') }); v.textContent = r.mood; svg.appendChild(v);
    }
  }
  host.appendChild(svg); host.appendChild(tip);
}

function renderHeat() {
  var host = $('heat'); host.innerHTML = '';
  var by = {}; (S.heatmap || []).forEach(function(r) { by[r.date] = r; });
  var end = new Date(S.today + 'T12:00:00'); var start = new Date(end); start.setDate(start.getDate() - 364 - start.getDay());
  var C = 12, G = 2, weeks = Math.ceil((end - start) / 86400000 / 7) + 1;
  var W = 30 + weeks * (C + G), H = 7 * (C + G) + 20;
  var svg = svgEl('svg', { width: W, height: H, role: 'img', 'aria-label': 'Daily mood over the last year' });
  var tip = document.createElement('div'); tip.className = 'tip';
  [1, 3, 5].forEach(function(d) { var t = svgEl('text', { x: 0, y: 20 + d * (C + G) + 10, fill: css('--dim'), 'font-size': 10 }); t.textContent = DOW[d]; svg.appendChild(t); });
  var lastMonth = -1;
  for (var w = 0; w < weeks; w++) {
    for (var d = 0; d < 7; d++) {
      var day = new Date(start); day.setDate(start.getDate() + w * 7 + d); if (day > end) continue;
      var key = day.toISOString().slice(0, 10), r = by[key];
      if (d === 0 && day.getMonth() !== lastMonth) { lastMonth = day.getMonth(); var mt = svgEl('text', { x: 30 + w * (C + G), y: 11, fill: css('--dim'), 'font-size': 10 }); mt.textContent = day.toLocaleString(undefined, { month: 'short' }); svg.appendChild(mt); }
      var v = r ? (r.score != null ? r.score : r.mood) : null;
      var fill = !r ? css('--heat-0') : v == null ? 'none' : css('--heat-' + Math.max(1, Math.min(5, Math.ceil(v / 2))));
      var rect = svgEl('rect', { x: 30 + w * (C + G), y: 20 + d * (C + G), width: C, height: C, rx: 2, fill: fill, stroke: r && v == null ? css('--accent') : 'none', 'stroke-width': 1 });
      (function(k, rr, px, py) {
        rect.addEventListener('mousemove', function() { tip.innerHTML = '<b>' + fmtDate(k) + '</b><br>' + (rr ? (rr.mood != null ? 'Mood ' + rr.mood : 'No mood') + (rr.score != null ? ' · Score ' + rr.score : '') : 'No entry'); tip.style.opacity = 1; tip.style.left = Math.max(0, px - 60 - host.scrollLeft) + 'px'; tip.style.top = (py + 16) + 'px'; });
        rect.addEventListener('mouseleave', function() { tip.style.opacity = 0; });
        if (rr) rect.addEventListener('click', function() { api('/api/journal/entries?from=' + k + '&to=' + k).then(function(x) { if (x.entries[0]) openEntry(x.entries[0].id); }); });
      })(key, r, 30 + w * (C + G), 20 + d * (C + G));
      svg.appendChild(rect);
    }
  }
  host.appendChild(svg); host.appendChild(tip);
  $('heat-legend').innerHTML = '<span>Low</span>' + [1, 2, 3, 4, 5].map(function(i) { return '<i style="background:' + css('--heat-' + i) + ';margin:0"></i>'; }).join(' ') + '<span>High</span><span><i style="background:' + css('--heat-0') + '"></i>No entry</span><span><i style="border:1px solid ' + css('--accent') + '"></i>Entry, no mood</span>';
}

// --- Insight ---------------------------------------------------------------
function loadInsight() {
  api('/api/journal/insights?period=' + insightPeriod).then(function(r) { showInsight(r.insight); }).catch(function() {});
}
function showInsight(ins) {
  if (!ins) { $('insight').innerHTML = '<div class="skeleton">No insight for this period yet. Generate one; it is cached until new entries arrive.</div>'; $('insight-meta').textContent = 'Patterns, energizers, drains and small experiments, tied to your own principles in the wiki'; return; }
  var c = ins.content;
  $('insight-meta').textContent = 'Generated ' + new Date((ins.created_at || '').replace(' ', 'T') + (String(ins.created_at).indexOf('Z') < 0 ? 'Z' : '')).toLocaleString() + ' · ' + (ins.model || '') + ' · ' + money(ins.cost_usd || 0) + (ins.cached ? ' · cached' : '');
  var li = function(a) { return (a || []).map(function(x) { return '<li>' + esc(x) + '</li>'; }).join(''); };
  $('insight').innerHTML = '<div class="insight-head">' + esc(c.headline) + '</div>' +
    '<div class="grid g2" style="margin:0"><div><h3>Patterns</h3>' + (c.patterns || []).map(function(p) { return '<div style="margin-bottom:10px"><b>' + esc(p.title) + '</b><div class="muted">' + esc(p.evidence) + '</div></div>'; }).join('') + '</div>' +
    '<div><h3 class="rose-t">Energizers</h3><ul>' + li(c.energizers) + '</ul><h3 class="thorn-t">Drains</h3><ul>' + li(c.drains) + '</ul></div></div>' +
    '<h3>Try next</h3>' + (c.experiments || []).map(function(x) { return '<div class="experiment"><b>' + esc(x.action) + '</b><div class="muted">' + esc(x.why) + '</div></div>'; }).join('') +
    '<div class="question">' + esc(c.question) + '</div>';
}
function generateInsight(force) {
  $('insight-btn').disabled = true; $('insight').innerHTML = '<div class="skeleton">Claude is reading your ' + insightPeriod + '…</div>';
  post('/api/journal/insights', { period: insightPeriod, force: !!force })
    .then(function(r) { showInsight(r); })
    .catch(function(e) { $('insight').innerHTML = '<div class="skeleton">' + esc(e.message) + '</div>'; })
    .then(function() { $('insight-btn').disabled = false; });
}

// --- Ask -------------------------------------------------------------------
function ask() {
  var q = $('ask-q').value.trim(); if (!q) return;
  $('ask-btn').disabled = true; $('ask-a').innerHTML = '<span class="muted">Reading your entries…</span>';
  post('/api/journal/ask', { question: q })
    .then(function(r) {
      $('ask-a').innerHTML = '<div style="font-size:15px;line-height:1.6">' + esc(r.answer) + '</div><div style="margin-top:8px">' +
        (r.dates || []).map(function(d) { return '<a class="pill" href="#" onclick="openDate(\'' + esc(d) + '\');return false">' + esc(d) + '</a>'; }).join('') + '</div>';
    })
    .catch(function(e) { $('ask-a').textContent = e.message; })
    .then(function() { $('ask-btn').disabled = false; });
}
$('ask-q').addEventListener('keydown', function(e) { if (e.key === 'Enter') ask(); });

// --- Drawer ----------------------------------------------------------------
function openDate(d) { api('/api/journal/entries?from=' + d + '&to=' + d).then(function(x) { if (x.entries[0]) openEntry(x.entries[0].id); }); }
function openEntry(id) {
  api('/api/journal/entries/' + encodeURIComponent(id)).then(function(r) {
    var e = r.entry;
    var f = [['Rose', e.rose, 'rose-t'], ['Thorn', e.thorn, 'thorn-t'], ['Thorn cause', e.thorn_cause], ['Bud', e.bud], ['Wins', e.key_wins], ['Lesson', e.lesson], ['Next action', e.next_action], ['Notable', e.notable], ['Tickers', e.tickers], ['People', (e.people || []).join(', ')], ['Places', (e.places || []).join(', ')]];
    $('drawer').innerHTML = '<button class="btn-ghost" onclick="closeDrawer()" style="float:right">Close</button>' +
      '<div class="date mono muted">' + esc(e.entry_date) + ' · ' + esc(e.source || '') + (e.entry_type ? ' · ' + esc(e.entry_type) : '') + '</div>' +
      '<h2>' + esc(e.title || fmtDate(e.entry_date)) + '</h2>' + (e.summary ? '<p class="muted" style="margin:6px 0 12px">' + esc(e.summary) + '</p>' : '') +
      '<div style="margin-bottom:10px">' + (e.mood != null ? '<span class="pill">mood ' + e.mood + '</span>' : '') + (e.day_score != null ? '<span class="pill">score ' + e.day_score + '</span>' : '') + (e.energy ? '<span class="pill">energy ' + esc(e.energy) + '</span>' : '') + (e.tags || []).map(function(t) { return '<span class="pill">' + esc(t) + '</span>'; }).join('') + '</div>' +
      '<dl class="fields">' + f.filter(function(x) { return x[1]; }).map(function(x) { return '<dt>' + x[0] + '</dt><dd class="' + (x[2] || '') + '">' + esc(x[1]) + '</dd>'; }).join('') + '</dl>' +
      (e.body ? '<pre>' + esc(e.body) + '</pre>' : '<p class="faint" style="margin-top:14px">' + (e.notion_id ? 'Full notes arrive with the next Notion sync.' : 'No notes.') + '</p>') +
      (e.notion_id ? '<p style="margin-top:16px"><a href="https://www.notion.so/' + esc(e.notion_id) + '" target="_blank" rel="noopener">Open in Notion</a></p>' : '');
    $('drawer').style.display = 'block'; $('drawer-bg').style.display = 'block';
  });
}
function closeDrawer() { $('drawer').style.display = 'none'; $('drawer-bg').style.display = 'none'; }
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeDrawer(); });

// --- Segmented controls ----------------------------------------------------
function seg(id, attr, fn) {
  var el = $(id);
  el.addEventListener('click', function(ev) {
    var b = ev.target.closest('button'); if (!b) return;
    Array.prototype.forEach.call(el.children, function(c) { c.classList.toggle('on', c === b); });
    fn(b.getAttribute(attr));
  });
}
seg('trend-range', 'data-r', function(v) { trendMonths = +v; renderTrend(); });
seg('theme-range', 'data-r', function(v) { themeRange = v; renderThemes(); });
seg('insight-range', 'data-p', function(v) { insightPeriod = v; loadInsight(); });
var resizeTimer; window.addEventListener('resize', function() { clearTimeout(resizeTimer); resizeTimer = setTimeout(function() { if (S) { renderTrend(); renderWeekday(); } }, 150); });

// --- Templates ---------------------------------------------------------------
var TEMPLATES = [];
function loadTemplates() {
  api('/api/journal/templates').then(function(r) {
    TEMPLATES = r.templates || [];
    $('tpl-chips').innerHTML = '<span class="muted" style="font-size:12px;align-self:center;margin-right:4px">Templates</span>' +
      TEMPLATES.map(function(t) { return '<button class="chip tpl" title="' + esc(t.hint || '') + '" onclick="useTemplate(\'' + esc(t.name).replace(/'/g, '&#39;') + '\')">' + esc(t.name) + '</button>'; }).join('');
  }).catch(function() {});
}
function useTemplate(name) {
  var t = TEMPLATES.filter(function(x) { return x.name === name; })[0]; if (!t) return;
  var ta = $('cap-text'); ta.value = (ta.value.trim() ? ta.value.replace(/\s+$/, '') + '\n\n' : '') + t.body; ta.focus();
  ta.scrollIntoView({ block: 'center', behavior: 'smooth' });
  try { localStorage.setItem('journal-draft', ta.value); } catch (e) {}
}

// --- Import ------------------------------------------------------------------
/*JOURNAL_PARSER*/
var PARSED = null;
function toggleImport(on) { $('import-card').style.display = on ? 'block' : 'none'; if (on) $('import-card').scrollIntoView({ behavior: 'smooth' }); }
(function() {
  var d = $('drop');
  ['dragenter', 'dragover'].forEach(function(ev) { d.addEventListener(ev, function(e) { e.preventDefault(); d.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function(ev) { d.addEventListener(ev, function(e) { e.preventDefault(); d.classList.remove('over'); }); });
  d.addEventListener('drop', function(e) { readFiles(e.dataTransfer.files); });
})();
function loadScript(src) { return new Promise(function(ok, bad) { var s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = bad; document.head.appendChild(s); }); }
function readFiles(list) {
  var files = Array.prototype.slice.call(list || []); if (!files.length) return;
  $('import-preview').innerHTML = '<div class="skeleton">Reading ' + files.length + ' file(s)…</div>';
  var needZip = files.some(function(f) { return /\.zip$/i.test(f.name); });
  (needZip && !window.fflate ? loadScript('https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js') : Promise.resolve()).then(function() {
    return Promise.all(files.map(function(f) {
      if (/\.zip$/i.test(f.name)) {
        return f.arrayBuffer().then(function(buf) {
          var out = fflate.unzipSync(new Uint8Array(buf)); var dec = new TextDecoder();
          return Object.keys(out).filter(function(n) { return /\.(md|markdown|txt)$/i.test(n) && n.indexOf('__MACOSX') < 0; })
            .map(function(n) { return { name: n, text: dec.decode(out[n]) }; });
        });
      }
      return f.text().then(function(t) { return [{ name: f.name, text: t }]; });
    }));
  }).then(function(groups) {
    PARSED = parseJournalMarkdown([].concat.apply([], groups));
    showPreview();
  }).catch(function(e) { $('import-preview').innerHTML = '<div class="skeleton">Could not read the files: ' + esc(e.message) + '</div>'; });
}
function showPreview() {
  var p = PARSED, n = p.entries.length;
  var count = function(f) { return p.entries.filter(function(e) { return e[f] != null && e[f] !== '' && !(Array.isArray(e[f]) && !e[f].length); }).length; };
  if (!n) {
    $('import-preview').innerHTML = '<div class="skeleton">No dated days found. Days need a date as the file name or as a heading, for example "## Tue, Jul 20, 2021" or "July 20th, 2021".' +
      (p.undated.length ? '<br>Sections without a date: ' + p.undated.slice(0, 8).map(function(u) { return esc(u.title); }).join(', ') : '') + '</div>';
    return;
  }
  var fields = [['Rose', 'rose'], ['Thorn', 'thorn'], ['Bud', 'bud'], ['Wins', 'key_wins'], ['Lesson', 'lesson'], ['Summary', 'summary'], ['Mood', 'mood'], ['Day score', 'day_score'], ['Tags', 'tags'], ['People', 'people']];
  var html = '<p style="margin-top:14px"><b class="mono">' + n + '</b> days from <b>' + esc(p.entries[0].date) + '</b> to <b>' + esc(p.entries[n - 1].date) + '</b>' +
    (p.templates.length ? ' · <b class="mono">' + p.templates.length + '</b> template' + (p.templates.length > 1 ? 's' : '') : '') +
    (p.undated.length ? ' · ' + p.undated.length + ' undated sections skipped' : '') + '</p>' +
    '<div class="legend" style="margin-top:4px">' + fields.map(function(f) { return '<span>' + f[0] + ' <b class="mono">' + count(f[1]) + '</b></span>'; }).join('') + '</div>' +
    '<table class="prev"><tr><th>Date</th><th>Rose</th><th>Thorn</th><th>Notes</th></tr>' +
    p.entries.slice(-5).reverse().map(function(e) {
      return '<tr><td class="mono">' + esc(e.date) + '</td><td>' + esc(e.rose || '') + '</td><td>' + esc(e.thorn || '') + '</td><td class="muted">' + esc(String(e.body || '').slice(0, 90)) + '</td></tr>';
    }).join('') + '</table>' +
    '<div class="cap-row"><span class="status" id="import-status"></span><span style="flex:1"></span><button class="btn" id="import-btn" onclick="runImport()">Import ' + n + ' days</button></div>';
  $('import-preview').innerHTML = html;
}
function runImport() {
  var p = PARSED, i = 0, done = 0; $('import-btn').disabled = true;
  function next() {
    if (i >= p.entries.length) {
      return (p.templates.length ? post('/api/journal/templates', { templates: p.templates }) : Promise.resolve()).then(function() {
        $('import-status').textContent = 'Imported ' + done + ' days' + (p.templates.length ? ' and ' + p.templates.length + ' template' + (p.templates.length > 1 ? 's' : '') : '') + '.';
        loadTemplates(); load(); checkEnrich();
      });
    }
    var batch = p.entries.slice(i, i + 200); i += 200;
    $('import-status').textContent = 'Importing ' + Math.min(i, p.entries.length) + ' of ' + p.entries.length + '…';
    return post('/api/journal/import', { entries: batch }).then(function(r) { done += r.imported; return next(); });
  }
  next().catch(function(e) { $('import-status').textContent = 'Import stopped: ' + e.message; $('import-btn').disabled = false; });
}

// --- Enrich ------------------------------------------------------------------
function checkEnrich() {
  api('/api/journal/enrich').then(function(r) {
    if (!r.remaining) return;
    var box = document.createElement('div'); box.className = 'ask-missing'; box.id = 'enrich-box';
    box.innerHTML = '<b class="mono">' + r.remaining + '</b> days have notes but no summary or mood. Claude can fill in summary, mood, themes and thorn cause. It never changes what you wrote. ' +
      'Estimated cost: <b>' + money(r.est_cost_usd) + '</b> on ' + esc(r.model) + '. <button class="btn" style="margin-left:6px" onclick="runEnrich(this)">Fill in with Claude</button>';
    var old = $('enrich-box'); if (old) old.remove();
    $('import-preview').appendChild(box);
  }).catch(function() {});
}
function runEnrich(btn) {
  btn.disabled = true; var spent = 0, done = 0;
  function step() {
    return post('/api/journal/enrich', {}).then(function(r) {
      spent += r.cost_usd || 0; done += r.enriched;
      btn.textContent = done + ' done · ' + r.remaining + ' left · ' + money(spent);
      if (r.remaining && r.enriched) return step();
      btn.textContent = 'Done: ' + done + ' days · ' + money(spent); load();
    });
  }
  step().catch(function(e) { btn.textContent = 'Stopped: ' + e.message; btn.disabled = false; });
}

loadTemplates();
load();
</script>
</body>
</html>`;
