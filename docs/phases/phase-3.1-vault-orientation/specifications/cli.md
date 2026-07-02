# Phase 3.1 CLI Specification

Status: Draft

This file is part of the Phase 3.1 specification. See ../requirements.md for requirements and this directory for the domain specifications.

## Commands

Phase 3.1 adds four orientation CLI commands:

- `vault-agent overview`
- `vault-agent tree`
- `vault-agent tags`
- `vault-agent facets`

All commands are server-backed. They call the corresponding HTTP orientation endpoints.

## Global Options

All orientation commands support the global CLI options defined in Phase 1:

- `--config <path>`: path to user-local configuration file.
- `--json`: output machine-readable JSON.
- `--endpoint <url>`: override configured server endpoint.
- `--api-key <key>`: override configured API key.

## `vault-agent overview`

### Usage

```bash
vault-agent overview
```

### Behavior

1. Resolve server endpoint from flags, environment, or config.
2. Call `GET /overview`.
3. On success, print compact human-readable output or JSON with `--json`.
4. Print warnings to stderr in human-readable mode; include them in the JSON envelope with `--json`.
5. On `INDEX_NOT_FOUND`, exit with code `4` and print actionable error.
6. On `INDEX_INCOMPATIBLE`, exit with code `7` and print actionable error.
7. On `SERVER_UNAVAILABLE`, exit with code `6` and print actionable message telling the user to start `vault-agent serve` or configure the endpoint.
8. On authentication failure, exit with code `3`.
9. On invalid parameter or configuration error, exit with code `2`.
10. On `VAULT_NOT_CONFIGURED`, exit with code `1` and print actionable error.

### Human Output Example

```text
Notes: 1,240
Chunks: 3,920

Top folders:
  Projects  320
  Areas     180

Top tags:
  meeting  84
  idea     62

Top fields:
  type    400
  status  130
```

### JSON Output Example

```json
{
  "data": {
    "noteCount": 1240,
    "chunkCount": 3920,
    "topLevelFolders": [{ "path": "Projects", "noteCount": 320 }],
    "topTags": [{ "tag": "meeting", "noteCount": 84 }],
    "frontmatterFields": [{ "name": "type", "noteCount": 400 }],
    "indexFreshness": "fresh"
  },
  "warnings": []
}
```

## `vault-agent tree`

### Usage

```bash
vault-agent tree [--depth <n>] [--limit <n>] [--direct-only]
```

### Options

- `--depth <n>`: maximum folder depth, 1–10. Default: 2.
- `--limit <n>`: maximum tree nodes, 1–500. Default: 50.
- `--direct-only`: count only notes directly in each folder.
- `--json`: output machine-readable JSON.

### Behavior

1. Validate `--depth` and `--limit` ranges.
2. Call `GET /tree?depth=<n>&limit=<n>&directOnly=<bool>`.
3. Print tree in human-readable indented format or JSON.
4. Include truncation warning if present (stderr in human-readable mode; JSON envelope with `--json`).
5. Error handling follows the same exit codes as `vault-agent overview`.

### Human Output Example

```text
Vault root  1,240
  Projects  320
    WebApp    120
    API       200
  Areas     180
    Health    80
    Finance  100
```

## `vault-agent tags`

### Usage

```bash
vault-agent tags [--limit <n>]
```

### Options

- `--limit <n>`: maximum tags, 1–200. Default: 50.
- `--json`: output machine-readable JSON.

### Behavior

1. Validate `--limit` range.
2. Call `GET /tags?limit=<n>`.
3. Print tags sorted by note count descending.
4. Include freshness warnings if present (`tags` does not emit truncation warnings because its limit is explicit).
5. Error handling follows the same exit codes as `vault-agent overview`.

### Human Output Example

```text
tag         notes
meeting     84
idea        62
project     45
```

## `vault-agent facets`

### Usage

```bash
vault-agent facets [--limit <n>]
```

### Options

- `--limit <n>`: maximum fields, 1–200. Default: 50.
- `--json`: output machine-readable JSON.

### Behavior

1. Validate `--limit` range.
2. Call `GET /facets?limit=<n>`.
3. Print fields and, for allowlisted fields, their values.
4. Include freshness warnings if present (`facets` does not emit truncation warnings because its limit is explicit).
5. Error handling follows the same exit codes as `vault-agent overview`.

### Human Output Example

```text
Field   Notes  Values
type    400    project 250, area 150
status  130    active 80, draft 50
date    200
```

## Warning Display

Human-readable output for all orientation commands prints warnings to stderr in a compact format when warnings exist:

- Freshness warnings: `Warning: INDEX_STALE — Index may be outdated. Run `vault-agent index` to refresh.`
- Truncation warnings: `Warning: TREE_LIMIT_EXCEEDED — Tree output was truncated by limit.`

With `--json`, warnings are included in the response envelope (`warnings` array at the top level).

CLI error messages must be actionable and must not include private absolute paths, note content, chunk content, raw queries, or secrets.

Common error messages:

- No usable index found. Run `vault-agent index` or `vault-agent reindex`.
- Index is incompatible. Run `vault-agent reindex`.
- Server is not reachable. Start `vault-agent serve` or update the configured endpoint.

## Exit Codes

| Exit Code | Meaning                                                               |
| --------- | --------------------------------------------------------------------- |
| `0`       | Success.                                                              |
| `1`       | General runtime error.                                                |
| `2`       | Validation or configuration error (including invalid CLI parameters). |
| `3`       | Authentication error (e.g., missing or invalid API key).              |
| `4`       | Index not found (`INDEX_NOT_FOUND`).                                  |
| `6`       | Server unavailable (`SERVER_UNAVAILABLE`).                            |
| `7`       | Index incompatible (`INDEX_INCOMPATIBLE`).                            |

Exit codes align with Phase 1 and Phase 2 CLI convention for overlapping error types. New orientation-specific codes (`6`, `7`) are added for errors that do not have a Phase 1/Phase 2 equivalent. Code `5` is avoided because Phase 2 uses it for "sync or index operation already in progress."
