# Remaining hosted validation (#35)

Status: Compact-workload and age-equivalent native retention follow-up completed;
Paid-plan validation is explicitly on hold at the operator's request. A fresh isolated deployment rejected `limits.cpu_ms=1000` with provider
code `100328`; removing that setting did not change account billing.

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
