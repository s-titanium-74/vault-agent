# Phase 1 Retrieval Foundation Specification

Status: Draft

## Purpose

This specification defines the concrete Phase 1 design for `vault-agent`.

It implements the requirements in `docs/phases/phase-1-retrieval-foundation/requirements.md` while preserving the product direction in `docs/product-plan.md`.

## Technology Stack

Phase 1 uses TypeScript on Node.js.

The implementation is split into:

- `core`: TypeScript library code for vault discovery, Markdown parsing, chunking, indexing, ranking, and retrieval schemas.
- `server`: Node.js HTTP server that validates requests, enforces access boundaries, and delegates retrieval work to `core`.
- `cli`: Node.js CLI that resolves local configuration, calls the server where appropriate, and formats output.

Storage, HTTP framework, CLI parser, package manager, and repository layout are defined in later sections.

## Repository Layout And Package Management

Phase 1 uses npm workspaces.

Repository layout:

```text
packages/
  core/
  server/
  cli/
```

Workspace responsibilities:

- `packages/core`: shared TypeScript library for filesystem discovery, Markdown reading, frontmatter parsing, chunking, embedding text generation, index operations, ranking, and retrieval schemas.
- `packages/server`: HTTP server package. It owns routing, request validation, access control, server configuration, error mapping, and delegation to `core`.
- `packages/cli`: CLI package. It owns argument parsing, user-facing command behavior, output formatting, endpoint resolution, local configuration commands, and server communication.

The repository root owns shared TypeScript, lint, format, test, workspace, and release configuration.

Root package scripts:

- `build`
- `typecheck`
- `lint`
- `format`
- `format:check`
- `test`
- `test:watch`
- `dev:server`

Phase 1 uses ESM packages with `"type": "module"`.

Minimum Node.js version: 22 LTS.

TypeScript settings:

- Target: `ES2022`.
- `strict: true`.
- `noUncheckedIndexedAccess: true`.

Build and development tools:

- Build tool: `tsup`.
- Development TypeScript runner: `tsx`.

Package source layout:

- `packages/core/src/index.ts`
- `packages/server/src/index.ts`
- `packages/server/src/main.ts`
- `packages/cli/src/index.ts`
- `packages/cli/src/main.ts`

Core public exports should include schemas, configuration types, indexer APIs, search APIs, retrieval APIs, and shared error types.

Server public exports should include `createServer(config)` and `startServer(config)`.

The CLI may use `core` configuration utilities and shared API schema types, but it must not implement search, indexing, ranking, or retrieval logic.

Phase 1 does not generate OpenAPI documentation. Public API schemas are defined in this specification and enforced with Zod in code.

`AGENTS.md` Working Commands should list the verified root package scripts once the implementation adds them.

The root workspace is private. npm publishing automation is out of scope for Phase 1. A future publishable CLI package may expose the `vault-agent` binary from `packages/cli`.

## Linting And Formatting

Phase 1 uses ESLint and Prettier from the repository root.

The root workspace should provide shared commands for:

- Type checking.
- Linting.
- Formatting checks.
- Running tests.

## User-Local Paths

Phase 1 uses `env-paths` with the application name `vault-agent` to derive user-local directories.

In this specification, `{paths.config}` and `{paths.data}` mean the directories returned by `env-paths` for the `vault-agent` application name.

Default paths:

- Config file: `{paths.config}/config.toml`
- Index data: `{paths.data}/indexes/{vaultIdentity}/index.sqlite`

The CLI command `vault-agent config path` prints the resolved config file path.

The index directory may be overridden by CLI flag, environment variable, or user-local TOML configuration. Configuration precedence is defined in the configuration section.

## Configuration File

User-local configuration is stored as TOML.

Config structure:

```toml
[vault]
root = "/path/to/vault"
exclude = []

[server]
endpoint = "http://127.0.0.1:8787"
host = "127.0.0.1"
port = 8787
api_key = ""
log_level = "info"

[index]
dir = ""

[embedding]
enabled = false
endpoint = "http://127.0.0.1:11434/v1/embeddings"
model = ""
require = false

[cors]
enabled = false
allowed_origins = []
```

Example repository configuration must use public-safe placeholder paths and empty secrets only.

Environment variable overrides use the `VAULT_AGENT_*` prefix.

Supported environment variables:

- `VAULT_AGENT_VAULT_ROOT`
- `VAULT_AGENT_SERVER_ENDPOINT`
- `VAULT_AGENT_SERVER_HOST`
- `VAULT_AGENT_SERVER_PORT`
- `VAULT_AGENT_API_KEY`
- `VAULT_AGENT_LOG_LEVEL`
- `VAULT_AGENT_INDEX_DIR`
- `VAULT_AGENT_EMBEDDING_ENABLED`
- `VAULT_AGENT_EMBEDDING_ENDPOINT`
- `VAULT_AGENT_EMBEDDING_MODEL`
- `VAULT_AGENT_EMBEDDING_REQUIRE`
- `VAULT_AGENT_CORS_ENABLED`
- `VAULT_AGENT_CORS_ALLOWED_ORIGINS`

`VAULT_AGENT_CORS_ALLOWED_ORIGINS` is a comma-separated list of origins.

Configuration precedence:

1. CLI flags.
2. Environment variables.
3. User-local TOML config.
4. Built-in defaults.

Secret values may be stored in user-local TOML configuration or environment variables. Normal configuration commands and API responses display only whether secret values are set. Phase 1 does not use OS keychain integration.

Unknown configuration keys are validation errors.

Boolean environment variables accept `true`, `false`, `1`, and `0`. Other values are validation errors.

Ports must be integers from 1 through 65535.

Endpoint values must be valid `http` or `https` URLs.

Default server endpoint: `http://127.0.0.1:8787`.

Default bind host: `127.0.0.1`.

Default port: `8787`.

An empty `index.dir` means the env-paths default index directory.

