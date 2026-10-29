# Hosted self-deployment validation (#35)

Date: 2026-10-29. All files were generated synthetic content. This run used the
operator's existing account and newly created, dedicated Worker/D1/private R2
resources. It validates the documented Wrangler flow, **not a clean account or
the Deploy button**. No subscription or account plan was changed. The generated
configuration omitted the Paid custom CPU limit. No AI/Vectorize resource was
bound and embedding consent stayed false.

[Content-free measurements](../measurements/2026-10-29-hosted.json).
Resource/account identities, endpoint and credentials are omitted.

## Provisioning and clients

The guide's actual Wrangler commands created a new D1 database and private R2
bucket, then the configuration generator created a stable vault UUID and local
ignored configuration. Two independently random read/admin secrets were
installed. The normal deploy script applied migrations 0001–0003 before deploying
`src/index.ts` with the generated configuration and one-minute Cron.
Provider reads verified private R2 managed-domain access disabled, D1 read
replication disabled, preview URLs disabled and the intended Cron schedule.

The actual CLI completed four smoke groups in 93,372 ms, with 50 indexing
checkpoints: scoped upload/search/explicit get/attachment metadata, note edit and
rename with stale-ID revocation, read/admin separation, and subsequent explicit
deletion. This functional fixture is separate from the standardized cost corpus.

The read-only client runner checked public health, unauthenticated/invalid-token
rejection, read-token rejection on uploads, lexical search and revision-pinned
explicit get (including 409 on a stale pin). A real SDK Streamable HTTP client
initialized the native remote `/mcp`, listed all 18 tools and successfully called
search and explicit get. It did not use the local stdio bridge.

## Actual autonomous R2 changes

`scripts/remote-autonomous-smoke.ts` changed only the dedicated source prefix
through Wrangler, while the uploader was disconnected. Its retrieval requests
used the read token; it issued **zero** admin/index/job-advance requests.

| Direct source action                        | Publication observed after last mutation completed |
| ------------------------------------------- | -------------------------------------------------: |
| Create note (plus excluded synthetic probe) |                                         314,960 ms |
| Overwrite note and replace image            |                                         177,239 ms |
| Rename by create + delete                   |                                         163,695 ms |
| Delete renamed note                         |                                         123,687 ms |

The runner polled at ten-second intervals. These are observation latencies for
one sample each, not percentiles or an SLA; mutations in each phase also took
about 1–4.5 seconds. Creation and overwrite returned the new note marker; the
image's authenticated download returned the replacement bytes. Rename and
deletion revoked the old note/chunk IDs, deletion removed the search hit, and
the excluded probe never appeared in search. No failed jobs were observed.

First `updating` status was observed at 43,175 ms for overwrite, 51,317 ms for
rename and 62,135 ms for deletion. Creation had no such observation. These status
samples are **not exact detection latency**: status can prioritize stale age,
and an existing scan does not prove a particular source change was observed.
Publication is the end-to-end evidence. All four small-corpus publications were
inside the specified 15-minute conditional target.

## Secret rotation and provider propagation

The old read/admin values were installed as their respective previous secrets,
then new independent values became current. During overlap, new and previous
credentials worked and read credentials still could not upload. Both previous
secrets were deleted using Wrangler. An immediate check still accepted an old
credential; a later check confirmed both old values returned 403 while both
current values returned 200 and privileges remained separated.

The successful later check was 224,230 ms after the deletion commands completed;
checks were not continuous over that interval, so this is an upper observation
bound, not a measured exact revocation delay. Application authentication runs on
every request, but secret deployment changes still require provider propagation.
The guide now requires checking revocation after propagation rather than assuming
instant global revocation from a successful secret-delete response.

## Native D1/R2 cost sample

After functional validation, the same dedicated deployment switched to the
existing synthetic-only counter wrapper around the production handlers. It added
no administration endpoints. All counts below come from native remote bindings.
The public sample generator supplied the standardized approximately 1.5 KiB
English/Japanese notes and SVG. Source changes were operator R2 writes, not CLI
upload staging. Existing functional snapshots remained retained in this database.

Cron was disabled before client-driven cost measurement. Nevertheless, two
small-corpus phases and the 100-note initial phase observed scheduled invocations
during configuration propagation. Those invocations are included in the counters,
not subtracted or mislabeled as isolated HTTP work. Exact checkpoint retries and
concurrent scheduled progress can change counts relative to local emulation.

| Phase                           | Invocations (scheduled included) | Native rows read / written | R2 get / head / list / put | Runner wall time |
| ------------------------------- | -------------------------------: | -------------------------- | -------------------------- | ---------------: |
| 1 note: initial                 |                           18 (0) | 311 / 292                  | 3 / 2 / 1 / 2              |        21,695 ms |
| 1 note: one-file update         |                           23 (1) | 326 / 192                  | 3 / 2 / 1 / 2              |        26,275 ms |
| 1 note: rebuild                 |                           17 (0) | 256 / 192                  | 3 / 2 / 1 / 2              |        20,301 ms |
| 1 note: deletion                |                           15 (1) | 151 / 57                   | 1 / 1 / 1 / 1              |        15,005 ms |
| 100 notes / 200 chunks: initial |                          540 (8) | 33,123 / 23,961            | 102 / 101 / 2 / 101        |     1,160,291 ms |
| 100 notes: 20 searches          |                           20 (0) | 37,540 / 0                 | 0 / 0 / 0 / 0              |        13,035 ms |
| 100 notes: 20 explicit gets     |                           20 (0) | 220 / 0                    | 20 / 0 / 0 / 0             |        11,611 ms |

