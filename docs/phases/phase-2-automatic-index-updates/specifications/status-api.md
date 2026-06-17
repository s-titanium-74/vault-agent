# Phase 2 Status API Specification

Status: Draft

This file is part of the Phase 2 specification. See ../requirements.md for
requirements and this directory for the domain specifications.

## Freshness States

Index freshness states:

- `fresh`
- `pending`
- `updating`
- `stale`
- `incompatible`
- `unknown`

State meanings:

- `fresh`: the committed index matches the latest known relevant vault state.
- `pending`: relevant changes are known and waiting for debounce or writer
  availability.
- `updating`: an index writer is applying changes.
- `stale`: relevant changes may exist but are not reflected in the committed
  index.
- `incompatible`: the active index cannot be safely queried for search.
- `unknown`: freshness cannot be determined.

## CLI Status

`vault-agent status` is a top-level command.

`vault-agent status` connects to the server and displays `GET /status`.

If the server cannot be reached, the CLI may display only local endpoint and
config path information.

`vault-agent status --json` returns stable JSON even when the server cannot be
reached.

Narrow status commands:

- `vault-agent watch status`
- `vault-agent sync status`

`vault-agent watch status` reports watcher status only.

`vault-agent sync status` reports Git sync status only.

Human-readable status may show private absolute paths only when needed for
diagnostics.

`vault-agent status` does not display secret values.

`vault-agent status --verbose` still does not display API keys or webhook
secrets.

`vault-agent status --verbose` may show local absolute paths in human-readable
output only.

JSON status does not return private absolute paths by default. JSON status uses
vault-relative paths or redacted values by default.

## CLI Output And Exit Codes

Phase 2 CLI commands follow the Phase 1 CLI output rules:

- Normal human-readable output goes to stdout.
- Errors and warnings go to stderr.
- With `--json`, JSON goes to stdout.
- JSON output stays close to the HTTP response envelope shape.
- Human-readable errors use `CODE: actionable message`.

Human-readable `vault-agent status` output is compact and grouped by server,
index, watch, and sync state.

Human-readable `vault-agent watch status` output shows only watcher enablement,
runtime state, pending state, and last public-safe error.

Human-readable `vault-agent sync status` output shows only sync enablement,
configuration state, runtime state, pending state, last success time,
consecutive failure count, and last public-safe error.

Human-readable `vault-agent sync pull` output shows whether sync completed,
changed the worktree, skipped because no work was needed, or failed with an
actionable sanitized error.

Phase 2 CLI exit codes:

- `0`: success.
- `1`: general runtime, watcher, index update, sync, or status failure.
- `2`: validation or configuration error.
- `3`: authentication error.
- `4`: requested status target, repository, branch, remote, note, chunk, or
  index not found.
- `5`: sync or index operation already in progress.

For compatibility with Phase 1, existing Phase 1 commands keep their Phase 1
exit-code behavior unless this phase explicitly changes a new Phase 2 command.

## Status Schema

`GET /status` and `vault-agent status --json` use the Phase 1 response envelope.

Successful server-backed JSON response:

```json
{
  "data": {
    "server": {
      "running": true,
      "host": "127.0.0.1",
      "port": 8787,
      "apiKeyRequired": false
    },
    "index": {
      "freshness": "fresh",
      "lastSuccessfulUpdateAt": null,
      "pendingChangeCount": 0,
      "reindexRequired": false,
      "reindexReasons": [],
      "embeddingState": "disabled"
    },
    "watch": {
      "enabled": true,
      "running": true,
      "lastEventAt": null,
      "pending": false,
      "lastError": null
    },
    "sync": {
      "enabled": false,
      "configured": false,
      "running": false,
      "pending": false,
      "lastSuccessfulSyncAt": null,
      "consecutiveFailures": 0,
      "lastError": null
    }
  },
  "warnings": []
}
```

The fields above are the minimum stable JSON status schema for Phase 2.

Additional public-safe fields may be added without removing or renaming these
fields.

When the server cannot be reached, `vault-agent status --json` still returns a
stable object:

```json
{
  "data": {
    "server": {
      "running": false,
      "endpoint": "http://127.0.0.1:8787",
      "configPath": null
    },
    "index": null,
    "watch": null,
    "sync": null
  },
  "warnings": [
    {
      "code": "SERVER_UNREACHABLE",
      "message": "Server is not reachable."
    }
  ]
}
```

`configPath` may be `null` when the CLI cannot safely determine it.

## Status Field Values

`index.freshness` uses the freshness states defined in this file.

`index.embeddingState` uses:

- `disabled`
- `ready`
- `unavailable`
- `stale`
- `incompatible`

`watch.running` is `true` only when watch is enabled and the watcher backend is
actively receiving events.

`watch.lastError` and `sync.lastError` are either `null` or public-safe error
objects using the error object schema below.

Timestamps are ISO 8601 strings with timezone offsets or `null`.

## Warning And Error Objects

Warnings use:

```json
{ "code": "EXAMPLE_WARNING", "message": "Short public-safe message" }
```

Error objects use:

```json
{
  "code": "EXAMPLE_ERROR",
  "message": "Short public-safe message",
  "details": {}
}
```

The `details` object is optional and must be public-safe.

Warning and error messages must not include raw note content, raw chunks, raw
queries, secrets, provider credentials, remote credentials, or private absolute
paths.

## Retrieval Warning Rules

`search` runs against the last usable index while the index is stale, pending,
or updating.

Human-readable `search` output shows a short freshness warning when useful.

`search --json` includes freshness warnings in a `warnings` array.

`related` follows the same freshness warning policy as `search`.

`get note` and `get chunk` run against the last usable index as long as the
requested ID can be resolved.

`get` warns only when stale state may affect ID lookup.

In `incompatible` state, `search` and `related` should fail by default.

In `incompatible` state, `get note <id>` may be allowed only when it can be
resolved safely.

Reindex-required output should briefly show the next command to run.

## HTTP

Phase 2 HTTP routes:

- `GET /status`
- `POST /sync/pull`
- `POST /sync/webhook`

`GET /status` includes index freshness, watcher state, pending update state, and
sync state.

`GET /status` requires API key according to the server access policy.

`POST /sync/pull` requires API key.

`POST /sync/pull` request body:

```json
{
  "wait": false,
  "timeoutSeconds": 120
}
```

Both fields are optional. `timeoutSeconds` is used only when `wait` is `true`.

Successful `POST /sync/pull` response:

```json
{
  "data": {
    "status": "completed",
    "changed": false,
    "indexFreshness": "fresh",
    "startedAt": "2026-01-01T00:00:00.000Z",
    "finishedAt": "2026-01-01T00:00:01.000Z"
  },
  "warnings": []
}
```

`status` values are:

- `completed`
- `no_op`

When another sync is running and `wait` is false, `POST /sync/pull` returns
HTTP `409` with `SYNC_IN_PROGRESS`.

`POST /sync/webhook` requires webhook secret.

HTTP status responses must not include remote URL credentials.

HTTP status responses must not include private absolute vault paths by default.

No public `POST /index/incremental` endpoint is required in Phase 2. If an
implementation exposes an internal or admin incremental-index endpoint, it must
require API key authentication and must follow the same public-safe warning and
error rules as other JSON endpoints.
