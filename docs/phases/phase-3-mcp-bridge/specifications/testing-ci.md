# Testing And CI Specification

Status: Ready for Review

## Overview

This specification defines testing requirements for Phase 3 MCP bridge.

## Test Categories

### Unit Tests

Unit tests verify MCP tool behavior by reusing Phase 1 core function tests.

**Coverage:**

- MCP tool parameter validation:
  - `search` rejects empty or oversized queries.
  - `search` rejects invalid `mode` and `limit` values.
  - `get_note` rejects empty `noteId` and invalid `allowLarge` types.
  - `get_chunk` rejects negative `chunkIndex` and invalid types.
  - `get_attachment` rejects traversal paths and non-boolean `download`.
  - `related` rejects invalid `type`, `id`, `mode`, and `limit` values.
- MCP tool response format:
  - Each tool result payload matches the corresponding HTTP API `data` field.
  - JSON-RPC wrapper is correctly formed.
- MCP tool error handling:
  - Application errors map to correct JSON-RPC codes and Phase 1 error codes.
  - Invalid parameters return `InvalidParams` (`-32602`).
  - Unknown tools return `MethodNotFound` (`-32601`).
- Configuration parsing for MCP options:
  - `mcp.enabled` default is `false`.
  - `mcp.http.endpoint` default is `"/mcp"`.
  - Endpoint path validation rejects conflicts and invalid paths.
- Tool annotation verification:
  - All tools declare `readOnlyHint`, `destructiveHint`, and `idempotentHint`.
  - Tool descriptions match the HTTP API behavior.
- Phase 2 freshness integration:
  - Search and related responses include `freshness` state and `warnings`
    array.
  - `get_note` and `get_chunk` responses include `warnings` array.
  - Incompatible index state causes `INDEX_INCOMPATIBLE` error.
  - Stale, pending, and updating states include visible warnings.
- Incompatible index safe-resolution:
  - `get_note` follows Phase 2 safe-resolution rules.
  - `get_chunk` follows Phase 2 safe-resolution rules.
- Tool invocation timeout:
  - Slow tool invocations return JSON-RPC error with code `-32012` and
    `data.errorCode: TIMEOUT`.
- `vault-agent mcp` independence from `mcp.enabled`:
  - `vault-agent mcp` starts and works when `mcp.enabled = false`.
  - `vault-agent mcp` starts and works when `mcp.enabled = true`.
- Streamable HTTP endpoint disabled by default:
  - Server without `mcp.enabled` does not expose `/mcp`.
- Error sanitization categories:
  - Error responses do not contain private absolute paths.
  - Error responses do not contain note content.
  - Error responses do not contain chunk content.
  - Error responses do not contain raw query text.
  - Error responses do not contain secret values.
- Attachment error paths:
  - `get_attachment` returns `ATTACHMENT_NOT_ALLOWED` for Markdown notes,
    hidden files, and excluded paths.
  - `ATTACHMENT_NOT_ALLOWED` returns JSON-RPC code `-32009`, distinct from
    validation error code `-32000`.
  - `get_attachment` returns `QUERY_TOO_LARGE` for oversized downloads.
  - Attachment downloads exceeding 50 MiB total MCP result payload fail with
    `QUERY_TOO_LARGE` even with `allowLarge=true`.
- Attachment MIME type detection:
  - `get_attachment` with `download=true` returns correct `contentType` for
    known file types.
  - Unknown file types return `application/octet-stream`.
- Graceful shutdown exit code:
  - stdio transport exits with code 0 after completing in-progress
    invocations.
- Vault-not-configured error:
  - Tool invocations without configured vault return `VAULT_NOT_CONFIGURED`
    error.
- Large attachment recommendation:
  - Documentation recommends HTTP API for large attachment downloads.

### Integration Tests

Integration tests verify MCP protocol layer behavior.

**Coverage:**

- MCP tool invocation via stdio transport:
  - `search` returns compact results.
  - `get_note` returns note content and metadata.
  - `get_chunk` returns chunk content.
  - `get_attachment` returns metadata and base64-encoded bytes.
  - `related` returns compact candidates.
- MCP tool invocation via Streamable HTTP transport:
  - All tools work through the `/mcp` endpoint.
  - Initialize handshake completes successfully.
  - Streaming responses are handled correctly.
- Authentication for Streamable HTTP transport:
  - Requests without `Authorization` header are rejected.
  - Requests with invalid API key are rejected.
  - Requests with valid API key succeed.
