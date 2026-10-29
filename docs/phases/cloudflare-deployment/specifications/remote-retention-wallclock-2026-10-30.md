# Real-time retention validation (2026-10-30 JST)

Status: preparation in progress. This is a real 24-hour observation, not a
completed validation or the earlier timestamp-aging experiment.

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

Throughout the trial, verify the active revision, its immutable note copy,
mutable source, excluded source probe and unrelated bucket prefix remain.
Search and explicit revision-pinned get must still return the replacement.
After expiry verify old derived rows, FTS, immutable objects, abandoned staging
objects and job entries are absent. Actual AI/vector cache expiry is not covered
by this lexical-only trial; the earlier synthetic bookkeeping test is separate.

## Follow-up and teardown

Private operator state, credentials and read-only observation tooling are kept
in an ignored operator directory with restricted permissions. An hourly thread
follow-up is registered to observe the trial, finish verification and remove
its owned resources. Local app/host availability affects observation timing;
the deployed Cron itself runs remotely. No result is inferred if a follow-up
does not run.

On completion, or if the trial cannot continue, remove this trial's Worker,
Cron, secrets, all R2 objects and bucket, and D1 database; verify provider absence
and remove private operator credentials. Until verified teardown, resources
remain intentionally provisioned and incur their ordinary reconciliation usage.
Public evidence must contain no credentials, resource/account/vault identifiers,
private endpoints or note content. Final timestamps, assertions and cleanup
results will be recorded after actual observation.
