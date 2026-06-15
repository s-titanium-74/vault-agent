# Phase 2 Testing And CI Specification

Status: Draft

This file is part of the Phase 2 specification. See ../requirements.md for
requirements and this directory for the domain specifications.

## Fixture Policy

Tests use only synthetic Markdown fixtures.

Git sync tests use temporary synthetic Git repositories.

Webhook tests use synthetic payloads only.

Tests must not copy private vault content, real names, private project names,
private paths, private URLs, provider credentials, API keys, or tokens.

Search-result snapshots should cover compact result metadata and snippets, not
full note bodies.

## Test Categories

Phase 2 includes:

- Unit tests.
- Integration tests.
- CLI smoke tests.

Unit tests should cover deterministic scheduling, filtering, state transitions,
error mapping, and configuration validation.

Integration tests should cover filesystem behavior, temporary Git repositories,
server endpoints, CLI-to-server behavior, and index updates.

CLI smoke tests should cover human-readable and JSON output for the main Phase 2
commands.

## Watcher Tests

Watcher debounce uses fake timers in unit tests.

Watcher event coalescing is covered by unit tests.

Watcher exclude filtering uses synthetic vault fixtures in integration tests.

Hidden file filtering is tested.

Rename handling is tested, including delete-plus-create behavior.

Watcher failure is tested as status error behavior, not server crash behavior.

Watcher tests should avoid relying on exact OS-specific event sequences.

## Incremental Index Tests

Incremental index tests cover:

- Changed Markdown files update note, chunk, and search rows.
- Deleted Markdown files remove note, chunk, and search rows.
- Created Markdown files add note, chunk, and search rows.
- Excluded file changes are ignored.
- Attachment metadata changes are handled without indexing attachment contents.
- Degraded files preserve last usable index behavior where practical.
- Configuration changes that require reindexing are detected.
- Embedding stale and dimension mismatch states are detected.
- Incremental update failure does not corrupt the last usable index.
- Index writer single-flight behavior is tested.
- Search during pending or updating state uses the last usable index.
- Stale warnings appear in `search --json` warnings.
- `get` stale warnings appear only when stale state may affect ID lookup.

## Git Sync Tests

Git sync tests use a temporary bare remote repository and temporary working
repositories.

Git sync tests cover:

- Existing repository detection through `sync configure`.
- Nested Git repositories choose the nearest worktree.
- `sync clone` target cases: missing, empty, and non-empty target directories.
- Remote URLs containing credentials are rejected.
- Dirty worktree sync failure.
- Fast-forward pull success.
- Non-fast-forward failure.
- Merge conflict failure.
- Missing remote branch failure.
- Git executable unavailable behavior where practical.
- Sync with no worktree file changes does not run indexing.
- Sync with indexed Markdown changes marks the index stale and updates it.
- Sync with excluded-file-only changes does not run indexing.
- Sync single-flight behavior across scheduled, manual, and webhook triggers.
- `sync pull --wait` waits and times out predictably.
- Git command output is sanitized before display or logging.

## Webhook Tests

Webhook tests cover:

- Disabled webhook response.
- Missing secret response.
- Invalid secret response.
- Timing-safe secret comparison behavior where practical.
- Request body size limit.
- Valid webhook schedules sync after debounce.
- Multiple webhook events coalesce while sync is running.
- Rate-limited valid webhook requests do not enqueue additional sync work.
- Webhook payload changed-file lists are ignored.
- Webhook responses do not expose remote URL or branch details.
- `sync.webhook_enabled = true` with `sync.enabled = false` fails as sync not
  configured.

## Status Tests

Status tests cover:

- `vault-agent status` server reachable behavior.
- `vault-agent status` server unreachable behavior.
- `vault-agent status --json` stable schema.
- `vault-agent status --json` stable server-unreachable schema.
- `vault-agent watch status`.
- `vault-agent sync status`.
- `GET /status`.
- `POST /sync/pull` success and in-progress responses.
- Redaction of API keys, webhook secrets, private absolute paths, and remote URL
  credentials.
- Freshness state transitions.
- Reindex-required reasons.
- Sync failure counts and last-success timestamps.

## Configuration Tests

Configuration tests cover:

- `[watch]` defaults and overrides.
- `[sync]` defaults and overrides.
- Environment variable parsing.
- Configuration precedence.
- Invalid boolean and numeric environment variables.
- Invalid watch timing values.
- Invalid sync interval, timeout, and backoff values.
- Secret redaction.
- Unknown key validation.

## CI Concerns

Watcher integration tests may be marked platform-sensitive if the selected
watcher backend behaves differently across operating systems.

Watcher debounce and coalescing should be covered primarily with fake timers to
reduce flakiness.

Git sync tests should create temporary repositories inside test temp
directories and must not use real remotes or credentials.

Tests that require Git may skip with a clear reason if the Git executable is not
available in the CI environment.

## Implementation Sequence

Recommended implementation order:

1. Extend configuration with `[watch]` and `[sync]` validation and environment
   variables.
2. Add index freshness state, status models, and `GET /status`.
3. Add incremental index update behavior behind core APIs.
4. Add watcher event filtering, batching, and incremental update scheduling.
5. Add CLI status, watcher status, and sync status commands.
6. Add manual `sync configure`, `sync status`, and `sync pull`.
7. Add `sync clone`, scheduled sync, and webhook sync.
8. Add status warning integration for search, related, and get.
9. Complete integration, CLI smoke, and CI coverage.

Each step should keep the last usable index available for search and get unless
the active index is incompatible.
