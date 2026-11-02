# pCloud source validation (2026-11-02)

## Implemented and locally verified

The source contract is [pcloud-source.md](pcloud-source.md). One synthetic HTTP
service (`packages/core/test/helpers/pcloud.ts`) drives both the Node/SQLite
adapter and the Worker/D1 adapter. No real vault data or credentials are used.

- Local regression: 43 files / 679 tests passed.
- Distribution: 3 files / 8 tests passed, including portable browser bundling
  and the packaged MCP/CLI entrypoints.
- Cloudflare regression: 10 files / 64 tests passed in Miniflare/workerd.
- Root typecheck/build/lint/format and Cloudflare typecheck passed.
- Wrangler dry-run passed for the existing R2 configuration and a generated
  pCloud configuration whose binding report contains D1 and no R2 binding.
  Dry-run creates no remote resources.

The dedicated pCloud Worker test has no `r2Buckets` configuration and checks
SQLite/D1 note IDs, digests, bodies, links and membership after creation, edits,
rename and removal. It verifies changed-row incremental publication, unchanged
note preservation, matching-current note and indexed-chunk retrieval, zero
pCloud requests during lexical search, explicit revision mismatch, failed
listing preservation, a source change between validation and publication,
recovery on a new job, and scheduled cleanup with no R2 binding. It asserts that
no `source_objects` or `retired_objects` rows are created.

Digest observation detects a same-size change even when the synthetic provider
hash and modified timestamp do not change. The provider's 64-bit decimal hash
is preserved exactly and never used as the content digest. Digest observations
are checkpointed one file at a time before Worker planning; prepared bytes are
verified against that observation on subsequent reads.

Adapter tests also cover exclusion and traversal rejection, guidance and hidden
file rejection, unsafe download hosts, manual redirect refusal, invalid UTF-8,
read size limits, abort/deadline errors, auth failures, rate limits and
observation-pinned pagination. Local HTTP tests cover explicit note/chunk reads,
unsupported attachment/guidance routes, polling status, manual refresh and
sanitized authentication/mismatch failures. Config tests verify that an
environment access token is not persisted when other settings are saved.

## Limits and remaining acceptance

These are local simulations, not deployed evidence. No pCloud credentials were
available in the execution environment. No real pCloud account/folder, hosted
Worker, D1, R2, Vectorize or provider credential was created, modified or deleted.
Miniflare instances and temporary synthetic SQLite folders were disposed of by
the tests. No production deployment, issue closure or PR merge is part of this
validation.

The API-specific parameter list for getfilelink omits historical version
selection, but the official global parameter reference explicitly documents
`revisionid` for getfilelink. This supplies a documented non-mutating mechanism;
real-account retention, identity-to-digest mapping and access behavior remain
unverified. Initial runtime support is matching-current-version retrieval with
explicit mismatch failure. It never reverts originals or substitutes newer text.

The initial polling path reads all admitted Markdown bodies to verify digests;
it does not claim optimized API traffic, a freshness SLA or large-vault capacity.
Workers advance at most eight checkpoints per cron invocation; large folders
may require many invocations. Optional embeddings retain their existing shared
preparation/cache and runtime publication paths; the existing semantic regression
suite passes, but no real pCloud-to-embedding-provider round trip was performed.

## Resume real-connection validation

1. Prepare an isolated normal pCloud folder containing only public-safe synthetic
   Markdown. Select its region, numeric folder ID and explicit includes. Provide
   its token through a secret manager/environment, not repository files or CLI
   arguments. Configure local opt-in as documented in the source contract.
2. Run initial index, lexical search, explicit note/chunk retrieval, edit/rename/
   delete and manual refresh. Record counts, sanitized failure codes and revision
   behavior. Never record account identifiers, tokens or note bodies in reports.
3. Create a disposable D1/Worker deployment using the pCloud configure mode,
   without creating an R2 bucket/binding. Apply the existing migrations, install
   independent vault read/admin tokens and the pCloud access token as Worker
   secrets, then deploy and repeat the same synthetic corpus changes.
4. Exercise interruption/resume, scheduled polling, source unavailability and
   token revocation, noting measured update lag. Validate historical retrieval
   separately before expanding the documented guarantee.
5. Remove disposable Worker/D1/optional Vectorize resources, revoke test tokens,
   and remove the isolated pCloud fixture folder through its owner. Verify
   teardown separately from test results; do not touch production resources.