When `embedding.enabled` is false, `embedding.endpoint` and `embedding.model` are ignored. When `embedding.enabled` is true, `embedding.model` is required.

Phase 1 server binds HTTP only. TLS termination is out of scope.

## Vault File Discovery

Indexed note extensions:

- `.md`
- `.markdown`

Exclude patterns use gitignore-style syntax.

Default exclusions:

- Hidden files and directories.
- `.obsidian/`
- `.git/`
- `node_modules/`
- Common build, cache, output, and generated-data directories.
- Binary attachments.

User-configured exclusions are provided by `[vault].exclude` in TOML and are added to the default exclusions.

The implementation should use the `ignore` package or equivalent gitignore-compatible matching.

Invalid user exclude patterns are configuration validation errors.

Symlinks may be followed only when their resolved real path remains inside the configured vault root. Symlinks that resolve outside the vault root are excluded from indexing and rejected for explicit retrieval.

Hidden files and directories remain excluded by default and cannot be re-included by user exclude configuration in Phase 1.

Filesystem access follows the host operating system's case-sensitivity behavior. Index paths and note ID generation treat vault-relative paths as case-sensitive strings.

Path strings are not Unicode-normalized before note ID or vault identity hashing. The implementation uses the relative path string returned by filesystem discovery after separator normalization.

## Markdown Parsing

Phase 1 uses `gray-matter` for YAML frontmatter extraction and the `unified` / `remark` ecosystem for Markdown parsing.

Markdown files are read as UTF-8.

Invalid UTF-8 files are skipped with a `FILE_NOT_UTF8` warning.

Markdown files larger than 2 MiB are registered as note records but are skipped for chunking, body search, and embedding with a `FILE_TOO_LARGE_FOR_INDEXING` warning during indexing.

Files with Markdown extensions that appear binary, such as files containing null bytes, are skipped with a `FILE_BINARY` warning.

Markdown parsing must produce an AST used for:

- Heading-aware chunking.
- Heading hierarchy metadata.
- Paragraph-aware oversized chunk splitting.
- Attachment reference extraction.
- Minimal Obsidian wikilink extraction.
- Search text generation.

The implementation must avoid treating Markdown syntax inside code fences as headings or attachment references.

The implementation must avoid treating wikilink-like text inside code fences as note links or attachment references.

Malformed frontmatter is handled according to the failure-mode requirements: the note body may still be indexed, while invalid frontmatter is ignored or marked degraded with a warning.

Phase 1 supports YAML frontmatter only. TOML and JSON frontmatter are out of scope.

Malformed YAML frontmatter produces a `FRONTMATTER_PARSE_FAILED` warning. The note body may still be indexed, but frontmatter metadata for that note is ignored or marked degraded.

## Obsidian Wikilinks And Attachment References

Phase 1 extracts Markdown attachment references from:

- Markdown image syntax: `![](path)`.
- Markdown link syntax: `[](path)`.
- Obsidian embedded wikilinks: `![[path]]`.

Phase 1 also extracts minimal Obsidian note wikilinks from:

- `[[Note]]`
- `[[Note#Heading]]`
- `[[Note|Display]]`
- `[[Note#Heading|Display]]`

The index stores raw wikilink targets and attempts one-pass note-link resolution.

Note-link resolution uses indexed note filename stems, titles, and aliases. A note wikilink is resolved only when it has exactly one matching note. Ambiguous or unresolved wikilinks are retained as unresolved link metadata and do not fail indexing.

Duplicate note titles are allowed. If duplicate titles make a wikilink target ambiguous, the wikilink remains unresolved.

Resolved note links may be used as a weak signal for `related` candidate ranking. Phase 1 does not build a full backlink UI, full note graph API, or rename-tracking system.

Unresolved or ambiguous wikilinks do not produce warnings by default.

Code fence contents are not scanned for attachment references or wikilinks, but code fence text remains available for body search.

Attachment files are never chunked, lexically indexed, embedded, OCRed, or summarized in Phase 1. Only attachment references from Markdown notes are indexed as compact metadata.

## Chunking

Chunking is heading-aware and character-count based.

Default limits:

- Target chunk size: 2,000 characters.
- Maximum chunk size: 4,000 characters.

Chunking rules:

1. Split notes into heading sections using the Markdown AST.
2. Preserve heading hierarchy as chunk metadata.
3. Keep a heading section as one chunk when it is at or below the maximum chunk size.
4. Split oversized sections at paragraph boundaries where possible.
5. If paragraph splitting cannot keep chunks within the maximum size, hard split by character count.

Chunk content excludes YAML frontmatter.

Empty notes are indexed as notes but do not produce searchable chunks. Explicit note retrieval still works for empty notes.

Oversized notes that exceed the indexing size limit are indexed as notes but do not produce searchable chunks. Explicit note retrieval still works subject to retrieval size limits.

Headingless notes are chunked from body content with `heading: null` and `headingPath: []`.

## Identifiers

Note IDs are opaque identifiers derived from normalized vault-relative paths.

Generation:

1. Normalize the vault-relative path to use `/` separators.
2. Remove redundant `.` segments.
3. Reject paths that resolve outside the configured vault root.
4. Hash the normalized vault-relative path with SHA-256.
5. Encode the first 16 bytes as lowercase hexadecimal.

The resulting note ID is 32 lowercase hexadecimal characters.

Valid note IDs are 32 lowercase hexadecimal characters.

Note ID collisions must be detected. If two different normalized vault-relative paths produce the same note ID, indexing fails with `ID_COLLISION`.

Chunk IDs are represented as `{noteId}:{chunkIndex}` in result objects. HTTP chunk retrieval uses `/chunks/{noteId}/{chunkIndex}`.

Chunk indexes are zero-based and assigned in document order within the current index.

Valid chunk IDs use `{noteId}:{chunkIndex}`, where `chunkIndex` is a non-negative integer.

