# Filesystem mutation adapter (delivery step 2)

Status: Filesystem service; see [local MCP](local-mcp.md) for transport enablement.
Depends on the portable preparation in #56. The full feature remains #54.

## Accepted filesystem race boundary

The 2026-11-02 follow-up agreement permits ordinary external editors. Explicit
write enablement is required; an assertion that all editors cooperate is not.
Detected version mismatches are rejected, including immediately before source
publication. External edits between that last check and rename/unlink may be
missed and overwritten. This is an accepted limitation, not a full conditional
write guarantee. Server-owned writers are serialized on one host/PID namespace.
Network filesystems and independently managed containers remain unsupported.
The adapter serializes calls using the private SQLite journal's write lock.
Local index publication shares that lock once the journal exists. Source reads
check no symlinks, regular files, bounded bytes, descriptor/path identity and
content digests. Immediately before publication it rechecks parent identities
and the expected source version. Creation uses an atomic no-clobber hard link;
replacement uses atomic rename; deletion uses unlink. No partial target bytes
are published. Filesystems without hard-link/atomic-rename/fsync support fail.

Node filesystem primitives do not offer conditional rename/unlink against an
uncooperative editor's version, or portable openat2-style parent resolution.
An external writer replacing a file or parent after the final check is outside
this supported boundary. Detected races fail closed, but tests at controlled
checkpoints are not proof against arbitrary malicious concurrent directory
changes. The adapter is not a security sandbox against another process with
permission to modify vault parents. Caller traversal and detected unsafe paths
remain rejected; HTTP/stdio setup describes the accepted race limitation.

## Identity, admission and persistence

The service uses the same source policy, schemas and all-files preflight as the
portable core. It returns a signed operation ID before source mutation. Review
mode additionally requires the binding returned with the explicit preview;
direct mode may allocate an ID without a diff. Apply resupplies the request.
An HMAC binds ID format, issue time, fixed expiry, random nonce, request digest
and vault/source identity. The private journal persists the signing key. A key
rotation invalidates existing IDs, with no anonymous fallback. Validate signature
before operation lookup; unknown IDs never allocate work. More than 30 seconds
of future clock skew is rejected. Apply rejects an expired ID even if retention
was subsequently increased. Policy changes invalidate unused proposals.

The journal is `mutations.sqlite` beside the vault's index database, independent
of index rebuild/swap and audit retention. The containing vault-specific state
directory is private, must be outside the source vault and is not a source.
Database/WAL files and staging files use private permissions. Audit rows contain
only IDs, issue/expiry times, digest, policy fingerprint, relative paths, types,
codes, versions and recovery metadata. They never contain bodies, replacements,
diffs or attachment bytes. SQLite uses FULL synchronous durability.
Version-only checks stream hashes without retaining original bytes. Explicit
note previews and patches retain their bounded original-body read requirement;
a larger original may require raising that read/payload setting within the
application ceiling. Direct full replacement and deletion need no original body.

Apply first prepares the complete request with no file changes, then claims the
ID and writes per-item intents durably before each I/O boundary. Independent
items can succeed or fail; repeat calls return recorded outcomes. Source bytes
exist only in memory or temporary 0600 staging files in the target parent.
Stage names are random hidden `.vault-agent-mutation-*.tmp` files, recorded
before creation and excluded from discovery. Files and affected directories
are fsynced at publication; no archive of replaced or deleted bytes is created.

## Recovery and retention

Before another apply, recover nonterminal records under the journal lock.
Unstarted/staging-only items terminate with an interruption failure and need a
fresh ID to retry. A committing save is applied only if the target has the exact
staged file identity and byte digest; a committing delete is applied only when
the target is absent. Otherwise it remains `reconciling`; never infer that it is
safe to write again. Recovery may finish bookkeeping after ID expiry, while an
expired client ID still cannot initiate writes. Status may inspect retained
unresolved operations after expiry. A source I/O exception after the durable
commit intent is an unknown outcome, not an automatically retryable failure.

Completed items are not repeated. Different content under the same ID fails
with `IDEMPOTENCY_CONFLICT`. Failed items require a fresh ID and versions.
Cleanup is bounded, explicit service maintenance (also run during allocations);
transport lifecycle scheduling remains step 3. Completed audit rows are retained
for the ID's originally configured retention duration after terminal completion,
independently of the earlier fixed apply expiry. Per-item update timestamps and
operation completion times are metadata. Unused expired proposals can be removed
at expiry. Delete eligible terminal rows only after their staging files have
been safely removed. Keep unresolved
state, pending index work and access suppression independently of audit TTL.

## Source and index reads

Versions bind vault, canonical path, source file identity/generation and full
byte SHA-256. mtime/size alone never authorizes a write. Latest note/attachment
reads come from the allowed source, even before indexing; new note IDs are
resolved using the journal's service-generated path registration, never an
untrusted caller mapping. Note reads distinguish source and indexed version
and pending/fresh state. Chunk reads check current source against indexed text;
old indexed content cannot be read at an old chunk index after source changes.

A durable path overlay suppresses deleted, unresolved and outdated indexed
versions from local candidate and aggregate reads, including old open index
connections and rebuilt databases. Deleted paths stay suppressed beyond audit
expiry. Recreating a path explicitly with a new operation releases the tombstone
only for the new indexed content. Deletion warns with bounded indexed backlinks,
and declares their freshness/completeness limits. Links are never repaired.

Bounded maintenance also re-observes registered paths edited by external apps.
Only current canonical source observations can release an external recreation's
tombstone; old index rows alone cannot. Unsafe/unreadable observations suppress
content and are retried. Each maintenance pass checks at most 100 registered
paths and 20 MiB/file; explicit latest reads re-observe their addressed path.

Source saves queue durable index work; they do not wait for embedding providers.
`flushIndex` uses existing shared local index preparation and version-aware
acknowledgement. Source changes increment a monotonic journal sequence. Index
preparation/publication and full database swaps reject obsolete sequences;
publication takes the same journal lock. Failed indexing leaves saved bytes
and pending work intact. A crash after source mutation but before pending-work
recording is fail-closed via the committing overlay, then recovered.

## Verification boundary

Use disposable synthetic files only. Cover explicit enablement, source/parent
symlinks and parent replacement checkpoints, hard-link targets, atomic creation,
version conflicts, same-ID overlap/restart/lost response, tampered/expired IDs,
policy/retention changes, each durable crash boundary, ambiguous outcomes,
private audit/staging cleanup, fresh note reads, stale chunk rejection, deletion
suppression across old stores/full rebuild, index failure and stale publication.
No real vault is mutated. MCP validation is extended in [local MCP](local-mcp.md).
Uncooperative editor races retain the accepted limitation; R2/Workers remain open.

Step 2 baseline validation (2026-11-02, before local MCP): 36 service cases include five actual
child-process exits at intent/stage/committing/published/applied, interrupted
replace/delete recovery, lost-response replay, audit expiry, ambiguous outcomes,
and delayed incremental/rebuild publication versus deletion. The full local
suite passes 882 tests; distribution tests pass 9. Build, typecheck (including
DOM-only portable declarations), browser bundle, lint and formatting pass.
Process-exit cases and HTTP integration were run outside sandbox process/network
restrictions after restricted child-process runs timed out. This is local Linux
synthetic evidence, not a proof against uncooperative editor races or a hosted
Cloudflare/MCP mutation validation.
