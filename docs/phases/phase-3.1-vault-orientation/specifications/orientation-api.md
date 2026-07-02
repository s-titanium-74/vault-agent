# Phase 3.1 Orientation API Specification

Status: Draft

This file is part of the Phase 3.1 specification. See ../requirements.md for requirements and this directory for the domain specifications.

## HTTP Endpoints

All orientation endpoints use `GET` and are read-only.

| Endpoint                                          | Description                                             |
| ------------------------------------------------- | ------------------------------------------------------- |
| `GET /overview`                                   | Compact vault-level metadata                            |
| `GET /tree?depth=<n>&limit=<n>&directOnly=<bool>` | Bounded directory tree                                  |
| `GET /tags?limit=<n>`                             | Tag names and note-level counts                         |
| `GET /facets?limit=<n>`                           | Frontmatter field names, counts, and allowlisted values |

## Base URL

Orientation endpoints are served on the configured server host and port, consistent with Phase 1 endpoints.

Default: `http://127.0.0.1:8787`

## Access Control

Orientation endpoints follow Phase 1 server access control:

- Localhost binds may run without an API key.
- Non-localhost binds require API key authentication via `Authorization: Bearer <api-key>`.
- API keys must not be accepted in query parameters.
- Failed authentication must not reveal expected keys or private config paths.
- Authentication failures return `401` with `UNAUTHORIZED`, consistent with the server's global authentication hook.

## CORS

CORS follows Phase 1 CORS policy:

- Disabled by default.
- May be enabled only by explicit configuration with explicit allowed origins.
- Wildcard origins are not allowed in Phase 3.1.

## Response Envelope

Orientation responses use the Phase 1 JSON envelope:

```json
{
  "data": { ... },
  "warnings": []
}
```

`data` contains the surface-specific result. `data` must not contain a `warnings` field. `warnings` is a top-level array containing warning objects with at least `code` and `message` fields.

Example:

```json
{
  "data": {
    "noteCount": 1240,
    "chunkCount": 3920,
    "topLevelFolders": [],
    "topTags": [],
    "frontmatterFields": [],
    "indexFreshness": "fresh"
  },
  "warnings": []
}
```

## GET /overview

Returns compact vault-level metadata.

### Request

```text
GET /overview
```

No query parameters.

### Success Response

HTTP `200`.

`data` fields:

- `noteCount`: integer.
- `chunkCount`: integer.
- `topLevelFolders`: array of `{ path, noteCount }`, max 20.
- `topTags`: array of `{ tag, noteCount }`, max 50.
- `frontmatterFields`: array of `{ name, noteCount }`, max 50.
- `indexFreshness`: string from Phase 2 enum.

`warnings` is returned only at the envelope level, not inside `data`.

### Example Response

```json
{
  "data": {
    "noteCount": 1240,
    "chunkCount": 3920,
    "topLevelFolders": [
      { "path": "Projects", "noteCount": 320 },
      { "path": "Areas", "noteCount": 180 }
    ],
    "topTags": [
      { "tag": "meeting", "noteCount": 84 },
      { "tag": "idea", "noteCount": 62 }
    ],
    "frontmatterFields": [
      { "name": "type", "noteCount": 400 },
      { "name": "status", "noteCount": 130 }
    ],
    "indexFreshness": "fresh"
  },
  "warnings": []
}
```

## GET /tree

Returns a bounded directory tree.

### Request

```text
GET /tree?depth=2&limit=50&directOnly=false
```

Query parameters:

- `depth`: integer, 1–10. Default: 2.
- `limit`: integer, 1–500. Default: 50.
- `directOnly`: boolean. Default: false.

Boolean query parameter parsing:

- Accepted string values: `true`, `false`.
- Values are case-sensitive and must be lowercase.
- Missing value (`GET /tree?directOnly`) is treated as `true`.
- Invalid boolean values return `400` with `INVALID_PARAMETER`.

Invalid parameter values return `400` with `INVALID_PARAMETER`.

Unknown query parameters are ignored, consistent with Phase 3 MCP tool behavior.

### Success Response

HTTP `200`.

`data` fields:

- `tree`: folder node object.
- `indexFreshness`: string.

`warnings` is returned only at the envelope level.

Folder node fields:

