# Phase 1 Retrieval Foundation Specification

Status: Draft

## Purpose

This specification defines the concrete Phase 1 design for `vault-agent`. It implements the requirements in [requirements.md](requirements.md) while preserving the product direction in [../../product-plan.md](../../product-plan.md).

Detailed specification content is split by implementation domain so each requirement section can link directly to the relevant specification file.

## Specification Map

- [Tooling And Repository](specifications/tooling.md): technology stack, workspace layout, linting, and formatting.
- [Configuration](specifications/configuration.md): user-local paths, TOML config, environment variables, and precedence.
- [Indexing](specifications/indexing.md): vault discovery, Markdown parsing, chunking, identifiers, index storage, embeddings, and indexing flows.
- [Retrieval](specifications/retrieval.md): search, related, snippets, result shape, explicit note/chunk retrieval, and attachment retrieval.
- [Server API](specifications/server-api.md): HTTP server behavior, CORS, auth, response envelopes, error mapping, health, and index/reindex endpoints.
- [CLI](specifications/cli.md): commands, option parsing, endpoint resolution, output, and exit codes.
- [Testing And CI](specifications/testing-ci.md): tests, fixtures, CI, examples, and implementation sequence.
