# Phase 3.2 MCP Tools Specification

Status: Draft

This file is part of the Phase 3.2 specification. See ../requirements.md for requirements and this directory for the API, CLI, core, and testing specifications.

## Tool Scope

Phase 3.2 extends the Phase 3 MCP `search` tool with structured filters.

No other MCP tools change in Phase 3.2. In particular, `related` does not accept filters in this phase.

## Tool Definition

### `search`

Description:
"Search the vault for notes matching a query. Optional filters can narrow results by vault-relative path prefixes, frontmatter tags, excluded tags, excluded path prefixes, and allowlisted frontmatter fields. Returns compact ranked results with titles, paths, snippets, and scores."

Parameters:

| Name    | Type    | Required | Default   | Description                                   |
| ------- | ------- | -------- | --------- | --------------------------------------------- |
| query   | string  | yes      | -         | Search query text                             |
| mode    | string  | no       | (omitted) | Search mode: `lexical`, `embedding`, `hybrid` |
| limit   | integer | no       | 10        | Maximum number of results                     |
| filters | object  | no       | omitted   | Structured filters                            |

Filter parameters use snake_case:

- `filters.path_prefix`: array of path prefixes.
- `filters.exclude_path_prefix`: array of path prefixes.
- `filters.tags`: array of include tags.
- `filters.exclude_tags`: array of exclude tags.
- `filters.frontmatter.type`: array of `type` values.
- `filters.frontmatter.status`: array of `status` values.

Example input:

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

## Validation

Phase 3 search validation continues to apply:

- `query` must be non-empty and at most 1,000 characters.
- `mode` must be `lexical`, `embedding`, or `hybrid` when supplied.
- `limit` must be an integer from 1 to 50.

Filter validation follows the core specification:

- `filters` must be an object when supplied.
- Unknown filter fields are invalid.
- Filter arrays must be non-empty when supplied.
- Path filters must be valid vault-relative prefixes.
- Tag values must be valid non-empty strings.
- Frontmatter fields must be `type` or `status`.
- Frontmatter values must be valid non-empty strings.
- `filters.frontmatter` must contain `type` and/or `status` when supplied.

Unlike Phase 3's original `search` parameter handling, unknown parameters inside `filters` are not ignored. They return `INVALID_FILTER` or `INVALID_FRONTMATTER_FILTER` so MCP clients do not assume an unsupported filter was applied.

## Response Structure

The MCP result object contains the same payload shape as `POST /search` response `data`, plus `warnings` at the result level per Phase 3 MCP convention.

Example result:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "requestedMode": "hybrid",
    "usedMode": "hybrid",
    "limit": 10,
    "results": [],
    "warnings": []
  }
}
```

Search results remain compact and use the Phase 1 result item shape. The MCP result must not include note bodies, chunk bodies, raw filter echoes, arbitrary frontmatter values, private absolute paths, or raw queries.

## Error Handling

MCP tool errors use JSON-RPC error responses with application error codes in `error.data.errorCode`.

Filter-specific errors:

| Application Error Code       | JSON-RPC Code | Condition                                                     |
| ---------------------------- | ------------- | ------------------------------------------------------------- |
| `INVALID_FILTER`             | `-32000`      | Unknown filter field or invalid filter object shape.          |
| `INVALID_PATH_FILTER`        | `-32000`      | Invalid path prefix, absolute path, traversal, or empty path. |
| `INVALID_TAG_FILTER`         | `-32000`      | Invalid or empty tag value.                                   |
| `INVALID_FRONTMATTER_FILTER` | `-32000`      | Unknown frontmatter field or invalid value.                   |

Existing Phase 3 search errors continue to apply:

- `INVALID_QUERY`
- `INVALID_MODE`
- `INVALID_LIMIT`
- `INDEX_NOT_FOUND`
- `INDEX_INCOMPATIBLE`
- `EMBEDDING_UNAVAILABLE`
- `VAULT_NOT_CONFIGURED`

Example error:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32000,
    "message": "Frontmatter filters support only type and status.",
    "data": {
      "errorCode": "INVALID_FRONTMATTER_FILTER"
    }
  }
}
```

Error messages and data must not include raw queries, raw request bodies, private absolute paths, note content, chunk content, secrets, or provider credentials.

## Tool Annotations

The `search` tool remains read-only and non-destructive:

- `readOnlyHint: true`
- `destructiveHint: false`
- `idempotentHint: true`

Search results may vary as the index changes, so clients should not treat `idempotentHint: true` as indefinite cache permission.
