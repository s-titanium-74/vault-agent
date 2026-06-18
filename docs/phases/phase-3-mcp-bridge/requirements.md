# Phase 3 MCP Bridge Requirements

Status: Ready for Review

## Purpose

Phase 3 adds an MCP (Model Context Protocol) bridge to `vault-agent`, letting
MCP-compatible clients such as Claude Desktop, Cursor, and other AI agent
runtimes safely retrieve vault context in stages.

The MCP bridge exposes `search`, `get`, and `related` as MCP tools through a
thin adapter layer that connects directly to core. This avoids requiring an
HTTP server for stdio transport while maintaining identical data scope and
privacy guarantees as the HTTP API.

Phase 3 must preserve the product direction from `docs/product-plan.md`:
local-first, private-by-default, deterministic retrieval, progressive
disclosure, one vault root per server process, and a clean separation between
core, server, and CLI responsibilities.

## Open Product Decisions

No unresolved product decisions are known in this draft. If implementation
raises a behavior, public API, security, privacy, or architecture choice that is
not covered here or in the linked specifications, add it to this section before
implementation.

## Scope

Phase 3 must include:

- MCP tools for search, get_note, get_chunk, get_attachment, and related.
- stdio transport as the default MCP connection method.
- Streamable HTTP transport as an optional MCP connection method.
- A dedicated `vault-agent mcp` CLI command for stdio transport only.
- An HTTP `/mcp` endpoint for Streamable HTTP transport (available through
  `vault-agent serve` with MCP enabled).
- Direct core access from MCP tools (not routed through HTTP server).
- MCP tool descriptions aligned with Phase 1 requirements.
- Streamable HTTP transport access control consistent with Phase 1 server
  access control.
- Configuration for MCP enablement, transport, and endpoint.
- Documentation with MCP client connection examples.
- Tests using synthetic Markdown fixtures.

Phase 3 builds on Phase 1 and Phase 2. Unless this phase explicitly overrides
a Phase 1 or Phase 2 behavior, server access control, response envelopes, CLI
JSON behavior, configuration precedence, logging policy, path safety, indexing
safety, and privacy requirements continue to apply.

Phase 3 must not include:

- MCP Resources (tools-only in Phase 3).
- Chat or LLM answer generation.
- An Obsidian plugin.
- Note writing or editing workflows.
- Multiple vaults in one server process.
- Automatic embedding model downloads.

## Phase Acceptance Criteria

Phase 3 is complete when an MCP-compatible client can connect to `vault-agent`
via stdio or Streamable HTTP and use MCP tools to search, retrieve, and find
related candidates from a local Markdown vault.

Acceptance criteria:

- `vault-agent mcp` starts an stdio-based MCP server that MCP clients can
  connect to.
- The `search` tool returns compact search results via MCP, with the same
  field names, types, defaults, and error codes as `POST /search` response
  body, wrapped in the MCP JSON-RPC result structure.
- The `get_note` tool returns an explicitly requested note via MCP, with the
  same field names, types, defaults, and error codes as `GET /notes/{noteId}`
  response body, wrapped in the MCP JSON-RPC result structure.
- The `get_chunk` tool returns an explicitly requested chunk via MCP, with the
  same field names, types, defaults, and error codes as
  `GET /chunks/{noteId}/{chunkIndex}` response body, wrapped in the MCP
  JSON-RPC result structure.
- The `get_attachment` tool returns attachment metadata or downloads bytes via
  MCP, with the same field names, types, defaults, and error codes as
  `GET /attachments/{*vaultRelativePath}` response body, wrapped in the MCP
  JSON-RPC result structure.
- The `related` tool returns compact related candidates via MCP, with the same
  field names, types, defaults, and error codes as `POST /related` response
  body, wrapped in the MCP JSON-RPC result structure.
- Streamable HTTP transport is available at `/mcp` when explicitly configured.
- Streamable HTTP transport follows Phase 1 server access control: localhost
  binds may run without an API key, while non-localhost access requires API key
  authentication.
- MCP tools access the same core functions as the HTTP API, with identical data
  scope and privacy guarantees.
- Error responses from MCP tools do not include private absolute paths, note
  content, chunk content, raw queries, or secrets.
- MCP enablement, transport, and endpoint are configurable through user-local
  configuration, environment variables, or CLI flags.
