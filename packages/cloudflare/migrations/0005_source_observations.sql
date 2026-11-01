ALTER TABLE ingestion_entries ADD COLUMN object_version TEXT;
CREATE TABLE source_observations (
 revision TEXT NOT NULL, path TEXT NOT NULL, digest TEXT NOT NULL,
 etag TEXT NOT NULL, object_version TEXT NOT NULL,
 PRIMARY KEY(revision,path)
);
UPDATE ingestion_jobs SET state='failed',error='INGESTION_UPGRADE_REQUIRED',lease=NULL,lease_until=0
 WHERE kind='scan' AND state NOT IN ('complete','failed');
ALTER TABLE ingestion_jobs ADD COLUMN observation_contract INTEGER NOT NULL DEFAULT 1
 CHECK(kind<>'scan' OR state IN ('failed','complete') OR coalesce(json_extract(data,'$.observations'),0)=1);
