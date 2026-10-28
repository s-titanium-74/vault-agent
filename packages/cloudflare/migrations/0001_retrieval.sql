CREATE TABLE snapshots (
  revision TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  manifest TEXT NOT NULL,
  note_count INTEGER NOT NULL CHECK(note_count <= 500),
  chunk_count INTEGER NOT NULL CHECK(chunk_count <= 2000),
  entry_count INTEGER NOT NULL CHECK(entry_count <= 500),
  indexed_bytes INTEGER NOT NULL CHECK(indexed_bytes <= 16777216)
);
CREATE TABLE deployment (id INTEGER PRIMARY KEY CHECK(id = 1), revision TEXT NOT NULL REFERENCES snapshots(revision));
CREATE TABLE sources (
  revision TEXT NOT NULL REFERENCES snapshots(revision), path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('note','guidance','attachment')),
  size INTEGER NOT NULL CHECK(size >= 0 AND size <= 20971520),
  digest TEXT NOT NULL, updated TEXT NOT NULL,
  PRIMARY KEY(revision, path)
);
CREATE TABLE notes (
  revision TEXT NOT NULL REFERENCES snapshots(revision), note_id TEXT NOT NULL,
  path TEXT NOT NULL, data TEXT NOT NULL CHECK(length(CAST(data AS BLOB)) <= 262144),
  PRIMARY KEY(revision, note_id), UNIQUE(revision,path)
);
CREATE TABLE chunks (
  revision TEXT NOT NULL REFERENCES snapshots(revision), chunk_id TEXT NOT NULL,
  note_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
  data TEXT NOT NULL CHECK(length(CAST(data AS BLOB)) <= 262144),
  PRIMARY KEY(revision,chunk_id),
  FOREIGN KEY(revision,note_id) REFERENCES notes(revision,note_id)
);
CREATE INDEX chunks_note ON chunks(revision,note_id,chunk_index);
CREATE TABLE grams (
  revision TEXT NOT NULL, chunk_id TEXT NOT NULL, gram TEXT NOT NULL,
  PRIMARY KEY(revision,gram,chunk_id),
  FOREIGN KEY(revision,chunk_id) REFERENCES chunks(revision,chunk_id)
);
-- Each snapshot creates fts_<64 hex revision> separately. Shared FTS corpora
-- would allow unpublished rows to change active BM25 ranking.
