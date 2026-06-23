# Phase 1 Server API Specification

Status: Draft

This file is part of the Phase 1 specification. See ../requirements.md for requirements and this directory for the domain specifications.

## HTTP Server Framework

Phase 1 uses Fastify for the HTTP server.

Fastify is responsible for:

- Route registration.
- Request body and parameter validation.
- Authentication hooks.
- CORS configuration.
- Structured response serialization where useful.
- Mapping core errors to HTTP responses.

Server route handlers must stay thin. They validate HTTP input, enforce server-level access rules, call `core`, and format the HTTP response.

Phase 1 uses `@fastify/cors` when CORS is explicitly enabled.

JSON request body size limit: 64 KiB.

Phase 1 HTTP routes:

- `GET /health`
- `POST /index`
- `POST /reindex`
- `POST /search`
- `POST /related`
- `GET /notes/:noteId`
- `GET /chunks/:noteId/:chunkIndex`
- `GET /attachments/*`

Documented routes omit trailing slashes. Trailing slash behavior follows Fastify defaults and is not part of the canonical API.

JSON endpoints return `application/json; charset=utf-8`.

## CORS

CORS is disabled by default.

When CORS is enabled, `allowed_origins` must contain at least one explicit origin. Wildcard origins are invalid.

CORS credentials are disabled in Phase 1.

## HTTP Response Envelope

Successful JSON responses use:

```json
{
  "data": {},
  "warnings": []
}
```

