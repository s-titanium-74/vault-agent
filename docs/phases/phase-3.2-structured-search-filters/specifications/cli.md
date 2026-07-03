# Phase 3.2 CLI Specification

Status: Draft

This file is part of the Phase 3.2 specification. See ../requirements.md for requirements and this directory for the API, MCP, core, and testing specifications.

## Command

Phase 3.2 extends the existing Phase 1 command:

```bash
vault-agent search <query...>
```

The command remains server-backed. It calls `POST /search`.

## Options

Existing Phase 1 options continue to apply:

- `--mode <mode>`
- `--limit <n>`
- `--json`
- Global `--config <path>`
- Global `--endpoint <url>`
- Global `--api-key <key>`

Phase 3.2 adds:

- `--path <prefix>`: include a vault-relative path prefix. May be repeated.
- `--exclude-path <prefix>`: exclude a vault-relative path prefix. May be repeated.
- `--tag <tag>`: include a frontmatter tag. May be repeated.
- `--exclude-tag <tag>`: exclude a frontmatter tag. May be repeated.
- `--frontmatter <field=value>`: include an allowlisted frontmatter field/value filter. May be repeated.

Allowed `--frontmatter` fields:

- `type`
- `status`

## Examples

```bash
vault-agent search "local embedding privacy" --path Projects --tag privacy
```

```bash
vault-agent search "roadmap" --path Projects --exclude-path Archive --exclude-tag archived
```

```bash
vault-agent search "review notes" --frontmatter type=note --frontmatter status=active
```

## Request Translation

The CLI translates repeated flags into arrays in the HTTP request body:

```bash
vault-agent search "local embedding privacy" \
  --path Projects \
  --tag privacy \
  --exclude-tag archive \
  --exclude-path Archive \
  --frontmatter status=active
```

produces:

```json
{
  "query": "local embedding privacy",
  "filters": {
    "pathPrefix": ["Projects"],
    "tags": ["privacy"],
    "excludeTags": ["archive"],
    "excludePathPrefix": ["Archive"],
    "frontmatter": {
      "status": ["active"]
    }
  }
}
```

When no filter flags are supplied, the CLI omits `filters`.

## CLI Validation

The CLI should perform lightweight validation before sending the request:

- `--path` and `--exclude-path` values must not be empty.
- Absolute path filter values fail locally with exit code `2`.
- Obvious traversal values such as `..` fail locally with exit code `2`.
- `--tag` and `--exclude-tag` values must not be empty after trimming.
- `--frontmatter` values must use `field=value`.
- `--frontmatter` field must be `type` or `status`.
- `--frontmatter` value must not be empty after trimming.

Server-side validation remains authoritative. If the server returns a filter validation error, the CLI maps it to exit code `2`.

## Output

Human-readable search output remains compact and follows Phase 1 behavior: rank, score, vault-relative path, heading, and snippet.

The CLI may print a concise filter summary to stderr in human-readable mode, but it must not echo large raw input values, private absolute paths, note content, chunk content, or arbitrary frontmatter values.

With `--json`, stdout contains the HTTP response envelope:

```json
{
  "data": {
    "requestedMode": "lexical",
    "usedMode": "lexical",
    "limit": 10,
    "results": []
  },
  "warnings": []
}
```

Warnings print to stderr in human-readable mode and remain in the JSON envelope with `--json`.

## Exit Codes

Phase 3.2 uses the existing CLI exit codes for `search`:

| Exit Code | Meaning                                                       |
| --------- | ------------------------------------------------------------- |
| `0`       | Success.                                                      |
| `1`       | General runtime, search, or retrieval failure.                |
| `2`       | Validation or configuration error, including invalid filters. |
| `3`       | Authentication error.                                         |
| `4`       | Index not found (`INDEX_NOT_FOUND`).                          |
| `6`       | Server unavailable (`SERVER_UNAVAILABLE`) where implemented.  |
| `7`       | Index incompatible (`INDEX_INCOMPATIBLE`) where implemented.  |

## Error Messages

Human-readable errors use:

```text
CODE: actionable message
```

Examples:

```text
INVALID_PATH_FILTER: Path filters must be vault-relative prefixes.
INVALID_FRONTMATTER_FILTER: Frontmatter filters support only type and status.
INDEX_NOT_FOUND: No usable index found. Run vault-agent index.
```

Errors must not include raw queries, raw request bodies, private absolute paths, note content, chunk content, secrets, or provider credentials.
