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

/* Editorial dashboard */
.wrap { max-width: 1140px; padding-top: 8px; }
.masthead { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--border); margin-bottom: 36px; flex-wrap: wrap; }
.brand { font-family: var(--serif); font-size: 24px; letter-spacing: -0.01em; } .brand span { color: var(--accent); }
.eyebrow { font-size: 11px; letter-spacing: .16em; text-transform: uppercase; color: var(--dim); font-weight: 600; }
.mono-num { font-family: var(--serif); font-variant-numeric: tabular-nums lining-nums; }
.hero { display: grid; grid-template-columns: 1.05fr 1fr; gap: 48px; align-items: end; padding-bottom: 32px; border-bottom: 1px solid var(--border); }
.hero-line { display: flex; align-items: flex-end; gap: 16px; margin-top: 10px; }
.hero-num { font-size: 132px; line-height: .8; letter-spacing: -0.04em; }
.hero-num small { font-size: 30px; color: var(--faint); letter-spacing: 0; margin-left: 4px; }
.delta { display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 13px; padding: 4px 10px; border-radius: 20px; border: 1px solid var(--border); margin-bottom: 10px; white-space: nowrap; }
.delta.up { color: var(--rose); border-color: color-mix(in srgb, var(--rose) 40%, var(--border)); }
.delta.down { color: var(--thorn); border-color: color-mix(in srgb, var(--thorn) 40%, var(--border)); }
.brief { font-family: var(--serif); font-size: 27px; line-height: 1.28; margin-top: 22px; letter-spacing: -0.005em; }
.brief em { font-style: normal; color: var(--accent); }
.minis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-top: 18px; border-top: 1px solid var(--border); padding-top: 14px; }
.mini .v { font-family: var(--serif); font-size: 28px; line-height: 1; font-variant-numeric: tabular-nums; }
.mini .l { font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: var(--dim); margin-top: 6px; }
.today-bar { display: flex; align-items: center; gap: 16px; padding: 18px 0; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.today-bar .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--faint); flex: none; }
.today-bar .dot.ok { background: var(--rose); }
.today-bar .txt { flex: 1; min-width: 200px; font-size: 15px; }
.signals { display: grid; grid-template-columns: repeat(3, 1fr); border-bottom: 1px solid var(--border); }
.signal { padding: 28px 28px 28px 0; }
.signal + .signal { padding-left: 28px; border-left: 1px solid var(--border); }
.signal .big { font-family: var(--serif); font-size: 25px; line-height: 1.2; margin: 10px 0 8px; }
.signal .ev { font-size: 13px; color: var(--dim); line-height: 1.5; }
.signal .ev b { color: var(--text); font-weight: 600; font-family: var(--mono); font-size: 12px; }
.section { padding: 40px 0; border-bottom: 1px solid var(--border); }
.section-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; margin-bottom: 22px; }
.section-head h2 { font-family: var(--serif); font-weight: 400; font-size: 34px; letter-spacing: -0.01em; margin-top: 6px; }
.section-head .sub { margin-top: 4px; max-width: 62ch; }
.col-h { font-family: var(--serif); font-weight: 400; font-size: 24px; margin: 6px 0 8px; }
.cols3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 40px; }
.cols2 { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; }
.drv { display: grid; grid-template-columns: minmax(120px, 210px) 1fr 1fr 118px; align-items: center; gap: 0 12px; padding: 7px 0; border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); font-size: 14px; }
.drv:hover { background: var(--raised); }
.drv .nm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.drv .nm .k { font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); margin-left: 6px; }
.drv .neg, .drv .pos { height: 14px; position: relative; }
.drv .neg { border-right: 1px solid var(--dim); }
.drv .neg i { position: absolute; right: 2px; top: 0; height: 100%; background: var(--thorn); border-radius: 4px 0 0 4px; }
.drv .pos i { position: absolute; left: 2px; top: 0; height: 100%; background: var(--rose); border-radius: 0 4px 4px 0; }
.drv .val { font-family: var(--mono); font-size: 12px; text-align: right; color: var(--dim); white-space: nowrap; }
.drv .val b { color: var(--text); font-weight: 600; }
.drv-axis { display: grid; grid-template-columns: minmax(120px, 210px) 1fr 1fr 118px; gap: 0 12px; font-size: 11px; color: var(--faint); padding-bottom: 6px; }
.drv-axis span:nth-child(2) { text-align: right; padding-right: 6px; } .drv-axis span:nth-child(3) { padding-left: 6px; }
@media (max-width: 860px) {
  .hero, .cols3, .cols2 { grid-template-columns: 1fr; gap: 28px; }
  .hero-num { font-size: 96px; }
  .brief { font-size: 22px; }
  .signals { grid-template-columns: 1fr; }
  .signal, .signal + .signal { padding: 22px 0; border-left: 0; }
  .signal + .signal { border-top: 1px solid var(--border); }
  .minis { grid-template-columns: repeat(2, 1fr); }
  .drv, .drv-axis { grid-template-columns: 110px 1fr 1fr 84px; font-size: 13px; }
  .masthead { margin-bottom: 24px; }
  .masthead .top-actions { flex-wrap: nowrap; overflow-x: auto; width: 100%; padding-bottom: 2px; }
  .masthead .top-actions > * { flex: none; }
  #today-label { display: none; }
}
</style>
</head>
<body>
<div class="wrap">
  <header class="masthead">
    <div class="brand">Living <span>Journal</span></div>
    <div class="top-actions">
      <span class="status" id="sync-status"></span>
      <span class="eyebrow" id="today-label"></span>
      <a class="btn-ghost" href="/journal/people">People</a>
      <span id="book-links"></span>
      <button class="btn-ghost" onclick="toggleReminder()">Reminder</button>
      <button class="btn-ghost" onclick="toggleImport(true)">Import</button>
      <button class="btn-ghost" id="sync-btn" onclick="syncNow()" style="display:none">Sync Notion</button>
      <a class="btn-ghost" href="/">Wiki</a>
      <button class="btn-ghost" onclick="toggleTheme()" id="theme-btn" aria-label="Toggle theme">&#9790;</button>
    </div>
  </header>

  <div id="setup"></div>

  <section class="card" id="import-card" style="display:none;margin-bottom:24px;border-color:var(--accent)">
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

  <section class="card" id="reminder-card" style="display:none;margin-bottom:24px">
    <div class="card-head"><div><h2>Nightly reminder</h2><div class="sub">Sent on Telegram every evening (01:07 UTC, about 9 pm in New York). Reply to it, or send /j and your day, and it is filed as today's entry. /onthisday shows past years.</div></div>
      <button class="btn-ghost" onclick="toggleReminder()">Close</button></div>
    <pre id="reminder-text" style="white-space:pre-wrap;font-family:var(--sans);font-size:14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px"></pre>
    <div class="cap-row"><span class="status" id="reminder-status"></span><span style="flex:1"></span><button class="btn" onclick="sendReminder(this)">Send it now</button></div>
  </section>

  <!-- 1. The answer first -->
  <section class="hero" id="hero">
    <div>
      <div class="eyebrow">Last 30 days · mood</div>
      <div class="hero-line"><div class="hero-num mono-num" id="hero-num">–</div><div id="hero-delta"></div></div>
      <p class="brief" id="brief">Loading your journal…</p>
    </div>
    <div>
      <div class="chart" id="spark"></div>
      <div class="minis" id="minis"></div>
    </div>
  </section>

  <!-- 2. Today -->
  <section class="today-bar" id="today-bar"></section>

  <!-- Capture (opens from the Today bar) -->
  <section class="card" id="capture-card" style="display:none;margin:20px 0">
    <div class="card-head">
      <div><h2>Tell me about today</h2><div class="sub">Dump your day in any order. Claude files the Rose, Thorn, Bud, wins and people. Missing parts get asked once, never invented.</div></div>
      <div class="top-actions"><input type="date" id="cap-date"><button class="btn-ghost" onclick="toggleCapture(false)">Close</button></div>
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

  <!-- 3. Signals -->
  <section class="signals" id="signals"></section>

  <!-- 4. What moves your mood -->
  <section class="section">
    <div class="section-head">
      <div><div class="eyebrow">Drivers</div><h2>What moves your mood</h2>
        <div class="sub">Average mood on days with each factor, against your overall average. Factors with fewer than 5 days are left out.</div></div>
      <div class="seg" id="driver-filter"><button data-k="all" class="on">All</button><button data-k="Theme">Themes</button><button data-k="Person">People</button><button data-k="time">Energy &amp; days</button></div>
    </div>
    <div id="drivers"></div>
  </section>

  <!-- 5. Trend and year -->
  <section class="section">
    <div class="section-head">
      <div><div class="eyebrow">Trend</div><h2>Mood over time</h2><div class="sub">The line is a 3-month average, 1–10. Faint lines are monthly values. Mood is inferred by Claude from each entry; Day Score is your own rating.</div></div>
      <div class="seg" id="trend-range"><button data-r="12">1Y</button><button data-r="36">3Y</button><button data-r="0" class="on">All</button></div>
    </div>
    <div class="chart" id="trend"></div>
    <div class="legend" id="trend-legend"></div>
  </section>

  <section class="section">
    <div class="section-head"><div><div class="eyebrow">Consistency</div><h2>The last year</h2><div class="sub">One square per day. Darker amber means a better day. Outlined means journaled, no mood yet.</div></div></div>
    <div class="heat chart" id="heat"></div>
    <div class="legend" id="heat-legend"></div>
  </section>

  <!-- 6. Claude -->
  <section class="section insight">
    <div class="section-head">
      <div><div class="eyebrow">Analysis</div><h2>Claude's read</h2><div class="sub" id="insight-meta">Patterns, energizers, drains and small experiments, tied to your own principles in the wiki</div></div>
      <div class="top-actions">
        <div class="seg" id="insight-range"><button data-p="week" class="on">Week</button><button data-p="month">Month</button><button data-p="quarter">Quarter</button><button data-p="all">All time</button></div>
        <button class="btn" id="insight-btn" onclick="generateInsight(false)">Generate</button>
      </div>
    </div>
    <div id="insight"><div class="skeleton">No insight for this period yet. Generate one; it is cached until new entries arrive.</div></div>
  </section>

  <!-- 7. Archive -->
  <section class="section cols3">
    <div><div class="eyebrow">Memory</div><h3 class="col-h">On this day</h3><ul class="list" id="otd"></ul></div>
    <div><div class="eyebrow">Last 14 days</div><h3 class="col-h">Next actions</h3><ul class="list" id="actions"></ul></div>
    <div><div class="eyebrow">In your words</div><h3 class="col-h">Lessons</h3><ul class="list" id="lessons"></ul></div>
  </section>

  <section class="section cols2">
    <div><div class="eyebrow">Fix these first</div><h3 class="col-h">Recurring thorn causes</h3><ul class="list" id="causes"></ul></div>
    <div><div class="eyebrow">Most mentioned</div><h3 class="col-h">People <a href="/journal/people" class="muted" style="font-size:13px;font-family:var(--sans)">All people →</a></h3><ul class="list" id="people"></ul></div>
  </section>

  <section class="section cols2">
    <div><div class="eyebrow">Search</div><h3 class="col-h">Ask your journal</h3>
      <div class="cap-row"><input type="text" id="ask-q" placeholder="When was I happiest at work? What helps my anxiety?" style="flex:1;min-width:200px"><button class="btn" id="ask-btn" onclick="ask()">Ask</button></div>
      <div id="ask-a" style="margin-top:12px"></div></div>
    <div><div class="eyebrow">Archive</div><h3 class="col-h" style="display:flex;justify-content:space-between;gap:12px;align-items:center">Entries <input type="text" id="search" placeholder="Search entries" oninput="searchSoon()"></h3>
      <ul class="list" id="recent"></ul></div>
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
    $('brief').textContent = 'Could not load the journal: ' + e.message;
  });
}

