# Phase 3.2 Structured Search Filters Requirements

Status: Draft

## Purpose

Phase 3.2 adds structured filters to `search` so agents and users can narrow deterministic retrieval by vault metadata such as vault-relative path prefixes, tags, and selected frontmatter fields.

Phase 3.2 builds on Phase 3.1 Vault Orientation. Orientation helps an agent discover useful folders, tags, and facets; structured filters let the agent apply those choices to search without relying on query-text hacks.

Phase 3.2 must preserve the product direction from `docs/product-plan.md`: local-first, private-by-default, deterministic retrieval, progressive disclosure, one vault root per server process, and a clean separation between core, server, CLI, and MCP responsibilities.

## Background

Phase 1 search can match indexed path or tag text as ordinary query material, but ordinary text matching does not provide precise filtering. Agents need a way to express constraints such as:

- Search only under a known folder, such as `Projects/`.
- Search notes tagged `meeting`.
- Exclude archived areas.
- Search only notes with safe, explicitly supported frontmatter fields or values when that scope is defined.

Structured filters should narrow candidates while preserving the existing compact search result shape. Search remains retrieval only; it must not generate answers or retrieve note bodies automatically.

## Scope

Phase 3.2 must include:

- Structured search filters for HTTP `POST /search`.
- Structured search filters for `vault-agent search`.
- Structured search filters for the MCP `search` tool.
- Core filter evaluation shared by HTTP, CLI, and MCP surfaces.
- Path prefix include filtering.
- Path prefix exclude filtering.
- Tag include filtering.
- Tag exclude filtering.
- Allowlisted frontmatter field filtering for `type` and `status`.
- Filter validation with stable error codes.
- Index schema support for efficient path and tag filtering where needed.
- Search freshness warnings inherited from Phase 2 behavior.
- Tests using only synthetic Markdown fixtures.

Phase 3.2 must not include:

- Vault orientation endpoints or tools; those are Phase 3.1.
- LLM answer generation.
- Chat behavior.
- Automatic note retrieval.
- Full note bodies or full chunk bodies in search results.
- Arbitrary unbounded frontmatter querying by default.
- User-configurable frontmatter filter allowlists.
- A general query language.
- Filtering for `related`.
- Multiple vaults in one server process.
- Note writing or editing workflows.

## Filter Model

Search filters are optional. A search request without filters behaves exactly as defined in Phase 1, Phase 2, Phase 3, and Phase 3.1.

Initial required filter types:

- `pathPrefix`: include only results whose note path is under at least one vault-relative path prefix.
- `excludePathPrefix`: exclude results whose note path is under any vault-relative path prefix.
- `tags`: include results whose note-level frontmatter tags match at least one requested tag.
- `excludeTags`: exclude results whose note-level frontmatter tags match any requested tag.
- `frontmatter`: include results whose note-level frontmatter values match allowlisted field filters.

Filter matching is based on note-level metadata. For chunk results, filters apply to the parent note's vault-relative path and note-level metadata.

Filters apply before ranking when practical so `limit` remains meaningful. If a specific backend cannot apply every filter before ranking, the implementation must still return the top ranked results from the filtered candidate set, not rank unfiltered results and then drop matches after the limit is applied.

Multiple values within the same include filter type use OR semantics. Multiple path prefixes match if the note path is under any requested prefix. Multiple tags match if the note has any requested tag. Multiple values for one allowlisted frontmatter field match if the note has any requested value for that field.

Different include filter types are combined with AND semantics. For example, `pathPrefix=["Projects"]` and `tags=["privacy"]` means the candidate must be under `Projects` and have the `privacy` tag.

Include filters narrow candidates. Exclude filters remove candidates from the included candidate set after include filters are applied. Existing vault exclusions and path safety rules always apply before user-visible filter semantics; filters cannot include hidden, excluded, or disallowed paths.

## HTTP API

Specification: [Search Filters API](specifications/search-filters-api.md).

`POST /search` accepts an optional `filters` object.

Suggested request shape:

```json
{
  "query": "local embedding privacy",
  "mode": "hybrid",
  "limit": 10,
  "filters": {
    "pathPrefix": ["Projects"],
    "tags": ["privacy"],
    "excludeTags": ["archive"],
    "excludePathPrefix": ["Archive"],
    "frontmatter": {
      "type": ["note"],
      "status": ["active"]
    }
  }
}
```

HTTP request fields use camelCase names, consistent with existing Phase 1 and Phase 3.1 HTTP conventions.

Unknown filter fields must return a validation error rather than being silently ignored. This prevents agents from believing a filter was applied when it was not.

Successful responses keep the existing Phase 1 search response envelope and result shape unless a later specification explicitly changes it:

```json
{
  "data": {
    "results": []
  },
  "warnings": []
}
```

The response must not echo raw queries, raw filter request bodies, private absolute paths, note bodies, or chunk bodies by default.

## CLI

Specification: [CLI](specifications/cli.md).

`vault-agent search` accepts filter flags.

Required flags:

