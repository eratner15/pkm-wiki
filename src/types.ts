export interface Env {
  AI: any;
  DB: D1Database;
  STORAGE: R2Bucket;
  WIKI_OWNER: string;
  PKM_PASSWORD: string;
  ANTHROPIC_API_KEY?: string;
  VECTORIZE?: VectorizeIndex;
  JOBS_QUEUE?: Queue;
  CACHE?: KVNamespace;
  BROWSER?: any;
}

export interface WikiPage {
  id: string;
  title: string;
  slug: string;
  page_type: 'concept' | 'entity' | 'project' | 'daily' | 'index';
  summary: string;
  tags: string[];
  word_count: number;
  links_to: string[];
  linked_from: string[];
  created_at: string;
  updated_at: string;
}

export interface Source {
  id: string;
  filename: string;
  source_type: 'roam' | 'chat' | 'document' | 'url' | 'note';
  r2_key: string;
  content_hash: string;
  ingested: boolean;
  summary: string;
  pages_updated: string[];
  token_count: number;
  created_at: string;
  ingested_at: string | null;
}

export interface IngestResult {
  source_id: string;
  pages_created: string[];
  pages_updated: string[];
  entities_extracted: number;
}

export interface QueryResult {
  answer: string;
  citations: { slug: string; title: string; excerpt: string }[];
  pages_created: string[];
}

export interface LintResult {
  contradictions: { pages: string[]; issue: string }[];
  stale_claims: { page: string; claim: string; reason: string }[];
  orphan_pages: string[];
  missing_crossrefs: { from: string; suggested_link: string; reason: string }[];
  health_score: number;
}

export interface ExtractedEntity {
  title: string;
  slug: string;
  page_type: 'concept' | 'entity' | 'project' | 'daily' | 'index';
  summary: string;
  tags: string[];
  content: string;
  links_to: string[];
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  source_summary: string;
}