- The default MCP transport is stdio; Streamable HTTP is opt-in.
- MCP HTTP endpoint is disabled by default in the server configuration.
- The `vault-agent mcp` command always works regardless of `mcp.enabled`
  setting (which controls only the Streamable HTTP endpoint on `vault-agent
serve`).
- The MCP server starts even without an index and returns actionable MCP errors
  when tools are invoked.
- The MCP server starts even without a configured vault root and returns
  actionable MCP errors when tools are invoked.
- MCP tool responses include Phase 2 index freshness warnings when available.
- The `get_note` and `get_chunk` tools follow Phase 2 safe-resolution rules
  when the index is in incompatible state.
- Documentation includes working connection configuration for Claude Desktop
  and Cursor.
- Troubleshooting guide covers vault-not-configured, index-not-available,
  MCP-not-enabled, and authentication-failed errors.
- The MCP server completes the MCP initialization handshake and capabilities
  negotiation correctly with at least one reference MCP client implementation
  (e.g., `@modelcontextprotocol/sdk` test client or Claude Desktop).
- Each MCP tool includes a description that accurately describes its purpose,
  inputs, and outputs, consistent with the Phase 1 API documentation.
- The `get_note` tool rejects oversized notes by default and returns them when
  `allowLarge=true`.
- The `get_attachment` tool rejects oversized downloads by default and returns
  base64-encoded bytes when `allowLarge=true` and `download=true`.
- The MCP server completes in-progress tool invocations and does not start new
  invocations after stdin is closed, then exits with code 0.
- The MCP server handles protocol version negotiation per the MCP
  specification, returning an error if the client requests an unsupported
  version.
- Concurrent HTTP MCP sessions receive independent responses; tool invocations
  in one session do not affect responses in another session.
- Tests cover MCP tools, stdio transport, Streamable HTTP transport,
  authentication, configuration, error handling, protocol compliance, and
  attachment download using only synthetic fixtures.

## MCP Tools

Specification: [MCP Tools](specifications/mcp-tools.md).

Phase 3 exposes the following MCP tools:

| Tool             | Description                                              | Input                                     | Output                      |
| ---------------- | -------------------------------------------------------- | ----------------------------------------- | --------------------------- |
| `search`         | Search the vault with lexical, embedding, or hybrid mode | query, mode?, limit?                      | Compact ranked results      |
| `get_note`       | Retrieve a note by ID                                    | noteId, allowLarge?                       | Note content with metadata  |
| `get_chunk`      | Retrieve a chunk by note ID and chunk index              | noteId, chunkIndex                        | Chunk content with metadata |
| `get_attachment` | Retrieve attachment metadata or download bytes           | vaultRelativePath, download?, allowLarge? | Metadata or file bytes      |
| `related`        | Find related candidates from a known note or chunk       | type, id, limit?, mode?                   | Compact related candidates  |

MCP tool descriptions must be accurate, concise, and aligned with Phase 1
requirements. MCP agents use tool descriptions to decide which tools to invoke.

Tool parameters must use snake_case naming. Tool names must be unambiguous and
consistent with the HTTP API.

## Tool Response Behavior

Specification: [MCP Tools](specifications/mcp-tools.md).

MCP tool responses follow the same data minimization rules as the HTTP API:

- Search and related results are compact. They must not include full note
  bodies or full chunks.
- Snippets are short and used only for decision support.
- Note retrieval returns the full Markdown content including frontmatter.
- Chunk retrieval returns only the requested chunk content.
- Attachment retrieval returns metadata by default; file bytes require an
  explicit download option.
- Responses prefer vault-relative paths and stable identifiers.
- Private absolute paths must not appear in MCP tool responses.

MCP tool results use the same inner payload structure as HTTP responses and
include Phase 2 freshness warnings in the `warnings` array at the top level of
the JSON-RPC result. MCP-specific extension fields are not used in Phase 3.

MCP tool responses include Phase 2 index freshness warnings when available:

- Search and related responses include freshness state and warnings.
- Incompatible index state causes search and related to fail with actionable
  MCP errors.
- Stale, pending, and updating states include visible warnings.

## MCP Tool Annotations

Specification: [MCP Tools](specifications/mcp-tools.md).

All Phase 3 MCP tools are read-only and non-destructive. Tool annotations
must declare:

- `readOnlyHint: true`
- `destructiveHint: false`
- `idempotentHint: true`

These annotations help MCP clients understand tool behavior without
trial-and-error.

Note: `search` and `related` tools are idempotent in intent, but results may
vary with index state. MCP clients should not rely on `idempotentHint: true`
for indefinite caching.

## Transports

