# Phase 1 Retrieval Foundation Requirements

## Purpose

Phase 1 establishes the standalone retrieval foundation for `vault-agent`: a local server and CLI that can index a single Markdown vault, return compact search and related-note candidates, and retrieve only explicitly requested notes, chunks, or attachments.

The phase must preserve the product direction from `docs/product-plan.md`: local-first, private-by-default, deterministic retrieval, progressive disclosure, and a clean separation between core, server, and CLI responsibilities.

## Scope

Phase 1 must include:

- A standalone server.
- A CLI client.
- User-local configuration.
- Manual indexing and reindexing.
- Lexical search.
- Optional local embedding search.
- Hybrid search.
- Related candidate retrieval.
- Explicit note retrieval.
- Explicit chunk retrieval.
- Limited explicit attachment retrieval.

Phase 1 must not include:

- Chat or LLM answer generation.
- An Obsidian plugin.
- An MCP bridge.
- Automatic background index updates.
- File watching.
- Git sync.
- Note writing or editing workflows.
- Multiple vaults in one server process.
- Automatic embedding model downloads.

Implementation language, framework, database, and storage engine choices are specification concerns and should not be decided in this requirements document.

## Vault Scope

One server process handles one configured vault root.

The vault root must come from user-local configuration, environment variables, or CLI flags. Private absolute vault paths must not be committed to repository files.

Indexed file types:

- `.md`
- `.markdown`

Default exclusions must include:

- Hidden files and directories.
- `.obsidian/`
- `.git/`
- `node_modules/`
- Common build, cache, output, and generated-data directories.
- Binary attachments.

The specification may define user-configurable vault-relative exclude patterns.

All indexing and explicit retrieval must stay within the configured vault root.

Path inputs that resolve outside the vault root must be rejected, including parent-directory traversal, absolute paths, URL-encoded traversal, and symlinks that resolve outside the vault root. Error responses must not expose private absolute paths.

## Attachments

Attachments are not indexed, searched, embedded, OCRed, summarized, or automatically expanded in Phase 1.

Markdown notes may expose attachment references as compact metadata where useful, but attachment contents must not appear in search or related results.

Attachment retrieval is explicit and limited:

- Attachments are addressed by vault-relative path.
- Attachment retrieval is limited to regular non-Markdown files inside the configured vault root.
- Attachment retrieval must not bypass note retrieval, default exclusions, user-configured exclusions, or path safety rules.
- The default attachment response returns metadata only.
- File bytes are returned only through an explicit download option.
- Attachment downloads have a default size limit.
- Oversized downloads require an explicit allow option or are rejected, as defined by the specification.
- MIME or content type metadata should be returned where practical.

## Indexing

Indexing is manually triggered in Phase 1, except for an optional first-run bootstrap when no usable index exists.

The first-run bootstrap may build the initial index during server startup. It must not watch files, automatically update an existing index, or silently repair stale or incompatible indexes.

`index` should attempt an incremental update when an index already exists. `reindex` performs a full rebuild.

Phase 1 must not include:

- File watchers.
- Automatic background updates.
- Automatic sync from Git or another remote.

Index data is private derived data from the vault. By default, indexes must be stored in a user-local data directory, not in the repository and not in the vault. The index location may be overridden by CLI flag, environment variable, or user-local configuration.

Index paths should be derived from a vault identifier, such as a hash of the vault root. Generated indexes must be excluded from commits.

Stale index conditions should be detectable where practical.

Large Markdown notes may be registered as retrievable note records even when their bodies are too large to chunk, search, or embed in Phase 1. Explicit note retrieval still applies the configured retrieval size limits.

## Embeddings

Embedding search is optional and disabled by default.

Phase 1 supports embeddings only through an explicitly configured local embedding provider. The primary provider interface is an OpenAI-compatible `/v1/embeddings` endpoint. Ollama should be documented as a primary local setup path when compatible with the chosen implementation.

