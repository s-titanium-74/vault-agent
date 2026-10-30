# Self-deployment and measurement (#35)

Status: In progress. Wrangler provisioning and the new-template hosted synthetic
walkthrough are validated; clean-account and Deploy-button validation remain
open. Account creation, R2 activation and required billing/authentication setup
are documented manual prerequisites; fully automating those account actions is
not a release gate. Validate deployment after those prerequisites. Recorded
hosted #34 evidence remains separate.

## Delivery contract

Use the entire public repository for Deploy to Cloudflare. A subdirectory
button cannot include the shared core/server declaration sources outside the
cloud package. The root Wrangler template points at the production entrypoint
and the cloud TypeScript configuration; ordinary local install/build never
installs or runs cloud tooling. Both flows provision private R2, D1 with all
migrations, independent read/admin secrets, rate limiting and one-minute Cron
reconciliation. Neither flow requires a queue or event notification route.
The baseline contains no AI/Vectorize bindings and no embedding consent.

The Wrangler fallback generates an ignored, operator-local configuration with
new vault identity, explicit resource names and a supplied D1 identifier. It
never changes a plan, provisions resources, uploads content or prints secrets.
The root template remains a public-safe deployment example. A Deploy-button
operator must review the full-repository build commands, UUID, secrets, resource
identities and billing before continuing. Automatic provisioning and a manual
Wrangler provisioning run are distinct validation gates.

Synthetic samples precede any private-content onboarding. The guide must cover
upload dry run, search then explicit get, native authenticated HTTP MCP, direct
R2 create/overwrite/delete/rename and attachment edits with uploader disconnected,
revision revocation, rotation, upgrade/recovery and deletion of all retained
storage. Production Worker deletion alone is insufficient teardown.

## Measurement contract

Generate deterministic public-safe English/Japanese Markdown and an attachment.
Measure initial index, one-file update, lexical search, explicit get, deletion
and rebuild independently for 1 and 100 notes. A 1,000-note corpus is an admission
failure experiment: the current publisher caps snapshots at 500 entries,
2,000 chunks and 16 MiB indexed JSON. Include maximum-size/long multilingual
notes and retained generations when assessing capacity. Never present an
out-of-budget workload as a supported deployment size.

Reports distinguish local workerd from hosted execution and CPU from wall time.
Keep content, queries, credentials, endpoints and account identifiers out of
public reports. D1 native meta counters capture reads/writes including index
amplification; R2 operation counters include idle scans, retries, staging,
publication, retained copies and cleanup. AI inputs are not token billing;
record provider usage separately. Vector query dimensions include insertion
and visibility probes as applicable, and stored dimensions include retained
generations. CPU and peak memory require actual platform/profiler evidence;
unavailable metrics must be null, never inferred from wall time.

Date official pricing assumptions. Estimate account-wide allowances and paid
base charges separately; report daily Free constraints, monthly Paid charges,
billing rounding and unmeasured inputs. No free-tier guarantee. The delivery
gate remains open until clean-account setup, both provisioning flows, native
client access, real Cron changes, full teardown and hosted cost/limit evidence
have been recorded. No automatic account upgrade is authorized by this guide.

## Validation recorded in this change

The root template and generated lexical operator configuration pass actual
Wrangler dry builds. The build runner aligns Wrangler's configuration directory
and working directory, so an operator config outside the package still uses the
cloud tsconfig and Zod compatibility alias. CI builds both configurations.

An isolated fresh root-only `npm ci` passed the dependency-closure check, local
workspace builds and all eight distribution tests, with no cloud toolchain
installation. Local regression checks passed 661 tests. Cloud checks cover
configuration overwrite protection, separate semantic/plan opt-in, sample-vault
overwrite protection and migration failure preventing deployment. The deploy
script refuses `--dry-run` before any remote migration; use the build command
for a write-free dry run. See [cost and limits](cost-and-limits.md) for measured
local workloads and explicit remaining hosted gates.

The [2026-10-29 hosted follow-up](remote-self-deployment-2026-10-29.md) records
new isolated Wrangler provisioning, migrations, actual CLI/native MCP, four
real-Cron R2 mutation phases with no admin advancement, token rotation and verified
full teardown. It also adds native 1-note mutation and 100-note initial/read
counters, platform CPU/V8-memory quantiles and a safe 2 MiB admission failure.
This is existing-account evidence; button/clean-account/Paid/remaining scale
phases still require separate validation.

The [compact-workload follow-up](remote-follow-up-2026-10-29.md) adds hosted
100-note update/rebuild/deletion with interruption recovery and native
age-equivalent snapshot/staging/cache cleanup. Its much smaller corpus and
explicit timestamp aging do not replace the remaining original-size/timer
measurements. Paid execution validation is deferred until the #43 optimization,
outside #35's completion gates; document its unverified limits. This does not
authorize a plan change. A [real-time retention trial](remote-retention-wallclock-2026-10-30.md)
is in preparation and has no completed 24-hour result yet.