Error JSON responses use:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Actionable error message.",
    "details": {}
  }
}
```

`warnings` is always an array on successful JSON responses. Warning and error details must not include raw note content, raw chunks, raw queries, secrets, provider credentials, or private absolute paths.

The response envelope `warnings` array contains warning details. Endpoint-specific summary fields such as `warningCount` are supplemental.

At most 100 warning objects are returned in one response. If warnings are truncated, the response includes a `WARNINGS_TRUNCATED` warning.

Error response `details` should include `requestId` when available.

Warning objects use:

```json
{
  "code": "WARNING_CODE",
  "message": "Actionable warning message.",
  "details": {}
}
```

## HTTP Status Codes And Error Codes

Phase 1 uses these HTTP status codes:

- `400`: validation error.
- `401`: missing or invalid authentication.
- `403`: forbidden path or access boundary violation.
- `404`: requested note, chunk, or attachment not found.
- `409`: incompatible index, stale index requiring explicit action, or conflicting index state.
- `413`: requested note or attachment exceeds the size limit without `allowLarge=true`.
- `503`: embedding provider or embedding index unavailable when required.
- `500`: unexpected internal error.

Error codes use `SCREAMING_SNAKE_CASE`, such as `INDEX_NOT_FOUND`, `PATH_OUTSIDE_VAULT`, and `EMBEDDING_UNAVAILABLE`.

The same error codes should be reused in API responses, CLI JSON output, and logs.

Each server request gets a request ID for log correlation.

Missing notes return `404` with `NOTE_NOT_FOUND`.

Missing chunks return `404` with `CHUNK_NOT_FOUND`.

Invalid note IDs or chunk IDs return `400` with `INVALID_ID`.

Unknown search or related modes return `400` with `INVALID_MODE`.

Limits outside 1 through 50 return `400` with `INVALID_LIMIT`.

Invalid attachment path syntax returns `400` with `INVALID_PATH`.

Attachment paths that point to directories return `400` with `INVALID_PATH`.

Attachment paths that point to Markdown notes, hidden paths, excluded paths, or other disallowed files return `403` with `ATTACHMENT_NOT_ALLOWED`.

Missing allowed attachments return `404` with `ATTACHMENT_NOT_FOUND`.

Path traversal or resolved paths outside the vault root return `403` with `PATH_OUTSIDE_VAULT`.

When no usable index exists, search and related return `409` with `INDEX_NOT_FOUND`. The message should tell the user to run `vault-agent index` or restart the server to run first-start bootstrap.

When stale index state is detected during search or related, the server may return results with an `INDEX_STALE` warning. Incompatible indexes must return `409` and must not be queried.

## Schema Validation

Phase 1 uses Zod for request, response, configuration, and internal retrieval schema validation.

Shared schemas should live in `packages/core` when they describe core retrieval concepts or public response shapes. Server-only HTTP parameter schemas may live in `packages/server`.

Fastify route handlers must validate incoming requests with Zod before calling `core`.

## Authentication

When the server binds to `127.0.0.1`, API key authentication is optional and disabled by default.

When an API key is configured, authentication is required for every endpoint even on localhost.

When the server binds to any non-localhost host, API key authentication is required for every endpoint, including `GET /health`.

Non-localhost startup without a configured API key generates a strong API key, stores it in the default user-local configuration, and enables authentication before the server starts listening. The generated key value is not printed during startup.

If a non-localhost server is started with `--config <path>` outside the default user-local configuration location and no API key is configured, startup fails with `API_KEY_REQUIRED` instead of writing a generated secret to the custom config file.

For authentication policy, localhost hosts are `127.0.0.1`, `localhost`, and `::1`. Any other bind host is non-localhost.

For non-localhost bind, the configured API key must be at least 32 characters.

Generated API keys use 32 random bytes encoded as a URL-safe string.

API key verification must use constant-time comparison.

Non-localhost startup must print a warning to stderr. Logs should include only a warning code and non-sensitive state.

Direct public internet exposure is out of scope for Phase 1.

API keys are supplied only with:

```text
Authorization: Bearer <api-key>
```

API keys must not be accepted in query parameters.

## Timeouts

CLI HTTP client timeouts:

- Indexing requests: 10 minutes.
- Search, related, note retrieval, chunk retrieval, attachment metadata, and attachment download requests: 60 seconds.

## Logging

Phase 1 uses `pino` for structured logging.

Default log level: `info`.

The log level may be configured through user-local configuration or environment variables. Supported levels are `debug`, `info`, `warn`, and `error`.

Logs must follow the data minimization rules defined in the requirements.

Logs may include warning codes and warning counts. Logs must not include individual private vault paths, raw queries, note content, chunk content, or absolute paths, even at `debug` level.

## Health API

`GET /health` successful response data:

```json
{
  "status": "ok",
  "version": "0.1.1",
  "index": {
    "available": true,
    "stale": false,
    "embeddingAvailable": true
  }
}
```

Health status values are `ok`, `degraded`, and `error`.

Health is `degraded` when the index is unavailable, the index is stale, or embeddings are configured but unavailable. Fatal configuration errors prevent server startup instead of producing health responses.

The health `version` value comes from the package version.

The health response must not include vault paths, index paths, raw configuration values, or secrets.

During first-run bootstrap, the server has not started listening, so `/health` is not available until bootstrap completes.

## Index And Reindex API

`POST /index` performs an incremental index update when a usable index already exists.

Request body:

```json
{
  "requireEmbeddings": false
}
```

Fields:

- `requireEmbeddings`: optional boolean. When true, embedding generation failure makes the request fail even if lexical indexing succeeds. Default is the configured `embedding.require` value.

Successful response data:

```json
{
  "mode": "incremental",
  "notesIndexed": 12,
  "chunksIndexed": 48,
  "notesSkipped": 120,
  "warningCount": 0
}
```

`POST /reindex` performs a full rebuild.

Request body:

```json
{
  "requireEmbeddings": false
}
```

Fields are the same as `POST /index`.

Successful response data:

```json
{
  "mode": "full",
  "notesIndexed": 132,
  "chunksIndexed": 512,
  "notesSkipped": 0,
  "warningCount": 0
}
```

Incremental change detection uses vault-relative path, file size, and `mtimeMs`.

Index warnings may include vault-relative path, reason code, and file size. They must not include absolute paths or file contents.

Files skipped because of default hidden-file or default exclude handling are not counted in `notesSkipped`.

Index updates must use SQLite transactions.

Full reindex builds into a temporary database and swaps it into place only after the rebuild succeeds. If full reindex fails, the previous usable index must remain available.
