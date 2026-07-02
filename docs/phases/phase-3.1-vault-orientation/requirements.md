# Phase 3.1 Vault Orientation Requirements

Status: Draft

## Purpose

Phase 3.1 adds a read-only metadata discovery layer that helps agents understand the shape of a vault before running targeted search or explicit retrieval.

Phase 3.1 extends Phase 3 MCP Bridge by adding orientation MCP tools. HTTP endpoints and CLI commands build on Phase 1 server and CLI foundations. This gives CLI, HTTP, and MCP clients compact orientation data such as folder summaries, tag summaries, frontmatter field summaries, and high-level vault statistics without returning note bodies or large file listings.

Phase 3.1 must preserve the product direction from `docs/product-plan.md`: local-first, private-by-default, deterministic retrieval, progressive disclosure, one vault root per server process, and a clean separation between core, server, and CLI responsibilities.

## Background

`vault-agent` currently focuses on `search`, `get`, and `related`, which work well once an agent knows what to ask for. A new agent often needs lightweight orientation first:

- What top-level areas exist?
- Which tags are common?
- What frontmatter fields are used?
- Which folders seem important?
- How should the agent narrow future searches?

This is deterministic index metadata, not LLM-generated interpretation.

## Scope

Phase 3.1 must include:

- A compact vault overview surface (`overview`).
- A bounded directory tree or folder summary surface (`tree`).
- A tag summary surface (`tags`).
- A frontmatter field summary surface with allowlisted field values (`facets`).
- HTTP endpoints for all orientation surfaces.
- CLI commands for human and agent use.
- MCP tools exposing the same metadata through Phase 3 MCP bridge.
- Index freshness warnings in orientation responses.
- Tests using only synthetic Markdown fixtures.

Phase 3.1 builds on Phase 1, Phase 2, and Phase 3. Unless this phase explicitly overrides a Phase 1, Phase 2, or Phase 3 behavior, server access control, response envelopes, CLI JSON behavior, configuration precedence, logging policy, path safety, indexing safety, MCP tool behavior, and privacy requirements continue to apply.

Phase 3.1 must not include:

- LLM answer generation.
- Chat behavior.
- Structured search filters.
- Automatic note retrieval.
- Full note bodies.
- Full chunk bodies.
- Unbounded full vault file listings.
- Multiple vaults in one server process.
- Note writing or editing workflows.
- User-authored schema inference that exposes arbitrary private data by default.

## Orientation Surfaces

### Overview

`overview` returns compact vault-level metadata useful for initial orientation.

Response fields:

- `noteCount`: total indexed note count.
- `chunkCount`: total indexed chunk count.
- `topLevelFolders`: array of top-level folder entries, each with `path` (vault-relative) and `noteCount` (recursive). Sorted by `noteCount` descending, then alphabetical by `path` as tie-breaker. A "top-level folder" is an immediate child directory of the vault root that contains at least one indexed note (recursively). Notes placed directly in the vault root (not in any subfolder) are not represented in `topLevelFolders` but are included in the total `noteCount`.
- `topTags`: array of tag entries, each with `tag` and `noteCount` (note-level count). Sorted by `noteCount` descending, then alphabetical by `tag` as tie-breaker. Tags are sourced from frontmatter `tags` field values only; inline `#tag` occurrences in note bodies are not counted.
- `frontmatterFields`: array of frontmatter field entries, each with `name` and `noteCount`. Sorted by `noteCount` descending, then alphabetical by `name` as tie-breaker.
- `indexFreshness`: freshness state from Phase 2 (e.g., `fresh`, `stale`, `pending`, `updating`, `incompatible`, `unknown`).