Phase 1 must not send vault content to external SaaS embedding providers or public internet endpoints. External embedding providers are out of scope for Phase 1.

`vault-agent` must not automatically download embedding models in Phase 1. Users are responsible for installing and managing local embedding providers and models.

Lexical indexing and search must remain usable without embeddings.

Embedding failures must not corrupt or remove a usable lexical index. If lexical indexing succeeds but embedding generation fails:

- `index` exits successfully by default with a warning.
- `index --require-embeddings` exits non-zero.
- Full indexing failure exits non-zero.

When embedding search is unavailable:

- Hybrid search may fall back to lexical search.
- The fallback must be visible in search and related responses when an embedding-capable mode was explicitly requested or embeddings are configured but unavailable.
- Explicit embedding-only mode must fail with an actionable error.

Warnings and errors must not include raw note content, raw chunks, secrets, provider credentials, or private absolute paths.

## Chunking

Phase 1 uses heading-aware Markdown chunking.

Chunks are primarily based on Markdown heading sections. Heading hierarchy must be retained as metadata.

Oversized sections must be split further. Paragraph boundaries should be preferred when splitting. If paragraph-boundary splitting is insufficient, the implementation may split by a configured size limit.

Exact chunk size limits are specification concerns.

## Identifiers

Phase 1 uses `note ID` as the external note identifier in APIs, CLI commands, and result objects.

Note IDs are derived from vault-relative paths, but callers should treat them as opaque identifiers. The exact derivation and encoding are specification concerns.

Chunk IDs are derived from the note ID plus the chunk index.

IDs are stable within the current index, but they are not permanent cross-rename identifiers. Renaming or moving a note changes its note ID and chunk IDs.

Search, related, note, chunk, and attachment responses must prefer vault-relative paths. Absolute paths must not be returned by default.

## Frontmatter

YAML frontmatter is parsed during indexing.

Search and ranking use built-in selected frontmatter fields, centered on:

- `title`
- `aliases`
- `tags`
- Short date-like fields such as `date`, `created`, and `updated`

Search and related results expose only compact built-in allowlisted metadata. Arbitrary frontmatter fields are not exposed in compact result lists by default and are not ranking inputs by default.

Future phases may add user-configurable frontmatter field selection.

Explicit note retrieval may return the original Markdown content including frontmatter.

## Search

Search returns deterministic retrieval results only. It must not call an LLM or generate answers.

Supported search modes:

- `lexical`
- `embedding`
- `hybrid`

Default mode behavior:

- If embeddings are not configured, search defaults to lexical.
- If embeddings are configured and available, search defaults to hybrid.

Mode selection must be available through both HTTP requests and CLI options.

Embedding-only mode is allowed for debugging, comparison, and semantic-only retrieval. If embedding-only mode is requested while embeddings are unavailable, the request must fail with an actionable error.

Search results must be compact. They must not include full note bodies or full chunks.

Search responses must not echo the raw query by default.

## Related

`related` returns compact candidate results from a known note or chunk.

Inputs:

- A note ID or chunk ID.
- Optional limit.
- Optional mode where supported.

Default behavior:

- If embeddings are configured and available, related defaults to embedding-based retrieval.
- If embeddings are not configured, related defaults to lexical candidate retrieval without a warning.
- If embeddings are configured but unavailable, related falls back to lexical candidate retrieval with a visible warning.

`related` must not silently retrieve note bodies or chunk bodies. Body retrieval must go through explicit note or chunk retrieval.

`related` may use indexed content and compact metadata from the input note or chunk as internal retrieval material. The response must still contain only compact candidate results, not the input body or candidate bodies.

The input note or chunk itself must be excluded from related results. The exact representation of a whole-note input and the lexical fallback algorithm are specification concerns.

## Snippets

Search and related results include short snippets where safe.

A snippet is shorter than a chunk, is not independently retrievable, and is used only to help the user or agent decide whether to retrieve the note or chunk.

