# Phase 1 Testing And CI Specification

Status: Draft

This file is part of the Phase 1 specification. See ../requirements.md for requirements and this directory for the domain specifications.

## Testing

Phase 1 uses Vitest.

Test coverage should include:

- Core unit tests for path safety, frontmatter parsing, chunking, identifier generation, indexing, ranking, and retrieval schemas.
- Server integration tests for route validation, authentication, CORS, response envelopes, indexing, search, related, and explicit retrieval.
- CLI tests or smoke tests for command parsing, JSON output, config commands, and server-backed retrieval commands.

Tests must use synthetic public-safe Markdown fixtures only.

Fixture vaults should live near the package that primarily uses them, such as `packages/core/test/fixtures/vaults/basic`.

Integration tests must create synthetic vaults and index directories under the OS temporary directory during the test run.

Snapshots may cover compact metadata and short snippets from synthetic fixtures, but must not snapshot full note bodies or full chunks.

Embedding tests use a fake local OpenAI-compatible embedding server.

The fake embedding server returns deterministic small vectors so embedding search and hybrid ranking are reproducible.

Integration tests must verify that `sqlite-vec` loads successfully. Because Phase 1 treats semantic retrieval as a first-class feature, sqlite-vec loading failure should fail the relevant integration tests rather than silently skip them.

Phase 1 does not require a numeric coverage threshold. Tests should prioritize path safety, data minimization, indexing failure modes, search modes, retrieval limits, authentication, and synthetic fixture behavior.

Phase 1 does not require CI secrets scanning. Public repository safety is enforced through review policy and may be strengthened with tools such as gitleaks in a later phase.

## Continuous Integration

GitHub Actions should run:

```text
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run test:dist
```

CI runs on Node.js 22.

## Repository Documentation And Examples

Phase 1 should include README coverage for:

- Installation.
- User-local configuration.
- Starting the server.
- First-run bootstrap indexing.
- Manual `index` and `reindex`.
- `search`, `get`, and `related`.
- Privacy defaults and local-only behavior.

The repository should include `.env.example` with public-safe placeholder values only.

The repository should include `examples/config/config.example.toml` with public-safe placeholder values only.

The repository should include `examples/synthetic-vault` for documentation, demos, and manual verification. Example vault content must be synthetic and public-safe.

The repository `.gitignore` must exclude `node_modules`, build output, coverage output, `.env`, local SQLite databases, logs, caches, and other private derived data.

The project license is MIT.

Initial package version: `0.1.0`.

## Implementation Sequence

Recommended implementation order:

1. Workspace, package tooling, TypeScript, lint, format, test, and configuration foundation.
2. Core path safety, vault file discovery, Markdown parsing, frontmatter handling, wikilink extraction, and chunking.
3. SQLite schema, manifest, FTS5 lexical index, and trigram lexical index.
4. `sqlite-vec` loading, embedding provider integration, embedding storage, and embedding failure behavior.
5. Core search, hybrid ranking, related retrieval, link signal integration, snippets, and result schemas.
6. Explicit retrieval for notes, chunks, attachment metadata, and attachment downloads.
7. Fastify server routes, response envelope, authentication, CORS, error mapping, health, and startup bootstrap.
8. Commander CLI, endpoint resolution, config commands, server-backed commands, and output formatting.
9. Tests, synthetic fixtures, examples, README, CI, and acceptance hardening.
