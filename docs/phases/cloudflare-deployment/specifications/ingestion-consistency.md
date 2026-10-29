# Cloudflare Ingestion And Consistency

Status: Superseded for #34 orchestration and source layout by
[scoped autonomous ingestion](scoped-ingestion.md).
The revision isolation and privacy requirements below remain applicable.

## Explicit Upload Workflow

The #34 public command is `vault-agent upload`, separate from Git `sync`:

```sh
vault-agent upload --include Notes --include attachments --dry-run
vault-agent upload --include Notes --include attachments
vault-agent upload --include Notes --include attachments --delete-removed
vault-agent upload --resume <job-id>
```

Use existing endpoint/API-key resolution with an admin token and user-local
cloud settings. Never change the original vault. No scheduled or automatic
upload. Dry run is offline and sends no data, including paths/digests; display
configured target/vault identity, selected relative paths/counts/bytes,
excludes, skipped reasons, proposed deletions from the locally saved last
manifest, and storage/AI destinations with secrets redacted. Warn that remote
parent state will be validated only during actual upload. The actual command
uses the same selection algorithm, recomputes digests, and fails if a saved
dry-run selection no longer matches; it never expands scope silently.

Omitting a remote file from upload is not deletion. `--delete-removed` deletes
only previously managed paths inside the explicit include scope. Rename is a
new upload plus explicit old-path deletion. To remove a whole former scope,
include that scope in a deletion plan, even if now empty locally. Scope/exclude
policy tightening must publish revocations before being declared effective;
it must not leave excluded files readable from an old active manifest.

## Cloud Administration Protocol

All operations require admin authentication except job status, which requires
read authentication. All JSON uses the existing data/warnings or error
envelope. IDs and cursors are opaque; paths are canonical vault-relative paths.
Mutations require `Idempotency-Key`; reuse with different input returns 409
`IDEMPOTENCY_CONFLICT`. Only one writer job per vault is admitted; competing
requests receive 409 `INDEX_BUSY`.