Renaming or moving a note changes its note ID and all chunk IDs.

API and CLI output paths use `/` separators.

## Vault Identity And Index Location

The vault identity is derived from the configured vault root.

Generation:

1. Resolve the configured vault root to a filesystem real path.
2. Hash the resolved absolute path with SHA-256.
3. Encode the first 16 bytes as lowercase hexadecimal.

The resulting vault identity is 32 lowercase hexadecimal characters.

The default index database path is:

```text
{paths.data}/indexes/{vaultIdentity}/index.sqlite
```

The index manifest stores the vault identity, not the private absolute vault root path.

If the configured vault root resolves to a different vault identity than the open index database, the index is incompatible and reindexing is required.

The index manifest stores a configuration fingerprint covering:

- Index schema version.
- Indexed file extensions.
- Effective exclude patterns.
- Chunk size limits.
- Embedding model where configured.

If the fingerprint changes, affected index portions are stale or incompatible and explicit indexing or reindexing is required.

## Index Storage

Phase 1 uses SQLite as the local index store.

The SQLite database contains:

- Document, note, chunk, metadata, and index manifest tables.
- FTS5 virtual tables for lexical search.
- Trigram lexical tables for non-whitespace language support.
- `sqlite-vec` vector tables for embedding search.

Lexical search must use SQLite FTS5 and supplemental trigram candidate matching. Embedding search must use `sqlite-vec`; Phase 1 does not include an application-side vector similarity fallback.

If embeddings are configured but `sqlite-vec` is unavailable or incompatible, embedding-only mode must fail with an actionable unavailable error. Hybrid and related behavior must follow the embedding fallback rules defined in the requirements.

The database is private derived data and is stored under the configured user-local index directory. The SQLite schema must include an index manifest with enough information to detect incompatible schema versions, vault root identity changes, relevant indexing configuration changes, and missing indexed files where practical.

Phase 1 uses `better-sqlite3` as the SQLite driver.

SQLite access must be isolated behind `core` index storage modules so server and CLI code do not issue ad hoc SQL queries.

Phase 1 loads `sqlite-vec` from the npm `sqlite-vec` package. It does not include a user-configurable sqlite-vec extension path.

If the `sqlite-vec` extension cannot be loaded from the installed package, embedding search is unavailable. The failure must not prevent lexical indexing or lexical search from working.

SQLite connections should use:

- `journal_mode=WAL`
- `foreign_keys=ON`
- `busy_timeout=5000`

Index database filenames:

- Active database: `index.sqlite`
- Temporary full rebuild database: `index.tmp.sqlite`

Index schema version starts at integer `1`. The current Phase 1 schema version
is `2`; version `2` includes allowlisted frontmatter aliases and tags in chunk
lexical index text. Indexes from older schema versions are incompatible and must
be rebuilt or explicitly indexed before retrieval uses them.

Phase 1 does not perform automatic index migrations. Schema version mismatch requires explicit reindexing.

## Embedding Provider

Phase 1 supports only OpenAI-compatible embedding endpoints.

Embedding requests use:

```text
POST {embedding.endpoint}
```

Request body:

```json
{
  "model": "configured-model",
  "input": ["text one", "text two"]
}
```

The configured endpoint should normally be a local `/v1/embeddings` endpoint, such as an Ollama OpenAI-compatible embeddings endpoint.

External SaaS embedding providers and public internet endpoints are out of scope for Phase 1.

Embedding is disabled by default.

The embedding endpoint host must be `127.0.0.1`, `localhost`, or `::1`.

No embedding model is selected by default. Users must explicitly configure the embedding model.

Phase 1 embedding provider authentication is out of scope.

Embedding provider request timeout: 120 seconds.

Embedding provider requests are not retried in Phase 1.

Embedding generation uses batches of up to 32 input texts per provider request.

Embedding model and vector dimension are stored in the index manifest. If the configured embedding model or observed vector dimension changes, the embedding index is stale or incompatible and embeddings must be regenerated. The lexical index may remain usable.

Embedding input text for each chunk is generated from:

1. Note title where available.
2. Heading path where available.
3. Chunk text.

Arbitrary frontmatter fields are not included in embedding input text.

Embedding input text is capped at 8,000 characters.

Embedding vectors are stored as float32 vectors in `sqlite-vec` tables.

Chunk content SHA-256 hashes are stored and may be used with the embedding model name to reuse embeddings for unchanged chunks.

Lexical index text for each chunk is generated from:

1. Note title where available.
2. `aliases` frontmatter values where available.
3. `tags` frontmatter values where available.
4. Heading path where available.
5. Chunk text.

Arbitrary frontmatter fields are not included in lexical index text.

Date-like frontmatter fields such as `date`, `created`, and `updated` may be exposed as compact allowlisted metadata, but they are not included in lexical index text or embedding input text in Phase 1.

Phase 1 does not include structured date filters.

Title selection order:

1. Frontmatter `title`.
2. First level-1 Markdown heading.
3. Filename stem.

Tags are normalized from frontmatter `tags` values. String values, string arrays, and `#tag` forms are accepted. Stored tag values omit the leading `#`.

Aliases are normalized from frontmatter `aliases`. A string value becomes a single-item array. A string array is preserved. Non-string alias values are ignored.

Date-like frontmatter values are stored as strings without date parsing.

Embedding failure behavior:

- If lexical indexing succeeds and `embedding.require` is false, indexing succeeds with a warning when embedding generation fails.
- If `embedding.require` is true or the CLI request uses `--require-embeddings`, embedding generation failure causes indexing to fail.
- Embedding failures must not corrupt or remove a usable lexical index.

SQLite FTS5 uses the `unicode61` tokenizer.

Phase 1 does not use language-specific tokenizers such as MeCab or Kuromoji. The supplemental trigram index is the portable lexical support path for non-whitespace languages.

Phase 1 does not define custom stopwords or stemming.

