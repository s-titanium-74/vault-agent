# Phase 3.2 Search Filters Core Specification

Status: Draft

This file is part of the Phase 3.2 specification. See ../requirements.md for requirements and this directory for the interface specifications.

## Scope

Core owns structured search filter schemas, normalization, validation, index metadata access, candidate filtering, and cross-interface result consistency.

Server, CLI, and MCP layers must not duplicate search filtering logic. They translate interface-specific names into the shared core filter model, call core, and format responses.

## Shared Filter Model

Core accepts a normalized search filter object:

```ts
type SearchFilters = {
  pathPrefix?: string[];
  excludePathPrefix?: string[];
  tags?: string[];
  excludeTags?: string[];
  frontmatter?: {
    type?: string[];
    status?: string[];
  };
};
```

Missing `filters` and an empty top-level `filters` object are equivalent to unfiltered search.

All arrays are optional. Empty arrays are invalid when supplied. If `frontmatter` is supplied, it must contain at least one supported field with a non-empty array. Duplicate values are allowed in input but deduplicated during normalization while preserving deterministic ordering.

## Filter Semantics

Filters apply to note-level metadata.

For chunk results, the filter is evaluated against the parent note's vault-relative path, frontmatter tags, and allowlisted frontmatter values.

Within one include filter type, values use OR semantics:

- `pathPrefix=["Projects","Areas"]` matches notes under either prefix.
- `tags=["privacy","meeting"]` matches notes with either tag.
- `frontmatter.status=["active","pending"]` matches notes with either status value.

Different include filter types use AND semantics:

- `pathPrefix=["Projects"]` plus `tags=["privacy"]` requires both conditions.
- `frontmatter.type=["note"]` plus `frontmatter.status=["active"]` requires both fields to match.

Exclude filters are applied after include filters:

1. Start from candidates allowed by vault discovery and configured exclusions.
2. Apply include filters.
3. Remove candidates matching `excludePathPrefix`.
4. Remove candidates matching `excludeTags`.
5. Rank the remaining candidate set and truncate to `limit`.

Filters must be applied before result limiting. A backend may rank internally before a final filter pass only if it still returns the top results from the filtered candidate set.

## Path Normalization

Path filter values are vault-relative folder prefixes.

Normalization steps:

1. Require a string value.
2. Trim surrounding whitespace.
3. Convert backslashes to `/`.
4. Collapse repeated `/`.
5. Remove one or more trailing `/`.
6. Reject empty values after normalization.
7. Reject absolute paths.
8. Reject `.` and `..` segments.
9. Reject URL-like values with schemes such as `file:`, `http:`, or `https:`.
10. Decode percent-encoded path separators or traversal forms before validation where applicable.
11. Preserve case; path matching is case-sensitive unless the underlying vault filesystem policy later defines otherwise.

Path matching is segment-aware:

- `Projects` matches `Projects/Alpha.md`.
- `Projects` matches `Projects/Active/Plan.md`.
- `Projects` does not match `ProjectsOld/Note.md`.
- `Projects/Active` does not match `Projects/Archive/Note.md`.

Path filters cannot bypass default exclusions or user-configured exclusions. A filter for an excluded prefix simply has no matches.

## Tag Normalization

Tag filters use YAML frontmatter `tags` values only.

Normalization steps:

1. Require a string value.
2. Trim surrounding whitespace.
3. Strip a single leading `#` for user convenience.
4. Reject empty values after trimming or stripping.
5. Preserve case; tag matching is case-sensitive in Phase 3.2.

Inline body tags such as `#meeting` are not indexed or matched for structured tag filters in Phase 3.2.

Duplicate tags within one note count as one note-level tag match.

## Frontmatter Normalization

Phase 3.2 supports only fixed allowlisted frontmatter fields:

- `type`
- `status`

Unknown frontmatter filter fields are invalid. User-configurable allowlists are out of scope.

Normalization steps for each value:

1. Require a string value.
2. Trim surrounding whitespace.
3. Reject empty values.
4. Preserve case; `Active` and `active` are distinct.

At indexing time, allowlisted field values follow Phase 3.1 facet value normalization:

- Array-valued frontmatter fields are expanded into individual values.
- String values are stored as-is.
- Numbers and booleans are coerced to strings.
- Null and empty string values are excluded.

## Index Schema Expectations

The implementation should store filterable metadata in structured index tables or columns rather than relying on FTS text matching.

Recommended logical model:

- Notes table includes note ID and vault-relative path.
- Tag table maps note ID to normalized tag values.
- Frontmatter facet table maps note ID, field name, and normalized value for allowlisted fields.
- Chunk table references parent note ID.

The exact physical schema is implementation-specific, but it must support:

- Filtering note and chunk candidates through parent note metadata.
- Efficient path prefix filtering.
- Efficient tag include and exclude filtering.
- Efficient allowlisted frontmatter filtering.
- Detecting index schema incompatibility when required metadata is unavailable.

If the active index lacks required filter metadata, filtered search returns `INDEX_INCOMPATIBLE` or another existing actionable index error. It must not return unfiltered results.

## Ranking Interaction

Filters narrow the candidate set. Ranking mode still controls how matching candidates are ordered:

- `lexical`: lexical ranking over filtered candidates.
- `embedding`: embedding nearest-neighbor ranking over filtered candidates.
- `hybrid`: RRF fusion over filtered lexical and embedding candidates.

Embedding-capable modes preserve Phase 1 fallback behavior:

- Omitted mode with unavailable embeddings falls back to lexical with warning.
- Explicit `hybrid` with unavailable embeddings falls back to lexical with warning.
- Explicit `embedding` with unavailable embeddings fails with `EMBEDDING_UNAVAILABLE`.

Filtering itself does not require embeddings.

## Result Shape

Structured filters do not change the search result item shape.

Search responses may include an optional `filters` summary only if a later specification explicitly adds it. Phase 3.2 does not add filter echoes to successful responses by default because raw filter values can reveal private organization.

## Errors

Core raises stable application errors:

- `INVALID_FILTER`
- `INVALID_PATH_FILTER`
- `INVALID_TAG_FILTER`
- `INVALID_FRONTMATTER_FILTER`
- Existing Phase 1 search and Phase 2 index errors.

Validation error details may include the invalid field name and a concise reason. They must not include raw full request bodies, raw queries, private absolute paths, note content, chunk content, secrets, or provider credentials.

## Privacy

Core logging must not include:

- Raw query strings.
- Raw filter request bodies.
- Private absolute paths.
- Note bodies.
- Chunk bodies.
- Arbitrary frontmatter values.
- Secrets or provider credentials.

Logs may include sanitized error codes, filter field names, count of supplied filter values, and request IDs.
