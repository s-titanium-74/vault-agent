# Hosted incremental-update comparison (2026-11-01)

Status: Matched lexical verification and teardown passed. Tracks #48; this
does not change account plans or certify capacity. Semantic and real-Cron
performance remain outside this comparison.

## Scope and method

Use one newly created disposable Worker, private R2 bucket and D1 database. Keep
Cron disabled, semantic consent false and AI/Vectorize unbound. Preserve the
operator-created deployment and its credentials/data. No CPU override or plan
change is made. The operator reported the previous rate limit would reset at
2026-11-01 00:00 UTC; control-plane, D1 write and Worker/R2 probes succeeded after
that time. This is evidence for the tested services, not a GraphQL budget claim.

Baseline production sources are pinned to
`0ceb48704ba7ff680c7ff5615010910fa759fcb3`. Candidate production sources are the
incremental-publication working tree, fingerprinted in the content-free report.
Both use the same instrumentation, synthetic wrapper, dependencies, Worker,
D1/R2 resources, rate limiter and HTTP driver. D1 was provisioned with the APAC
hint and reports HKG primary service. Replication is disabled. Run baseline
initial indexing and the baseline update; migrate to schema 0004, deploy the
candidate, restore the original source bytes with an unmeasured candidate update,
then repeat the identical one-note change. This also exercises migration from a
real legacy published store. Reusing the resources avoids attributing a resource
location difference to the code change; it is not a randomized experiment.

The corpus matches `sample-vault.mjs`: 100 bilingual Markdown notes, 1,521 bytes
per note, 200 chunks, plus a 113-byte SVG. Append the 34-byte synthetic marker
from the 2026-10-31 capacity trial to Note-0000; final note size is 1,555 bytes.
The exclusion probe is not uploaded. No real vault data is used.

The synthetic authenticated wrapper drives production `tick`, at most eight
checkpoints per call, with one second of client pacing and a job-status read
between calls. Start timing after the source mutation is acknowledged. Poll exact
note bodies and lexical marker search concurrently, with five-second waits
between observation cycles. Accept only the old or exact new body; classify any
`REVISION_CHANGED` separately from other read failures. Confirm the exact new
body and marker result after lexical job completion. The report separates job
completion time, first observed new body and first observed marker search.

These are accelerated HTTP-driven publication observations, not actual Cron
latency or CLI upload timings. Polling includes request overhead and has finite
resolution. One sample per version is a matched observation, not a distribution,
worst case, billing invoice or Free/Paid guarantee. Repeated baseline rebuilds
would consume a large part of the account-shared write allowance. Optional
semantic catch-up and provider billing are outside this lexical-only comparison.
CPU and peak memory remain null; do not substitute wall time.

Aggregate native D1/R2 counters reuse the existing synthetic instrumentation,
including its session-aware read counters. Telemetry receipt/reset writes and
source admission are outside these counters. The same read-poll cadence runs
for both versions, so total read counts include more observation requests in a
longer run; per-kind totals distinguish production ticks from other HTTP reads.
No new per-checkpoint production logging or CPU profiling is introduced.

## Results

| Metric                                           |           Baseline | Incremental candidate |
| ------------------------------------------------ | -----------------: | --------------------: |
| Source acknowledgment to observed job completion | 395,287 ms (6m35s) |    165,534 ms (2m46s) |
| Logical checkpoints / HTTP ticks                 |           511 / 64 |              209 / 27 |
| D1 rows written                                  |             24,203 |                 1,298 |
| D1 statements, including read observation        |              6,221 |                 2,514 |
| D1 rows read, including read observation         |             54,352 |                32,218 |
| R2 immutable copies (PUT)                        |                101 |                     1 |
| Concurrent get/search observations               |                120 |                    50 |
| Read errors / mixed bodies observed              |              0 / 0 |                 0 / 0 |
| Maximum measured single invocation wall time     |           7,535 ms |              5,394 ms |

In this pair, publication time fell 58.12% (2.39x), D1 writes fell 94.64%, and
R2 copies fell 99.01%. The candidate's final explicit body/search verification
was observed at 167,283 ms; this includes observation/request overhead. The
remaining work still includes all 101 source GETs and 101 final HEAD validations
in the production-tick counters, plus HTTP pacing and D1 round trips. Do not
attribute the whole residual latency to one stage without a separate measurement.

