export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS manifest (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  vault_identity TEXT NOT NULL,
  effective_exclude_patterns TEXT NOT NULL,
  target_chunk_size INTEGER NOT NULL,
  max_chunk_size INTEGER NOT NULL,
  embedding_model TEXT,
  embedding_dimension INTEGER,
  note_count INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  indexed_at REAL NOT NULL,
  config_fingerprint TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  note_id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  title TEXT,
  file_size INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  mtime_ms REAL NOT NULL,
  frontmatter_title TEXT,
  aliases_json TEXT,
  tags_json TEXT,
  date_value TEXT,
  created_value TEXT,
  updated_value TEXT,
  has_frontmatter INTEGER NOT NULL DEFAULT 0,
  frontmatter_degraded INTEGER NOT NULL DEFAULT 0,
  links_json TEXT,
  attachment_refs_json TEXT,
  body_text TEXT,
  oversized INTEGER NOT NULL DEFAULT 0,
  empty INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chunks (
  chunk_id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  path TEXT NOT NULL,
  title TEXT,
  heading TEXT,
  heading_path_json TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  lexical_text TEXT NOT NULL,
  embedding_input_text TEXT NOT NULL,
  FOREIGN KEY (note_id) REFERENCES notes(note_id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
  chunk_id,
  lexical_text,
  content='chunks',
  content_rowid='rowid',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO fts_chunks(rowid, chunk_id, lexical_text)
  VALUES (new.rowid, new.chunk_id, new.lexical_text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO fts_chunks(fts_chunks, rowid, chunk_id, lexical_text)
  VALUES('delete', old.rowid, old.chunk_id, old.lexical_text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO fts_chunks(fts_chunks, rowid, chunk_id, lexical_text)
  VALUES('delete', old.rowid, old.chunk_id, old.lexical_text);
  INSERT INTO fts_chunks(rowid, chunk_id, lexical_text)
  VALUES (new.rowid, new.chunk_id, new.lexical_text);
END;

CREATE TABLE IF NOT EXISTS trigrams (
  chunk_id TEXT NOT NULL,
  gram TEXT NOT NULL,
  FOREIGN KEY (chunk_id) REFERENCES chunks(chunk_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trigrams_gram ON trigrams(gram);
CREATE INDEX IF NOT EXISTS idx_trigrams_chunk ON trigrams(chunk_id);
CREATE INDEX IF NOT EXISTS idx_chunks_note_id ON chunks(note_id);
CREATE INDEX IF NOT EXISTS idx_notes_path ON notes(path);
`;

export const VEC_SCHEMA_SQL = (dimension: number) => `
CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding float[${dimension}]
);
`;
