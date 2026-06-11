# vault-agent Product Plan

## Overview

`vault-agent` is a standalone server and CLI for searching a local Markdown vault and giving AI agents only the small amount of context they explicitly need.

The initial product should not be built as an Obsidian plugin. Search, indexing, and note retrieval should live in a standalone foundation so CLI agents, HTTP clients, a future MCP bridge, and an Obsidian UI can share the same core behavior.

```text
CLI / Obsidian plugin / MCP bridge
  -> HTTP server
    -> core
      -> vault files / search index
```

## Background

When an AI agent needs to use a local vault, the product should avoid passing the entire vault or large note bodies into context. It should safely retrieve only the notes or chunks needed for the current task.

AI usage is broader than simple search. Users may use agents for thinking, design discussion, review, and planning. For those workflows, the useful pattern is not dumping a large search result into context. The useful pattern is adding context gradually as the conversation or task requires it.

Basic retrieval flow:

```text
query
-> return a small ranked result list
-> inspect title / path / reason / snippet
-> explicitly retrieve only the needed note or chunk
-> use it in the agent conversation or work context
```

`related` is not query search. It is a helper for finding nearby candidates from a known note or chunk. It should not auto-expand note bodies. It should return compact candidates that the user or agent can explicitly retrieve with `get`.

## Target Users

The primary users are people with a local Markdown vault who want CLI-based agent workflows, such as Codex, opencode, or Claude Code, to retrieve only the notes they need.

Secondary users are people who want to search a vault and retrieve notes through a CLI or HTTP API for human reading.

Future users include people who want the same vault retrieval foundation from an Obsidian plugin or MCP-compatible client.

## Key Use Cases

- Give an active agent a small set of relevant candidates instead of the entire vault.
- Search from a user query, return compact ranked results, then explicitly retrieve only the needed note or chunk.
- Start from an already-read note or chunk and find nearby candidates to read next.
- Index a vault locally and run basic search without sending note content outside the machine.
- Start with manual index / reindex, then later support automatic index updates.
- Stabilize the CLI and HTTP API so future clients can share the same server and core.

## Goals

- Let CLI agents retrieve vault context with low token usage.
- Provide deterministic CLI and HTTP APIs for search and note retrieval.
- Start with manual indexing while keeping the design extensible to automatic and incremental index updates.
- Make lexical search the default and allow hybrid search only when embedding search is explicitly configured.
- Keep the design local-first and private-by-default.
- Let future Obsidian plugin and MCP bridge clients use the same core and server.
- Keep `search`, `get`, `related`, and `chat` responsibilities separate.

## Non-Goals

- Do not make the initial product an Obsidian plugin.
- Do not make MCP the primary initial integration surface.
- Do not return large note bodies from `search`.
- Do not build this as a public hosted web service.
- Do not include private vault content in the repository.
- Do not include `chat` in the MVP.
- Do not bundle embedding models or automatically download / pull them.
- Do not support multiple vaults inside one server process in the initial product. If needed, users can run multiple server instances with separate ports and config.
- Do not treat direct public internet exposure as a supported hosted-service mode.
- Do not include note writing or editing workflows in the MVP. If added later, they should be read-only by default, opt-in, proposal-first, and reviewable.

## Design Principles

- Local-first: by default, the product uses localhost, the local filesystem, and a local index.
- Private-by-default: private vault content, indexes, caches, logs, and examples should not be leaked to the public repository or external providers.
- Progressive disclosure: the first response should be a small candidate list; note body retrieval should require an explicit user or agent action.
- Deterministic retrieval: `search`, `get`, and `related` are retrieval tools, not LLM answer-generation tools.
- Thin clients: the CLI, Obsidian plugin, and MCP bridge should not duplicate core behavior.
- Provider optionality: embedding and LLM providers should be replaceable, and providers that send content outside the machine should not be defaults.
- Single-vault boundary: initially, one server process handles one vault root. Multiple-vault support is future work; users can run separate server instances when needed.
- Vault-relative identity: API and CLI output should use vault-relative paths and stable note / chunk identifiers by default, not private absolute paths.
- Local derived data: indexes, embedding caches, local databases, and logs are local data derived from a private vault and must not be committed.
- Minimal logging: logs and error messages must not dump full notes, full chunks, raw queries, generated answers, request bodies, secrets, private absolute paths, or provider credentials.

## Documentation Policy

`docs/product-plan.md` is the source of truth for background, goals, non-goals, design principles, and roadmap. Detailed phase requirements and API / CLI / config / storage specifications should live in phase documents, not in this file.

