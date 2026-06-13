# vault-agent

`vault-agent` is a standalone server and CLI for searching a local Markdown vault and retrieving only the context an AI agent explicitly needs.

The project is local-first and private-by-default. Search, indexing, and retrieval run against a vault on your machine. Search results are compact metadata and snippets; full note or chunk bodies are returned only through explicit `get` commands.

## Status

This repository is in the Phase 1 retrieval foundation stage.

Phase 1 includes:

- A local HTTP server.
- A CLI client.
- Markdown discovery, parsing, chunking, indexing, search, related-candidate lookup, and explicit note, chunk, and attachment retrieval.
- Lexical search by default.
- Optional local embedding search when explicitly configured.

Out of scope for Phase 1:

- Hosted/public service operation.
- Note writing or editing.
- Chat or answer generation.
- Automatic Git sync.
- Multiple vault roots in one server process.

## Roadmap

- Phase 1: Retrieval foundation with a standalone server, CLI, local indexing, compact search results, explicit retrieval, related lookup, and optional local embeddings.
- Phase 2: Automatic index updates, file watching, stale index handling, and opt-in Git checkout sync for remote or server deployments.
- Phase 3: Thin MCP bridge exposing `search`, `get`, and `related` through the same HTTP server.
- Phase 4: Optional LLM integration with `vault-agent chat` while keeping retrieval and answer generation separate.
- Phase 5: Obsidian plugin client using the shared server and retrieval model.

See [docs/product-plan.md](docs/product-plan.md) for the detailed roadmap and phase policy.

## Requirements

- Node.js 22 or newer.
- npm.
- A local Markdown vault.

Optional:

- A local OpenAI-compatible embedding endpoint, such as Ollama, if you want semantic or hybrid search.

## Quick Start From Source

Install dependencies and build the workspace:

```bash
npm install
npm run build
```

Run the local CLI from the checkout with `npx --no-install vault-agent`. This uses the workspace binary created by `npm install` and does not download a package from the registry.

Configure a vault root:

```bash
npx --no-install vault-agent config set vault.root "/path/to/your/vault"
```

Start the server:

```bash
npx --no-install vault-agent serve
```

In another terminal, index the vault:

```bash
npx --no-install vault-agent index
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

## CLI Commands

Phase 1 commands:

```bash
vault-agent config get
vault-agent config set vault.root "/path/to/vault"
vault-agent config path
vault-agent config reveal-api-key
vault-agent serve
vault-agent index
vault-agent reindex
vault-agent search "query"
vault-agent related "<note-or-chunk-id>"
vault-agent get note "<note-id>"
vault-agent get chunk "<note-id>" "<chunk-index>"
vault-agent get attachment "attachments/example.pdf"
```

Most commands support `--json` for machine-readable output.

After the CLI is installed or linked on your PATH, use `vault-agent ...` directly. From a source checkout, use `npx --no-install vault-agent ...`.

## Configuration

Configuration can come from CLI flags, environment variables, user-local TOML config, and built-in defaults.

Common environment variables are listed in [.env.example](.env.example).

The default server endpoint is:

```text
http://127.0.0.1:8787
```

The server binds to `127.0.0.1` by default. Non-localhost access must be explicitly configured and requires API key protection.

Normal config output does not print secret values. Use `vault-agent config reveal-api-key` only when you intentionally need to copy the API key for remote client setup.

## Embedding Setup

Embedding search is disabled by default. Lexical search works without an embedding provider.

Phase 1 supports local OpenAI-compatible embedding endpoints only. The endpoint host must be `127.0.0.1`, `localhost`, or `::1`. External SaaS embedding providers and provider authentication are out of scope for Phase 1.

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
- [Agent working rules](AGENTS.md)
