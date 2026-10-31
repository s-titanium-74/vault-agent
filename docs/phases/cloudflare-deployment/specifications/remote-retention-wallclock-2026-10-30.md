# Real-time retention validation (2026-10-30 JST)

Status: completed. Real time elapsed without timestamp modification; the final
read-only observation confirmed reclamation about 32.8 hours after preparation.
This is separate from the earlier timestamp-aging experiment.

Preparation completed on 2026-10-30 at 08:21:39 JST. The old snapshot was created
at 08:18:25 JST and the abandoned upload at 08:21:38 JST. Their 24-hour cutoffs
are therefore 2026-10-31 at 08:18:25 and 08:21:38 JST respectively. The baseline
observation at 08:21:52 JST passed: old rows/FTS/copy and staging remained,
active/source/excluded/unrelated objects were preserved, and search/get returned
the replacement. Post-expiry results are recorded below.

## Final observation and teardown (2026-10-31 JST)

At approximately 17:08 JST, connected Cloudflare API queries and read-only
Worker HTTP calls confirmed:

- The obsolete snapshot, its notes/chunks/sources/grams and FTS table were absent.
- The obsolete immutable R2 prefix was absent.
- The abandoned upload job, entries and staged R2 prefix were absent.
- The expected active snapshot and its immutable note copy remained, even though
  the active snapshot itself was more than 24 hours old.
- Mutable source, excluded source and unrelated objects remained. All four
  remaining objects matched their expected sizes and content ETags.
- Search and revision-pinned get returned the replacement content; get did not
  return the prior content. Detection was observed and cleanupPending was false.

The reservation's completion was not recorded locally when the user asked for
status, so this turn performed the final observation directly. The original
Wrangler observation command failed with provider authorization code 7403;
the connected Cloudflare API was used for D1/R2 verification instead. HTTP
checks used the existing read token. No admin advancement or timestamp edits
were used to complete indexing or cleanup.

The preparation baseline and this final observation bound the observed interval.
There was no observation immediately before the cutoff, so this trial does not
prove the exact deletion time or uninterrupted preservation up to the cutoff.
It does demonstrate the production Cron reached a fully reclaimed state after
real elapsed time, while preserving the current data. Keep the earlier
age-equivalent tests as separate evidence of the boundary conditions.

After recording the result, the owned Worker and its secrets/Cron, the four
remaining R2 objects (169 bytes), bucket and D1 database were removed. Independent
provider reads confirmed 404 for Worker settings, schedules, D1 and R2. The
follow-up automation was stopped. Operator-local credentials/configuration/logs
were removed; the user's Wrangler login was preserved. Provider backup retention
is separate from absence of live resources.

Content-free assertions and observation timestamps are recorded in
[the measurement report](../measurements/2026-10-31-retention.json). This closes
the real-time retention follow-up, not all #35 deployment/cost validation.

## Method

Use newly provisioned disposable Worker, D1 and private R2 resources with only
synthetic content. Deploy the production entrypoint and its normal one-minute
Cron. Omit Paid CPU settings and AI/Vectorize bindings. Do not change billing.
Do not modify timestamps, call admin advance, or invoke a synthetic tick route.

Publish a small note, overwrite its mutable source, and wait for real Cron to
publish the replacement. Record the old snapshot's actual D1 `created` time:
retention eligibility is based on creation, not the later publication time.
Create an uncommitted upload through the normal authenticated upload API and
leave its staged object in place. Record that job's actual creation time too.

Before each object's 24-hour cutoff, check that the obsolete snapshot and its
immutable note copy, FTS table and derived rows, and the abandoned job's staged
object and entry remain. Read-only follow-up checks observe real Cron cleanup
after the cutoffs. Cleanup is bounded and need not finish at exactly 24 hours.
Record the last observation before expiry and first observation of completion;
do not infer an exact deletion time from the polling interval.
The operator chose to check again about 30 hours later rather than hourly;
the preparation baseline is the available pre-expiry observation. A later
successful check will not prove preservation immediately before the cutoff.

Throughout the trial, verify the active revision, its immutable note copy,
mutable source, excluded source probe and unrelated bucket prefix remain.
Search and explicit revision-pinned get must still return the replacement.
After expiry verify old derived rows, FTS, immutable objects, abandoned staging
objects and job entries are absent. Actual AI/vector cache expiry is not covered
by this lexical-only trial; the earlier synthetic bookkeeping test is separate.

## Follow-up and teardown

Private operator state, credentials and read-only observation tooling are kept
in an ignored operator directory with restricted permissions. The thread
follow-up was moved from hourly checks to about 30 hours after the operator's
request (2026-10-31 afternoon JST), to finish verification and remove its owned
resources. It is instructed to stop after that check and reporting, rather than
continue a recurring trial. Local app/host availability affects observation timing;
the deployed Cron itself runs remotely. No result is inferred if a follow-up
does not run.

On completion, or if the trial cannot continue, remove this trial's Worker,
Cron, secrets, all R2 objects and bucket, and D1 database; verify provider absence
and remove private operator credentials. Until verified teardown, resources
remain intentionally provisioned and incur their ordinary reconciliation usage.
Public evidence must contain no credentials, resource/account/vault identifiers,
private endpoints or note content. Final timestamps, assertions and cleanup
results are recorded above and in the linked measurement report.