- `path`: vault-relative folder path. Root is `""`.
- `noteCount`: integer.
- `childFolders`: integer.
- `children`: array of folder nodes.

### Example Response

```json
{
  "data": {
    "tree": {
      "path": "",
      "noteCount": 1240,
      "childFolders": 5,
      "children": [
        {
          "path": "Projects",
          "noteCount": 320,
          "childFolders": 3,
          "children": []
        }
      ]
    },
    "indexFreshness": "fresh"
  },
  "warnings": []
}
```

### Truncation

When tree nodes are omitted due to `limit`, the response includes a `TREE_LIMIT_EXCEEDED` warning.

## GET /tags

Returns tag names and note-level counts.

### Request

```text
GET /tags?limit=50
```

Query parameters:

- `limit`: integer, 1–200. Default: 50.

### Success Response

HTTP `200`.

`data` fields:

- `tags`: array of `{ tag, noteCount }`.
- `indexFreshness`: string.

`warnings` is returned only at the envelope level.

### Example Response

```json
{
  "data": {
    "tags": [
      { "tag": "meeting", "noteCount": 84 },
      { "tag": "idea", "noteCount": 62 }
    ],
    "indexFreshness": "fresh"
  },
  "warnings": []
}
```

## GET /facets

Returns frontmatter field names, counts, and allowlisted field values.

### Request

```text
GET /facets?limit=50
```

Query parameters:

- `limit`: integer, 1–200. Default: 50.

### Success Response

HTTP `200`.

`data` fields:

- `fields`: array of field objects.
- `indexFreshness`: string.

`warnings` is returned only at the envelope level.

Field object fields:

- `name`: string.
- `noteCount`: integer.
- `values`: optional array of `{ value, noteCount }`, present only for allowlisted fields (`type`, `status`).

### Example Response

```json
{
  "data": {
    "fields": [
      {
        "name": "type",
        "noteCount": 400,
        "values": [
          { "value": "project", "noteCount": 250 },
          { "value": "area", "noteCount": 150 }
        ]
      }
    ],
    "indexFreshness": "fresh"
  },
  "warnings": []
}
```

## Error Responses

Orientation errors use the Phase 1 JSON error envelope:

```json
{
  "error": {
    "code": "INDEX_NOT_FOUND",
    "message": "No usable index found. Run `vault-agent index` or `vault-agent reindex`."
  }
}
```

### Error Codes and HTTP Statuses

| Error Code             | HTTP Status | Description                                                                   |
| ---------------------- | ----------- | ----------------------------------------------------------------------------- |
| `INDEX_NOT_FOUND`      | `409`       | No usable index exists.                                                       |
| `INDEX_INCOMPATIBLE`   | `409`       | Index is incompatible; reindex required.                                      |
| `INVALID_PARAMETER`    | `400`       | Query parameter value is invalid (including out-of-range orientation limits). |
| `SERVER_UNAVAILABLE`   | `503`       | Server is temporarily unavailable (e.g., index locked).                       |
| `AUTH_REQUIRED`        | `401`       | Missing API key for non-localhost access.                                     |
| `AUTH_FAILED`          | `403`       | Invalid API key for non-localhost access.                                     |
| `VAULT_NOT_CONFIGURED` | `503`       | No vault root is configured.                                                  |

`AUTH_REQUIRED` and `AUTH_FAILED` reuse the Phase 3 error code names for authentication failures.

Orientation endpoints use `INVALID_PARAMETER` for all limit range errors. Phase 1's `INVALID_LIMIT` applies only to search and related result limits.

Error messages must be actionable and must not include private absolute paths, note content, chunk content, raw queries, or secrets.

## Freshness Warnings

When the index is not `fresh`, the response `warnings` array includes an entry:

```json
{
  "code": "INDEX_STALE",
  "message": "Index may be outdated. Run `vault-agent index` to refresh."
}
```

Warning codes:

- `INDEX_STALE`
- `INDEX_PENDING`
- `INDEX_UPDATING`
- `INDEX_UNKNOWN`
- `TOP_LEVEL_FOLDERS_TRUNCATED`
- `TOP_TAGS_TRUNCATED`
- `FRONTMATTER_FIELDS_TRUNCATED`
- `TREE_LIMIT_EXCEEDED`

`INDEX_INCOMPATIBLE` is an error, not a warning, because the index cannot be used.
