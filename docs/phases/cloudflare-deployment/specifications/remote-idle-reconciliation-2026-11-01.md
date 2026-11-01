# Idle reconciliation measurement (#43, 2026-11-01)

Status: Local/workerd, repeated hosted idle/changed-source checks, actual Cron
and independent teardown verification passed. Paid-plan validation is unverified.

## Method and boundaries

Use one newly created disposable Worker, private R2 bucket and D1 database in
APAC with read replication disabled. Apply migrations 0001–0005. No AI or
Vectorize bindings, semantic consent, real vault content, account plan change
or operator-deployment changes. Managed public R2 access is disabled and there
are no custom bucket domains. Only the authenticated Worker endpoint is enabled;
preview URLs and persisted Workers Logs remain disabled.
The isolated synthetic driver's rate-limit binding is 1,000 requests/minute;
the product template's 120 requests/minute setting is unchanged.

The fixture is the existing remote-update wrapper's 100 bilingual notes (200
chunks, approximately 1.5 KiB per note) plus one synthetic SVG. Seed and warm the
index before idle measurement. Use the synthetic-only admin tick wrapper to
drive the production `tick` with one-second client pacing, separately from the
actual one-minute Cron. Every read/search/get remains authenticated.

Native binding counters cover only production operations inside each tick.
Synthetic telemetry receipt/reset writes, fixture PUTs and provider-side
inspection queries are outside that counter boundary. In particular, the
instrumented test wrapper itself writes one receipt after each tick; this is
not a production feature or a claim that the entire instrumented deployment
does no writing. No console history or new log sink is added to the product.

Elapsed time and detection latency are wall time, not CPU. Temporary real-time
tail events provide CPU for sampled instrumented invocations, including wrapper
overhead; do not infer CPU from production `elapsedMs` console fields.

## Completed HTTP-driven observations

- Fixture seed plus initial index creation through observed completion:
  191,684 ms, 52 production ticks. This setup phase is outside idle costs.
- Warmed idle: three ticks, each with zero D1 rows written. No new ingestion
  jobs or per-file staging are required.
- Append the synthetic marker to one note: observed publication in 5,822 ms,
  two driven ticks with 343 and 159 D1 rows written.
- Restore that note: observed publication in 5,680 ms, two driven ticks with
  343 and 144 D1 rows written.
- Final exact note content and lexical search pass. Durable detection is idle,
  monitoring is not persisted, and index freshness is unknown.
- With observability persistence disabled, real-time tail output includes
  `start`, `changed` and `resumed` with only counts, elapsed time and outcomes.

The first idle samples precede the final aggregate-freshness presentation fix;
the subsequent update/restore observations use the final production code.
That fix does not change the probe, signature or write path. Repeated final-code
idle and actual-Cron observations are recorded separately below.

## Actual scheduled update

Provision the one-minute trigger once, restore the unmarked note, then append
the marker and stop all manual tick/index/advance requests. Poll read-only
status until publication and verify exact body and lexical search afterward.
The new schedule was configured at 10:35:35 UTC; its first observed invocation
was at approximately 10:46 UTC. This is configuration propagation, not evidence
of normal steady-state one-minute latency.

Publication was observed 553,994 ms after the source write acknowledgement,
including the initial schedule propagation wait and ten-second status polling.
Two actual scheduled invocations performed the work, with 343 and 158 native D1
rows written. Their tail CPU values were 138 and 31 ms; tail wall times were
14,652 and 2,944 ms. Console results were `changed` and `resumed`. These are
instrumented invocation samples, not a CPU distribution or a capacity guarantee.

## Actual scheduled idle and maintenance

Observe three actual scheduled invocations after publication, without manual
tick/index/advance requests. All three write **zero** D1 rows, read 32 D1 rows
through eight statements, and perform two R2 LISTs. They perform no source
GET/HEAD/PUT/DELETE and no AI/vector operations. Production tick wall times are
2,548 / 2,087 / 3,726 ms. Two captured idle tail samples have CPU 17 / 21 ms and
whole-invocation wall time 3,436 / 2,787 ms; the third CPU sample was not captured.
Do not equate tail invocation timing with the narrower production tick timing.
The three-receipt observation window is 183,260 ms. Durable observation age
does not falsely turn status stale during these unchanged executions.

Separately insert one unreferenced synthetic embedding cache row with timestamp
zero, then drive three production ticks. The cache is collected with **one** D1
row written on the first tick; subsequent ticks write zero/zero. Collection is
age-equivalent, not a new 24-hour wait. Independent native queries confirm the
expired cache is absent and the active index still has 100 notes/200 chunks.
The broader reference-safe retention regressions also pass locally.

[Hosted raw counters and sanitized tail samples](../measurements/2026-11-01-idle-hosted.json)
separate setup, driven idle/update/restore, actual Cron update/idle, and
maintenance. All operation counts retain the wrapper exclusions stated above.

## Local comparison and regression checks

[Matched local counters](../measurements/2026-11-01-idle-local.json) compare
immutable baseline `db7aff0` with this change, three repeats per fixture. The
small notes have one chunk each and no attachment, so they differ from the
hosted fixture. D1 writes per idle tick change from 13/15/211/219 to zero for
0/1/99/101 notes respectively. All optimized ticks issue eight D1 statements,
read 20 rows and perform one/two R2 LISTs; none issue mutating SQL or source
GET/HEAD/PUT/DELETE. Local wall times are 17–23 ms; CPU/memory are unmeasured.

The Cloudflare suite passes 81 tests, including a durable workerd restart.
The existing local/core/server/CLI suite passes 662
tests. Cloudflare and workspace typecheck, lint, formatting and the production
Worker dry-run build pass. Coverage includes policy/model changes, active upload
admission during a probe, publication races, failures, duplicate execution,
stale-ID revocation, reference-safe retention and explicit multipage fallback.

Reproduce the local comparison from `packages/cloudflare` with:

```sh
node --import tsx scripts/benchmark-idle.ts db7aff0 <report.json>
```

The new hosted driver is `scripts/remote-idle-smoke.ts`; it only accepts a
private state file naming a disposable synthetic trial. Prepare isolated
resources and deploy `test/remote-update-worker.ts` with its explicit synthetic
flags, then run `prepare`, `idle`, `update`, `restore`, `cron-update`,
`cron-idle` and `maintenance` sequentially, using separate actual Cron setup.
The maintenance phase requires an explicitly aged, unreferenced synthetic cache
entry. Never use these unauthenticated/local or synthetic administration
wrappers with private data or an existing deployment.

## Limits and remaining follow-up

The 1,000 ms CPU override was rejected again with provider code `100328`
(Free plan). The base deployment succeeded while retaining existing secrets;
no plan change or billing activation was performed. Paid initial/update/rebuild/
retrieval/delete/idle validation remains unverified and conditional on a
separately authorized, available contract.

This is a short repeated trial, not a 24-hour measurement, latency distribution
or Free/Paid capacity guarantee. R2 LIST and D1 reads remain recurring costs.
The eight-page/time-budget durable fallback, pending semantic work, failed-job
recovery and eligible collection can still write and must not be extrapolated
from the warmed zero-write samples.

## Teardown

Disable the trial Cron and delete its temporary tail session. Purge all 205 R2
objects (309,091 bytes) and verify the owned bucket is empty. Delete the trial
Worker, including credentials/schedules, then its R2 bucket and D1 database.
Independent provider GET requests return HTTP 404 for all three resources.
Remove local temporary credentials and tail access URLs after exporting only
sanitized counters. No existing deployment or contract was modified. Live
resource deletion is distinct from provider backup/Time Travel retention.
