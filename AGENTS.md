# AGENTS.md

This repository is intended to become the public `vault-agent` project: a standalone server and CLI that let AI agents search a local Markdown vault and retrieve only the context they explicitly need.

## Repository Policy

- Treat this repository as future public GitHub material.
- Do not commit private or sensitive vault content, API keys, tokens, private endpoints, or machine-specific absolute paths.
- Keep product and requirement decisions in `docs/`.
- Keep this file focused on repository policy and agent working rules.
- Before implementing changes that affect product behavior, public API shape, security, privacy, or architecture, update the relevant document in `docs/`.
- Documentation updates are not required for typo fixes, test-only changes, mechanical refactors, or internal implementation changes that do not alter the intended behavior.

## Project Direction

- The initial focus is a standalone server plus CLI.
- The initial product handles one vault root per server process; multiple vaults should use separate server instances unless future docs say otherwise.
- Do not trap search, indexing, or note retrieval inside the Obsidian plugin lifecycle.
- Treat the Obsidian plugin and MCP bridge as future clients.
- Default to local-first and private-by-default behavior.

## Agent Working Rules

- Read the relevant `docs/` documents before proposing or making implementation changes.
- Preserve the separation between core, server, and client responsibilities.
- Do not mix search with LLM answer generation.
  - `search` returns deterministic search results only and must not call an LLM.
  - `get` returns only the explicitly requested note or chunk.
  - `related` returns compact candidates from a known note or chunk and must not silently retrieve note bodies.
  - `config` manages user-local settings and must not write private paths or credentials into repository files.
  - `sync` is a future opt-in Git checkout update command and must not push or auto-resolve conflicts.
  - `chat` is a future LLM integration command.
- Avoid designs that return large note bodies as search results.
- When an agent needs vault context, narrow candidates with `search`, then retrieve only the necessary note or chunk with `get`.

## Architecture Boundaries

- `core` owns filesystem discovery, Markdown reading, frontmatter parsing, chunking, embedding text generation, index operations, ranking, and search result schemas.
- `server` owns HTTP routing, request validation, endpoint configuration, access control boundaries, and delegation to core.
- `cli` owns argument parsing, user-facing command behavior, output formatting, endpoint resolution, and server communication.
- Do not duplicate core search, indexing, or note lookup behavior in server route handlers or clients.
- TODO: Add concrete source directory paths once the project structure exists.

## Working Commands

- TODO: Add install, test, typecheck, lint, server, and local CLI commands once the implementation stack and package scripts exist.

## Test And Fixture Policy

- Use only synthetic Markdown content for fixtures, examples, snapshots, and test vaults.
- Do not copy real private or sensitive vault content, real names, private project names, private paths, or private URLs into tests.
- Search-result snapshots should cover compact result metadata and snippets, not full note bodies.
- If a test needs realistic content, write a small public-safe note specifically for the test.

## Configuration And Secrets Policy

- Commit only public-safe sample configuration, such as `.env.example` or documented example config values.
- Do not commit real `.env` files, provider credentials, API keys, tokens, private endpoint URLs, or machine-specific vault paths.
- Runtime secrets and private paths should come from environment variables or user-local config files.
- External LLM or embedding providers must be opt-in and must not become the default path for private vault content.
- API and CLI output should prefer vault-relative paths and stable note or chunk identifiers over private absolute paths.

## Local Data And Generated Files

- Treat search indexes, local databases, embedding caches, generated snippets, and logs as potentially derived from private vault content.
- Do not commit generated indexes, cache directories, local databases, coverage output, build output, or runtime logs.
- If generated files are needed for tests, generate them from synthetic fixtures during the test run.
- Keep `.gitignore` aligned with any new local data, cache, or build output paths introduced by the implementation.

## Data Minimization

- Return and log the minimum content needed for the requested operation.
- Search responses should prefer metadata, scores, reasons, short snippets, and chunk identifiers over note bodies.
- Error messages and debug logs must not dump full notes, full chunks, raw queries, generated answers, secrets, private paths, request bodies containing note content, or provider credentials.
- Any feature that expands context automatically must be documented and opt-in.
- Automatic Git pull / sync behavior must be opt-in and should assume clean-worktree, fast-forward-only behavior unless phase docs explicitly define otherwise.

## Review Checklist

- Check whether the change affects product behavior, public API shape, security, privacy, or architecture, and update `docs/` first when it does.
- Check that server defaults remain localhost-only and private-by-default.
- Check that one server process maps to one vault root unless phase docs explicitly define multiple-vault support.
- Check that `search`, `get`, `related`, and `chat` responsibilities remain separated.
- Check that `config` and future `sync` behavior use user-local configuration and do not commit private paths, credentials, remotes, indexes, or logs.
- Check that tests and examples use only synthetic public-safe content.
- Check that new local data, generated files, and secrets are excluded from commits.

## Public Repository Safety

- Assume the target vault may contain private or sensitive notes.
- If examples use real vault-derived content, sanitize it into a public-safe form first.
- Do not hard-code private absolute paths in committed docs or code.
- The server default bind host must be `127.0.0.1`.
- Non-localhost access must be explicitly configured and should assume either a private network or API key protection.

## Documentation Map

- `docs/product-plan.md`: product plan covering background, goals, non-goals, design decisions, and roadmap.
- Future phase requirements should live under `docs/phases/<phase-name>/requirements.md`.
- Future phase specifications should live under `docs/phases/<phase-name>/specification.md`.
