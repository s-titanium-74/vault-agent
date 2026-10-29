# Cost and runtime limits (#35)

Date: 2026-10-29. Currency: USD before tax. Status: **partial evidence**.
The [hosted Wrangler follow-up](remote-self-deployment-2026-10-29.md) validates
isolated resource provisioning, clients, autonomous changes, rotation and teardown
and adds native CPU/V8-memory and selected 1/100-note counters. Neither
clean-account deployment nor Paid capacity is certified. Ordinary
installation continues to require no Cloudflare account or services.

## Reproducible local operation measurements

Run from `packages/cloudflare`, after both dependency installations:

```sh
node --import tsx scripts/benchmark-local.ts REPORT_JSON
```

The runner generates public-safe English/Japanese notes (about 1.5 KiB each),
two chunks per original note, a small SVG and an excluded synthetic file.
It executes the production handlers in workerd, wraps native D1/R2 bindings
with content-free counters, and cleans its temporary source/runtime state.
Sources are inserted directly into local R2: these numbers do **not** measure
CLI upload staging. Rate limiting is raised only inside this local experiment.
No AI is configured and all AI/vector counters are zero by construction.

[Raw content-free report](../measurements/2026-10-29-local.json).
The retained D1 state includes four snapshots (before 24-hour cleanup), FTS and
trigram rows. Counters exclude migration/fixture loading, instrumentation writes,
report queries and source edits performed outside the Worker. They include job
administration, validation, per-snapshot publication and native SQL index work.
The instrumentation itself adds wall overhead and one D1 row per invocation;
it must not be deployed with a private vault.

| Corpus / phase                            | HTTP invocations | D1 statements | Rows read | Rows written | R2 get / head / list / put |
| ----------------------------------------- | ---------------: | ------------: | --------: | -----------: | -------------------------- |
| 1 note: initial                           |               16 |           133 |       251 |          292 | 2 / 2 / 1 / 2              |
| 1 note: one-file update                   |               15 |           127 |       186 |          156 | 2 / 2 / 1 / 2              |
| 1 note: rebuild                           |               15 |           127 |       181 |          156 | 2 / 2 / 1 / 2              |
| 1 note: deletion + two stale-ID checks    |               13 |            94 |       108 |           57 | 1 / 1 / 1 / 1              |
| 1 note: 20 searches                       |               20 |           240 |       730 |            0 | 0 / 0 / 0 / 0              |
| 1 note: 20 explicit gets                  |               20 |           140 |       240 |            0 | 20 / 0 / 0 / 0             |
| 100 notes: initial                        |              512 |         4,693 |    30,760 |       24,175 | 101 / 101 / 2 / 101        |
| 100 notes: one-file update                |              511 |         4,786 |    31,289 |       24,037 | 101 / 101 / 2 / 101        |
| 100 notes: rebuild                        |              511 |         4,786 |    30,994 |       24,037 | 101 / 101 / 2 / 101        |
| 100 notes: deletion + two stale-ID checks |              509 |         4,753 |    30,812 |       23,938 | 100 / 100 / 2 / 100        |
| 100 notes: 20 searches                    |               20 |           380 |    37,500 |            0 | 0 / 0 / 0 / 0              |
| 100 notes: 20 explicit gets               |               20 |           140 |       240 |            0 | 20 / 0 / 0 / 0             |

All successful phases asserted published results; deletion asserted both note
and chunk retrieval returned 404. Search alternated English and Japanese.
The 100-note initial/update/rebuild/deletion phases took 10.6–11.4 seconds
**locally**, with unpaced administration requests. Hosted clients enforce
one-second checkpoint pacing and the default limiter allows 120 requests per
minute per location. Those local times are not hosted latency estimates.

A single file edit still copies/rebuilds the snapshot's lexical rows and
immutable source objects, even though parsing/embedding reuse is incremental.
The initial 100-note run wrote about 242 native rows per note; the update wrote
24,037 rows for one changed note. After four snapshots, 399 note rows, 796 chunk
rows and 40,598 gram rows remained, plus FTS internal tables. R2 retained 504
objects totaling 755,190 bytes from an initial 152,278-byte source set. This
small corpus illustrates retained-generation and lexical write amplification;
it does not establish a universal factor for arbitrary languages/note sizes.

The 1,000-note admission experiment failed with `INDEX_BUDGET_EXCEEDED` before
publishing any snapshot. It used 13 invocations, 2,054 D1 row writes and 11 R2
lists. Admission rejection itself consumes resources. Current admission caps
are **500 total entries including attachments**, 2,000 chunks and 16 MiB indexed
JSON, with additional per-note/per-chunk limits. A 2 MiB upload limit on Markdown
does not imply that a maximally large note fits derived-row/chunk budgets.
Full-size/long-note remote testing remains outstanding.

## Idle reconciliation is a recurring cost

After the deletion phases, a simulated scheduled invocation on unchanged source
used 15 D1 writes / one R2 list for the small corpus and 217 writes / two lists
for the medium corpus. These are single local samples; cleanup after 24 hours,
retry, stale leases and partially completed scans can change the cost.
After deleting the changed note, those idle samples contain zero and 99 notes
respectively, plus the attachment. They are lower-load samples than the original
1/100-note sets. The minute schedule admits 43,200 invocations in a 30-day month, including when
there are no user searches. The medium idle sample alone extrapolates to
312,480 D1 writes/day, above the current Free daily allowance. Do not describe
100 notes plus continuous reconciliation as a supported Free configuration.
Reconciliation, immutable snapshot copying and retention must be included in
any future optimization; AI input reuse alone does not remove these costs.