Snippets must not contain full note bodies or full chunks. If a chunk is too short to excerpt without returning the whole chunk, the snippet may be empty. Exact snippet length limits are specification concerns.

## Result Shape

Each search or related result must include:

- ID.
- Result type, such as note or chunk.
- Note ID.
- Vault-relative path.
- Title where available.
- Heading where available.
- Short snippet, which may be empty when needed to avoid returning a full chunk.
- Score.
- Reason.
- Compact allowlisted metadata.

Search and related responses must include:

- Requested mode.
- Used mode.
- Limit.
- Warnings.
- Results.

Warnings must make embedding fallback visible when hybrid or related retrieval degrades to lexical behavior.

## Failure Modes

Malformed frontmatter must not fail indexing for the whole vault. The note body may still be indexed, while invalid frontmatter is ignored or marked degraded with a warning.

Search and related must not silently return empty results when no usable index exists. They must return an actionable error that tells the user to run index or reindex.

Detected stale, incomplete, or incompatible index state must be visible through warnings or actionable errors. Incompatible index versions must not be used silently and should require reindexing.

At minimum, the specification should define stale or incompatible index handling for changed index schema, changed vault root identity, changed relevant indexing configuration, and missing indexed files where detectable.

Failure messages must not include raw note content, raw chunks, raw queries, secrets, provider credentials, or private absolute paths.

## Explicit Retrieval

Search and related identify candidates. Note, chunk, and attachment retrieval require explicit requests.

### Notes

Note retrieval returns the original Markdown content, including frontmatter.

The response includes:

- ID.
- Vault-relative path.
- Title where available.
- Compact metadata.
- Content.
- Content type.
- Size.

Large note size limits apply. Oversized notes require an explicit allow option or are rejected, as defined by the specification.

### Chunks

Chunk retrieval returns only the requested chunk content. Chunk content does not include frontmatter.

The response includes:

- ID.
- Note ID.
- Vault-relative path.
- Title where available.
- Heading where available.
- Compact note-level metadata.
- Content.
- Content type.
- Size.

Frontmatter is available through explicit note retrieval when needed.

## Server API

The required Phase 1 HTTP API is:

- `GET /health`
- `POST /index`
- `POST /reindex`
- `POST /search`
- `POST /related`
- `GET /notes/{noteId}`
- `GET /chunks/{noteId}/{chunkIndex}`
- `GET /attachments/{*vaultRelativePath}`

Known resource retrieval uses `GET`.

Operations containing private free-text queries or ranking options use `POST` request bodies. Search and related query text must not be placed in URLs by default.

Indexing uses `POST`.

Detailed request and response schemas are specification concerns.

## Server Access Control

Server defaults:

- Bind host: `127.0.0.1`
- Port: `8787`
- Remote access disabled by default.

Binding outside localhost requires:

- Explicit configuration.
- API key authentication.
- A startup warning.

API keys must come from user-local configuration or environment variables. API keys must not be committed to the repository.

Automatically generated API keys must be written only to user-local configuration, not to arbitrary configuration paths or repository files.

API keys are supplied with:

```text
Authorization: Bearer <api-key>
```

API keys must not be accepted in query parameters.

Failed authentication responses must not reveal expected keys, secrets, or private config paths.

## CORS

CORS is disabled by default.

CORS is not required for CLI, `curl`, or command-based agent usage.

CORS may be enabled only by explicit configuration. Allowed origins must be listed explicitly. Wildcard origins are not allowed in Phase 1.

## CLI

Required Phase 1 CLI commands:

- `vault-agent serve`
- `vault-agent index`
- `vault-agent reindex`
- `vault-agent search <query>`
- `vault-agent related <note-or-chunk-id>`
- `vault-agent get note <note-id>`
- `vault-agent get chunk <note-id> <chunk-index>`
- `vault-agent get attachment <vault-relative-path>`
- `vault-agent config get`
- `vault-agent config set`
- `vault-agent config path`

CLI output defaults to compact human-readable output.

