# MCP Tools Specification

Status: Ready for Review

## Overview

This specification defines the MCP tools exposed by `vault-agent` in Phase 3.

The server implementation may use the official `@modelcontextprotocol/sdk` or
an equivalent library that correctly implements MCP protocol version
`2025-03-26`. Tool behavior, response schemas, and error handling are defined
here independently of the chosen SDK.

## Response Wrapper

MCP tool results use the JSON-RPC 2.0 result structure. The `result` field
contains the same payload shape as the corresponding Phase 1 HTTP response
`data` field, plus the HTTP response envelope `warnings` array placed at the
`result.warnings` level.

The HTTP response envelope (`data`/`warnings` or `error`) is not nested inside
the MCP result; only the inner `data` payload is returned, with the envelope's
`warnings` array merged at the top level of the result object.

Successful tool result:

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

Error tool result:

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

Phase 2 freshness warnings are carried in the `result.warnings` array using the
same warning object schema as the Phase 1/2 HTTP response envelope. When the
index is fresh and no warnings exist, `warnings` is an empty array.

MCP-specific extension fields are not used in Phase 3 unless a future phase adds
them explicitly. If a future phase adds extension fields, they must use a
namespaced prefix (e.g., `_mcp_`) and must not override or shadow HTTP API
field names.

The result payload is structurally compatible with the HTTP API inner payload:
same field names, types, defaults, and error codes. It is not required to be
byte-for-byte identical in JSON serialization.

## Tool Definitions

All Phase 3 tools return `VAULT_NOT_CONFIGURED` when no vault root is
configured. The per-tool error tables below list errors specific to that tool
in addition to the shared `VAULT_NOT_CONFIGURED` and shared validation errors.

Indexing and reindexing are intentionally **not** exposed as MCP tools in
Phase 3. These are administrative operations performed through the CLI or HTTP
API. The MCP troubleshooting guide explains how to trigger indexing outside
MCP when the index is missing or incompatible.

### search

Search the vault with lexical, embedding, or hybrid mode.

**Description:**
"Search the vault for notes matching a query. Returns compact ranked results
with titles, paths, snippets, and scores. Use this first to find relevant
candidates before retrieving full note content."

**Parameters:**

| Name  | Type    | Required | Default   | Description                                   |
| ----- | ------- | -------- | --------- | --------------------------------------------- |
| query | string  | yes      | -         | Search query text                             |
| mode  | string  | no       | (omitted) | Search mode: `lexical`, `embedding`, `hybrid` |
| limit | integer | no       | 10        | Maximum number of results                     |

**Validation:**

- `query` must be a non-empty, non-whitespace-only string.
- Maximum `query` length: 1,000 characters.
- `mode` must be one of `lexical`, `embedding`, `hybrid` when provided.
- If `mode` is omitted, the server chooses the default mode based on embedding
  availability: `hybrid` when embeddings are available, otherwise `lexical`.
- If embeddings are configured but unavailable and `mode` is omitted, search
  falls back to `lexical` with an `EMBEDDING_UNAVAILABLE` warning.
- `limit` must be an integer between 1 and 50 inclusive.
- Unknown parameters are ignored.

**Errors:**

| Error Code              | Condition                                                          |
| ----------------------- | ------------------------------------------------------------------ |
| `INVALID_QUERY`         | Empty or whitespace-only query, or query exceeds 1,000 characters. |
| `INVALID_MODE`          | `mode` is not one of the allowed values.                           |
| `INVALID_LIMIT`         | `limit` is outside 1 through 50.                                   |
| `INDEX_NOT_FOUND`       | No usable index exists.                                            |
| `INDEX_INCOMPATIBLE`    | Index is incompatible and must be rebuilt.                         |
| `EMBEDDING_UNAVAILABLE` | `mode` is `embedding` and embeddings are unavailable.              |

**Response:**

Same inner payload structure as `POST /search` response in Phase 1 server API.

Example result payload:

```json
{
  "requestedMode": "hybrid",
  "usedMode": "hybrid",
  "limit": 10,
  "freshness": "fresh",
  "results": [
    {
      "id": "note-id:0",
      "type": "chunk",
      "noteId": "note-id",
      "chunkIndex": 0,
      "path": "Folder/Note.md",
      "title": "Note title",
      "heading": "Heading",
      "headingPath": ["Parent", "Heading"],
      "snippet": "Short snippet...",
      "score": 0.123,
      "reason": "hybrid_match",
      "metadata": {
        "aliases": [],
        "tags": [],
        "date": null,
        "created": null,
        "updated": null,
        "attachmentCount": 0
      }
    }
  ],
  "warnings": []
}
```

