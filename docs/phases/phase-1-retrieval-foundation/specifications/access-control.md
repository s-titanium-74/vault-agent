# Shared HTTP Access Control (#44)

Local REST, local MCP HTTP and Cloudflare use the runtime-neutral
`@vault-agent/core/access` module for Bearer parsing, role resolution and
operation permissions. This is a transport policy module, independent of
retrieval/index logic, Node, Fastify and Workers. Adapters load secrets, compare
them safely and format responses. ADMIN includes READWRITE and READ; READWRITE includes READ.

## Local configuration and migration

User-local `[server]` TOML accepts `read_key`, `admin_key`,
`previous_read_key`, `previous_admin_key`, optional `readwrite_key`,
`previous_readwrite_key` (camelCase config keys `readKey`,
`adminKey`, `previousReadKey`, `previousAdminKey`, `readwriteKey`,
`previousReadwriteKey`). Environment equivalents are
`VAULT_AGENT_READ_KEY`, `VAULT_AGENT_ADMIN_KEY`,
`VAULT_AGENT_PREVIOUS_READ_KEY`, `VAULT_AGENT_PREVIOUS_ADMIN_KEY`,
`VAULT_AGENT_READWRITE_KEY`, `VAULT_AGENT_PREVIOUS_READWRITE_KEY`.
Existing precedence remains CLI, environment, TOML, defaults. Empty environment
values for these keys explicitly clear the corresponding stored value.

When any role key is nonempty, current read/admin keys are required; a previous readwrite key also requires a current readwrite key; each must
contain at least 32 ASCII letters, digits, underscores or hyphens. Generate
independent random secrets with at least 256 bits of entropy. Previous keys are
optional explicit rotation overlap. Cross-role equality, including previous
keys, is invalid; same-role equality is harmless. Removing a previous key
revokes it on the next server start/config reload (configuration is immutable
for a running server). No keys are echoed in errors, logs or ordinary config
output. `config get` (with or without a key) redacts all six secrets.

Legacy `server.apiKey` / TOML `api_key` / `VAULT_AGENT_API_KEY` continues to grant
admin and read when role keys are absent. Mixing a nonempty legacy key with
role keys fails closed, without precedence between roles. To migrate, generate
both role keys and remove the legacy key from every configured source before
restarting. A partial or conflicting configuration never disables auth and
never triggers automatic key generation.

With no keys, localhost retains unauthenticated access. Non-localhost requires
credentials; existing automatic legacy-key generation in the default user-local
config and legacy minimum length validation remain. Explicit host configuration
is still required to bind beyond localhost. Split keys enforce auth on localhost
too. Direct local CLI processing, stdio MCP, startup indexing, watchers,
scheduled Git sync and Workers Cron run within their existing process trust
boundary and do not use HTTP credentials.

For example, set both keys in the user-local config (replace placeholders with
independently generated secrets; do not commit this file):

```toml
[server]
read_key = "<independently-generated-read-secret>"
readwrite_key = "<optional-independently-generated-editing-secret>"
admin_key = "<independently-generated-admin-secret>"
```

## Operations and responses

| Surface                                                                                        | Permission                          |
| ---------------------------------------------------------------------------------------------- | ----------------------------------- |
| Search/related POST, note/chunk/attachment GET, status, orientation, guidance, links, profiles | read                                |
| Local health (contains index metadata)                                                         | read                                |
| All index/reindex/upload/uploads/sync/watch paths, including unsupported methods               | admin                               |
| Job GET                                                                                        | read                                |
| Job mutation                                                                                   | admin                               |
| MCP initialize, list, call, notifications, GET/DELETE and reused sessions                      | read                                |
| Unknown HTTP paths                                                                             | read before capability/404 response |

The existing read REST paths are `POST /search`, `POST /related`,
`GET /notes/:noteId`, `GET /chunks/:noteId/:chunkIndex`, `GET /attachments/*`,
`GET /status`, `GET /overview`, `GET /tree`, `GET /tags`, `GET /facets`,
`GET /agent-guidance`, `GET /agent-guidance/*`, `GET /links/notes/:noteId`,
`GET /links/backlinks/:noteId`, `GET /links/broken`, `GET /links/orphans`,
`GET /links/summary`, `GET /profiles/metadata`, `GET /profiles/style` and local
`GET /health`. Local mutations are `POST /index`, `POST /reindex` and
`POST /sync/pull`; watch has no HTTP mutation implementation. Workers adds
`POST /uploads`, `PUT /uploads/:id/manifest`, `PUT /uploads/:id/files/*`,
`POST /uploads/:id/commit`, `GET /jobs/:id`, `POST /jobs/:id/advance` and
its native `POST /index` / `POST /reindex`. Shared family classification also
protects unsupported methods and paths before capability responses.

