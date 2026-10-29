CREATE TABLE ingestion_jobs (
 id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, kind TEXT NOT NULL,
 state TEXT NOT NULL, checkpoint INTEGER NOT NULL DEFAULT 0,
 data TEXT NOT NULL, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 created INTEGER NOT NULL, error TEXT, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE ingestion_entries (
 job TEXT NOT NULL REFERENCES ingestion_jobs(id), path TEXT NOT NULL,
 kind TEXT NOT NULL, size INTEGER NOT NULL, digest TEXT, etag TEXT,
 updated TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(job,path)
);
CREATE TABLE ingestion_state (
 id INTEGER PRIMARY KEY CHECK(id=1), job TEXT, signature TEXT,
 observed INTEGER, error TEXT
);
INSERT INTO ingestion_state(id) VALUES(1);
CREATE TABLE ingestion_guard (id INTEGER PRIMARY KEY CHECK(id=1), valid INTEGER CHECK(valid=1));
CREATE TABLE embedding_cache (key TEXT PRIMARY KEY, values_json TEXT NOT NULL, created INTEGER NOT NULL DEFAULT 0);
CREATE TABLE ingestion_vectors (
 revision TEXT NOT NULL, chunk_id TEXT NOT NULL, cache_key TEXT NOT NULL,
 receipt TEXT, visible INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(revision,chunk_id)
);

ALTER TABLE snapshots ADD COLUMN created INTEGER NOT NULL DEFAULT 0;
UPDATE snapshots SET created=unixepoch()*1000 WHERE created=0;

CREATE INDEX ingestion_jobs_work ON ingestion_jobs(kind,state,created);
CREATE INDEX ingestion_vectors_cache ON ingestion_vectors(cache_key);
