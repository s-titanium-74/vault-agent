# Phase 3.1 Configuration Specification

Status: Draft

This file is part of the Phase 3.1 specification. See ../requirements.md for requirements and this directory for the domain specifications.

## New Configuration

Phase 3.1 introduces no new configuration keys.

## Inherited Configuration

Orientation surfaces inherit all configuration from Phase 1 and Phase 2:

### Phase 1 Inherited Configuration

- `vault.root`: configured vault root path.
- `server.endpoint`: server endpoint URL.
- `server.host`: server bind host.
- `server.port`: server port.
- `server.api_key`: API key for non-localhost access.
- `cors.enabled`: CORS enablement flag.
- `cors.allowed_origins`: allowed CORS origins.
- `[vault].exclude`: user-configured vault-relative exclude patterns.
- `index.dir`: override for index directory.

### Phase 2 Inherited Configuration

- `index.freshness.*` or equivalent freshness detection configuration.

## Configuration Precedence

Configuration precedence follows Phase 1:

1. CLI flags.
2. Environment variables.
3. User-local TOML config.
4. Built-in defaults.

## No MCP-Specific Orientation Configuration

Orientation MCP tools do not require their own configuration keys. They reuse Phase 3 MCP bridge configuration:

- `mcp.enabled`: controls Streamable HTTP MCP endpoint availability.
- `mcp.http.endpoint`: Streamable HTTP endpoint path.

## Example Configuration

No new configuration is needed. A typical Phase 1 configuration is sufficient:

```toml
[vault]
root = "/path/to/vault"
exclude = ["templates/", "archive/"]

[server]
host = "127.0.0.1"
port = 8787
```

## Future Configuration

User-configurable facet field allowlisting may be added in a future phase. If added, it must be opt-in and privacy-aware. Phase 3.1 does not define the mechanism.