Recommended phase document structure:

```text
docs/
  product-plan.md
  phases/
    phase-1-retrieval-foundation/
      requirements.md
      specification.md
    phase-2-automatic-index-updates/
      requirements.md
      specification.md
```

Phase workflow:

```text
review goals and non-goals in product-plan.md
-> create / update phase requirements
-> create / update phase specification
-> implement
-> update phase docs if implementation decisions change
-> verify acceptance criteria and complete the phase
```

## Success Criteria

The initial success condition is that a CLI-based agent can progressively retrieve only the notes it needs without putting the whole private vault into context.

Concretely, `index`, `search`, and `get` should work with local-only defaults. Search results should be compact, and note body retrieval should require an explicit action. Basic search should work without an embedding provider. If embeddings are used, they should go through a local provider explicitly configured by the user.

The future success condition is that non-CLI clients can use the same HTTP server and core, and that the Obsidian plugin and MCP bridge share the same retrieval model.

## Configuration Policy

In the initial product, one server process handles one vault root. The vault root is explicitly configured through user-local config, an environment variable, or a CLI flag. Private vault paths and machine-specific absolute paths must not be committed to the public repository.

API and CLI output should return vault-relative paths by default. Absolute paths should appear only when needed for setup or diagnostics, and private paths should not be leaked into logs or responses.

The CLI should provide a `vault config` command for user-local configuration. The initial scope is limited to local settings required for server and CLI connectivity, such as the vault root, server endpoint, and bind / access settings. Provider credentials and private paths should live in user-local config or environment variables, not in the repository.

Client endpoint resolution should be defined in phase specifications, but the default endpoint is the local-only `http://127.0.0.1:8787`.

## Architecture

`vault-agent` is split into core, server, and clients.

```text
vault-agent
|-- core
|   |-- markdown reading
|   |-- frontmatter extraction
|   |-- chunking
|   |-- embedding text generation
|   |-- index operations
|   |-- search / ranking
|   `-- search result schema
|
|-- cli
|   |-- serve
|   |-- config
|   |-- index / reindex
|   |-- sync
|   |-- search
|   |-- get
|   |-- related
|   `-- chat
|
|-- server
|   |-- HTTP API
|   |-- /search
|   |-- /notes
|   |-- /related
|   `-- /reindex
|
`-- future clients
    |-- Obsidian plugin
    `-- MCP bridge