User search input is not exposed directly as raw FTS5 query syntax. The implementation must safely tokenize or escape user input before querying FTS5.

Raw search queries must not be included in API responses, CLI human output, logs, warnings, or errors.

## Index Command Flow

Phase 1 treats the CLI primarily as a server client.

Command behavior:

- `vault-agent serve` starts the HTTP server.
- On server startup, if no usable index exists for the configured vault root, the server performs a first-run bootstrap index build before accepting retrieval requests.
- The server does not start listening until the first-run bootstrap index build finishes.
- The first-run bootstrap only applies when no usable index exists.
- Existing indexes are not automatically refreshed, repaired, migrated, or rebuilt during startup.
- `vault-agent index` calls `POST /index`.
- `vault-agent reindex` calls `POST /reindex`.
- `vault-agent search`, `vault-agent related`, and `vault-agent get` call the HTTP API.
- `vault-agent config *` commands operate on local user configuration.

Phase 1 does not include a local CLI indexing path that bypasses the server. If `vault-agent index`, `vault-agent reindex`, `vault-agent search`, `vault-agent related`, or `vault-agent get` cannot reach the configured server endpoint, the CLI fails with `SERVER_UNAVAILABLE` and tells the user to start `vault-agent serve` or update the configured endpoint.

Recommended first-run flow:

1. Configure the vault root with `vault-agent config set vault.root <path>` or an equivalent environment variable / CLI flag.
2. Start `vault-agent serve`.
3. Let first-run bootstrap build the initial index when no usable index exists.
4. Use `vault-agent search`, `vault-agent get`, and `vault-agent related` from another shell or agent process.
5. Run `vault-agent index` or `vault-agent reindex` later only while a server is reachable.

If startup detects a stale or incompatible existing index, the server must surface an actionable warning or error and require an explicit `index` or `reindex` command as appropriate.

`POST /index` and `POST /reindex` are synchronous in Phase 1. The request waits until indexing completes or fails, then returns an indexing summary. Phase 1 does not include background indexing jobs, job IDs, or progress polling APIs.

Server startup fails with `CONFIG_INVALID` when no vault root is configured.

`vault-agent serve` startup output may display the configured vault root absolute path because it is an explicit local CLI operation. Logs and API responses must continue to avoid private absolute paths by default.

Startup output should include host, port, index availability, and embedding availability.

If first-run bootstrap indexing fails, the server exits without listening.

If first-run bootstrap embedding generation fails while `embedding.require` is false, the server may start with a usable lexical index and a warning. If `embedding.require` is true, startup fails.

Concurrent `index` or `reindex` requests for the same vault identity return `409` with `INDEX_BUSY`.

When full reindex is running and a previous usable index exists, search and retrieval continue using the previous index until the rebuilt index is swapped into place.

Indexing uses a vault-identity-scoped lock file to prevent concurrent indexing for the same vault from multiple server or CLI processes.

## Search And Related Limits

Default result limit: 10.

Maximum result limit: 50.

Requests with limits above the maximum are rejected with a validation error rather than silently clamped.

## Snippets

Search and related snippets have a maximum length of 240 characters.

When possible, snippets should be selected around lexical matches or the most relevant text span. If no focused span is available, use the beginning of the matched chunk text.

Snippets are not independently retrievable and must not equal a full chunk. If a matched chunk is short enough that any useful excerpt would return the whole chunk, the snippet should be an empty string and the result should rely on title, path, heading, score, and reason.

## Ranking

Lexical search uses SQLite FTS5 ranking.

Lexical search also uses a supplemental trigram candidate index to improve matching for non-whitespace languages. FTS5 and trigram candidate lists are fused before or during lexical ranking.

The trigram index uses the same source text as lexical index text: title, aliases, tags, heading path, and chunk text.

Trigram indexing is chunk-level and stores gram-to-chunk mappings.

The default gram size is 3. For 2-character queries, the implementation may use bigram fallback. Queries shorter than 2 characters do not use trigram or bigram candidate matching.

Trigram candidate ranking uses query gram coverage, such as matched query grams divided by total query grams, rather than raw matched gram count. Trigram candidates are fused with FTS5 candidates using RRF.

Embedding search uses `sqlite-vec` nearest-neighbor results.

Hybrid search uses Reciprocal Rank Fusion to merge lexical and embedding result lists. Hybrid ranking must not directly add raw BM25 scores and raw vector distances.

Default RRF constant: 60.

Hybrid search should retrieve more candidates internally than the requested result limit from each source, then fuse and truncate to the requested limit. The internal candidate multiplier is an implementation detail, but it must not cause result responses to exceed the requested limit.

For `related`, resolved direct wikilinks may be added as a weak supplemental ranking signal. The link signal should be represented as another ranked candidate list and fused with the primary retrieval mode using RRF.

## Search Result Unit

Search and related results are chunk-primary in Phase 1.

Each result represents a chunk by default and includes note-level metadata such as `noteId`, vault-relative `path`, title, and compact allowlisted frontmatter metadata.

Notes without searchable chunks, such as empty or oversized notes, may appear as note-type results when title, path, or compact indexed metadata matches. Note-type results do not include body content and use an empty snippet.

Note body retrieval remains explicit through note retrieval endpoints and CLI commands.

## Search API

`POST /search` request body:

```json
{
  "query": "search text",
  "mode": "hybrid",
  "limit": 10
}
```

Fields:

- `query`: required non-empty string.
- `mode`: optional search mode. Allowed values are `lexical`, `embedding`, and `hybrid`.
- `limit`: optional integer from 1 to 50. Default is 10.

Maximum query length: 1,000 characters.

Empty or whitespace-only queries are invalid and return `400` with `INVALID_QUERY`.

If `mode` is omitted, the server chooses the default mode based on embedding availability.

Phase 1 does not include structured search filters such as path prefix or tag filters.

If embeddings are configured but unavailable and `mode` is omitted, search falls back to lexical with an `EMBEDDING_UNAVAILABLE` warning.

