# Cloudflare Validation And Rollout

Status: Ready for Review

## Evidence And Bounded Compatibility Tasks

Documentation checked 2026-10-27. The composition is feasible at the service
level; no deployed application test, cost measurement, or compatibility claim
is made by #30. All spikes use synthetic public-safe data. Each failure below
blocks its issue and requires a documented revision, not silent degradation.

| Decision / official evidence                                                                                                                                                                                                                                                                                                        | Required validation and owner                                                                                                                                                                                                                          | Failure action                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2 selected for immutable source; [strong consistency](https://developers.cloudflare.com/r2/reference/consistency/)                                                                                                                                                                                                                 | #32: test digest-checked reads, nested paths, exclusion checks, streaming, missing objects; #34: concurrent replacement/deletion                                                                                                                       | Block onboarding until revision reads are safe; no public bucket fallback                                                                             |
| D1 selected for metadata, FTS5/BM25 and gram tables; [supported SQLite extensions](https://developers.cloudflare.com/d1/sql-api/sql-statements/)                                                                                                                                                                                    | #32: run actual schema migrations and FTS MATCH/bm25, Unicode/bigram/trigram, RRF ties, filtered and empty-note fixtures against local reference; verify staged queries do not rank unpublished rows                                                   | Revise D1 schema/query design; no assumed binary SQLite/native-extension compatibility                                                                |
| D1 bounds differ from local SQLite; [limits](https://developers.cloudflare.com/d1/platform/limits/)                                                                                                                                                                                                                                 | #32/#34: verify 100-bound-parameter ceiling, bounded rows below 2 MB, transaction rollback, compare-and-publish fencing, FTS/gram write amplification; choose per-snapshot FTS isolation if shared FTS corpus changes rank                             | Block publication or scope before silently changing ranking/filter semantics                                                                          |
| D1 [batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/) and [primary-first sessions](https://developers.cloudflare.com/d1/best-practices/read-replication/)                                                                                                                                                    | #34: concurrent writer, crash-before/after pointer switch, stale read and deleted-ID tests                                                                                                                                                             | Keep replication disabled; do not ship if acknowledged deletion can be bypassed                                                                       |
| Vectorize selected for optional semantic storage; [API asynchronous mutations and topK](https://developers.cloudflare.com/vectorize/reference/client-api/), [limits](https://developers.cloudflare.com/vectorize/platform/limits/), [filter constraints](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/) | #33: validate model dimension/metric, 64-byte IDs, snapshot namespaces, mutation visibility barrier, stale matches, post-filter starvation and truncation warning; compare semantic quality on synthetic multilingual fixtures                         | Keep semantic disabled until safe; lexical delivery remains independent                                                                               |
| Workers AI selected, model remains a bounded #33 decision; [multilingual bge-m3 candidate](https://developers.cloudflare.com/workers-ai/models/bge-m3/)                                                                                                                                                                             | #33: record exact model ID/revision, dimensions, limits, preprocessing, price and availability; measure Japanese/English quality and document/query consistency. Verify runtime responses instead of assuming model-card input examples are compatible | Select another explicitly configured Workers AI embedding model with recorded evidence, or block semantic release; no silent external provider switch |
| Separate runtime imports required                                                                                                                                                                                                                                                                                                   | #31: bundle portable entrypoint for Workers without Node/native/config/Git/watch imports; run all existing local regression checks; verify local install dependency closure excludes Cloudflare tooling                                                | Block extraction completion if local behavior changes or cloud imports leak                                                                           |
| Stateless Workers MCP selected; [2025-03-26 transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)                                                                                                                                                                                                   | #32: selected SDK Web transport bundle, initialize/tools list/call, notification and batch handling, bearer/Origin checks, base64 attachment bounds, cross-isolate client requests                                                                     | Block #32; revise transport docs before adding sessions, OAuth, or new infrastructure                                                                 |
| CLI-driven bounded indexing selected; [Workers CPU and memory limits](https://developers.cloudflare.com/workers/platform/limits/)                                                                                                                                                                                                   | #34/#35: deployed CPU profiling for 1, 100 and 1,000 synthetic notes, long multilingual/maximum-size notes, attachments, retry and disconnect/resume. Measure worst single-file step as well as total index                                            | Reduce batch/admission budgets or require measured paid capacity; never index a vault in one HTTP request                                             |

The official Worker limits currently list 10 ms HTTP CPU on Free, and Paid
defaults to 30 seconds with configurable higher limits. This design initially
targets Paid for indexing; Free compatibility is unproven. D1 parameter/row
limits and Vectorize's candidate cap require bounded adapters. Service limits
must be rechecked when implementation starts. No fixed free-tier or cost
promise follows from these architectural choices.

## Delivery Gates

1. **#30 specification:** review these documents, confirmed product choices,
   capability inventory, and testable contracts. No production deployment or
   provider credentials required.
2. **#31 portable contracts:** existing build/typecheck/lint/tests and dist
   tests pass; synthetic contract tests cover identities, scope, expected
   revision, and adapter failures. No local network transmission regression.
3. **#32 lexical/HTTP/MCP:** actual Workers/R2/D1 synthetic smoke tests and all
   promised read APIs, auth-before-body checks, safe errors, path traversal,
   excluded/missing/large content, read/admin separation, and denied Origins.
4. **#33 semantic:** multilingual quality, model descriptor, finite/vector
   validation, metric thresholds, consent-disabled zero calls, provider rate
   limits, fallback, model migration, stale vector/deletion, and filter tests.
5. **#34 ingestion:** dry run zero transmission; exact scoped selection;
   synthetic create/change/rename/delete, interrupted upload, duplicate advance,
   lost publication response, lease fencing, mismatched digest, changed excludes,
   and stale search/get races. Never expose staging as fresh.
6. **#35 release:** clean-account self-deploy walkthrough with native `/mcp`
   and CLI, migrations/secrets/rotation, scoped sample upload and search/get,
   update/delete, upgrade and full teardown. Test deploy-button provisioning
   separately from Wrangler; require a documented working Wrangler path.

Measure Worker CPU/memory/errors, D1 reads/writes and storage including FTS/
gram amplification, R2 operations/storage, Workers AI input usage, Vectorize
stored/queried dimensions, staging duplication, cleanup, and reindex overhead.
Report dated small/medium synthetic workloads, account-plan assumptions,
rate/batch budgets, and estimated paid/free scenarios from measurements.
Include future queue/workflow costs only if those services are adopted through
a reviewed specification change. CI credentials are scoped and never exposed
to untrusted fork code; deployed smoke tests require explicit trusted setup.

Do not close a gate merely because local emulation passed. Record which checks
ran locally and which ran in a deployed account. Until auth, scope enforcement,
consistent publication/deletion, and teardown pass, onboarding accepts synthetic
sample vaults only. No private vault content is used in fixtures or reports.