### get_note

Retrieve a note by ID.

**Description:**
"Retrieve the full content of a note by its ID. Returns Markdown content
including frontmatter. Use search first to find relevant notes, then use this
to retrieve only the notes you need."

**Parameters:**

| Name       | Type    | Required | Default | Description                        |
| ---------- | ------- | -------- | ------- | ---------------------------------- |
| noteId     | string  | yes      | -       | Note ID to retrieve                |
| allowLarge | boolean | no       | false   | Allow retrieval of oversized notes |

**Validation:**

- `noteId` must be a non-empty string. A note ID is an opaque string that
  uniquely identifies a Markdown note within the vault. Empty strings are
  rejected; the exact encoding is an implementation detail.
- `allowLarge` must be a boolean when provided.
- Unknown parameters are ignored.

**Errors:**

| Error Code           | Condition                                    |
| -------------------- | -------------------------------------------- |
| `INVALID_ID`         | `noteId` is empty or malformed.              |
| `INVALID_PARAMETER`  | `allowLarge` is not a boolean when provided. |
| `NOTE_NOT_FOUND`     | Note ID does not exist.                      |
| `QUERY_TOO_LARGE`    | Note exceeds 200 KiB and `allowLarge=false`. |
| `PATH_OUTSIDE_VAULT` | Resolved path is outside the vault root.     |

**Response:**

Same inner payload structure as `GET /notes/{noteId}` response in Phase 1
server API.

Example result payload:

```json
{
  "id": "note-id",
  "path": "Folder/Note.md",
  "title": "Note title",
  "metadata": {
    "aliases": [],
    "tags": [],
    "date": null,
    "created": null,
    "updated": null
  },
  "content": "---\ntitle: Note title\n---\n\nMarkdown content",
  "contentType": "text/markdown; charset=utf-8",
  "size": 1234,
  "freshness": "fresh",
  "warnings": []
}
```

When available, `links` and `attachments` summaries are included in the same
shape as the Phase 1 HTTP API. When no link or attachment data is present,
the fields are omitted.

When the index is in an incompatible state, `get_note` follows Phase 2
safe-resolution rules: it may be allowed only when the note ID can be resolved
safely without relying on the incompatible index.

### get_chunk

Retrieve a chunk by note ID and chunk index.

**Description:**
"Retrieve a specific chunk from a note. Chunks are sections of a note split
by headings. Use this when you need only a portion of a note rather than the
full content."

**Parameters:**

| Name       | Type    | Required | Default | Description                 |
| ---------- | ------- | -------- | ------- | --------------------------- |
| noteId     | string  | yes      | -       | Note ID                     |
| chunkIndex | integer | yes      | -       | Chunk index within the note |

**Validation:**

- `noteId` must be a non-empty string. A note ID is an opaque string that
  uniquely identifies a Markdown note within the vault. Empty strings are
  rejected; the exact encoding is an implementation detail.
- `chunkIndex` must be a non-negative integer.
- Unknown parameters are ignored.

**Errors:**

| Error Code           | Condition                                   |
| -------------------- | ------------------------------------------- |
| `INVALID_ID`         | `noteId` is empty or malformed.             |
| `INVALID_ID`         | `chunkIndex` is negative or not an integer. |
| `NOTE_NOT_FOUND`     | Note ID does not exist.                     |
| `CHUNK_NOT_FOUND`    | Chunk index does not exist for the note.    |
| `PATH_OUTSIDE_VAULT` | Resolved path is outside the vault root.    |

**Response:**

Same inner payload structure as `GET /chunks/{noteId}/{chunkIndex}` response
in Phase 1 server API.

Example result payload:

```json
{
  "id": "note-id:0",
  "noteId": "note-id",
  "chunkIndex": 0,
  "path": "Folder/Note.md",
  "title": "Note title",
  "heading": "Heading",
  "headingPath": ["Parent", "Heading"],
  "metadata": {
    "aliases": [],
    "tags": [],
    "date": null,
    "created": null,
    "updated": null
  },
  "content": "Chunk Markdown content",
  "contentType": "text/markdown; charset=utf-8",
  "size": 1234,
  "freshness": "fresh",
  "warnings": []
}
```

