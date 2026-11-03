# Workers MCP mutations (#54, step 4d)

Status: Implemented and locally verified; disabled by default. R2's ETag/generation
boundary is awaiting explicit confirmation. No existing deployment is enabled
by this implementation work.

## Configuration and transport

Worker settings mirror the local write settings: `WRITE_ENABLED=false`,
`WRITE_MODE=review`, `WRITE_MAX_FILE_BYTES=5242880`,
`WRITE_MAX_BATCH_BYTES=20971520`, `WRITE_MAX_BATCH_OPERATIONS=20`,
`WRITE_HISTORY_RETENTION_DAYS=7`. Settings are deployment-local; credentials stay
in the existing read/admin secrets. Reject malformed values, unsupported runtime
limits and enabled writes on pCloud. Enabling requires ingestion/Cron enabled
and migrations through 0008 so asynchronous indexing/recovery can progress.

Expose the shared `preview_changes`, `apply_changes`, `get_change_status` schemas
only to an authenticated admin when explicitly enabled. Every HTTP request
authenticates current credentials before buffering its body; an ID, a session
header or client-provided auth metadata is never permission. Worker MCP remains
stateless. Authorize the entire batch before executing any message; a read caller
cannot hide a mutation behind an allowed search. Recheck at tool dispatch.

Read callers and disabled deployments retain a 64 KiB raw JSON limit. Enabled
admin MCP requests have a 32 MiB received-byte limit applied while streaming,
before JSON/Base64/patch preparation. Other routes keep their existing limits.
Return only fixed sanitized errors. Review mode requires a real preview binding;
direct mode still allocates an issued ID before application. A client execution
prompt controls human confirmation; note/guidance text is untrusted input.

## Retrieval and lifecycle

When enabled, explicit note/attachment reads expose a current source version even
for indexed paths never edited through MCP. Only server-known indexed or managed
note IDs resolve to paths. Search/related chunk references include their indexed
version; `get_chunk` requires `expected_version` when writes are enabled and
rejects stale references even after a newer index is fresh. Default read-only
deployments retain their existing retrieval semantics. Durable suppression stays
active when writes are later disabled.

Save success remains independent of source observation/indexing. Existing bounded
Cron maintenance/index publication resumes without a connected client. New notes
resolve by their server-generated IDs before indexing. Deletion responses include
bounded detected incoming references and an index-staleness/incompleteness warning;
references do not prevent deletion or trigger link repair. No source bytes/diffs
are stored in audit rows or application logs.

## Validation and remaining acceptance

Use synthetic workerd/SDK clients for default-off behavior, role-separated tool
lists/calls, mixed batches, credential rotation, body limits, request identity,
lost responses, latest reads, patching and note/attachment deletion. The lexical
deletion regression verifies that incremental publication removes the active
D1 chunks and schedules the immutable R2 copy for retirement. The Worker
scheduled handler preserves that copy during retention, then removes it after
the test ages the retirement record, preserving the active copy of another note.
Hosted validation and hosted Vectorize cleanup evidence remain open. The R2 condition compares ETag;
the last generation check cannot turn it into a generation-ID CAS or cancel an
already-dispatched storage request.

The production Worker entrypoint passes 16 synthetic HTTP/MCP cases, including
an actual SDK client, within the 179-case Cloudflare workerd suite. The local
suite passes 910 cases after extracting shared mutation tool definitions.
These results do not close the outstanding guarantee decision or hosted gates.
