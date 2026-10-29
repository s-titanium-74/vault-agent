# Cloudflare retrieval adapter

For an operator deployment, start with the [self-deployment guide](../../docs/cloudflare-setup-guide.md). It covers the root template, ignored local configuration, synthetic onboarding, native MCP, rotation and teardown. The package configuration below remains the development/smoke example.

This independent package serves one explicitly configured vault through private
R2 + D1 bindings, authenticated HTTP reads, and stateless read-only MCP. It uses
`@vault-agent/core/portable` source through the package tsconfig; no local core
entrypoint, filesystem, native SQLite, Ollama, watcher, or Git code is bundled.
The MCP tool declarations are shared with the local server through a module
containing only declarations and SDK type imports.

Ordinary root installation/build/test does not install or execute cloud tooling.
Cloud development starts from a repository checkout with root dependencies
installed. The separate lockfile pins the cloud toolchain. The Zod v3 API from
the current Zod package preserves the shared schemas without migrating local
consumers. Miniflare is pinned to the runtime used by Wrangler and uses its
v4-options conversion helper.

```sh
npm ci
npm ci --prefix packages/cloudflare
npm run typecheck --prefix packages/cloudflare
npm test --prefix packages/cloudflare
npm run build --prefix packages/cloudflare
```

Tests bundle and execute the real Worker in workerd with real local D1/R2
bindings. They cover migrations, FTS5/MATCH/BM25, Japanese bigram/trigram
behavior, deterministic ranking against the local SQLite adapter, filters,
empty notes/vaults, explicit retrieval, size and path restrictions, D1 rollback,
isolated staged FTS corpora, authentication, Origins, rate limits, all 18 MCP
tools, and an authenticated SDK Streamable HTTP client. They use synthetic
fixtures only. They require local TCP/IPC access. A successful local run is not
a successful deployed-service smoke test.

## Local synthetic fixture

From this directory, create local bindings and generate the reproducible seed:

```sh
npx wrangler d1 migrations apply DB --local
npm run seed
npx wrangler d1 execute DB --local --file .wrangler/fixture/seed.sql
```

The seed is a one-time import into an empty database. Reset local D1 state
before rerunning it. `.wrangler/fixture/objects.json` lists the exact private
object keys and generated files. Upload each using the CLI binding syntax:

```sh
npx wrangler r2 object put vault-agent-synthetic/KEY --local --file FILE
```

Replace KEY and FILE using one entry from the generated synthetic manifest;
do not upload real vault content through this operator-only fixture workflow.
Create `.dev.vars` with independently generated `READ_TOKEN` and `ADMIN_TOKEN`
(each 32 random bytes encoded as 64 lowercase hex characters). Never commit
this file. No sample credentials are supplied. For example, generate each token
in a private terminal using `openssl rand -hex 32`. Start with local TLS:

```sh
npm run dev -- --local --local-protocol https
```

The Worker requires HTTPS even in development. Use the local development
certificate only for local testing. `GET /health` is public and returns only
liveness. Every other route requires `Authorization: Bearer …`; no tokens in
URLs. Missing/invalid tokens return 401/403. Read tokens cannot access admin
routes. The private binding configuration fails closed when either secret is
missing or equal to the other secret. For an explicit short rotation overlap,
set `PREVIOUS_READ_TOKEN` / `PREVIOUS_ADMIN_TOKEN` secrets, install the new
current secrets, update clients, then delete the previous secrets. Previous
read credentials never gain admin privileges. Authentication is checked on
every request; there is no session that survives revocation.

## Read contract

HTTP routes and MCP tools follow
[API and clients](../../docs/phases/cloudflare-deployment/specifications/api-clients.md).
HTTP successes use `{ data, warnings, revision: { vaultId, snapshot } }`. MCP
text payloads preserve existing flat tool results, plus warnings/revision.
Pass `snapshot` on explicit get calls to pin the active revision. A changed
snapshot returns 409 `REVISION_CHANGED`; historical revisions cannot be read.
Attachments default to metadata; HTTP `download=true` returns an authenticated
download and MCP returns base64. R2 bytes are bounded and digest-verified before
any content is returned. `allowLarge` raises ordinary retrieval thresholds but
never bypasses the hard source or MCP transport budgets.

The base configuration serves lexical search with hybrid fallback warnings;
explicit embedding returns 503 until semantic processing is configured and a
complete generation is ready. Explicit upload and resumable indexing jobs are
available when `INGESTION_ENABLED=true`. Watch and Git sync remain unsupported. Link/orientation/profile data comes from bounded indexed
rows. Guidance is untrusted vault context, retrieved only by explicit calls.
See [admission budgets](../../docs/phases/cloudflare-deployment/specifications/workers-retrieval.md).

