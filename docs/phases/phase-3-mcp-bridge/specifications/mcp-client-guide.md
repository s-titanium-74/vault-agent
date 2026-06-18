# MCP Client Guide

Status: Ready for Review

## Overview

This specification defines documentation for connecting MCP clients to
`vault-agent`.

## Claude Desktop

### Configuration

Add the following to Claude Desktop's MCP configuration:

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

### Usage

Once configured, Claude Desktop can use MCP tools to search and retrieve vault
content:

- Use `search` to find relevant notes.
- Use `get_note` to retrieve full note content.
- Use `get_chunk` to retrieve specific chunks.
- Use `get_attachment` to retrieve attachment metadata.
- Use `related` to find nearby candidates.

## Cursor

### Configuration

Add the following to Cursor's MCP configuration:

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

### Usage

Cursor can use MCP tools to search and retrieve vault content during coding
sessions.

## Other MCP Clients

For other MCP-compatible clients, use the following connection details:

- **Transport:** stdio (default)
- **Command:** `vault-agent mcp`
- **Arguments:** None required

For Streamable HTTP transport (available through `vault-agent serve`):

- **Endpoint:** `http://127.0.0.1:8787/mcp`
- **Authentication:** `Authorization: Bearer <api-key>`
- **Note:** Streamable HTTP transport must be enabled in configuration first
  (`mcp.enabled = true`).
- **Note:** `127.0.0.1:8787` are the default `server.host` and `server.port`
  values. Adjust the URL if you have configured different values.

### OpenWebUI Configuration

OpenWebUI supports MCP servers via Streamable HTTP. Add the following to your
OpenWebUI configuration:

```json
{
  "mcpServers": {
    "vault-agent": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

Replace `YOUR_API_KEY` with the API key configured for your `vault-agent`
server. Use `vault-agent config reveal-api-key` to display the configured key
locally.

**Note:** `127.0.0.1:8787` are the default `server.host` and `server.port`
values. Adjust the URL if you have configured different values.

## Troubleshooting

### Connection Issues

- Verify `vault-agent` is installed and available in PATH.
- Check that the vault is configured: `vault-agent config get`.
- Verify the index is built: `vault-agent index`.
- Check MCP Streamable HTTP endpoint is enabled (for Streamable HTTP
  transport): `vault-agent config get` (look for `mcp.enabled`).

### Authentication Issues (Streamable HTTP Transport)

- Verify API key is configured: `vault-agent config reveal-api-key`.
  **Note:** `reveal-api-key` is a local diagnostic command. The API key
  should be shared only through secure channels, not copied into client
  configuration files on shared or remote machines.
- Check that the server is running: `vault-agent serve`.
- Verify the endpoint is correct: `http://127.0.0.1:8787/mcp` (adjust host and
  port if configured differently).
- stdio transport (`vault-agent mcp`) does not require API key
  authentication.

### Index Issues

If the index is missing or incompatible:

1. MCP tools will return actionable error messages explaining the issue.
2. To fix the issue, run `vault-agent index` or `vault-agent reindex` from the
   command line.
3. Indexing is an administrative operation performed through CLI or HTTP API,
   not through MCP tools.

### Common Errors

| Error                   | Cause                                | Solution                                               |
| ----------------------- | ------------------------------------ | ------------------------------------------------------ |
| "Vault not configured"  | No vault root set                    | Run `vault-agent config set vault.root /path/to/vault` |
| "Index not available"   | No index built                       | Run `vault-agent index`                                |
| "Index incompatible"    | Index requires reindexing            | Run `vault-agent reindex`                              |
| "MCP not enabled"       | Streamable HTTP endpoint disabled    | Run `vault-agent config set mcp.enabled true`          |
| "Authentication failed" | Invalid or missing API key           | Check API key configuration                            |
| "Path outside vault"    | Requested path is outside vault root | Use vault-relative paths                               |
| "Embedding unavailable" | Embedding provider not configured    | Configure embedding or use lexical mode                |

### Large Attachments

The MCP `get_attachment` tool is suitable for small to medium attachments. For
attachments larger than a few megabytes, use the HTTP API instead:

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
  "http://127.0.0.1:8787/attachments/path/to/file?download=true"
```

This avoids MCP transport size limits and returns raw file bytes instead of
base64-encoded JSON.

- Start with `search` to find relevant notes before retrieving full content.
- Use `related` to discover nearby content after reading a note.
- Use `get_note` only when you need the full note content.
- Use `get_chunk` when you need only a portion of a note.
- Check tool descriptions for guidance on when to use each tool.
