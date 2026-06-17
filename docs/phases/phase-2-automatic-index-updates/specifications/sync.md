# Phase 2 Sync Specification

Status: Draft

This file is part of the Phase 2 specification. See ../requirements.md for
requirements and this directory for the domain specifications.

## Configuration

TOML shape:

```toml
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

Defaults:

- `enabled`: `false`
- `remote`: `origin`
- `interval_seconds`: `900`
- `webhook_enabled`: `false`
- `pull_timeout_seconds`: `120`
- `failure_backoff_seconds`: `3600`

Empty `repo` means sync is not configured unless it can be resolved from
`vault.root` during an explicit configure flow.

Remote URLs and private repository paths may be stored only in user-local
configuration. They must not be committed to repository files.

Webhook secrets may be stored only in user-local configuration or environment
variables.

`sync.enabled` controls scheduled sync and whether the server treats Git sync as
active.

Manual `vault-agent sync pull` may run when sync is configured even if
`sync.enabled` is `false`.

Webhook-triggered sync requires:

- Sync is configured.
- `sync.enabled` is `true`.
- `sync.webhook_enabled` is `true`.
- A webhook secret is configured.

If `sync.webhook_enabled` is `true` but `sync.enabled` is `false`, webhook
requests fail with `WEBHOOK_SYNC_NOT_CONFIGURED`.

## Existing Repository Detection

Server startup and `sync status` detect whether `vault.root` is inside a Git
worktree.

If `vault.root` is inside nested Git worktrees, use the nearest enclosing Git
worktree.

Detecting a Git worktree does not enable sync.

`serve` may report that a Git repository was detected and sync is not configured
in status or debug output only.

Normal `search` and `get` responses must not mention Git remote details.

Git executable absence makes sync unavailable, but search, get, index, and watch
continue.

## Commands

Phase 2 includes:

- `vault-agent sync status`
- `vault-agent sync configure`
- `vault-agent sync clone`
- `vault-agent sync pull`
- `vault-agent sync enable`
- `vault-agent sync disable`

### Clone

Command shape:

```bash
vault-agent sync clone <remote-url> --target <path>
```

Options:

- `--branch <branch>`
- `--enable-sync`
- `--index`

Behavior:

- `--target` is required.
- If `--branch` is omitted, use the remote default branch.
- The target path may be saved as `vault.root` in user-local configuration.
- `sync clone` creates Git sync configuration after cloning.
- After clone, `[sync].enabled` remains `false` unless `--enable-sync` is
  specified.
- After clone, initial indexing runs only when `--index` is specified.
- Without `--index`, the command shows `vault-agent index` as the next command.
- If the target directory does not exist, create it.
- If the target directory exists and is empty, cloning is allowed.
- If the target directory exists and is not empty, cloning fails.
- If the target directory is already a Git checkout, suggest `sync configure`.
- The target directory may be outside the current working tree, but must be
  stored only in user-local configuration.
- Remote URLs may use HTTPS or SSH URL forms.
- Remote URLs containing credentials are rejected.
- Git output during clone is sanitized before display.
- Failed clone does not automatically delete a partial target directory.
- Failed clone shows short cleanup guidance.

`sync clone --force` is out of scope for Phase 2.

### Configure

Command shape:

```bash
vault-agent sync configure --repo <path>
```

Behavior:

- If `--repo` is omitted, detect the Git worktree from the current `vault.root`.
- `sync configure` must not modify Git remotes by default.
- `sync configure --remote <name>` selects an existing remote, default
  `origin`.
- If the selected remote does not exist, configuration fails unless
  `--remote-url` is explicitly provided.
- `sync configure --remote-url <url>` may add the selected remote.
- When `--remote-url` is specified and the remote exists with the same URL,
  configuration succeeds without changing it.
- When `--remote-url` is specified and the remote exists with a different URL,
  configuration fails.
- Existing remote URLs may be changed only with explicit
  `--update-remote-url`.
- Remote additions and changes occur only during explicit `sync configure`
  commands.
- `serve` and scheduled sync never change remote configuration.
- The default branch is the current checked-out branch.
- Detached HEAD requires explicit `--branch`.
- The selected branch is stored in user-local configuration.
- Remote URL may be stored in user-local configuration only.
- Remote credentials must not be stored by `vault-agent`.
- Git authentication uses existing Git, SSH, or OS credential mechanisms.
- After `sync configure`, `[sync].enabled` remains `false` unless `--enable` is
  specified.

`--remote-url` and `--update-remote-url` reject remote URLs containing
credentials.

### Pull

`sync pull` performs fetch plus fast-forward-only update by default.

`sync pull --wait` is included in Phase 2.

Behavior:

- `sync pull --wait` waits for an already running sync to finish.
- After waiting, `sync pull --wait` may attempt another pull if needed.
- Default `sync pull --wait` timeout: 120 seconds.
- `sync pull --wait --timeout <seconds>` may specify the wait timeout.
- If another `sync pull` is already running, plain `sync pull` returns
  `409 sync_in_progress`.
- Human-readable CLI output shows a short `sync already running` message.
- JSON output uses the stable error code `SYNC_IN_PROGRESS`.

HTTP `POST /sync/pull` uses the request and response shape defined in
[Status API](status-api.md#http).

Failure behavior:

- Dirty worktree fails sync by default.
- Dirty worktree includes tracked and untracked changes inside the Git worktree.
- Non-fast-forward state fails with an actionable message.
- Merge conflicts fail; they are never resolved automatically.
- Local commits ahead of remote fail by default unless the state is already
  fast-forward-compatible.
- Untracked files that would be overwritten fail sync.
- Fetch or pull network errors fail with warning/status only; the last usable
  index remains available.

## Scheduling

Scheduled sync default when enabled: every 15 minutes.

Minimum allowed interval: 1 minute.

Recommended normal interval range: 5 to 30 minutes.

Manual `vault-agent sync pull` runs immediately.

If a scheduled pull is still running, the next scheduled run is skipped.

If pull fails, retry on the next scheduled interval.

After three consecutive failures, retry no more often than every 60 minutes
until one succeeds.

Pull timeout default: 120 seconds.

Scheduled sync runs only while the server process is running. OS-level service
or cron installation is out of scope for Phase 2.

## Changed Path Handling

Successful fetch or pull with no worktree file changes does not run an index
update.

Successful fetch or pull with indexed-file changes marks the index stale
immediately and follows the watcher debounce and maximum delay policy.

Successful fetch or pull with only excluded-file changes does not run an index
update.

Changed path detection compares Git results against effective indexed
extensions and exclude rules.

If changed-path detection is uncertain, prefer marking stale. Do not reindex
immediately unless watcher or incremental logic confirms relevant changes.

## Concurrency

Git sync execution is single-flight per configured repository or worktree.

Rules:

- If scheduled sync fires while manual sync is running, scheduled sync is
  skipped.
- If webhook sync fires while manual sync is running, the webhook event is
  recorded as pending.
- If manual sync is requested while scheduled or webhook sync is running, the
  request returns `409 sync_in_progress` by default.
- Manual sync supports `--wait` to wait for the current sync and then
  optionally run again.
- Multiple webhook events during an active sync are coalesced into one pending
  sync.
- Multiple scheduled ticks during an active sync are skipped, not queued.
- After active sync completes, one pending webhook sync may run after the
  webhook debounce window.
- If the active sync already pulled the latest remote state, the pending webhook
  sync should become a no-op after fetch/status check.
- If a sync lock appears abandoned after 10 minutes, report an error and require
  manual status or recovery.
- Index updates are also single-flight.
- Sync may mark the index stale while an index update is running, but it must
  not start a second concurrent index writer.
- Search and get during sync use the last usable index and may report
  `sync_in_progress`.
- Search and get during index update use the last usable index until the new
  update commits atomically.
- Failed sync does not trigger index update unless worktree changes were
  actually applied before failure.

## Webhook Sync

Webhook sync is disabled by default.

Endpoint:

```text
POST /sync/webhook
```

Authentication:

- The webhook is authenticated with a webhook secret, not the normal API key.
- Secret is passed in `X-Vault-Agent-Webhook-Secret`.
- Secret in query parameters is not supported.
- Secret comparison uses timing-safe comparison.
- Secret mismatch responses do not include detailed reasons.

Behavior:

- Webhook sync is enabled only when `[sync].webhook_enabled = true`.
- Webhook-triggered sync still requires `[sync].enabled = true`.
- The webhook secret is stored only in user-local configuration or environment
  variables.
- The webhook secret is not shown in normal config or status output.
- Webhook payload is not trusted.
- Webhook payload changed-file lists are not used as the basis for index
  updates.
- A webhook is treated only as a signal requesting sync pull.
- After receiving a valid webhook, the server attempts sync pull after a
  60-second debounce.
- Webhooks received while sync is running coalesce into one pending sync.
- Webhook request body size limit default: 64 KiB.
- Webhook endpoint does not depend on content type.
- Webhook responses must not include remote URL or branch details.
- If webhook is used outside localhost binding, documentation must state that it
  assumes API key protection or a private network.
- GitHub and GitLab specific signature verification is not required in Phase 2.
- The implementation should allow future GitHub or GitLab specific signature
  verification to be added.

Webhook response behavior:

- Disabled webhook returns `404` or `403` with `WEBHOOK_DISABLED`; the
  specification does not require exposing that the route exists.
- Missing webhook secret configuration returns `503` with
  `WEBHOOK_SECRET_NOT_CONFIGURED`.
- Invalid webhook secret returns `401` with `WEBHOOK_SECRET_INVALID`.
- Oversized request bodies return `413` with `WEBHOOK_BODY_TOO_LARGE`.
- Valid webhook requests return `202` when sync is scheduled or coalesced.
- If sync is not configured or not enabled, return `409` with
  `WEBHOOK_SYNC_NOT_CONFIGURED`.
- If a valid webhook is accepted while sync is running, return `202` and record
  one pending webhook sync instead of returning an error.

Webhook rate limiting:

- Rate limiting applies after secret validation.
- More than 60 valid webhook requests per minute per server process returns
  `429` with `WEBHOOK_RATE_LIMITED`.
- Rate-limited requests do not enqueue additional sync work.
- Multiple accepted webhook requests inside the debounce window coalesce into
  one pending sync.

## Error Codes

Sync error codes:

- `SYNC_IN_PROGRESS`
- `SYNC_WORKTREE_DIRTY`
- `SYNC_DETACHED_HEAD`
- `SYNC_NON_FAST_FORWARD`
- `SYNC_CONFLICT`
- `SYNC_GIT_UNAVAILABLE`
- `SYNC_AUTH_FAILED`
- `SYNC_NETWORK_FAILED`
- `SYNC_TIMEOUT`
- `SYNC_REMOTE_REF_MISSING`
- `SYNC_INVALID_REMOTE_URL`
- `SYNC_REMOTE_URL_CONTAINS_CREDENTIALS`
- `SYNC_GIT_FAILED`

Webhook error codes:

- `WEBHOOK_DISABLED`
- `WEBHOOK_SECRET_NOT_CONFIGURED`
- `WEBHOOK_SECRET_INVALID`
- `WEBHOOK_BODY_TOO_LARGE`
- `WEBHOOK_SYNC_NOT_CONFIGURED`
- `WEBHOOK_SYNC_IN_PROGRESS`
- `WEBHOOK_RATE_LIMITED`
- `WEBHOOK_INVALID_METHOD`
- `WEBHOOK_UNKNOWN_ERROR`

Error messages must be sanitized and must not include raw Git stdout, raw Git
stderr, credentials, private absolute paths, or remote URLs containing
credentials.