## Opt-in semantic environment

The `semantic` Wrangler environment is an explicit configuration example for
Workers AI and Vectorize V2. Review and replace its resource placeholders,
configure its own read/admin secrets, and apply **all** migrations (including 0002) before enabling it. Create a dedicated 1024-dimension cosine index and
a string metadata index on `chunkId` for visibility probes. The base environment
has no AI/Vectorize bindings and keeps consent false. Selecting `--env semantic`
sets `EXTERNAL_EMBEDDING_CONSENT=true`; this permits processing document inputs,
queries, and related context in Cloudflare. AI calls during local development
can still use the real service and incur usage; deterministic tests do not.

The selected model is `@cf/baai/bge-m3`. The adapter validates dimensions,
finite vectors and bounded input/batch sizes, normalizes vectors, and sanitizes
provider failures. Shared core applies filters and RRF fusion. Vectorize holds
compact identifiers and hashes only; D1 authorizes every hit against the pinned
snapshot. Explicit lexical mode performs no provider calls. Hybrid falls back
with a warning; embedding-only returns 503 when the provider/generation is
unavailable. Search/related responses include content-free `usage` counts when
semantic processing is configured.

Applying migration 0002 or selecting an environment does not create embeddings.
The publisher stages a matching `embedding_generations` descriptor,
calls bounded adapter writes and visibility probes, then publishes a complete
ready snapshot. Existing lexical snapshots remain usable. Model or
input-format changes require a new generation and full rebuild. See the
[semantic contract](../../docs/phases/cloudflare-deployment/specifications/semantic-retrieval.md)
for model selection, budgets, readiness, migration and hosted validation results.

### Remote semantic smoke

[The recorded synthetic run](../../docs/phases/cloudflare-deployment/specifications/remote-semantic-smoke-2026-10-28.md)
uses real Workers AI and Vectorize and records both successful behavior and a
hybrid ranking limitation. Its reusable runner is
`scripts/remote-semantic-smoke.ts`, paired with the separate disposable
`test/remote-semantic-worker.ts` entrypoint. Neither runs during ordinary tests.

Provision **new disposable** Worker/D1/private R2/Vectorize resources. Compile
the test entrypoint with the existing esbuild settings plus a `.sql` text loader.
Use the semantic bindings, the synthetic fixture vault identity, independently
generated read/admin secrets and `SYNTHETIC_SMOKE=true`. Keep content logging,
observability, previews and public bucket access disabled. Create the `chunkId`
string metadata index before writes. Do not use an existing vault's bindings.
Bootstrap with admin-authenticated POSTs to `/__smoke/setup`, then
`/__smoke/embed`, and bounded `/__smoke/probe` requests until ready. The setup
route is synthetic test scaffolding, not a production ingestion API.

Create a private operator-local JSON file with `endpoint`, `readToken` and
`adminToken`; never put secrets in command arguments or tracked files. From this
package directory run:

```sh
./node_modules/.bin/tsx scripts/remote-semantic-smoke.ts PRIVATE_STATE_JSON REPORT_JSON
```

If the visibility polling budget expires, rerun with `--resume-visibility` and
the same private state/report files. The runner preserves completed measurements
and resumes the staging visibility/deletion checks. It records semantic top-one
and hybrid top-three as smoke assertions and reports actual top-one rankings
for both modes. This small corpus is not a general relevance benchmark.

Finally POST `/__smoke/clear-source` with admin authentication, disable the route,
delete exactly the disposable Worker/secrets, index, database and bucket, and
verify their absence. Remove the local credential file. Worker deletion alone
does not remove storage or provider backups. Use the regular `src/index.ts`
entrypoint for product deployments; the smoke wrapper must never serve a vault.

MCP accepts POST only, protocol `2025-03-26`, notification responses 202, batches
of at most 10 messages, total request body at most 64 KiB and total response at
most 50 MiB. GET/DELETE return 405. Use a client that supports bearer request
headers. There are no sessions, SSE streams, OAuth, resources, or prompts.

## Deployed synthetic smoke procedure

Use a dedicated disposable Cloudflare deployment with no private content.
The checked-in Wrangler config is a non-deploying sample: replace resource IDs,
create a new vault UUID, and explicitly configure a route. Provision private
R2 and D1, leave R2 public access disabled, apply `migrations/` with `--remote`,
set the two Worker secrets with `wrangler secret put`, and review the include,
exclude, Origin and profile allowlists. Do not put tokens or account identifiers
in tracked files. Worker observability and request/content logs are disabled.
The rate limiter allows 120 authenticated requests/minute per deployment key
per Cloudflare location; configure ingress abuse protection separately.

