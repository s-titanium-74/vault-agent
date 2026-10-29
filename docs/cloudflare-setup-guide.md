# Deploy your own Cloudflare edition

Status: #35 implementation in progress. Wrangler provisioning in an existing
account with new isolated resources has been validated. Account creation, R2
activation and required billing/authentication setup are manual prerequisites;
their complete automation is not required. Deployment after those prerequisites
and Deploy-button execution still need separate validation. Use synthetic
content first. See [measurement evidence](phases/cloudflare-deployment/specifications/cost-and-limits.md).

## Prerequisites and data scope

Use your own Cloudflare account, Node.js 22 or newer, npm, Git and Wrangler
(the separately locked cloud package supplies it). Enable R2 billing in the
Cloudflare dashboard if required. Review Workers, R2 and D1 plan/usage quotas;
optional semantic retrieval also requires Workers AI and Vectorize access.
The scripts do not activate subscriptions or upgrade your account. Free HTTP
CPU limits can reject indexing even when storage fits the included allowance.
A Paid configuration is available but must be selected after billing review.

This edition sends selected Markdown and allowlisted attachments to private
R2, stores parsed content/metadata, FTS/trigram indexes and job state in D1,
and runs automatic cloud-side reconciliation once a minute. It is one vault per
deployment. The lexical baseline has no AI binding or semantic consent.
Enabling semantic mode separately sends note chunks and requested queries to
Workers AI and stores vectors/identifiers in Vectorize. Attachments are stored
for explicit retrieval; no OCR is performed. Normal local installation and
local search require none of these services.

## Deploy to Cloudflare template

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/s-titanium-74/vault-agent)

