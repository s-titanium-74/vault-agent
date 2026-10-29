# Cloudflare API And Clients

Status: Ready for Review

## Scope And Compatibility

The table inventories existing surfaces and commits the first complete cloud
release (#35). #32 must deliver all read rows including MCP with synthetic
seeding; #33 adds semantic mode; #34 adds upload and resumable index execution.
Before a later milestone is implemented, advertise its capability as false
and return `501 CAPABILITY_UNSUPPORTED`, never fabricated success.

| Existing surface                                                                                      | Cloud behavior                                                                                                     | CLI / MCP access                                                                                                       |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `POST /search`                                                                                        | Lexical required; optional embedding/hybrid in #33; existing filters and compact results                           | `search`; MCP `search`                                                                                                 |
| `GET /notes/{id}`, `/chunks/{id}/{index}`                                                             | Explicit revision-checked text retrieval                                                                           | `get note`, `get chunk`; MCP `get_note`, `get_chunk`                                                                   |
| `GET /attachments/*`                                                                                  | Metadata by default; authenticated streamed download only with `download=true`; uploaded allowed attachments only  | `get attachment`; MCP `get_attachment` retains existing metadata/base64 download behavior                              |
| `POST /related`                                                                                       | Existing lexical/optional semantic and weak resolved-link signal; no body expansion                                | `related`; MCP `related`                                                                                               |
| `GET /overview`, `/tree`, `/tags`, `/facets`                                                          | Existing bounded orientation semantics over selected cloud vault                                                   | Same CLI names; MCP `vault_overview`, `vault_tree`, `vault_tags`, `vault_facets`                                       |
| Search filters                                                                                        | Existing include/exclude path prefixes, tags, type/status semantics; enforce after vector candidate validation too | Existing CLI flags and MCP filter schema                                                                               |
| `GET /links/notes/{id}`, `/links/backlinks/{id}`, `/links/broken`, `/links/orphans`, `/links/summary` | Existing bounded graph; links outside uploaded scope remain unresolved                                             | `links` subcommands; MCP `vault_links`, `vault_backlinks`, `vault_broken_links`, `vault_orphans`, `vault_link_summary` |
| `GET /agent-guidance`, `/agent-guidance/*`                                                            | Compact list and explicit allowed file retrieval from selected source manifest                                     | Existing HTTP; MCP `vault_guidance_list`, `vault_guidance_get`; no existing dedicated CLI command                      |
| `GET /profiles/metadata`, `/profiles/style`                                                           | Existing filters, aggregates, example policy and configured value allowlist; no body responses                     | `profile` subcommands; MCP `vault_metadata_profile`, `vault_style_profile`                                             |
| `GET /status`                                                                                         | Authenticated cloud freshness/capabilities below                                                                   | `status`, `watch status`, `sync status`; no existing MCP status tool                                                   |
| `POST /index`, `/reindex`                                                                             | Admin-only resumable jobs over committed uploaded source, never read local filesystem                              | Existing commands gain job handling; no MCP mutation tools                                                             |
| Watch                                                                                                 | Unsupported in Workers; status reports disabled with unsupported capability                                        | `watch status` reports disabled; attempts to enable cloud watch fail explicitly                                        |
| `POST /sync/pull`, `/sync/webhook`                                                                    | Unsupported; all methods return 501 after authentication; no Git process, scheduling, or webhook alias for upload  | `sync pull` fails explicitly; `sync status` reports disabled                                                           |
| `POST /mcp`                                                                                           | Required initial cloud Streamable HTTP transport                                                                   | Remote MCP client configured with endpoint and bearer token                                                            |
| Local `serve`, `config`, `mcp`                                                                        | Remain local commands; no implicit deployment or upload                                                            | `mcp` still talks directly to local core over stdio                                                                    |

Unless explicitly overridden here, use current response envelopes, validation,
filter semantics, result ordering, errors, and size limits defined in local
phase documents and current schemas. Search/related limit 10 default / 50 max,
query 1,000 characters max, snippets 240 characters max and never a whole
chunk. Note/guidance retrieval defaults to 200 KiB, attachment bytes to 10 MiB;
`allowLarge=true` bypasses these retrieval thresholds, not upload hard limits
or execution/memory budgets. Default attachment retrieval is metadata only;
raw downloads stream with attachment Content-Disposition. Profile/graph scans
must use bounded indexed data, not read every R2 source object per request.

Embedding unavailable behavior follows Phase 1: omitted mode or explicit
hybrid falls back to lexical with `EMBEDDING_UNAVAILABLE`; explicit embedding
returns 503. Disabled consent must prevent provider calls, including probes.
An empty cloud vault is a valid empty snapshot; it is not a missing index.

## Status And Capability Negotiation

Keep the actual current local `FullStatus` object layout: `server`,
`index.freshness` object, `index.embeddingState`, `watch`, and `sync`. Cloud
uses `server.host` as the deployment hostname, port 443, `apiKeyRequired: true`.
Watch is disabled; sync is unconfigured, disabled and idle. Do not implement
the older illustrative flattened freshness schema from Phase 2 docs.

Add cloud-only `deployment` with `runtime: "cloudflare"`, `vaultId`,
`activeRevision`, `targetRevision` (nullable), `activeJobId` (nullable),
`cleanupPending`, and a `capabilities` object. Capability booleans are:
`lexical`, `semantic`, `attachments`, `related`, `orientation`, `filters`,
`links`, `guidance`, `profiles`, `mcpHttp`, `upload`, `indexJobs`, `watch`,
`gitSync`. Semantic is enabled configuration, with current availability in
`index.embeddingState`; watch and gitSync are always false. Include no account
IDs, storage resource names, credentials, local roots, or provider endpoints.
Clients must not infer runtime from hostname or a timeout. Older clients
remain usable for read APIs; cloud admin operations require the updated CLI.

Successful cloud JSON reads additionally include top-level
`revision: { vaultId, snapshot }`. Optional `snapshot` query parameter on
explicit get APIs pins a prior search revision; it succeeds only while that
revision is active, otherwise 409 `REVISION_CHANGED`. Without a pin, get reads
the current active revision. Clients needing exact search-to-get consistency
must pass the returned snapshot. Do not expose historical snapshots by ID.
Cloud MCP explicit get tools accept the same optional `snapshot` string;
existing required inputs remain unchanged. Map cloud revision/source failures
to JSON-RPC `-32000` with `data.errorCode` carrying the HTTP application code.
Keep existing specific MCP error mappings for existing errors. MCP response
budgets, including base64 expansion, retain the existing 50 MiB transport cap;
`allowLarge` never bypasses it. Larger attachment downloads use HTTP.

## Workers MCP

Provide `/mcp` from #32, with the same read-only tools/inputs/inner payloads as
the existing adapter, including guidance, links, and profiles. Tool output
includes warnings and cloud revision metadata. No source mutation, indexing,
chat, resources, or prompts are advertised. The endpoint is enabled by the
explicit cloud setup; local MCP defaults remain unchanged.

Use the existing `2025-03-26` negotiation contract with a stateless Web
Request/Response transport: initialize returns tools capability; POST returns
JSON responses, notification-only input returns 202 without a body; GET and
DELETE return 405 with `Allow: POST`. No SSE stream, resumability, persistent
session ID, or isolate-local session map is required. Authenticate every
request and validate Origin. Accept bounded JSON-RPC batches (maximum 10
messages, total body 64 KiB); process sequentially with normal protocol errors.
Initialize protocol fallback, tool annotations, schemas and tool error
mapping retain the existing MCP contract. Batch errors must not echo params.

This stateless option follows the
[MCP Streamable HTTP transport specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports).
Validate the selected SDK's Web transport and a real authenticated remote
client before #32 closes. Do not port Fastify's raw-stream transport or its
in-memory sessions into Workers. Clients must support manual bearer headers;
OAuth discovery/interactive login and stdio-to-cloud proxying are out of scope.
Document these client constraints in #35; do not imply every MCP host works.

## Implemented #34 administration protocol

The [scoped ingestion specification](scoped-ingestion.md) supersedes the older
CLI-only advancement proposal. With ingestion enabled:

| Route                                     | Behavior                                                                                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /uploads`                           | Admin + UUID `Idempotency-Key`; `{vaultId,parentRevision,includes,entries,deletes,requireEmbeddings?}`. At most 100 total entries/deletes; returns job status. |
| `PUT /uploads/{job}/manifest`             | Admin; additional immutable `{entries,deletes}` page of up to 100 operations; at most 500 paths total. Identical pages may be retried.                         |
| `PUT /uploads/{job}/files/{encoded-path}` | Admin; raw bytes matching declared size and digest. Retries are deterministic.                                                                                 |
| `POST /uploads/{job}/commit`              | Admin; requires all declared bodies; seals source application. Cron or advance applies one operation per step.                                                 |
| `GET /jobs/{job}`                         | Read auth; bounded checkpoint/state/error metadata.                                                                                                            |
| `POST /jobs/{job}/advance`                | Admin; `{checkpoint}`. Old checkpoint returns current status without repeating the step.                                                                       |
| `POST /index`                             | Admin; `{requireEmbeddings?,newScan?}`. Resumes current reconciliation unless `newScan:true`, which conflicts while busy.                                      |
| `POST /reindex`                           | Admin; reparses all notes in a new snapshot; conflicts while busy.                                                                                             |

Manifest entries are `{path,kind,size,digest,updated}`. Job states are preparing,
uploading, applying, scanning, planning, files, chunks, links, counting, vectors,
validating, publishing, complete and failed. A complete upload job means source
intent was applied; the CLI also waits for a subsequent index job before
reporting overall success. Job cancellation is not exposed in this milestone;
uncommitted plans expire after 24 hours. `--resume` takes the private local plan
UUID rather than an arbitrary remote job ID. Failed source intents require a
new plan so conflicting direct edits are never silently overwritten.
