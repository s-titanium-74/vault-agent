# Phase 1 Indexing Specification

Status: Draft

This file is part of the Phase 1 specification. See ../requirements.md for requirements and this directory for the domain specifications.

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

If startup detects a stale or incompatible existing index, the server must surface an actionable warning or error and require an explicit `index` or `reindex` command as appropriate. An incompatible existing index must not be used for retrieval, but server startup must continue far enough to expose `POST /reindex` so users can rebuild without manually deleting local index files.

`POST /index` and `POST /reindex` are synchronous in Phase 1. The request waits until indexing completes or fails, then returns an indexing summary. Phase 1 does not include background indexing jobs, job IDs, or progress polling APIs.

Server startup fails with `CONFIG_INVALID` when no vault root is configured.

`vault-agent serve` startup output may display the configured vault root absolute path because it is an explicit local CLI operation. Logs and API responses must continue to avoid private absolute paths by default.

Startup output should include host, port, index availability, and embedding availability.

If first-run bootstrap indexing fails, the server exits without listening.

If first-run bootstrap embedding generation fails while `embedding.require` is false, the server may start with a usable lexical index and a warning. If `embedding.require` is true, startup fails.

Concurrent `index` or `reindex` requests for the same vault identity return `409` with `INDEX_BUSY`.

When full reindex is running and a previous usable index exists, search and retrieval continue using the previous index until the rebuilt index is swapped into place.

Indexing uses a vault-identity-scoped lock file to prevent concurrent indexing for the same vault from multiple server or CLI processes.
