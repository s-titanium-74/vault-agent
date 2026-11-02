# Read-only idle reconciliation (#43)

Status: Implemented; local/workerd, disposable hosted Cron checks and teardown
passed. Paid-plan validation remains conditional and unverified.

This supersedes the observation-age freshness rule and idle scan admission in
[scoped ingestion](scoped-ingestion.md). Keep the one-minute Cron and the
existing opt-in storage/semantic boundaries.

## Detection before job admission

Resume committed uploads and active scans first. Otherwise read the published
store/snapshot/epoch and ingestion state, then list only the mutable source
prefix. Use the existing admission rules, including exclusions, attachments and
tombstones. Compare a canonical, path-sorted signature of kind, path, size,
ETag, object version and uploaded timestamp plus the complete processing policy
(scope/exclusions, ingestion/schema/chunking versions and semantic descriptor).
Share signature construction with durable scan planning. A legacy signature
requires one reconciliation to establish the new contract.

Only the final page can establish equality. Re-read publication and ingestion
state after listing; changed writer state, errors or publication require the
durable path. Missing signatures, failed jobs and an uninitialized deployment
also require that path. A successful equality check creates no job, entries,
lease, observation timestamp or history, and performs zero D1 writes. Restarting
the Worker simply repeats the read-only check; no in-memory state is required.

Limit the preflight to 8 LIST pages of at most 100 objects, 500 admitted entries
and the existing 20-second invocation deadline. Reject duplicate admitted
paths. Retain only canonical metadata for those entries plus the current page,
not note or attachment bodies. Check `truncated`, not page length. Excluded objects and tombstones count
toward page work, even though they are absent from the signature. If the page
or time budget is exhausted before the final page, report `deferred` and fall
back to the existing durable paginated scan, starting discovery again. This is
an explicit bounded-scan exception: it may write even if the eventual result is
unchanged. Never report an incomplete list as unchanged. More than 500 admitted
entries remains an explicit `INDEX_BUDGET_EXCEEDED` failure.

After detecting a difference, admit/resume the existing job rather than trusting
preflight data as publishable staging. Preserve final LIST validation,
lease/fencing and publication CAS. Concurrent source changes have the existing
sampled-manifest semantics: a paginated LIST is not a cross-object transaction,
and later edits are found on subsequent reconciliation. No stale historical
snapshot access is introduced.

## Maintenance and freshness

Run bounded reference-safe retention and optional semantic catch-up even when
sources are unchanged. Account for those writes separately from detection.
With no active work, no collectible data and a completed preflight, the entire
tick performs zero D1 writes. Skip empty cache deletion using a read-only
eligibility check. No other service stores the preflight state.

Detection status becomes `idle`, `updating`, `stale` or `unknown`: idle means
the last durable reconciliation completed, updating means a durable scan is
active, stale means a recorded reconciliation failure, and unknown means no
durable observation exists. Elapsed time alone never makes it stale. The
existing `lastObservedAt` remains the last **durably recorded** successful
reconciliation time, not the most recent Cron execution; add
`monitoring: "not_persisted"` to make that limitation explicit. A preflight
failure is visible in runtime logs, not a newly persisted status error. Old
recorded failures trigger durable recovery and clear only on successful work.

For autonomous ingestion, idle/unknown map to index freshness `unknown`, with
`INDEX_FRESHNESS_UNKNOWN` on retrieval; updating/stale retain their warnings.
HTTP and MCP must agree. A usable published snapshot is still retrievable, but
must not be labeled fresh relative to the mutable prefix or proof of Cron
health. Non-autonomous seeded deployments retain their existing behavior.

## Runtime logs

Emit start plus an outcome (`unchanged`, `changed`, `resumed`, `deferred`, or
`failed`) using console. Include only admitted counts, page counts, elapsed
milliseconds and allowlisted error codes. Do not emit paths, queries, note or
chunk bodies, request data, credentials, raw exceptions or provider responses.
Sanitize exceptions before allowing a scheduled invocation to fail.

Use dashboard real-time logs or a temporary `wrangler tail` session; real-time
logs do not persist log history. Keep persisted Workers Logs disabled by default
and distinguish enabling persistence from opening a real-time viewer. No new
log sink, notification, permanent history or D1 log writes are required.

References: [R2 LIST](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/),
[real-time logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/).

## Validation

Measure reads, writes, R2 operations and wall time separately. CPU is unknown
unless supplied by runtime telemetry. Test empty/1/99/multipage sources,
create/overwrite/same-byte rewrite/delete/rename, attachments, exclusions,
tombstones, policy changes, failures/restarts, duplicate Cron, admission and
publication races, stale IDs and maintenance without changes. Assert zero
native D1 rows written and no mutating SQL on completed idle probes, and inspect
logs with synthetic sensitive markers. Measure durable resume and collection
separately, including long-idle status and retention eligibility.

Record matched local/workerd before/after results and repeated disposable hosted
checks, including actual Cron and cleanup. A short repeated trial is not a
24-hour run or a Free/Paid capacity guarantee. Paid 1,000 ms validation remains
a follow-up conditional on an already available contract; no plan change or
billing activation is authorized by this issue.
