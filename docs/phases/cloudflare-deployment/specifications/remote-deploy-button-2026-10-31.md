# Deploy-button and original-size workload validation (2026-10-31)

Status: Deploy-button HTTP/MCP, autonomous mutation checks and the isolated
original-size 100-note cycle passed. This report supplements #35, PR #42 and the separate retention report
in PR #45. No product behavior was changed during this validation.

## Operator-created deployment

The operator used the public Deploy to Cloudflare button after manual account,
R2 activation and GitHub authentication/authorization steps. They entered a
new vault UUID and independent read/admin secrets, then configured repository
root `/`, build `npm ci --prefix packages/cloudflare` and deploy
`npm run deploy:cloudflare`. Treat these as explicit setup steps, not automatic
prepopulation or a one-click claim.

Provider inspection confirmed the expected D1/R2 bindings, three applied D1
migrations, a one-minute Cron, disabled managed public R2 access and no custom
R2 domains. Semantic consent was false and no AI/Vectorize binding was added.
No account subscription or CPU setting was changed.

The operator's CLI transcript confirmed a synthetic upload of two notes and
one attachment, 2 indexed notes / 4 chunks, read-token search and explicit get,
an update marker becoming searchable, and deletion followed by old-ID get
exiting with code 4 (HTTP 404). The CLI's missing error output is tracked in #46;
it was not changed as part of this test. The blank title display is not proof
that body retrieval failed; the returned synthetic source was verified.

## Authenticated client and direct R2 checks

The operator's actual secrets were neither requested nor extracted. A generated
temporary read-only credential used the initially absent previous-read slot.
HTTP checks verified health liveness, missing/invalid bearer rejection,
read-on-admin rejection, search/get, deleted-ID rejection and stale pinned
revision rejection. An actual MCP SDK client initialized the remote transport,
listed all 18 tools, searched and explicitly retrieved the known synthetic note.

Direct source changes used uniquely named synthetic probe objects. No upload,
index, advance or synthetic tick requests accelerated these phases. Completion
required a new published revision plus search/get assertions; failures of
intermediate jobs were also observed.

| Phase                    | First updating observed | Publication observed | Failed jobs observed |
| ------------------------ | ----------------------: | -------------------: | -------------------: |
| Create note and image    |               60,312 ms |           193,010 ms |                    0 |
| Overwrite note and image |               59,015 ms |           191,925 ms |                    0 |
| Rename note              |               59,275 ms |           191,882 ms |                    0 |
| Delete note and image    |               51,635 ms |           123,145 ms |                    0 |

Times include operator/API mutation overhead and polling, not exact server
event times or a latency distribution. These are one sample per mutation in
this flow; the earlier Wrangler-flow samples remain separately recorded.
Renaming and deletion revoked the old IDs. The overwritten image bytes were
explicitly retrieved and verified. After deletion, the probe image could no
longer be retrieved and the original synthetic survivor remained searchable.

Excluded and out-of-scope probe objects were never represented by forbidden
source/note rows or retrievable IDs. Lexical search can return an authorized
fuzzy candidate for an unmatched marker, so scope validation checks identity,
content and authoritative rows rather than requiring an empty candidate list.
An initial zero-result assertion was too strict and was corrected in the
private test harness; product ranking logic was unchanged.

The temporary credential was removed; a subsequent request returned HTTP 403.
Provider settings confirmed the original binding set and Cron were restored.
The operator-created deployment and its original keys/data were preserved.
Mutable test probes were deleted; obsolete immutable snapshots remain subject
to normal retention. Local temporary credentials/configuration/logs were removed.

## Isolated original-size capacity cycle

Use separate disposable resources, the existing instrumented synthetic-only
entrypoint, 100 deterministic approximately 1.5 KiB bilingual notes (200 chunks)
and one SVG. No real vault data or AI bindings. Cron is disabled in this
measurement environment to avoid mixing autonomous observations with the
HTTP-driven workload; the grouped synthetic HTTP tick is labeled separately
from the production-Cron timings above. An interrupted grouped phase may resume
with the existing single-checkpoint driver, explicitly marking telemetry gaps.

Measure initial indexing, a one-note update, full rebuild and one-note deletion
independently. Native D1 row counters and R2 operation counts are not an
account-wide billing ledger. Provider CPU/memory analytics have returned a
rate-budget error; unavailable fields stay null and are not inferred from wall
time. No guaranteed Free or Paid capacity follows from successful completion.

The initial source set contained 152,100 bytes of Markdown plus a 113-byte SVG.
The updated note grew from 1,521 to 1,555 bytes. Source admission (101 initial
puts, one overwrite and one delete) was outside the instrumented phase windows
and is listed separately in the measurement report.

| Phase                      | Final notes / chunks |  Wall time | D1 rows read / written |  R2 get / head / list / put |
| -------------------------- | -------------------: | ---------: | ---------------------: | --------------------------: |
| Initial                    |            100 / 200 | 392,693 ms |        33,176 / 24,175 |         102 / 101 / 2 / 101 |
| One-note update            |            100 / 200 | 370,574 ms |        33,814 / 24,203 |         102 / 101 / 2 / 101 |
| Full rebuild               |            100 / 200 | 385,419 ms |        33,766 / 24,203 |         103 / 101 / 2 / 101 |
| One-note deletion, resumed |             99 / 198 | 568,311 ms |    >=31,519 / >=23,934 | >=100 / >=100 / >=1 / >=100 |

The first three phases completed with the grouped HTTP driver and no recorded
telemetry gaps. The deletion phase's grouped request returned HTTP 503 after
the last observed checkpoint 312. A read-only native query still succeeded;
the cause of 503 was not established. The same job resumed with the existing
single-checkpoint driver and completed at checkpoint 505 without recreating
the job. Its counters are lower bounds and its wall time includes recovery.
Do not treat the expected final HTTP 404 retrieval checks as the original 503.

The exact updated body was retrieved before deletion. After deletion, note and
chunk gets returned 404; native active-snapshot counts were 99 notes, 198 chunks
and 100 sources, with no deleted note/source row. Final storage retained four
generations: 503 R2 objects / 758,091 bytes and a 15,708,160-byte D1 file that
also included synthetic telemetry. Instrumentation receipt/reset writes are
outside the reported operation counters. These are observations, not a billing
invoice or proof that continuous 100-note reconciliation fits Free allowances.

All 503 objects, the isolated Worker/secrets, D1 and R2 bucket were removed;
independent provider reads confirmed 404 for all three resources. Private
operator credentials/configuration/logs were removed. The operator-created
Deploy-button environment was intentionally preserved, with no test key left.

Content-free evidence: [Deploy-button results](../measurements/2026-10-31-deploy-button.json)
and [capacity results](../measurements/2026-10-31-capacity.json). Optional semantic
billed usage and Paid CPU execution are not certified by this lexical-only
trial; Paid execution remains deferred to #43. Older native CPU/V8-memory
quantiles remain separately dated evidence, not substitutes for unavailable
CPU/peak-memory values in this new cycle.