Generate a fixture for the configured synthetic vault ID (the script's public
fixture ID and deployment must agree). Apply its SQL and R2 objects using the
same commands with `--remote`. Writes are operator actions outside HTTP and
are not a substitute for #34's ingestion/publication protocol. Deploy only
after reviewing the compiled bundle with `npm run build`.

Check the following using a private client environment for credentials:

1. `/health` discloses no identity or counts. Every other read, status, MCP,
   and admin route rejects missing/invalid credentials before storage access.
2. A read token receives `ADMIN_REQUIRED` on `/index`, `/reindex`, `/sync/pull`,
   and `/uploads`; an admin token can run ingestion jobs while Git sync remains
   `CAPABILITY_UNSUPPORTED`.
3. Search `apple` lexically, apply `tags: [garden]` and path/type/status filters,
   then get one returned note/chunk with its snapshot pin. Compare ordering
   with the local fixture tests. Check the Japanese trigram and empty note.
4. Get `images/chart.png` metadata, then explicitly download it. Check private
   download headers, no-store, size limits, excluded paths and traversal.
5. Use an actual remote MCP SDK client: initialize, list tools, call search,
   get note/chunk, guidance/profile/link tools, and attachment base64. Repeat
   requests across connections without a session ID; reject unlisted Origins.
6. Check `/status` cloud capabilities, observation age and active revision. Record measured
   D1/R2 behavior and timings without queries, bodies, credentials, or raw URLs.
7. Remove the disposable Worker, secrets, D1 and R2 objects/bucket after testing.
   Worker deletion alone does not remove storage/backups. Provider retention
   applies; no promise of immediate erasure from retained backups is made.

Remote smoke and cost/limit measurements must be recorded separately. This
package does not claim those gates have passed based on simulation. Do not
onboard private production content until authentication/exclusion/revision
isolation and #34 publication/ingestion validation have passed.

## Explicit upload and autonomous ingestion

Apply migration 0003 before enabling `INGESTION_ENABLED=true`. The provided
cloud configurations include a once-per-minute Cron Trigger and a paid-plan
1000 ms CPU limit. A Free-plan smoke requires omitting that custom limit; it
does not validate the paid-plan CPU budget. Never change an account plan as
part of setup without explicit authorization.

Configure the deployment endpoint and admin API key in user-local settings or
environment variables. From a configured local vault:

```sh
vault-agent upload --vault-id VAULT_UUID --include Notes images --dry-run
vault-agent upload --resume PLAN_UUID
vault-agent upload --vault-id VAULT_UUID --include Notes images --delete-removed
```

Dry run creates a private user-local plan, prints only selected relative paths,
counts/bytes, rules and destinations, and performs no requests. Resume verifies
that the selection is unchanged before sending bytes. The server revalidates
its own include/exclude policy. Supply matching exclusions locally; if the
server's narrower policy rejects a plan, no excluded bytes are accepted.

Editing `<VAULT_UUID>/source/<path>` directly in the private R2 bucket also
updates retrieval, without the CLI. Cron scans only this prefix and persists
bounded parsing/indexing/validation checkpoints in D1. Source objects are
mutable; `<VAULT_UUID>/<snapshot>/<path>` is reserved for immutable publication.
Do not edit published or staging objects. Attachments remain retrieval-only.
Optional hosted embeddings require separate deployment consent; unchanged exact
model/input pairs reuse cached vectors. The CLI polls jobs at one-second minimum
intervals; Cron continues committed work after it disconnects.

Retrieval serves the last immutable snapshot during detection/building/failure.
Status reports `deployment.detection.lastObservedAt` and observed/updating/stale
state, rather than claiming instantaneous synchronization. Deleted content can
remain accessible until a deletion snapshot publishes; afterward old IDs and
vectors cannot authorize retrieval. Cleanup retains obsolete snapshots for at
least 24 hours, then removes bounded batches on Cron. Ingestion never scans or
deletes unrelated bucket prefixes.

Protocol, concurrency, latency targets, budgets and recovery:
[scoped ingestion](../../docs/phases/cloudflare-deployment/specifications/scoped-ingestion.md).
The reusable `scripts/remote-ingestion-smoke.ts` operates only against disposable
resources using an operator-local credential JSON; it exercises the actual CLI
and optionally waits for a direct R2 edit to appear through real Cron.

Hosted #34 results and limits: [deployed ingestion smoke](../../docs/phases/cloudflare-deployment/specifications/remote-ingestion-smoke-2026-10-29.md).

`scripts/remote-ingestion-semantic-smoke.ts` adds hosted mandatory rebuild,
cache-reuse and autonomous deletion/query checks for two synthetic notes. It
uses the disposable instrumentation entrypoint and private operator state from
the recorded procedure; it must not be run against an existing vault.
