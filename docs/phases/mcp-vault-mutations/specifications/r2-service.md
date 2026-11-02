# Internal R2 mutation service (#54, step 4b)

Status: Internal implementation verified with synthetic workerd tests; not a
public Workers capability. The service requires internal explicit enablement.
Workers MCP tools/configuration remain disabled until the remaining design/hosted
gates are verified.

## Storage and recovery

Reuse portable mutation validation, ordered patches, bounded previews and
request digests. Keep `VaultSource` read-only. D1 owns signed expiring operation
IDs, content-free item receipts, source-path suppression and a monotonic read
epoch. Private R2 staging holds only transient prepared bytes. Current admin
secret rotation invalidates unused signed IDs; recovery of already attempted
items uses durable receipts and never needs an old signing key or request body.
Client status validation also requires the current signing secret; key rotation
does not erase unresolved durable records or permit reapplication.

An operation is claimed once under a short D1 lease. Persist every item before
I/O. Acquire a durable per-path suppression record before conditional source
PUT, then acknowledge source save and durable pending-index work in one D1 batch.
Deleting writes a conditional empty marker with no source body; it does not call
an unconditional DELETE after checking HEAD. All new content-bearing reads must
honor suppression before returning any cached/indexed content. Bump the read
epoch when acquiring/releasing suppression; a racing read discards its result.

An ambiguous storage outcome stays `reconciling`, blocks the path, and cannot be
reapplied. Recovery can acknowledge only this exact operation/item's current R2
receipt with the intended SHA-256 (and deletion marker when applicable). A
missing receipt or an old-looking source is not evidence that retry is safe.
Upload admission and source commit also reject an unresolved mutation path,
including identical-content baseline adoption; an upload cannot clear uncertainty.
Only terminal operation history expires; unresolved receipts and path suppression
outlive audit retention. Stage cleanup is bounded and never deletes live sources.

Normal saved paths stay hidden from old search/related/profile/graph results until
the published source observation has both the saved digest and R2 generation.
Deletion/uncertainty suppression is independent of immutable index snapshots,
audit cleanup, and the feature switch. Old scans may publish but cannot restore
access. Latest targeted reads resolve server-known note IDs/paths and verify
current R2 bytes/version. New note IDs resolve before indexing. Older chunk
references must be rejected when the source or requested indexed version differs.

Existing source ingestion owns parsing/chunking/linking/publication; source saves
do not duplicate those operations. Existing Cron/advance can resume source
observation/indexing independently of the original client. Receipt recovery and
audit cleanup are bounded internal methods; automatic wiring awaits the Workers
runtime integration step. This step does not promise immediate full
indexing of a saved Markdown file above the existing 2 MiB cloud ingestion bound.
The portable entry point exports its existing `noteFromRow` result builder so
latest-source retrieval keeps the shared note response schema without importing
Node/local modules or reconstructing transport-specific note results.

## Conditional-write boundary and enablement gates

Source versions bind vault, path, exact digest and R2 object generation. Recheck
them immediately before publication; conditional PUT additionally compares the
captured ETag or absence. The binding's condition is on ETag, not generation ID.
An authorized same-byte rewrite between the final check and PUT cannot be
distinguished by that ETag. D1 fencing cannot cancel an already-dispatched R2
request. These are explicit design gates before public enablement; the accepted
filesystem race limitation must not silently weaken R2's requirements.

Do not add public write settings/tools in this step. Remaining work includes the
public R2 consistency boundary, oversized-save ingestion behavior, deletion
reference warnings and physical-derived cleanup evidence, external recreation
reconciliation, Workers transport/auth wiring and isolated hosted verification.
This step alone does not close #54 or authorize a production deployment.

Apply migration `0007_r2_mutations.sql` after the baseline migration while old
readers/writers are quiescent. Once internal mutations exist, an old Worker
binary that ignores path suppression must not serve this database. This migration
does not enable writes. Disabling an eventual feature switch must not disable
read suppression or allow rollback to an old reader.

## Verification

`mutations.test.ts` exercises 29 cases through an authenticated synthetic-only
harness in Miniflare/workerd, then checks the production HTTP retrieval surfaces.
It covers shared literal/regex preparation and regex admission budget rejection,
UTF-8/BOM and unchanged line endings, preview binding/direct allocation, partial
failure, version mismatch, concurrent operations, same-byte observed generation
changes, conditional PUT rejection, latest reads and read-size boundaries,
attachment type enforcement, old chunk rejection after a newer index is fresh,
search/related/graph/profile/guidance suppression, read epochs, D1 acknowledgment
failure, deletion receipts, five interruption checkpoints, expiration, policy/key/
vault boundaries, pCloud rejection and retained suppression after audit cleanup.

Interruption hooks emulate lost checkpoints/receipts; they are not actual process
termination or hosted fault evidence. Workerd regex budget rejection demonstrates
the shared work-admission rule, not a CPU-millisecond limit or timer cancellation.

Cloudflare's full suite passed 149 cases, and the final mutation/upload regression
passed 67 cases after adding the unresolved-path upload guard. Distribution tests
passed 11 cases, including the Node-free portable bundle and actual local CLI MCP.
Build, root/Cloudflare typechecks (including DOM-only portable declarations),
lint/format and Wrangler deploy dry-run passed. No real vault, deployment, secret
or production D1 migration was changed. The existing `2026-10-28` compatibility
date is retained; the retrieved latest Workers types were `5.20261102.1`.