If `mode` is explicitly `hybrid` and embeddings are unavailable, search falls back to lexical with an `EMBEDDING_UNAVAILABLE` warning.

If `mode` is explicitly `embedding` and embeddings are unavailable, search fails with `503` and `EMBEDDING_UNAVAILABLE`.

## Related API

`POST /related` request body:

```json
{
  "type": "chunk",
  "id": "note-id:0",
  "mode": "embedding",
  "limit": 10
}
```

Fields:

- `type`: required input type. Allowed values are `note` and `chunk`.
- `id`: required note ID or chunk ID matching `type`.
- `mode`: optional retrieval mode. Allowed values are `lexical`, `embedding`, and `hybrid`.
- `limit`: optional integer from 1 to 50. Default is 10.

If `mode` is omitted, related defaults to embedding when embeddings are configured and available. If embeddings are not configured, related defaults to lexical without a warning. If embeddings are configured but unavailable, related falls back to lexical with an `EMBEDDING_UNAVAILABLE` warning.

Resolved links may be used as a supplemental related signal regardless of the requested related mode. The requested mode describes the primary retrieval signal.

Related input handling:

- For note input, related uses the note's chunks, compact metadata, and resolved note links as the source context.
- For chunk input, related uses that chunk's text, embedding, compact metadata, and resolved links from that chunk as the source context.
- For note input, all chunks from the input note are excluded from results.
- For chunk input, the input chunk is excluded from results.
- Resolved linked notes are returned as chunk-primary results using the linked note's first chunk as the representative result.
- Unresolved links are not used for ranking but may remain in explicit retrieval metadata.

For lexical related on a note input, the implementation builds an internal query from the note's chunk text and compact metadata. Related internal query text is capped at 4,000 characters.

Related result `reason` values include `related_embedding`, `related_lexical`, `related_link`, and `related_hybrid`.

If related defaults from embedding to lexical because embeddings are unavailable, the response includes an `EMBEDDING_UNAVAILABLE` warning.

Missing related input notes return `404` with `NOTE_NOT_FOUND`. Missing related input chunks return `404` with `CHUNK_NOT_FOUND`.

## Search And Related Response Shape

`POST /search` successful response data:

```json
{
  "requestedMode": "hybrid",
  "usedMode": "hybrid",
  "limit": 10,
  "results": []
}
```

`POST /related` successful response data:

```json
{
  "input": {
    "type": "chunk",
    "id": "note-id:0"
  },
  "requestedMode": "embedding",
  "usedMode": "embedding",
  "limit": 10,
  "results": []
}
```

Warnings are returned in the top-level response envelope.

Result item shape:

```json
{
  "id": "note-id:0",
  "type": "chunk",
  "noteId": "note-id",
  "chunkIndex": 0,
  "path": "Folder/Note.md",
  "title": "Note title",
  "heading": "Heading",
  "headingPath": ["Parent", "Heading"],
  "snippet": "Short snippet...",
  "score": 0.123,
  "reason": "hybrid_match",
  "metadata": {
    "aliases": [],
    "tags": [],
    "date": null,
    "created": null,
    "updated": null,
    "attachmentCount": 0
  }
}
```

Result items must not include full note bodies or full chunk bodies.

For note-type results, `id` is the note ID, `type` is `note`, `chunkIndex` is `null`, `heading` is `null`, and `headingPath` is an empty array.

`score` is a normalized display score from 0 to 1, where higher is better.

Raw BM25 scores, vector distances, and RRF internals are not included in Phase 1 responses.

`reason` uses stable string values, such as `lexical_match`, `embedding_match`, and `hybrid_match`.

## Note Retrieval API

`GET /notes/{noteId}` returns the original Markdown note content, including YAML frontmatter when present.

The HTTP response is JSON. The `contentType` field for note content is `text/markdown; charset=utf-8`.

Optional query parameters:

- `allowLarge=true`

Successful response data:

```json
{
  "id": "note-id",
  "path": "Folder/Note.md",
  "title": "Note title",
  "metadata": {
    "aliases": [],
    "tags": [],
    "date": null,
    "created": null,
    "updated": null
  },
  "content": "---\ntitle: Note title\n---\n\nMarkdown content",
  "contentType": "text/markdown; charset=utf-8",
  "size": 1234
}
```

Parsed arbitrary frontmatter fields are not returned separately.

Note retrieval may include compact link and attachment summaries:

```json
{
  "links": {
    "resolved": [],
    "unresolved": []
  },
  "attachments": []
}
```

## Chunk Retrieval API

`GET /chunks/{noteId}/{chunkIndex}` returns only the requested chunk content.

The HTTP response is JSON. The `contentType` field for chunk content is `text/markdown; charset=utf-8`.

Successful response data:

```json
{
  "id": "note-id:0",
  "noteId": "note-id",
  "chunkIndex": 0,
  "path": "Folder/Note.md",
  "title": "Note title",
  "heading": "Heading",
  "headingPath": ["Parent", "Heading"],
  "metadata": {
    "aliases": [],
    "tags": [],
    "date": null,
    "created": null,
    "updated": null
  },
  "content": "Chunk Markdown content",
  "contentType": "text/markdown; charset=utf-8",
  "size": 1234
}
```

Chunk content does not include YAML frontmatter unless the frontmatter text is part of the chunk, which Phase 1 chunking should avoid.

Chunk retrieval may include compact link and attachment summaries for references contained in that chunk.

## Explicit Retrieval Size Limits

Default note retrieval size limit: 200 KiB.

Default attachment download size limit: 10 MiB.

If a note exceeds the note retrieval limit, note retrieval fails unless the request includes the explicit large-content allow option.

If an attachment exceeds the attachment download limit, byte download fails unless the request includes the explicit large-content allow option.

Attachment metadata retrieval is not subject to the attachment byte download size limit because it does not return file contents.

