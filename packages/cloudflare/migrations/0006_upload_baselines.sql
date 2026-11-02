-- Do not infer a local/cloud common ancestor from a current source snapshot.
CREATE TABLE upload_baselines (
 path TEXT PRIMARY KEY, digest TEXT, job TEXT NOT NULL, acknowledged INTEGER NOT NULL,
 CHECK(digest IS NULL OR (length(digest)=64 AND digest NOT GLOB '*[^a-f0-9]*'))
);
ALTER TABLE ingestion_entries ADD COLUMN baseline_job TEXT;
ALTER TABLE ingestion_entries ADD COLUMN upload_attempted INTEGER NOT NULL DEFAULT 0;
-- Old plans did not capture a baseline and cannot safely resume source writes.
UPDATE ingestion_jobs SET state='failed',error='UPLOAD_BASELINE_REQUIRED',lease=NULL,lease_until=0
 WHERE kind='upload' AND state NOT IN ('complete','failed');
ALTER TABLE ingestion_jobs ADD COLUMN upload_contract INTEGER NOT NULL DEFAULT 2
 CHECK(kind<>'upload' OR state IN ('failed','complete') OR coalesce(json_extract(data,'$.uploadContract'),0)=2);
