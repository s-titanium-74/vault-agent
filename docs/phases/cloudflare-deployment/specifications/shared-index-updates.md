# Shared Index Update Core

Local watch, local index/reindex and Workers ingestion use the same portable
update policy and prepared index data. Storage adapters own I/O and completion.
This extends the portable-core boundary in #31 and the ingestion work in #34.

Accepted follow-up #48: [incremental publication](incremental-publication.md)
defines a shared prepared delta and changed-row comparisons. Local SQLite keeps
atomic vector/lexical writes; cloud optional vectors may catch up separately with
current-version validation and explicit warnings. The runtime descriptions below
document the original baseline; the linked follow-up specifies the new layout.

## Common decisions and data

Portable core owns:

- Source change planning: create/change/reuse/remove, forced rebuilding, and
  complete-manifest versus partial-event deletion scope. A missing or excluded
  member is removed; an unreadable present file preserves its prior entry with
  a sanitized warning. Runtime adapters admit paths before requesting reads.
- Markdown/frontmatter parsing, note IDs and chunk generation, prepared note and
  lexical/embedding-input rows, attachment references and degraded metadata.
- Link catalog construction and resolution against the whole target membership,
  including links from unchanged notes when targets are added/renamed/deleted.
- Exact-input embedding reuse keyed by the complete provider/model/input-format
  descriptor and embedding text. Changed eligible inputs are embedded in bounded
  batches; unchanged inputs are reused. Disabled embeddings never contact a
  provider. Required embedding failures prevent publication; optional failure
  leaves lexical results usable and cannot authorize stale vectors.

Adapters supply validated source observations, previous metadata, source bytes,
provider/cache bindings and explicit limits. The portable core imports no Node,
filesystem, SQLite, Cloudflare binding, local configuration or scheduler code.
The same functions run for a local watcher event and a bounded Worker job step.

## Runtime responsibilities

Local adapters retain filesystem discovery/watch, endpoint opt-in validation,
SQLite/FTS/sqlite-vec writes, process locks and atomic transactions. Prepare
asynchronous parsing/embedding work before opening the transaction on a shared
server connection; apply completed rows/vectors/links synchronously so reads
cannot observe partially applied changes. Verify that the prior manifest still
matches before applying a prepared update. Manual index/reindex and watch use
one local update adapter rather than separate parsing/update implementations.
The server serializes watched batches and obtains the current store for each
batch, including after reindex replaces the database connection. A concurrent
manual publication invalidates an outdated prepared update rather than allowing
it to overwrite a newer manifest; a failed watch update marks freshness stale.

Workers retain R2 reads/writes and source admission, D1 SQL, immutable snapshots,
leases/fencing, per-step checkpoints, vector visibility checks, active-pointer
publication and cleanup. Bounded jobs may call the common core one file or
embedding input at a time. A local transaction does not become a distributed
checkpoint job, and a Worker never imports the local indexer.

## Compatibility and correctness

Keep local note/chunk IDs, local vault identity and legacy decoded-text hashes.
Cloud source revisions continue to hash complete bytes. Revision normalization
belongs to the source adapter; core compares like-for-like observations.
Read evidence must include a digest before deciding whether a file is unchanged,
so equal size/mtime cannot conceal a changed file after a watcher notification.

SQLite gains additive internal storage for original link inputs and exact-input
embedding cache entries. Existing databases remain readable; a writable open
adds the columns/tables without discarding notes or changing the public index
schema. Legacy link rows can be resolved again without treating previously
normalized Markdown paths as source-relative paths. Cache entries are local
vault-derived data inside the already ignored SQLite index, never repository
configuration. Model/dimension changes keep their existing reindex requirements.

Local watched changes now run the same embedding-update policy as manual index
and Workers. Deleted/replaced chunks revoke their SQLite vectors transactionally.
Local default lexical behavior, localhost binding, watch defaults and explicit
cloud upload remain unchanged. Guidance/attachment admission, encoding and size
limits retain each deployment's documented scope; these are adapter constraints.

## Validation

Use one synthetic corpus across SQLite and workerd/D1/R2. Assert compatible
note/chunk/lexical inputs, links and aggregate membership after initial indexing,
change, rename and delete. Include an unchanged source linking to a newly added
or removed target, same-size/same-mtime edits, metadata-only embedding changes,
zero inference on exact input reuse, and stale-vector removal on deletion.
Verify required-provider failure preserves the prior snapshot and optional
failure keeps lexical retrieval while revoking replaced vectors. Run local,
portable bundle/type, distribution and Worker regression checks. Repeat hosted
synthetic ingestion/cache/deletion validation after changing the Worker adapter;
record source revision and resource teardown independently of local simulation.
