# Shared HTTP Access Control (#44)

Local REST, local MCP HTTP and Cloudflare use the runtime-neutral
`@vault-agent/core/access` module for Bearer parsing, role resolution and
operation permissions. This is a transport policy module, independent of
retrieval/index logic, Node, Fastify and Workers. Adapters load secrets, compare
them safely and format responses. Admin includes read.

## Local configuration and migration

User-local `[server]` TOML accepts `read_key`, `admin_key`,
`previous_read_key`, `previous_admin_key` (camelCase config keys `readKey`,
`adminKey`, `previousReadKey`, `previousAdminKey`). Environment equivalents are
`VAULT_AGENT_READ_KEY`, `VAULT_AGENT_ADMIN_KEY`,
`VAULT_AGENT_PREVIOUS_READ_KEY`, `VAULT_AGENT_PREVIOUS_ADMIN_KEY`.
Existing precedence remains CLI, environment, TOML, defaults. Empty environment
values for these keys explicitly clear the corresponding stored value.

When any role key is nonempty, both current role keys are required; each must
contain at least 32 ASCII letters, digits, underscores or hyphens. Generate
independent random secrets with at least 256 bits of entropy. Previous keys are
optional explicit rotation overlap. Cross-role equality, including previous
keys, is invalid; same-role equality is harmless. Removing a previous key
revokes it on the next server start/config reload (configuration is immutable
for a running server). No keys are echoed in errors, logs or ordinary config
output. `config get` (with or without a key) redacts all four secrets.

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
All existing MCP tools are read operations; unknown tools cannot dispatch
mutations. Adding a future mutation tool requires an explicit admin check.

Missing credentials return 401 `AUTH_REQUIRED`; malformed/unknown credentials
return 403 `AUTH_FAILED`; read on admin returns 403 `ADMIN_REQUIRED`, before
request body parsing or side effects. Local REST and MCP HTTP use this model;
MCP maps it to JSON-RPC authentication errors. This replaces legacy REST's
uniform 401 `UNAUTHORIZED`. Authentication is repeated on every HTTP request,
regardless of MCP session ID. Cloudflare retains the existing token format,
rotation, Origin checks and mandatory-auth configuration.

CLI `--api-key` remains an explicit credential override, including for cloud
clients. A client may store only its own current role key; a server requires both.
With local role configuration, read commands select `readKey` and
index/reindex/sync mutations select `adminKey`; neither implicitly falls back
to the other role. Legacy-only clients keep using `apiKey`. Prefer environment
or user-local config over command-line secrets. `serve` accepts role keys via
user-local config/environment; it validates after its existing CLI overrides.

Tests use synthetic credentials and a common authentication table for missing,
malformed, unknown, read/admin, overlap and revocation. Runtime tests additionally
cover routes, unsupported methods, early rejection and MCP session reuse.