Cloudflare alone keeps public `GET /health` with minimal liveness. Local
`POST /sync/webhook` alone uses its existing dedicated HMAC authentication;
other webhook methods require admin. No general sync-path bypass is allowed.
Every retrieval MCP tool requires READ: `search`, `get_note`, `get_chunk`,
`get_attachment`, `related`, `vault_overview`, `vault_tree`, `vault_tags`,
`vault_facets`, `vault_guidance_list`, `vault_guidance_get`, `vault_links`,
`vault_backlinks`, `vault_broken_links`, `vault_orphans`, `vault_link_summary`,
`vault_metadata_profile` and `vault_style_profile`. Unknown tools cannot dispatch mutations.

The opt-in [local MCP mutation extension](../../mcp-vault-mutations/specifications/local-mcp.md)
adds three READWRITE-or-ADMIN MCP tools: `preview_changes`, `apply_changes`,
`get_change_status`, including preview/status. Read callers cannot
list/call them. Enabled HTTP writes require distinct read/admin credentials,
including localhost; authenticate every request and bind sessions to their role.

Missing credentials return 401 `AUTH_REQUIRED`; malformed/unknown credentials
return 403 `AUTH_FAILED`; READ/READWRITE on admin returns 403 `ADMIN_REQUIRED`; READ on mutation returns
403 `READWRITE_REQUIRED`. Management authorization precedes body parsing;
MCP mutation authorization follows bounded JSON parsing and precedes operation
preparation or side effects. Local REST and MCP HTTP use this model;
MCP maps it to JSON-RPC authentication errors. This replaces legacy REST's
uniform 401 `UNAUTHORIZED`. Authentication is repeated on every HTTP request,
regardless of MCP session ID. Cloudflare retains the existing token format,
rotation, Origin checks and mandatory-auth configuration.

CLI `--api-key` remains an explicit credential override, including for cloud
clients. A client may store only its own current role key; a server requires both.
With local role configuration, read commands select `readKey` and
index/reindex/sync mutations select `adminKey`; editing clients explicitly select
`readwriteKey` (or supply their own Bearer credential); neither implicitly falls back
to the other role. Legacy-only clients keep using `apiKey`. Prefer environment
or user-local config over command-line secrets. `serve` accepts role keys via
user-local config/environment; it validates after its existing CLI overrides.

Tests use synthetic credentials and a common authentication table for missing,
malformed, unknown, read/readwrite/admin, overlap and revocation. Runtime tests additionally
cover routes, unsupported methods, early rejection and MCP session reuse.

## READWRITE credential setup (#73)

READWRITE never enables writes or bypasses review/direct mode, provider/source
scope, version checks, replay protection, operation IDs or size limits. Saves
schedule existing background indexing; all index/reindex/upload/sync/watch and
job advancement endpoints remain ADMIN-only, including unsupported methods.
The route table above is unchanged for every existing REST route. MCP transport
initialize/list/call/notifications/GET/DELETE requires READ; each mutation call
additionally requires READWRITE when writes are enabled. Disabled mutations
remain unavailable to all roles. Local write-enabled sessions bind exactly to
READ, READWRITE or ADMIN; any role switch requires a fresh initialize, including
GET and DELETE. Rotation within the same role works; every request rechecks keys.
Workers MCP remains stateless and checks each dispatch and the whole batch.
Stdio retains process trust and needs no HTTP keys.

Operators may add `server.readwriteKey` / `[server] readwrite_key` and optionally
`previous_readwrite_key`, keeping required read/admin keys distinct. Existing
READ/ADMIN and legacy configurations retain their permissions. A previous
READWRITE key requires its current key. Worker secrets are optional
`READWRITE_TOKEN` and `PREVIOUS_READWRITE_TOKEN` (64 lowercase hex characters,
distinct across all roles); overlap is revoked by removing the previous secret.
Local overlap is revoked on restart like other keys. Never put secrets in the
repository. Give an editing agent only the READWRITE Bearer credential for its
HTTP/MCP connection; retain ADMIN for operators. No client credential selection
falls back from READWRITE to ADMIN. A CLI client may store only its own role key;
read commands can use its READWRITE key when no READ key is present.
