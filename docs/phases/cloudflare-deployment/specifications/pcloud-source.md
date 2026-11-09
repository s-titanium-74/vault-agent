# pCloud original source (#51, #67)

## Initial scope

Explicit opt-in selects one normal pCloud folder per local configuration or
Worker deployment. The adapter defaults to read-only. An administrator can
explicitly enable Markdown writes through MCP in review mode (default) or
explicitly opt into direct mode (#72). Crypto folders, shortcuts, attachments and guidance are
not supported initially; Markdown (.md/.markdown) notes only. Existing filesystem
and R2 sources remain defaults. Switching source requires a separate index or
fresh deployment; never reuse an existing deployment across source identities.

The same Web API adapter runs in Node and Workers. It observes folder membership
and provider versions, downloads bounded bytes, and supplies verified SHA-256
revisions to the existing shared parsing, chunking, link, embedding and delta
functions. SQLite/D1 keep indexed bodies and chunks. pCloud originals are never
copied to R2, including staging or published snapshots. pCloud mode requires no
R2 binding or bucket. D1 checkpoint rows hold prepared derived index data.

## Configuration and processing

Local opt-in uses a user-local [vault.pcloud] table: region (us/eu), folder_id
(decimal string), access_token (secret), includes (explicit nonempty relative
paths; ["."] explicitly selects the whole folder), and poll_seconds (at least
60, default 300). vault.root is unused in this mode. vault.exclude still applies.
Worker opt-in uses SOURCE_PROVIDER=pcloud, PCLOUD_REGION, PCLOUD_FOLDER_ID and
PCLOUD_ACCESS_TOKEN (Worker secret); INCLUDE_PATHS and EXCLUDE_PATHS still apply.
Use a fresh D1 deployment and generate a pCloud config without R2 provisioning.
INGESTION_ENABLED controls scheduled reconciliation; authenticated /index and
/reindex start jobs, existing advance/status calls resume them. Upload is
unsupported in pCloud mode. Locally index/reindex and server startup ingest;
periodic server polling runs only with watch.enabled, and manual /index remains
available. When writes are enabled, the local mutation runtime also reconciles
committed changes independently of polling. Stopping the process or disabling ingestion pauses updates. A retry
starts from a new complete observation or resumes a cloud checkpoint.

pCloud authentication permissions may cover more than the chosen folder.
Application scope is enforced separately and does not reduce token authority.
Prefer a dedicated account/shared synthetic folder and revoke tokens when done.
No automatic OAuth/browser flow or account-region discovery is performed.
Tokens must never enter repository config, logs or public output. pCloud sees
API metadata/read requests; enumerating the selected root transfers its folder
metadata, including excluded filenames, transiently to the selected runtime;
only admitted Markdown bodies are downloaded and indexed; local SQLite retains derived text locally; Workers
send selected originals transiently to Cloudflare and store derived text in D1.
Embedding remains a separate opt-in with the existing provider disclosure.

## Consistency and failure semantics

Provider hash is an opaque 64-bit change marker, never SHA-256. Preserve its
JSON decimal digits without lossy Number conversion. File ID, hash, size and
modified metadata identify observations. Verify parent folder membership on
path resolution and verify metadata before/after downloads. Reject unsafe path
segments, encrypted entries, malformed/partial listings, duplicate paths/IDs,
invalid UTF-8, excessive sizes, timeouts and cancellation with fixed errors.
Never interpret failed listing as an empty vault. Do not follow note links.

Observe membership again after preparation and before publication. A source
change aborts publication and retains the prior complete index. D1 fencing and
publication CAS remain in force. Remote APIs cannot provide a transaction with
SQLite/D1: a change after the final observation is detected on the next poll
or explicit note read. Search and chunk retrieval use the committed index;
note retrieval reads only the requested path and verifies its indexed digest.
No search request enumerates pCloud. A missing/changed/unavailable original
returns a sanitized failure; latest content never substitutes for an indexed
revision. Indexed chunks may remain readable while the source is unavailable.

The initial adapter supports only matching current revisions. Further official
research found that the [global parameters](https://docs.pcloud.com/methods/intro/global_parameters.html)
explicitly allow `revisionid` on file methods and name `getfilelink` as an
example. Combined with `listrevisions`, this documents a non-mutating historic
read mechanism even though the method-specific parameter list omits it. This
implementation deliberately does not advertise historic reads: mapping an
indexed digest to a retained revision, provider retention, deletion/permission
behavior and cross-region operation have not been verified on a real account.
A future adapter extension can resolve revisionid internally and verify returned
bytes against the requested SHA-256; it must never call `revertrevision`.
History expiry, delete/move/rename or lost permission can make an indexed note
unavailable. The current release reports mismatch/unavailability and requires
reconciliation; it never substitutes latest content or introduces R2 copies.

API requests explicitly reset connection authentication (`logout=1`) and supply
the configured OAuth token, reset metadata filtering, and select RFC2822 dates.
This avoids inheriting connection-level authentication/formatting state. The
`nofiles` presence flag is never sent: even a zero value may request a folders-only
listing. No application token is forwarded to content download servers.

Scope budgets are explicit and fail closed rather than publishing a truncated
vault. The note-count ceiling is 10,000 locally and 500 on Workers.
A recursive listing remains limited to 10,000 entries and a 4 MiB response,
so folders and metadata size can reduce the usable note count.
The per-note limit is 2 MiB. Large delta fallback follows existing Worker
rebuild rules.
Ordinary reconciliation trusts the complete provider observation (file ID,
hash, size, timestamp and parent) to detect changes. Only new or changed notes
need a body download during incremental reconciliation. A changed body with
identical provider metadata is detected by an explicit revision-checked read
or full reindex. SHA-256 still identifies the downloaded bytes. SQLite records
the provider version alongside the index transaction. Existing SQLite indexes
without those observations download the scoped corpus once to establish them.
Workers reuse the observations already stored in D1.

On local SQLite, index publication also reconciles the version and content
hash of settled pCloud mutation paths with the verified, published revision.
This uses the same mutation fence as index publication. Deleted, pending and
unresolved paths keep their existing visibility guards. If the index commits
before the mutation journal update is durable, reads still require a matching
hash. The next successful scan retries reconciliation, including for revisions
whose stored observation still matches the provider metadata.

## Evidence

Contract and runtime tests use synthetic data and mocked pCloud HTTP responses.
These do not prove real-account permissions, provider consistency, account
history retention or deployed Worker behavior. Real pCloud and hosted smoke
results must be recorded separately; no private account is accessed implicitly.

Official references checked 2026-11-02:

- https://docs.pcloud.com/methods/folder/listfolder.html
- https://docs.pcloud.com/structures/metadata.html
- https://docs.pcloud.com/methods/streaming/getfilelink.html
- https://docs.pcloud.com/methods/revisions/listrevisions.html
- https://docs.pcloud.com/methods/intro/global_parameters.html
- https://docs.pcloud.com/methods/oauth_2.0/authorize.html
- https://docs.pcloud.com/protocols/http_json_protocol/

## MCP writes (#67)

Use the existing READWRITE/ADMIN (or trusted local stdio) preview and apply workflow for scoped Markdown
create, replace, patch and delete in the Node and Workers runtimes. Enable
pCloud writes explicitly and use one vault-agent writer per configured root.
The shared pCloud adapter resolves paths from the configured folder ID and
checks the current exact-byte SHA-256 against the requested expected version. A known
mismatch before the provider request rejects the write. Creation uses
`createfolderifnotexists` for missing parents and `uploadfile` with `nopartial`.
A failed create can leave empty parent folders. Deletion uses the verified file
ID. Rename and attachments remain outside the MCP mutation scope.

Writes remain disabled by default. When enabled, `write.mode=review` (Node)
or `WRITE_MODE=review` (Workers) remains the default and requires a diff preview
and its binding. Explicit `direct` mode uses `preview_changes` with
`preview:false` to allocate an operation ID without a diff or preview binding,
then `apply_changes` with that ID and the exact same operations. It adds no
single-call mutation API and does not bypass MCP client execution confirmation.
Authorization, issued IDs, request binding, replay protection, scope/size limits,
expected versions, asynchronous indexing and stale-chunk rejection still apply.

The documented pCloud upload and delete APIs have no expected-revision
parameter. The hash check and provider write are separate requests. External
writes, including pCloud Sync and edits from the pCloud web UI, can intervene
between them. Read-back verification confirms the resulting state and cannot
prove that an intervening update was preserved. Deployment with this model
requires exclusive write ownership of the configured scope.
Direct mode changes only the preview requirement, not this concurrency boundary.

After a confirmed write, use source reconciliation to update SQLite or D1.
An ambiguous provider outcome enters reconciliation. The runtime checks
current state after a delay and compares it with the intended result, without
replaying the write. Use the same operation ID to inspect the outcome. Keep tokens in the existing environment or Worker
secret, sanitize provider failures, and keep originals in pCloud.

Synthetic tests cover scope, stale revisions, read-back verification,
ambiguous outcomes and index convergence. The [upload API](https://docs.pcloud.com/methods/file/uploadfile.html),
[folder API](https://docs.pcloud.com/methods/folder/createfolderifnotexists.html) and
[delete API](https://docs.pcloud.com/methods/file/deletefile.html) describe the
provider operations used here.

## Setup examples

Local user config (outside the repository):

```toml
[vault.pcloud]
region = "eu"
folder_id = "123456"
includes = ["Notes"]
poll_seconds = 300
```

Set VAULT_AGENT_PCLOUD_ACCESS_TOKEN in the process environment (prefer a secret
manager). It overrides access_token without persisting the environment secret
when other settings are saved. Existing `vault-agent index`, `reindex`, `serve`,
`search` and `get` commands apply. `config get --json`, including parent objects,
redacts the token. Local `/status` adds a `source` object with polling policy,
interval, last successful update and freshness; filesystem watch is disabled.

Cloud config generation (resource creation remains an explicit operator step):

```sh
npm run configure --prefix packages/cloudflare -- synthetic-vault REPLACE_D1_UUID lexical paid pcloud eu 123456
```

Create only D1 (and optional Vectorize for semantic mode), review the generated
`.cloudflare/wrangler.jsonc` scope, and set PCLOUD_ACCESS_TOKEN together with
READ_TOKEN and ADMIN_TOKEN as Worker secrets using that configuration. Apply
migrations and deploy using the existing deploy script. Do not create an R2
bucket. Source credentials are not vault bearer tokens. Removing this deployment
removes neither the pCloud originals nor provider backups; revoke its pCloud
token and delete D1/Vectorize and Worker resources separately.

Worker cron advances up to eight checkpoints per invocation; a large folder can
require many scheduled invocations per scan. This initial correctness-first
path lists metadata each scan and reads changed originals. Local source data and staged derived rows remain private.
