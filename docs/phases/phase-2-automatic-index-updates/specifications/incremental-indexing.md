# Phase 2 Incremental Indexing Specification

Status: Draft

This file is part of the Phase 2 specification. See ../requirements.md for
requirements and this directory for the domain specifications.

## Update Unit

The incremental update unit is a vault-relative path.

All path inputs are normalized with Phase 1 path safety rules before they reach
the index writer. Paths that resolve outside the configured vault root are
rejected.

The incremental indexer receives classified paths:

- Markdown note.
- Discoverable attachment.
- Excluded path.
- Deleted path.
- Unknown path.

Unknown paths that may affect indexed state should mark the index stale rather
than incorrectly reporting freshness.

## Markdown File Changes

Changed Markdown files:

- Re-read the file as UTF-8.
- Parse Markdown and frontmatter.
- Rebuild chunks for that note.
- Update note metadata.
- Update lexical index rows.
- Update embeddings when embeddings are enabled.
- Update link metadata.
- Update attachment reference metadata.

Created Markdown files follow the same flow when the file passes discovery and
exclude rules.

Deleted Markdown files remove:

- Note records.
- Chunks.
- Lexical rows.
- Embedding rows.
- Link metadata.
- Attachment reference metadata owned by that note.

Rename handling may be implemented as delete plus create.

## Attachment Changes

Changed non-Markdown attachments update attachment metadata only if referenced
or explicitly discoverable by existing rules.

Deleted attachments remove attachment metadata or mark the attachment missing,
as defined by the Phase 1 retrieval model.

Attachment contents are not indexed, searched, embedded, OCRed, summarized, or
automatically expanded in Phase 2.

## Degraded Files

If a changed file exceeds the indexing size limit:

- Keep or create the note record.
- Remove searchable chunks and embeddings for that file.
- Preserve explicit note retrieval subject to retrieval limits.
- Record warning status.

If a file becomes unreadable:

- Mark the note degraded or stale.
- Preserve the last usable index entry where practical.
- Surface warning status without exposing private absolute paths or note
  content.

Parse and frontmatter failures follow Phase 1 behavior: index the body where
safe and record a degraded warning.

Invalid UTF-8 and binary-looking Markdown files follow Phase 1 skip and warning
behavior.

## Compatibility And Reindex Requirements

The index manifest stores enough information to detect compatibility with the
current server configuration.

Full reindex is required for:

- Schema version changes.
- Vault root identity changes.
- Effective exclude pattern changes.
- Chunk size changes.
- ID collision during incremental update.
- Embedding dimension mismatch.
- Any other configuration fingerprint change not explicitly defined as safe.

Embedding rebuild or full reindex is required for:

- Embedding model changes.
- Embedding provider changes that also change dimensions or embedding semantics.

Embedding endpoint changes with the same model and dimensions do not require
reindexing by themselves.

When embeddings are stale but lexical index data remains usable, lexical search
continues to work and embedding-capable modes follow the Phase 1 fallback and
warning policy.

## Atomicity

Incremental updates are transactional.

Failed incremental updates must not corrupt the last usable committed index.

Full reindex continues to use a temporary database followed by atomic swap.

Search and get during incremental update use the last committed index snapshot.

After successful incremental update, the new snapshot becomes active atomically.

Only one index writer may run at a time.

Reads may continue while a writer builds an update where SQLite and WAL allow.

If the writer lock cannot be acquired quickly, the system records status and
returns or reports an index-writer-busy condition instead of starting a parallel
writer.

## Freshness State Mapping

Incremental index operations update the index freshness state:

- `pending`: relevant changes are known but no writer has started.
- `updating`: a writer is currently applying changes.
- `fresh`: the latest known relevant changes have committed.
- `stale`: relevant changes may exist but are not committed.
- `incompatible`: the active index cannot be safely queried for search.
- `unknown`: freshness cannot be determined.

## Error Codes

Index update error codes:

- `INDEX_UPDATE_FAILED`
- `INDEX_WRITER_BUSY`
- `INDEX_REINDEX_REQUIRED`
- `INDEX_INCOMPATIBLE`
- `INDEX_SCHEMA_INCOMPATIBLE`
- `INDEX_CONFIG_CHANGED`
- `INDEX_EXCLUDES_CHANGED`
- `INDEX_CHUNKING_CHANGED`
- `INDEX_EMBEDDINGS_STALE`
- `INDEX_EMBEDDING_DIMENSION_MISMATCH`
- `INDEX_VAULT_IDENTITY_CHANGED`
- `INDEX_ID_COLLISION`
- `INDEX_FILE_READ_FAILED`
- `INDEX_FILE_NOT_UTF8`
- `INDEX_FILE_BINARY`
- `INDEX_FILE_TOO_LARGE`
- `INDEX_FRONTMATTER_PARSE_FAILED`

Error messages must not include raw note content, full chunks, raw queries,
secrets, provider credentials, or private absolute paths.

## Shared update implementation

Local manual indexing and watcher updates delegate to the same update adapter and
portable mutation policy used by Workers. See [shared index updates](../../cloudflare-deployment/specifications/shared-index-updates.md).
The adapter preserves SQLite atomicity and local provider opt-in; it does not
enable cloud upload or hosted embedding processing.

## Resumable local embedding preparation (#87)

Local index, reindex and watcher updates persist each validated embedding batch
in the vault-scoped SQLite cache before requesting the next batch. Cache writes
contain no searchable rows and do not publish notes, chunks, vectors or manifests.
Required failures preserve the last published snapshot; optional failures publish
the lexical update and successful vectors together, leaving other chunks pending.
A later index update retries pending inputs even when note text is unchanged.
Full reindex checkpoints to the active database cache so deleting a failed staging
database does not discard progress, including on a first build. When the active
DB cannot be opened or its manifest is incompatible, reindex uses a separate
`embedding-cache.sqlite` in the same private index directory so repair remains
possible.

Cache identity includes the complete provider/model/input descriptor and exact
embedding input. A dimension-discovery alias (the same descriptor with a null
dimension) allows retries before any manifest has committed; it only discovers
the dimension, and actual reuse still validates the dimension-specific key.
Local update requests contain at most eight chunks (and respect provider limits).
Confirmed local input-limit failures use the bounded splitting policy in the
[indexing specification](../../phase-1-retrieval-foundation/specifications/indexing.md#bounded-input-limit-recovery-90).
Other provider failures are not immediately retried. The provider-wide maximum
batch size remains unchanged; recovery shares the original request deadline.
Cache data remains private derived data in the ignored index directory.

Warnings and failed updates retain allowlisted public error codes, including
EMBEDDING_TIMEOUT, EMBEDDING_INPUT_TOO_LARGE, EMBEDDING_FAILED and dimension/configuration errors. Unknown
errors use a generic code; provider messages and arbitrary error codes are never
forwarded. Text freshness and embedding readiness are independent: a successful
optional lexical update may be fresh while embeddings remain unavailable.
