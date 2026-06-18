# vault-agent

`vault-agent` is a standalone server and CLI for searching a local Markdown vault and retrieving only the context an AI agent explicitly needs.

The project is local-first and private-by-default. Search, indexing, and retrieval run against a vault on your machine. Search results are compact metadata and snippets; full note or chunk bodies are returned only through explicit `get` commands.

## Status

This repository is in the Phase 3 MCP bridge stage.

The current implementation includes:

- A local HTTP server.
- A CLI client.
- Markdown discovery, parsing, chunking, indexing, search, related-candidate lookup, and explicit note, chunk, and attachment retrieval.
- Lexical search by default.
- Optional local embedding search when explicitly configured.
- Status surfaces for server, index, watcher, and sync state.
- Local file watching and incremental index updates.
- Opt-in Git checkout sync.
- MCP tools over stdio and optional Streamable HTTP.

Out of scope:

- Hosted/public service operation.
- Note writing or editing.
- Chat or answer generation.
- Multiple vault roots in one server process.

## Roadmap

- Phase 1: Retrieval foundation with a standalone server, CLI, local indexing, compact search results, explicit retrieval, related lookup, and optional local embeddings.
- Phase 2: Automatic index updates, file watching, stale index handling, and opt-in Git checkout sync for remote or server deployments.
- Phase 3: Thin MCP bridge exposing `search`, `get`, and `related` through stdio and optional Streamable HTTP.
- Phase 4: Optional LLM integration with `vault-agent chat` while keeping retrieval and answer generation separate.
- Phase 5: Obsidian plugin client using the shared server and retrieval model.

See [docs/product-plan.md](docs/product-plan.md) for the detailed roadmap and phase policy.

## Requirements

- Node.js 22 or newer.
- npm.
- A local Markdown vault.

Optional:

- A local OpenAI-compatible embedding endpoint, such as Ollama, if you want semantic or hybrid search.

## Installation

Install the CLI from npm:

```bash
npm install -g @vault-agent/cli
vault-agent --help
```

Or run from Docker:

```bash
docker run --rm DOCKERHUB_USER/vault-agent:0.1.0 --help
```

## Quick Start From Source

Install dependencies and build the workspace:

```bash
npm install
npm run build
```

Run the local CLI from the checkout with `npx --no-install vault-agent`. This uses the workspace binary created by `npm install` and does not download a package from the registry.

### Route A: Use An Existing Local Vault

Configure a vault root in user-local config:

```bash
npx --no-install vault-agent config set vault.root "/path/to/your/vault"
```

Check the effective config:

```bash
npx --no-install vault-agent config get
```

Start the local server:

```bash
npx --no-install vault-agent serve
```

On first startup, the server creates the local index if no usable index exists. In another terminal, check that the server, index, watcher, and sync state are visible:

```bash
npx --no-install vault-agent status
```

If you want to rebuild the index explicitly, keep the server running and run:

```bash
npx --no-install vault-agent reindex
```

Search:

```bash
npx --no-install vault-agent search "local embedding privacy"
```

Retrieve a specific note or chunk from a search result:

```bash
npx --no-install vault-agent get note "<note-id>"
npx --no-install vault-agent get chunk "<note-id>" "<chunk-index>"
```

Find related candidates from a known note or chunk:

```bash
npx --no-install vault-agent related "<note-or-chunk-id>"
```

### Route B: Clone A Git-Backed Vault

Use this route when the vault should be checked out from a remote Git repository. Sync remains disabled unless you explicitly enable it.

```bash
npx --no-install vault-agent sync clone "https://example.com/owner/vault.git" --target "/path/to/local/vault" --index
```

Then start the server:

```bash
npx --no-install vault-agent serve
```

Check status:

```bash
npx --no-install vault-agent status
```

To configure an already-cloned Git worktree for manual sync:

```bash
npx --no-install vault-agent config set vault.root "/path/to/local/vault"
npx --no-install vault-agent sync configure --repo "/path/to/local/vault"
npx --no-install vault-agent sync status
```

Manual pull is available once sync is configured:

```bash
npx --no-install vault-agent sync pull
```

Scheduled sync is opt-in:

```bash
npx --no-install vault-agent sync enable
```

Git sync uses fetch plus fast-forward-only update behavior. It does not push, stash, reset, merge, or resolve conflicts automatically.

### Initialization Checklist

For a new local setup, the expected path is:

1. Install and build: `npm install && npm run build`.
2. Choose one vault root: either `config set vault.root ...` or `sync clone ... --target ...`.
3. Start one server process for that vault: `vault-agent serve`.
4. Confirm readiness: `vault-agent status`.
5. Search compact results with `search`.
6. Retrieve only explicit notes or chunks with `get`.

`index` and `reindex` are server-backed commands. Run them from another terminal while `vault-agent serve` is running.

## CLI Commands

Common commands:

