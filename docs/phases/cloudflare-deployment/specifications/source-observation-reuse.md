# Reuse verified R2 observations (#48)

Status: Implemented; local/workerd regressions and hosted lexical measurement passed.

The [first hosted incremental comparison](remote-incremental-update-2026-11-01.md)
reduced writes but still read and validated all 101 sources individually. This
follow-up keeps Cron reconciliation and the existing shared core. It adds no
Queues, event notifications, providers or automatic external processing.

## Reuse evidence

Record the R2 object version and ETag together with the byte digest that was
actually verified for that object. Bind this observation to the physical store
and canonical path; the authoritative source row still owns kind, size and
uploaded timestamp. An ETag is opaque observation data, not a SHA-256 digest.
Matching size/mtime alone cannot authorize reuse.

A bounded R2 LIST supplies version, ETag, size, uploaded timestamp and deletion
metadata. Reuse a previously published digest only if all those observations,
kind and path match, the path is still admitted, and the saved observation is
bound to the current authoritative digest. Bulk-mark reusable job entries in one
fenced D1 checkpoint rather than advancing once per unchanged file. GET and hash
only new/changed/unknown objects. Check the GET's returned version as well as its
ETag, size and deletion metadata before accepting bytes.

A same-byte overwrite or metadata-only rewrite can retain its ETag but gets a
new object version. It must be read once to establish evidence again; matching
content can still reuse parsed rows, lexical data and immutable bytes. Explicit
rebuild and parser/schema/chunking incompatibility force preparation from bytes.
Policy tightening removes excluded membership without trusting stale access.

Save changed observations in the same publication transaction as the source and
index delta. An unsuccessful job must not advance published reuse evidence.
Full builds populate observations only after reading each object. Retired stores
and removed paths reclaim their observation records with their other metadata.

## Publication validation

Replace one HEAD/checkpoint per file with a second bounded LIST pass. Apply the
same scope, kind, hidden-path, size and tombstone admission rules as initial
discovery. Compare every admitted current object to its planned version, ETag,
size, uploaded timestamp and kind. Reject unexpected entries and mismatches.
Persist the opaque pagination cursor and distinct seen paths in the job. Require
the final seen membership to equal the planned manifest before publishing;
duplicates or missing entries fail closed. No content/path lists appear in the
public job response or logs.

R2 listing is strongly consistent per operation, but multiple pages are not a
cross-object snapshot transaction. A direct R2 edit after a page is checked can
still race publication, as with the previous per-file HEAD pass. Publication
continues to mean a validated sampled manifest; a later reconciliation observes
subsequent edits. Immutable published bytes, digest checks, revision/epoch reads
and immediate policy enforcement remain unchanged. Do not claim the mutable
prefix is locked or perfectly current.

Official API and consistency references:
[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/),
[R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/).

## Migration and compatibility

Add migration 0005 for job object versions and digest-bound source observations.
Legacy stores have no trusted observations: their first reconciliation reads
unknown files once, without reuploading bytes or requiring a full lexical
rebuild. Do not seed observations from unverified metadata. The source signature
includes the complete observed identity so an old signature cannot skip this
bootstrap. Retain earlier reports as pre-observation-reuse measurements.

Revoke in-flight scan leases and fence old scan writers with a separate
observation contract; retain the existing layout contract and resumable upload
intents. As with migration 0004, quiesce legacy readers/writers for application
cutover. New readers retain legacy immutable-source locators and stable public
note/chunk IDs. Normal local SQLite update behavior is unchanged: R2 identity
and pagination belong in the cloud adapter, not the portable core.

## Acceptance

- On the warmed 100-note/200-chunk fixture, one-note change performs one source
  GET and one immutable PUT, zero source HEADs, and bounded initial/final LIST
  pages. Unchanged sources do not each require a preparation checkpoint.
- A no-change scan performs LIST only. Same-byte and same-size rewrites are not
  mistaken for unchanged object versions. Missing version evidence reads bytes.
- Full rebuild reads every source; migration without observations bootstraps
  safely. Failed commit or validation never publishes observation evidence.
- Changes, deletions, additions, rename, exclusion and tombstones during paged
  validation are checked against planned membership, with durable resume.
- Existing shared local/cloud parity, optional semantic, fencing, concurrent
  reads, immutable-byte retrieval and reference-safe GC regressions still pass.
- Compare user-visible hosted updates separately from the historical 2m46s
  result; report setup/bootstrap and measurement boundaries explicitly. Real
  Cron/CLI timing, semantic billing and capacity remain separate checks.

## Local validation

The synthetic 100-note/200-chunk fixture plus one attachment performs exactly
one source GET, zero HEADs, four LIST pages (two discovery and two validation),
and one immutable PUT for a warmed one-note change. Publication takes fewer
than 15 durable checkpoints. A no-change scan uses two LIST pages and no
GET/HEAD/PUT. A same-byte overwrite reads its new object version once but does
not copy immutable bytes again.

The Cloudflare suite passes 63 tests, including observation migration/fencing,
failed publication rollback, paginated membership races, legacy observation
bootstrap, explicit rebuild and chunking compatibility invalidation. Typecheck,
lint and formatting checks pass. These counts are local workerd evidence; no
new hosted elapsed-time result is inferred from these local counts. The
[separate hosted measurement](remote-source-observations-2026-11-01.md) observed
the warmed update completing in 7,974 ms with final body/search verification at
9,295 ms, including one concurrent search revision-conflict response.
