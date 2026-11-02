# Hosted validation status and limitations (#35)

Status: Baseline deployment and workload checks completed. The
[operator Deploy-button and original-size capacity run](remote-deploy-button-2026-10-31.md)
adds authenticated HTTP/MCP, real-Cron create/overwrite/rename/delete and
100-note initial/update/rebuild/deletion. The original-size deletion recovered
from a grouped HTTP 503 and has lower-bound counters. All isolated trials were
removed; the operator-created deployment was preserved with its original keys.

The [real-time retention run](remote-retention-wallclock-2026-10-30.md) is also
complete. Remaining limits are missing new CPU/peak-memory analytics due to the
provider query budget, unknown exact retention deletion time/no near-cutoff
observation, small latency samples, and unverified optional semantic billing.
None is converted to a Free/Paid or worst-case capacity guarantee.

Paid-plan validation is deferred until the #43 idle-reconciliation optimization
and is not a #35 completion gate. A fresh isolated deployment rejected `limits.cpu_ms=1000` with provider
code `100328`; removing that setting did not change account billing.

The [#43 idle optimization trial](remote-idle-reconciliation-2026-11-01.md)
subsequently verified zero production D1 writes across three actual unchanged
Cron runs, changed-source publication, separate eligible-cache collection and
complete disposable teardown. The 1,000 ms override was again rejected with
`100328`; Paid execution remains unverified. This short trial does not replace
24-hour measurements, semantic billing or broader workload capacity validation.

## Earlier compact-workload and age-equivalent method

The follow-up adds 100 compact atomic bilingual notes (one short line per note)
for update, rebuild and deletion, subject to actual remaining account quotas.
This differs from the earlier approximately 1.5 KiB two-chunk corpus; do not
claim it completes measurements of that larger fixture. Record native
admission/quota failures honestly; do not buy capacity or claim a smaller fixture
proves the original workload. Respect Analytics API retry windows and distinguish
its query budget from the retrieval Worker's limiter and D1 daily quotas.

Retention is tested separately using production cleanup against native D1/R2.
An authenticated synthetic-only wrapper calls the production `tick` function;
it is never a product route or used with private data. Explicitly age disposable
snapshot/job/cache timestamps past the existing 24-hour cutoff, fence in-progress
indexing while observing cleanup, and verify bounded deletion of old FTS/grams,
rows and R2 objects. Preserve active and young snapshots, in-progress job data,
mutable source and unrelated prefixes. This is an age-equivalent retention test,
not proof of actual 24-hour timer delivery. Record operation counters and teardown.

The optional `--scheduled-driver` cost mode uses the synthetic-only authenticated
wrapper to execute the same bounded production tick, including cleanup overhead,
then reads the job checkpoint. It reduces experiment HTTP round trips; it is not
a new product API, does not change Cron frequency, and does not establish CLI or
autonomous wall-time latency. Report this driver separately from earlier
single-checkpoint measurements. Retry 429 responses only after Retry-After;
persist sanitized quota/error codes instead of disguising an incomplete phase.

The compact run's synthetic batched HTTP driver returned 503 during link work.
Do not infer a D1/CPU quota cause without platform evidence: Analytics itself
continued to reject queries with a budget-depleted response after the retry
window. `--resume` preserves an incomplete phase's telemetry, resumes its owned
job in an isolated deployment using normal HTTP single-checkpoint advancement,
and marks a possible telemetry gap from the failed invocation. Such counters
are lower bounds, and the wall time includes the interruption. Later fresh
phases retain their own clean measurement windows. Wrangler logs are stored
alongside private reports, not a required writable home directory.

Recorded results and limitations: [hosted follow-up](remote-follow-up-2026-10-29.md).

A [real-time retention trial](remote-retention-wallclock-2026-10-30.md) completed
with production Cron and unmodified timestamps. At the final observation about
32.8 hours after preparation, obsolete snapshot/staging data were gone while
current/source/unrelated data and search/get were intact. All trial resources
and private operator credentials were removed, with provider 404 checks. There
was no observation immediately before the cutoff and the exact deletion time
is unknown; these limits are recorded separately from the earlier aging test.

## Changed-source optimization (#48)

The [2026-11-01 paired lexical comparison](remote-incremental-update-2026-11-01.md)
passed migration, changed-note publication, concurrent reads, stale-pin rejection
and owned-resource teardown. It used accelerated HTTP ticks with semantic disabled.
Actual Cron/CLI timing, hosted semantic catch-up and broader workload distributions
remain separate validation work; no capacity or billing guarantee follows.

The later [verified source-observation reuse](source-observation-reuse.md)
follow-up passes local operation-count and consistency regressions and a
[hosted lexical measurement](remote-source-observations-2026-11-01.md): 7,974 ms
to observed completion, with one concurrent search revision-conflict response.
The earlier 2m46s sample does not include this optimization. The two runs use
different resources; neither certifies actual Cron timing or latency distributions.
