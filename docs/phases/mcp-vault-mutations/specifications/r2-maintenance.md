# R2 mutation maintenance (#54, step 4c)

Status: Implemented and locally verified. This step does not expose Workers mutation
tools or enable new writes.

## Bounded background work

After migration `0008_r2_mutation_maintenance.sql`, Cron resumes existing mutation
receipts, cleans expired terminal metadata/private stages, and observes registered
terminal source paths before ordinary ingestion. No new mutation identity or
source write is issued by maintenance. It still runs when ingestion is disabled;
that setting continues to disable scanning/indexing/AI. pCloud never participates.
Deployments without mutation history perform no R2 maintenance or durable writes.

Admit at most four recovery items, two cleanup operations (100 stage objects per
operation), and eight path observations per invocation, stopping admission of new
work at a two-second maintenance deadline inside the existing twenty-second Cron
budget. These are application limits, not hard cancellation of in-flight I/O or
measured CPU capacity. A maintenance binding failure is sanitized and deferred;
it cannot remove suppression or prevent unrelated source indexing from progressing.

Recovery attempts have a durable sixty-second retry boundary and fair ordering so
an unresolved early path cannot monopolize every invocation. Operation retention
is captured when the ID is issued. Terminal cleanup deadlines do not change when
the maintenance process restarts or settings change. Unresolved receipts and
suppression remain outside the audit TTL. Concurrent maintenance cannot extend
cleanup or repeat a canonical source PUT.

## External changes and recreation

Never release `uncertain` paths from a scan or external edit. For terminal managed
paths, HEAD can revoke access after observed absence/deletion. Restoring access
after external replacement/recreation additionally requires the active published
source observation to match the current R2 generation, size and verified digest.
The old index alone cannot release a deletion marker. Recheck the stored path
owner/state/generation in the same D1 transaction as the suppression update and
read-epoch bump. Use a durable bounded path cursor, honoring current scope/type
rules. Do not change the last-upload baseline while observing external edits.

## Oversized saved Markdown

Existing upload/CLI and unmanaged direct-source limits stay at 2 MiB for Markdown
and 20 MiB for attachments. A terminal managed mutation path may have up to 20 MiB
of saved Markdown/guidance, bounded by the mutation settings when saving. Source
admission and both incremental/full indexing can verify and snapshot those bytes.
Use shared note preparation: Markdown over 2 MiB has metadata and an `oversized`
marker, with no chunks, body search or embeddings. Existing derived-row and CPU
admission budgets still apply; saving does not promise a successful index for
every possible document. No content is silently truncated or rewritten.

Explicit current-source reads retain default note/guidance/attachment read limits;
`allowLarge` can retrieve admitted managed bytes. Index publication and subsequent
observation release stale-result suppression only for the matching saved version.

## Remaining gates

Public Workers MCP/auth/settings, the R2 ETag/generation guarantee boundary,
deletion reference warnings, physical-derived cleanup evidence and isolated hosted
validation remain separate #54 work. Apply migration 0008 after 0007 with old
writers quiescent; do not serve this data with readers that ignore suppression.

## Verification

Cloudflare's workerd suite passed 163 cases, including 14 maintenance cases.
Coverage includes disabled-ingestion Cron recovery, fair bounded retry, completion
after an already-applied interruption, stable captured retention/migration,
external absence/recreation, old-index rejection, uncertain-path preservation,
cursor progress, oversized metadata-only incremental/full publication, unchanged
unmanaged limits and private-stage cleanup failures that leave indexing usable.

Root build/typecheck (including DOM-only portable declarations), Cloudflare
typecheck, lint, formatting and Wrangler deploy dry-run passed. The dependency
lockfiles were unchanged. Tests use only synthetic local D1/R2 and retain the
existing compatibility date; no hosted capacity, actual Cron timing, production
migration or real-vault behavior is certified by these results.
