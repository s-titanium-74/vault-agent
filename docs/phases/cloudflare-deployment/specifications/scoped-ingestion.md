# Scoped Upload And Autonomous R2 Ingestion (#34)

Follow-up #43: [read-only idle reconciliation](idle-reconciliation.md) supersedes
the idle job admission, checkpoint cost and observation-age freshness rules
below. Completed unchanged checks create no durable jobs or observation writes.

This specification supersedes the CLI-driven orchestration proposal in
[ingestion and consistency](ingestion-consistency.md). Public command:
`vault-agent upload --vault-id <uuid> --include Notes --include images`.
`--dry-run` is offline; `--delete-removed` authorizes deletion only of paths
previously uploaded by this client within the current include scope. `--resume`
uses a private user-local upload plan. Git sync and filesystem watch are unchanged.

Follow-up #48: [incremental publication](incremental-publication.md) is the
accepted replacement design for ordinary changed-source updates. Its hosted rollout
is pending. It replaces per-update full copies with an atomic D1 delta, uses
explicit immutable source locators and reference-aware cleanup, and permits
reported optional vector lag. The per-snapshot layout/readiness/retention rules
below describe the original baseline; upload scope and consent still apply.

## Source Layout And Consent

After explicit deployment setup, edit allowed objects at
`<VAULT_ID>/source/<canonical-vault-relative-path>` in the private R2 bucket.
No per-edit manifest is required. Published objects remain immutable at
`<VAULT_ID>/<snapshot-sha256>/<path>`; staging uses `<VAULT_ID>/staging/<job>/<path>`.
Only the source prefix is listed. Hidden/generated paths, symlinks, configured
exclusions and non-allowlisted attachments are excluded before client transfer
and again at Worker admission. Supported attachments: PDF, PNG, JPEG, GIF,
WebP, SVG and AVIF. Notes/guidance are limited to 2 MiB, attachments to 20 MiB;
existing snapshot limits (500 entries, 2000 chunks, 16 MiB derived rows,
256 KiB per derived row) also apply. No OCR or attachment embedding.

The dry run includes sanitized HTTPS origin, vault identity, included paths,
counts/bytes, rules, deletion candidates and storage/processing destinations.
It saves a mode-0600 plan outside the repository. Executing that plan rechecks
selection and digests before any request. A new invocation makes a new plan;
resuming a plan never expands its selection. Credentials use existing endpoint
and API-key resolution. Cloud storage requires this explicit upload action;
embedding remains independently controlled by deployment consent. Dry run
reports that semantic processing depends on the remote consent setting.

## Protocol And Concurrent Writers

Admin-only `/uploads`, `/uploads/<job>/files/<encoded-path>` and
`/uploads/<job>/commit` stage an explicit manifest (at most 100 entries per page,
500 total) and verified bytes. Creation is keyed by a UUID idempotency key and
input digest; changed input on retry conflicts. Job status is read-authenticated
at `/jobs/<job>`; admin `/jobs/<job>/advance` executes one checkpoint. Uploading
jobs expire after 24 hours. Cloud-side reconciliation never waits for an
uncommitted upload. Source writes use captured ETag preconditions, including
conditional tombstones for deletion; direct edits made after capture cause
`REVISION_CONFLICT` instead of being overwritten. Upload commit applies one
source operation per checkpoint. This is intentionally not an atomic multi-file
source transaction: partial source application is reported and can be retried.
Only validated complete immutable snapshots are exposed through retrieval.

D1 stores checkpoints. Each step acquires a short writer lease and a fencing
token; stale invocations cannot advance checkpoints or publish. Source bodies
and staging snapshots are immutable; retries use deterministic writes. Only
one indexing job runs per deployment. `POST /index {newScan:true}` requests a
new scan after upload source application and returns `INDEX_BUSY` while an
earlier scan runs; the CLI waits for that job before requesting its own scan. Losing publishers cannot replace a newer
active pointer. Direct R2 edits racing a scan are re-observed during validation
and the next reconciliation. Arbitrary authorized direct R2 writers cannot
participate in a cross-object transaction; publication denotes a validated
sampled manifest, not a lock on the editable R2 prefix.

## Autonomous Detection And Bounded Work

Provision a Workers Cron Trigger once per minute in the opted-in cloud edition.
No Queue or event notifications are required: notification ordering, duplicates
and loss cannot affect correctness. Cron starts/resumes bounded reconciliation
with the CLI disconnected; admin advance requests optionally accelerate it.
Each checkpoint lists at most 100 objects, parses at most one note, writes one
chunk, resolves one note's links, processes one embedding input, or validates
one source object. Each Cron run executes at most 8 checkpoints and stops
starting work after 20 seconds. Persist state before returning. A failed job
retains the last good snapshot and the next cron retries a new scan. No logs
contain source paths, bodies, queries or provider errors.

Target detection is one minute plus `ceil(source-list-pages / 8)` minutes;
publication depends on file/chunk counts and vector visibility. For a small
vault (up to 5 notes / 10 chunks), target publication is within 15 minutes.
These are operational targets, not platform SLAs. Steady polling costs at least
1440 scoped R2 list requests/day plus bounded D1 checkpoints; record actual
local and remote operation counts before declaring release readiness. Paid
Workers CPU limit is 1000 ms per invocation; pathological parsing fails closed.
Cron configuration propagation and service outages may delay detection.

Reuse unchanged parsed rows/chunks and cached embeddings identified by the
exact model descriptor and embedding input digest. Every published snapshot
still receives its own FTS corpus and vector namespace. Persist vectors before
upsert; verify query visibility before marking the generation ready. Optional
provider failure publishes lexical-only with semantic unavailable; explicit
`requireEmbeddings` prevents publication on failure. Model changes invalidate
the embedding cache key. Unreferenced cache entries become eligible for
bounded cleanup after 24 hours; an unfinished target prevents cache eviction. Links and aggregates are rebuilt against all target
notes so rename/delete resolve consistently.

## Freshness, Revocation And Recovery

Retrieval pins immutable published bytes and a D1 revision for the full request.
During scanning/building/failed detection, report pending/updating/stale and
last successful observation time. Between scans report observation age; never
claim real-time equivalence to the mutable prefix. During the detection lag,
the previous sampled snapshot remains retrievable, including deleted content.
Once the deletion snapshot publishes, stale note/chunk IDs and vector matches
cannot authorize retrieval. Policy tightening is enforced immediately by source
admission and retrieval policy; finish a reconciliation before considering
aggregate revocation complete.

A source mismatch during final validation abandons the target and restarts on
a later tick. Interrupted steps retry from durable checkpoints. Old snapshots
are never routed publicly; cleanup is separately reported until bounded removal
of staging, obsolete vectors/rows and snapshots has completed. Retain previous
snapshots for at least 24 hours. Never delete unrelated prefixes. This milestone
must not be marked complete until synthetic workerd and deployed Cron/R2/D1
checks cover upload/change/rename/delete, retries, direct edits, excluded
objects, concurrent changes, model/cache behavior and resource teardown.