- `--path <prefix>`: add an include path prefix. May be repeated.
- `--exclude-path <prefix>`: add an exclude path prefix. May be repeated.
- `--tag <tag>`: add an include tag filter. May be repeated.
- `--exclude-tag <tag>`: add an exclude tag filter. May be repeated.
- `--frontmatter <field=value>`: add an allowlisted frontmatter filter. May be repeated.

Suggested usage:

```bash
vault-agent search "local embedding privacy" --path Projects --tag privacy --exclude-tag archive --exclude-path Archive --frontmatter status=active
```

CLI output remains compact. Human-readable output may show a short filter summary, but it must not print large raw input values or private absolute paths. `--json` output should stay close to the HTTP response envelope.

CLI validation failures use actionable messages and exit code `2`, consistent with existing validation behavior.

## MCP Tool

Specification: [MCP Tools](specifications/mcp-tools.md).

The MCP `search` tool accepts optional structured filters.

Suggested MCP input additions:

```json
{
  "query": "local embedding privacy",
  "mode": "hybrid",
  "limit": 10,
  "filters": {
    "path_prefix": ["Projects"],
    "tags": ["privacy"],
    "exclude_tags": ["archive"],
    "exclude_path_prefix": ["Archive"],
    "frontmatter": {
      "type": ["note"],
      "status": ["active"]
    }
  }
}
```

MCP filter field names use snake_case, consistent with Phase 3 MCP tool parameter conventions.

MCP search remains read-only and non-destructive. Tool annotations continue to declare:

- `readOnlyHint: true`
- `destructiveHint: false`
- `idempotentHint: true`

MCP responses use the same inner payload structure as HTTP search responses, wrapped in the MCP JSON-RPC result structure, with Phase 2 freshness warnings in the `warnings` array.

## Path Filter Requirements

Path filter values are vault-relative prefixes.

Path filters must:

- Accept relative folder prefixes such as `Projects` and `Projects/Active`.
- Normalize redundant separators and optional trailing slashes for matching.
- Reject absolute paths.
- Reject parent-directory traversal.
- Reject URL-like or encoded traversal forms that would escape the vault root.
- Reject empty strings.
- Respect default exclusions and user-configured exclusions.
- Match path segments, not arbitrary string prefixes that cut through a segment.

Examples:

- `Projects` matches `Projects/Alpha.md` and `Projects/Active/Plan.md`.
- `Projects` does not match `ProjectsOld/Note.md`.
- `Archive` excludes `Archive/Old.md` when supplied via `excludePathPrefix`.

All returned paths remain vault-relative.

## Tag Filter Requirements

Tag filters use note-level tags sourced from YAML frontmatter, consistent with Phase 3.1 tag orientation.

Tag filters must:

- Use frontmatter `tags` field values only.
- Not count or match inline `#tag` occurrences in note bodies in Phase 3.2.
- Apply to both note and chunk search results through the parent note.
- Validate tag values and reject empty strings.
- Avoid exposing arbitrary frontmatter values in errors or logs.

Repeated include tag filters use OR semantics. A note matches `tags=["privacy","meeting"]` if it has either `privacy` or `meeting`.

Repeated exclude tag filters also use OR semantics. A note is excluded by `excludeTags=["archive","private"]` if it has either `archive` or `private`.

When include and exclude tag filters are both present, include tags narrow the candidate set first, then exclude tags remove matching candidates.

## Frontmatter Filter Requirements

Phase 3.2 includes frontmatter filters for the fixed allowlisted fields `type` and `status`, matching Phase 3.1's fixed facet value allowlist.

Frontmatter filters must:

- Be allowlist-oriented.
- Avoid arbitrary free-text field exposure by default.
- Use field names and value exposure rules aligned with Phase 3.1 facets where practical.
- Apply to note-level metadata and parent notes for chunk results.
- Reject unknown or unallowlisted fields with stable validation errors.
- Use OR semantics for multiple values within the same field.
- Combine different frontmatter fields with AND semantics.
- Avoid logging raw frontmatter values.

For example, `frontmatter.status=["active","pending"]` matches notes whose `status` is either `active` or `pending`. `frontmatter.type=["note"]` plus `frontmatter.status=["active"]` requires both `type=note` and `status=active`.

User-configurable frontmatter allowlists are deferred to a future phase. If added later, they must be stored only in user-local configuration and must include privacy guardrails.

## Indexing And Core

Specification: [Search Filters Core](specifications/search-filters-core.md).

Core owns filter evaluation and any index schema additions required for efficient filtering.

Core responsibilities:

- Define shared filter schemas and validation helpers.
- Normalize path prefix filters safely.
- Normalize tag filters.
- Normalize allowlisted frontmatter filters.
- Apply filters to search candidate selection.
- Ensure note and chunk results share consistent note-level filter behavior.
- Keep search result schemas compact and unchanged by default.

The implementation should prefer structured indexed columns or tables for path and tags over ad hoc string matching. If index schema changes are required, Phase 2 index freshness and incompatible-index behavior apply.