Index/update/rebuild phases include a subsequent search and explicit get;
deletion includes two stale-ID assertions. Search alternated English/Japanese.
The initial 100-note phase made 529 client advance requests with one-second
minimum spacing. Its longest instrumented invocation wall time was 22,629 ms.
The one-note changed input retained repeated multilingual text; it differs from
the short replacement used by the earlier local benchmark.

Counters exclude operator source writes, migrations, telemetry table maintenance,
report queries and the wrapper's one telemetry-row write per invocation. These
excluded operations still consume real service resources. Retained database
size was 4,587,520 bytes including instrumentation, FTS/gram indexes and job
history. Before the maximum-note probe R2 held 237 objects / 310,202 bytes;
after it R2 held 237 objects / 2,405,833 bytes. These are point-in-time observations,
not GB-month measurements. Every AI/vector counter was zero, consistent with
absent bindings and disabled consent; no inference cost is estimated.

## Platform CPU and V8 memory

Official GraphQL analytics were queried by this Worker and each phase's time
window. Schema introspection confirmed CPU/wall-time quantiles are microseconds
and V8 isolate memory quantiles are bytes. Values below convert CPU to ms.
These sampled invocation quantiles are **not maximum heap measurements** or
worst-case capacity certification. The cost runner keeps its per-call CPU/peak
fields null; platform quantiles are stored in a separate report section. The instrumentation adds its own overhead.

| Measured window                  | CPU P50 / P99 (ms) | V8 memory P99 (bytes) |
| -------------------------------- | ------------------ | --------------------: |
| 1 note: initial                  | 7.064 / 12.498     |            13,434,261 |
| 1 note: one-file update          | 11.693 / 34.970    |            13,194,198 |
| 1 note: rebuild                  | 11.330 / 21.349    |            13,160,457 |
| 1 note: deletion                 | 7.508 / 18.684     |            11,514,718 |
| 100 notes: initial               | 8.140 / 45.058     |            13,820,183 |
| 100 notes: 20 searches           | 47.843 / 64.793    |            27,959,818 |
| 100 notes: 20 gets               | 15.341 / 20.092    |            26,779,258 |
| Maximum-size note failure window | 9.998 / 113.250    |            40,577,876 |

For the 100-note initial window, analytics returned 533 successful invocations
and one `clientDisconnected` observation; wrapper telemetry recorded 540 total
invocations. Analytics ingestion/sampling and instrumentation boundaries differ;
these counts must not be treated as identical billing ledgers. A filtered native
tail sample recorded 770 events, maximum observed CPU 113 ms, and one canceled
outcome. It retained only timings/outcomes, never request headers/content.

Some observed CPU values exceed the documented Free HTTP budget. This successful
sample therefore provides **no Free-capacity guarantee**, and it did not validate
the Paid 1,000 ms configured ceiling. See [dated pricing and assumptions](cost-and-limits.md).

## Maximum-size failure and cleanup

An exactly 2,097,152-byte generated UTF-8 multilingual note was placed in the
source prefix using Wrangler. The job failed with `INDEX_BUDGET_EXCEEDED`.
The active revision did not change, and the last published note still returned
its original synthetic content. A source upload-size allowance is not an indexed
row/chunk admission guarantee. The failed job's content was never published.

Worker/secrets/Cron were removed first, followed by all 237 R2 objects, the
dedicated D1 database and private bucket. Provider reads confirmed 404 for all
three resources. No existing resource or account plan was modified. Operator-local
credential/state files were removed after retaining only content-free evidence.
Live-resource deletion is distinct from provider backup retention.

## Reproduction and remaining gates

Use new disposable resources and a private state JSON containing `endpoint`,
`vaultId`, `readToken`, `adminToken` and, for mutation/cost runners, `name`.
The autonomous/cost runners require a generated `vault-agent-trial-` name with
ten lowercase hex characters and a matching private Wrangler configuration.
They must never be pointed at an existing vault.

```sh
node --import tsx packages/cloudflare/scripts/remote-ingestion-smoke.ts PRIVATE_STATE_JSON REPORT_JSON
node --import tsx packages/cloudflare/scripts/remote-client-smoke.ts PRIVATE_STATE_JSON REPORT_JSON
node --import tsx packages/cloudflare/scripts/remote-autonomous-smoke.ts PRIVATE_STATE_JSON REPORT_JSON PRIVATE_CONFIG --allow-synthetic-r2-writes
```

The cost runner requires `test/remote-ingestion-worker.ts` as the disposable
entrypoint and `CREATE TABLE synthetic_telemetry(kind TEXT,wall_ms INTEGER,counts TEXT)`.
Supply generated sample sources using the guide's direct R2 procedure, then run
`remote-cost-smoke.ts PRIVATE_STATE_JSON REPORT_JSON PRIVATE_CONFIG PHASE`, with
phase `initial`, `update`, `rebuild`, `delete`, `search` or `get`. Never use the
instrumentation entrypoint with private data. Always remove all resources.

Remaining #35 gates: actual clean-account and Deploy-button provisioning;
Paid-plan execution; hosted 100-note update/rebuild/deletion, full 24-hour cleanup,
repeat latency/retry/reconciliation distributions and optional AI/Vectorize billed
usage. The local 100-note mutation measurements remain separate. This run advances
the draft PR; it does not close #35 or imply all release gates passed.
