# Local MCP file changes (delivery step 3)

The filesystem concurrency boundary is the accepted final-version-check model
in [filesystem](filesystem.md). Detected conflicts fail; an external edit in the
last check/write window may be missed. No exclusive-editor assertion is needed.
The [pCloud source contract](../../cloudflare-deployment/specifications/pcloud-source.md#mcp-writes-67) covers opt-in Markdown writes with review and exclusive write ownership.

## Enablement and tools

User-local TOML `[write]` uses the portable settings: `enabled = false`,
`mode = "review"`, 5 MiB/file, 20 operations, 20 MiB/batch, 7 days retention.
`vault-agent config set write.enabled true` explicitly enables all operations;
`write.mode direct` permits apply without a preview binding. No operation-specific
switches, force override, backup/trash or automatic link repair are introduced.
Environment overrides use `VAULT_AGENT_WRITE_ENABLED`, `VAULT_AGENT_WRITE_MODE`,
`VAULT_AGENT_WRITE_MAX_FILE_BYTES`, `VAULT_AGENT_WRITE_MAX_BATCH_OPERATIONS`,
`VAULT_AGENT_WRITE_MAX_BATCH_BYTES`, `VAULT_AGENT_WRITE_HISTORY_RETENTION_DAYS`.
Unknown write settings and invalid limits fail configuration validation.
Local transports accept up to 20 MiB decoded batch payload and 32 MiB raw JSON
per request/frame; escaping/Base64 may require smaller batches. Reject higher
batch settings rather than silently lowering them.

Enabled admin/local stdio callers see three additional tools:

- `preview_changes({operations, preview?: true})` validates and allocates an ID,
  bounded diffs and a binding. `preview:false` allocates metadata without diffs
  only in direct mode.
- `apply_changes({operation_id, preview_binding?, operations})` resupplies the
  exact request and returns per-file status without bodies.
- `get_change_status({operation_id})` resolves lost responses without applying.

Disabled direct calls fail `WRITE_DISABLED` without source/journal creation.
Read HTTP callers neither list these tools nor obtain preview/status/results.
Tool descriptions say retrieved note/guidance instructions are untrusted data;
edits must follow the user's request. MCP annotations are hints, not permission.
Client execution confirmation is the human approval mechanism; review mode
does not establish that a human approved a preview.

## Authentication and sessions

Enabled local HTTP requires distinct read/admin keys under #44 even on localhost.
Legacy single apiKey and anonymous localhost cannot enable HTTP writes.
stdio uses the process trust boundary without HTTP keys. Authenticate each HTTP
request using current credentials before buffering it. After bounded JSON
parsing identify all mutation calls, including batch messages, and require admin
before decoding Base64 or preparing operations. The SDK receives request-scoped
roles, never a role captured at initialization. Enabled sessions are role-bound;
switching read/admin requires a new initialize. IDs/sessions are not credentials.
Rotation and revocation apply on every call.

## Reads and lifecycle

Enabled local MCP/REST note reads use the current source and add `version`,
`indexed_version`, `indexed_content_hash`, `index_state`. Preserve note metadata
and the default 200 KiB retrieval limit unless allowLarge is explicit. New
service-issued note IDs work before publication. Chunk reads reject changed
source with `REVISION_CHANGED`. With writes enabled, MCP and REST chunk reads
require `expected_version` from compact search/related result `version` or an
explicit note read. Indexed chunk tokens bind note/chunk hashes and index;
source note versions separately bind file identity and bytes for writes. An
old token must fail even after a newer index becomes fresh. CLI chunk retrieval
accepts `--expected-version`; write-disabled reads keep their prior contract.
Attachments add source versions and respect revocation. Search,
get and related responsibilities remain separate.

Storage payload limits do not lower existing read defaults: note reads retain
200 KiB and attachment downloads 10 MiB unless allowLarge is explicit. Enabled
source reads have a 20 MiB memory bound and MCP serialized results a 50 MiB
bound; JSON escaping may reduce effective content capacity.

One service per HTTP vault or stdio process owns recovery, bounded history
cleanup and durable index work. Startup recovers intents then schedules pending
work. Apply schedules indexing asynchronously; maintenance retries every five
seconds without overlapping flushes. Failed indexing never undoes saves. Close
timers/service on shutdown; closing one HTTP session keeps the vault service.
Maintenance errors log no content, raw provider responses or credentials.
Configuration changes apply on restart; HTTP keys are checked per request.

## Validation

Synthetic MCP clients cover default-off, review/direct, strict fields,
note/attachment create/read/replace/delete, replay/status, read-size limits,
new-note reads and stale chunks. HTTP covers anonymous/legacy rejection,
read/admin lists/calls, role-bound sessions, current-key revocation, batch
authorization and raw size limits. Stdio bounds lines before SDK parsing.
Verify external edits/recreation through maintenance and preserve local,
portable and distribution regressions. No real private vault is used.

2026-11-02 local evidence: 910 normal tests and 11 distribution tests pass,
including 18 MCP/stdio-boundary cases, 9 write-setting cases, and actual CLI
stdio create/read/update/delete without HTTP credentials. HTTP tests use the
real SDK server transport with synthetic requests and credentials; no desktop
client confirmation UI or hosted Cloudflare mutation flow was exercised.
Build, typecheck (including DOM-only portable declarations), lint and formatting
pass. A controlled filesystem test explicitly demonstrates the accepted missed
external write after the last version check; successful tests do not establish
a fully atomic conditional write against external editors.