Specification: [MCP Transports](specifications/mcp-transports.md).

### stdio Transport

stdio is the default MCP transport. The MCP server reads JSON-RPC messages from
stdin and writes responses to stdout.

stdio transport requirements:

- `vault-agent mcp` starts an stdio MCP server.
- The command does not accept `--transport` flag; stdio is the only transport
  for this command.
- stdio transport does not require API key authentication.
- The stdio process communicates with core directly.
- The stdio process does not start an HTTP server.
- stderr may be used for logging but must not interfere with the JSON-RPC
  message stream on stdout.
- The server processes one MCP session per process instance.
- The server completes in-progress tool invocations before shutting down when
  stdin is closed.
- The server always starts regardless of `mcp.enabled` setting.
- If no usable index exists, the server starts and returns actionable MCP
  errors when tools are invoked.

### Streamable HTTP Transport

Streamable HTTP transport is available through the `vault-agent serve` server.

Streamable HTTP transport requirements:

- The MCP endpoint is `/mcp` on the configured server host and port.
- The endpoint supports both POST and GET methods per the MCP Streamable HTTP
  transport specification.
- The client sends JSON-RPC messages via HTTP POST to the MCP endpoint.
- The server responds with either `Content-Type: application/json` for single
  responses or `Content-Type: text/event-stream` for streaming responses.
- The client may open an SSE stream via HTTP GET to receive server-to-client
  notifications and requests.
- The endpoint follows Phase 1 server access control. When API key
  authentication is configured or required for the server bind, clients supply
  it via `Authorization: Bearer <api-key>`.
- The endpoint is disabled by default and must be explicitly enabled through
  configuration (`mcp.enabled = true`).
- Binding and access control follow Phase 1 server access control rules.
- CORS follows Phase 1 CORS policy.
- Session lifecycle follows the MCP specification.
- Multiple concurrent clients are supported.
- MCP tool invocations are independent and stateless.

## MCP Protocol

Specification: [MCP Transports](specifications/mcp-transports.md).

### Protocol Version

Phase 3 targets MCP specification version 2025-03-26 or later.

### Capabilities

The MCP server advertises the following capabilities during initialization:

- `tools`: The server provides MCP tools.
- No resources, no prompts (Phase 3 limitation).

### Initialization Handshake

The server completes the MCP initialization handshake:

1. Client sends `initialize` request.
2. Server responds with protocol version and capabilities.
3. Client sends `initialized` notification.
4. Server is ready to accept tool requests.

### Error Handling

MCP tool errors use JSON-RPC error responses:

- Standard JSON-RPC error codes for protocol errors.
- Custom error codes in the `-32000` range for application errors.
- Error data includes Phase 1 error codes (e.g., `INDEX_NOT_FOUND`,
  `PATH_OUTSIDE_VAULT`, `EMBEDDING_UNAVAILABLE`).
- Error messages are actionable and sanitized.
- Error responses must not include raw note content, raw chunks, raw queries,
  secrets, provider credentials, or private absolute paths.

## CLI

Specification: [CLI](specifications/cli.md).

Phase 3 adds the following CLI command:

```bash
vault-agent mcp
```

The `mcp` command:

- Starts an MCP server using stdio transport.
- Does not accept `--transport` flag; stdio is the only transport.
- Reads vault configuration from user-local configuration and environment
  variables. The `mcp` command inherits global CLI flags (e.g., `--config`)
  but has no MCP-specific flags.
- Connects to core directly without starting an HTTP server.
- Always works regardless of `mcp.enabled` setting.
- Logs to stderr to avoid interfering with the MCP JSON-RPC stream on stdout.

## Configuration

Specification: [Configuration](specifications/configuration.md).

Phase 3 adds user-local configuration for MCP.

Configuration requirements:

- `mcp.enabled` (boolean, default: `false`) controls whether the Streamable
  HTTP MCP endpoint is available on `vault-agent serve`. It does not affect the
  `vault-agent mcp` command.
- `mcp.http.endpoint` (string, default: `"/mcp"`) sets the Streamable HTTP
  endpoint path. The endpoint path must not conflict with existing Phase 1/2
  HTTP API paths (`/search`, `/notes`, `/chunks`, `/attachments`, `/related`,
  `/health`, `/index`, `/reindex`, `/status`).
- Configuration precedence follows Phase 1: CLI flags, environment variables,
  user-local TOML, then built-in defaults.
- Private paths, credentials, and secrets must not be stored in repository
  files.