The HTTP query parameter for large-content retrieval is `allowLarge=true`.

The CLI option is `--allow-large`.

## Attachment Retrieval

Attachment metadata retrieval:

```text
GET /attachments/{*vaultRelativePath}
```

Attachment byte download:

```text
GET /attachments/{*vaultRelativePath}?download=true
```

By default, attachment retrieval returns metadata only.

When `download=true`, the server returns file bytes if the attachment is within the configured size limit or `allowLarge=true` is set.

Attachment retrieval must apply the same vault-root path safety checks as note retrieval.

Attachment routes use a wildcard path segment so attachments may live in nested vault subdirectories. The server URL-decodes the wildcard path as UTF-8, treats it as a vault-relative path, and rejects it if normalization or realpath resolution would leave the configured vault root.

Attachment retrieval is allowed only for regular files that are not indexed Markdown notes and are not excluded by default or user-configured vault exclude patterns. Paths with `.md` or `.markdown` extensions must be retrieved through note APIs rather than attachment APIs. Hidden files and directories, `.git/`, `.obsidian/`, `node_modules/`, generated-data directories, and user-excluded paths are not retrievable as attachments.

Attachment paths that resolve to disallowed files return `403` with `ATTACHMENT_NOT_ALLOWED`. Missing allowed attachment paths return `404` with `ATTACHMENT_NOT_FOUND`.

Phase 1 uses the `mime-types` package for attachment `Content-Type` detection.

Unknown attachment content types use `application/octet-stream`.

Attachment metadata response data:

```json
{
  "path": "attachments/file.pdf",
  "fileName": "file.pdf",
  "contentType": "application/pdf",
  "size": 12345,
  "downloadAvailable": true
}
```

Phase 1 attachment metadata does not include file hashes or filesystem timestamps.

Successful attachment byte downloads return raw file bytes with the detected `Content-Type`. They do not use the JSON response envelope.

Attachment byte downloads should include `Content-Disposition: attachment` with the attachment filename where practical.

Attachment download errors still use the standard JSON error envelope.

## HTTP Server Framework

Phase 1 uses Fastify for the HTTP server.

Fastify is responsible for:

- Route registration.
- Request body and parameter validation.
- Authentication hooks.
- CORS configuration.
- Structured response serialization where useful.
- Mapping core errors to HTTP responses.

Server route handlers must stay thin. They validate HTTP input, enforce server-level access rules, call `core`, and format the HTTP response.

Phase 1 uses `@fastify/cors` when CORS is explicitly enabled.

JSON request body size limit: 64 KiB.

Phase 1 HTTP routes:

- `GET /health`
- `POST /index`
- `POST /reindex`
- `POST /search`
- `POST /related`
- `GET /notes/:noteId`
- `GET /chunks/:noteId/:chunkIndex`
- `GET /attachments/*`

Documented routes omit trailing slashes. Trailing slash behavior follows Fastify defaults and is not part of the canonical API.

JSON endpoints return `application/json; charset=utf-8`.

## CORS

CORS is disabled by default.

When CORS is enabled, `allowed_origins` must contain at least one explicit origin. Wildcard origins are invalid.

CORS credentials are disabled in Phase 1.

## HTTP Response Envelope

Successful JSON responses use:

```json
{
  "data": {},
  "warnings": []
}
```

Error JSON responses use:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Actionable error message.",
    "details": {}
  }
}
```

`warnings` is always an array on successful JSON responses. Warning and error details must not include raw note content, raw chunks, raw queries, secrets, provider credentials, or private absolute paths.

The response envelope `warnings` array contains warning details. Endpoint-specific summary fields such as `warningCount` are supplemental.

At most 100 warning objects are returned in one response. If warnings are truncated, the response includes a `WARNINGS_TRUNCATED` warning.

Error response `details` should include `requestId` when available.

Warning objects use:

```json
{
  "code": "WARNING_CODE",
  "message": "Actionable warning message.",
  "details": {}
}
```

## HTTP Status Codes And Error Codes

Phase 1 uses these HTTP status codes:

- `400`: validation error.
- `401`: missing or invalid authentication.
- `403`: forbidden path or access boundary violation.
- `404`: requested note, chunk, or attachment not found.
- `409`: incompatible index, stale index requiring explicit action, or conflicting index state.
- `413`: requested note or attachment exceeds the size limit without `allowLarge=true`.
- `503`: embedding provider or embedding index unavailable when required.
- `500`: unexpected internal error.

Error codes use `SCREAMING_SNAKE_CASE`, such as `INDEX_NOT_FOUND`, `PATH_OUTSIDE_VAULT`, and `EMBEDDING_UNAVAILABLE`.

The same error codes should be reused in API responses, CLI JSON output, and logs.

Each server request gets a request ID for log correlation.

Missing notes return `404` with `NOTE_NOT_FOUND`.

Missing chunks return `404` with `CHUNK_NOT_FOUND`.

Invalid note IDs or chunk IDs return `400` with `INVALID_ID`.

Unknown search or related modes return `400` with `INVALID_MODE`.

Limits outside 1 through 50 return `400` with `INVALID_LIMIT`.

Invalid attachment path syntax returns `400` with `INVALID_PATH`.

Attachment paths that point to directories return `400` with `INVALID_PATH`.

Attachment paths that point to Markdown notes, hidden paths, excluded paths, or other disallowed files return `403` with `ATTACHMENT_NOT_ALLOWED`.

Missing allowed attachments return `404` with `ATTACHMENT_NOT_FOUND`.

Path traversal or resolved paths outside the vault root return `403` with `PATH_OUTSIDE_VAULT`.

When no usable index exists, search and related return `409` with `INDEX_NOT_FOUND`. The message should tell the user to run `vault-agent index` or restart the server to run first-start bootstrap.

When stale index state is detected during search or related, the server may return results with an `INDEX_STALE` warning. Incompatible indexes must return `409` and must not be queried.

## Schema Validation

Phase 1 uses Zod for request, response, configuration, and internal retrieval schema validation.

Shared schemas should live in `packages/core` when they describe core retrieval concepts or public response shapes. Server-only HTTP parameter schemas may live in `packages/server`.

Fastify route handlers must validate incoming requests with Zod before calling `core`.

## Authentication

When the server binds to `127.0.0.1`, API key authentication is optional and disabled by default.

When an API key is configured, authentication is required for every endpoint even on localhost.

When the server binds to any non-localhost host, API key authentication is required for every endpoint, including `GET /health`.

Non-localhost startup without a configured API key generates a strong API key, stores it in the default user-local configuration, and enables authentication before the server starts listening. The generated key value is not printed during startup.

If a non-localhost server is started with `--config <path>` outside the default user-local configuration location and no API key is configured, startup fails with `API_KEY_REQUIRED` instead of writing a generated secret to the custom config file.

For authentication policy, localhost hosts are `127.0.0.1`, `localhost`, and `::1`. Any other bind host is non-localhost.

For non-localhost bind, the configured API key must be at least 32 characters.

Generated API keys use 32 random bytes encoded as a URL-safe string.

API key verification must use constant-time comparison.

Non-localhost startup must print a warning to stderr. Logs should include only a warning code and non-sensitive state.

Direct public internet exposure is out of scope for Phase 1.

API keys are supplied only with:

```text
Authorization: Bearer <api-key>
```

API keys must not be accepted in query parameters.

## Timeouts

CLI HTTP client timeouts:

- Indexing requests: 10 minutes.
- Search, related, note retrieval, chunk retrieval, attachment metadata, and attachment download requests: 60 seconds.

## Logging

Phase 1 uses `pino` for structured logging.

Default log level: `info`.

The log level may be configured through user-local configuration or environment variables. Supported levels are `debug`, `info`, `warn`, and `error`.

Logs must follow the data minimization rules defined in the requirements.

Logs may include warning codes and warning counts. Logs must not include individual private vault paths, raw queries, note content, chunk content, or absolute paths, even at `debug` level.

## Health API

`GET /health` successful response data:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "index": {
    "available": true,
    "stale": false,
    "embeddingAvailable": true
  }
}
```

