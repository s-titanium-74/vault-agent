# Configuration Specification

Status: Ready for Review

## Overview

This specification defines the configuration options added in Phase 3 for MCP
bridge functionality.

## Configuration Options

### mcp.enabled

- Type: boolean
- Default: `false`
- Description: Controls whether the Streamable HTTP MCP endpoint is available
  on `vault-agent serve`. Does not affect the `vault-agent mcp` command, which
  always provides MCP tools via stdio.
- Sources: CLI flag, environment variable, user-local TOML config.
- CLI flag: `--mcp-enabled`
- Environment variable: `VAULT_AGENT_MCP_ENABLED`

### mcp.http.endpoint

- Type: string
- Default: `"/mcp"`
- Description: Sets the Streamable HTTP endpoint path for MCP.
- Sources: CLI flag, environment variable, user-local TOML config.
- CLI flag: `--mcp-http-endpoint`
- Environment variable: `VAULT_AGENT_MCP_HTTP_ENDPOINT`
- Validation: The endpoint path must not conflict with existing Phase 1/2
  HTTP API paths (`/search`, `/notes`, `/chunks`, `/attachments`, `/related`,
  `/health`, `/index`, `/reindex`, `/status`). The path must start with `/`.
  The path must not contain `..` or null bytes.

## Configuration Precedence

Configuration follows Phase 1 precedence:

1. CLI flags.
2. Environment variables.
3. User-local TOML config.
4. Built-in defaults.

## Environment Variables

MCP configuration can be set via environment variables:

| Variable                        | Config Key          | Description                         |
| ------------------------------- | ------------------- | ----------------------------------- |
| `VAULT_AGENT_MCP_ENABLED`       | `mcp.enabled`       | Enable Streamable HTTP MCP endpoint |
| `VAULT_AGENT_MCP_HTTP_ENDPOINT` | `mcp.http.endpoint` | Streamable HTTP endpoint path       |

## Example Configuration

```toml
# User-local TOML config
mcp.enabled = true
mcp.http.endpoint = "/mcp"
```

## Scope Clarification

- `mcp.enabled = true` enables the `/mcp` Streamable HTTP endpoint on
  `vault-agent serve`.
- `mcp.enabled = false` disables the `/mcp` Streamable HTTP endpoint on
  `vault-agent serve`.
- `vault-agent mcp` always works regardless of `mcp.enabled` setting.
- The `vault-agent mcp` command does not read `mcp.enabled` from configuration.

## Security

- Private paths, credentials, and secrets must not be stored in repository
  files.
- MCP configuration is stored in user-local configuration only.
- Configuration commands must not display secret values by default.
