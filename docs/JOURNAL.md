# Living Journal

The Living Journal moves the Notion **Daily Journal** into the PKM Wiki. The PKM keeps every entry in D1, shows a dashboard at `/journal`, and uses Claude to file new entries and find patterns.

## Why it exists

Filing entries through Notion was slow, because the Notion connector asks for access on every page. The PKM now holds the data, so:

- One Notion integration token replaces the per-page prompts.
- New entries can go straight into the PKM. Notion becomes optional.
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
| `scripts/import-notion-export.mjs` | Local | One-time import of a Notion "Markdown & CSV" export |

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

### Cron

| Schedule (UTC) | Job |
|---|---|
| `7 * * * *` | Notion sync: changed pages, then up to 25 page bodies |
| `10 12 * * 1` | Weekly insight for the last 7 days |

## One-time setup

### Option A: Notion API sync (recommended)

1. Open [notion.so/profile/integrations](https://www.notion.so/profile/integrations).
2. Create an internal integration named `PKM Journal`. Give it "Read content" only.
3. Copy the token.
4. In Notion, open **Living Journal**, click **•••**, then **Connections**, and add `PKM Journal`. All databases under the page share at once.
5. Save the token as a Worker secret: `npx wrangler secret put NOTION_TOKEN`.
6. Open `/journal` and click **Sync Notion**.

The first sync loads all entries at once. Page bodies take one or more Notion requests each, so each run fetches a batch. Click **Sync Notion** again to continue, or wait for the hourly cron. About 424 bodies take 6 to 10 clicks, or one day of hourly runs.

### Option B: Notion export (no token)

1. In Notion, open **Daily Journal**, click **•••**, then **Export**. Pick **Markdown & CSV** and turn on subpages.
2. Unzip the export.
3. Run:

   ```bash
   PKM_PASSWORD=... node scripts/import-notion-export.mjs ~/Downloads/notion-export
   ```

4. Add `--dry-run` first to check the parse.

The importer keeps the Notion page IDs. If you add the token later, the sync updates the same rows. It does not create duplicates.

## Cost

Only three actions call Claude. Page loads, stats, search and sync never do.

| Action | When | Typical tokens | Cost on Opus 5.5 ($4 / $20 per M) |
|---|---|---|---|
| File an entry | You click **File entry** | ~1.5K in, ~0.6K out | ~$0.02 |
| Weekly insight | Monday cron or **Generate** | ~6K in, ~1.5K out | ~$0.05 |
| All-time insight | You click **Generate** | ≤ ~35K in, ~2K out | ~$0.18 |
| Ask your journal | You click **Ask** | ~5K in, ~0.4K out | ~$0.03 |

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