function render() {
  var t = S.totals;
  $('setup').innerHTML = !t.entries ? setupHTML() : '';
  $('sync-btn').style.display = S.notion_connected ? '' : 'none';
  $('today-label').textContent = new Date(S.today + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  renderHero(); renderToday(); renderSignals(); renderDrivers();

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
    var name = p.id ? '<a href="/journal/people/' + esc(p.id) + '">' + esc(p.name) + '</a>' : esc(p.name);
    return '<li style="display:flex;justify-content:space-between"><span>' + name + '</span><span class="mono muted">' + p.n + ' days · last ' + esc(p.last) + '</span></li>';
  }).join('') || empty('No people yet. <a href="/journal/people">Add people</a>');

  renderRecent(S.recent);
  $('foot').textContent = 'AI spend this month: ' + money(S.ai_cost_month_usd || 0) + ' · model ' + S.model +
    (S.last_sync ? ' · last Notion sync ' + new Date(S.last_sync).toLocaleString() : '') +
    ' · ' + (t.with_body || 0) + ' of ' + (t.entries || 0) + ' entries have full notes';
  renderCharts();
  loadInsight();
}

// --- The answer first ---------------------------------------------------------
function num(x) { return x == null || isNaN(x) ? null : Number(x); }
function f1(x) { return x == null ? '–' : Number(x).toFixed(1); }
function signed(x) { return (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(x).toFixed(1); }
function daysAgo(n) { return new Date(Date.parse(S.today) - n * 86400000).toISOString().slice(0, 10); }
function avgOf(rows) { var v = rows.map(function(r) { return num(r.v); }).filter(function(x) { return x != null; }); return v.length ? v.reduce(function(a, b) { return a + b; }, 0) / v.length : null; }
function drivers() {
  var I = S.insight_inputs || {}, base = num((I.overall || {}).v);
  if (base == null) return [];
  return (I.drivers || []).filter(function(d) { return d.v != null; }).map(function(d) {
    return { kind: d.kind, label: d.label, n: d.n, v: Number(d.v), delta: Number(d.v) - base, person_id: d.person_id };
  });
}
function nice(d) {
  if (d.kind === 'Theme') return d.label + ' days';
  if (d.kind === 'Energy') return d.label.replace(' energy', '-energy') + ' days';
  if (d.kind === 'Person') return 'Days with ' + d.label;
  return d.label;
}
function niceInline(d) {
  var t = nice(d);
  return d.kind === 'Theme' || d.kind === 'Energy' ? t.charAt(0).toLowerCase() + t.slice(1) : d.kind === 'Person' ? 'days with ' + d.label : t;
}

function renderHero() {
  var I = S.insight_inputs || {}, daily = I.daily90 || [];
  var last30 = daily.filter(function(r) { return r.d > daysAgo(30); });
  var v30 = avgOf(last30), prior = num((I.prior30 || {}).v), base = num((I.overall || {}).v);
  $('hero-num').innerHTML = v30 == null ? '–' : f1(v30) + '<small>/10</small>';
  var dEl = $('hero-delta');
  if (v30 != null && prior != null) {
    var d = v30 - prior, cls = d > 0.05 ? 'up' : d < -0.05 ? 'down' : '';
    dEl.innerHTML = '<span class="delta ' + cls + '">' + (d > 0.05 ? '▲' : d < -0.05 ? '▼' : '■') + ' ' + signed(d) + ' vs prior 30 days</span>';
  } else dEl.innerHTML = '';

  var ds = drivers(), pos = ds.filter(function(d) { return d.delta >= 0.3; }).sort(function(a, b) { return b.delta - a.delta; });
  var neg = ds.filter(function(d) { return d.delta <= -0.3; }).sort(function(a, b) { return a.delta - b.delta; });
  var parts = [];
  if (v30 != null && prior != null) {
    var dd = v30 - prior;
    parts.push(Math.abs(dd) < 0.15 ? 'You are holding steady.' : dd > 0 ? 'Your month is better than the one before.' : 'Your month is harder than the one before.');
  } else if (base != null) parts.push('Your long-run average is ' + f1(base) + '.');
  if (pos.length) parts.push('Your best days are <em>' + esc(niceInline(pos[0])) + '</em> (' + signed(pos[0].delta) + ')' + (pos[1] ? ' and <em>' + esc(niceInline(pos[1])) + '</em> (' + signed(pos[1].delta) + ')' : '') + '.');
  if (neg.length) parts.push('<em>' + esc(nice(neg[0])) + '</em> cost you ' + Math.abs(neg[0].delta).toFixed(1) + ' points.');
  $('brief').innerHTML = parts.length ? parts.join(' ') : 'Import your journal to see what moves your mood.';

  var yr = num((I.year || {}).v), pyr = num((I.prior_year || {}).v);
  var minis = [
    [S.totals.entries || 0, 'Days written'],
    [(S.totals.current_streak || 0) + 'd', 'Streak · best ' + (S.totals.longest_streak || 0)],
    [yr == null ? '–' : f1(yr) + (pyr != null ? ' <span class="muted" style="font-size:14px">' + signed(yr - pyr) + '</span>' : ''), 'Last 12 months'],
    [(S.next_actions || []).length, 'Open actions'],
  ];
  $('minis').innerHTML = minis.map(function(m) { return '<div class="mini"><div class="v">' + m[0] + '</div><div class="l">' + esc(m[1]) + '</div></div>'; }).join('');
  renderSpark(daily, base);
}

function renderSpark(daily, base) {
  var host = $('spark'); host.innerHTML = '';
  if (!daily.length) { host.innerHTML = '<div class="skeleton">The last 90 days appear here.</div>'; return; }
  var W = host.clientWidth || 520, H = 170, L = 4, R = 4, T = 12, B = 20;
  var t0 = Date.parse(daysAgo(89)), t1 = Date.parse(S.today);
  var x = function(d) { return L + (Date.parse(d) - t0) / (t1 - t0) * (W - L - R); };
  var vals = daily.map(function(r) { return num(r.v); }).filter(function(v) { return v != null; }).concat(base != null ? [base] : []);
  var lo = Math.max(1, Math.floor(Math.min.apply(null, vals)) - 0.5), hi = Math.min(10, Math.ceil(Math.max.apply(null, vals)) + 0.5);
  var y = function(v) { return T + (hi - v) / (hi - lo) * (H - T - B); };
  var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img', 'aria-label': 'Daily mood, last 90 days, with a 14-day rolling average' });
  if (base != null) {
    svg.appendChild(svgEl('line', { x1: L, x2: W - R, y1: y(base), y2: y(base), stroke: css('--dim'), 'stroke-dasharray': '3 4', 'stroke-width': 1 }));
  }
  daily.forEach(function(r) { if (r.v != null) svg.appendChild(svgEl('circle', { cx: x(r.d), cy: y(r.v), r: 2.5, fill: css('--faint') })); });
  // 14-day rolling average
  var pts = [];
  for (var i = 0; i < 90; i += 2) {
    var end = daysAgo(89 - i), start = new Date(Date.parse(end) - 13 * 86400000).toISOString().slice(0, 10);
    var a = avgOf(daily.filter(function(r) { return r.d >= start && r.d <= end; }));
    if (a != null) pts.push([x(end), y(a), end, a]);
  }
  if (pts.length > 1) svg.appendChild(svgEl('path', { d: 'M' + pts.map(function(p) { return p[0] + ' ' + p[1]; }).join('L'), fill: 'none', stroke: css('--accent'), 'stroke-width': 2.2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  if (pts.length) { var lp = pts[pts.length - 1]; svg.appendChild(svgEl('circle', { cx: lp[0], cy: lp[1], r: 4.5, fill: css('--accent'), stroke: css('--bg'), 'stroke-width': 2 })); }
  [89, 60, 30, 0].forEach(function(n) {
    var t = svgEl('text', { x: x(daysAgo(n)), y: H - 4, 'text-anchor': n === 89 ? 'start' : n === 0 ? 'end' : 'middle', fill: css('--faint'), 'font-size': 10, 'font-family': css('--mono') });
    t.textContent = n === 0 ? 'today' : n + 'd'; svg.appendChild(t);
  });
  var tip = document.createElement('div'); tip.className = 'tip';
  svg.addEventListener('mousemove', function(ev) {
    var rect = svg.getBoundingClientRect(), px = (ev.clientX - rect.left) * W / rect.width, best = null;
    pts.forEach(function(p) { if (!best || Math.abs(p[0] - px) < Math.abs(best[0] - px)) best = p; });
    if (!best) return;
    tip.innerHTML = '<b>' + fmtDate(best[2]) + '</b><br>14-day average ' + f1(best[3]);
    tip.style.opacity = 1; tip.style.left = Math.min(rect.width - 150, Math.max(0, best[0] * rect.width / W - 70)) + 'px'; tip.style.top = '0px';
  });
  svg.addEventListener('mouseleave', function() { tip.style.opacity = 0; });
  host.appendChild(svg); host.appendChild(tip);
  var lg = document.createElement('div'); lg.className = 'legend'; lg.style.marginTop = '2px';
  lg.innerHTML = '<span><i style="background:' + css('--accent') + '"></i>14-day average</span><span><i style="background:' + css('--faint') + ';border-radius:50%"></i>One day</span>' +
    (base != null ? '<span><i style="height:0;border-top:1px dashed ' + css('--dim') + ';border-radius:0"></i>Your average ' + f1(base) + '</span>' : '');
  host.appendChild(lg);
}

function renderToday() {
  var T = (S.insight_inputs || {}).today;
  $('today-bar').innerHTML = T
    ? '<span class="dot ok"></span><div class="txt"><b>Today is logged.</b> <span class="muted">' + esc(T.rose ? 'Rose: ' + T.rose : T.summary || '') + '</span></div><button class="btn-ghost" onclick="openEntry(\'' + T.id + '\')">Open</button><button class="btn" onclick="toggleCapture(true)">Add to today</button>'
    : '<span class="dot"></span><div class="txt"><b>Today is not logged yet.</b> <span class="muted">Two minutes: rose, thorn, bud, one win.</span></div><button class="btn" onclick="toggleCapture(true)">Write today</button>';
}
function toggleCapture(on) {
  $('capture-card').style.display = on ? 'block' : 'none';
  if (on) { $('capture-card').scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(function() { $('cap-text').focus(); }, 300); }
}

function renderSignals() {
  var ds = drivers(), I = S.insight_inputs || {};
  var pos = ds.filter(function(d) { return d.delta > 0; }).sort(function(a, b) { return b.delta - a.delta; }).slice(0, 3);
  var neg = ds.filter(function(d) { return d.delta < 0; }).sort(function(a, b) { return a.delta - b.delta; }).slice(0, 3);
  var ev = function(list) { return list.map(function(d) { return esc(nice(d)) + ' <b>' + signed(d.delta) + '</b> <span class="faint">(' + d.n + ' days)</span>'; }).join('<br>'); };
  var w = (I.watch || [])[0], open = (S.next_actions || []).length;
  var cards = [
    ['What lifts you', pos.length ? esc(nice(pos[0])) : 'Not enough data yet', pos.length ? ev(pos) : 'Needs days with a mood or score.'],
    ['What drains you', neg.length ? esc(nice(neg[0])) : 'Not enough data yet', neg.length ? ev(neg) : 'Needs days with a mood or score.'],
    ['Watch', w ? '“' + esc(w.cause.charAt(0).toUpperCase() + w.cause.slice(1)) + '” is back' : open ? open + ' open actions' : 'Nothing repeating',
      w ? '<b>' + w.n + '×</b> in the last 60 days, last on ' + esc(fmtDate(w.last)) + '. A repeated cause is where the <a href="#" onclick="toggleCapture(true);useTemplate(\'Issue Log\');return false">Issue Log</a> pays off.'
        : open ? 'From the last 14 days. They also go out in the nightly reminder.' : 'No thorn cause repeated in the last 60 days.'],
  ];
  $('signals').innerHTML = cards.map(function(c, i) {
    return '<div class="signal"><div class="eyebrow" style="color:' + (i === 0 ? 'var(--rose)' : i === 1 ? 'var(--thorn)' : 'var(--accent)') + '">' + c[0] + '</div><div class="big">' + c[1] + '</div><div class="ev">' + c[2] + '</div></div>';
  }).join('');
}

var driverKind = 'all';
function renderDrivers() {
  var ds = drivers().filter(function(d) {
    return driverKind === 'all' || (driverKind === 'time' ? (d.kind === 'Energy' || d.kind === 'Day') : d.kind === driverKind);
  }).filter(function(d) { return Math.abs(d.delta) >= 0.1; });
  if (!ds.length) { $('drivers').innerHTML = '<div class="skeleton">Drivers appear once days have a mood or score' + (driverKind === 'Person' ? ' and people are added' : '') + '.</div>'; return; }
  var pos = ds.filter(function(d) { return d.delta > 0; }).sort(function(a, b) { return b.delta - a.delta; }).slice(0, 8);
  var neg = ds.filter(function(d) { return d.delta < 0; }).sort(function(a, b) { return b.delta - a.delta; }).slice(-7);
  var list = pos.concat(neg), max = Math.max.apply(null, list.map(function(d) { return Math.abs(d.delta); }).concat([0.5]));
  var row = function(d) {
    var w = Math.max(2, Math.abs(d.delta) / max * 100) + '%';
    var nm = d.person_id ? '<a href="/journal/people/' + esc(d.person_id) + '" style="color:inherit">' + esc(d.label) + '</a>' : esc(d.label);
    return '<div class="drv" title="' + esc(d.label) + ': average ' + d.v.toFixed(1) + ' on ' + d.n + ' days (' + signed(d.delta) + ' against your average)">' +
      '<span class="nm">' + nm + '<span class="k">' + esc(d.kind) + '</span></span>' +
      '<span class="neg">' + (d.delta < 0 ? '<i style="width:' + w + '"></i>' : '') + '</span>' +
      '<span class="pos">' + (d.delta > 0 ? '<i style="width:' + w + '"></i>' : '') + '</span>' +
      '<span class="val"><b>' + signed(d.delta) + '</b> · ' + d.n + 'd</span></div>';
  };
  $('drivers').innerHTML = '<div class="drv-axis"><span></span><span>◀ lower than average</span><span>higher than average ▶</span><span style="text-align:right">vs avg · days</span></div>' + list.map(row).join('');
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

function renderCharts() { renderTrend(); renderHeat(); }

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
  // Monthly values stay faint; a 3-month rolling average of the day value carries the story.
  var roll = months.map(function(mo, i) {
    var w = months.slice(Math.max(0, i - 2), i + 1).map(function(m) { var r = by[m]; return r ? (r.score != null ? r.score : r.mood) : null; }).filter(function(v) { return v != null; });
    return w.length ? w.reduce(function(a, b) { return a + b; }, 0) / w.length : null;
  });
  var faint = svgEl('g', { opacity: 0.35 }); svg.appendChild(faint);
  var keep = svg; svg = faint; line('mood', css('--dim')); if (hasScore) line('score', css('--score')); svg = keep;
  var rd = '', pen2 = false;
  roll.forEach(function(v, i) { if (v != null) { rd += (pen2 ? 'L' : 'M') + x(i) + ' ' + y(v); pen2 = true; } else pen2 = false; });
  svg.appendChild(svgEl('path', { d: rd, fill: 'none', stroke: css('--accent'), 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  // Label the best and the hardest 3-month stretch.
  var bi = -1, wi = -1;
  roll.forEach(function(v, i) { if (v == null) return; if (bi < 0 || v > roll[bi]) bi = i; if (wi < 0 || v < roll[wi]) wi = i; });
  [[bi, 'best stretch', -10], [wi, 'hardest stretch', 18]].forEach(function(a) {
    if (a[0] < 0) return;
    svg.appendChild(svgEl('circle', { cx: x(a[0]), cy: y(roll[a[0]]), r: 4, fill: css('--accent'), stroke: css('--bg'), 'stroke-width': 2 }));
    var tx = svgEl('text', { x: x(a[0]), y: y(roll[a[0]]) + a[2], 'text-anchor': x(a[0]) > W - 90 ? 'end' : x(a[0]) < 90 ? 'start' : 'middle', fill: css('--text'), 'font-size': 11 });
    tx.textContent = a[1] + ' · ' + months[a[0]] + ' · ' + roll[a[0]].toFixed(1); svg.appendChild(tx);
  });
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
  $('trend-legend').innerHTML = '<span><i style="background:' + css('--accent') + '"></i>3-month average</span><span><i style="background:' + css('--dim') + ';opacity:.5"></i>Monthly mood (inferred)</span>' + (hasScore ? '<span><i style="background:' + css('--score') + ';opacity:.5"></i>Monthly Day Score (yours)</span>' : '');
}

function renderHeat() {
  var host = $('heat'); host.innerHTML = '';
  var by = {}; (S.heatmap || []).forEach(function(r) { by[r.date] = r; });
  var end = new Date(S.today + 'T12:00:00'); var start = new Date(end); start.setDate(start.getDate() - 364 - start.getDay());
  var weeks = Math.ceil((end - start) / 86400000 / 7) + 1, G = 3;
  var C = Math.max(9, Math.min(18, Math.floor(((host.clientWidth || 900) - 34) / weeks) - G));
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
seg('driver-filter', 'data-k', function(v) { driverKind = v; renderDrivers(); });
seg('insight-range', 'data-p', function(v) { insightPeriod = v; loadInsight(); });
var resizeTimer; window.addEventListener('resize', function() { clearTimeout(resizeTimer); resizeTimer = setTimeout(function() { if (S) { renderTrend(); renderHero(); } }, 150); });

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
function runLibrary() {
  var pages = PARSED.pages, i = 0, made = 0, had = 0; $('library-btn').disabled = true;
  function next() {
    if (i >= pages.length) { $('library-status').textContent = 'Library: ' + made + ' new pages added, ' + had + ' were already in the wiki.'; return; }
    var batch = pages.slice(i, i + 40); i += 40;
    $('library-status').textContent = 'Importing ' + Math.min(i, pages.length) + ' of ' + pages.length + '…';
    return post('/api/journal/library', { pages: batch }).then(function(r) { made += r.created; had += r.skipped_existing; return next(); });
  }
  next().catch(function(e) { $('library-status').textContent = 'Library import stopped: ' + e.message; $('library-btn').disabled = false; });
}
function showPreview() {
  var p = PARSED, n = p.entries.length;
  var count = function(f) { return p.entries.filter(function(e) { return e[f] != null && e[f] !== '' && !(Array.isArray(e[f]) && !e[f].length); }).length; };
  if (!n && p.pages.length) {
    $('import-preview').innerHTML = '<p style="margin-top:14px">No dated days in these files. <b class="mono">' + p.pages.length + '</b> knowledge pages for the Library.</p>' +
      '<div class="cap-row"><span class="status" id="library-status">Pages already in the wiki are skipped, never overwritten.</span><span style="flex:1"></span>' +
      '<button class="btn" id="library-btn" onclick="runLibrary()">Import ' + p.pages.length + ' pages to the Library</button></div>';
    return;
  }
  if (!n && !p.pages.length) {
    $('import-preview').innerHTML = '<div class="skeleton">No dated days found. Days need a date as the file name or as a heading, for example "## Tue, Jul 20, 2021" or "July 20th, 2021".' +
      (p.undated.length ? '<br>Sections without a date: ' + p.undated.slice(0, 8).map(function(u) { return esc(u.title); }).join(', ') : '') + '</div>';
    return;
  }
  var fields = [['Rose', 'rose'], ['Thorn', 'thorn'], ['Bud', 'bud'], ['Wins', 'key_wins'], ['Lesson', 'lesson'], ['Summary', 'summary'], ['Mood', 'mood'], ['Day score', 'day_score'], ['Tags', 'tags'], ['People', 'people']];
  var html = '<p style="margin-top:14px"><b class="mono">' + n + '</b> days from <b>' + esc(p.entries[0].date) + '</b> to <b>' + esc(p.entries[n - 1].date) + '</b>' +
    (p.templates.length ? ' · <b class="mono">' + p.templates.length + '</b> template' + (p.templates.length > 1 ? 's' : '') : '') +
    (p.pages.length ? ' · <b class="mono">' + p.pages.length + '</b> knowledge pages for the Library' : '') +
    (p.undated.length ? ' · ' + p.undated.length + ' undated sections skipped' : '') +
    (p.redactions ? ' · <b class="mono">' + p.redactions + '</b> secrets (API keys, tokens) removed before upload' : '') + '</p>' +
    '<div class="legend" style="margin-top:4px">' + fields.map(function(f) { return '<span>' + f[0] + ' <b class="mono">' + count(f[1]) + '</b></span>'; }).join('') + '</div>' +
    '<table class="prev"><tr><th>Date</th><th>Rose</th><th>Thorn</th><th>Notes</th></tr>' +
    p.entries.slice(-5).reverse().map(function(e) {
      return '<tr><td class="mono">' + esc(e.date) + '</td><td>' + esc(e.rose || '') + '</td><td>' + esc(e.thorn || '') + '</td><td class="muted">' + esc(String(e.body || '').slice(0, 90)) + '</td></tr>';
    }).join('') + '</table>' +
    '<div class="cap-row"><span class="status" id="import-status"></span><span style="flex:1"></span><button class="btn" id="import-btn" onclick="runImport()">Import ' + n + ' days</button></div>';
  if (p.pages.length) html += '<div class="cap-row"><span class="status" id="library-status">Pages already in the wiki are skipped, never overwritten.</span><span style="flex:1"></span>' +
    '<button class="btn-ghost" id="library-btn" onclick="runLibrary()">Import ' + p.pages.length + ' pages to the Library</button></div>';
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

// --- Reminder, Daybook links, deep links ----------------------------------------
function toggleReminder() {
  var c = $('reminder-card'), on = c.style.display === 'none'; c.style.display = on ? 'block' : 'none';
  if (on) { $('reminder-text').textContent = 'Loading…'; api('/api/journal/reminder').then(function(r) { $('reminder-text').textContent = r.text; }); }
}
function sendReminder(btn) {
  btn.disabled = true;
  post('/api/journal/reminder', {}).then(function(r) { $('reminder-status').textContent = r.sent ? 'Sent to Telegram.' : 'Not sent: TELEGRAM_CHAT_ID is not set.'; })
    .catch(function(e) { $('reminder-status').textContent = e.message; }).then(function() { btn.disabled = false; });
}
api('/api/journal/books').then(function(r) {
  var ys = (r.years || []).filter(function(y) { return y.days >= 5; });
  if (ys.length) $('book-links').innerHTML = '<select class="btn-ghost" onchange="if(this.value)location.href=\'/journal/book/\'+this.value" aria-label="Daybook volume"><option value="">Daybook</option>' +
    ys.map(function(y) { return '<option value="' + y.year + '">' + y.year + ' (' + y.days + ')</option>'; }).join('') + '</select>';
}).catch(function() {});
(function() { var m = location.search.match(/[?&]entry=([^&]+)/); if (m) openEntry(decodeURIComponent(m[1])); })();

loadTemplates();
load();
</script>
</body>
</html>`;

// --- People page (/journal/people and /journal/people/:id) -------------------------
const JOURNAL_CSS = PAGE.slice(PAGE.indexOf('<style>') + 7, PAGE.indexOf('</style>'));

export function peoplePageHTML(): string {
  return PEOPLE.replace('/*CSS*/', () => JOURNAL_CSS);
}

const PEOPLE = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>People</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Instrument+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>/*CSS*/
.pgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; }
.person { cursor: pointer; }
.person:hover { border-color: var(--accent); }
.person .nm { font-family: var(--serif); font-size: 24px; line-height: 1.1; }
.delta-up { color: var(--rose); } .delta-down { color: var(--thorn); }
.form-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <h1><a href="/journal/people" style="color:inherit">People</a></h1>
    <div class="top-actions">
      <a class="btn-ghost" href="/journal">Journal</a>
      <button class="btn-ghost" onclick="toggleTheme()" id="theme-btn" aria-label="Toggle theme">&#9790;</button>
    </div>
  </header>
  <div id="view"></div>
</div>
<script>
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function $(id) { return document.getElementById(id); }
function api(path, opts) { return fetch(path, opts).then(function(r) { return r.json().then(function(j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); }); }
function post(path, body) { return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); }
function fmtDate(d) { return d ? new Date(d + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '–'; }
function delta(x) { if (x == null) return '<span class="muted">mood –</span>'; var s = (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(x).toFixed(1);
  return '<span class="' + (x > 0.05 ? 'delta-up' : x < -0.05 ? 'delta-down' : 'muted') + '" title="Average mood on days with this person, compared with your overall average">mood ' + s + ' vs. average</span>'; }
function applyTheme(t) { document.documentElement.dataset.theme = t; $('theme-btn').innerHTML = t === 'light' ? '&#9728;' : '&#9790;'; }
function toggleTheme() { var t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; try { localStorage.setItem('pkm-theme', t); } catch (e) {} applyTheme(t); }
(function() { var t = 'dark'; try { t = localStorage.getItem('pkm-theme') || 'dark'; } catch (e) {} applyTheme(t); })();

function route() {
  var m = location.pathname.match(/^\/journal\/people\/([a-z0-9-]+)/);
  if (m) showPerson(m[1]); else showList();
}

function showList() {
  $('view').innerHTML = '<div class="skeleton">Loading…</div>';
  Promise.all([api('/api/journal/people'), api('/api/journal/people/suggest').catch(function() { return { suggestions: [] }; })]).then(function(res) {
    var list = res[0].people || [], sug = res[1].suggestions || [];
    var html = '<section class="card" style="margin-bottom:14px"><h2>Add a person</h2><div class="sub">Aliases catch other names for the same person, such as initials or a nickname. Every day that mentions any of them links to the person.</div>' +
      '<div class="form-row" style="margin-top:10px"><input type="text" id="p-name" placeholder="Name"><input type="text" id="p-aliases" placeholder="Aliases, comma separated" style="flex:1;min-width:180px">' +
      '<select id="p-circle" style="background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:7px"><option value="">Circle</option><option>Family</option><option>Friend</option><option>Work</option><option>Network</option><option>Other</option></select>' +
      '<button class="btn" onclick="addPerson()">Add</button></div><div class="status" id="p-status"></div></section>';
    if (sug.length) html += '<section class="card" style="margin-bottom:14px"><h2>Suggested</h2><div class="sub">Names that recur in your journal. Click to add.</div><div class="chips" style="margin-top:10px">' +
      sug.map(function(s) { return '<button class="chip tpl" onclick="quickAdd(this, \'' + esc(s.name).replace(/'/g, '&#39;') + '\')">' + esc(s.name) + ' <span class="muted">' + s.days + '</span></button>'; }).join('') + '</div></section>';
    html += list.length ? '<div class="pgrid">' + list.map(function(p) {
      return '<div class="card person" onclick="go(\'' + p.id + '\')"><div class="nm">' + esc(p.name) + '</div>' +
        '<div class="sub">' + esc([p.circle].concat(p.aliases || []).filter(Boolean).join(' · ')) + '</div>' +
        '<div style="margin-top:10px" class="mono"><b>' + p.days + '</b> days · last ' + fmtDate(p.last) + '</div><div style="font-size:12px;margin-top:2px">' + delta(p.mood_delta) + '</div></div>';
    }).join('') + '</div>' : '<div class="skeleton">No people yet. Add one above, or pick from the suggestions.</div>';
    $('view').innerHTML = html;
  }).catch(function(e) { $('view').innerHTML = '<div class="skeleton">' + esc(e.message) + '</div>'; });
}

function addPerson() {
  var name = $('p-name').value.trim(); if (!name) return;
  $('p-status').textContent = 'Linking days…';
  post('/api/journal/people', { name: name, aliases: $('p-aliases').value.split(',').map(function(s) { return s.trim(); }).filter(Boolean), circle: $('p-circle').value || null })
    .then(function(r) { go(r.person.id); }).catch(function(e) { $('p-status').textContent = e.message; });
}
function quickAdd(btn, name) { btn.disabled = true; post('/api/journal/people', { name: name }).then(function() { showList(); }).catch(function(e) { btn.textContent = e.message; }); }
function go(id) { history.pushState(null, '', '/journal/people/' + id); route(); }
window.addEventListener('popstate', route);

function showPerson(id) {
  $('view').innerHTML = '<div class="skeleton">Loading…</div>';
  Promise.all([api('/api/journal/people/' + id), api('/api/journal/people')]).then(function(res) {
    var p = res[0].person, row = (res[1].people || []).filter(function(x) { return x.id === id; })[0] || {};
    var themes = p.themes || [];
    var tlist = function(kind) { return themes.filter(function(t) { return t.kind === kind; }).slice(0, 4).map(function(t) { return esc(t.theme) + ' <span class="muted">' + t.n + '</span>'; }).join(' · ') || '<span class="muted">none yet</span>'; };
    $('view').innerHTML =
      '<section class="card" style="margin-bottom:14px"><div class="card-head"><div><div class="sub">' + esc([p.circle].concat(p.aliases).filter(Boolean).join(' · ')) + '</div>' +
      '<h2 style="font-size:40px">' + esc(p.name) + '</h2></div><button class="btn-ghost" onclick="removePerson(\'' + p.id + '\')">Remove</button></div>' +
      '<div class="grid g4" style="margin:0"><div class="kpi"><div class="label">Days</div><div class="value mono">' + p.days.length + '</div></div>' +
      '<div class="kpi"><div class="label">First</div><div class="value" style="font-size:22px">' + fmtDate(row.first) + '</div></div>' +
      '<div class="kpi"><div class="label">Last</div><div class="value" style="font-size:22px">' + fmtDate(row.last) + '</div></div>' +
      '<div class="kpi"><div class="label">Mood</div><div class="value" style="font-size:22px">' + delta(row.mood_delta) + '</div></div></div>' +
      '<p style="margin-top:12px"><span class="rose-t">Roses:</span> ' + tlist('rose') + '<br><span class="thorn-t">Thorns:</span> ' + tlist('thorn') + '</p>' +
      (p.seen_with.length ? '<p style="margin-top:6px"><span class="muted">Often with:</span> ' + p.seen_with.map(function(s) { return '<a href="#" onclick="go(\'' + s.id + '\');return false">' + esc(s.name) + '</a> <span class="muted">' + s.n + '</span>'; }).join(' · ') + '</p>' : '') +
      '<div class="form-row" style="margin-top:12px"><input type="text" id="e-aliases" value="' + esc(p.aliases.join(', ')) + '" placeholder="Aliases, comma separated" style="flex:1;min-width:200px"><button class="btn-ghost" onclick="saveAliases(\'' + p.id + '\', \'' + esc(p.name).replace(/'/g, '&#39;') + '\')">Save aliases</button><span class="status" id="e-status"></span></div></section>' +
      '<section class="card"><h2>Days</h2><ul class="list">' + (p.days.map(function(d) {
        return '<li><a href="/journal?entry=' + encodeURIComponent(d.id) + '" style="color:inherit"><div class="date">' + fmtDate(d.entry_date) + (d.mood != null ? ' · mood ' + d.mood : '') + '</div><div>' + esc(d.excerpt || d.summary || '') + '</div></a></li>';
      }).join('') || '<li class="faint">No days mention this person yet. Add an alias above.</li>') + '</ul></section>';
  }).catch(function(e) { $('view').innerHTML = '<div class="skeleton">' + esc(e.message) + '</div>'; });
}
function saveAliases(id, name) {
  $('e-status').textContent = 'Relinking…';
  post('/api/journal/people', { id: id, name: name, aliases: $('e-aliases').value.split(',').map(function(s) { return s.trim(); }).filter(Boolean) })
    .then(function() { showPerson(id); }).catch(function(e) { $('e-status').textContent = e.message; });
}
function removePerson(id) {
  if (!confirm('Remove this person? Your journal entries stay unchanged.')) return;
  api('/api/journal/people/' + id, { method: 'DELETE' }).then(function() { history.pushState(null, '', '/journal/people'); route(); });
}
route();
</script>
</body>
</html>`;
