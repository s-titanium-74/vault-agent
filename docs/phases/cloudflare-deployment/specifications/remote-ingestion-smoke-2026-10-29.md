# Deployed scoped ingestion smoke (#34)

Date: 2026-10-29. All content was synthetic. No private vault was read.
A new disposable Worker, private R2 bucket and D1 database were used, followed
by a dedicated Vectorize V2 index for the additional semantic observation.
The account and resource identities, endpoint and credentials are deliberately
omitted. The account plan was not changed. Read replication, observability,
Logpush, preview URLs and public bucket access were disabled.

## CLI and autonomous source updates

The regular production `src/index.ts` entrypoint handled the following five
successful groups, driven by `scripts/remote-ingestion-smoke.ts` and the actual
CLI, not a synthetic administration endpoint:

1. Explicit scoped upload of two notes and an attachment, followed by lexical
   search, explicit get and attachment metadata retrieval.
2. Changed note, rename and `--delete-removed`; old note and chunk IDs returned
   404 and the renamed note became retrievable.
3. Read-token rejection on administration routes.
4. Direct R2 overwrite, creation and deletion while the local uploader was
   disconnected. Real once-per-minute Cron progressed D1 checkpoints and
   published the new immutable snapshot without an admin advance request.
5. Subsequent explicit CLI deletion and verification that the removed ID
   remained unavailable.

The runner took 349 seconds in total, including real Cron waiting. It issued
31 read/assertion requests and recorded 54 completed indexing checkpoints from
its three CLI operations; those counts exclude the CLI's own HTTP requests.
This is a functional smoke, not a latency percentile or load benchmark.

The direct-change snapshot contained exactly the two allowed notes and image.
The removed note was absent. The image digest matched the changed synthetic
image bytes. Its resolved link graph targeted the newly created note. Hidden,
user-excluded and out-of-scope objects were absent from the published manifest.
Local tests also verify that revision-pinned gets cannot route to an old snapshot.

## Semantic observation and bounded operation counts

A separate disposable `test/remote-ingestion-worker.ts` entrypoint wraps the
same production handlers with content-free D1/R2 operation counters. It adds
no administration endpoints. A dedicated 1024-dimension cosine Vectorize
index and `chunkId` metadata index were created, with separate embedding
consent enabled for the two synthetic notes.

Real Cron produced two persisted embedding cache entries, two query-visible
vector records, a ready embedding generation and its published active pointer.
The observed sequence passed the actual Workers AI and Vectorize adapter
visibility checks. These were cloud-side autonomous operations; the additional
client-driven semantic runner was not executed.

Six instrumented scheduled invocations observed during this sequence had:

| Metric                                       | Observation       |
| -------------------------------------------- | ----------------- |
| Per-invocation wall time                     | 11,806–22,408 ms  |
| Maximum D1 statements in one invocation      | 88                |
| D1 rows read / written in total              | 843 / 269         |
| R2 get / head / list / put / delete in total | 3 / 3 / 1 / 3 / 0 |

Counters exclude the single telemetry-row write appended by the test wrapper.
Wall time includes remote binding and provider latency, not CPU time. Cron
stops starting checkpoints after 20 seconds; an already started checkpoint can
finish afterward. The sample is small and does not establish worst-case limits.
The sample account uses the Free plan, so the custom paid-plan 1000 ms CPU
setting was omitted. Paid-plan CPU and full-size-vault measurements remain a
release gate under #35; no plan upgrade was performed.

Local workerd tests separately verify exact-input embedding cache reuse,
visibility delay, unavailable-provider fallback, mandatory-embedding failure
and exclusion of retained old vectors after deletion. A second real semantic
rebuild/cache-reuse and post-deletion query test remains unverified. Treat it
as an additional hosted verification gap rather than extrapolating from this
single real generation. The test Cron was disabled after observation; already
admitted work could finish while the schedule change propagated.

## Cleanup

The disposable Worker, its secrets and Cron, Vectorize index, D1 database,
R2 objects and bucket are removed after observation. Teardown is checked by
resource reads: Worker, database and bucket returned 404; Vectorize returned
410 `vectorize.index.deleted`. No account configuration or existing project resource
is modified. Resource deletion is distinct from provider backup retention.

## Reproduction

Provision new isolated resources, apply migrations 0001–0003, configure a new
vault UUID, include Notes/images and exclude the synthetic secret path, and
set independent random read/admin secrets. Use a private operator-local JSON
file with `endpoint`, `vaultId`, `readToken` and `adminToken`.

From the repository root:

```sh
node --import tsx packages/cloudflare/scripts/remote-ingestion-smoke.ts PRIVATE_STATE_JSON REPORT_JSON --watch
```

The runner saves a `watch-ready.json` alongside its private state. During that
wait, modify the allowed source prefix through the Cloudflare API/dashboard;
do not call advance/index/upload to drive that change. The runner only polls
explicit get while waiting for the synthetic marker. Never use existing vault
bindings for this procedure. Remove the disposable resources and credentials
at the end of every run.
