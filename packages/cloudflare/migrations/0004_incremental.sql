-- Physical stores keep legacy revision keys; public snapshots advance separately.
CREATE TABLE publications (
 store TEXT PRIMARY KEY, snapshot TEXT NOT NULL, epoch INTEGER NOT NULL
);
INSERT INTO publications SELECT revision,revision,0 FROM deployment;
CREATE TABLE source_objects (
 revision TEXT NOT NULL, path TEXT NOT NULL, object_key TEXT NOT NULL,
 PRIMARY KEY(revision,path)
);
CREATE INDEX source_objects_key ON source_objects(object_key);
CREATE TABLE prepared_deltas (
 job TEXT NOT NULL, path TEXT NOT NULL, data TEXT NOT NULL,
 PRIMARY KEY(job,path)
);
CREATE TABLE retired_objects (
 object_key TEXT PRIMARY KEY, retired INTEGER NOT NULL
);
CREATE TABLE vector_work (
 revision TEXT NOT NULL, chunk_id TEXT NOT NULL, input_key TEXT NOT NULL,
 content_hash TEXT NOT NULL, vector_id TEXT NOT NULL, state TEXT NOT NULL,
 receipt TEXT, error TEXT, retry_at INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(revision,chunk_id)
);
CREATE INDEX vector_work_pending ON vector_work(revision,state,retry_at);
CREATE TABLE retired_vectors (
 vector_id TEXT PRIMARY KEY, retired INTEGER NOT NULL
);
CREATE TABLE delta_fallbacks (signature TEXT PRIMARY KEY);
-- In-flight legacy publishers lose their token before the new writer starts.
UPDATE ingestion_jobs SET state='failed',error='INGESTION_UPGRADE_REQUIRED',lease=NULL,lease_until=0
 WHERE kind='scan' AND state NOT IN ('complete','failed');
ALTER TABLE ingestion_jobs ADD COLUMN writer_contract INTEGER NOT NULL DEFAULT 2
 CHECK(kind<>'scan' OR state IN ('failed','complete') OR coalesce(json_extract(data,'$.layout'),0)=2);
