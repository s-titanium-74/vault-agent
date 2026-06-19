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

### 3. Optional: Enable Local Embeddings With Ollama

Lexical search works without embeddings. To enable local embedding search with
[Ollama](https://ollama.com/) (see also
[ollama/ollama](https://github.com/ollama/ollama)), make sure Ollama is running
locally, then pull an embedding model and point `vault-agent` at Ollama's
OpenAI-compatible endpoint before starting the server:

```bash
ollama pull nomic-embed-text
vault-agent config set embedding.enabled true
vault-agent config set embedding.endpoint "http://127.0.0.1:11434/v1/embeddings"
vault-agent config set embedding.model "nomic-embed-text"
```

When embeddings are configured before first startup, bootstrap indexing includes
vectors. `nomic-embed-text` is an example embedding model; if you enable or
change embeddings after an index already exists, run `vault-agent reindex`.

### 4. Serve

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

### 5. Connect An Agent

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

### 3. Prepare SSH Authentication

For private repositories, create a repository-scoped read-only deploy key and
store it outside the repository. Pass it to Docker at runtime:

```bash
export VAULT_AGENT_GIT_SSH_PRIVATE_KEY="$(cat ~/.ssh/vault-agent-deploy-key)"
export VAULT_AGENT_GIT_SSH_KNOWN_HOSTS="$(ssh-keyscan github.com)"
```

`VAULT_AGENT_GIT_SSH_PRIVATE_KEY` is written to a temporary key file inside the
container before Git runs. `VAULT_AGENT_GIT_SSH_KNOWN_HOSTS` pins the SSH host
key used by Git. If `VAULT_AGENT_GIT_SSH_KNOWN_HOSTS` is omitted, the container
uses OpenSSH `accept-new` behavior.

Environment variables passed to Docker can be visible to the local Docker daemon
and operators of that host. Use a read-only deploy key with access only to the
vault repository, rotate it if exposed, and never commit it to repository files.

### 4. Clone And Index

```bash
docker run --rm \
  -v vault-agent-vault:/data/vault \
  -v vault-agent-index:/data/index \
  -e VAULT_AGENT_INDEX_DIR=/data/index \
  -e VAULT_AGENT_GIT_SSH_PRIVATE_KEY \
  -e VAULT_AGENT_GIT_SSH_KNOWN_HOSTS \
  vault-agent:0.1.0 \
  sync clone "git@github.com:owner/private-vault.git" \
    --target /data/vault \
    --enable-sync \
    --index
```

Use an SSH Git URL without embedded credentials. `--enable-sync` turns on
scheduled pull so the server can keep the checkout fresh while it is running.

Keep `/data/vault` as the target path for both `sync clone` and `serve`. The
index is tied to the vault identity, so changing the in-container vault path can
make the server rebuild the index.

### 5. Serve With MCP Enabled

```bash
docker run --rm \
  -p 127.0.0.1:8787:8787 \
  -v vault-agent-vault:/data/vault \
  -v vault-agent-index:/data/index \
  -e VAULT_AGENT_VAULT_ROOT=/data/vault \
  -e VAULT_AGENT_INDEX_DIR=/data/index \
  -e VAULT_AGENT_MCP_ENABLED=true \
  -e VAULT_AGENT_API_KEY=change-this-development-key-32bytes \
  -e VAULT_AGENT_GIT_SSH_PRIVATE_KEY \
  -e VAULT_AGENT_GIT_SSH_KNOWN_HOSTS \
  vault-agent:0.1.0 \
  serve --host 0.0.0.0
```

The server must bind to `0.0.0.0` inside the container so Docker can publish the
port. Non-localhost server binds require an API key, even when Docker publishes
the port only to host localhost.

Pass the SSH key environment variables to `serve` as well as `sync clone`;
scheduled pull runs inside the server process and needs the same Git access.

### 6. Connect An Agent

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

## Configuration Notes

Common environment variables are listed in [.env.example](../.env.example).

The default server endpoint is:

```text
http://127.0.0.1:8787
```

The server binds to `127.0.0.1` by default. Non-localhost access must be
explicitly configured and requires API key protection.

Normal config output does not print secret values. Use
`vault-agent config reveal-api-key` only when you intentionally need to copy the
API key for remote client setup.

File watching is enabled by default:

```bash
vault-agent config set watch.enabled true
```

Disable watching when you want fully manual indexing:

```bash
vault-agent config set watch.enabled false
```

Git sync is disabled by default and must be configured explicitly. Repository
paths, remote names, branches, API keys, and webhook secrets belong in
user-local config or environment variables, not in repository files.

## Docker With A Mounted Vault

Build the image locally:

```bash
docker build -t vault-agent:0.1.0 .
```

Run against a mounted vault:

```bash
docker run --rm \
  -p 8787:8787 \
  -v "$PWD/examples/synthetic-vault:/data/vault:ro" \
  -v vault-agent-index:/data/index \
  -e VAULT_AGENT_VAULT_ROOT=/data/vault \
  -e VAULT_AGENT_API_KEY=change-this-development-key-32bytes \
  vault-agent:0.1.0 serve --host 0.0.0.0
```

On first startup, `serve` creates the index automatically if no usable index
exists. Keep the index volume to preserve the local index across container
restarts. Because the server binds to `0.0.0.0` inside the container, configure
an API key and send `Authorization: Bearer <key>` from clients.

For Streamable HTTP MCP in Docker, keep localhost-only publishing when possible
or configure an API key before exposing the server on a private network:

```bash
docker run --rm \
  -p 127.0.0.1:8787:8787 \
  -v "$PWD/examples/synthetic-vault:/data/vault:ro" \
  -v vault-agent-index:/data/index \
  -e VAULT_AGENT_VAULT_ROOT=/data/vault \
  -e VAULT_AGENT_API_KEY=change-this-development-key-32bytes \
  -e VAULT_AGENT_MCP_ENABLED=true \
  vault-agent:0.1.0 serve --host 0.0.0.0
```

## Embedding Setup

Embedding search is disabled by default. Lexical search works without an
embedding provider.

The current embedding implementation supports local OpenAI-compatible embedding
endpoints only. The endpoint host must be `127.0.0.1`, `localhost`, or `::1`.
External SaaS embedding providers and provider authentication are out of scope.

One common local setup is [Ollama](https://ollama.com/) with
`nomic-embed-text`, an example embedding model:

```bash
ollama pull nomic-embed-text
ollama serve
```

Configure `vault-agent` to use the local endpoint:

```bash
vault-agent config set embedding.enabled true
vault-agent config set embedding.endpoint "http://127.0.0.1:11434/v1/embeddings"
vault-agent config set embedding.model "nomic-embed-text"
```

Then rebuild the index with embeddings:

```bash
vault-agent reindex --require-embeddings
```

`--require-embeddings` makes indexing fail if embedding generation fails.
Without it, indexing may still succeed with a lexical index and an embedding
warning when `embedding.require` is false.

To make embedding generation mandatory for future index requests through
configuration:

```bash
vault-agent config set embedding.require true
```

If you change the embedding model or the provider returns a different vector
dimension, run `reindex` so stored vectors match the current configuration.

## Embedding Usage

When embeddings are indexed and available, search defaults to hybrid mode.
Hybrid mode combines lexical and embedding results.

Explicit search modes:

```bash
vault-agent search --mode lexical "privacy local index"
vault-agent search --mode hybrid "notes about semantic retrieval"
vault-agent search --mode embedding "conceptually similar notes"
```

Related lookup also supports embedding and hybrid modes:

```bash
vault-agent related --mode embedding "<note-or-chunk-id>"
vault-agent related --mode hybrid "<note-or-chunk-id>"
```

Mode behavior:

- `lexical` uses only the local lexical index.
- `hybrid` uses embeddings when available and falls back to lexical with an
  `EMBEDDING_UNAVAILABLE` warning when embeddings are configured but
  unavailable.
- `embedding` requires embeddings. If embeddings are unavailable, the command
  fails with `EMBEDDING_UNAVAILABLE`.

Use `--json` when another agent or script needs stable machine-readable output:

```bash
vault-agent search --mode hybrid --limit 5 --json "retrieval architecture"
```

## Privacy And Safety

- Do not commit private vault content.
- Do not commit real `.env` files, credentials, tokens, API keys, local indexes,
  caches, databases, logs, or machine-specific paths.
- API and CLI output should prefer vault-relative paths and stable note or
  chunk IDs.
- Search and related responses should stay compact and must not silently return
  full note bodies.
- External embedding providers are not defaults. Any provider that sends vault
  content outside the machine must be explicitly configured.

## Troubleshooting

- If MCP tools say the index is missing, run `vault-agent index` or start
  `vault-agent serve` and let bootstrap indexing complete.
- If Docker search results are unexpectedly empty after clone, confirm clone and
  serve both use `/data/vault` inside the container.
- If a Docker MCP request returns `401`, confirm the client sends
  `Authorization: Bearer <api-key>`.
- If `sync clone` rejects a URL, remove embedded credentials and use normal Git,
  SSH, or Docker credential mechanisms.
