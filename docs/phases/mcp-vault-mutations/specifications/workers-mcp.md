# Workers MCP mutations (#54, step 4d)

Status: Implemented and locally verified; disabled by default. The R2 ETag/generation
boundary was accepted for #54 on 2026-11-03. The hosted lexical smoke test passed.

## Configuration and transport

Worker settings mirror the local write settings: `WRITE_ENABLED=false`,
`WRITE_MODE=review`, `WRITE_MAX_FILE_BYTES=5242880`,
`WRITE_MAX_BATCH_BYTES=20971520`, `WRITE_MAX_BATCH_OPERATIONS=20`,
`WRITE_HISTORY_RETENTION_DAYS=7`. Settings are deployment-local; credentials stay
in the existing read/admin secrets. Reject malformed values, unsupported runtime
limits. pCloud supports explicit `WRITE_MODE=direct` with the same issued-ID
allocation (`preview_changes` with `preview:false`) and exact-request apply
workflow as R2. It remains Markdown-only and requires exclusive write ownership;
direct mode does not make the provider version check/write atomic. Enabling requires ingestion/Cron enabled
and migrations through 0008 so asynchronous indexing/recovery can progress.

Expose the shared `preview_changes`, `apply_changes`, `get_change_status` schemas
only to an authenticated READWRITE or ADMIN caller when explicitly enabled. Every HTTP request
authenticates current credentials before buffering its body; an ID, a session
header or client-provided auth metadata is never permission. Worker MCP remains
stateless. Authorize the entire batch before executing any message; a read caller
cannot hide a mutation behind an allowed search. Recheck at tool dispatch.

Read callers and disabled deployments retain a 64 KiB raw JSON limit. Enabled
READWRITE/ADMIN MCP requests have a 32 MiB received-byte limit applied while streaming,
before JSON/Base64/patch preparation. Other routes keep their existing limits.
Return only fixed sanitized errors. Review mode requires a preview binding.
Direct mode also obtains a signed ID before application. Preview performs no
D1 writes. Apply records the operation in D1 before mutating the source. The
client handles human confirmation and treats note and guidance text as untrusted.

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
Hosted Vectorize cleanup is covered by the semantic trial below. The R2 condition compares ETag;
the last generation check cannot turn it into a generation-ID CAS or cancel an
already-dispatched storage request.

The production Worker entrypoint passes 16 synthetic HTTP/MCP cases, including
an actual SDK client, within the 179-case Cloudflare workerd suite. The local
suite passes 910 cases after extracting shared mutation tool definitions.
These results cover local workerd only.

## Hosted lexical smoke test (2026-11-03)

Deployed the production Worker entrypoint with a disposable D1 database and
private R2 bucket, applied all migrations, and enabled writes for this trial.
The real HTTP MCP endpoint listed 21 tools for admin and 18 for read, and
rejected read-key preview. A synthetic note passed create, immediate explicit
retrieval, replacement, and deletion. Replaying each apply returned the same
result. Advancing the index through its HTTP API made the note searchable,
and deletion suppressed the old search result before the next publication.
Both publications completed.

The first attempt stopped at bundling because the generated Wrangler config
used an absolute TypeScript config path. The retry used relative paths. Both
attempts ended with the Worker, D1 database, and R2 bucket confirmed absent
from the Cloudflare account inventory. The scheduled R2 reclamation evidence
above is from workerd with an aged retirement record. Hosted Vectorize was
outside the lexical trial.

## Hosted Cron follow-up (2026-11-03)

A separate isolated lexical deployment used the production entrypoint and a
one-minute Cron schedule. The first attempt saw no ingestion jobs during a
six-minute observation window. The retry allowed up to 18 minutes for the
initial observation because [Cloudflare documents up to 15 minutes for Cron
configuration propagation](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
This does not establish the cause of the first timeout.

The retry used no HTTP index or job-advance calls. Read-only polling observed
the created note in search after 525 seconds, its replacement after 62 seconds,
and a new publication revision after deletion after 61 seconds. The deleted
note was already unavailable to explicit retrieval and search before publication.
These are observations from one trial. Both trials ended with the temporary
Worker, D1 database, and R2 bucket absent from the account inventory.

## Hosted semantic deletion and reclamation

An isolated production Worker used a dedicated 1024-dimension cosine Vectorize
index with a `chunkId` metadata index. Workers AI embedded two synthetic notes
with explicit consent for the trial. Both notes appeared in meaning-based
search before deletion. MCP deletion immediately suppressed the target while
its old vector IDs were still listed by Vectorize and the control note was
still searchable.

After incremental publication, the trial aged only the target's retirement
records to cross the 24-hour cutoff. Cron removed the target vectors and cleared
their retirement records within 328 seconds of the start of the cleanup
observation. The control's original vector IDs remained listed and its note
still appeared in meaning-based search. This measured an age-equivalent cleanup
rather than waiting out the full retention period.

Earlier attempts encountered a Wrangler authentication error, a visibility
observation window that expired during indexing, and a smoke-driver assumption
that initial vectors were stored in the incremental vector-work table. The
successful driver resolved both initial and incremental vector IDs and used a
longer visibility window. Every attempt ended with the temporary Worker, D1,
R2, and Vectorize resources confirmed absent from the account inventory.

READWRITE configuration, rotation and exact route/tool permissions are defined in
[shared access control](../../phase-1-retrieval-foundation/specifications/access-control.md#readwrite-credential-setup-73).