The repository may include only public-safe example MCP configuration.

## Security And Privacy

MCP bridge must preserve Phase 1 and Phase 2 data minimization rules.

Security and privacy requirements:

- MCP tools access the same core functions as the HTTP API.
- Data scope is identical to the HTTP API.
- MCP tool results use the same inner payload structure as HTTP responses
  (without the HTTP envelope wrapper), wrapped in the MCP JSON-RPC result
  structure.
- The MCP adapter must replicate server-level guarantees: path safety, logging,
  error sanitization. Shared enforcement logic should live in core or a shared
  middleware layer to prevent divergence between HTTP and MCP paths.
- Error responses must not include raw note content, raw chunks, raw queries,
  secrets, provider credentials, or private absolute paths.
- stdio transport does not require API key authentication.
- Streamable HTTP transport follows Phase 1 server access control. Localhost
  binds may run without an API key; non-localhost binds require API key
  authentication.
- MCP HTTP endpoint is opt-in; disabled by default.
- Single-vault boundary applies: one MCP server instance serves one vault root.
- Logs must not include full notes, full chunks, snippets, raw queries, request
  bodies, frontmatter values, attachment contents, API keys, tokens,
  credentials, provider secrets, or private absolute paths.

## Binary Content Handling

Specification: [MCP Tools](specifications/mcp-tools.md).

The `get_attachment` tool with `download=true` returns binary file bytes.

Binary content requirements:

- Binary content is base64-encoded in the MCP tool result.
- The response includes a MIME type field when detectable.
- Large file downloads (exceeding default size limit) require `allowLarge=true`.
- The default size limit is defined in the Phase 1 retrieval specification.
- The total MCP tool result payload must not exceed 50 MiB. Attachment
  downloads that would exceed this limit fail with `QUERY_TOO_LARGE` even with
  `allowLarge=true`.
- MCP tool results have practical size limits; very large files may not be
  suitable for MCP transport.
- When a file exceeds the hard limit even with `allowLarge=true`, the tool
  returns an error with code `QUERY_TOO_LARGE`.
- Documentation must recommend the HTTP API for large attachment downloads.

## Documentation

Specification: [MCP Client Guide](specifications/mcp-client-guide.md).

Phase 3 includes documentation for MCP client connection:

- Claude Desktop connection configuration.
- Cursor connection configuration.
- Other major MCP-compatible clients.
- Troubleshooting guide for common connection issues.
- Note that `reveal-api-key` is a local diagnostic command; API keys should
  be shared only through secure channels.

Documentation must not include private vault paths, credentials, or API keys.

## Index and Reindex

Phase 3 does not expose `index` or `reindex` as MCP tools.

This is an intentional limitation. MCP tools are read-only retrieval tools.
Indexing and reindexing are administrative operations that should be performed
through CLI or HTTP API.

The `mcp-client-guide.md` troubleshooting section explains how to trigger
indexing outside MCP when the index is missing or incompatible.

## Specification Files

Phase 3 specifications live under:

```text
docs/phases/phase-3-mcp-bridge/specifications/
```

Specification files:

- [MCP Tools](specifications/mcp-tools.md)
- [MCP Transports](specifications/mcp-transports.md)
- [CLI](specifications/cli.md)
- [Configuration](specifications/configuration.md)
- [MCP Client Guide](specifications/mcp-client-guide.md)
- [Testing And CI](specifications/testing-ci.md)

## Testing And Fixtures

Specification:
[Testing And CI](specifications/testing-ci.md) covers tests and CI concerns.

Testing requirements:

- Tests use only synthetic Markdown fixtures.
- MCP tool tests reuse Phase 1 core function tests where appropriate.
- MCP protocol layer tests cover tool invocation, response format, and error
  handling.
- MCP protocol compliance tests cover initialization handshake, capabilities
  negotiation, and JSON-RPC message format.
- stdio transport tests spawn `vault-agent mcp` as a child process and
  communicate via stdin/stdout.
- Streamable HTTP transport tests use the HTTP API with MCP endpoint.
- Configuration tests cover MCP enablement, transport selection, and endpoint
  configuration.
- Authentication tests verify API key requirement for Streamable HTTP
  transport.
- Attachment download tests cover `get_attachment` with both `download=false`
  (metadata) and `download=true` (bytes).
- Tests cover concurrent HTTP MCP sessions.
- Tests cover all acceptance criteria scenarios.
- Generated indexes, caches, logs, and local databases must not be committed.
