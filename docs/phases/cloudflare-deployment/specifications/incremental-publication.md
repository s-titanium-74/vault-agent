# Incremental publication (#48)

Status: Implemented; local regressions and matched hosted lexical comparison passed.
Hosted semantic and actual-Cron performance are not certified.

Tracking: [#48](https://github.com/s-titanium-74/vault-agent/issues/48).
This document records the changed-source update decisions made after the
2026-10-31 baseline. Existing snapshot behavior remains deployed until migration
and rollout; the operator's deployment has not been updated. Disposable hosted
verification is recorded separately below. On rollout, this contract
supersedes per-update full snapshot copying, vector readiness before ordinary
publication, and retention of every intermediate D1 revision in the #34 specs.
It does not change upload consent, source admission, authentication or local defaults.

Accepted follow-up: [verified source-observation reuse](source-observation-reuse.md)
replaces full source GET/HEAD passes with digest-bound version/ETag reuse and
paged LIST validation. The 2026-11-01 comparison linked here measures the earlier
GET/HEAD implementation and must remain historical evidence.

## Decisions and scope

- Keep R2 source storage, D1 metadata/FTS/trigrams and optional Workers AI / Vectorize.
  Do not adopt AI Search or move D1 body fields to R2 in this change.
- Prepare a delta through shared portable core, then publish all authoritative
  D1 changes in one transaction. Do not copy unchanged note/chunk/search rows
  into a new revision for an ordinary small update.
- Keep reads available during preparation. Do not introduce a long-lived read
  barrier, reader leases or a journal for partially applied live updates.
- Allow optional cloud semantic retrieval to lag lexical publication. Missing
  matches, fewer candidates and temporary ranking differences are acceptable;
  deleted, excluded, foreign or content-incompatible matches are not.
- Preserve local SQLite atomic publication, including sqlite-vec writes when
  enabled. Do not add artificial vector lag to the local runtime.
- Compare user-visible behavior on a 100-note synthetic vault first. Add detailed
  checkpoint timing only if the observed result still requires investigation.

## Shared core and adapters

Extend the existing `planSourceChanges`, `prepareNoteUpdate`,
`createIndexLinkResolver` and `prepareEmbeddingBatch` policies rather than adding
cloud-specific parsing, chunking, ranking or embedding-input generation.
`prepareIndexDelta` and `indexRowsEqual` provide portable row comparisons;
`planSourceChanges` remains the common source-change policy. Local publication
uses the same comparisons to skip identical observation/link updates.

The shared prepared delta describes note/chunk upserts and removals, lexical
inputs, changed observations, changed resolved links, target membership/counts,
and embedding inputs invalidated or reused. It contains no SQL, bucket keys,
HTTP credentials, transaction handles or scheduler state. Compare persisted
fields by their meaning; JSON property order must not manufacture a change.

Initially a changed note may replace all of its own chunks, FTS and grams; it
must not rewrite other notes' chunks. Resolve links against the complete target
catalog, then persist only changed link results. Title/alias changes, additions,
deletions and rename can affect links from otherwise unchanged notes. Observed
mtime/size changes may require metadata writes without lexical rewrites. Preserve
the existing byte-digest evidence and local decoded-text hash conventions;
equal size/mtime alone is not proof of unchanged content.

Adapters read sources and prior rows, stage prepared output, enforce budgets,
and apply it. Local SQLite uses its synchronous transaction; Workers uses one
D1 `batch()` for live publication. Cloud preparation may span durable
checkpoints; local preparation can remain in memory. Core must not import the
local indexer into Workers or Cloudflare bindings into portable code.

## Storage identity and publication identity

Separate a physical index store from the public source snapshot revision:

```text
deployment -> { storeId: A, snapshot: R42, epoch: 42 }
store A    -> notes, chunks, FTS, grams, source references, vector membership

small update: mutate only the delta in A; publish { A, R43, 43 }
full rebuild: prepare store B separately; publish { B, R44, 44 }
```

`storeId` selects physical rows and one FTS corpus. It does not change for every
small edit. `snapshot` retains the public opaque source-revision contract.
`epoch` is an internal monotonically increasing publication token, including
rebuilds or a return to previously seen source bytes, to detect ABA changes.
Never rewrite every row's revision just to advance publication identity.
Legacy revision-keyed stores become initial physical stores during migration.

Use an active source-reference table rather than a complete copied reference
table per small revision. The source reference contains canonical path, kind,
size, digest, observation metadata and an internal immutable object locator.
Small updates replace only affected references. No historical read API is added.

All active FTS entries belong to exactly the current corpus. Prepared FTS inputs
stay outside that FTS table until commit: adding staged/deleted versions to the
same corpus and filtering IDs afterwards can change BM25 corpus statistics.
Queries retain common filters, fallback trigrams, RRF and result schemas.

## Prepare and commit

1. Capture parent store, snapshot, epoch, policy and writer token. Discover and
   admit sources with the existing bounded reconciliation; source scanning and
   final validation may still inspect the whole allowed manifest.
2. Build and durably stage the delta. Do not mutate live notes, chunks, FTS,
   grams, source references or vector authorization. Stage source bytes at
   immutable object locations and verify their digest before publication.
3. Validate the sampled source observations, exclusions and target budgets.
   Direct R2 writers remain outside the transaction: this is a validated sampled
   manifest, not a cross-object lock or instantaneous mirror of mutable source.
4. Select the bounded incremental path before any live mutation. Prepare every
   SQL statement in advance; no inference, R2 calls or application callbacks
   occur inside the publication batch.
5. In one D1 transaction, enforce parent epoch/store/snapshot and writer fencing;
   apply affected notes/chunks/FTS/grams, changed links/observations, source
   references, counts/manifest, vector invalidations and durable pending work;
   then advance publication identity and mark the lexical job complete.
   A failed guard must abort the batch, not merely update zero rows while later
   SQL continues. Reuse the existing constraint-based guard pattern.
6. Resume optional semantic work from its own durable cursor. Garbage collection
   is separate from lexical completion and cannot authorize old content.

A failed batch preserves the previous live state. Job completion and the
published token are committed with the data, so a lost response is resolved by
reading durable status rather than blindly applying the delta again. Stale
writers cannot publish after their fencing token is replaced. Failed R2 staging
prevents commit; successful staging followed by failed D1 commit leaves only
unpublished garbage eligible for later cleanup.

The transaction property is specific to D1 SQL, not R2 or Vectorize. See
[D1 batch semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/).

### Updates that do not fit one transaction

Do not assume that one changed file, or the admitted vault size, guarantees a
bounded batch. Choose and test conservative application budgets for statement
count, prepared bytes and derived-row volume before enabling the fast path;
these are application limits, not invented platform guarantees.
Initial constants in `incremental.ts` are 80 statements including publication
overhead, 512 KiB of note/chunk upserts and 8,000 generated gram rows. These
conservative admission limits are locally tested, not certified hosted capacity.

If the delta exceeds a budget, use a separately staged full index store and
switch the active pointer atomically after validation, as in the existing rebuild
path. Explicit rebuild, incompatible schema/model and legacy data requiring
conversion can use this path too. Never split a live delta across multiple
commits. If a runtime budget failure rolls back an admitted delta, record the
failure and route a later attempt to the rebuild path instead of retrying the
same oversized batch indefinitely. Report the selected update path.

## Concurrent reads

Each HTTP or MCP operation captures store, snapshot and epoch before any data
reads and checks them after all reads, before returning data or starting a byte
response. Use one ordered D1 session for that operation; if read replication is
enabled, begin at the primary and maintain sequential consistency. Sessions do
not make multiple separate queries a snapshot transaction. See
[D1 read consistency](https://developers.cloudflare.com/d1/best-practices/read-replication/).

If the epoch changed, discard the whole result. An unpinned read may retry once
from a new context; a pinned read or a second race returns the existing
`REVISION_CHANGED` error. A transient missing row must also pass this epoch
check before being reported as a genuine 404. No response may contain a mixture
of old ranking and new chunk bodies. MCP batches retain operation-level rather
than batch-wide read consistency.

Read bytes from the captured immutable R2 object, never from the editable source
prefix. Verify admission, digest and publication before starting the response.
Retain the object long enough for an already authorized bounded response to
finish; a later deletion does not cancel bytes already sent. New requests after
deletion or policy tightening cannot acquire authorization from an old reference.

## R2 references and cleanup

Keep the existing private mutable source and upload staging prefixes. Initially
new immutable objects may keep the existing job/target-revision path layout;
content-addressed storage is not required. Reuse prior immutable objects for
unchanged source bytes and store their actual locator in D1. All readers must
use that locator instead of constructing a key from the public snapshot.
The implementation uses `<vault>/<physical-store>/.updates/<job>/<path>` for
changed bytes; a full rebuild still creates its own complete source copy. Thus
reclamation of a retired full store cannot delete bytes reused by the active
store. Disabling ingestion does not disable locator-aware retrieval.
Expired job cleanup also enumerates its owned `.updates/<job>/` prefix and
queues unreferenced objects for aged reclamation. This covers termination after
R2 PUT but before checkpoint/retirement tracking was committed.

After this change, age or an obsolete revision prefix alone is not permission
to delete an object: an active store may still reference it. Track bounded GC
candidates and recheck references from active/retained stores and unfinished jobs
under writer/GC fencing. Publish references before retiring old ones. Enforce
at least the existing 24-hour unreferenced retention window and preserve mutable
source, upload plans and unrelated prefixes. Protect objects selected by an
unfinished job from concurrent GC before publishing a reference to them.

Every intermediate mutable D1 state is no longer a retained immutable snapshot.
Rollback protects a failed transaction; successful incremental commits are not
user-visible undo points. Replaced full stores retain the existing cleanup
window. Historical recovery and backup are separate concerns, not a reason to
copy the full live index on every edit.

## Optional Vectorize catch-up

For ordinary optional-semantic updates, commit lexical data and expected vector
membership first. Invalidate removed/replaced membership in that same transaction
and enqueue changed embedding inputs durably. Unchanged valid vectors remain
searchable while changed/new inputs catch up. Disabled consent prevents all
inference, probes and vector calls, including background catch-up.

Use a stable vault/physical-store/model-generation namespace for incremental reuse, with
immutable versioned vector IDs derived from chunk identity and the complete
embedding-input key plus the publishing job ID. The job ID prevents a later
content reversion from resurrecting an ID concurrently selected for GC; exact
embedding inputs can still reuse cached vector values. Do not overwrite an old content version at the same vector
ID. Content hash alone is insufficient: title/heading changes can change the
embedding input without changing chunk body text. Metadata remains minimal;
no bodies, paths, tags or frontmatter are sent to Vectorize.

For every candidate, D1 must validate current membership, expected vector ID,
embedding-input key, compatible model/generation, chunk/source integrity,
admission and structured filters. The final read epoch check still applies.
Do not treat unregistered vectors or old chunk IDs as authority to fetch bodies.

Persist receipts and bounded search-visibility probes. Registration acceptance
is not readiness. Mark work ready only with a conditional D1 update that still
matches its expected input/model; a superseded task cannot mark a newer chunk
ready. New index publications cannot erase pending tasks for unchanged inputs.
Cron/advance must resume catch-up even after the lexical job is complete.

While compatible semantic processing is operational but membership is pending,
search/related may return partial results with additive `SEMANTIC_UPDATING`
warnings, including an empty embedding-only result. Missing/disabled/incompatible
providers still use existing lexical fallback or embedding-only 503 behavior.
Do not claim pending results have full recall. Postfiltering invalid candidates
can reduce result count; preserve bounded candidate retrieval and its truncation
warning. Do not add unbounded retries to fill results.

Status gains an additive cloud-only semantic summary with state
`disabled | updating | ready | failed`, pending-input count, active snapshot and
last sanitized error code. Existing embedding availability must not label a
partially caught-up corpus fully ready. Lexical job completion means source and
lexical data are public; CLI output distinguishes that from semantic completion
and cleanup. Failure leaves lexical data and unaffected valid vectors usable,
with explicit warnings; durable work can retry without repeating publication.

Preserve `requireEmbeddings`: use a separately staged ready generation/store
and publish only after visibility checks pass. Initial implementation can retain
the existing full-build path for this stricter request. Model/dimension changes
also retain generation isolation. Local SQLite keeps its existing prepared
embedding application in the same transaction as lexical publication.

## Migration and implementation sequence

1. Add a portable prepared-delta representation and comparisons, adapting local
   updates to skip identical observation/link writes without changing local IDs,
   hashes, result semantics or vector atomicity. Test local/cloud parity.
2. Add versioned cloud schema for store identity, epoch, source locators, staged
   deltas, vector membership and catch-up. Migrate a legacy active snapshot into
   an initial store without reuploading private bytes or rewriting every edit.
   Read-only access to legacy data remains available during preparation.
3. Implement atomic lexical publication, read epoch handling and bounded rebuild
   fallback. Implement reference-aware GC before enabling object reuse.
4. Add optional vector catch-up, status/warnings and client completion handling.
   Do not ship partial semantics silently under the old all-ready contract.
5. Validate the complete path and migration, then compare user-visible updates.

Do not run legacy and new writers concurrently during rollout. Drain or explicitly
fail old in-flight jobs, preserve the last readable store and stage migration
under an exclusive fencing token. A stale legacy writer must be unable to commit
after the new layout is enabled. Version the writer/storage contract and disable
old application rollback against a mutated new store; recovery uses a compatible
reader/writer and a validated rebuild or backup. Never silently discard uploads.
Migration `0004_incremental.sql` revokes active legacy scan leases and adds a
writer-contract CHECK that rejects new legacy scan jobs. Existing upload intents
remain resumable. Apply migrations while old readers and scheduled writers are
quiescent, then deploy the compatible application; do not use mixed application
versions or roll back just the Worker binary after incremental writes start.

## Local implementation evidence

`incremental-publication.test.ts` uses the original-size 100-note/200-chunk
pattern to assert unchanged note/chunk/gram writes are absent and unchanged FTS
row identities are preserved. It also checks prepublication reads, pinned reads,
epoch races, ingestion-disabled retrieval, transaction rollback, recovery and
large-delta fallback, and native migration fencing. Shared-adapter tests cover
change/rename/delete and link parity with local SQLite. Semantic tests cover
pending results, input reuse, visibility delay, provider failure, title-only
input changes, superseded versions, consent and unaffected vector availability.
These are correctness checks, not a latency benchmark or hosted evidence.

## Acceptance and first comparison

Use synthetic content only. Start with the existing deterministic 100-note,
approximately 1.5 KiB, 200-chunk fixture plus SVG, changing one note as in
`2026-10-31-capacity.json`. This means one changed note in a 100-note vault, not
100 simultaneously changed notes. Include a later many-change case to exercise
fallback without conflating it with the primary comparison.

Measure from source-change completion to (a) exact new body and lexical result
availability and (b) verified semantic availability when enabled. Also record
successful/error reads during updating, temporary semantic omissions and
warnings. Distinguish detection wait from publication delay using existing job
progress observations; do not require new checkpoint telemetry. Use source GET
equality and revoked old IDs, not search marker hits alone, for correctness.

Compare baseline and candidate under the same corpus, driver, pacing, polling,
Cron settings, source-admission method and semantic configuration. The historical
approximately six-minute HTTP-driven lexical run is reference evidence, not a
matched CLI/Cron or semantic before/after. Run separate matched trials for real
CLI completion or autonomous Cron publication. State polling resolution and
sample count; choose numeric performance goals after the first comparison.
Existing aggregate counters may be reused, but no new phase-level timing or
production checkpoint logging is required initially.

Required correctness evidence includes no writes to unrelated note/chunk/FTS/gram
rows on a one-note edit; local/cloud result parity after full semantic catch-up;
add/delete/rename, title/alias changes and cross-note links; same-size edits;
failed batch rollback and lost responses; competing/stale writers; concurrent
HTTP/MCP reads and attachment responses; direct R2 races and exclusions; vector
lag, supersession and provider failures; strict embedding requests; fallback;
legacy jobs/migration; and reference-safe cleanup of reused source objects.

The original #48 report labels the grouped 503 unexplained. The operator later
identified it as Cloudflare rate limiting and supplied a reset time of
2026-11-01 00:00 UTC. Keep the original raw counters and null CPU/memory fields.
The disposable hosted comparison below ran after that reset; it neither changed
plans nor used the operator's deployment. Local/workerd tests establish operation
reduction and correctness, not hosted latency or capacity. Any further hosted
comparison must keep synthetic resources and verified teardown.

Hosted lexical evidence: [2026-11-01 matched update comparison](remote-incremental-update-2026-11-01.md).
The comparison includes migration from the baseline store and verified teardown;
it does not measure optional vector catch-up or actual Cron/CLI latency.