Machine-readable output must be available with `--json`.

Search and related commands must support mode selection and result limits.

Large note and attachment retrieval must support an explicit allow option.

Phase 1 does not require a `status` or `doctor` command. Embedding fallback and availability issues must be visible in search and related responses.

Phase 1 CLI retrieval and indexing commands are server-backed. If the server is unreachable, commands must fail with an actionable message that tells the user how to start or configure the server.

## Configuration

User-local configuration uses TOML.

Configuration precedence:

1. CLI flags.
2. Environment variables.
3. User-local TOML config.
4. Built-in defaults.

Configuration covers at least:

- Vault root.
- Server endpoint.
- Bind host.
- Port.
- Index directory override.
- Embedding enabled flag.
- Embedding endpoint.
- Embedding model.
- API key where required.
- CORS allowed origins where enabled.

The repository may include only public-safe example configuration. Private vault paths, credentials, API keys, tokens, private endpoints, and provider-specific secrets must not be committed.

Configuration commands and API responses must not display secret values by default. For API keys, tokens, credentials, and provider secrets, output may indicate only whether a value is set.

Phase 1 may include an explicit API-key reveal command for remote client setup. This command must be narrow, intentional, and must not affect normal configuration display behavior.

API responses, logs, errors, search results, related results, note responses, chunk responses, and attachment responses must not return private absolute paths by default. Explicit local CLI configuration commands, such as `vault-agent config get` and `vault-agent config path`, may display configured local paths so users can inspect their own setup.

## Logging And Error Messages

Logs and error messages must follow data minimization.

Do not log:

- Full notes.
- Full chunks.
- Snippets.
- Raw queries.
- Request bodies.
- Frontmatter values.
- Attachment contents.
- API keys.
- Tokens.
- Credentials.
- Provider secrets.
- Private absolute paths.

Allowed log fields include:

- Event type.
- Status code.
- Duration.
- Result count.
- Requested and used mode.
- Warning or error code.
- Non-sensitive configuration state, such as whether embeddings are enabled.

Logs should prefer codes over raw values. Access logs must not include `Authorization` headers.

Errors should be actionable without dumping private content.

## Test And Fixture Requirements

Tests, examples, snapshots, and fixture vaults must use only synthetic public-safe Markdown content.

Tests must not include:

- Real private vault content.
- Real names.
- Private project names.
- Private paths.
- Private URLs.
- Credentials.
- API keys.
- Tokens.

Search-result snapshots should cover compact result metadata and snippets, not full note bodies.

Generated indexes, caches, logs, coverage output, build output, and local databases must not be committed.

If generated files are needed for tests, they must be generated from synthetic fixtures during the test run.

## Acceptance Criteria

Phase 1 is complete when:

- A user can configure one local vault root.
- A user can run a localhost-only server by default.
- A user can manually index and reindex synthetic Markdown vault content.
- Lexical search works without embedding configuration.
- Optional local embedding search works when configured.
- Hybrid search is default when embeddings are available.
- `related` returns compact candidates from a known note or chunk.
- Search and related never return full note bodies or full chunks.
- Note retrieval returns an explicitly requested Markdown note, subject to size limits.
- Chunk retrieval returns an explicitly requested chunk.
- Attachment retrieval returns metadata by default and bytes only through an explicit download option.
- CLI supports compact human-readable output and `--json`.
- Non-localhost bind requires API key authentication.
- Retrieval rejects path inputs that resolve outside the configured vault root.
- Normal configuration output indicates whether secrets are set without printing secret values.
- Search and related return actionable errors when no usable index exists.
- Detected embedding fallback, stale index, incomplete index, or incompatible index state is visible through warnings or errors.
- Malformed frontmatter in one note does not fail indexing for the whole vault.
- Related results exclude the input note or chunk itself.
- Private absolute paths, raw queries, request bodies, secrets, and note or chunk bodies are not logged.
- Tests use only synthetic Markdown fixtures.
