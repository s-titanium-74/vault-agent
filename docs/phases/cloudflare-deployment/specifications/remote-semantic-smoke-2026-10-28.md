# Deployed semantic smoke validation (#33)

Date: 2026-10-28. Result: the ten functional smoke groups passed, with the
ranking limitation below. Production implementation: `b97b7ca7949d73b502b3efea77be2222c28771da`.
The separate synthetic administration entrypoint compiled that implementation
with `test/remote-semantic-worker.ts`; normal requests used the actual Worker,
portable core, Workers AI BGE-M3, Vectorize V2, D1 and R2. No provider doubles
or private vault data were used.

## Isolation and setup

Created a dedicated disposable Worker, D1 database, private R2 bucket and
1024-dimension cosine Vectorize index. Created the `chunkId` string metadata
index before writing vectors. Applied both D1 migrations. Seeded eight synthetic
notes, seven chunks and ten source objects. Disabled D1 replication, Worker
observability, Logpush, tail consumers and preview URLs. Verified R2 managed
public access was disabled and no custom public domains existed.

Used separate random read/admin secrets and explicit external embedding consent.
The test wrapper's administration routes required HTTPS, the admin token, the
synthetic vault identity and a separate smoke enablement flag. The wrapper is
not the product entrypoint and must never be deployed against an existing vault.

The account used Workers Free. Upload with a custom CPU limit was rejected;
removed that setting without changing the account plan. This small smoke does
not validate the documented paid-plan indexing CPU budget. Synthetic bootstrap
took about 37 seconds because it performed many individual administration
writes; it is not the #34 ingestion protocol or an example of a bounded index job.

## Multilingual quality and latency

Queried gardening, networking and astronomy in English, Japanese and Spanish
against the small synthetic corpus. The requested result limit was three.

| Mode      | Expected topic ranked first | Expected topic in top three | Observed search latency                   |
| --------- | --------------------------- | --------------------------- | ----------------------------------------- |
| Embedding | 9/9                         | 9/9                         | 1.684–2.026 seconds; median 1.843 seconds |
| Hybrid    | 8/9                         | 9/9                         | 1.851–2.562 seconds; median 2.023 seconds |

These are warm, sequential client wall-clock measurements, not CPU timings,
percentile SLOs, load tests or a representative multilingual benchmark.

The Spanish networking hybrid query ranked the unrelated empty-orchard note
first and the correct networking chunk second, with equal normalized scores.
The initial all-top-one quality assertion exposed this result. The final report
records both top-one and top-three outcomes instead of claiming perfect hybrid
ranking. The shared lexical candidate selection/RRF behavior was preserved;
this is a known ranking limitation, not evidence of a provider failure. More
representative relevance evaluation and any shared ranking change need separate
fixtures and local/cloud regression validation.

## Functional results

All ten groups passed:

1. Authenticated readiness, invalid-token rejection and read-token rejection on
   synthetic admin routes.
2. Nine actual embedding-mode multilingual searches.
3. Nine actual hybrid-mode multilingual searches, with rankings recorded above.
4. Path include/exclude, tags, excluded tags and type/status filters; explicit
   lexical mode made zero provider calls. Empty filter membership sent no query
   text to AI.
5. Explicit note/chunk retrieval and rejection of a changed snapshot pin.
6. Pending/incompatible generations returned embedding-only 503 and warned
   lexical fallback for hybrid, with no embedding call.
7. The real Vectorize binding rejected a 768-dimensional query against the
   1024-dimensional index.
8. A real SDK Streamable HTTP MCP client initialized, listed all 18 tools, ran
   Japanese semantic search and hybrid related retrieval with usage counters.
9. Real asynchronous vector mutation, visibility probes and staging isolation.
10. Removing active D1 note/chunk/source membership revoked a retained vector:
    semantic search omitted it and note get returned 404 while vectors remained
    physically present in the index.

Success and error responses used `Cache-Control: no-store`. Deletion here is
an operator-only synthetic revocation test; production atomic deletion and
publication remain #34 work. Provider errors, retries, nonfinite vectors and
dimension/model mismatch also retain their deterministic local coverage.

## Asynchronous visibility

Upserted seven additional vectors into a new staging snapshot namespace while
the original snapshot continued serving. The adapter returned a pending
mutation receipt. Immediate query probes found zero candidates at about 1.5
seconds; a later probe still found none at about 55 seconds. All seven exact
generation/hash references were query-visible at the next successful observation
at about 119 seconds. This bounds the observed transition; it is not an exact
119-second service delay or a promised maximum.

An initial short polling window expired; resuming the persisted probe succeeded.
No receipt, timeout or index vector count was treated as proof of readiness.
The active snapshot and ordered search IDs remained unchanged, and repeat query
scores agreed within 0.0001. The staging generation was never published.
This validates the need for #34's resumable `waiting_vectors` checkpoints rather
than waiting for whole-vault readiness inside an HTTP request.

## Usage and cost evidence

Initial indexing embedded seven inputs totaling 736 UTF-8 bytes in one model
call, then wrote seven vectors. Its mutation receipt remained pending. The
recorded HTTP/admin suite, including its resumed visibility checks, reported
24 embedding inputs, 1118 input bytes, 38 vector queries and seven additional
vector writes, with zero adapter retries. These counts exclude exploratory
calls, bootstrap, MCP SDK calls and the direct billing probe, and are not an
account-wide billing total. Fourteen vectors occupied 14,336 stored dimensions
before teardown. The retained-vector test did not depend on physical deletion.

A direct three-input multilingual billing probe returned provider metadata
`input_tokens: 45` and `neurons: 0.048356454093705634`. At the reviewed
[BGE-M3 list price](https://developers.cloudflare.com/workers-ai/models/bge-m3/)
of $0.0118 per million input tokens, those 45 tokens correspond to approximately
$0.000000531 before included allowances and other billing adjustments. This is
the probe's calculated list cost, not the entire run's cost or an invoiced charge.
UTF-8 bytes in application counters must not be presented as billable tokens.

[Vectorize billing](https://developers.cloudflare.com/vectorize/platform/pricing/)
uses queried/stored dimensions; its estimate includes stored vectors as well
as query count. Do not substitute returned candidate count for billed query
dimensions. The published Free allocations are 30 million queried dimensions
per month and five million stored dimensions. This isolated sample is small,
but other account usage and included allowances were not audited. No account
upgrade was made. Actual aggregate charges, larger-vault capacity, sustained
limits and budget controls remain #35 validation.

## Cleanup and remaining gates

Deleted all ten synthetic R2 objects, disabled the temporary route, deleted the
Worker and its secrets, and deleted the Vectorize index, D1 database and R2
bucket. Every deletion succeeded. Subsequent listings confirmed all four named
resources were absent. Provider-managed backup retention still applies.

No endpoint, account/resource identifier, credential, private path or raw runtime
log is included here. The reusable runner reads an operator-owned private state
file and writes a sanitized local report. Production onboarding still requires
#34 publication/ingestion validation and #35 deployment/capacity/cost gates.
