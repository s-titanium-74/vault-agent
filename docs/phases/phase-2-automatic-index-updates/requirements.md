# Phase 2 Automatic Index Updates Requirements

Status: Draft

## Purpose

Phase 2 reduces dependence on manual `vault-agent index` runs by letting the
system follow local vault changes and optional Git checkout updates.

The phase adds automatic local file watching, incremental index updates, stale
index detection, provider and model change guidance, opt-in Git checkout sync,
and status surfaces for operational visibility.

Phase 2 must preserve the product direction from `docs/product-plan.md`:
local-first, private-by-default, deterministic retrieval, progressive
disclosure, one vault root per server process, and a clean separation between
core, server, and CLI responsibilities.

## Open Product Decisions

No unresolved product decisions are known in this draft. If implementation
raises a behavior, public API, security, privacy, or architecture choice that is
not covered here or in the linked specifications, add it to this section before
implementation.

## Scope

Phase 2 must include:

- File watching for a configured vault root.
- Incremental index updates from local file changes.
- Stale, pending, updating, incompatible, and unknown index-state reporting.
- Manual index and reindex fallback when automatic updates cannot safely
  proceed.
- Provider, model, schema, and configuration change guidance.
- Opt-in Git sync for Git checkout deployments.
- `vault-agent sync` commands for configured Git checkout updates.
- Existing Git repository detection for a served vault root.
- Manual, scheduled, and webhook-triggered Git sync policy.
- File tree change detection and index stale handling after Git sync.
- Status surfaces for server, index, watcher, and sync state.

Phase 2 builds on Phase 1. Unless this phase explicitly overrides a Phase 1
behavior, Phase 1 server access control, response envelopes, CLI JSON behavior,
configuration precedence, logging policy, path safety, indexing safety, and
privacy requirements continue to apply.

Phase 2 must not include:

- Chat or LLM answer generation.
- An Obsidian plugin.
- An MCP bridge.
- Note writing or editing workflows.
- Git push.
- Automatic Git conflict resolution.
- Multiple vaults in one server process.
- Automatic embedding model downloads.

## Phase Acceptance Criteria

Phase 2 is complete when a user can run one local server for one configured
vault root and rely on the last usable index while local file changes,
incremental indexing, optional Git sync, and failures occur.

Acceptance criteria:

- A local Markdown create, modify, delete, or rename is detected by the watcher
  and reflected in search after an incremental update.
- A relevant local change that has not yet been indexed is visible as pending,
  stale, or updating status.
- Search and related continue to use the last usable index during pending,
  stale, updating, watcher-failed, sync-failed, and index-writer-busy states.
- Incompatible index states are detected and block search by default with a
  reindex-required message.
- Manual `vault-agent index` and `vault-agent reindex` remain available as
  recovery paths when automatic updates cannot proceed safely.
- Watcher disabled mode works and leaves manual indexing behavior intact.
- Git sync remains disabled until explicitly configured and enabled.
- Manual Git sync can update a clean fast-forward-compatible checkout and then
  trigger stale detection or incremental indexing for relevant file changes.
- Scheduled and webhook-triggered sync are opt-in and do not run concurrently
  with another sync.
- Dirty worktrees, non-fast-forward updates, merge conflicts, missing Git,
  authentication failures, and network failures fail without making the last
  usable index unavailable.
- `vault-agent status`, `vault-agent watch status`, `vault-agent sync status`,
  and `GET /status` expose enough public-safe state for a user or agent to
  decide whether to wait, search, sync, index, or reindex.
- Status, logs, warnings, errors, tests, and examples do not expose private
  note content, secrets, provider credentials, remote credentials, or private
  absolute paths by default.
- Tests cover watcher, incremental indexing, sync, webhook, status, and
  configuration behavior using only synthetic fixtures.

## Local File Watching

Specification: [Watching](specifications/watching.md).

File watching is enabled by default for the configured vault root and may be
explicitly disabled through configuration or CLI flags.

Watcher requirements:

- The watcher applies only to the configured vault root for the current server
  process.
- The watcher must respect Phase 1 default exclusions and user-configured
  exclusions.
