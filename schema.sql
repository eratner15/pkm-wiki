-- Wiki pages index
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  page_type TEXT NOT NULL DEFAULT 'concept', -- concept, entity, project, daily, index
  summary TEXT,
  tags TEXT, -- JSON array
  word_count INTEGER DEFAULT 0,
  links_to TEXT, -- JSON array of slugs this page links to
  linked_from TEXT, -- JSON array of slugs linking here
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Source documents registry
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  source_type TEXT NOT NULL, -- roam, chat, document, url, note
  r2_key TEXT NOT NULL, -- R2 object key
  content_hash TEXT, -- SHA-256 for dedup
  ingested INTEGER DEFAULT 0,
  summary TEXT,
  pages_updated TEXT, -- JSON array of page slugs updated during ingest
  token_count INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  ingested_at TEXT
);

-- Ingest/query/lint log (append-only)
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL, -- ingest, query, lint, edit
  details TEXT, -- JSON with context
  pages_touched TEXT, -- JSON array
  created_at TEXT DEFAULT (datetime('now'))
);

-- Full-text search on pages
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  title, summary, tags, content='pages', content_rowid='rowid'
);

-- Triggers for FTS sync
CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, summary, tags) VALUES (new.rowid, new.title, new.summary, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, summary, tags) VALUES ('delete', old.rowid, old.title, old.summary, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, summary, tags) VALUES ('delete', old.rowid, old.title, old.summary, old.tags);
  INSERT INTO pages_fts(rowid, title, summary, tags) VALUES (new.rowid, new.title, new.summary, new.tags);
END;

-- Living Journal (also created at runtime by ensureJournalSchema in src/journal.ts)
CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  entry_date TEXT NOT NULL,
  title TEXT,
  entry_type TEXT,
  source TEXT,
  summary TEXT,
  rose TEXT,
  rose_theme TEXT,
  thorn TEXT,
  thorn_theme TEXT,
  thorn_cause TEXT,
  bud TEXT,
  key_wins TEXT,
  lesson TEXT,
  next_action TEXT,
  notable TEXT,
  tickers TEXT,
  day_score REAL,
  mood REAL,
  mood_confidence TEXT,
  energy TEXT,
  tags TEXT,
  people TEXT,
  places TEXT,
  body TEXT,
  notion_id TEXT,
  notion_edited_at TEXT,
  body_synced_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_journal_date ON journal_entries(entry_date);

CREATE TABLE IF NOT EXISTS journal_names (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  category TEXT
);

CREATE TABLE IF NOT EXISTS journal_insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period TEXT NOT NULL,
  period_key TEXT NOT NULL,
  content TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  entries_through TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_journal_insights_period ON journal_insights(period, period_key);

CREATE TABLE IF NOT EXISTS journal_state (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS journal_fts USING fts5(
  title, summary, rose, thorn, bud, lesson, body, content='journal_entries', content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS journal_ai AFTER INSERT ON journal_entries BEGIN
  INSERT INTO journal_fts(rowid, title, summary, rose, thorn, bud, lesson, body)
  VALUES (new.rowid, new.title, new.summary, new.rose, new.thorn, new.bud, new.lesson, new.body);
END;

CREATE TRIGGER IF NOT EXISTS journal_ad AFTER DELETE ON journal_entries BEGIN
  INSERT INTO journal_fts(journal_fts, rowid, title, summary, rose, thorn, bud, lesson, body)
  VALUES ('delete', old.rowid, old.title, old.summary, old.rose, old.thorn, old.bud, old.lesson, old.body);
END;

CREATE TRIGGER IF NOT EXISTS journal_au AFTER UPDATE ON journal_entries BEGIN
  INSERT INTO journal_fts(journal_fts, rowid, title, summary, rose, thorn, bud, lesson, body)
  VALUES ('delete', old.rowid, old.title, old.summary, old.rose, old.thorn, old.bud, old.lesson, old.body);
  INSERT INTO journal_fts(rowid, title, summary, rose, thorn, bud, lesson, body)
  VALUES (new.rowid, new.title, new.summary, new.rose, new.thorn, new.bud, new.lesson, new.body);
END;
