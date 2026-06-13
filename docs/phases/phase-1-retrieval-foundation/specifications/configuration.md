# Phase 1 Configuration Specification

Status: Draft

This file is part of the Phase 1 specification. See ../specification.md for the specification map and ../requirements.md for requirements.

## User-Local Paths

Phase 1 uses `env-paths` with the application name `vault-agent` to derive user-local directories.

In this specification, `{paths.config}` and `{paths.data}` mean the directories returned by `env-paths` for the `vault-agent` application name.

Default paths:

- Config file: `{paths.config}/config.toml`
- Index data: `{paths.data}/indexes/{vaultIdentity}/index.sqlite`

The CLI command `vault-agent config path` prints the resolved config file path.

The index directory may be overridden by CLI flag, environment variable, or user-local TOML configuration. Configuration precedence is defined in the configuration section.

## Configuration File

User-local configuration is stored as TOML.

Config structure:

```toml
[vault]
root = "/path/to/vault"
exclude = []

[server]
endpoint = "http://127.0.0.1:8787"
host = "127.0.0.1"
port = 8787
api_key = ""
log_level = "info"

[index]
dir = ""

[embedding]
enabled = false
endpoint = "http://127.0.0.1:11434/v1/embeddings"
model = ""
require = false

[cors]
enabled = false
allowed_origins = []
```

Example repository configuration must use public-safe placeholder paths and empty secrets only.

Environment variable overrides use the `VAULT_AGENT_*` prefix.

Supported environment variables:

- `VAULT_AGENT_VAULT_ROOT`
- `VAULT_AGENT_SERVER_ENDPOINT`
- `VAULT_AGENT_SERVER_HOST`
- `VAULT_AGENT_SERVER_PORT`
- `VAULT_AGENT_API_KEY`
- `VAULT_AGENT_LOG_LEVEL`
- `VAULT_AGENT_INDEX_DIR`
- `VAULT_AGENT_EMBEDDING_ENABLED`
- `VAULT_AGENT_EMBEDDING_ENDPOINT`
- `VAULT_AGENT_EMBEDDING_MODEL`
- `VAULT_AGENT_EMBEDDING_REQUIRE`
- `VAULT_AGENT_CORS_ENABLED`
- `VAULT_AGENT_CORS_ALLOWED_ORIGINS`

`VAULT_AGENT_CORS_ALLOWED_ORIGINS` is a comma-separated list of origins.

Configuration precedence:

1. CLI flags.
2. Environment variables.
3. User-local TOML config.
4. Built-in defaults.

Secret values may be stored in user-local TOML configuration or environment variables. Normal configuration commands and API responses display only whether secret values are set. Phase 1 does not use OS keychain integration.

Unknown configuration keys are validation errors.

Boolean environment variables accept `true`, `false`, `1`, and `0`. Other values are validation errors.

Ports must be integers from 1 through 65535.

Endpoint values must be valid `http` or `https` URLs.

Default server endpoint: `http://127.0.0.1:8787`.

Default bind host: `127.0.0.1`.

Default port: `8787`.

An empty `index.dir` means the env-paths default index directory.

When `embedding.enabled` is false, `embedding.endpoint` and `embedding.model` are ignored. When `embedding.enabled` is true, `embedding.model` is required.

Phase 1 server binds HTTP only. TLS termination is out of scope.
