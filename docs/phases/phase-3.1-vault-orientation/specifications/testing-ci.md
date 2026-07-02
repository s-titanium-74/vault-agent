# Phase 3.1 Testing And CI Specification

Status: Draft

This file is part of the Phase 3.1 specification. See ../requirements.md for requirements and this directory for the domain specifications.

## Test Fixtures

All tests use synthetic public-safe Markdown content. No real private vault content, names, projects, paths, URLs, credentials, or secrets may be used.

Fixture vault structure should include:

- 3-5 top-level folders.
- 2-3 levels of nested folders.
- 10-50 notes.
- Notes with frontmatter fields including `title`, `tags`, `type`, `status`, `date`, `created`, `updated`.
- Notes with array-valued `tags` (e.g., `["meeting", "idea"]`).
- Notes with array-valued `type` or `status` to test facet array expansion.
- Notes without frontmatter.
- Notes placed directly in the vault root (not in a subfolder).
- Files and directories matching default exclusions (`.obsidian/`, `.git/`, `node_modules/`) to verify exclusion behavior.

## Unit Tests

### Core Orientation Tests

- `getOverview` returns correct note count and chunk count.
- `getOverview` top-level folders are sorted and limited to 20.
- `getOverview` emits `TOP_LEVEL_FOLDERS_TRUNCATED` when top-level folders exceed 20.
- `getOverview` top tags are note-level and sorted.
- `getOverview` emits `TOP_TAGS_TRUNCATED` when tags exceed 50.
- `getOverview` frontmatter fields are aggregated and sorted.
- `getOverview` emits `FRONTMATTER_FIELDS_TRUNCATED` when fields exceed 50.
- `getOverview` excludes root-level notes from `topLevelFolders` but includes them in `noteCount`.
- `getTree` respects `depth` and `limit`.
- `getTree` counts the root node toward `limit`.
- `getTree` uses breadth-first node selection when `limit` is exceeded.
- `getTree` counts notes recursively by default.
- `getTree` counts notes directly when `directOnly` is true.
- `getTree` excludes excluded directories.
- `getTree` respects user-configured exclude patterns.
- `getTree` returns root node with zero counts and empty children for empty vault.
- `getTree` with `limit=1` returns only the root node with empty `children`.
- `getTags` returns note-level tag counts.
- `getTags` strips leading `#` from tags.
- `getTags` does not count inline `#tag` occurrences in note bodies.
- `getTags` deduplicates duplicate tags within a single note's frontmatter array (note count is 1, not 2).
- `getOverview` top tags do not include inline `#tag` occurrences in note bodies.
- `getFacets` returns field names and counts.
- `getFacets` returns values only for `type` and `status`.
- `getFacets` expands array values into separate value counts.
- `getFacets` coerces number and boolean values to strings.
- `getFacets` excludes null and empty string values.
- `getFacets` treats string values as case-sensitive.
- All surfaces return correct `indexFreshness` matching the Phase 2 enum exactly (`fresh`, `stale`, `pending`, `updating`, `incompatible`, `unknown`).
- All surfaces return freshness warnings at the envelope level, not inside `data`.
- Empty vault (zero notes) returns zero counts, not errors.
- Incompatible index returns `INDEX_INCOMPATIBLE`.
- Missing index returns `INDEX_NOT_FOUND`.

## HTTP API Tests

