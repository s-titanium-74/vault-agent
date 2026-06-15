# Phase 2 Configuration Specification

Status: Draft

This file is part of the Phase 2 specification. See ../requirements.md for
requirements and this directory for the domain specifications.

## Configuration File

Phase 2 extends the Phase 1 user-local TOML configuration with `[watch]` and
`[sync]` sections.

Phase 2 additions:

```toml
[watch]
enabled = true
debounce_ms = 10000
max_batch_delay_ms = 60000
ignore_initial = true

[sync]
enabled = false
repo = ""
remote = "origin"
branch = ""
interval_seconds = 900
webhook_enabled = false
webhook_secret = ""
pull_timeout_seconds = 120
failure_backoff_seconds = 3600
```

Example repository configuration must use public-safe placeholder paths, public
placeholder remotes, and empty secrets only.

Private paths, remotes, and secrets must not be stored in repository files.

## Configuration Precedence

Phase 2 uses the Phase 1 precedence order:

1. CLI flags.
2. Environment variables.
3. User-local TOML config.
4. Built-in defaults.

## Environment Variables

Phase 2 adds environment variable overrides mirroring the new watch and sync
configuration sections.

Supported environment variables:

- `VAULT_AGENT_WATCH_ENABLED`
- `VAULT_AGENT_WATCH_DEBOUNCE_MS`
- `VAULT_AGENT_WATCH_MAX_BATCH_DELAY_MS`
- `VAULT_AGENT_WATCH_IGNORE_INITIAL`
- `VAULT_AGENT_SYNC_ENABLED`
- `VAULT_AGENT_SYNC_REPO`
- `VAULT_AGENT_SYNC_REMOTE`
- `VAULT_AGENT_SYNC_BRANCH`
- `VAULT_AGENT_SYNC_INTERVAL_SECONDS`
- `VAULT_AGENT_SYNC_WEBHOOK_ENABLED`
- `VAULT_AGENT_SYNC_WEBHOOK_SECRET`
- `VAULT_AGENT_SYNC_PULL_TIMEOUT_SECONDS`
- `VAULT_AGENT_SYNC_FAILURE_BACKOFF_SECONDS`

Boolean environment variables accept `true`, `false`, `1`, and `0`. Other
values are validation errors.

Numeric environment variables must parse as positive integers.

## Validation

Watch validation:

- `watch.debounce_ms` must be greater than zero.
- `watch.max_batch_delay_ms` must be greater than or equal to
  `watch.debounce_ms`.
- `watch.ignore_initial` is a boolean.

Sync validation:

- `sync.enabled` is a boolean.
- `sync.repo`, when set, must resolve to a Git worktree used only through
  user-local configuration.
- `sync.remote`, when set, is a Git remote name, not a URL.
- `sync.branch`, when set, is a branch name.
- `sync.interval_seconds` must be at least 60.
- `sync.pull_timeout_seconds` must be greater than zero.
- `sync.failure_backoff_seconds` must be greater than or equal to
  `sync.interval_seconds`.
- `sync.webhook_enabled` requires `sync.enabled = true` and a webhook secret
  before webhook requests can succeed.
- `sync.enabled = true` requires `sync.repo`, `sync.remote`, and `sync.branch`
  to resolve to a usable Git sync target before scheduled sync can run.
- Remote URLs containing credentials are rejected by sync commands before they
  are stored.

Unknown configuration keys remain validation errors.

## Secret Redaction

Secret values may be stored in user-local TOML configuration or environment
variables.

Normal configuration commands, status commands, API responses, logs, and errors
display only whether secret values are set.

Webhook secrets and API keys must not be printed by `--verbose` output.

Remote URLs are hidden by default in status output. Verbose human-readable sync
status may show credentials-redacted remote URLs.

## User-Local Storage

Repository paths, vault paths, selected remotes, selected branches, remote URLs,
and webhook secrets are user-local settings.

They must not be written to docs, examples, fixtures, snapshots, or other files
intended for the public repository.

Runtime configuration writes must not modify the vault repository unless the
user explicitly runs a Git command through `sync configure` that adds or updates
a remote.
