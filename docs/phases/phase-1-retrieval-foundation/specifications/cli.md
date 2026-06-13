# Phase 1 CLI Specification

Status: Draft

This file is part of the Phase 1 specification. See ../specification.md for the specification map and ../requirements.md for requirements.

## CLI Framework

Phase 1 uses Commander for the CLI.

Commander owns command and option parsing, help text, subcommand registration, and process exit behavior. CLI command handlers must stay thin: they resolve configuration, validate CLI-level arguments, call the server or local configuration layer, and format output.

The CLI binary name is `vault-agent`.

CLI endpoint resolution:

1. `--endpoint`
2. `VAULT_AGENT_SERVER_ENDPOINT`
3. `[server].endpoint` in user-local TOML config.
4. Built-in default `http://127.0.0.1:8787`.

Global CLI flags:

- `--config <path>`
- `--endpoint <url>`
- `--api-key <key>`
- `--json`

`--api-key` is allowed for explicit one-off use. Help and documentation should recommend environment variables or user-local configuration for routine use because CLI flags may be recorded in shell history.

`--config <path>` may point to a custom TOML file, but generated secrets are never written to custom config paths outside the default user-local configuration location.

Command flags:

- `vault-agent serve`: `--vault-root`, `--host`, `--port`, `--index-dir`, `--api-key`
- `vault-agent index`: `--require-embeddings`, `--json`
- `vault-agent reindex`: `--require-embeddings`, `--json`
- `vault-agent search`: `--mode`, `--limit`, `--json`
- `vault-agent related`: `--type note|chunk`, `--mode`, `--limit`, `--json`
- `vault-agent get note`: `--allow-large`, `--json`
- `vault-agent get chunk`: `--json`
- `vault-agent get attachment`: `--download`, `--output <path>`, `--allow-large`, `--json`
- `vault-agent config get`: `--json`
- `vault-agent config set`: no command-specific flags
- `vault-agent config path`: `--json`
- `vault-agent config reveal-api-key`: `--json`

Attachment downloads require an explicit output target. `--download` without `--output` must fail. Writing attachment bytes to stdout is allowed only with `--output -`.

`vault-agent related` may infer `chunk` when the input contains `:` and may infer `note` when the input is a valid 32-character lowercase hexadecimal note ID. Ambiguous input requires `--type`.

`vault-agent search <query...>` joins positional query tokens with spaces.

`vault-agent related <id>` accepts a note ID or chunk ID.

`vault-agent get chunk` accepts either `<note-id> <chunk-index>` or a single `<chunk-id>`.

`vault-agent get note` accepts note IDs only in Phase 1. Retrieval by vault-relative note path is out of scope.

`vault-agent get attachment` accepts vault-relative attachment paths.

Phase 1 does not include structured path search filters. Path text may still match as ordinary query text when indexed.

`vault-agent config set` uses dotted keys, such as:

```text
vault-agent config set server.port 8787
```

`vault-agent config get` without a key prints the effective configuration. `vault-agent config get <key>` prints one dotted-key value. Secret values are shown only as set or unset.

For human-readable output, secret values appear as `set` or `unset`. For JSON output, secret values appear as objects such as `{ "set": true }`.

`vault-agent config set` must not echo secret values after writing them. It should print only set/unset status for secret keys.

`vault-agent config reveal-api-key` is the only Phase 1 command that prints an API key value. It prints the API key to stdout for explicit remote client setup and prints caution text to stderr. With `--json`, stdout contains `{ "apiKey": "..." }`.

`vault-agent config path` prints the resolved config file path. With `--json`, it prints `{ "path": "..." }`.

`vault-agent config set` creates the parent config directory and config file when needed. `vault-agent config get` shows effective defaults when the config file does not exist.

## CLI Output And Exit Codes

CLI human-readable output is compact table or list output.

CLI `--json` output should stay close to the HTTP response envelope shape.

Normal CLI output goes to stdout. Errors and warnings go to stderr. With `--json`, the JSON response goes to stdout.

Human-readable errors use:

```text
CODE: actionable message
```

Human-readable search output shows rank, score, vault-relative path, heading, and snippet.

Human-readable `get note` outputs note content to stdout by default so it can be redirected. Metadata is omitted or printed only as compact stderr context.

Human-readable `get chunk` outputs chunk content to stdout by default. Metadata is omitted or printed only as compact stderr context.

Human-readable `get attachment` without `--download` prints path, content type, size, and download availability.

Attachment downloads with `--output <path>` write bytes to the output file and print only a compact save summary. Attachment downloads with `--output -` write bytes to stdout.

`--download --json` without `--output` is invalid. With `--output <path>`, `--json` prints a save summary as JSON. Raw attachment bytes and JSON must not be mixed on stdout.

CLI exit codes:

- `0`: success.
- `1`: general runtime, indexing, search, or retrieval failure.
- `2`: validation or configuration error.
- `3`: authentication error.
- `4`: requested note, chunk, attachment, or index not found.