When available, `links` and `attachments` summaries for references contained in
that chunk are included in the same shape as the Phase 1 HTTP API. When no link
or attachment data is present, the fields are omitted.

When the index is in an incompatible state, `get_chunk` follows Phase 2
safe-resolution rules: it may be allowed only when the note and chunk can be
resolved safely without relying on the incompatible index.

### get_attachment

Retrieve attachment metadata or download bytes.

**Description:**
"Retrieve metadata about an attachment file, or download its contents. By
default returns only metadata (name, size, MIME type). Set download=true to
get the file content as base64-encoded data."

**Parameters:**

| Name              | Type    | Required | Default | Description                             |
| ----------------- | ------- | -------- | ------- | --------------------------------------- |
| vaultRelativePath | string  | yes      | -       | Vault-relative path to the attachment   |
| download          | boolean | no       | false   | Download file bytes instead of metadata |
| allowLarge        | boolean | no       | false   | Allow download of oversized files       |

**Validation:**

- `vaultRelativePath` must be a non-empty string representing a vault-relative
  path.
- `vaultRelativePath` must not contain path traversal (`..`) or null bytes.
- `download` must be a boolean when provided.
- `allowLarge` must be a boolean when provided.
- Unknown parameters are ignored.

**Errors:**

| Error Code               | Condition                                                                       |
| ------------------------ | ------------------------------------------------------------------------------- |
| `INVALID_PATH`           | Path is empty, contains traversal, or is otherwise malformed.                   |
| `INVALID_PARAMETER`      | `download` or `allowLarge` is not a boolean when provided.                      |
| `PATH_OUTSIDE_VAULT`     | Resolved path is outside the vault root.                                        |
| `ATTACHMENT_NOT_ALLOWED` | Path points to a Markdown note, hidden file, excluded path, or disallowed file. |
| `ATTACHMENT_NOT_FOUND`   | Attachment does not exist.                                                      |
| `QUERY_TOO_LARGE`        | Attachment exceeds 10 MiB and `allowLarge=false` when `download=true`.          |

**Response (metadata):**

Same inner payload structure as `GET /attachments/{*vaultRelativePath}`
metadata response in Phase 1 server API.

Example metadata result payload:

```json
{
  "path": "attachments/file.pdf",
  "fileName": "file.pdf",
  "contentType": "application/pdf",
  "size": 12345,
  "downloadAvailable": true,
  "warnings": []
}
```

**Response (download):**

When `download=true`, the response includes the following fields in addition to
metadata fields:

```json
{
  "path": "attachments/file.pdf",
  "fileName": "file.pdf",
  "contentType": "application/pdf",
  "size": 12345,
  "downloadAvailable": true,
  "content": "base64-encoded-bytes",
  "encoding": "base64",
  "warnings": []
}
```

- `content`: Base64-encoded file bytes.
- `contentType`: MIME type of the file (when detectable), matching Phase 1
  attachment metadata.
- `encoding`: `"base64"`.

The default attachment download size limit is 10 MiB. Requests for larger
files fail with `QUERY_TOO_LARGE` unless `allowLarge=true` is set. Even with
`allowLarge=true`, attachment downloads that would cause the total MCP tool
result payload to exceed 50 MiB fail with `QUERY_TOO_LARGE`. For very large
attachments, use the HTTP API (`GET /attachments/{path}?download=true`) instead
of the MCP `get_attachment` tool.

### related

Find related candidates from a known note or chunk.

**Description:**
"Find notes and chunks that are related to a given note or chunk. Returns
compact candidates with titles, paths, snippets, and scores. Use this to
discover nearby content after reading a note."

**Parameters:**

| Name  | Type    | Required | Default   | Description                                      |
| ----- | ------- | -------- | --------- | ------------------------------------------------ |
| type  | string  | yes      | -         | Type of input: `"note"` or `"chunk"`             |
| id    | string  | yes      | -         | Note ID or chunk ID                              |
| limit | integer | no       | 10        | Maximum number of results                        |
| mode  | string  | no       | (omitted) | Retrieval mode: `lexical`, `embedding`, `hybrid` |

**Validation:**

