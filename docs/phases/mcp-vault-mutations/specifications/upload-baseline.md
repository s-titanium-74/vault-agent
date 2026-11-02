# R2 upload baseline (#54, step 4a)

Status: Implemented with local workerd verification. This prerequisite does not
expose Workers mutation tools; local MCP behavior is unchanged.

## Conflict rule

Keep a durable last-acknowledged upload digest/presence for each managed path in
D1, separately from index snapshots and expiring upload jobs. This baseline is
shared by uploads to this vault; it is not a two-way sync or a merge base for
multiple independent local checkouts. The CLI's local manifest still determines
the paths that `--delete-removed` is allowed to submit.

At admission and again before each source commit, compare the baseline, actual
current R2 content/presence, and proposed content/presence. If current and proposed
already agree, acknowledge without rewriting R2. Otherwise current must equal a
known baseline; a path without a baseline can only create an absent object.
Unknown baseline with an existing different object, cloud edits and cloud
deletions conflict with `UPLOAD_CONFLICT`. The rule applies to explicit deletes
and every manifest page. Never infer a baseline from an index snapshot or a
newly observed source ETag. Ordinary indexing and direct R2 edits do not update it.

An upload with a conflict on its first page is rejected before creating a job.
Additional-page conflicts leave the already acknowledged pages staged but do not
apply source changes. Batches remain per-file, not transactional across R2.

## Commit and recovery

Capture the baseline owner and R2 ETag per entry at admission. Immediately before
commit re-read and compare content; a changed baseline owner rejects the stale
plan. Conditional R2 PUT retains the captured ETag/create-if-absent condition;
a race after comparison returns `REVISION_CONFLICT`. A bounded source read
computes SHA-256 when R2 has no SHA-256 checksum. Source bytes are never stored
in D1 or returned by conflict errors. An unreadable/oversized source fails closed.

The existing conditional empty deletion marker represents absence and retains
no deleted body. This upload mechanism does not yet implement MCP's deletion
revocation overlay. Do not use unconditional R2 DELETE as a conditional operation:
the Workers binding exposes conditions on PUT, not DELETE (see the
[R2 API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)).

Persist an attempt marker under the lease before the external write, then the
baseline and processed checkpoint together under the lease and captured baseline
owner. After a lost PUT response an object bearing this job's upload marker and
exact intended checksum acknowledges the write without another PUT. Matching
content without a receipt can also be acknowledged as a no-op. If an attempted
write has no matching current result, fail closed with `UPLOAD_CONFLICT`, even
when current content reverted to the ancestor. A new plan with freshly reconciled
content is required. A failed D1 acknowledgment leaves the old baseline and
checkpoint intact; a fresh identical plan can acknowledge the saved source
without rewriting it. Baselines outlive job, staging and retired-snapshot cleanup,
including acknowledged deletion baselines.

## Migration

Migration `0006_upload_baselines.sql` starts with no inferred baselines. Existing
cloud data can be adopted only by uploading identical content (no R2 write);
otherwise users must reconcile their local files with current cloud data first.
There is no force flag. Old unfinished uploads are failed with
`UPLOAD_BASELINE_REQUIRED`; restart them as new plans after reconciliation.
Completed jobs stay completed. A writer-contract constraint rejects old upload
writers, including old saved plans resumed through the old binary. Quiesce old
Workers/Cron before migration and deploy the compatible binary before resuming.
Do not roll back just the binary after migration.

R2/D1 do not form one transaction. Conditional PUT compares ETags (content
identity), not R2 generation IDs. An authorized external writer's same-byte
rewrite/ABA between the last observation and PUT is not distinguished by that
condition. An already in-flight storage request is not cancelled by a D1 lease;
do not treat a D1 fence as an R2 transaction or promise hostile-writer isolation.
The attempt marker prevents later application-level replay after an uncertain
write; it cannot recall an already dispatched request.

Full mutation recovery/revocation, Workers MCP integration and hosted verification
remain subsequent #54 work.

## Verification

`upload-baseline.test.ts` executes HTTP upload requests in Miniflare/workerd over
synthetic D1/R2. Cases cover notes/attachments, first-page/additional-page edits
and deletes, physical/marker cloud deletion, unknown baseline, identical adoption
without a version change, late conditional-write races, competing plans,
interrupted receipt/attempt handling, stale acknowledgment rollback, D1 commit
failure and baseline survival after job cleanup. Migration tests reject old
upload writers and old unfinished plans without inferring existing baselines.
Injected request failures are controlled lost-checkpoint evidence, not real
process-termination or hosted-provider fault evidence.

Validation: Cloudflare tests passed (120 cases, including 24 new baseline cases),
as did Cloudflare typecheck, repository lint/format check and Wrangler deploy dry
run. A final upload/ingestion rerun after the bounded-read integrity check passed
38 cases. Existing search, semantic, incremental publication, retention, pCloud
and idle-reconciliation tests remain in the full Cloudflare suite.

Uses the existing `2026-10-28` compatibility date; the lockfile's workerd binary
supports dates only through `2026-10-30`. Latest API types retrieved for review:
`@cloudflare/workers-types@5.20261102.1`. No production migration/deploy or real
vault upload is performed by this implementation step.
