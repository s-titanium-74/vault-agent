# Opt-in semantic retrieval (#33)

The cloud adapter uses shared portable search, filters, compact results and RRF
fusion. It never generates answers. Local installation and providers are unchanged.

Accepted follow-up #48: [incremental publication](incremental-publication.md)
defines optional vector catch-up, versioned input-based IDs, pending-state
warnings/status and authoritative D1 membership checks. It preserves strict
`requireEmbeddings` publication and local vector atomicity. The
snapshot-wide readiness and fallback rules below document the original baseline
and the retained full-build path; incremental semantics follow the linked spec.

## Model and consent

Select `@cf/baai/bge-m3`, dense 1024 dimensions, cosine, unit normalization,
generation input format `vault-agent-bge-m3-v1`. It supports multilingual text
without asymmetric query instructions. Documents use the shared
`generateEmbeddingInputText`; queries use bounded query text. Both pass through
the same provider, with no task prefixes or silent provider truncation.
The deployment must explicitly set `EXTERNAL_EMBEDDING_CONSENT=true` and
`EMBEDDING_MODEL=@cf/baai/bge-m3`, and bind AI and a cosine Vectorize V2 index.
Bindings alone do not grant consent. The checked-in sample keeps consent false.

Reviewed 2026-10-28: [model availability and pricing](https://developers.cloudflare.com/workers-ai/models/bge-m3/)
lists $0.0118 per million input tokens. The provider page advertises 60,000
tokens, while the [upstream model card](https://huggingface.co/BAAI/bge-m3)
documents 8192 tokens and 1024 dimensions. Use the conservative 8192-token
descriptor and a separate 8000 UTF-8-byte admission cap (at most 32000 bytes
per batch), rather than relying on the larger hosted context claim. Oversize
input fails explicitly; indexing must not silently truncate documents.
At most 16 inputs per call. These are application budgets; the hosted API
does not document a model-specific synchronous batch count guarantee.

## Revision and vector boundary

Migration 0002 stores one immutable generation descriptor and readiness state
per snapshot. The generation ID is SHA-256 of the complete descriptor; the
namespace hashes vault, snapshot and generation. Vector IDs hash namespace and
chunk ID. Metadata contains only chunk ID, chunk hash and generation. Never
store note bodies, paths, tags or frontmatter in Vectorize.

Only a generation marked ready by the publisher, matching the manifest's
model/dimension and the configured descriptor, can serve semantic reads.
The #34 publisher must validate all bounded write receipts and query visibility
before marking ready and atomically publishing the snapshot. Upsert receipts
stay pending; an acknowledgement alone never proves readiness. Adapters expose
bounded writes/deletes and visibility probes for that publisher. No ingestion
HTTP endpoints are introduced here.

Every query pins the snapshot namespace, resolves each hit in D1, verifies its
derived vector ID, generation, chunk hash and source-manifest digest, and applies
current exclusions and shared structured filters. A deleted, stale, foreign or
staged hit is discarded. Source/index mismatch fails closed. The existing final
active-pointer check rejects concurrent publication. D1 authorization is
authoritative even while Vectorize cleanup remains pending.

Vectorize cosine similarity is converted to cosine distance `1 - similarity`,
then to a bounded score `(similarity + 1) / 2`. No sqlite-vec cutoff is reused.
Query at most 100 IDs without metadata, then fetch and verify bounded metadata
by ID. This allows the shared maximum of 50 results; postfiltering can return
fewer results and makes no exhaustive recall promise.

## Failure, cost and migration

Explicit lexical mode makes no AI or Vectorize calls. Missing, pending or
incompatible generations yield warning-bearing lexical fallback for hybrid or
omitted mode; embedding-only requests return 503 `EMBEDDING_UNAVAILABLE`.
AI/Vectorize failures use the same behavior. Retry only known 429/5xx failures,
at most three attempts, within a 10-second operation deadline; honor bounded
Retry-After, fail immediately if it exceeds the remaining budget. Unknown
failures, invalid dimensions, nonfinite/zero vectors and invalid outputs are
sanitized and not retried. The request retains its existing 30-second deadline.

Request/job-scoped counters expose attempts, retries, input count/UTF-8 bytes,
vector queries/candidate count/writes/deletes; no text, paths or provider errors.
When semantic processing is configured, successful HTTP search/related envelopes
and MCP search/related payloads include a `usage` object with these counters.
Lexical requests report zero provider work. Counters are per operation, not
deployment totals; attempt counts include configuration checks and retries.
Bytes are not billable tokens. Use provider billing for actual token charges.
No process-global counters, content logging or AI Gateway payload logging/cache.

Changing model, operator model revision, metric, normalization or input format
requires a full new snapshot/generation; dimension/metric changes also require
a new index. Retrieval never mutates readiness. Status reports configured
versus ready; unknown or incompatible generations never appear ready.

Synthetic Japanese, English and Spanish tests verify adapter contracts,
filters, fusion, isolation, failure and budgets using deterministic bindings.
They do not measure hosted multilingual relevance, availability, latency or
cost. The separate [deployed synthetic validation](remote-semantic-smoke-2026-10-28.md)
records actual provider behavior, ranking limitations and scoped cost evidence.
Production onboarding still requires #34 publication and #35 deployment work.

## Implementation validation (2026-10-28)

- Cloud package: 30 tests pass, including real workerd HTTP/MCP with synthetic
  AI/Vectorize bindings and real local D1/R2. Hosted inference is not exercised.
- Local regression suite: 648 tests pass; built-artifact suite: 8 tests pass.
  Git, loopback and child-process cases require the normal execution environment.
- Root/cloud typechecks, lint, formatting, root build and both base/semantic
  Wrangler deployment dry-runs pass.
- The subsequent deployed synthetic run passed ten functional groups using real
  providers. Semantic topic top-one was 9/9; hybrid top-one was 8/9 and top-three
  9/9. Real vector visibility was observed after pending receipts, and all
  disposable resources were removed. See the linked report for latency, usage,
  billing-probe evidence and limitations. Aggregate invoiced costs and capacity
  remain #35 work.