- Configuration loading and precedence:
  - CLI flags override environment variables and TOML.
  - Environment variables override TOML.
- Error response format and privacy guarantees:
  - Errors do not leak private paths, note content, or secrets.
  - Error messages are actionable.
- Attachment download with base64 encoding:
  - `download=false` returns metadata.
  - `download=true` returns base64 content.
  - Oversized attachments require `allowLarge=true`.
- Concurrent HTTP MCP sessions:
  - Multiple clients can connect simultaneously.
  - Tool invocations in one session do not affect another.

### Protocol Compliance Tests

MCP protocol compliance tests verify adherence to the MCP specification.

**Coverage:**

- Initialization handshake (initialize, capabilities, initialized):
  - Server responds with protocol version `2025-03-26`.
  - Server advertises `tools` capability only.
  - Server rejects unsupported protocol versions.
- Capabilities advertisement (tools only, no resources/prompts).
- JSON-RPC message format validation:
  - Requests and responses follow JSON-RPC 2.0.
  - Batched messages are handled per the MCP specification.
- Error response format per MCP specification:
  - Protocol errors use standard JSON-RPC codes.
  - Application errors use custom codes in the `-32000` range.
- Tool list response format:
  - `tools/list` returns all five tools.
  - Tool names, descriptions, and schemas are correct.
- Tool invocation and response format:
  - Tool results are wrapped in JSON-RPC `result`.
  - Tool errors are wrapped in JSON-RPC `error`.
- Reference client interoperability:
  - Initialization handshake succeeds with `@modelcontextprotocol/sdk` test
    client or equivalent reference implementation.
  - Tool list and tool invocation work end-to-end with the reference client.

### Transport Tests

stdio transport tests:

- Spawn `vault-agent mcp` as a child process.
- Send JSON-RPC messages via stdin.
- Read responses from stdout.
- Verify response format and content.
- Handle process lifecycle (start, communicate, shutdown).
- Verify server starts without index and returns actionable errors.
- Verify server starts without configured vault and returns actionable errors.
- Verify graceful shutdown when stdin closes with in-progress invocations.
- Verify graceful shutdown on SIGTERM with in-progress invocations.
- Verify graceful shutdown on SIGINT with in-progress invocations.
- Verify process exits with code 0 after clean shutdown.
- Verify stderr logging does not corrupt stdout JSON-RPC stream.
- Cross-reference: concurrent stdio and Streamable HTTP access is tested under
  Streamable HTTP transport tests.

Streamable HTTP transport tests:

- Start server with MCP enabled.
- Send requests to `/mcp` endpoint.
- Verify authentication requirement.
- Verify response format and content.
- Handle SSE stream lifecycle via GET.
- Handle single JSON responses via POST.
- Test concurrent client connections.
- Verify session isolation between concurrent clients.
- Test concurrent stdio and Streamable HTTP access to the same vault root.
- Verify malformed JSON input returns JSON-RPC parse error (`-32700`).
- Verify missing `protocolVersion` in initialize returns Invalid Request
  (`-32600`).
- Verify unsupported protocol version returns Invalid Request (`-32600`).

## Test Fixtures

### Synthetic Markdown Content

All tests use synthetic, public-safe Markdown content only.

**Requirements:**

- No real vault content.
- No real names, private project names, private paths, or private URLs.
- No credentials, API keys, or tokens.
- Generated indexes must be excluded from commits.

### Fixture Vault Structure

```
test/fixtures/vault/
  notes/
    note-1.md
    note-2.md
    note-3.md
  attachments/
    example.txt
    image.png
```

Each fixture file contains synthetic content appropriate for testing search,
retrieval, and related functionality.

## Test Commands

```bash
# Run all tests
npm test

# Run Phase 3 specific tests
npm test -- --grep "MCP"

# Run in watch mode
npm run test:watch
```

## Coverage Requirements

- All MCP tools must have unit test coverage.
- All transport methods must have integration test coverage.
- MCP protocol compliance must be tested.
- Authentication must be tested for Streamable HTTP transport.
- Error handling must be tested for all failure scenarios.
- Configuration must be tested for all precedence levels.
- Attachment download with base64 encoding must be tested.
- Concurrent HTTP MCP sessions must be tested.

## CI Integration

- Tests run on all supported platforms (Linux, macOS, Windows).
- Tests use synthetic fixtures only.
- Generated test artifacts are excluded from commits.
- Coverage reports are generated but not committed.