Use the **entire repository**, without `/tree/main/packages/cloudflare` in the
URL. The shared core is outside the cloud package. Cloudflare's [documented
monorepo limitation](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
makes a subdirectory-only clone insufficient. This button targets main; new
changes become available after merge. This flow has not yet been validated in
a clean account and is not a one-click compatibility claim.

Review the generated application before deploying:

1. Keep root directory `/`. Use build command
   `npm ci --prefix packages/cloudflare` and deploy command
   `npm run deploy:cloudflare`. Override the local workspace `npm run build`
   command if the dashboard preselects it. Root dependency installation is
   still required; Workers Builds normally installs root dependencies itself.
2. Select new, dedicated DB and SOURCE resources. Keep SOURCE private, disable
   public R2 domains/CORS, and leave D1 read replication disabled. The template
   requests D1/R2 provisioning; validate the assigned IDs in the cloned config.
3. Replace `VAULT_ID` with a new lowercase UUID v4 generated using
   `node -p 'crypto.randomUUID()'`. Keep it stable for the lifetime of the vault.
   Review `INCLUDE_PATHS`, `EXCLUDE_PATHS`, `ALLOWED_ORIGINS` and profile policy.
4. Supply **different** READ_TOKEN and ADMIN_TOKEN secrets, each generated with
   `openssl rand -hex 32`, in the dashboard secret prompts. Blank entries in
   `.dev.vars.example` declare secret names; they are not usable credentials.
   Never paste secrets into a build command, URL, Git file or ordinary variable.
5. The deployment script applies all D1 migrations by binding name **before**
   publishing the production Worker. Missing provisioning or migration failure
   stops deployment. The template includes rate limiting and one-minute Cron;
   no R2 event notification, queue, Workflow or consumer is needed.
6. Disable preview URLs and non-production branch deployments in Workers Builds;
   ensure previews never bind production data. Logs are disabled in the template.
   Verify the schedule and perform the synthetic checks below.

A button-created clone is a deployment fork. Keep its resource bindings and
vault UUID when upgrading. Automatic provisioning is distinct from the explicit
resource creation below. The baseline button intentionally omits AI/Vectorize;
use the explicit semantic steps after lexical setup succeeds.

## Wrangler fallback

Clone the full repository, then run from its root:

```sh
npm ci
npm ci --prefix packages/cloudflare
packages/cloudflare/node_modules/.bin/wrangler login
packages/cloudflare/node_modules/.bin/wrangler whoami
packages/cloudflare/node_modules/.bin/wrangler d1 create my-vault-trial
packages/cloudflare/node_modules/.bin/wrangler r2 bucket create my-vault-trial
```

Choose a globally available bucket name. Record the D1 UUID privately. Use the
same chosen name for the dedicated Worker, database and bucket. Generate the
ignored operator configuration (replace the sample UUID argument):

```sh
npm run configure --prefix packages/cloudflare -- my-vault-trial D1_UUID lexical free
```

This writes `.cloudflare/wrangler.jsonc`, including a new vault UUID. It refuses
to overwrite an existing configuration and performs no resource creation or
upload. The `free` argument omits the custom CPU setting; it does not promise
Free compatibility. To use an already-approved Paid plan, pass `paid` instead;
that sets a 1,000 ms CPU ceiling per invocation. The script does not buy a plan.
Review scope and origins in the generated file, then set secrets interactively:

```sh
packages/cloudflare/node_modules/.bin/wrangler secret put READ_TOKEN --config .cloudflare/wrangler.jsonc
packages/cloudflare/node_modules/.bin/wrangler secret put ADMIN_TOKEN --config .cloudflare/wrangler.jsonc
npm run build --prefix packages/cloudflare -- --config ../../.cloudflare/wrangler.jsonc
npm run deploy --prefix packages/cloudflare -- --config ../../.cloudflare/wrangler.jsonc
```

Generate each secret independently in your private terminal. Wrangler may create
an initial Worker when adding the first secret. No vault data is present then;
the final deployment installs the production code. Confirm both secrets exist
using `wrangler secret list --config .cloudflare/wrangler.jsonc` (names only).
Get the HTTPS `workers.dev` endpoint from deployment output. There is no need to
expose the local server or enable R2 public access. `/health` is public liveness;
all other routes must reject requests without bearer authentication.

## Synthetic upload, search and explicit retrieval

Generate a new sample directory; an existing destination is rejected:

```sh
npm run sample --prefix packages/cloudflare -- ../../.cloudflare/sample-vault 2
```

Use the built CLI (`npm run build` builds only local packages) or install the
published CLI separately. In a private shell, set `VAULT_AGENT_SERVER_ENDPOINT`
to the deployment HTTPS origin and `VAULT_AGENT_VAULT_ROOT` to the generated
sample directory. Set `VAULT_AGENT_API_KEY` to the admin secret using your secret
manager or a hidden prompt. Obtain VAULT_UUID from the private generated config.
For example in bash, a hidden prompt avoids putting a secret in shell history:

```sh
read -rs -p 'Admin token: ' VAULT_AGENT_API_KEY
export VAULT_AGENT_API_KEY
node packages/cli/dist/main.js upload --vault-id VAULT_UUID --include Notes images --exclude '**/secret.md' --dry-run
node packages/cli/dist/main.js upload --resume PLAN_UUID
node packages/cli/dist/main.js search apple --mode lexical --json
node packages/cli/dist/main.js get note NOTE_ID --json
```

Use the dry run's actual plan ID and a search result's actual note ID. The dry
run sends no content and shows selected paths/bytes, destination and processing
scope. Check that `Notes/secret.md` is excluded. Use the same exclusions on the
client and server. Narrow candidates with search and retrieve only needed IDs.
Use the read token for ongoing retrieval; the admin token is required for upload.
Change a sample note, rerun the dry run and upload, then remove a sample note
and upload with `--delete-removed`. Verify search updates and old IDs return 404
once the deletion snapshot publishes. A stale pinned HTTP get must return 409.

For HTTP, use bearer headers over HTTPS, `POST /search` with JSON
`{"query":"apple","mode":"lexical","limit":5}`, then
`GET /notes/NOTE_ID?snapshot=SNAPSHOT` using the response revision. An unauthenticated
request must fail; a read token must get 403 on admin upload/index routes.
Never put tokens in query parameters. Store client settings only in user-local
config/environment, outside Git.

## Native MCP client

Configure a client that supports Streamable HTTP, URL `https://YOUR_WORKER/mcp`
and an `Authorization: Bearer READ_TOKEN` header supplied privately. The server
supports stateless POST transport protocol `2025-03-26`, initialize, list tools
and tool calls. Initialize/list/search/get with the actual client before
onboarding. It has no OAuth login, SSE subscription or durable session.
If the client sends an Origin, allow that exact HTTPS origin explicitly in the
Worker policy. The local `vault-agent mcp` stdio bridge opens a local vault; it
does **not** forward requests to a cloud endpoint. See [MCP and HTTP contracts](phases/cloudflare-deployment/specifications/api-clients.md).

## Direct R2 changes with no uploader running

Only `<VAULT_UUID>/source/<vault-relative-path>` is externally editable. Use
the dashboard or authenticated Wrangler `r2 object put BUCKET/KEY --remote --file FILE`
and `r2 object delete BUCKET/KEY --remote`. Do not edit immutable snapshot or
staging objects. Include/exclude rules still apply.

Stop all local upload processes. In the private bucket:

1. Create `Notes/Direct.md`, then overwrite its body with a new synthetic marker.
2. Replace `images/chart.svg` and verify explicit attachment metadata/download.
3. Rename the note by creating `Notes/Renamed.md` and deleting `Notes/Direct.md`.
4. Delete the renamed note and confirm both its old note and chunk IDs fail.
5. Add `Notes/secret.md` and an unrelated prefix object; neither may appear.

For every change record write time, `/status` observation time, active revision
and publication time. Poll only reads; do not call index/advance/upload during
this check. Confirm actual Cron executions in the dashboard. Target detection
and publication delays are specified in [scoped ingestion](phases/cloudflare-deployment/specifications/scoped-ingestion.md);
they are conditional targets, not a synchronization guarantee. The current
last immutable snapshot remains retrievable during detection/building, including
content pending deletion. Published deletion revokes it. Stale/failed status is
visible through `/status`; do not interpret health as index freshness.

For recovery, inspect the status error and job checkpoint; correct invalid
source/scope or provider availability, then request a fresh `/index` with
`{"newScan":true}` using admin authentication. Cron continues committed jobs
without clients. A full `/reindex` rebuild uses retained source and consumes
additional writes/storage. Do not delete D1 job rows to force progress.

## Optional semantic retrieval

For a new semantic trial, create a dedicated Vectorize V2 index before enabling
consent. Use the chosen deployment name as INDEX_NAME:

```sh
packages/cloudflare/node_modules/.bin/wrangler vectorize create INDEX_NAME --dimensions 1024 --metric cosine
packages/cloudflare/node_modules/.bin/wrangler vectorize create-metadata-index INDEX_NAME --property-name chunkId --type string
```

For a fresh configuration, select `semantic` instead of `lexical` when running
the configuration generator. For an existing deployment, preserve its vault
UUID/resources and add `ai: {"binding":"AI"}` and
`vectorize: [{"binding":"VECTORS","index_name":"INDEX_NAME"}]`, then explicitly
set `EXTERNAL_EMBEDDING_CONSENT` to `"true"`. The model is
`@cf/baai/bge-m3`, 1024 dimensions, cosine, revision `operator-v1`. Confirm actual
model availability and review [semantic limits](phases/cloudflare-deployment/specifications/semantic-retrieval.md).
Deploy with migrations, then request `/reindex` with
`{"requireEmbeddings":true,"newScan":true}` or upload with `--require-embeddings`.
Wait for a ready generation before testing embedding search. Cached exact
inputs can avoid repeat AI calls but every retained generation stores vectors.

## Upgrade, migration and rotation

Keep a private inventory of Worker, Cron, bucket, D1 UUID, optional Vectorize
index, stable vault UUID, credential names and deployment revision. Back up
source and use D1 Time Travel/export as appropriate to your account's retention
policy. Exports contain vault-derived data and belong outside Git.

Review release migration notes, update source/dependencies, dry-build, apply all
pending migrations and deploy using the **existing** local configuration. SQL
migrations are applied by the deploy script before the Worker changes. Do not
rerun configuration generation to upgrade. Disable automatic Builds deployment
while coordinating an incompatible migration. Code rollback does not undo SQL
or embedding descriptor changes; retain a known compatible version and source
backup. Model/input-format changes require an explicit full embedding rebuild.

Rotate without mixing privileges: install `PREVIOUS_READ_TOKEN` with the old
read value and `PREVIOUS_ADMIN_TOKEN` with the old admin value, set new distinct
current secrets, update clients, test new tokens, then delete both previous
secrets. Use `wrangler secret put/delete NAME --config .cloudflare/wrangler.jsonc`;
allow secret deployment changes to propagate and verify revoked tokens fail on
HTTP and MCP. The hosted trial observed an old credential still accepted
immediately after secret deletion, then confirmed both old credentials rejected
on a later check. There are no application sessions retaining revoked access;
provider deployment propagation is a separate delay. Separately rotate/revoke Cloudflare API tokens, R2 S3 credentials
and Workers Builds integration credentials if you created them. Cron uses native
bindings and requires no separate external credential.

## Remove compute and all retained data

For a dedicated trial, use your recorded resource inventory. Disable Builds
triggers and Cron first; wait for already admitted jobs to stop. Delete the
Worker with `wrangler delete --config .cloudflare/wrangler.jsonc`; verify the
schedule and secrets are gone. Worker removal alone leaves vault-derived data.

Empty the **dedicated** bucket in the dashboard (including mutable source,
staging, obsolete snapshots and any unfinished multipart uploads), then delete
it using `wrangler r2 bucket delete BUCKET`. Delete the dedicated D1 database
using `wrangler d1 delete DATABASE_NAME`; this removes content, FTS/grams, jobs,
cache and telemetry tables. Delete optional Vectorize using
`wrangler vectorize delete INDEX_NAME`; old vectors may remain stored until
index deletion even when retrieval has been revoked. Verify resource absence
with provider reads/listing and ensure no public bucket domain remains.

Remove private local upload plans/config, exports, sample vault and local
Wrangler state; revoke trial-only provider credentials and remove the cloned
Builds project/repository connection if no longer needed. Deleting a shared
bucket/database/index can affect other data, so this walkthrough always uses
new dedicated resources. Provider backup/Time Travel retention is separate from
live-resource deletion; no immediate backup-erasure promise is made.
