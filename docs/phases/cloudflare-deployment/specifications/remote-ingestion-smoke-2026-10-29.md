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

## Initial semantic observation and bounded operation counts

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
and exclusion of retained old vectors after deletion. The initial hosted run
validated one actual generation; the additional run below verifies hosted cache
reuse and post-deletion queries. The first test Cron was disabled after
observation; already admitted work could finish while the schedule change
propagated.

## Additional hosted semantic validation

A second isolated deployment ran the reusable
`scripts/remote-ingestion-semantic-smoke.ts` against two synthetic notes with
real Workers AI and Vectorize. Its wrapper added content-free counters around
the native bindings; it did not replace provider responses. The production
handlers came from `0b7ef9f` with that instrumentation. The later writer-admission
fix described below has separate workerd regression coverage.

| Phase                                   | Additional ingestion AI calls / inputs | Result                                                   | Runner wall time |
| --------------------------------------- | -------------------------------------- | -------------------------------------------------------- | ---------------- |
| Initial mandatory-embedding rebuild     | 2 / 2                                  | Two query-visible vectors; published ready generation    | 191,103 ms       |
| Mandatory rebuild with identical source | 0 / 0                                  | Reused exact model/input cache; new ready generation     | 180,611 ms       |
| Incremental update of one note          | 1 / 1                                  | Only the changed input was embedded; ready generation    | 124,735 ms       |
| Direct R2 deletion of the other note    | 0 / 0                                  | Real Cron published deletion without advance/index calls | 319,440 ms       |

The deletion runner was waiting before the source object was removed; its wall
time includes that short setup interval. After publication, explicit note and
chunk retrieval returned 404. An actual embedding search returned only the
surviving note. A separate native Vectorize `get_by_ids` confirmed that the
removed note's vector from the first generation was still stored: retrieval
revocation therefore did not depend on physical vector cleanup. The old vector
and all other disposable data were removed during teardown.

The four generations stored seven query-visible vector records and three
exact-input cache entries. Total native AI calls/inputs were four: three from
ingestion plus one explicitly requested search query after deletion. The
scheduled deletion processing itself made zero AI calls.

The second run's instrumented operation sample was:

| Invocation kind | Count | Wall time range | Maximum D1 statements | Total D1 rows read / written |
| --------------- | ----- | --------------- | --------------------- | ---------------------------- |
| GET             | 36    | 79–1,282 ms     | 7                     | 377 / 0                      |
| POST            | 296   | 289–1,876 ms    | 12                    | 3,173 / 1,687                |
| Scheduled       | 5     | 3,325–15,336 ms | 81                    | 440 / 249                    |

Counters exclude the appended telemetry-row write. The sample does not measure
CPU or establish maximum-vault cost limits. The account stayed on its existing
Free plan, with the custom paid-plan CPU setting omitted. The R2 managed public
domain was verified disabled.

Review during validation also found a writer-admission race: a losing explicit
rebuild/new-scan/mandatory-embedding request could receive a different job.
Fault-injected workerd tests reproduced the incorrect 200 response. The publisher
now returns 409 `INDEX_BUSY` for those requests after losing admission, preserving
the caller's work requirements. All 45 cloud tests passed after the fix.

## Cleanup

The disposable Worker, its secrets and Cron, Vectorize index, D1 database,
R2 objects and bucket are removed after observation. Teardown is checked by
resource reads: Worker, database and bucket returned 404; Vectorize returned
410 `vectorize.index.deleted`. The additional run also removed its Worker,
secrets/Cron, eight R2 objects and bucket, database and Vectorize index, with
absence checked through the same resource reads. No account configuration or
existing project resource is modified. Resource deletion is distinct from provider backup retention.

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

For the additional semantic run, provision a dedicated Vectorize index and its
`chunkId` string metadata index, apply the migrations, enable embedding consent
and add only these synthetic source files under the configured source prefix:

```json
{
  "Notes/Apple.md": "# Apple\nSynthetic apple trees grow in an orchard.\n",
  "Notes/Pear.md": "# Pear\nSynthetic pear trees bear fruit in summer.\n"
}
```

