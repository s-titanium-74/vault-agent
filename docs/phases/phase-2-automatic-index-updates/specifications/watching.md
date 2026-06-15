# Phase 2 Watching Specification

Status: Draft

This file is part of the Phase 2 specification. See ../requirements.md for
requirements and this directory for the domain specifications.

## Configuration

TOML shape:

```toml
[watch]
enabled = true
debounce_ms = 10000
max_batch_delay_ms = 60000
ignore_initial = true
```

Defaults:

- `enabled`: `true`
- `debounce_ms`: `10000`
- `max_batch_delay_ms`: `60000`
- `ignore_initial`: `true`

`debounce_ms` is the time after the last filesystem event before an incremental
update starts.

`max_batch_delay_ms` is the longest time a batch may wait after the first
filesystem event before an incremental update starts.

`ignore_initial` means startup discovery events from the watcher backend do not
schedule updates. Startup stale detection is handled by index freshness checks,
not by initial watcher events.

## Lifecycle

Watcher lifecycle states:

- `disabled`
- `starting`
- `running`
- `degraded`
- `stopped`
- `unavailable`

The server may start when the watcher is disabled, degraded, stopped, or
unavailable.

Watcher startup failure must not crash the server by default. The failure is
reported through `vault-agent status`, `vault-agent watch status`, and
`GET /status`.

If the server shuts down during a pending watcher update, the pending update is
discarded. The next startup uses index freshness detection to identify stale
state.

## Path Filtering

Watcher events are normalized to vault-relative paths before filtering.

Filtering order:

1. Reject paths that resolve outside the configured vault root.
2. Ignore generated index and data directories.
3. Apply Phase 1 default exclusions.
4. Apply user-configured exclusions.
5. Ignore hidden paths by default.
6. Classify remaining paths as Markdown notes, attachments, or irrelevant
   files.

The watcher must not emit private absolute paths in status JSON, logs, warnings,
or errors by default.

## Event Handling

The watcher handles create, modify, delete, and rename events.

Rename events may be represented as delete plus create when the host platform or
watcher library does not provide reliable rename events.

Event mapping:

- Created Markdown files schedule an incremental add.
- Modified Markdown files schedule an incremental update.
- Deleted Markdown files schedule indexed-note removal.
- Created or modified discoverable attachments schedule attachment metadata
  refresh.
- Deleted discoverable attachments schedule attachment metadata removal or
  missing-marker update.
- Excluded path changes are ignored.
- Hidden path changes are ignored by default.

Rapid changes are coalesced into one incremental update.

`vault-agent index` is a manual override and runs without waiting for the
watcher debounce window.

## Pending Batches

Pending watcher batches track:

- First event time.
- Last event time.
- Vault-relative changed path count.
- Whether any changed path may affect indexed Markdown content.
- Whether any changed path may affect attachment metadata.

If changed-path classification is uncertain, the index should be marked stale
instead of assuming freshness.

Pending path samples in human-readable diagnostic output must be vault-relative.
JSON status should return counts and state, not raw private paths by default.

## Search Behavior During Watcher Updates

Search and related requests use the last usable committed index while an update
is pending, updating, or failed.

Human-readable search output may show a short freshness warning when a pending,
stale, or failed watcher update may affect results.

JSON search and related responses include warnings in the response warnings
array.

`get` warns only when stale state may affect ID lookup or chunk resolution.

## Error Codes

Watcher error codes:

- `WATCHER_UNAVAILABLE`
- `WATCHER_PERMISSION_DENIED`
- `WATCHER_TOO_MANY_FILES`
- `WATCHER_EVENT_OVERFLOW`
- `WATCHER_PATH_OUTSIDE_VAULT`
- `WATCHER_UNKNOWN_ERROR`

Error messages must be short, actionable, and public-safe.
