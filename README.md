# vault-agent

`vault-agent` is a standalone server and CLI for searching a local Markdown
vault and retrieving only the context an AI agent explicitly asks for.

It is local-first and private-by-default:

- Search a Markdown vault through a CLI, HTTP server, or MCP tools.
- Return compact search results with snippets, scores, and stable note or chunk
  IDs.
- Retrieve full notes, chunks, or attachments only through explicit `get`
  commands.
- Keep indexing, search, related lookup, file watching, and optional Git sync on
  your machine.
- Use lexical search by default, with optional local embeddings when configured.

`vault-agent` does not generate answers, edit notes, host a public service, or
serve multiple vault roots from one server process.

## Installation

Requirements:

- Node.js 22 or newer.
- npm.
- A local Markdown vault.

Install the CLI from npm:

```bash
npm install -g @vault-agent/cli
vault-agent --help
```

For local development from a source checkout:

```bash
npm install
npm run build
npx --no-install vault-agent --help
```

Docker image:

```bash
docker pull namka0703/vault-agent:0.1.0
```

Docker usage is covered in the [setup guide](docs/setup-guide.md).

## Quick Start

Configure one vault and enable the MCP HTTP endpoint:

```bash
vault-agent config set vault.root "/path/to/your/vault"
vault-agent config set mcp.enabled true
vault-agent serve
```

To enable local embedding search with [Ollama](https://ollama.com/) (see also
[ollama/ollama](https://github.com/ollama/ollama)), make sure Ollama is running
locally, then pull an embedding model and point `vault-agent` at Ollama's
OpenAI-compatible endpoint before starting the server:

```bash
ollama pull nomic-embed-text
vault-agent config set embedding.enabled true
vault-agent config set embedding.endpoint "http://127.0.0.1:11434/v1/embeddings"
vault-agent config set embedding.model "nomic-embed-text"
vault-agent serve
```

The server binds to `127.0.0.1:8787` by default. On first startup, it creates a
local index automatically if no usable index exists. File watching is enabled by
default, so Markdown changes are indexed incrementally while the server is
running. Lexical search works without embeddings; when embeddings are indexed
and available, search can use hybrid or embedding mode. `nomic-embed-text` is
an example embedding model; if you enable or change embeddings after an index
already exists, run `vault-agent reindex`.

Search from another terminal:

```bash
vault-agent search "retrieval privacy"
vault-agent get note "<note-id>"
vault-agent status
```

Connect an MCP client that supports Streamable HTTP to:

```text
http://127.0.0.1:8787/mcp
```

For stdio MCP clients:

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

For source checkouts, replace `vault-agent` with
`npx --no-install vault-agent` in the commands above.

## Common Commands

```bash
vault-agent config get
vault-agent config set vault.root "/path/to/vault"
vault-agent serve
vault-agent status
vault-agent index
vault-agent reindex
vault-agent search "query"
vault-agent related "<note-or-chunk-id>"
vault-agent get note "<note-id>"
vault-agent get chunk "<note-id>" "<chunk-index>"
vault-agent get attachment "attachments/example.pdf"
vault-agent sync status
vault-agent sync pull
```

Most commands support `--json` for machine-readable output.

## Documentation

- [Setup guide](docs/setup-guide.md): detailed local, Docker, MCP, sync,
  configuration, and embedding setup.
- [Product plan](docs/product-plan.md): goals, non-goals, architecture, and
  roadmap.
- [Phase 1 requirements](docs/phases/phase-1-retrieval-foundation/requirements.md)
  and [specifications](docs/phases/phase-1-retrieval-foundation/specifications/)
- [Phase 2 requirements](docs/phases/phase-2-automatic-index-updates/requirements.md)
  and
  [specifications](docs/phases/phase-2-automatic-index-updates/specifications/)
- [Phase 3 requirements](docs/phases/phase-3-mcp-bridge/requirements.md) and
  [specifications](docs/phases/phase-3-mcp-bridge/specifications/)
- [Agent working rules](AGENTS.md)

## Development

```bash
npm run clean
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
```

Run build-output CLI smoke tests after building:

```bash
npm run test:dist
```

Start the development server with:

```bash
npm run dev:server
```

## Status

This repository is in the Phase 3 MCP bridge stage. See the
[product plan](docs/product-plan.md) for the full roadmap.