- `type` must be one of `note` or `chunk`.
- `id` must be a non-empty string matching the expected format for `type`.
  - For `type: "note"`, `id` is a note ID.
  - For `type: "chunk"`, `id` is in the form `note-id:chunkIndex`.
  - A note ID is an opaque string that uniquely identifies a Markdown note
    within the vault. Empty strings are rejected; the exact encoding is an
    implementation detail.
- `mode` must be one of `lexical`, `embedding`, `hybrid` when provided.
- If `mode` is omitted, `related` defaults to `embedding` when embeddings are
  configured and available. If embeddings are not configured, it defaults to
  `lexical` without a warning. If embeddings are configured but unavailable,
  it falls back to `lexical` with an `EMBEDDING_UNAVAILABLE` warning.
- `limit` must be an integer between 1 and 50 inclusive.
- Unknown parameters are ignored.

**Errors:**

| Error Code              | Condition                                             |
| ----------------------- | ----------------------------------------------------- |
| `INVALID_TYPE`          | `type` is not `note` or `chunk`.                      |
| `INVALID_ID`            | `id` is empty or does not match the expected format.  |
| `INVALID_MODE`          | `mode` is not one of the allowed values.              |
| `INVALID_LIMIT`         | `limit` is outside 1 through 50.                      |
| `NOTE_NOT_FOUND`        | Input note does not exist.                            |
| `CHUNK_NOT_FOUND`       | Input chunk does not exist.                           |
| `INDEX_NOT_FOUND`       | No usable index exists.                               |
| `INDEX_INCOMPATIBLE`    | Index is incompatible and must be rebuilt.            |
| `EMBEDDING_UNAVAILABLE` | `mode` is `embedding` and embeddings are unavailable. |

**Response:**

Same inner payload structure as `POST /related` response in Phase 1 server
API.

Example result payload:

```json
{
  "input": {
    "type": "chunk",
    "id": "note-id:0"
  },
  "requestedMode": "embedding",
  "usedMode": "embedding",
  "limit": 10,
  "freshness": "fresh",
  "results": [],
  "warnings": []
}
```

## Tool Annotations

All Phase 3 MCP tools declare the following annotations:

- `readOnlyHint: true` — Tool does not modify any data.
- `destructiveHint: false` — Tool does not destroy or overwrite data.
- `idempotentHint: true` — Repeated calls with same parameters return the same
  results in intent.

Note: `search` and `related` are idempotent in intent, but results may vary if
the index state changes between calls. MCP clients should not rely on
`idempotentHint: true` to cache results indefinitely for these tools.

## Shared Enforcement

MCP tools must call shared core functions for path validation, error
sanitization, and logging rather than reimplementing these checks in the MCP
adapter. The HTTP server and the MCP adapter must share the same enforcement
logic to prevent divergence over time.

Specifically:

- Path safety checks (vault-root resolution, traversal detection, excluded
  paths) must be performed by shared core utilities.
- Error sanitization (removal of private paths, note content, chunks, raw
  queries, secrets) must use shared sanitization helpers.
- Logging must use the same structured logger and data-minimization rules as
  the HTTP server.
- Response formatting for tool results must reuse the same serializers as the
  HTTP API.

MCP tool errors follow the same rules as HTTP API errors:

- Error responses must not include raw note content, raw chunks, raw queries,
  secrets, provider credentials, or private absolute paths.
- Error messages must be actionable and help the user resolve the issue.
- Invalid parameters return descriptive error messages.

Invalid or malformed tool invocations:

- Calls to non-existent tools return JSON-RPC `MethodNotFound` (`-32601`).
- Missing required parameters return JSON-RPC `InvalidParams` (`-32602`).
- Parameters with wrong types return JSON-RPC `InvalidParams` (`-32602`).
- Unknown parameters are ignored and do not cause errors.
- Invalid enum values (e.g., invalid `mode`) return application errors
  (`INVALID_MODE`) rather than JSON-RPC `InvalidParams`.

Application errors use JSON-RPC error responses with custom codes in the
`-32000` range and include the Phase 1 error code in `data.errorCode`.

## Error Code Mapping

MCP tool errors map Phase 1 HTTP error codes to JSON-RPC error responses:

### Tool-Level Application Errors