```

### Core

Core is shared logic, not a standalone process.

Responsibilities:

- Markdown file discovery and reading
- Frontmatter extraction
- Note chunking
- Embedding text generation
- Index operations
- Search and ranking
- Search result schema construction

### Server

The server exposes core functionality through an HTTP API.

Default endpoint:

```text
http://127.0.0.1:8787
```

Remote access is not the default. If enabled, it must be explicitly configured and should assume a private network such as Tailscale or API key protection.

Binding to `0.0.0.0` is allowed only with explicit configuration. Access from outside localhost should assume a private network or API key protection. Direct public internet exposure is a non-goal.

### Clients

Clients should stay thin. They accept queries or commands, call the server, and format responses for agents or users.

Initial client:

- CLI

Future clients:

- Obsidian plugin
- MCP bridge

## Why Not Start With an Obsidian Plugin

If core logic lives inside an Obsidian plugin, CLI and agent workflows become dependent on Obsidian's desktop app lifecycle.

Likely problems:

- The server would not run unless Obsidian is open.
- CLI and agent usage would require Obsidian to be running.
- Desktop and mobile behavior would differ.
- Local ports and external process execution would be harder to explain.
- Plugin distribution would become tied to indexer and embedding provider distribution.
- LLM agent runtimes and the Obsidian UI lifecycle do not naturally align.

Preferred dependency direction:

```text
CLI -> standalone server -> vault
Obsidian plugin -> standalone server -> vault
MCP bridge -> standalone server -> vault
```

## Search Policy

Search should work by default with lexical search, such as FTS/BM25. Even without an embedding provider, keyword matching and compact note retrieval should provide a useful baseline experience.

Hybrid search is an optional feature that becomes available only when an embedding provider is explicitly configured.

- Lexical search, such as FTS/BM25, provides keyword matching and fallback behavior.
- Embedding search is an optional signal for semantic retrieval.
- Ranking should be able to combine lexical and semantic signals.

The initial local embedding provider target is Ollama. Ollama should be treated as a separately running local HTTP embedding provider, not as a model bundled with `vault-agent`.

`vault-agent` does not bundle embedding models and does not automatically download or pull them. If a configured provider or model is unavailable, the CLI or server should return setup instructions only. It should not perform implicit network access or large model downloads.

External embedding providers such as OpenAI can be added later, but they must not be defaults because they may send note content outside the machine.

## Command Policy

Initial commands:

```bash
vault config
vault config set vault.root "/path/to/vault"
vault serve
vault index
vault search "local embedding privacy"
vault get "Examples/Search Architecture.md"
vault related "Examples/Search Architecture.md"
```

Post-MVP commands:

```bash
vault sync
vault chat "summarize the requirements related to this design note"
vault chat
```

Responsibility split:

- `search`: performs deterministic search only.
- `get`: returns only the explicitly requested note or chunk.
- `related`: starts from a known note or chunk and returns compact related-candidate metadata.
- `config`: inspects and updates user-local configuration. Private vault paths, endpoints, and access settings are stored in local config, not in the repository.
- `sync`: updates the vault checkout from a configured remote source. In Phase 2, this targets opt-in `git fetch` / `git pull` for a Git checkout.
- `chat`: performs vault-aware question answering using retrieval results as context. With an argument it is single-shot; without an argument it starts an interactive session.

## Roadmap

The MVP is Phase 1: Retrieval Foundation. Phase 2 and later are post-MVP extensions. Detailed requirements and specifications for each phase live under `docs/phases/<phase-name>/`.

### Phase 1: Retrieval Foundation

- `vault serve`
- `vault config`
- `vault index`
- `vault search`
- `vault get`
- `vault related`
- Local HTTP API used by the CLI
- Stable request / response schemas for search, get, related, and reindex
- Endpoint configuration
- Security defaults
- Agent-facing usage guidance

Purpose: let Codex, opencode, Claude Code, and similar CLI-based agent workflows retrieve vault context with small context usage. Because the CLI goes through the standalone server to use core behavior, the initial phase includes the local HTTP API. This phase should create a shared retrieval surface for the CLI and future clients.

### Phase 2: Automatic Index Updates

- File watching
- Incremental index update
- Stale index detection
- Manual reindex fallback
- Provider / model change reindex guidance
- Opt-in Git sync for remote / server deployments
- `vault sync` for configured Git checkout updates
- Manual / scheduled / webhook-triggered Git sync policy
- File tree change detection and index stale handling after `git fetch` / `git pull`

Purpose: stop depending only on manual `vault index` and let the system follow vault changes in a local-first way. If the vault root on a remote server is a Git checkout, explicitly configured sync policy should support manual, scheduled, or webhook-triggered `git fetch` / `git pull`, then connect resulting file changes to stale index handling or reindexing.

Git sync is not a note writing or editing workflow. It is a helper that lets a read-only retrieval server update a vault checkout managed elsewhere. Automatic pull is opt-in and must explicitly configure the target repository / branch, schedule or webhook, credentials, and access control. Conflict handling, dirty worktree behavior, and remote URL handling are defined in the Phase 2 specification. The system must not perform implicit push or automatic conflict resolution. Automatic pull should default to clean-worktree and fast-forward-only behavior.

### Phase 3: MCP Bridge

- Expose `search`, `get`, and `related` as MCP tools.
- Keep the bridge thin by calling the HTTP server.
- Preserve progressive disclosure for MCP clients.
- Keep tool responses based on compact results and explicit retrieval.

Purpose: let MCP-compatible clients safely retrieve vault context in stages.

### Phase 4: LLM Integration

- `vault chat "question"` for single-shot vault-aware answers
- `vault chat` for interactive sessions
- HTTP chat interface for single-shot and explicit-session usage
- LLM provider settings
- Conversation history
- Referenced-note reporting

Purpose: let users ask vault-aware questions directly from the CLI without going through Codex or another external agent.

`vault chat "question"` returns a single-shot answer and exits. By default it does not persist conversation history. `vault chat` starts an interactive session and keeps conversation history for that session. For HTTP clients, single-shot chat should not require a persistent session, while interactive chat assumes the client explicitly provides a session id. Chat does not write or edit notes.

### Phase 5: Obsidian Plugin

- Server status display
- Search UI
- Chat UI
- Endpoint / API key settings
- Guidance when the server is not running

Purpose: let Obsidian use the same search and LLM foundation.

## Delivery Policy

For initial local use, prefer distribution options that are simple to install.

Candidates:

- npm global package
- GitHub Releases single binary
- Docker Compose
- systemd user service
- Homebrew later

The initial implementation target is TypeScript/Node with npm distribution.
