# Phase 3.1 MCP Tools Specification

Status: Draft

This file is part of the Phase 3.1 specification. See ../requirements.md for requirements and this directory for the domain specifications.

## Tool Scope

Phase 3.1 adds four orientation MCP tools through the Phase 3 MCP bridge. These tools expose the same data as the orientation HTTP endpoints.

Tools are available on both stdio and Streamable HTTP transports, consistent with Phase 3 MCP bridge behavior.

## Tool Naming

Orientation tools use the `vault_` prefix to namespace them separately from Phase 3 retrieval tools (`search`, `get_note`, `get_chunk`, `get_attachment`, `related`).

| Tool             | HTTP Equivalent |
| ---------------- | --------------- |
| `vault_overview` | `GET /overview` |
| `vault_tree`     | `GET /tree`     |
| `vault_tags`     | `GET /tags`     |
| `vault_facets`   | `GET /facets`   |

## Tool Annotations

All orientation MCP tools declare the same annotations as Phase 3 retrieval tools:

- `readOnlyHint: true`
- `destructiveHint: false`
- `idempotentHint: true`

## Parameter Naming

MCP tool parameters use snake_case to align with Phase 3 MCP tool conventions:

- `depth`
- `limit`
- `direct_only`

## Tool Definitions

### `vault_overview`

Description: "Get compact vault-level metadata: note count, chunk count, top folders, top tags, frontmatter fields, and index freshness."

Parameters: none.

Returns: same inner payload as `GET /overview` response `data`.

### `vault_tree`

Description: "Get a bounded directory tree of the vault with note counts per folder. Use depth, limit, and direct_only to control response size."

Parameters:

- `depth` (integer, optional): maximum folder depth. Default: 2, minimum: 1, maximum: 10.
- `limit` (integer, optional): maximum tree nodes. Default: 50, minimum: 1, maximum: 500.
- `direct_only` (boolean, optional): when true, note counts reflect only notes directly in each folder. Default: false.

Returns: same inner payload as `GET /tree` response `data`.

### `vault_tags`

Description: "Get tag names and note-level usage counts from frontmatter tags."

Parameters:

- `limit` (integer, optional): maximum tags. Default: 50, minimum: 1, maximum: 200.

Returns: same inner payload as `GET /tags` response `data`.

### `vault_facets`

Description: "Get frontmatter field names and note counts. Values are included only for allowlisted fields (type, status)."

Parameters:

- `limit` (integer, optional): maximum fields. Default: 50, minimum: 1, maximum: 200.

Returns: same inner payload as `GET /facets` response `data`.

## Response Structure

MCP tool results follow the Phase 3 MCP response structure. The `result` object contains the same inner payload as the corresponding HTTP response `data` field, with the envelope `warnings` array merged at the top level of the `result` object.

The data payload must not contain a `warnings` field. `warnings` appears only at the `result` level.

Example successful result for `vault_overview`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "noteCount": 1240,
    "chunkCount": 3920,
    "topLevelFolders": [{ "path": "Projects", "noteCount": 320 }],
    "topTags": [{ "tag": "meeting", "noteCount": 84 }],
    "frontmatterFields": [{ "name": "type", "noteCount": 400 }],
    "indexFreshness": "fresh",
    "warnings": []
  }
}
```

This matches the Phase 3 MCP convention where the `result` object is structurally compatible with the HTTP API inner payload.

### Freshness Field Name

Phase 3.1 orientation MCP tools use `indexFreshness` in the `result` payload, matching the Phase 3.1 HTTP API and Phase 2's sync/pull response. Phase 2's `GET /status` response uses `data.index.freshness`. Phase 3 retrieval tools (`search`, `get_note`, etc.) currently use `freshness` as the field name. This is a known cross-phase inconsistency; Phase 3 retrieval tools should migrate to `indexFreshness` in a future phase to align with Phase 2 sync/pull and Phase 3.1.

## Error Handling

MCP tool errors use JSON-RPC error responses with Phase 1 application error codes, following the same mapping as Phase 3 MCP tools. See Phase 3 [MCP Tools](../../../phase-3-mcp-bridge/specifications/mcp-tools.md#error-code-mapping) for the complete JSON-RPC error code mapping table.

Orientation-specific application errors:

| Error Code             | JSON-RPC Code | Description                                                             |
| ---------------------- | ------------- | ----------------------------------------------------------------------- |
| `INDEX_NOT_FOUND`      | `-32001`      | No usable index exists.                                                 |
| `INDEX_INCOMPATIBLE`   | `-32002`      | Index is incompatible; reindex required.                                |
| `INVALID_PARAMETER`    | `-32000`      | Parameter value is invalid (including out-of-range orientation limits). |
| `SERVER_UNAVAILABLE`   | `-32014`      | Server or core is temporarily unavailable.                              |
| `VAULT_NOT_CONFIGURED` | `-32013`      | No vault root is configured.                                            |

Orientation endpoints use `INVALID_PARAMETER` for all limit range errors. Phase 1's `INVALID_LIMIT` applies only to search and related result limits.

The JSON-RPC codes for `INDEX_NOT_FOUND`, `INDEX_INCOMPATIBLE`, `INVALID_PARAMETER`, and `VAULT_NOT_CONFIGURED` match the Phase 3 MCP error code mapping. `SERVER_UNAVAILABLE` uses a new `-32014` code because it is not present in the Phase 3 mapping table.

Error messages must be actionable and sanitized. They must not include private absolute paths, note content, chunk content, raw queries, or secrets.

Example error response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32001,
    "message": "No usable index found. Run vault-agent index to build one.",
    "data": {
      "errorCode": "INDEX_NOT_FOUND"
    }
  }
}
```

## Freshness Warnings

Orientation MCP tool results include Phase 2 freshness warnings in the top-level `warnings` array when the index is not `fresh`.

Example warning:

```json
{
  "code": "INDEX_STALE",
  "message": "Index may be outdated. Run `vault-agent index` to refresh."
}
```
