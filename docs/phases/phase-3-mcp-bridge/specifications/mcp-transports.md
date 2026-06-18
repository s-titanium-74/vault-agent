# MCP Transports Specification

Status: Ready for Review

## Overview

This specification defines the MCP transports supported by `vault-agent` in
Phase 3: stdio (default) and Streamable HTTP (optional).

## MCP Protocol Version

Phase 3 targets MCP specification version 2025-03-26 or later.

## Capabilities

The MCP server advertises the following capabilities during initialization:

```json
{
  "capabilities": {
    "tools": {}
  }
}
```

No resources or prompts are advertised in Phase 3.

## Initialization Handshake

The server completes the MCP initialization handshake:

1. Client sends `initialize` request with protocol version and capabilities.
2. Server responds with its protocol version and capabilities.
3. Client sends `initialized` notification.
4. Server is ready to accept tool requests.

## stdio Transport

stdio is the default MCP transport. The MCP server reads JSON-RPC messages from
stdin and writes responses to stdout.

### Requirements

- `vault-agent mcp` starts an stdio-based MCP server.
- The command does not accept `--transport` flag; stdio is the only transport.
- stdio transport does not require API key authentication.
- The stdio process communicates with core directly.
- The stdio process does not start an HTTP server.
- stderr may be used for logging but must not interfere with the JSON-RPC
  message stream on stdout.
- The server processes one MCP session per process instance.
- The server always starts regardless of `mcp.enabled` setting.
- If no vault root is configured, the server starts and returns actionable MCP
  errors when tools are invoked.
- If no usable index exists, the server starts and returns actionable MCP
  errors when tools are invoked.
- The server completes in-progress tool invocations before shutting down when
  stdin is closed.

### MCP Client Connection

MCP clients connect to stdio transport by spawning the `vault-agent mcp`
process and communicating via stdin/stdout.

Example Claude Desktop configuration:

```json
{
  "mcpServers": {
    "vault-agent": {
      "command": "vault-agent",
      "args": ["mcp"]
    }
  }
}
```

## Streamable HTTP Transport

Streamable HTTP transport is available through the `vault-agent serve` server.

### Requirements

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

### Protocol Version Negotiation

The server supports MCP protocol version `2025-03-26`.

- If the client requests a supported protocol version, the server responds with
  the negotiated version.
- If the client requests an unsupported protocol version, the server responds
  with a JSON-RPC error:
  - `code`: `-32600` (Invalid Request)
  - `message`: `"Unsupported MCP protocol version: <version>"`
  - `data`: `{ "protocolVersion": "<requested-version>" }`
- If the client omits `protocolVersion`, the server treats the request as
  invalid and responds with `-32600`.

The server must not accept protocol versions older than `2025-03-26`.

The Streamable HTTP transport follows the MCP specification pattern:

1. Client sends `InitializeRequest` via HTTP POST to `/mcp` with `Accept:
application/json, text/event-stream`.
2. Server responds with `InitializeResult` (JSON or SSE stream).
3. Client sends `InitializedNotification` via HTTP POST.
4. Client sends tool requests via HTTP POST.
5. Server responds with JSON or SSE stream per request.
6. Client may open SSE stream via HTTP GET for server-initiated messages.

### Authentication

- Streamable HTTP authentication follows Phase 1 server access control.
- Localhost binds may run without an API key.
- Non-localhost binds require an API key, supplied via `Authorization: Bearer
<api-key>`.
- API keys must come from user-local configuration or environment variables.
- API keys must not be committed to the repository.
- Failed authentication responses must not reveal expected keys, secrets, or
  private config paths.

### Example curl Request

```bash
curl -X POST http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc": "2.0", "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "test", "version": "1.0"}}, "id": 1}'
```

## Transport Selection

The transport is selected by:

1. CLI command: `vault-agent mcp` always uses stdio.
2. Configuration: `mcp.enabled` controls Streamable HTTP endpoint on `vault-agent
serve`.
3. Default: Streamable HTTP is disabled; stdio is always available via
   `vault-agent mcp`.

When using `vault-agent serve`, only Streamable HTTP transport is available if
MCP is enabled. When using `vault-agent mcp`, only stdio transport is available.

## Graceful Shutdown

stdio transport shutdown behavior:

- The server completes in-progress tool invocations before shutting down.
- If a tool invocation is in progress when stdin closes, it completes normally.
- The server does not start new tool invocations after stdin closes.
- SIGTERM and SIGINT trigger the same graceful shutdown behavior as stdin close.
- Exit code 0 for clean shutdown; non-zero for errors.

Streamable HTTP transport shutdown behavior:

- The server follows Phase 1 server shutdown behavior.
- Active MCP sessions are closed gracefully.
- In-progress tool invocations complete normally.

## Cancellation And Progress Notifications

Phase 3 does not support MCP cancellation notifications or progress
notifications. Tool invocations run to completion or until the configured
timeout expires.

## Concurrent stdio and Streamable HTTP Access

A user may run `vault-agent mcp` (stdio) and `vault-agent serve` with MCP
enabled (Streamable HTTP) at the same time, both accessing the same vault root.
This is supported because both transports are read-only and use the same core
retrieval functions.

Concurrency requirements:

- Both transports read from the same index snapshot mechanism used by the HTTP
  API.
- Read concurrency follows Phase 1/2 index snapshot and locking rules.
- Neither transport writes to the index, so no additional write-lock
  coordination is required beyond what Phase 2 already provides for the HTTP
  API.

stdio transport:

- One process = one session. No concurrency concerns.

Streamable HTTP transport:

- Multiple concurrent clients are supported.
- MCP tool invocations are independent and stateless.
- No maximum session limit is enforced, but resource limits follow Phase 1
  server configuration.

## JSON-RPC Protocol Errors

Transport implementations must handle malformed JSON-RPC messages according to
the JSON-RPC 2.0 specification:

| Condition                                                                             | JSON-RPC Code             | HTTP Status (Streamable HTTP) |
| ------------------------------------------------------------------------------------- | ------------------------- | ----------------------------- |
| Invalid JSON or parse failure                                                         | `-32700` Parse error      | 400 Bad Request               |
| Missing or invalid `jsonrpc` field, missing `method`, or unsupported JSON-RPC version | `-32600` Invalid Request  | 400 Bad Request               |
| Unknown method or tool name                                                           | `-32601` Method not found | 200 OK or SSE event           |
| Missing required parameter or wrong parameter type                                    | `-32602` Invalid params   | 200 OK or SSE event           |
| Internal transport or protocol failure                                                | `-32603` Internal error   | 500 Internal Server Error     |

For stdio transport, protocol errors are returned as JSON-RPC error responses
on stdout.

For Streamable HTTP transport:

- Parse errors and invalid requests that cannot be associated with a request ID
  return the appropriate HTTP status code with a JSON-RPC error response that
  has no `id`.
- Errors associated with a specific request return the JSON-RPC error response
  via the same channel as the successful response (JSON body or SSE event).

### Batched Messages

Batched JSON-RPC messages (arrays of requests/notifications) are accepted and
processed sequentially within a session. Each request in a batch receives its
own response. Notifications receive no response. If any message in the batch
is malformed, the server returns a JSON-RPC error for that message and
continues processing the rest of the batch where possible.

Transport-level errors must not expose private vault content, secrets, or
internal implementation details.

- Connection errors return actionable error messages.
- Authentication errors for Streamable HTTP transport follow Phase 1 error
  handling.
- Transport initialization failures log sanitized error messages to stderr.
