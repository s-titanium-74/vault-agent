# Cloudflare Architecture And Contracts

Status: Ready for Review

## Data Flow And Package Boundaries

```text
selected local vault files -> explicit upload -> private immutable R2 source
                                                    |
                                 portable parsing/chunking/index coordinator
                                     |                        |
                            D1 metadata/FTS/grams     opt-in Workers AI
                                     |                        |
                                     |                    Vectorize
                                     +-----------+------------+
                                                 |
HTTP CLI / remote MCP client -> authenticated Workers -> portable retrieval
```

The diagram describes cloud mode only. Local mode continues to use filesystem,
SQLite/FTS5, sqlite-vec, Ollama, Node HTTP, and local stdio MCP.

In #31, `@vault-agent/core/portable` becomes the runtime-neutral entrypoint.
The existing core entrypoint remains compatible with local consumers. The
portable entrypoint must have no transitive Node/native, filesystem, config,
watcher, Git, or Cloudflare imports. TypeScript types must also bundle without
requiring runtime-specific types. Web Crypto and UTF-8 encoders may be injected
or used through standard Web APIs; hashing must preserve existing ID bytes.

Local adapters may remain behind explicit local entrypoints in core; package
splitting must not force a public local API migration. A new
`packages/cloudflare` runtime owns Workers routing, bindings, authentication,
D1 migrations, and ingestion coordination. It consumes portable core, never
Fastify or the current Node core entrypoint. Cloud tooling is installed and
built separately from ordinary local installation. CLI owns upload selection,
arguments, endpoint resolution, credentials, progress, and output formatting;
it does not reimplement chunking or ranking. MCP tool definitions and mapping
delegate to the same portable use cases as HTTP.

## Identity And Path Rules

- A cloud `vaultId` is a random UUID created at setup, stored in deployment
  configuration and user-local upload configuration. It is not derived from a
  root path, bucket name, account ID, or endpoint. Moving the source directory
  or deployment preserves it when intentionally restoring the same vault.
- Current local `vaultIdentity(realpath)` remains a local cache identity. Do
  not silently replace it or invalidate local indexes in #31. A cloud manifest
  has its own portable vault ID and explicit schema version.
- Note ID remains the first 32 lowercase hex characters of SHA-256 of the
  canonical vault-relative path in UTF-8. Chunk ID remains `noteId:chunkIndex`.
  IDs are stable across deployment moves and reindexing of identical content.
  Rename is delete plus create; changing chunk boundaries can change which
  text a chunk index identifies. IDs alone never identify a content revision.
- Canonical paths use `/`, preserve case and Unicode bytes, and have no empty,
  `.` or `..` segments. Reject absolute/drive/UNC paths, backslashes, NUL,
  URL-like paths, invalid UTF-8, and normalization collisions. Decode HTTP paths
  exactly once and apply the same validator to manifests and adapter results.
- Source revision is a SHA-256 content digest, not a timestamp or R2 ETag.
  A manifest binds path, kind, size, digest, and source timestamp (if known).
  Public paths never contain R2 prefixes or machine roots.

## Contract Semantics

The following are implementation contracts, not new general-purpose public
storage APIs. All I/O is asynchronous, bounded, abortable, and returns typed
sanitized failures. All reads take a vault/snapshot context; adapters must not
fall back to a different vault, revision, or provider.

| Contract               | Required operations and guarantees                                                                                                                                                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VaultSource`          | Enumerate allowed manifest entries with opaque cursor and limit; stat one path; read UTF-8 text or stream bytes for one path and expected digest. Return missing, excluded, revision mismatch, and size-limit outcomes distinctly. No generic source write/delete methods.                            |
| `MetadataLexicalStore` | Read a committed snapshot manifest; resolve notes/chunks and compact attachment/guidance metadata; retrieve bounded FTS/gram candidates and filtered metadata; supply orientation, graph, and profile inputs; stage bounded index batches and atomically publish against an expected parent revision. |
| `VectorStore`          | Upsert/delete bounded vector batches with deterministic IDs; query a specific model generation and snapshot namespace; return internal references and raw metric values; report asynchronous mutation progress. No note bodies or query text in metadata.                                             |
| `EmbeddingProvider`    | Describe provider/model revision, dimensions, metric/normalization expectations, input-format version, input/token/batch limits; embed ordered document or query inputs with deadline; return one finite vector per input with exact dimension or typed error.                                        |

Source object writes belong to the cloud ingestion adapter, separate from the
read-only retrieval source contract. Index mutation belongs to the index
coordinator, not retrieval routes. Capabilities and backend constraints are
explicit; adapters cannot claim unsupported SQL or unlimited enumeration.

Core owns common filter evaluation and ranking. Stores implement bounded
candidate selection and filtering with those semantics. Core validates final
candidate membership/revision and builds schemas. Local ranking and snippets
retain their current behavior. Cloud lexical uses FTS5 plus the existing
bigram/trigram fallback, fused through RRF; hybrid fuses lexical and vector
ranks, never raw BM25 plus distance. Vectorize metric relevance must be
calibrated separately from sqlite-vec thresholds.

D1 is authoritative for allowed note membership and final filters. Vectorize
uses snapshot namespaces and minimal indexed references; it must not emulate
arbitrary path/tag filters through lossy truncated metadata. Fetch up to 100
vector references without values/full metadata, validate and post-filter in
D1, then fuse. A filtered semantic result may contain fewer than the requested
limit; report `VECTOR_CANDIDATES_TRUNCATED` when the candidate budget is
exhausted. Never relax filters to fill the limit. This bounded approximate
semantic policy is cloud-specific; lexical filtering remains complete.

Source adapters are not required to use R2. A future pCloud or other source
must provide the same scoped revision reads, or reject unsupported consistency
requirements. Such adapters, OAuth setup, and polling are follow-up work.

Index mutation policy and prepared data are shared across local and cloud runtimes:
[shared index updates](shared-index-updates.md).
