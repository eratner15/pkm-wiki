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