`warnings` is returned at the response envelope level, not inside the `overview` data payload. See [Response Envelope](#response-envelope).

Default limits:

- `topLevelFolders`: default limit 20.
- `topTags`: default limit 50.
- `frontmatterFields`: default limit 50.

These limits are fixed by design and are not overridable via parameters. `overview` is always a compact surface. When a sub-array exceeds its limit, the response includes a truncation warning: `TOP_LEVEL_FOLDERS_TRUNCATED`, `TOP_TAGS_TRUNCATED`, or `FRONTMATTER_FIELDS_TRUNCATED`. Agents that need all entries should use `tree`, `tags`, or `facets` with higher limits.

Specification: [Orientation](specifications/orientation.md).

### Tree

`tree` returns a bounded directory tree showing vault folder structure.

Parameters:

- `depth`: maximum folder depth to return. Default: 2.
- `limit`: maximum number of tree nodes to return. Default: 50. Maximum: 500.
- `directOnly`: when true, `noteCount` reflects only notes directly in the folder, not recursively. Default: false.

Response fields per node:

- `path`: vault-relative folder path.
- `noteCount`: note count (recursive by default, direct-only when `directOnly` is true).
- `childFolders`: number of immediate child folders.
- `children`: child folder nodes (up to `depth` and `limit`), sorted alphabetical by `path`.

Tree output respects Phase 1 default exclusions and user-configured exclusions. Excluded directories (`.obsidian/`, `.git/`, `node_modules/`, build/cache dirs, user-excluded paths) do not appear in tree output.

All orientation surfaces respect Phase 1 default exclusions and user-configured exclusions. Excluded notes and directories are not counted in overview, tags, or facets aggregations.

Tree output is bounded by `depth` and `limit`. Nodes beyond the limit are omitted with a `TREE_LIMIT_EXCEEDED` warning.

Specification: [Orientation](specifications/orientation.md).

### Tags

`tags` returns tag names and note-level usage counts.

Parameters:

- `limit`: maximum number of tags to return. Default: 50.

Response fields per tag:

- `tag`: tag name (without leading `#`).
- `noteCount`: number of notes with this tag.

Tags are sorted by `noteCount` descending by default.

Tag counts are note-level only. Chunk-level tag counts are not included.

Specification: [Orientation](specifications/orientation.md).

### Facets

`facets` returns frontmatter field names, usage counts, and values for allowlisted fields.

Parameters:

- `limit`: maximum number of fields to return. Default: 50.

Response fields per field:

- `name`: frontmatter field name.
- `noteCount`: number of notes that have this field.
- `values`: array of `{ value, noteCount }` entries, populated only for allowlisted fields. Sorted by `noteCount` descending, then alphabetical by `value` as tie-breaker.

Fields are sorted by `noteCount` descending, then alphabetical by `name` as tie-breaker.

Allowlisted facet value fields:

- `type`
- `status`

Only these fields expose their values by default. Other fields return only `name` and `noteCount`. Arbitrary frontmatter values must not be exposed by default.

The allowlist is fixed for Phase 3.1. User-configurable facet field allowlisting is deferred to a future phase. If added later, it must be opt-in and must include privacy guardrails to prevent exposure of sensitive free-text values.

Facet value normalization rules:

- Array-valued frontmatter fields are expanded into individual value entries. Each array element is counted as a separate value for the same note.
- String values are case-sensitive. `Project` and `project` are distinct values.
- Non-string values (numbers, booleans) are coerced to strings for counting.
- Null and empty string values are excluded from facet value results.

Exact normalization details are specification concerns.

Specification: [Orientation](specifications/orientation.md).

## CLI

Specification: [CLI](specifications/cli.md).

Required Phase 3.1 CLI commands:

- `vault-agent overview`
- `vault-agent tree [--depth <n>] [--limit <n>] [--direct-only]`
- `vault-agent tags [--limit <n>]`
- `vault-agent facets [--limit <n>]`
- All commands support `--json` for machine-readable output.

CLI output defaults to compact human-readable output.

Phase 3.1 CLI orientation commands are server-backed. If the server is unreachable, commands must fail with an actionable message that tells the user how to start or configure the server.

## HTTP API

Specification: [Orientation API](specifications/orientation-api.md).

Required Phase 3.1 HTTP endpoints:

- `GET /overview`
- `GET /tree?depth=2&limit=50&directOnly=false`
- `GET /tags?limit=50`
- `GET /facets?limit=50`

All orientation endpoints use GET because they are idempotent metadata retrieval operations.

Query parameters use camelCase naming consistent with Phase 1 API conventions.

All orientation endpoints follow Phase 1 server access control, CORS policy, and response envelope conventions.

Limit validation for orientation endpoints is scoped to orientation surfaces and overrides Phase 1 search/related limit ranges:

- `tree` limit range: 1–500.
- `tags` limit range: 1–200.
- `facets` limit range: 1–200.

Phase 1's `INVALID_LIMIT` range of 1–50 applies only to search and related result limits.

## MCP Tools

Specification: [MCP Tools](specifications/mcp-tools.md).

Phase 3.1 adds the following MCP tools through the Phase 3 MCP bridge:

Orientation tools are prefixed with `vault_` to namespace them separately from Phase 3 retrieval tools (`search`, `get_note`, etc.) and avoid name collisions in MCP clients that merge tool lists from multiple servers.

All four orientation MCP tools are available on both stdio and Streamable HTTP transports, consistent with Phase 3 MCP bridge behavior.

| Tool             | Description                                     | Input                        | Output                        |
| ---------------- | ----------------------------------------------- | ---------------------------- | ----------------------------- |
| `vault_overview` | Get compact vault-level metadata                | (none)                       | Overview with counts and tags |
| `vault_tree`     | Get bounded directory tree                      | depth?, limit?, direct_only? | Folder tree with note counts  |
| `vault_tags`     | Get tag names and note-level usage counts       | limit?                       | Tag list with counts          |
| `vault_facets`   | Get frontmatter field names, counts, and values | limit?                       | Field list with counts/values |

MCP tool annotations:

- `readOnlyHint: true`
- `destructiveHint: false`
- `idempotentHint: true`

MCP tool parameters use snake_case naming consistent with Phase 3 MCP tools.

MCP tool responses follow Phase 3 response behavior: same inner payload structure as HTTP responses, wrapped in MCP JSON-RPC result structure, with Phase 2 index freshness warnings in the `warnings` array.

## Response Envelope

Orientation HTTP responses use the Phase 1 response envelope structure:

```json
{
  "data": { ... },
  "warnings": []
}
```

`warnings` is a top-level envelope field, not a field inside `data`. This is consistent with Phase 1 search and related responses.

`indexFreshness` is a field inside `data` for all orientation surfaces. Each orientation surface includes `indexFreshness` in its data payload.

When the index is not `fresh`, the envelope `warnings` array includes a freshness warning with the state and an actionable message.

## Data Minimization

Orientation responses must stay compact.

They must return:

- Counts.
- Vault-relative folder paths.
- Tag names and counts.
- Frontmatter field names and counts.
- Allowlisted field values (`type`, `status`) with counts.
- Index freshness warnings when available.

They must not return:

- Note bodies.
- Chunk bodies.
- Private absolute paths.
- Raw full file listings by default.
- Raw frontmatter values for arbitrary fields by default.
- Raw queries or request bodies in logs.

## Failure Modes

Specification: [Orientation](specifications/orientation.md), [Orientation API](specifications/orientation-api.md).

When no usable index exists, orientation endpoints must return an actionable error (`INDEX_NOT_FOUND`) that tells the user to run `index` or `reindex`. They must not silently return empty results.

When the index is stale, pending, or updating, orientation responses must include freshness warnings in the `warnings` array.

When the index is incompatible, orientation endpoints must fail with an actionable error (`INDEX_INCOMPATIBLE`).

`INDEX_NOT_FOUND` and `INDEX_INCOMPATIBLE` return HTTP `409`, consistent with Phase 1 search and related behavior.

Orientation endpoints must not expose private absolute paths, note content, chunk content, raw queries, or secrets in error responses.

When a usable index exists but contains zero notes (empty vault or vault with only non-Markdown files), orientation endpoints return valid responses with zero counts and empty arrays, not errors. This is distinct from the no-index case (`INDEX_NOT_FOUND`).

## Index Freshness

Orientation responses include Phase 2 index freshness warnings when available.

Freshness states:

- `fresh`: the committed index matches the latest known relevant vault state.
- `stale`: index may be outdated (e.g., files changed since last index).
- `pending`: indexing is expected but has not started.
- `updating`: indexing is in progress.
- `incompatible`: index schema or configuration has changed; reindexing required.
- `unknown`: freshness cannot be determined.

When freshness is not `fresh`, the response `warnings` array must include a freshness warning with the state and an actionable message.

Specification: [Orientation](specifications/orientation.md).

## Core

Orientation logic lives in `packages/core/src`.

Responsibilities:

- Aggregating note counts from the index.
- Building folder tree structures from indexed vault-relative paths.
- Aggregating tag counts from indexed frontmatter metadata.
- Aggregating frontmatter field names and counts from indexed metadata.
- Returning allowlisted field values for `type` and `status`.
- Constructing orientation response schemas.

Orientation data is derived from the existing index at request time. Phase 3.1 does not add orientation-specific caching or pre-computed orientation tables.

Orientation reads use the last committed index snapshot, consistent with Phase 2 search and get behavior during incremental updates. Orientation must not read a partially-written index during an active update.

Specification: [Orientation](specifications/orientation.md).

## Configuration

Phase 3.1 introduces no new configuration. Orientation inherits Phase 1 server configuration and Phase 2 index freshness configuration.

The [Configuration](specifications/configuration.md) specification file documents this inheritance and confirms no new configuration keys are required.

## Test And Fixture Requirements

Specification: [Testing And CI](specifications/testing-ci.md).

Tests, examples, snapshots, and fixture vaults must use only synthetic public-safe Markdown content.

Test vault fixtures for orientation should include:

- Multiple top-level folders (3-5).
- Nested folder structure (2-3 levels).
- Notes with various frontmatter fields (`title`, `tags`, `type`, `status`, `date`).
- Notes with and without frontmatter.
- Multiple tag varieties (5-10 distinct tags).

Tests must not include:

- Real private vault content.
- Real names.
- Private project names.
- Private paths.
- Private URLs.
- Credentials.
- API keys.
- Tokens.

Generated indexes, caches, logs, and local databases must not be committed.

If generated files are needed for tests, they must be generated from synthetic fixtures during the test run.

## Phase Acceptance Criteria

Phase 3.1 is complete when:

- An agent can call `vault-agent overview` and receive compact vault metadata useful for choosing future searches.
- An agent can call `vault-agent tree` and receive a bounded directory tree with note counts.
- An agent can call `vault-agent tags` and receive tag names with note-level counts.
- An agent can call `vault-agent facets` and receive frontmatter field names, counts, and values for allowlisted fields.
- All orientation surfaces work without returning note bodies or chunk bodies.
- Tree output is bounded by `depth` and `limit`.
- Tag output is bounded by `limit`.
- Facet output exposes values only for allowlisted fields (`type`, `status`).
- All paths in orientation responses are vault-relative.
- HTTP endpoints are available for all orientation surfaces.
- MCP tools are available for all orientation surfaces through Phase 3 MCP bridge.
- CLI commands support `--json` for machine-readable output.
- Orientation responses include index freshness warnings when the index is stale, pending, updating, or unknown. `incompatible` state returns an actionable error rather than a warning.
- Orientation `indexFreshness` values match the Phase 2 freshness state enum exactly, including the `fresh` state when the index is current.
- Orientation endpoints return actionable errors when no usable index exists.
- Orientation endpoints return actionable errors when the index is incompatible.
- When a usable index exists but contains zero notes, orientation endpoints return valid responses with zero counts and empty arrays.
- When tree output is truncated by `limit`, the response includes a `TREE_LIMIT_EXCEEDED` warning.
- When `overview` sub-arrays are truncated, the response includes `TOP_LEVEL_FOLDERS_TRUNCATED`, `TOP_TAGS_TRUNCATED`, or `FRONTMATTER_FIELDS_TRUNCATED` warnings.
- Facet value counts correctly handle array-valued frontmatter fields, with each array element counted as a separate value.
- Orientation reads during an active incremental index update return consistent results from the last committed index snapshot.
- Each orientation MCP tool includes a description that accurately describes its purpose, inputs, and outputs, consistent with the HTTP API documentation.
- API, CLI, MCP, logs, warnings, and errors avoid private absolute paths and note content.
- Tests use synthetic vault fixtures only.

## Open Product Decisions

No unresolved product decisions remain in this requirements document.

Previously open decisions resolved during requirements interview and review:

- `facets` includes values for allowlisted fields (`type`, `status`), not only field names and counts.
- `tree` noteCount is recursive by default, with `--direct-only` flag for direct-only counts.
- Tag counts are note-level only.
- MCP exposes separate tools (`vault_overview`, `vault_tree`, `vault_tags`, `vault_facets`) rather than a combined tool.
- `tree` default limit is 50, maximum is 500. Phase 1's 1–50 limit range applies only to search/related.
- Freshness state uses `fresh` (not `ok`) to match Phase 2 exactly.
- The `type`/`status` facets allowlist is fixed for Phase 3.1; user-configurable allowlisting is deferred.
- `vault_` MCP tool prefix namespaces orientation tools separately from Phase 3 retrieval tools.
- Orientation reads use the last committed index snapshot during active updates.
- Empty vault (zero notes) returns valid responses with zero counts, not errors.
- `overview` sub-array limits are fixed by design; truncated sub-arrays emit `TOP_LEVEL_FOLDERS_TRUNCATED`, `TOP_TAGS_TRUNCATED`, or `FRONTMATTER_FIELDS_TRUNCATED` warnings.
- `warnings` appears only at the response envelope level, not inside `data`, consistent with Phase 1.
- CLI exit codes align with Phase 1/2 for overlapping types (`2` validation, `3` auth, `4` not found); new codes `6` (server unavailable) and `7` (index incompatible) are added. Code `5` is avoided because Phase 2 uses it for "sync or index operation already in progress".
- CLI `--json` output wraps the HTTP response envelope (`{"data": {...}, "warnings": [...]}`).
- Orientation limit errors use `INVALID_PARAMETER`; Phase 1's `INVALID_LIMIT` applies only to search/related.
- Tree root node counts toward `limit`; breadth-first traversal is used for node selection when truncated.
- `tree` `depth` parameter range is 1–10; `limit` range is 1–500.
- Phase 1 default exclusions and user-configured exclusions apply to all orientation surfaces, not only `tree`.

## Specification Files

Phase 3.1 specifications live under:

```text
docs/phases/phase-3.1-vault-orientation/specifications/
```

Specification files:

- [Orientation](specifications/orientation.md)
- [Orientation API](specifications/orientation-api.md)
- [MCP Tools](specifications/mcp-tools.md)
- [CLI](specifications/cli.md)
- [Configuration](specifications/configuration.md)
- [Testing And CI](specifications/testing-ci.md)
