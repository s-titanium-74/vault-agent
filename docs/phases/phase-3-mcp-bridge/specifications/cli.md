# CLI Specification

Status: Ready for Review

## Overview

This specification defines the CLI commands added in Phase 3 for MCP bridge
functionality.

## Commands

### vault-agent mcp

Start an MCP server using stdio transport.

**Usage:**

```bash
vault-agent mcp
```

**Options:**

None. The `mcp` command always uses stdio transport.

**Behavior:**

- Starts an MCP server using stdio transport.
- Reads vault configuration from user-local configuration and environment
  variables. The `mcp` command inherits global CLI flags (e.g., `--config`)
  but has no MCP-specific flags.
- Connects to core directly without starting an HTTP server.
- Reads JSON-RPC from stdin and writes to stdout.
- Logs to stderr to avoid interfering with the MCP JSON-RPC stream.
- Always works regardless of `mcp.enabled` setting.
- If no usable index exists, the server starts and returns actionable MCP
  errors when tools are invoked.

**Examples:**

```bash
# Start MCP server with stdio transport
vault-agent mcp
```

**Error Handling:**

- If the vault is not configured, the server starts and returns an actionable
  MCP error when tools are invoked.
- If the index is not available, the server starts and returns an actionable
  MCP error when tools are invoked.
- Error messages are logged to stderr; MCP errors are returned via JSON-RPC.
- Error messages must not include private vault paths, secrets, or note
  content.

## Configuration Commands

Phase 3 extends the existing `config` commands to support MCP settings.

### vault-agent config get

Displays current configuration including MCP settings.

**Example output:**

```toml
vault.root = "/path/to/vault"
server.host = "127.0.0.1"
server.port = 8787
mcp.enabled = false
mcp.http.endpoint = "/mcp"
```

### vault-agent config set

Sets configuration values including MCP settings.

**Examples:**

```bash
vault-agent config set mcp.enabled true
vault-agent config set mcp.http.endpoint "/mcp"
```

## Output Format

CLI output defaults to compact human-readable output.

Machine-readable output must be available with `--json` where applicable.

The `mcp` command outputs to stderr in human-readable mode to avoid
interfering with the MCP JSON-RPC stream on stdout.