Health status values are `ok`, `degraded`, and `error`.

Health is `degraded` when the index is unavailable, the index is stale, or embeddings are configured but unavailable. Fatal configuration errors prevent server startup instead of producing health responses.

The health `version` value comes from the package version.

The health response must not include vault paths, index paths, raw configuration values, or secrets.

During first-run bootstrap, the server has not started listening, so `/health` is not available until bootstrap completes.

## Index And Reindex API

`POST /index` performs an incremental index update when a usable index already exists.

Request body:

```json
{
  "requireEmbeddings": false
}
```

Fields:

- `requireEmbeddings`: optional boolean. When true, embedding generation failure makes the request fail even if lexical indexing succeeds. Default is the configured `embedding.require` value.

Successful response data:

```json
{
  "mode": "incremental",
  "notesIndexed": 12,
  "chunksIndexed": 48,
  "notesSkipped": 120,
  "warningCount": 0
}
```

`POST /reindex` performs a full rebuild.

Request body:

```json
{
  "requireEmbeddings": false
}
```

Fields are the same as `POST /index`.

Successful response data:

```json
{
  "mode": "full",
  "notesIndexed": 132,
  "chunksIndexed": 512,
  "notesSkipped": 0,
  "warningCount": 0
}
```

Incremental change detection uses vault-relative path, file size, and `mtimeMs`.

Index warnings may include vault-relative path, reason code, and file size. They must not include absolute paths or file contents.

Files skipped because of default hidden-file or default exclude handling are not counted in `notesSkipped`.

Index updates must use SQLite transactions.

Full reindex builds into a temporary database and swaps it into place only after the rebuild succeeds. If full reindex fails, the previous usable index must remain available.

## CLI Framework

Phase 1 uses Commander for the CLI.

Commander owns command and option parsing, help text, subcommand registration, and process exit behavior. CLI command handlers must stay thin: they resolve configuration, validate CLI-level arguments, call the server or local configuration layer, and format output.

The CLI binary name is `vault-agent`.

CLI endpoint resolution:

1. `--endpoint`
2. `VAULT_AGENT_SERVER_ENDPOINT`
3. `[server].endpoint` in user-local TOML config.
4. Built-in default `http://127.0.0.1:8787`.

Global CLI flags:

- `--config <path>`
- `--endpoint <url>`
- `--api-key <key>`
- `--json`

`--api-key` is allowed for explicit one-off use. Help and documentation should recommend environment variables or user-local configuration for routine use because CLI flags may be recorded in shell history.

`--config <path>` may point to a custom TOML file, but generated secrets are never written to custom config paths outside the default user-local configuration location.

Command flags:

- `vault-agent serve`: `--vault-root`, `--host`, `--port`, `--index-dir`, `--api-key`
- `vault-agent index`: `--require-embeddings`, `--json`
- `vault-agent reindex`: `--require-embeddings`, `--json`
- `vault-agent search`: `--mode`, `--limit`, `--json`
- `vault-agent related`: `--type note|chunk`, `--mode`, `--limit`, `--json`
- `vault-agent get note`: `--allow-large`, `--json`
- `vault-agent get chunk`: `--json`
- `vault-agent get attachment`: `--download`, `--output <path>`, `--allow-large`, `--json`
- `vault-agent config get`: `--json`
- `vault-agent config set`: no command-specific flags
- `vault-agent config path`: `--json`
- `vault-agent config reveal-api-key`: `--json`

Attachment downloads require an explicit output target. `--download` without `--output` must fail. Writing attachment bytes to stdout is allowed only with `--output -`.

`vault-agent related` may infer `chunk` when the input contains `:` and may infer `note` when the input is a valid 32-character lowercase hexadecimal note ID. Ambiguous input requires `--type`.

