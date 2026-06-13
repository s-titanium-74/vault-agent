# Phase 1 Tooling And Repository Specification

Status: Draft

This file is part of the Phase 1 specification. See ../specification.md for the specification map and ../requirements.md for requirements.

## Technology Stack

Phase 1 uses TypeScript on Node.js.

The implementation is split into:

- `core`: TypeScript library code for vault discovery, Markdown parsing, chunking, indexing, ranking, and retrieval schemas.
- `server`: Node.js HTTP server that validates requests, enforces access boundaries, and delegates retrieval work to `core`.
- `cli`: Node.js CLI that resolves local configuration, calls the server where appropriate, and formats output.

Storage, HTTP framework, CLI parser, package manager, and repository layout are defined in later sections.

## Repository Layout And Package Management

Phase 1 uses npm workspaces.

Repository layout:

```text
packages/
  core/
  server/
  cli/
```

Workspace responsibilities:

- `packages/core`: shared TypeScript library for filesystem discovery, Markdown reading, frontmatter parsing, chunking, embedding text generation, index operations, ranking, and retrieval schemas.
- `packages/server`: HTTP server package. It owns routing, request validation, access control, server configuration, error mapping, and delegation to `core`.
- `packages/cli`: CLI package. It owns argument parsing, user-facing command behavior, output formatting, endpoint resolution, local configuration commands, and server communication.

The repository root owns shared TypeScript, lint, format, test, workspace, and release configuration.

Root package scripts:

- `build`
- `typecheck`
- `lint`
- `format`
- `format:check`
- `test`
- `test:watch`
- `dev:server`

Phase 1 uses ESM packages with `"type": "module"`.

Minimum Node.js version: 22 LTS.

TypeScript settings:

- Target: `ES2022`.
- `strict: true`.
- `noUncheckedIndexedAccess: true`.

Build and development tools:

- Build tool: `tsup`.
- Development TypeScript runner: `tsx`.

Package source layout:

- `packages/core/src/index.ts`
- `packages/server/src/index.ts`
- `packages/server/src/main.ts`
- `packages/cli/src/index.ts`
- `packages/cli/src/main.ts`

Core public exports should include schemas, configuration types, indexer APIs, search APIs, retrieval APIs, and shared error types.

Server public exports should include `createServer(config)` and `startServer(config)`.

The CLI may use `core` configuration utilities and shared API schema types, but it must not implement search, indexing, ranking, or retrieval logic.

Phase 1 does not generate OpenAPI documentation. Public API schemas are defined in this specification and enforced with Zod in code.

`AGENTS.md` Working Commands should list the verified root package scripts once the implementation adds them.

The root workspace is private. npm publishing automation is out of scope for Phase 1. A future publishable CLI package may expose the `vault-agent` binary from `packages/cli`.

## Linting And Formatting

Phase 1 uses ESLint and Prettier from the repository root.

The root workspace should provide shared commands for:

- Type checking.
- Linting.
- Formatting checks.
- Running tests.