- `GET /overview` returns `200` with correct envelope shape (`data` and top-level `warnings` only; no `warnings` inside `data`).
- `GET /overview` response does not contain note bodies, chunk bodies, or content fields.
- `GET /overview` paths are vault-relative (do not start with `/`).
- `GET /tree` validates `depth`, `limit`, and `directOnly` parameters.
- `GET /tree` rejects `directOnly=True` (uppercase) with `400`.
- `GET /tree` treats bare `directOnly` query parameter as `true`.
- `GET /tree` rejects `directOnly=1` with `400`.
- `GET /tree` rejects `depth=11` with `400`.
- `GET /tree` returns `TREE_LIMIT_EXCEEDED` warning when truncated.
- `GET /tree` ignores unknown query parameters.
- `GET /tags` returns tags sorted by count.
- `GET /facets` returns fields with allowlisted values.
- Missing index returns `409` with `INDEX_NOT_FOUND`.
- Incompatible index returns `409` with `INDEX_INCOMPATIBLE`.
- No vault root configured returns `503` with `VAULT_NOT_CONFIGURED`.
- Server unavailable returns `503` with `SERVER_UNAVAILABLE`.
- Invalid parameters return `400` with `INVALID_PARAMETER`.
- Missing API key for non-localhost access returns `401` with `AUTH_REQUIRED` per Phase 1/Phase 3 behavior.
- Invalid API key for non-localhost access returns `403` with `AUTH_FAILED` per Phase 1/Phase 3 behavior.
- Error responses do not include private absolute paths or note content.

## CLI Tests

- `vault-agent overview` prints human-readable output.
- `vault-agent overview --json` prints valid JSON wrapped in `{"data": {...}, "warnings": [...]}` envelope.
- `vault-agent overview --json` does not contain private absolute paths or note content.
- `vault-agent tree --depth 3 --limit 100` passes parameters correctly.
- `vault-agent tree --direct-only` passes `directOnly=true`.
- `vault-agent tree` with `--limit` exceeding 500 fails with validation error (exit code `2`).
- `vault-agent tags --limit 10` returns at most 10 tags.
- `vault-agent facets --limit 5` returns at most 5 fields.
- CLI prints actionable error when server is unavailable.
- CLI exits with correct exit codes (`0` success, `1` general runtime, `2` invalid parameter, `3` auth, `4` index not found, `6` server unavailable, `7` index incompatible).
- `vault-agent overview` with no vault root configured exits with code `1` and prints actionable error.
- CLI human-readable output does not contain private absolute paths or note content.

## MCP Tool Tests

- `vault_overview` returns compact metadata via stdio transport.
- `vault_tree` accepts `depth`, `limit`, `direct_only` parameters.
- `vault_tags` returns note-level tag counts.
- `vault_facets` returns allowlisted field values.
- MCP tool result `warnings` array appears at the `result` level, not inside the data payload.
- MCP tool result uses `indexFreshness` field name matching the HTTP API.
- MCP tool errors return correct JSON-RPC error codes per Phase 3 mapping.
- `VAULT_NOT_CONFIGURED` returns JSON-RPC error code `-32013`.
- MCP tool descriptions are accurate and mention all parameters.
- MCP tool annotations are `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`.
- Streamable HTTP transport supports orientation tools when `mcp.enabled = true`.
- MCP tool results do not contain private absolute paths or note content.

## Privacy Tests

- Orientation HTTP responses do not contain note bodies, chunk bodies, or content fields.
- Orientation CLI output (human-readable and JSON) does not contain private absolute paths or note content.
- Orientation MCP tool results do not contain private absolute paths or note content.
- Orientation logs do not contain full notes, full chunks, snippets, raw queries, request bodies, frontmatter values, or private absolute paths.
- Orientation error messages do not leak private absolute paths, note content, chunk content, raw queries, or secrets.

## Integration Tests

- End-to-end flow: configure vault, index, call all orientation surfaces, verify consistency.
- Index update during orientation request: verify snapshot isolation (counts remain consistent).
- Reindex after vault changes: verify orientation surfaces reflect new counts.
- Cross-interface consistency: HTTP, CLI `--json`, and MCP tool results for the same vault produce equivalent data payloads (modulo envelope shape).

## Snapshot Tests

- Search-result-style snapshots should cover compact orientation metadata, not full note bodies.
- Snapshot tests for `overview`, `tree`, `tags`, and `facets` human-readable output are allowed.
- Snapshots must use synthetic fixture content only.

## CI Checks

Phase 3.1 does not add new CI workflows. Existing project checks continue to apply:

- `npm run typecheck`
- `npm run lint`
- `npm run format:check`
- `npm test`

## Generated Files

Generated indexes, caches, logs, coverage output, build output, and local databases must not be committed. Tests must generate these from synthetic fixtures during the test run.