| Phase 1 Error Code       | HTTP Status | MCP Error Code | Description                            |
| ------------------------ | ----------- | -------------- | -------------------------------------- |
| `INDEX_NOT_FOUND`        | 404         | -32001         | No usable index exists                 |
| `INDEX_INCOMPATIBLE`     | 409         | -32002         | Index requires reindexing              |
| `PATH_OUTSIDE_VAULT`     | 400         | -32003         | Path resolves outside vault root       |
| `NOTE_NOT_FOUND`         | 404         | -32004         | Note ID not found                      |
| `CHUNK_NOT_FOUND`        | 404         | -32005         | Chunk not found                        |
| `ATTACHMENT_NOT_FOUND`   | 404         | -32006         | Attachment not found                   |
| `EMBEDDING_UNAVAILABLE`  | 503         | -32007         | Embedding provider unavailable         |
| `QUERY_TOO_LARGE`        | 413         | -32008         | Request exceeds size limit             |
| `ATTACHMENT_NOT_ALLOWED` | 403         | -32009         | Path points to a disallowed attachment |
| `INTERNAL_ERROR`         | 500         | -32011         | Internal server error                  |
| `TIMEOUT`                | 504         | -32012         | Tool invocation timed out              |
| `VAULT_NOT_CONFIGURED`   | 503         | -32013         | No vault root is configured            |

### Validation Errors

Validation errors use JSON-RPC code `-32000` with the specific Phase 1 error
code in `data.errorCode`:

| Phase 1 Error Code  | Condition                                           |
| ------------------- | --------------------------------------------------- |
| `INVALID_QUERY`     | Empty, whitespace-only, or oversized query.         |
| `INVALID_MODE`      | `mode` is not one of the allowed values.            |
| `INVALID_LIMIT`     | `limit` is outside 1 through 50.                    |
| `INVALID_ID`        | `noteId`, `chunkIndex`, or `id` is malformed.       |
| `INVALID_TYPE`      | `type` is not `note` or `chunk`.                    |
| `INVALID_PATH`      | Attachment path is malformed or contains traversal. |
| `INVALID_PARAMETER` | Parameter has the wrong type.                       |

### Transport-Level Errors (Streamable HTTP)

| Phase 1 Error Code | HTTP Status | MCP Error Code | Description             |
| ------------------ | ----------- | -------------- | ----------------------- |
| `AUTH_REQUIRED`    | 401         | -32020         | Authentication required |
| `AUTH_FAILED`      | 403         | -32021         | Authentication failed   |

Authentication errors are returned by the Streamable HTTP transport layer
before the tool invocation is routed. They do not appear in stdio transport
responses because stdio transport does not use API key authentication.

MCP error responses include:

- `code`: JSON-RPC error code.
- `message`: Human-readable error description.
- `data.errorCode`: Phase 1 error code (e.g., `INDEX_NOT_FOUND`).
- `data.details`: Additional context (optional).

## Response Format

MCP tool responses use JSON format consistent with the HTTP API response
structure. The `result` payload is the same inner payload as the HTTP API
response `data` field. MCP-specific extension fields are not added in Phase 3.

If a future phase adds MCP-specific extension fields, they must use a
namespaced prefix (e.g., `_mcp_`) and must not override or shadow HTTP API
field names.

## Tool Invocation Timeouts

MCP tool invocations follow Phase 1 timeouts:

- Search, related, note retrieval, chunk retrieval, attachment metadata, and
  attachment download: 60 seconds.
- If a tool invocation exceeds its timeout, the server returns a JSON-RPC error:
  - `code`: `-32012`
  - `data.errorCode`: `TIMEOUT`
  - `message`: "Tool invocation timed out."

Long-running operations such as indexing and reindexing are not exposed as MCP
tools in Phase 3.

## Phase 2 Freshness Integration

MCP tool responses include Phase 2 index freshness information when available.

`freshness` uses the Phase 2 state names:

- `fresh`
- `pending`
- `updating`
- `stale`
- `incompatible`
- `unknown`

Behavior:

- Search and related responses include a `freshness` field with the current
  state and a `warnings` array.
- The `warnings` array includes freshness warnings when state is not `fresh`.
- Incompatible state causes search and related to fail with
  `INDEX_INCOMPATIBLE` error.
- Stale, pending, and updating states include warnings but do not block
  operations.
- `get_note` and `get_chunk` follow Phase 2 safe-resolution rules and warn
  only when stale state may affect ID lookup.