For the changed-input phase, replace only Apple with
`# Apple\nSynthetic orchard apples need winter pruning and spring water.\n`.
The instrumented entrypoint requires a synthetic-only table:

```sql
CREATE TABLE synthetic_telemetry(kind TEXT, wall_ms INTEGER, counts TEXT);
```

Run `rebuild` twice, comparing native AI-call/input counters in that private D1
table between phases; both runs must publish ready generations and the second
must add zero calls. Change only the Apple note and run `index`; it must add one
ingestion input. Start `wait-deleted`, wait for its `REPORT_JSON.ready` signal,
then delete only the Pear source object through the R2 API/dashboard. That mode
polls reads and issues a single explicit embedding query after deletion. It
never drives a job. Always compare counters before that query so query inference
is not mistaken for an ingestion cache miss.

```sh
node --import tsx packages/cloudflare/scripts/remote-ingestion-semantic-smoke.ts PRIVATE_STATE_JSON REPORT_JSON rebuild
node --import tsx packages/cloudflare/scripts/remote-ingestion-semantic-smoke.ts PRIVATE_STATE_JSON REPORT_JSON index
node --import tsx packages/cloudflare/scripts/remote-ingestion-semantic-smoke.ts PRIVATE_STATE_JSON REPORT_JSON wait-deleted
```

## Shared update core follow-up

The subsequent shared-core refactor has separate local coverage: the same
synthetic corpus runs through SQLite/watch and workerd/D1/R2 and produces
compatible note/chunk rows after create, edit, rename and delete. Regression
coverage also verifies exact-input reuse, invalid-cache repair, legacy SQLite
migration, link re-resolution and mandatory/optional provider failure.

After explicit authorization, a third isolated deployment ran the same two
synthetic notes against the production handlers from `7c90137` with the existing
content-free instrumentation. Both GitHub workflows passed for that revision.
All 715 local checks passed (661 root tests, 8 distribution tests and 46 Worker
tests), along with type checks, lint, formatting and builds.

| Phase                       | Additional ingestion AI calls / inputs | Result                             | Runner wall time |
| --------------------------- | -------------------------------------- | ---------------------------------- | ---------------- |
| Initial mandatory rebuild   | 2 / 2                                  | Ready generation, two vectors      | 112,674 ms       |
| Identical mandatory rebuild | 0 / 0                                  | Reused cache, new ready generation | 146,451 ms       |
| Edit Apple only             | 1 / 1                                  | Only the changed input regenerated | 133,041 ms       |
| Direct R2 deletion of Pear  | 0 / 0                                  | Actual Cron published deletion     | 246,669 ms       |

The deletion runner started before the direct R2 removal and performed zero
administration checkpoints. Real scheduled invocations published a ready
replacement. Explicit note and chunk retrieval returned 404; an actual embedding
query returned only Apple. Native Vectorize `get_by_ids` separately confirmed
that Pear's first-generation vector was still stored, proving that retrieval
revocation did not depend on physical cleanup. The explicit search added one
AI call/input, bringing the total to four; scheduled processing added zero.
Four ready generations, three exact-input cache entries and seven vector
upserts were observed.

The follow-up operation sample was:

| Invocation kind | Count | Wall time range | Maximum D1 statements | Total D1 rows read / written |
| --------------- | ----- | --------------- | --------------------- | ---------------------------- |
| GET             | 30    | 103–466 ms      | 7                     | 311 / 0                      |
| POST            | 236   | 287–1,585 ms    | 12                    | 2,573 / 1,447                |
| Scheduled       | 6     | 4,706–16,212 ms | 82                    | 439 / 247                    |

These counters exclude the wrapper's telemetry insert and cover a functional
sample, not a cost or CPU benchmark. Cron configuration propagation is included
in the deletion wait. The R2 managed public domain remained disabled, and no
account plan was changed. After observation the Worker/secrets/Cron, all eight
R2 objects and bucket, D1 database and Vectorize index were removed. Resource
reads verified 404 for Worker/bucket/database and 410 for Vectorize. The private
operator credential file was removed as well.