When an existing index does not contain metadata required for filtering, search with filters must fail with an actionable index error rather than silently returning unfiltered results.

## Data Minimization

Structured filters must preserve existing search data minimization rules.

Search results must:

- Remain compact.
- Not include full note bodies.
- Not include full chunk bodies.
- Prefer vault-relative paths and stable note or chunk identifiers.
- Include freshness warnings when available.

Errors, warnings, logs, and validation details must not expose:

- Private absolute paths.
- Note content.
- Chunk content.
- Raw full request bodies.
- Raw queries.
- Secrets.
- Provider credentials.
- Large raw filter values.

Validation errors may identify invalid filter names, invalid value shapes, and concise sanitized examples of invalid fields when needed.

## Failure Modes

Filter validation failures return `400`.

Required stable error codes:

- `INVALID_FILTER`: unknown filter name or invalid filter object shape.
- `INVALID_PATH_FILTER`: invalid path prefix syntax, absolute path, traversal, empty path, or disallowed path shape.
- `INVALID_TAG_FILTER`: invalid tag value syntax or empty tag.
- `INVALID_FRONTMATTER_FILTER`: invalid or unallowlisted frontmatter filter.

Existing search failure modes continue to apply:

- `INVALID_MODE` for unknown search modes.
- `INVALID_LIMIT` for limits outside the Phase 1 search range.
- `INDEX_NOT_FOUND` when no usable index exists.
- `INDEX_INCOMPATIBLE` when the index schema or configuration is incompatible.
- `EMBEDDING_UNAVAILABLE` when embedding-only mode is required but unavailable.

Filtered search must never silently ignore filters. If a supplied filter cannot be validated or applied, the request fails.

## Test And Fixture Requirements

Specification: [Testing And CI](specifications/testing-ci.md).

Tests, examples, snapshots, and fixture vaults must use only synthetic public-safe Markdown content.

Test coverage must include:

- Path prefix include filtering.
- Path prefix exclude filtering.
- Combined include and exclude path filtering.
- Tag filtering.
- Exclude tag filtering.
- Allowlisted frontmatter filtering for `type` and `status`.
- Repeated CLI flags.
- HTTP filter validation.
- MCP filter validation.
- Note and chunk result filtering through parent note metadata.
- Lexical search with filters and no embeddings configured.
- Hybrid search with filters while preserving existing embedding fallback behavior.
- Index freshness warnings on filtered search.
- Invalid absolute path filters.
- Invalid traversal path filters.
- Empty filter values.
- Unknown filter names.
- Synthetic fixtures with overlapping folder names, such as `Projects` and `ProjectsOld`.

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

## Phase Acceptance Criteria

Phase 3.2 is complete when:

- HTTP `POST /search` supports structured filters for path prefix, exclude path prefix, and tags.
- HTTP `POST /search` supports tag exclude filters and allowlisted frontmatter filters for `type` and `status`.
- `vault-agent search` supports filter flags for path prefix, exclude path prefix, tags, exclude tags, and allowlisted frontmatter fields.
- The MCP `search` tool supports equivalent filters with snake_case field names.
- Unfiltered search behavior remains compatible with earlier phases.
- Filtered search results remain compact and use the existing search result shape.
- Filters are validated with stable error codes.
- Invalid path filters cannot escape the configured vault root or bypass existing exclusion rules.
- Filtering uses vault-relative paths only.
- Filtering applies to both note and chunk results through note-level metadata.
- Filtering works with lexical search and does not require embeddings.
- Hybrid and embedding-capable modes preserve existing embedding fallback behavior.
- Search responses include freshness warnings when available.
- Existing exclusion rules still apply before filter matching.
- Tests cover path prefix filtering, tag filtering, include/exclude behavior, validation failures, HTTP, CLI, MCP, and synthetic fixture behavior.
- Tests cover allowlisted frontmatter filtering for `type` and `status`.
- Tests use only synthetic public-safe content.

## Open Product Decisions

No unresolved product decisions remain in this requirements document.

Previously open decisions resolved during requirements review:

- Repeated tag filters use OR semantics by default.
- Phase 3.2 includes `excludeTag` / `exclude_tag` / `--exclude-tag`.
- Phase 3.2 includes frontmatter filtering.
- Frontmatter filtering uses the fixed Phase 3.1 facet value allowlist: `type` and `status`.
- Phase 3.2 does not add user-local configurable frontmatter allowlists.
- Phase 3.1 facet field names and Phase 3.2 frontmatter filter field names should match where possible.
- Phase 3.2 changes only `search`; `related` filters are deferred.
- Multiple path prefixes use OR semantics within the same filter type.
- Include filters are applied before exclude filters.

## Specification Files

Phase 3.2 specifications live under:

```text
docs/phases/phase-3.2-structured-search-filters/specifications/
```

Specification files:

- [Search Filters Core](specifications/search-filters-core.md)
- [Search Filters API](specifications/search-filters-api.md)
- [CLI](specifications/cli.md)
- [MCP Tools](specifications/mcp-tools.md)
- [Testing And CI](specifications/testing-ci.md)