The initial baseline build wrote 24,175 rows and copied 101 R2 objects. After
migration 0004, restoring the original bytes used the incremental path (168,670
ms, 1,285 writes, one R2 copy); that preparatory reverse edit is not the matched
forward-update sample. Native FTS `MATCH` returned zero marker hits after restore
and one after the candidate update. Two physical stores remained throughout
candidate restoration/update; only the public epoch advanced to one and two.
The final job reported 99 notes reused, one changed chunk and 101 processed
source entries. The active source locator table contained one changed-path row.

Final HTTP checks rejected the baseline public snapshot with 409
`REVISION_CHANGED` even though its physical store was reused, and rejected a
missing bearer with 401. AI/vector counters were zero. These checks supplement
local rollback, fencing, migration, vector-lag and GC regression tests; they do
not constitute a hosted semantic or failure-injection suite.

### Baseline harness correction

The baseline job completed and exact new-body verification succeeded, but the
original driver then failed an overly strict assertion that expected the search
marker inside the compact snippet. The correct chunk was returned; the snippet
was a prefix that did not contain the late marker. This was a test assertion
problem, not evidence of a failed publication. The original failed report is
retained verbatim apart from omission of generated IDs.

Two follow-up read-only searches confirmed target identity, and a native FTS
`MATCH` query independently confirmed the indexed marker. The completed baseline
was not rebuilt or replaced. Its measured publication time and counters are kept;
the two known post-run search requests are excluded from its counter boundary.
Baseline first-body/search observation timestamps were not recorded before the
assertion failed and remain null. The corrected driver checks fresh exact body
plus search identity; the candidate completed that driver without correction.
Do not present the baseline original driver's `passed: false` as an ingestion
failure or hide it by rewriting the raw outcome.

### Cleanup and retained evidence

Purged 305 owned R2 objects / 459,783 bytes, confirmed the bucket was empty, and
removed the disposable Worker (including secrets), D1 and R2 bucket. Independent
provider reads returned HTTP 404 for all three. No changes were made to the
operator's deployment. Generated private state, secrets, configs, logs and
archived source copies are removed after retaining the content-free report.

[Raw comparison, counters, correction and cleanup evidence](../measurements/2026-11-01-incremental-update.json).

## Reproduction

Use the resource, secret and private-state procedures in the
[prior hosted instructions](remote-deploy-button-2026-10-31.md). State JSON holds
`name`, `endpoint`, `readToken`, `adminToken`, `vaultId` and `databaseId` outside
version control. Names must match `vault-agent-trial-` plus ten lowercase hex
characters. The setup wrapper requires `SYNTHETIC_VERIFICATION=true`, that trial
name in `TRIAL_NAME`, HTTPS and admin authentication. It must never be deployed
with private vault bindings.

Bundle [the synthetic update wrapper](../../../../packages/cloudflare/test/remote-update-worker.ts)
against each version's production sources and the same measurement wrapper.
Set `SYNTHETIC_RETENTION=true`, disable Cron and create the existing
`synthetic_telemetry(kind,wall_ms,counts)` test table after migrations. Fixture
loading uses bounded batches to fit the client timeout; setup retries are outside
all update windows. Keep every private config/state/log file under an ignored
operator-selected directory.

The [update driver](../../../../packages/cloudflare/scripts/remote-update-smoke.mjs)
accepts private state, report and phase arguments:

```sh
node packages/cloudflare/scripts/remote-update-smoke.mjs STATE REPORT probe
node packages/cloudflare/scripts/remote-update-smoke.mjs STATE REPORT seed
node packages/cloudflare/scripts/remote-update-smoke.mjs STATE REPORT baseline-initial
node packages/cloudflare/scripts/remote-update-smoke.mjs STATE REPORT baseline-update
# After schema 0004 and candidate deployment:
node packages/cloudflare/scripts/remote-update-smoke.mjs STATE REPORT candidate-restore
node packages/cloudflare/scripts/remote-update-smoke.mjs STATE REPORT candidate-update
```

Use distinct report paths. Only generated synthetic data belongs in these
reports. Preserve any failed run honestly. After retaining content-free evidence,
purge the owned test bucket, remove only the created Worker/D1/bucket, independently
verify their absence, and remove generated secrets/configs/state/logs. Do not
copy account IDs, private endpoints or credentials into the retained report.
