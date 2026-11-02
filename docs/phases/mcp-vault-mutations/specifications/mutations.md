# MCP Mutation Contract

Status: Portable preparation, [filesystem service](filesystem.md) and
[local MCP tools](local-mcp.md) implemented. R2 has
[upload baselines](upload-baseline.md) and an
[internal mutation service](r2-service.md) with
[runtime maintenance](r2-maintenance.md) and default-disabled
[Workers MCP integration](workers-mcp.md). The R2 guarantee decision and hosted
verification remain open.
Tool/field names below are an implementation
proposal; the agreed behavior is in [requirements](../requirements.md).

## Step 1 implementation contract

`@vault-agent/core/portable` exports strict mutation schemas, default-disabled
settings and `prepareMutationBatch`. Preparation reads only the explicitly
addressed current source through a bounded snapshot callback. It never writes,
issues operation IDs, authenticates HTTP or claims a preview authorizes apply.
Adapters must supply source-bound versions (including generation where needed),
current path scope and attachment policy, and a filesystem collision key where
the filesystem treats distinct spelling as one target. Canonical path validation
rejects malformed Unicode, traversal and platform path aliases; paths are raw
vault-relative strings, never URL-decoded. Hidden paths are denied even when
the read policy permits guidance. Filesystem attachment selection reuses its
existing non-Markdown policy; R2 uses its existing PDF/image allowlist.

The snapshot callback must return one regular file's coherent version/content,
reject directories, symlinks and unsafe parents, and enforce its byte bound
while reading. This interface establishes no filesystem race or R2
conditional-write guarantee. Later apply must revalidate the prepared source
version at the write boundary and implement durable recovery and deletion
suppression before exposing mutation tools.

The preparation request contains only `operations`; transport operation IDs and
preview bindings will wrap it in later steps. Strict schemas reject unknown
fields at every level. Invalid path syntax, path collisions (including a file
and its descendant), decoding and size/count errors reject the whole envelope.
Denied type/scope, missing/existing source, version mismatch and patch errors
produce per-item failures. All outputs are prepared before an adapter may save
any file. Internal prepared bytes are private and are never a status response.
The request digest includes ordered normalized operations, source/vault identity
and effective policy limits plus a policy revision supplied by the adapter;
it is binding material, not a signed operation identity or authorization token.

