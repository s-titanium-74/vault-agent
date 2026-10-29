# Hosted compact-workload and retention follow-up (#35)

Date: 2026-10-29. Paid validation remains on hold at the operator's request.
A newly created isolated Worker/D1/private R2 deployment rejected the 1,000 ms
CPU setting with code `100328`. The test removed that setting and did not change
billing. All source content was generated synthetic text. No AI/Vectorize binding
was configured, and every recorded provider counter was zero.

[Content-free evidence](../measurements/2026-10-29-follow-up.json).

## Separate compact corpus

This run used 100 atomic bilingual notes, each initially 27 UTF-8 bytes with a
heading and `apple 果樹園。`, plus one small SVG, an excluded probe and an unrelated
bucket-prefix probe. There was one chunk per note. This is **not equivalent** to
the earlier approximately 1.5 KiB / two-chunk corpus, whose full hosted mutation
cost measurements remain outstanding. It adds a small-content, 100-note functional
case within the existing account; it does not prove Free capacity for other vaults.

The initial experiment used an authenticated synthetic wrapper to call the same
production `tick` function, which can run eight bounded checkpoints. This changes
the test's HTTP round trips, not product API or Cron frequency. Its wall time is
not a CLI or autonomous publication latency measurement.

The grouped HTTP driver returned 503 during update link processing after the last
observed checkpoint 280; the job persisted at checkpoint 281. Platform analytics
continued to return a query-budget-depleted error after the stated retry window,
so no specific platform-limit cause is claimed. The run resumed that same job
through the normal single-checkpoint HTTP API. Explicit note and chunk retrieval
then returned the changed synthetic marker.

Rebuild used ordinary single-checkpoint advancement. Deletion encountered a
network `TypeError` after checkpoint 232 and also resumed its existing job.
Deletion published 99 notes, and both deleted note and chunk IDs returned 404.

| Phase                                 | Invocations recorded | D1 rows read / written | R2 get / head / list / put |
| ------------------------------------- | -------------------: | ---------------------- | -------------------------- |
| Initial: grouped synthetic tick       |                  107 | 22,760 / 4,959         | 102 / 101 / 2 / 101        |
| Update: grouped then resumed normally |                  207 | 23,096 / 4,956         | 102 / 101 / 2 / 101        |
| Rebuild: normal HTTP checkpoints      |                  416 | 22,519 / 4,961         | 103 / 101 / 2 / 101        |
| Deletion: normal HTTP, resumed        |                  412 | 20,621 / 4,912         | 100 / 100 / 2 / 100        |

The resumed phases mark `knownTelemetryGap=true`: an interrupted invocation may
have performed operations without appending its telemetry. Their counters are
therefore lower bounds; monitoring calls and pauses are also included. These
are not clean per-operation latency samples. Index/rebuild assertions include
search and explicit get. Source edits, operator SQL, report queries and each
telemetry insert consume resources outside the reported wrapper counters.
New CPU/peak-memory values remain null; wall time is not substituted for CPU.

## Age-equivalent native retention

The synthetic-only retention route requires the explicit runtime flag, HTTPS,
admin authentication, allowed Origin and the deployment limiter. It calls the
production cleanup/tick implementation rather than duplicating it. It is a test
entrypoint and must never be deployed with private content. Three local workerd
tests cover access control, active/young/source preservation, and staging/cache
retention guards.

After the mutation cycle, the operator explicitly set the creation timestamps
of two obsolete synthetic snapshots and one failed synthetic upload to zero,
while preserving a young snapshot. A persisted in-flight job lease fenced index
progress during cleanup. Synthetic orphan/reference cache bookkeeping rows were
added to exercise eviction guards; these were not actual provider embeddings.

In 23 authenticated ticks (80,226 ms including operator checks), the native
pipeline:

- Removed expired chunk/gram/note/source rows, the two old FTS tables and their
  immutable R2 objects.
- Reclaimed the failed upload's staging object, entries and job.
- Preserved the active revision/retrieval, young snapshot, mutable source and
  unrelated prefix; direct R2 reads independently checked preservation/removal.
- Retained the orphan cache entry while a job was in flight, then evicted it
  after the fence completed; retained a referenced cache entry.

Native tick counters were 1,376 D1 statements, 204,870 rows read, 2,823 rows written,
10 R2 list calls and 5 R2 bulk-delete calls. Control SQL, object checks and
instrumentation writes are excluded. The read amplification during per-chunk gram
cleanup is material even for short notes; do not estimate cleanup cost from row
writes alone. This test establishes age-eligible cleanup behavior, **not an actual
24-hour wait or Cron delivery across that interval**.

## Teardown and remaining gates

After preserving content-free evidence, the Worker/secrets were removed, all
303 remaining R2 objects were deleted, and D1 and R2 were removed. Provider reads
verified 404 for all three resources. Operator-local credentials/config were
removed. Provider backup retention is distinct from live-resource deletion.

Paid execution is intentionally deferred. Actual clean-account/Deploy-button
provisioning, original larger-corpus hosted mutation costs, real 24-hour timer
observation, repeated autonomous latency/reconciliation samples and optional
AI/Vectorize billed usage remain unverified. This follow-up does not close #35.

Use `remote-retention-smoke.ts PRIVATE_STATE_JSON REPORT_JSON PRIVATE_CONFIG
--age-synthetic-data` only after a completed isolated cost cycle. The matching
config must use `test/remote-retention-worker.ts` and `SYNTHETIC_RETENTION=true`.
To resume an interrupted cost phase, reuse its private deployment and report with
`remote-cost-smoke.ts ... PHASE --resume`; do not reuse reports across deployments.
The runner preserves existing telemetry and marks uncertainty from interrupted
requests. It retries idempotent network operations with a bounded backoff and
respects Retry-After on 429; index creation is not blindly retried.