```bash
vault-agent config get
vault-agent config set vault.root "/path/to/vault"
vault-agent config path
vault-agent config reveal-api-key
vault-agent serve
vault-agent status
vault-agent watch status
vault-agent index
vault-agent reindex
vault-agent search "query"
vault-agent related "<note-or-chunk-id>"
vault-agent get note "<note-id>"
vault-agent get chunk "<note-id>" "<chunk-index>"
vault-agent get attachment "attachments/example.pdf"
vault-agent sync clone "https://example.com/owner/vault.git" --target "/path/to/vault"
vault-agent sync status
vault-agent sync configure --repo "/path/to/vault"
vault-agent sync pull
vault-agent sync enable
vault-agent sync disable
```

Most commands support `--json` for machine-readable output.

After the CLI is installed or linked on your PATH, use `vault-agent ...` directly. From a source checkout, use `npx --no-install vault-agent ...`.

## MCP Usage

For local MCP clients, use stdio transport:

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

The stdio command does not start an HTTP server and does not require an API key.
It uses the configured vault root and existing local index.

For server-backed MCP with automatic indexing and file watching, enable the
Streamable HTTP endpoint on `vault-agent serve`:

```bash
vault-agent config set mcp.enabled true
vault-agent serve
```

When `serve` binds to localhost, `/mcp` follows the same local access behavior
as the rest of the server. Non-localhost binds require API key protection.

## Docker

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

## Configuration

Configuration can come from CLI flags, environment variables, user-local TOML config, and built-in defaults.

Common environment variables are listed in [.env.example](.env.example).

The default server endpoint is:

```text
http://127.0.0.1:8787
```

The server binds to `127.0.0.1` by default. Non-localhost access must be explicitly configured and requires API key protection.

Normal config output does not print secret values. Use `vault-agent config reveal-api-key` only when you intentionally need to copy the API key for remote client setup.

File watching is enabled by default:

```bash
npx --no-install vault-agent config set watch.enabled true
```

Disable watching when you want fully manual indexing:

```bash
npx --no-install vault-agent config set watch.enabled false
```

Git sync is disabled by default and must be configured explicitly. Repository paths, remote names, branches, API keys, and webhook secrets belong in user-local config or environment variables, not in repository files.

## Embedding Setup

Embedding search is disabled by default. Lexical search works without an embedding provider.

The current embedding implementation supports local OpenAI-compatible embedding endpoints only. The endpoint host must be `127.0.0.1`, `localhost`, or `::1`. External SaaS embedding providers and provider authentication are out of scope.

One common local setup is Ollama with an embedding model:

```bash
ollama pull nomic-embed-text
ollama serve
```

Configure `vault-agent` to use the local endpoint:

```bash
npx --no-install vault-agent config set embedding.enabled true
npx --no-install vault-agent config set embedding.endpoint "http://127.0.0.1:11434/v1/embeddings"
npx --no-install vault-agent config set embedding.model "nomic-embed-text"
```

Then rebuild the index with embeddings:

```bash
npx --no-install vault-agent reindex --require-embeddings
```

`--require-embeddings` makes indexing fail if embedding generation fails. Without it, indexing may still succeed with a lexical index and an embedding warning when `embedding.require` is false.

To make embedding generation mandatory for future index requests through configuration:

```bash
npx --no-install vault-agent config set embedding.require true
```

If you change the embedding model or the provider returns a different vector dimension, run `reindex` so stored vectors match the current configuration.

## Embedding Usage

When embeddings are indexed and available, search defaults to hybrid mode. Hybrid mode combines lexical and embedding results.

Explicit search modes:

```bash
npx --no-install vault-agent search --mode lexical "privacy local index"
npx --no-install vault-agent search --mode hybrid "notes about semantic retrieval"
npx --no-install vault-agent search --mode embedding "conceptually similar notes"
```

Related lookup also supports embedding and hybrid modes:

```bash
npx --no-install vault-agent related --mode embedding "<note-or-chunk-id>"
npx --no-install vault-agent related --mode hybrid "<note-or-chunk-id>"
```

Mode behavior:

- `lexical` uses only the local lexical index.
- `hybrid` uses embeddings when available and falls back to lexical with an `EMBEDDING_UNAVAILABLE` warning when embeddings are configured but unavailable.
- `embedding` requires embeddings. If embeddings are unavailable, the command fails with `EMBEDDING_UNAVAILABLE`.

Use `--json` when another agent or script needs stable machine-readable output:

```bash
npx --no-install vault-agent search --mode hybrid --limit 5 --json "retrieval architecture"
```

## Privacy And Safety

- Do not commit private vault content.
- Do not commit real `.env` files, credentials, tokens, API keys, local indexes, caches, databases, logs, or machine-specific paths.
- API and CLI output should prefer vault-relative paths and stable note or chunk IDs.
- Search and related responses should stay compact and must not silently return full note bodies.
- External embedding providers are not defaults. Any provider that sends vault content outside the machine must be explicitly configured.

## Development

```bash
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
```

Start the development server with:

```bash
npm run dev:server
```

## Documentation

- [Product plan](docs/product-plan.md)
- [Phase 1 requirements](docs/phases/phase-1-retrieval-foundation/requirements.md)
- [Phase 1 specifications](docs/phases/phase-1-retrieval-foundation/specifications/)
- [Phase 2 requirements](docs/phases/phase-2-automatic-index-updates/requirements.md)
- [Phase 2 specifications](docs/phases/phase-2-automatic-index-updates/specifications/)
- [Agent working rules](AGENTS.md)
