# Deployed Synthetic Smoke Validation (#32)

Date: 2026-10-28. Result: passed.

Tested implementation commit: `945576fd63ff7e844c04e4c9ee8d7794a7829a77`.
The compiled Worker bundle from that commit was uploaded to an isolated
Cloudflare deployment. A private R2 bucket and a new D1 database were created
for this run. Read replication was disabled. No existing application resources
were modified and no private vault data or AI providers were used.

## Setup

- Applied the actual D1 migration: all seven statements succeeded.
- Generated the repository's synthetic fixture, assigned a new portable vault
  UUID, and applied its 130 seed statements successfully.
- Uploaded six synthetic source objects to private R2.
- Configured independent random read/admin Worker secrets, exact Origin rules,
  the source scope, profile allowlist and a 120-request/minute rate limiter.
- Deployed the compiled module with its D1/R2 bindings before enabling its
  temporary authenticated Workers route. Preview URLs were disabled.
- Confirmed that R2 managed public access was disabled and no custom public
  bucket domains existed. Worker Logpush was disabled, no tail consumers were
  attached, and observability was disabled.

## Remote results

All 13 primary smoke groups passed against the deployed Worker:

| Group                        | Verified behavior                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Health                       | Public liveness only; no vault identity or counts                                                                |
| Authentication               | Missing/invalid credentials rejected across read, MCP and admin surfaces                                         |
| Admin boundary               | Read credentials rejected; admin credentials receive explicit unsupported-operation errors                       |
| Lexical search               | Compact deterministic results without note bodies                                                                |
| Structured filters           | Path includes/excludes, tags and type/status apply before result limits                                          |
| Unicode and empty notes      | Japanese gram retrieval and empty-note metadata fallback                                                         |
| Explicit retrieval           | Note/chunk gets and rejection of a changed snapshot pin                                                          |
| Compact read surfaces        | Orientation, graph, profiles, guidance listing and related candidates                                            |
| Guidance and attachments     | Explicit guidance text, attachment metadata and authenticated byte download                                      |
| Origin, exclusion and limits | Unlisted Origins, excluded paths, traversal and oversized request rejection; explicit semantic-unavailable error |
| Status                       | Cloud freshness, active revision and explicit disabled capabilities                                              |
| Remote MCP SDK client        | Initialize, list and invoke all 18 read-only tools, including base64 attachment download                         |
| Stateless MCP protocol       | Sequential batch handling, notification 202 responses and GET/DELETE 405 responses                               |

Additional deployed checks passed:

- Compared result IDs, ordering and exact scores with actual local SQLite for
  seven query cases, including English, Japanese, empty notes and FTS syntax
  punctuation. Every comparison matched.
- Staged a separate D1 snapshot/FTS corpus without publishing it. The complete
  active search response remained identical.
- Replaced a synthetic R2 note with different content of the same byte size:
  retrieval returned `409 SOURCE_REVISION_MISMATCH`.
- Removed that synthetic object: retrieval returned `404 SOURCE_NOT_FOUND`.
  Restored the original and verified successful retrieval again.
- Temporarily increased the synthetic source-manifest sizes above the ordinary
  note/attachment thresholds: both retrievals returned 413 before source bytes
  were read. Restored the manifest sizes afterwards.
- Exercised the real rate-limit binding with bounded requests to an unsupported
  admin operation: it returned `429 RATE_LIMITED` with `Retry-After: 60` on
  request 122 in this run. The configured limit is not a strict global quota.
- Successful and error responses used `Cache-Control: no-store`.

These are correctness smoke tests, not CPU, capacity, sustained-load, price or
cost measurements. They do not establish maximum-vault performance or change
the documented admission budgets. Those measurements remain in #35, and
production onboarding still requires #34's ingestion/publication validation.

## Cleanup

Disabled the temporary Worker route, deleted the Worker and its secrets,
deleted the synthetic D1 database, deleted all six source objects and deleted
the R2 bucket. Every deletion succeeded. Subsequent resource listings confirmed
that the test Worker, D1 database and R2 bucket were absent. Provider-managed
backup retention remains subject to Cloudflare policy.

No endpoint, account identifier, resource identifier, credential, private path
or runtime log is included in this report.
