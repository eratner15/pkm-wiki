# Living Journal

The Living Journal moves the Notion **Daily Journal** into the PKM Wiki. The PKM keeps every entry in D1, shows a dashboard at `/journal`, and uses Claude to file new entries and find patterns.

## Why it exists

Filing entries through Notion was slow, because the Notion connector asks for access on every page. The PKM now holds the data, so:

- You import your markdown export once. Notion is not needed.
- New entries go straight into the PKM, with your templates one click away.
- The dashboard reads from D1, so page loads cost nothing.

## Architecture

| Part | Where | What it does |
|---|---|---|
| `journal_entries` | D1 | One row per day: Rose, Thorn, Bud, wins, lesson, mood, score, energy, tags, people, places, full notes |
| `journal_fts` | D1 | Full-text search over titles, summaries, roses, thorns and notes |
| `journal_insights` | D1 | Cached Claude insights per period |
| `journal_names` | D1 | People and Places names from Notion relations |
| `src/journal.ts` | Worker | Schema, Notion sync, import, stats, Claude calls |
| `src/journal-routes.ts` | Worker | `/journal` page, `/api/journal/*`, cron |
| `src/journal-page.ts` | Worker | Dashboard HTML |
| `src/journal-parse.ts` | Browser | Markdown parser for the Import panel (`npm test` runs its tests) |
| `scripts/import-notion-export.mjs` | Local | Optional: import a Notion "Markdown & CSV" export from the command line |

The Worker creates the tables on first use. `schema.sql` holds the same statements.

### Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/journal` | Dashboard |
| GET | `/api/journal/stats` | All dashboard aggregates in one D1 batch |
| GET | `/api/journal/entries?from=&to=&q=&limit=` | List or search entries |
| GET | `/api/journal/entries/:id` | One entry with full notes |
| POST | `/api/journal/capture` | `{ text, date?, day_score?, energy? }`: Claude files the entry |
| POST | `/api/journal/sync` | `{ bodies?, full? }`: pull changes from Notion |
| POST | `/api/journal/import` | `{ entries: [...] }`: bulk upsert, up to 500 per call |
| GET/POST | `/api/journal/insights` | Read or generate `{ period: week \| month \| quarter \| all, force? }` |
| POST | `/api/journal/ask` | `{ question }`: answer from your own entries, with dates |
| GET/POST | `/api/journal/templates` | List templates, or save imported ones `{ templates: [{ name, body }] }` |
| GET/POST | `/api/journal/enrich` | GET: days without a summary and the estimated cost. POST: fill in the next 8 |

### Cron

| Schedule (UTC) | Job |
|---|---|
| `7 * * * *` | Notion sync, only when `NOTION_TOKEN` is set |
| `10 12 * * 1` | Weekly insight for the last 7 days |

## One-time setup: import your markdown

1. Open `/journal` and click **Import**.
2. Drop the markdown file. A Roam export `.zip` also works.
3. Check the preview: number of days, date range, and how many days have each field.
4. Click **Import**. Sections titled "Template" are saved as templates.
5. If some days have notes but no summary or mood, click **Fill in with Claude**. The button shows the cost first. Claude fills empty fields only and never changes what you wrote.

The parser reads your file in the browser. It accepts:

| Format | Example |
|---|---|
| A file per day, named by date | `July 20th, 2021.md` (Roam) |
| A heading per day in one file | `## Tue, Jul 20, 2021`, `# 2021-07-20`, `### July 20th, 2021` |
| Roam attributes | `Rose:: Golf with Dan` |
| Bold or plain labels | `**Rose:** …`, `- Thorn: …` |
| A label with nested bullets | `- Thorn` then an indented `- neck pain` |
| A label heading | `### Goals for tomorrow` then `- [ ] gym` (open items become the Next Action) |
| Table rows | `\| Rose \| Golf \|` |

Each day gets a fixed ID from its date. Importing the same file again updates the same days. It does not create duplicates.

**Privacy:** this repository is public. Never commit a journal export to it. The import sends the file only to your own Worker, which sits behind `PKM_PASSWORD`.

## Templates

The entry box shows template buttons. A click adds the template to the text.

- **Daily:** Rose, Thorn, Bud, Key Wins, Lesson, Day in Review, Goals for tomorrow (the Roam layout)
- **Thinking Templates** (Cortex Futura and Dalio's Principles): Issue Log, Choice, Pain Button, Difference Engine, I Want, Disagreement Check
- Templates found in your import

When a new thorn repeats a cause you logged before, the page offers the Issue Log. It offers the Pain Button when the thorn theme is Mindset.

## Optional: Notion sync

You do not need Notion. If you want Notion and the PKM to stay in step:

1. Create an internal integration at [notion.so/profile/integrations](https://www.notion.so/profile/integrations) with "Read content" only.
2. In Notion, open **Living Journal**, then **•••**, then **Connections**, and add the integration.
3. Run `npx wrangler secret put NOTION_TOKEN`.

A **Sync Notion** button then shows on `/journal`, and an hourly cron pulls changes.

## Cost

Only these actions call Claude. Page loads, stats, search, import and sync never do.

| Action | When | Typical tokens | Cost on Opus 5.5 ($4 / $20 per M) |
|---|---|---|---|
| File an entry | You click **File entry** | ~1.5K in, ~0.6K out | ~$0.02 |
| Weekly insight | Monday cron or **Generate** | ~6K in, ~1.5K out | ~$0.05 |
| All-time insight | You click **Generate** | ≤ ~35K in, ~2K out | ~$0.18 |
| Ask your journal | You click **Ask** | ~5K in, ~0.4K out | ~$0.03 |
| Fill in imported days | One time, you click **Fill in with Claude** | ~1K in, ~0.3K out per day | ~$0.01 per day; the button shows the total first |

A daily entry, a weekly insight and a few questions cost about **$1 a month**. The footer of `/journal` shows the month-to-date spend from `activity_log`.

Cost controls in the code:

- An insight is cached in `journal_insights`. It stays until an entry in its window changes. **Generate** reuses the cache.
- Long windows send one compact line per day. They do not send the full notes. Above ~120K characters, the code thins the lines evenly.
- Effort is `low` for filing, asking and weekly insights. Effort is `medium` for longer periods.
- Every call goes through the Cloudflare AI Gateway, so logs and caching are in one place.

To cut cost about 40x, set `JOURNAL_MODEL = "claude-haiku-5-5"` in `wrangler.toml`. Quality on pattern-finding is lower.

## Data rules

The rules follow the Living Journal page in Notion:

- Claude keeps your own words for Rose, Thorn, Bud, wins and lessons.
- Claude never invents a Rose, Thorn, Bud, win, lesson or next action. A missing field shows on screen once after you file.
- **Mood** is Claude's inference. **Day Score** is your own rating. Insights treat Day Score as the stronger signal.
- Filing twice on the same day appends to that day. It does not create a second entry.