| Route                                      | Input and result                                                                                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /uploads`                            | `{vaultId, parentRevision, includes, deleteRemoved}` creates a staging job; 202 `{jobId, state, parentRevision}`. No automatic discovery outside includes.                                 |
| `PUT /uploads/{jobId}/manifest?cursor=...` | Ordered pages of at most 100 `{path, kind, size, digest, updated}` entries; response contains next cursor. Final page explicitly seals the proposed manifest.                              |
| `PUT /uploads/{jobId}/files/*`             | Stream one declared file with expected digest and length; immutable staging object; reject undeclared/excluded paths and mismatches. Repeat identical upload succeeds.                     |
| `POST /uploads/{jobId}/commit`             | Seal source after all declared objects validate, calculate scoped deletions against parent; 202 returns the index job ID (same job ID). No index publication yet.                          |
| `POST /index`, `/reindex`                  | Existing `{requireEmbeddings}` body, optional cloud `parentRevision`; create incremental/full derived rebuild over committed source. 202 `{jobId, state}`; no vault-sized work in request. |
| `GET /jobs/{jobId}`                        | Bounded state/progress counts, public-safe error, revision and cleanup state; never file content or credentials.                                                                           |
| `POST /jobs/{jobId}/advance`               | Expected checkpoint token from job status; execute one bounded step and return persisted next checkpoint/state. Duplicate/replayed checkpoint never repeats publication.                   |
| `POST /jobs/{jobId}/cancel`                | Stop uncommitted work and schedule staging cleanup. A published revision cannot be rolled back by cancellation.                                                                            |

Initial jobs are CLI-driven with durable D1 checkpoints and expiring writer
leases/fencing tokens. Updated `upload`, `index`, and `reindex` commands drive
advance/status calls until complete; `upload --resume` can resume any cloud
job. Disconnect pauses progress without invalidating committed data. No Queue,
Workflow, cron, or `waitUntil` completion guarantee is assumed. The job status
does not imply a background worker is running. Automated orchestration is a
later extension, requiring documentation and cost validation first.

Job state values are `uploading`, `indexing`, `waiting_vectors`, `publishing`,
`complete`, `failed`, and `cancelled`. Status returns `jobId`, `state`,
`checkpoint`, `parentRevision`, `targetRevision`, `filesAccepted`,
`filesProcessed`, `chunksProcessed`, `retryAfterMs`, `cleanupPending`, and
`error` (nullable sanitized error object). Counts refer only to this job;
responses never enumerate all files. `advance` with `{checkpoint}` drives
indexing, vector readiness checks, publication, or cleanup; it returns 200
with status even when more work remains. A failed/cancelled job can only run
cleanup; a retry starts a new job against the current parent while reusing
validated content by digest. First seed/upload uses `parentRevision: null`;
setup creates the valid empty source/index snapshot before normal retrieval.
The client polls no faster than `retryAfterMs` (minimum 1 second). The final
CLI result includes the existing indexing summary fields plus job/revision
metadata; until complete it must not report indexing success.

Each invocation starts with at most one Markdown file, 16 chunks per embedding
batch, 100 manifest entries, and 100 vector writes per step; D1 writes are
split to at most 90 parameters per statement. Persist a cursor between steps.
Apply an explicit paid-plan CPU budget of 1 second per advance invocation,
wall-clock deadline of 30 seconds, and bounded retries (at most 3 attempts per
transient operation, honoring Retry-After). A single file must be parseable
within that CPU budget; exceeding it fails with `INDEX_BUDGET_EXCEEDED`, never
silently drops content. Size limits are admission checks, not CPU guarantees.
These starting budgets must be measured and may be lowered before release.

Initial cloud upload hard limits: Markdown/guidance 2 MiB per file,
attachments 20 MiB per file. Exceeding them returns 413 `UPLOAD_TOO_LARGE`;
`allowLarge` does not override upload limits. Stream bytes and digest checks;
never hold a whole vault or large attachment batch in memory. D1 stores
bounded chunks/metadata rows, not a whole maximum-size note in one row.
Oversize files are reported in dry run and cause actual upload to fail until
the selection is explicitly narrowed. Platform-independent local limits stay
unchanged.

## Revision Publication

Each snapshot has `vaultId`, unique revision, parent revision, schema/parser/
chunker/input-format versions, scope/exclude policy digest, file manifest,
and optional embedding-generation descriptor. Staging references immutable
source objects and derived rows; unchanged files may reuse source objects.
Changed content never overwrites an object referenced by an active revision.

1. Upload source bytes and verify manifest size/digest. Finish bounded parsing,
   chunks, FTS/grams, links, guidance catalog, and profile inputs in staging D1
   rows. Every derived reference carries the snapshot and source digest.
2. If embeddings are enabled, stage vectors in a separate snapshot namespace.
   Internal vector IDs are fixed 64-hex SHA-256 digests of vault, snapshot,
   chunk ID, and model generation. Track asynchronous mutations. A mutation
   receipt is not proof of query visibility.
3. Validate completeness and revision references, then atomically compare
   parent revision and writer fence and switch D1's active pointer. The switch
   is a bounded D1 transaction/batch, not a transaction across stores. A losing
   writer returns 409 `REVISION_CONFLICT` and must replan, never overwrite.
4. Requests pin one active revision for their entire operation. Authoritative
   D1 reads use primary-consistent reads (initially no read replication; if
   enabled, use `first-primary` sessions). Check that the active pointer is
   unchanged before emitting a response; otherwise return 409
   `REVISION_CHANGED`. No historical snapshot routing is exposed.
5. Get reads the exact referenced source digest; mismatch or unavailable source
   returns 409 `SOURCE_REVISION_MISMATCH` or 503 `SOURCE_UNAVAILABLE`, never
   substitutes newer bytes. Chunk reads come from the same snapshot's rows.
   Validate vector references, digest, generation, and membership through D1
   before returning snippets. Old/deleted/staged vectors cannot authorize reads.

While target work is pending/updating/failed, serve the last committed snapshot
with `INDEX_PENDING`, `INDEX_UPDATING`, or `INDEX_STALE` warning. Fresh means
matching the latest accepted upload intent, not matching an unobserved local
filesystem. No active usable snapshot returns 409 `INDEX_NOT_FOUND`.
Requests already admitted before publication may finish before the switch;
requests seeing a new pointer cannot access removed content. Publication
acknowledgement does not promise recall of responses already delivered.

Lexical completion may publish even if optional embedding work fails, with
`embeddingState: unavailable` and an explicit warning; vectors are used only
when the complete generation is validated as query-visible. Until then, use
documented lexical fallback or embedding-only 503. `requireEmbeddings: true`
prevents publication unless the entire target vector generation is ready.
Unknown/stale/incompatible states must never be labeled fresh/ready.

## Deletion, Recovery, And Model Changes

Publication removes deleted notes/chunks, attachment/guidance membership,
links, and derived aggregates together. Post-publication queries ignore old
vectors immediately regardless of asynchronous vector cleanup. Background-free
cleanup uses bounded job steps and is resumable; mark `cleanupPending` until
old derived rows/vectors and unreferenced R2 objects are removed. Retain the
previous snapshot with a 24-hour cleanup eligibility window for recovery, never as
an authorized historical retrieval API. Abandoned staging expires after 24
hours and is cleaned on subsequent admin advances; idle deployments require
explicit admin cleanup/teardown. Deletion from storage and backups is distinct
from API revocation. Never delete unrelated bucket prefixes or another vault.

Persist intent before each external write, record receipts/checkpoints, and
retry idempotently after crashes. If publication succeeded but its response
was lost, retry reports the already published revision. Partial staging leaves
the previous snapshot usable. A corrupt active source fails closed; repair
through a new validated upload/rebuild, not automatic rollback that could
restore revoked data. Cancellation or exhausted retries records a sanitized
failure and leaves cleanup resumable.

Provider/model version, dimension, distance metric, normalization, or embedding
input-format changes require a new generation and full embedding rebuild.
Dimension/metric changes provision a new Vectorize index. Never mix spaces,
reuse cached vectors across generations, or silently change models. Keep
lexical available; disable semantic until the newly selected generation is
complete, then publish its pointer atomically. Parser/schema/chunker changes
requiring new IDs/rows use a full staged rebuild; incompatible old snapshots
return `INDEX_INCOMPATIBLE`. Local cache migration is a separate concern.