- The watcher must ignore generated index and data directories.
- The watcher must handle create, modify, delete, and rename events.
- Excluded and hidden path changes are ignored by default.
- Rapid changes are coalesced into incremental updates.
- `vault-agent index` remains a manual override.
- Watcher failure must not crash the server by default.
- Watcher unavailable or degraded state must be visible through status output.
- Search during a pending or failed watcher update uses the last usable index
  and may include freshness status metadata.

## Incremental Index Updates

Specification:
[Incremental Indexing](specifications/incremental-indexing.md).

The incremental update unit is a vault-relative path.

Incremental indexing requirements:

- Created or changed Markdown files update note records, chunks, lexical rows,
  embeddings when enabled, link metadata, and attachment reference metadata.
- Deleted Markdown files remove the corresponding indexed note data.
- Attachment changes update only attachment metadata where Phase 1 retrieval
  rules make the attachment discoverable.
- Excluded path changes do not update the index.
- File read, parse, size, encoding, and frontmatter failures must preserve the
  last usable committed index where practical and surface degraded status.
- Schema, vault identity, exclude, chunking, embedding model, and embedding
  dimension incompatibilities must require explicit reindexing or embedding
  rebuild as appropriate.
- Incremental updates are transactional and must not corrupt the last usable
  committed index.
- Search and get during an incremental update use the last committed index
  snapshot.
- Only one index writer may run at a time.

## Index Freshness And Retrieval Behavior

Specification: [Status API](specifications/status-api.md).

Status surfaces must represent index freshness with stable state names:

- `fresh`
- `pending`
- `updating`
- `stale`
- `incompatible`
- `unknown`

Search and retrieval requirements:

- `search` and `related` run against the last usable index while the index is
  stale, pending, or updating.
- Human-readable output shows short freshness warnings when useful.
- JSON output includes freshness warnings in a stable warnings array.
- `get note` and `get chunk` run against the last usable index as long as the
  requested ID can be resolved safely.
- `get` warns only when stale state may affect ID lookup.
- In `incompatible` state, `search` and `related` fail by default.
- In `incompatible` state, `get note <id>` may be allowed only when it can be
  resolved safely.
- Reindex-required output should briefly show the next command to run.

## Startup And Recovery

Specification:
[Incremental Indexing](specifications/incremental-indexing.md) and
[Status API](specifications/status-api.md).

Startup and recovery requirements:

- Server startup must detect whether the configured vault root, index schema,
  effective exclusions, chunking settings, and embedding settings are compatible
  with the current index.
- If no usable index exists, Phase 1 first-run bootstrap or manual indexing
  behavior remains the recovery path.
- If a usable but stale index exists, the server may start and serve retrieval
  from that index while exposing stale status.
- If an index is incompatible, search and related fail by default until the user
  explicitly reindexes or rebuilds the affected index portion.
- A failed watcher, failed sync, failed incremental update, or abandoned lock
  must leave a public-safe status signal and a manual recovery path.
- Automatic recovery must not perform destructive Git operations or silently
  discard local worktree changes.

## Git Sync

Specification: [Sync](specifications/sync.md).

Git sync is disabled by default.

Git sync is an opt-in helper for a read-only retrieval server to update a vault
checkout managed elsewhere. It is not a note writing or editing workflow.

Git sync requirements:

- Detecting a Git worktree must not enable sync.
- If `vault.root` is inside nested Git worktrees, the nearest enclosing Git
  worktree is used.
- Sync configuration, repository paths, remote names, branches, and secrets must
  be stored only in user-local configuration or environment variables.
- Remote URLs containing credentials must be rejected.
- Authentication must use existing Git, SSH, or OS credential mechanisms.
- `sync clone`, `sync configure`, `sync status`, `sync enable`,
  `sync disable`, and `sync pull` are included in Phase 2.
- `sync pull` must use fetch plus fast-forward-only update behavior by default.
- Dirty worktrees, non-fast-forward states, merge conflicts, missing remote
  refs, authentication failures, network failures, and Git executable absence
  must fail with actionable sanitized errors.
- Git sync must not push, auto-stash, reset, auto-merge, auto-resolve
  conflicts, or store credentials.
- Scheduled sync and webhook-triggered sync must be opt-in and single-flight.
- Sync failures must not make the last usable index unavailable.
- Successful sync must mark the index stale only when indexed files may have
  changed.

## Git Sync Concurrency

Specification: [Sync](specifications/sync.md).

Git sync execution is single-flight per configured repository or worktree.

