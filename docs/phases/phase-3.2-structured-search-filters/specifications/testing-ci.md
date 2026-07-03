# Phase 3.2 Testing And CI Specification

Status: Draft

This file is part of the Phase 3.2 specification. See ../requirements.md for requirements and this directory for the API, CLI, MCP, and core specifications.

## Fixture Policy

All tests use synthetic public-safe Markdown content.

Tests must not copy private vault content, real names, private project names, private paths, private URLs, provider credentials, API keys, or tokens.

Generated indexes, caches, logs, coverage output, build output, and local databases must not be committed.

## Fixture Vault

The Phase 3.2 fixture vault should include:

- Overlapping folder names such as `Projects/` and `ProjectsOld/`.
- Nested folders such as `Projects/Active/` and `Projects/Archive/`.
- Notes directly under the vault root.
- Notes with frontmatter `tags`.
- Notes with duplicate tags in one note.
- Notes with array-valued `tags`.
- Notes with inline body `#tags` that are not in frontmatter.
- Notes with `type` and `status` frontmatter.
- Notes with `type` and `status` as arrays.
- Notes with non-allowlisted frontmatter fields.
- Notes without frontmatter.
- Hidden and excluded paths such as `.obsidian/`, `.git/`, and `node_modules/`.

Fixtures should include enough overlapping content that query text alone would match both included and excluded candidates.

## Core Unit Tests

Core tests should cover:

- Missing `filters` behaves exactly like unfiltered search.
- Empty filter object behaves like unfiltered search.
- `pathPrefix` includes notes under the requested prefix.
- `pathPrefix` is segment-aware (`Projects` does not match `ProjectsOld`).
- Multiple `pathPrefix` values use OR semantics.
- `excludePathPrefix` removes matching candidates after include filters.
- `tags` include filter uses frontmatter tags only.
- `tags` multiple values use OR semantics.
- `excludeTags` removes notes with any excluded tag.
- Include tags and exclude tags combine as include then exclude.
- Inline body tags do not match structured tag filters.
- Duplicate tags within one note do not affect matching.
- `frontmatter.type` filters values.
- `frontmatter.status` filters values.
- Multiple values within one frontmatter field use OR semantics.
- Different frontmatter fields combine with AND semantics.
- Unknown frontmatter fields return `INVALID_FRONTMATTER_FILTER`.
- Frontmatter array values are matched.
- Number and boolean frontmatter values are matched as coerced strings where indexed.
- Null and empty frontmatter values are not matched.
- Chunk results are filtered through parent note metadata.
- Note-type results are filtered through note metadata.
- Filters apply before result limiting.
- Filtered lexical search works without embeddings.
- Hybrid search with filters preserves embedding fallback warnings.
- Explicit embedding search with filters fails when embeddings are unavailable.
- Incompatible index metadata fails filtered search rather than returning unfiltered results.

## Validation Tests

Validation tests should cover:

- Unknown top-level filter fields return `INVALID_FILTER`.
- `filters` supplied as a non-object returns `INVALID_FILTER`.
- Filter arrays supplied as non-arrays return `INVALID_FILTER`.
- Empty arrays return the relevant filter error.
- Non-string path, tag, or frontmatter values return the relevant filter error.
- Absolute path filters return `INVALID_PATH_FILTER`.
- Traversal path filters return `INVALID_PATH_FILTER`.
- URL-like path filters return `INVALID_PATH_FILTER`.
- Empty path filters return `INVALID_PATH_FILTER`.
- Empty tag filters return `INVALID_TAG_FILTER`.
- Empty frontmatter objects return `INVALID_FRONTMATTER_FILTER`.
- Empty frontmatter values return `INVALID_FRONTMATTER_FILTER`.
- Unknown frontmatter fields return `INVALID_FRONTMATTER_FILTER`.

## HTTP API Tests

HTTP tests should cover:

- `POST /search` with `filters.pathPrefix`.
- `POST /search` with `filters.excludePathPrefix`.
- `POST /search` with `filters.tags`.
- `POST /search` with `filters.excludeTags`.
- `POST /search` with `filters.frontmatter.type`.
- `POST /search` with `filters.frontmatter.status`.
- Combined path, tag, exclude, and frontmatter filters.
- Response envelope remains `{"data": ..., "warnings": [...]}`.
- Result item shape remains Phase 1 compatible.
- Responses do not include raw filter echoes, note bodies, chunk bodies, private absolute paths, or arbitrary frontmatter values.
- Validation errors return correct HTTP status and error code.
- Missing API key and invalid API key behavior remains unchanged from Phase 1.
- Freshness warnings appear at the envelope level.

## CLI Tests

CLI tests should cover:

- `vault-agent search "query" --path Projects`.
- Repeated `--path` flags.
- `--exclude-path`.
- `--tag`.
- Repeated `--tag` flags.
- `--exclude-tag`.
- `--frontmatter type=note`.
- `--frontmatter status=active`.
- Repeated `--frontmatter` flags for the same field.
- Invalid `--frontmatter invalid=value` exits with code `2`.
- Invalid path filters exit with code `2`.
- `--json` output remains the HTTP envelope shape.
- Human-readable output remains compact.
- CLI output and errors do not include private absolute paths, note content, chunk content, raw request bodies, or secrets.

## MCP Tool Tests

MCP tests should cover:

- `search` accepts `filters.path_prefix`.
- `search` accepts `filters.exclude_path_prefix`.
- `search` accepts `filters.tags`.
- `search` accepts `filters.exclude_tags`.
- `search` accepts `filters.frontmatter.type`.
- `search` accepts `filters.frontmatter.status`.
- Unknown filter fields return JSON-RPC error with `INVALID_FILTER`.
- Unknown frontmatter fields return JSON-RPC error with `INVALID_FRONTMATTER_FILTER`.
- Result payload matches the HTTP inner payload plus result-level `warnings`.
- Tool description mentions structured filters.
- Tool annotations remain read-only, non-destructive, and idempotent.
- `related` does not advertise filter parameters and Phase 3.2 does not add related filter behavior.
- MCP results and errors do not include private absolute paths, note content, chunk content, raw queries, raw request bodies, or secrets.

## Integration Tests

Integration tests should cover:

- End-to-end filtered search through HTTP after indexing a synthetic vault.
- CLI-to-server filtered search.
- MCP filtered search over stdio transport.
- Cross-interface consistency: HTTP, CLI `--json`, and MCP return equivalent result sets for the same query and filters, modulo envelope shape.
- Reindex after fixture changes updates filtered search results.
- Search during pending or updating index state uses the last committed snapshot and includes freshness warnings.
- Incompatible index returns actionable errors for filtered search.

## Snapshot Tests

Search-result snapshots may cover compact result metadata and snippets only.

Snapshots must not include full note bodies, full chunk bodies, private paths, real names, private project names, private URLs, credentials, API keys, or tokens.

## CI Checks

Phase 3.2 does not add new CI workflows. Existing project checks continue to apply:

- `npm run typecheck`
- `npm run lint`
- `npm run format:check`
- `npm test`
