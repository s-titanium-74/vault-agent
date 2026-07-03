# Phase 3.2 Search Filters API Specification

Status: Draft

This file is part of the Phase 3.2 specification. See ../requirements.md for requirements and this directory for the core, CLI, MCP, and testing specifications.

## Endpoint

Phase 3.2 extends the existing Phase 1 endpoint:

```text
POST /search
```

The endpoint remains read-only and returns deterministic search results only.

## Request Body

`POST /search` accepts the Phase 1 request body plus optional `filters`.

```json
{
  "query": "local embedding privacy",
  "mode": "hybrid",
  "limit": 10,
  "filters": {
    "pathPrefix": ["Projects"],
    "excludePathPrefix": ["Archive"],
    "tags": ["privacy"],
    "excludeTags": ["archive"],
    "frontmatter": {
      "type": ["note"],
      "status": ["active"]
    }
  }
}
```

Fields:

- `query`: required non-empty string, maximum 1,000 characters.
- `mode`: optional search mode, one of `lexical`, `embedding`, `hybrid`.
- `limit`: optional integer from 1 to 50, default 10.
- `filters`: optional object.

Filter fields:

- `filters.pathPrefix`: optional non-empty array of path prefixes.
- `filters.excludePathPrefix`: optional non-empty array of path prefixes.
- `filters.tags`: optional non-empty array of tags.
- `filters.excludeTags`: optional non-empty array of tags.
- `filters.frontmatter`: optional object containing `type` and/or `status`.
- `filters.frontmatter.type`: optional non-empty array of values.
- `filters.frontmatter.status`: optional non-empty array of values.

HTTP field names use camelCase. Unknown fields inside `filters` or `filters.frontmatter` are invalid.

## Validation

All Phase 1 search validation continues to apply.

Additional validation:

- `filters` must be an object when supplied.
- Unknown filter names return `400` with `INVALID_FILTER`.
- Filter arrays must contain at least one value when supplied.
- Filter array values must be strings.
- Invalid path filter values return `400` with `INVALID_PATH_FILTER`.
- Invalid tag filter values return `400` with `INVALID_TAG_FILTER`.
- Unknown or invalid frontmatter filters return `400` with `INVALID_FRONTMATTER_FILTER`.
- `filters.frontmatter` must contain `type` and/or `status` when supplied.

Path values reject absolute paths, traversal, empty strings, URL-like schemes, and segment shapes that cannot be interpreted as vault-relative prefixes.

Tag values reject empty strings after trimming and optional leading `#` stripping.

Frontmatter values reject empty strings after trimming. Only `type` and `status` are accepted.

## Response

Successful responses use the existing Phase 1 envelope and search data shape.

```json
{
  "data": {
    "requestedMode": "hybrid",
    "usedMode": "hybrid",
    "limit": 10,
    "results": []
  },
  "warnings": []
}
```

Search result items use the Phase 1 result shape. Phase 3.2 does not add note bodies, chunk bodies, raw filter echoes, or arbitrary frontmatter values to result items.

Warnings appear only at the response envelope level. Phase 2 freshness and embedding fallback warnings continue to apply.

## Filter Semantics

Filter semantics are defined in [Search Filters Core](search-filters-core.md).

Summary:

- Multiple path prefixes use OR semantics.
- Multiple include tags use OR semantics.
- Multiple exclude tags use OR semantics.
- Multiple values for one frontmatter field use OR semantics.
- Different include filter types use AND semantics.
- Include filters apply before exclude filters.
- Filters apply to parent note metadata for chunk results.
- Filters apply before result limiting.

## Errors

HTTP status mapping:

| Error Code                   | HTTP Status | Condition                                                     |
| ---------------------------- | ----------- | ------------------------------------------------------------- |
| `INVALID_FILTER`             | `400`       | Unknown filter field or invalid filter object shape.          |
| `INVALID_PATH_FILTER`        | `400`       | Invalid path prefix, absolute path, traversal, or empty path. |
| `INVALID_TAG_FILTER`         | `400`       | Invalid or empty tag value.                                   |
| `INVALID_FRONTMATTER_FILTER` | `400`       | Unknown frontmatter field or invalid value.                   |
| `INVALID_QUERY`              | `400`       | Existing Phase 1 query validation failure.                    |
| `INVALID_MODE`               | `400`       | Existing Phase 1 mode validation failure.                     |
| `INVALID_LIMIT`              | `400`       | Existing Phase 1 limit validation failure.                    |
| `INDEX_NOT_FOUND`            | `409`       | No usable index exists.                                       |
| `INDEX_INCOMPATIBLE`         | `409`       | Index cannot support the requested search safely.             |
| `EMBEDDING_UNAVAILABLE`      | `503`       | Embedding-only search requested but unavailable.              |

Error response shape follows Phase 1:

```json
{
  "error": {
    "code": "INVALID_PATH_FILTER",
    "message": "Invalid path filter.",
    "details": {
      "field": "filters.pathPrefix"
    }
  }
}
```

Error details may identify the field and concise reason. They must not echo raw request bodies, raw queries, private absolute paths, note content, chunk content, secrets, or provider credentials.

## Access Control And CORS

`POST /search` keeps Phase 1 server access control:

- Localhost binds may run without an API key.
- Non-localhost binds require API key authentication.
- API keys use `Authorization: Bearer <api-key>`.
- API keys are not accepted in query parameters.

CORS behavior is unchanged from Phase 1.

## Compatibility

Unfiltered requests remain backward-compatible with Phase 1.

If an older index cannot support structured filters, filtered requests fail with an actionable index error. Unfiltered lexical search may continue when the index is otherwise usable.