Concurrency requirements:

- Scheduled sync does not run in parallel with manual or webhook sync.
- Manual sync returns a stable in-progress error by default when another sync is
  running.
- Manual sync may support waiting for the current sync to finish.
- Webhook events received during active sync are coalesced.
- Scheduled ticks received during active sync are skipped.
- Sync may mark the index stale while an index update is running, but it must
  not start a second concurrent index writer.
- Failed sync does not trigger index update unless worktree changes were
  actually applied before failure.

## Webhook Sync

Specification: [Sync](specifications/sync.md).

Webhook sync is included in Phase 2 but disabled by default.

Webhook requirements:

- Webhook sync is enabled only by explicit configuration.
- The webhook endpoint is authenticated with a webhook secret, not the normal
  API key.
- Webhook secrets are stored only in user-local configuration or environment
  variables.
- Webhook secrets are not shown in normal config or status output.
- Webhook payloads are not trusted and changed-file lists from payloads are not
  used as the basis for index updates.
- A valid webhook is treated only as a signal requesting sync pull.
- Webhooks received while sync is running are coalesced.
- Secret mismatch responses do not include detailed reasons.
- Webhook responses must not include remote URL or branch details.
- If webhook is used outside localhost binding, documentation must state that it
  assumes API key protection or a private network.
- GitHub and GitLab specific signature verification is not required in Phase 2,
  but the design should allow future provider-specific verification.

## HTTP And CLI Status

Specification: [Status API](specifications/status-api.md).

Phase 2 adds status surfaces for operational state.

Status requirements:

- `vault-agent status` reports server, index, watcher, and sync status.
- `vault-agent watch status` reports watcher status only.
- `vault-agent sync status` reports Git sync status only.
- Status JSON uses stable machine-readable schemas.
- Status output does not display secret values.
- JSON status does not return private absolute paths by default.
- Human-readable status may show private absolute paths only when explicitly
  useful for local diagnostics.
- HTTP status endpoints require authentication according to the server access
  policy.

## Security And Privacy

Watcher, sync, status, and incremental indexing must preserve Phase 1 data
minimization rules.

Security and privacy requirements:

- Watcher and sync logs must not include full note content.
- Git command output must not be passed directly to logs, CLI output, or HTTP
  responses.
- Git stderr and stdout must be converted into sanitized summaries.
- Remote URLs containing credentials are rejected.
- Sync status does not show remote URL by default.
- Verbose sync status may show a credentials-redacted remote URL.
- API and JSON output prefer vault-relative paths and stable state enums.
- Private absolute paths are avoided by default and shown only in explicit
  human diagnostics where useful.

## Configuration

Specification: [Configuration](specifications/configuration.md).

Phase 2 adds user-local configuration and environment variable overrides for
watching, incremental update behavior, and sync.

Configuration requirements:

- Defaults must preserve local-first and private-by-default behavior.
- Watch configuration controls enablement, debounce, maximum batch delay, and
  initial event behavior.
- Sync configuration controls enablement, repository binding, remote, branch,
  schedule, webhook, timeout, and backoff behavior.
- Private paths, remotes, and secrets must not be stored in repository files.
- Secrets are redacted from normal config, status, logs, and errors.
- Configuration precedence follows Phase 1: CLI flags, environment variables,
  user-local TOML, then built-in defaults.

## Specification Files

Phase 2 specifications live under:

```text
docs/phases/phase-2-automatic-index-updates/specifications/
```

Specification files:

- [Watching](specifications/watching.md)
- [Incremental Indexing](specifications/incremental-indexing.md)
- [Sync](specifications/sync.md)
- [Status API](specifications/status-api.md)
- [Configuration](specifications/configuration.md)
- [Testing And CI](specifications/testing-ci.md)

## Testing And Fixtures

Specification:
[Testing And CI](specifications/testing-ci.md) covers tests and CI concerns.

Testing requirements:

- Tests use only synthetic Markdown fixtures.
- Git sync tests use temporary synthetic Git repositories.
- Webhook tests use synthetic payloads only.
- Watcher, incremental indexing, Git sync, webhook, status, and configuration
  behavior are covered by unit, integration, and CLI smoke tests as appropriate.
- Flaky watcher behavior must be mitigated in CI through fake timers, polling,
  platform-aware assertions, or explicit integration-test isolation.
