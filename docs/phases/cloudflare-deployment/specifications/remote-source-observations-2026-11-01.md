# Hosted source-observation reuse measurement (2026-11-01)

Status: Hosted lexical measurement, final verification and teardown passed.

## Method

Measure the current #48 working tree with verified R2 observation reuse and
the final paginated source validation enabled. Use one new disposable Worker,
private R2 bucket and D1 database, migrations 0001–0005, no Cron triggers and no
AI/Vectorize bindings or semantic consent. No CPU override, account plan change,
operator deployment changes or real vault content are involved. The bucket's
managed public domain is disabled and it has no custom domains. D1 is created
in APAC with read replication disabled; setup responses report ICN service.

Use the same synthetic wrapper, fixture and HTTP driver as the
[earlier comparison](remote-incremental-update-2026-11-01.md): 100 bilingual
1,521-byte notes, 200 chunks and one 113-byte SVG. Build the current index from
scratch to establish verified observations, then append the identical 34-byte
marker to Note-0000. Keep the first build separate from the warmed update.

Time from the acknowledged source change through observed job completion.
Drive production ticks with at most eight checkpoints per call, one second of
client pacing and job-status reads between calls. Concurrently poll exact note
body and lexical marker search with five-second observation waits, then verify
both after completion. Counters include those reads; per-kind totals separate
production ticks. Fixture admission and telemetry receipt/reset writes are
excluded. Do not add checkpoint logging or infer CPU time from wall time.

This is one hosted update observation, not actual Cron/CLI latency, a latency
distribution, capacity certification or a billing estimate. The earlier 2m46s
sample used different disposable resources and an HKG D1 primary; this run's
historical timing comparison is not a same-resource paired experiment. Operation
counts provide stronger evidence of the specific work removed. Preserve the
earlier report unchanged.

## Results

| Metric                                              | Current warmed update | Earlier incremental sample |
| --------------------------------------------------- | --------------------: | -------------------------: |
| Observed job completion                             |              7,974 ms |                 165,534 ms |
| Final exact body and marker search verified         |              9,295 ms |                 167,283 ms |
| Durable checkpoints / HTTP ticks                    |                 9 / 2 |                   209 / 27 |
| Production source GET / HEAD / LIST / immutable PUT |         1 / 0 / 4 / 1 |          101 / 101 / 2 / 1 |
| D1 rows written, including measured HTTP calls      |                   502 |                      1,298 |
| D1 queries, including read observations             |                   283 |                      2,514 |
| D1 rows read, including read observations           |                15,120 |                     32,218 |

The observed publication duration is 95.18% shorter than the historical sample.
Resources and primary location differ, so do not attribute that exact percentage
solely to this implementation or present it as a paired benchmark. The current
sample retains both final LIST pages, establishes new observation evidence only
for the changed file and uses one immutable copy. Its maximum measured single
invocation wall time is 3,826 ms; CPU remains unmeasured.

The separate initial build took 256,992 ms, 411 checkpoints / 52 HTTP ticks,
23,980 measured D1 row writes and 101 immutable copies. This is setup from an
empty database, not migration bootstrap or the one-note update sample.

Concurrent get/search polling made four observations. One search returned 409
`REVISION_CHANGED` during publication; no other errors or unexpected/mixed note
bodies were observed. This is a visible retry response, not a zero-error result.
Final fresh body and marker search succeeded at 9,295 ms; neither was observed
earlier by the sparse concurrent poll, so both recorded first-visibility fields
use final verification as an upper bound. A client may need to retry at the
publication boundary. Do not infer error rates from four observations.

Independent native FTS found one marker hit. The final publication has 101
source observations for 101 sources, one changed-source locator, one physical
store and epoch two. The old public snapshot is rejected with 409
`REVISION_CHANGED`, and a missing bearer is rejected with 401. AI and vector
counters are zero. This does not replace local rollback/migration/fencing tests.

## Teardown and evidence

Purged 203 owned R2 objects / 306,015 bytes and confirmed an empty bucket.
Deleted the created Worker (including secrets), D1 and R2 bucket. Independent
GET requests for each returned provider errors containing HTTP 404. Removed
private state, secrets, configuration, logs and the saved pre-optimization source
copy after preserving content-free evidence. The operator's deployment was not
used or changed.

[Raw sanitized report and counters](../measurements/2026-11-01-source-observation-reuse.json).
Source, migration and harness fingerprints are included for reproducibility.
Reuse the earlier wrapper/driver instructions, applying migration 0005 as well.
The driver's `baseline-initial` phase name is used only to trigger a fresh build;
the retained report labels that phase `current-initial-build` to avoid implying
that historical baseline production code was deployed in this run.
