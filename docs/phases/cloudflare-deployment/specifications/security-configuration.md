# Cloudflare Security And Configuration

Status: Ready for Review

## Explicit Setup And Transmission

Cloud installation is separate from local installation. Setup creates one
deployment/vault identity and private R2, D1, and optional Vectorize bindings.
It must disclose that Cloudflare receives selected paths, source files,
derived index text, metadata, and authenticated queries. These are private
vault-derived data even when an index stores only fragments or embeddings.

Upload selection requires explicit vault-relative include paths. `.` means
the entire allowed vault and must be explicitly selected; there is no implicit
whole-vault upload. Allowed Markdown and attachments (including PDFs/images)
are uploaded together inside that scope. Attachments are for explicit
metadata/byte retrieval only: no OCR, extraction, embedding, or attachment
text search in this release. Do not follow links to upload files outside scope
or fetch remote URLs referenced by notes.

Client selection and Worker validation both apply default and configured
exclusions. Reject symlinks for cloud upload, including internal symlinks;
resolve/check parent boundaries before reading and detect changes during
reading. Exclude hidden paths, `.git`, `.obsidian`, dependency folders, generated
data, caches, and logs. Only the existing guidance allowlist may admit hidden
guidance paths such as `.cursorrules` and `.cursor/rules/*`; it never admits
arbitrary hidden files. Guidance remains untrusted vault context and is not
injected into search, related, orientation, or system instructions.

`externalStorageConsent` must be explicitly enabled in user-local cloud upload
settings. Semantic mode additionally requires `externalEmbeddingConsent` in
deployment settings, a selected model, and valid Vectorize configuration.
Binding an AI service alone does not enable it. The consent disclosure covers
document embedding input (title, metadata, headings, and chunk text), query
text, and related context processed to build embeddings. Clients invoking the
deployment accept its configured processing policy; clients can request
`mode: lexical` to avoid query embedding. Omitted mode follows existing
configured-embedding behavior. No chat/LLM generation is added.

Deployment settings include `vaultId`, allowed include paths, excludes,
profile value allowlist, consent flags, model descriptor, storage bindings,
MCP enablement, allowed Origins, and measured batch budgets. These are a
separate cloud schema, not defaults added to local `Config`. Endpoint, local
root, upload selection, and credentials stay in user-local configuration or
environment variables. Samples use synthetic paths and placeholders only.
The server's configured scope bounds what an upload token can publish; a
client cannot expand it. Scope expansion requires explicit setup changes.

## Authentication And Trust Boundaries

- Require HTTPS and an independently generated random bearer credential with
  at least 256 bits of entropy. Use separate read and admin credentials;
  admin includes read access and ingestion/index privileges. Never accept a
  read token for mutation. Validate before reading/parsing vault request bodies
  or accessing storage. Compare secrets without content-dependent timing.
- Store credentials in Worker secrets, never source, public vars, URL query
  parameters, upload manifests, or command arguments shown in history. Client
  tokens use user-local config/environment, with redacted config/status output.
- Cloudflare provisioning credentials are distinct from vault access tokens.
  Use resource-scoped deployment permissions. Workers use service bindings;
  clients need no direct D1/R2/AI/Vectorize account token.
- Fail closed if required secrets/bindings are absent. Missing bearer returns
  `401 AUTH_REQUIRED`; invalid bearer returns `403 AUTH_FAILED`; read token on
  admin surface returns `403 ADMIN_REQUIRED`. Authenticate even unsupported
  data/admin routes before reporting capability details.
- R2 has no public bucket endpoint/custom domain; no signed public downloads.
  Worker attachment responses require the same read authentication as notes.
- All data/metadata/status/MCP/admin responses have `Cache-Control: no-store`.
  Do not use CDN or application response caching in the initial release.
  Disable content/request logging and AI Gateway payload caching/logging.
- CORS defaults to no browser origins. If `Origin` is present, match a configured
  exact HTTPS origin or reject with 403 before dispatch, including `/mcp`.
  Absence of Origin is permitted for authenticated CLI/MCP clients. No wildcard
  origins or cookie-based authentication. Bound request bytes, query/result
  limits, execution deadlines, and per-deployment request rate; 429 uses
  `RATE_LIMITED` and `Retry-After` without echoing the request.
- Token rotation supports a short explicit old/new overlap, followed by old
  token revocation on every route. No in-memory isolate session may bypass
  authentication. Account operators and connected agent clients can access
  authorized content; this is not end-to-end encryption from the provider.

The only public exception is `GET /health` returning `{"status":"ok"}` for
liveness, without counts, vault identity, binding/model configuration, or
index state. Readiness requires authenticated `/status`. It must be possible
to protect health as well at the ingress layer.

## Diagnostics And Data Removal

Logs contain only operation code, random request/job ID, counts, durations,
and normalized failure codes. No bodies, chunks, queries, frontmatter values,
raw URLs/paths, headers, secrets, provider error text, or unsanitized stacks.
Authorized dry-run output may show selected vault-relative paths; application
logs may not. Errors use fixed actionable messages and sanitized details.

Deployment docs must explain that deleting the Worker does not delete its R2,
D1, Vectorize, backups, or staged objects. Removing a note revokes API access
at publication; physical cleanup is tracked and retried separately. Backup
retention and provider-managed deletion are disclosed during teardown, without
promising immediate erasure from provider backups. The account owner removes
retained resources and credentials through the #35 teardown procedure.

The [Workers AI data-usage policy](https://developers.cloudflare.com/workers-ai/platform/data-usage/)
is a setup review reference, not a promise of zero stored vault data: this
product intentionally persists source and indexes in Cloudflare storage.