`vault-agent search <query...>` joins positional query tokens with spaces.

`vault-agent related <id>` accepts a note ID or chunk ID.

`vault-agent get chunk` accepts either `<note-id> <chunk-index>` or a single `<chunk-id>`.

`vault-agent get note` accepts note IDs only in Phase 1. Retrieval by vault-relative note path is out of scope.

`vault-agent get attachment` accepts vault-relative attachment paths.

Phase 1 does not include structured path search filters. Path text may still match as ordinary query text when indexed.

`vault-agent config set` uses dotted keys, such as:

```text
vault-agent config set server.port 8787
```

`vault-agent config get` without a key prints the effective configuration. `vault-agent config get <key>` prints one dotted-key value. Secret values are shown only as set or unset.

For human-readable output, secret values appear as `set` or `unset`. For JSON output, secret values appear as objects such as `{ "set": true }`.

`vault-agent config set` must not echo secret values after writing them. It should print only set/unset status for secret keys.

`vault-agent config reveal-api-key` is the only Phase 1 command that prints an API key value. It prints the API key to stdout for explicit remote client setup and prints caution text to stderr. With `--json`, stdout contains `{ "apiKey": "..." }`.

`vault-agent config path` prints the resolved config file path. With `--json`, it prints `{ "path": "..." }`.

`vault-agent config set` creates the parent config directory and config file when needed. `vault-agent config get` shows effective defaults when the config file does not exist.

## CLI Output And Exit Codes

CLI human-readable output is compact table or list output.

CLI `--json` output should stay close to the HTTP response envelope shape.

Normal CLI output goes to stdout. Errors and warnings go to stderr. With `--json`, the JSON response goes to stdout.

Human-readable errors use:

```text
CODE: actionable message
```

Human-readable search output shows rank, score, vault-relative path, heading, and snippet.

Human-readable `get note` outputs note content to stdout by default so it can be redirected. Metadata is omitted or printed only as compact stderr context.

Human-readable `get chunk` outputs chunk content to stdout by default. Metadata is omitted or printed only as compact stderr context.

Human-readable `get attachment` without `--download` prints path, content type, size, and download availability.

Attachment downloads with `--output <path>` write bytes to the output file and print only a compact save summary. Attachment downloads with `--output -` write bytes to stdout.

`--download --json` without `--output` is invalid. With `--output <path>`, `--json` prints a save summary as JSON. Raw attachment bytes and JSON must not be mixed on stdout.

CLI exit codes:

- `0`: success.
- `1`: general runtime, indexing, search, or retrieval failure.
- `2`: validation or configuration error.
- `3`: authentication error.
- `4`: requested note, chunk, attachment, or index not found.

## Testing

Phase 1 uses Vitest.

Test coverage should include:

- Core unit tests for path safety, frontmatter parsing, chunking, identifier generation, indexing, ranking, and retrieval schemas.
- Server integration tests for route validation, authentication, CORS, response envelopes, indexing, search, related, and explicit retrieval.
- CLI tests or smoke tests for command parsing, JSON output, config commands, and server-backed retrieval commands.

Tests must use synthetic public-safe Markdown fixtures only.

Fixture vaults should live near the package that primarily uses them, such as `packages/core/test/fixtures/vaults/basic`.

Integration tests must create synthetic vaults and index directories under the OS temporary directory during the test run.

Snapshots may cover compact metadata and short snippets from synthetic fixtures, but must not snapshot full note bodies or full chunks.

Embedding tests use a fake local OpenAI-compatible embedding server.

The fake embedding server returns deterministic small vectors so embedding search and hybrid ranking are reproducible.

Integration tests must verify that `sqlite-vec` loads successfully. Because Phase 1 treats semantic retrieval as a first-class feature, sqlite-vec loading failure should fail the relevant integration tests rather than silently skip them.

Phase 1 does not require a numeric coverage threshold. Tests should prioritize path safety, data minimization, indexing failure modes, search modes, retrieval limits, authentication, and synthetic fixture behavior.

Phase 1 does not require CI secrets scanning. Public repository safety is enforced through review policy and may be strengthened with tools such as gitleaks in a later phase.

## Continuous Integration

GitHub Actions should run:

```text
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

CI runs on Node.js 22.

## Repository Documentation And Examples

Phase 1 should include README coverage for:

- Installation.
- User-local configuration.
- Starting the server.
- First-run bootstrap indexing.
- Manual `index` and `reindex`.
- `search`, `get`, and `related`.
- Privacy defaults and local-only behavior.

The repository should include `.env.example` with public-safe placeholder values only.

The repository should include `examples/config/config.example.toml` with public-safe placeholder values only.

The repository should include `examples/synthetic-vault` for documentation, demos, and manual verification. Example vault content must be synthetic and public-safe.

The repository `.gitignore` must exclude `node_modules`, build output, coverage output, `.env`, local SQLite databases, logs, caches, and other private derived data.

The project license is MIT.

Initial package version: `0.1.0`.

## Implementation Sequence

Recommended implementation order:

1. Workspace, package tooling, TypeScript, lint, format, test, and configuration foundation.
2. Core path safety, vault file discovery, Markdown parsing, frontmatter handling, wikilink extraction, and chunking.
3. SQLite schema, manifest, FTS5 lexical index, and trigram lexical index.
4. `sqlite-vec` loading, embedding provider integration, embedding storage, and embedding failure behavior.
5. Core search, hybrid ranking, related retrieval, link signal integration, snippets, and result schemas.
6. Explicit retrieval for notes, chunks, attachment metadata, and attachment downloads.
7. Fastify server routes, response envelope, authentication, CORS, error mapping, health, and startup bootstrap.
8. Commander CLI, endpoint resolution, config commands, server-backed commands, and output formatting.
9. Tests, synthetic fixtures, examples, README, CI, and acceptance hardening.
