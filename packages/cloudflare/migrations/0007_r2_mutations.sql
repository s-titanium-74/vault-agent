CREATE TABLE r2_mutation_meta (id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL);
INSERT INTO r2_mutation_meta VALUES(1,0);
CREATE TABLE r2_mutation_operations (
 id TEXT PRIMARY KEY, nonce TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, policy TEXT NOT NULL,
 issued INTEGER NOT NULL, expires INTEGER NOT NULL, preview INTEGER NOT NULL,
 state TEXT NOT NULL, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 completed INTEGER, cleanup_after INTEGER
);
CREATE TABLE r2_mutation_items (
 operation_id TEXT NOT NULL, item_index INTEGER NOT NULL, path TEXT NOT NULL,
 state TEXT NOT NULL, result TEXT NOT NULL, recovery TEXT,
 PRIMARY KEY(operation_id,item_index)
);
CREATE TABLE r2_mutation_paths (
 path TEXT PRIMARY KEY, note_id TEXT, owner TEXT NOT NULL, item_index INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('saved','deleted','uncertain')),
 digest TEXT, object_version TEXT, version TEXT, updated INTEGER NOT NULL
);
CREATE INDEX r2_mutation_note ON r2_mutation_paths(note_id);
CREATE INDEX r2_mutation_cleanup ON r2_mutation_operations(state,cleanup_after);