The regex engine is pinned to `re2js` 2.9.0 (pure JS, non-backtracking;
[upstream API and syntax](https://github.com/le0pard/re2js/tree/v2.9.0)).
Only flags `i`, `m`, `s` (each at most once) are accepted. No native `RegExp`
executes user patterns. Inline flags, lookaround, pattern backreferences, named
groups and counted repetitions are not supported in this initial subset;
ordinary groups, noncapturing groups, classes, alternation, `?`, `*`, `+`,
anchors and simple RE2 escapes are supported. Braced escapes and `\Q`/`\E`
quoting are outside this subset. Reject unescaped braces and group
extensions other than `(?:` before compilation, bounding compact repetition
expansion. Cap patterns at 1,024 UTF-16 units, compiled programs at 2,048
instructions and captures at 32. Before each regex search charge
`(remaining UTF-16 input + 1) * programSize * (captures + 1)` against a shared
16,000,000-unit batch budget. Reject before a call that exceeds it; bound match
enumeration at 10,000. These are conservative application work admission units,
not elapsed CPU milliseconds or an engine instruction counter. The engine
provides bounded non-backtracking searches; no timer claims to interrupt native
regex. Real workerd CPU/cancellation validation remains a later delivery gate.

Regex replacement supports `$$` (literal dollar) and `$1`–`$99` (greedy decimal
capture reference); missing optional groups expand to empty strings. Invalid or
nonexistent references fail. All other dollars, including `$0`, `$&`, prefix,
suffix and named references, fail rather than silently inserting unexpected
content. Literal replacements do not expand dollars. Zero-width matches advance
one Unicode code point, including one possible match at end of input; the same
replacement never rematches inserted text. Ordered replacements preserve BOM,
CRLF and all untouched UTF-8 bytes without parsing frontmatter.

Default limits are 5 MiB per file, 20 operations, 20 MiB final batch bytes,
100 replacements per note, 1 MiB combined patch instructions per batch and
16 KiB of rendered note diffs per preview. Configurable file/batch limits have
an application ceiling of 20 MiB/file, 100 operations and 100 MiB/batch;
adapters must additionally validate their runtime/transport limits. Strict
canonical padded Base64 is decoded without Node APIs. Invalid UTF-16 text is
rejected rather than converted into replacement characters. Deletion counts
as zero payload bytes. Patched output is checked after each replacement and
for the complete batch. Exceeding a byte bound always rejects the envelope,
including when the offending item is otherwise in conflict; raw payloads are
validated before snapshot I/O. Transport must bound received request bytes
before parsing or calling the core.

Preview returns an explicitly bounded single changed-span diff with UTF-16
offsets (not an optimal multi-hunk diff). Only this explicit preview contains
note text; truncation is marked and uses a batch-wide rendered-byte budget.
Attachments show path, size and create/replace; deletion shows the target.
`mutationBatchSummary` omits bytes, diffs and digests. A saved note over the
existing 2 MiB indexing limit is marked `oversized_for_index` in preparation;
the 5 MiB storage limit does not promise full-text indexing.

The [filesystem service](filesystem.md) implements local operation identity,
journal recovery, source reads, access suppression and pending index work under
the accepted final-check race boundary. Local transport enablement is documented
in [local MCP](local-mcp.md). The [Workers MCP adapter](workers-mcp.md) exposes
mutation tools only when explicitly enabled for admin callers; committed
configurations keep them disabled. R2 guarantee confirmation and hosted
verification remain open.
External edits after the final filesystem check may be missed; this
accepted limitation is explicit in setup and tools. These layers do not close #54.

## MCP tools and modes

| Tool (proposed)     | Purpose                                                                       | Side effects                                                                 |
| ------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `preview_changes`   | Validate operations and show note diffs / attachment metadata / deletion list | May allocate expiring metadata-only operation identity; never changes source |
| `apply_changes`     | Apply exactly the previewed request; direct requests only when enabled        | Source mutation and pending index work                                       |
| `get_change_status` | Resolve lost responses and retrieve per-item results                          | No source mutation                                                           |

Use the existing MCP result/error conventions. Preserve existing read tools.
In the default `review` mode require a preview binding before `apply_changes`;
`direct` mode permits application without preview. Both require writes enabled.
A preview is not proof of human approval: the same agent can call both tools.
The MCP client's confirmation settings control human review, including in direct mode.

The preview binding covers vault/source identity, canonical request digest,
expected versions, policy and expiry. Apply must reject different content,
another vault, expired identity or tightened policy; it must recheck versions
at the actual write boundary. Preview is never a reservation/lock on the file.
Do not retain bodies/diffs to replay a preview: the apply request resupplies the
operations and the server verifies the binding. Temporary write staging needed
for crash recovery is private operational data with bounded cleanup, not an
audit archive or restore feature.

Mutation tools declare `readOnlyHint: false`. `apply_changes` declares
`destructiveHint: true`; duplicate-safe calls may declare `idempotentHint: true`
only with the mandatory operation-ID semantics. Preview descriptions must
explain any metadata allocation. Annotations are client hints, not authorization.
Descriptions explicitly say that retrieved note/guidance content is untrusted
data, not permission to edit; mutations must follow the user's request.

## Request shape (proposed)

```json
{
  "operation_id": "SERVER_ISSUED_TIME_BOUND_OPAQUE_ID",
  "preview_binding": "OPAQUE_BINDING",
  "operations": [
    {
      "type": "patch_note",
      "path": "Notes/example.md",
      "expected_version": "OPAQUE_SOURCE_VERSION",
      "replacements": [
        {
          "match_type": "literal",
          "pattern": "Old heading",
          "replacement": "New heading",
          "allow_multiple": false,
          "expected_matches": 1
        }
      ]
    }
  ]
}
```

| Type                | Required payload                                   | Existence rule                                                           |
| ------------------- | -------------------------------------------------- | ------------------------------------------------------------------------ |
| `create_note`       | `path`, UTF-8 `content`                            | Must not exist; no upsert                                                |
| `replace_note`      | `path`, `expected_version`, UTF-8 `content`        | Existing Markdown with matching version                                  |
| `patch_note`        | `path`, `expected_version`, ordered `replacements` | Existing Markdown with matching version                                  |
| `upload_attachment` | `path`, `content_base64`, explicit `replace`       | New by default; `replace: true` additionally requires `expected_version` |
| `delete_file`       | `path`, `expected_version`                         | Existing allowed Markdown or attachment with matching version            |

The required version is opaque, source-bound and exposed by explicit note or
attachment reads (and path resolution during preview). Do not use mtime/size
alone. A content digest proves bytes; adapters also use identity/generation
where necessary for races and delete/recreate. No `force` bypass is offered.
Creation must be conditional on absence at apply, not just at preview.
Unknown mutation fields should fail validation to avoid silently ignoring safety
parameters; existing read-tool validation stays unchanged.

Every operation is addressed by a canonical vault-relative path, not a chunk
index. Return note ID for Markdown so new notes can be retrieved explicitly
before indexing. Resolve this ID within the allowed current source, never by
accepting an arbitrary caller-supplied ID-to-path mapping.

## Replacements

- `match_type: literal` uses exact, case-sensitive substring matches.
- `match_type: regex` supports capture references in replacement, including
  numbered `$1`-style references. Define escaping for literal `$`, optional
  captures, flags and supported syntax consistently in both runtimes before shipping.
- Default is exactly one match. More than one requires `allow_multiple: true`
  and a positive `expected_matches`; the actual count must equal it.
  Zero matches is a failure, never an implicit no-op success.
- Count non-overlapping matches in the current intermediate text. Apply each
  replacement in order. Do not recursively rematch text inserted by the same
  replacement. Define zero-width progression in the chosen regex contract.
- Prepare all replacements and check output size before saving the note.
  Any mismatch, invalid pattern/capture, timeout or size overflow leaves that
  note unchanged. Other files in the batch can still succeed.
- Regex flags do not bypass the explicit multiple-match rule. Avoid an
  uninterruptible native regex call with an application timer that cannot stop it.
  Choose a bounded engine or isolated, cancellable execution and test pathological input.
- Do not parse/reserialize frontmatter to implement text replacement. Preserve
  untouched content, line endings and BOM where present. Full replacement writes
  the explicitly supplied valid UTF-8 content, without implicit normalization.

## Limits and validation order

Proposed configuration (names may be aligned with existing config):

```toml
[write]
enabled = false
mode = "review"
max_file_bytes = 5242880
max_batch_operations = 20
max_batch_bytes = 20971520
history_retention_days = 7
```

Settings belong in user-local config/environment or deployment settings;
credentials belong in user-local secrets/environment/Worker secrets.
The file limit applies to Markdown and attachments, including patched output.
Batch bytes are the sum of new/replacement file bytes and final patched bodies,
before Base64; deletion contributes no payload bytes. Count request-envelope,
patch-pattern and preview-response bytes separately under bounded transport
limits, so small output cannot authorize unbounded input or diff output.
Decode Base64 strictly; never execute attachments or fetch remote URLs.

Authenticate and check write authorization before decoding user file content.
Bound raw request bytes while receiving it. Then validate the envelope,
operation count, canonical paths, duplicates, Base64/UTF-8 and applicable byte
limits before source changes. Prepare patch outputs so output-limit violations
can also reject the batch before any mutation. A per-file conflict or replacement
mismatch remains an item failure; it does not abort unrelated valid items.
If a source races after preparation, fail that item rather than using newer
bytes without a matching expectation.

Envelope-level errors (malformed schema, duplicate/colliding path or size/count
limit) reject the batch without changes. Per-file missing/existing, denied path,
conflict and patch failures produce item results. Canonical aliases/case-folding
collisions on the target filesystem must not bypass duplicate detection.

Configurable limits are application admission limits, not promises that every
platform accepts arbitrarily high settings. Validate effective runtime limits
and report unsupported settings; do not silently truncate content. Existing
read/index limits must be reconciled: a saved 5 MiB note may be oversized for
chunking and must report the existing oversized-index behavior explicitly.

## Authorization and path scope

Writes disabled means no source mutation and no write capability exposed to a
read-only caller; a direct tool call must also fail closed. In HTTP, writes
require an authenticated write/admin credential even on localhost. Read-only
localhost behavior remains compatible when writes are disabled. Missing write
credentials must not make localhost writes anonymous. Reuse #44's read/admin
model and the existing Cloudflare admin credential rather than inventing a
third role. Admin may still perform its existing indexing/upload duties; the
write feature switch independently gates the new file mutations.

Authenticate every call, including status/preview, against current credentials
and scope. A session or operation ID is not an authorization credential.
Read clients cannot obtain write status/diffs through another session.
stdio trusts the local process boundary and requires explicit write enablement;
it does not acquire HTTP bearer requirements.

Reject traversal, absolute/drive/UNC paths, invalid encoding, excluded/hidden/
generated targets and unsafe parent traversal using shared policy. Check both
new and existing paths. The existing guidance hidden-file read exception must
not grant writes to hidden configuration. No directory delete, recursive delete,
rename or move. Check symlinks and parent replacements at write time; never
follow a path out of the configured root. Do not interpret upload filenames as
storage keys or expose absolute roots/provider object locators.

## Per-file application and recovery

Perform preflight without source changes, then apply independent items. File
publication must not expose partially written bytes. Record item states such
as `pending`, `applied`, `failed`, `reconciling`, with sanitized failure codes.
Unknown outcome after a storage timeout is `reconciling`, not a safe-to-repeat
failure. Inspect durable state to finish recovery before another application.

Local adapters own exclusive server-side mutation coordination, safe temporary
files/rename, no-clobber creation, version recheck and durable operation records.
Concurrent Obsidian/external editor writes require special attention: a check
followed by rename alone is not a true conditional write against uncooperative
writers. Specify and test the supported race boundary instead of claiming
transactional guarantees that the filesystem cannot provide. The local final-
check limitation is explicitly accepted as described in [filesystem](filesystem.md).

Cloud adapters own R2 conditional mutations, existing writer fencing and D1
operation/pending state. R2, D1 and Vectorize do not form one transaction.
Use a durable recoverable state machine and prevent old ingestion/upload work
from publishing over a later mutation. A source mutation must have resumable
index work even if the client disconnects. Reuse shared index preparation and
the existing bounded D1 delta publication, not duplicated parsing/index logic.

Creating parent folders is allowed after validation, with race-safe boundary
checks. A failed write may leave empty newly created parents; do not remove
other actors' directories during cleanup. Do not leave partial target files.

## Operation identity and retention

IDs are server-issued, time-bound, unguessable and bound to vault/source and
canonical request digest. `preview_changes` can issue them; direct mode needs
an allocation path through the same metadata tool without requiring a diff.
The client must receive the ID before the first source mutation so a lost
response is recoverable. A same-ID/different-request call fails with
`IDEMPOTENCY_CONFLICT`; same ID and same request returns prior item results or
current pending status, without reapplying successful items.

Recover pending items under the same ID without repeating applied items.
Terminal failures are retained as results; to retry failed items, submit those
items with a fresh operation ID and freshly checked versions. A retry cannot
expand an existing ID's scope. Serialize concurrent claims of the same ID.
Persist item outcome and the request digest across restarts/isolates.

Do not trust an arbitrary client timestamp as proof of a new ID. Validate the
issued identity and expiry before looking up evicted history; an unknown/expired
issued ID must never turn into a new operation. Define clock skew, secret
rotation, and retention-setting changes; keep each ID's expiry stable so raising
retention cannot resurrect a previously expired ID.

Default history retention is seven days and configurable. Audit records contain
operation ID, timestamps, relative path, operation, outcome and before/after
versions, plus digest/expiry/recovery metadata necessary for duplicate safety.
No source bodies, diffs or attachment bytes. Audit history is private vault-derived
data, not public application logging. Schedule bounded cleanup locally/on Workers.
Do not expire unresolved operation state or access-revocation state merely to
meet the audit TTL; retain necessary recovery state until safely resolved, while
still rejecting attempts to apply an expired operation ID.

## Indexing, reads and deletion

Return saved state separately from index state (`pending`, `updating`, `fresh`,
or sanitized failure using existing freshness conventions). Index failures do
not undo a successful source save; they remain visible and retryable.
`get_note` on filesystem/R2 resolves the current allowed source and returns its
version, indexed version if known, and freshness. A newly created note must be
addressable before index publication. This targeted read extension supersedes
indexed-only body retrieval for these sources; it does not change pCloud.
Do not make the current note version look identical to the indexed chunk version.

Attach indexed content version to search/chunk references as needed. Before
`get_chunk`, verify that the requested/indexed source version is still current.
Reject stale references with `REVISION_CHANGED` (or consistently mapped existing
revision error); never silently return the new text at an old chunk index.
Search can remain stale during updating, with explicit freshness/version data.

Deletion requires removing the original and durably revoking subsequent API
access before reporting `applied`. Remove deleted membership from candidate
results and all content-bearing surfaces, including old FTS/vector results,
related, links, profiles, guidance and attachments as applicable. A tombstone
or equivalent overlay must guard immutable old objects until index publication
and cleanup catch up. A crash between R2 and D1 steps must remain fail-closed
and recoverable. Do not declare success based solely on an R2 delete receipt.
Requests already authorized and streaming before deletion need not retract bytes
already sent; new requests after completion must not retrieve deleted content.

Warn with bounded detected incoming link references, never full source bodies.
Warn when the link index is stale or the reference list is truncated. No link
repair, trash, undelete endpoint or archive of the deleted bytes is provided.
Physical cleanup of private derived rows, vectors, staging and retired objects
is tracked/retried separately. Provider-managed backup deletion is not guaranteed
by this API. Cleanup must preserve bytes still referenced by other active data.

## Local/cloud upload conflicts

Persist a last-acknowledged upload baseline per managed path independently of
short-lived mutation audit history. Compare baseline, current cloud and proposed
local digests/presence (including cloud deletion) before later upload commit.
If the cloud diverged, do not overwrite/recreate it unless both sides already
agree and no mutation is necessary. An unknown baseline fails closed for an
existing target. Source ETag checks alone do not detect a prior cloud edit if
upload first observes that edited ETag as its expected value.
Apply the rule to `--delete-removed` as well. Preview can report conflicts, but
the actual source commit must revalidate the baseline/current version.
Do not implement automatic merge, forced overwrite or bidirectional sync.
Migration of older upload plans/baselines must not weaken this rule.

## Response and errors (proposed)

```json
{
  "operation_id": "SERVER_ISSUED_TIME_BOUND_OPAQUE_ID",
  "state": "completed",
  "results": [
    {
      "path": "Notes/example.md",
      "type": "patch_note",
      "status": "applied",
      "version": "NEW_OPAQUE_VERSION",
      "index_state": "pending",
      "warnings": []
    }
  ]
}
```

Include item identity/order, note ID when applicable, sanitized codes, and
operation expiry. Do not include body or bytes in application/status results.
Preview is the explicit exception for note diffs. Bound and mark truncated
previews rather than representing them as complete; no retained content logs.

Use existing invalid-path/auth/revision/size errors where possible. Proposed
mutation-specific codes cover `WRITE_DISABLED`, `WRITE_REQUIRED`,
`SOURCE_WRITE_UNSUPPORTED`, `FILE_ALREADY_EXISTS`, `MATCH_COUNT_MISMATCH`,
`INVALID_PATTERN`, `REGEX_BUDGET_EXCEEDED`, `DUPLICATE_PATH`,
`PREVIEW_REQUIRED`, `PREVIEW_CHANGED`, `IDEMPOTENCY_CONFLICT`,
`OPERATION_EXPIRED` and `UPLOAD_CONFLICT`.
Map consistently through MCP without leaking raw patterns, replacements, paths
outside the vault, note bodies, provider responses or credentials.

## Verification

Use only synthetic notes/attachments. Share fixtures and behavior tables across
filesystem and R2 adapters. Cover both successful editing and crash/race cases
listed in the requirements. Retain existing local retrieval and portable-bundle
regressions. Hosted synthetic MCP validation is separate from workerd evidence
and must include verified teardown; no real private vault upload is needed.
