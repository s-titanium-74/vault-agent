# Setup Guide

This guide covers two common ways to run `vault-agent` and expose it to an MCP
client.

`vault-agent` handles one vault root per server process. Run separate server
instances for separate vaults.

## Local Vault With Automatic Indexing

Use this path when the Markdown vault already exists on the same machine as the
agent.

### 1. Install

After the npm package is published:

```bash
npm install -g @vault-agent/cli
```

From a source checkout before publishing:

```bash
npm install
npm run build
```

Then replace `vault-agent` in the commands below with
`npx --no-install vault-agent`.

### 2. Configure One Vault

```bash
vault-agent config set vault.root "/path/to/your/vault"
vault-agent config set mcp.enabled true
```

### 3. Serve

```bash
vault-agent serve
```

The server binds to `127.0.0.1:8787` by default. On first startup, it creates a
local index automatically if no usable index exists. File watching is enabled by
default, so later Markdown file changes are indexed incrementally while the
server is running.

Check readiness from another terminal:

```bash
vault-agent status
```

### 4. Connect An Agent

For MCP clients that support Streamable HTTP, connect to:

```text
http://127.0.0.1:8787/mcp
```

Localhost access follows the same local access behavior as the rest of the
server and does not require an API key by default.

Example MCP client shape:

```json
{
  "mcpServers": {
    "vault-agent": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp"
    }
  }
}
```

For MCP clients that only support stdio, use:

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

Stdio MCP does not start the server. It uses the configured vault root and an
existing usable local index, so start `vault-agent serve` once first or run
`vault-agent index` before relying on stdio.

## Git Repository In Docker

Use this path when the vault should be cloned from Git into a Docker volume and
served from a container.

### 1. Build Or Pull The Image

Before Docker Hub publication, build locally:

```bash
docker build -t vault-agent:0.1.0 .
```

After Docker Hub publication:

```bash
docker pull DOCKERHUB_USER/vault-agent:0.1.0
```

The examples below use `vault-agent:0.1.0`. Replace it with the Docker Hub image
name after publication.

### 2. Create Persistent Volumes

```bash
docker volume create vault-agent-vault
docker volume create vault-agent-index
```

### 3. Clone And Index

```bash
docker run --rm \
  -v vault-agent-vault:/data/vault \
  -v vault-agent-index:/data/index \
  -e VAULT_AGENT_INDEX_DIR=/data/index \
  vault-agent:0.1.0 \
  sync clone "https://example.com/owner/vault.git" \
    --target /data/vault \
    --index
```

Use an HTTPS or SSH Git URL without embedded credentials. Git authentication
should come from Docker or Git credential setup outside committed repository
files.

Keep `/data/vault` as the target path for both `sync clone` and `serve`. The
index is tied to the vault identity, so changing the in-container vault path can
make the server rebuild the index.

### 4. Serve With MCP Enabled

```bash
docker run --rm \
  -p 127.0.0.1:8787:8787 \
  -v vault-agent-vault:/data/vault \
  -v vault-agent-index:/data/index \
  -e VAULT_AGENT_VAULT_ROOT=/data/vault \
  -e VAULT_AGENT_INDEX_DIR=/data/index \
  -e VAULT_AGENT_MCP_ENABLED=true \
  -e VAULT_AGENT_API_KEY=change-this-development-key-32bytes \
  vault-agent:0.1.0 \
  serve --host 0.0.0.0
```

The server must bind to `0.0.0.0` inside the container so Docker can publish the
port. Non-localhost server binds require an API key, even when Docker publishes
the port only to host localhost.

### 5. Connect An Agent

For Streamable HTTP MCP, use:

```json
{
  "mcpServers": {
    "vault-agent": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": {
        "Authorization": "Bearer change-this-development-key-32bytes"
      }
    }
  }
}
```

Use a real secret value for anything outside local development. Do not commit
API keys or private Git URLs to repository files.

## Useful Commands

Search:

```bash
vault-agent search "retrieval privacy"
```

Retrieve an explicit note or chunk from a search result:

```bash
vault-agent get note "<note-id>"
vault-agent get chunk "<note-id>" "<chunk-index>"
```

Rebuild the index:

```bash
vault-agent reindex
```

Show server, index, watcher, and sync state:

```bash
vault-agent status
```

## Troubleshooting

- If MCP tools say the index is missing, run `vault-agent index` or start
  `vault-agent serve` and let bootstrap indexing complete.
- If Docker search results are unexpectedly empty after clone, confirm clone and
  serve both use `/data/vault` inside the container.
- If a Docker MCP request returns `401`, confirm the client sends
  `Authorization: Bearer <api-key>`.
- If `sync clone` rejects a URL, remove embedded credentials and use normal Git,
  SSH, or Docker credential mechanisms.