## Dated pricing assumptions

Rechecked official documentation 2026-10-29. Allowances are account-wide and may
already be used by other Workers; daily allowances do not become monthly pools.
Rates and product availability must be rechecked before deployment.

| Service                                                                      | Included allowance / assumption                                                                                                  | Additional usage                                                                                           |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [Workers](https://developers.cloudflare.com/workers/platform/pricing/)       | Paid subscription $5/month; 10M invocations and 30M CPU ms/month. Free: 100k invocations/day, 10 ms HTTP CPU/invocation          | Paid: $0.30/M invocations and $0.02/M CPU ms                                                               |
| [D1](https://developers.cloudflare.com/d1/platform/pricing/)                 | Paid: 25B reads, 50M writes/month, 5 GB storage. Free: 5M reads and 100k writes/day, 5 GB total (per-database limits also apply) | Paid: $0.001/M reads, $1/M writes, $0.75/GB-month above allowance                                          |
| [R2 Standard](https://developers.cloudflare.com/r2/pricing/)                 | 10 GB-month, 1M Class A, 10M Class B/month                                                                                       | $0.015/GB-month, $4.50/M Class A, $0.36/M Class B, with billable-unit rounding                             |
| [Vectorize](https://developers.cloudflare.com/vectorize/platform/pricing/)   | Paid: 50M queried and 10M stored dimensions; Free experimentation: 30M queried and 5M stored dimensions                          | Paid: $0.01/M queried and $0.05/100M stored dimensions above allowance                                     |
| [Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/) | Model-specific neuron/token accounting; document and query processing require separate consent                                   | Obtain current bge-m3 usage and model price from account billing; input counts/bytes are not billed tokens |

Vectorize's product pricing lists a Free allowance, while the Workers overview
still describes Paid availability. Check your actual account's provisioning
capability; do not promise semantic Free deployment from either table alone.
No Queues, Workflows, Durable Objects, external notification delivery or event
consumer costs apply to the selected Cron reconciliation design. Builds minutes
and provider backups/exports are additional operator/account considerations.

## Illustrative monthly projections, not invoices

Assume a dedicated otherwise-unused account, 30 days, one initial index,
30 one-file updates, one rebuild, one deletion, 3,000 lexical searches and
3,000 explicit gets. Extrapolate each phase from the local counters above and
43,200 idle invocations from the single idle sample. Native row counters include
FTS/gram work. These estimates exclude upload staging, post-retention cleanup,
retries, denied traffic, storage metadata overhead, Builds, AI and optional
semantic queries. They are **not an upper bound**.

| Synthetic scenario          | D1 monthly reads / writes | R2 Class A / B operations (Worker only) | Interpretation                                                                                         |
| --------------------------- | ------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Small: 1 note initially     | 1,793,220 / 653,185       | 43,298 / 3,130                          | Included usage may cover measured lexical operations; Free CPU and cleanup not established             |
| Medium: 100 notes initially | 17,189,836 / 10,167,660   | 89,798 / 9,664                          | Measured Paid operations fit stated allowances; Free idle D1 writes already exceed the daily allowance |

The Paid **base-only lower estimate** is $5/month when those measured operations
and actual storage/CPU fit unused included allowances; additional unknown usage
must be added. The corresponding Free estimate is not a supported deployment
promise. D1 paid overage is
`max(0, reads-25B)/1M*0.001 + max(0,writes-50M)/1M*1.00`, plus storage.
Apply R2's own rounding to billable units after the included allocation; list
and put are Class A, get/head are Class B, and delete is not billed. External
source edits and CLI staging must be added to Worker counters.

For semantic scenarios, use the actual retained vector count times 1024 for
stored dimensions. Queried dimensions include queries plus the insertion work
specified by Vectorize pricing. Visibility queries, retries, initial indexing,
full rebuilds and retained old generations contribute. Existing [hosted semantic
smoke](remote-ingestion-smoke-2026-10-29.md) observed seven vector upserts and four
AI inputs across initial/rebuild/update/deletion/query, including zero ingestion
AI inputs for identical rebuild/deletion; it did not measure provider-billed
neurons/tokens or CPU. Do not turn four inputs into a dollar estimate.

## Hosted follow-up and remaining release gates

The [new hosted run](remote-self-deployment-2026-10-29.md) passed Wrangler resource
creation/migrations/deployment, actual CLI and native MCP clients, real Cron
create/overwrite/rename/delete plus attachment changes, rotation and full
provider-verified teardown. It measured one-note mutation/rebuild/deletion,
100-note initial indexing/search/get, and an exact 2 MiB multilingual failure
that preserved the published revision. Native CPU/V8-memory quantiles are now
recorded separately from the local report's deliberately null fields. The
observed 100-note search CPU P99 was 64.793 ms; successful completion does not
prove Free-plan capacity. No account plan was changed.

Keep the following #35 gates open:

- Actual clean-account and Deploy-button provisioning, including resource
  configuration, migrations, secrets, native clients and Cron.
- Hosted 100-note update/rebuild/deletion phases, repeat latency/retry and
  reconciliation samples, full 24-hour cleanup and optional AI/Vectorize billed
  usage. The earlier local phases and #34 semantic smoke remain separate evidence.
- Paid 1,000 ms CPU configuration and plan-specific limits, plus worst-case
  capacity/maximum heap validation. Invocation memory quantiles are not heap peaks.

No blanket Free or Paid cost/capacity guarantee follows from this partial
measurement set. Keep issue #35 open until the outstanding results are recorded.
