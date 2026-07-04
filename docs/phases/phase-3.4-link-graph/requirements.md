# Phase 3.4 Link Graph Requirements

Status: Draft

## Purpose

Phase 3.4 adds read-only link graph discovery so agents and users can inspect
explicit vault relationships separately from `related` content similarity.

The feature preserves the product direction from `docs/product-plan.md`:
local-first, private-by-default, deterministic retrieval, progressive
disclosure, one vault root per server process, and clear separation between
core, server, CLI, and MCP responsibilities.

## Scope

Phase 3.4 must include:

- Core link graph discovery from indexed note link metadata.
- HTTP APIs for note links, backlinks, broken links, orphan notes, and compact
  graph summary.
- CLI commands for the same read-only surfaces.
- MCP tools for the same read-only surfaces.
- Vault-relative paths and stable note IDs only.
- Compact responses without note bodies or chunk bodies.
- Tests using only synthetic public-safe Markdown fixtures.

Phase 3.4 must not include:

- LLM answer generation.
- Note writing or link repair.
- Automatic retrieval of linked note bodies.
- Full graph dumps without limits.
- Multiple vaults in one server process.
- Attachment graph traversal.

## Link Model

Initial link graph data is based on indexed wiki links and Markdown links to
`.md` / `.markdown` notes. Existing Markdown attachment references remain
attachment metadata, not note graph edges, in this phase.

Each edge records:

- source note ID and vault-relative path
- raw target text from the link
- optional heading anchor and display text
- link kind: `wiki` or `markdown`
- resolved target note ID and path when resolution is unambiguous
- `resolved: false` for unresolved, ambiguous, or broken note links

Orphan notes are notes with no resolved inbound note links and no resolved
outbound note links. Unresolved links alone do not make a note non-orphan.

## HTTP API

Required endpoints:

- `GET /links/notes/{noteId}`: return outlinks and backlinks for one note.
- `GET /links/backlinks/{noteId}`: return backlinks for one note.
- `GET /links/broken?limit=50`: return unresolved links across the vault.
- `GET /links/orphans?limit=50`: return orphan notes.
- `GET /links/summary?limit=20&pathPrefix=Projects`: return compact graph
  counts and top linked notes, optionally scoped by path prefix.

All endpoint responses use the existing HTTP envelope:

```json
{
  "data": {},
  "warnings": []
}
```

## CLI

Required commands:

- `vault-agent links note <noteId>`
- `vault-agent links backlinks <noteId>`
- `vault-agent links broken [--limit <n>]`
- `vault-agent links orphans [--limit <n>]`
- `vault-agent links summary [--limit <n>] [--path <prefix>]`

All commands support `--json`. Human-readable output must remain compact and
must not print note bodies.

## MCP Tools

Required read-only tools:

- `vault_links`
- `vault_backlinks`
- `vault_broken_links`
- `vault_orphans`
- `vault_link_summary`

MCP responses use the same inner payloads as the HTTP API plus a top-level
`warnings` array.

All tools are read-only, idempotent, and non-destructive.

## Safety

Link graph discovery must:

- Return vault-relative paths only.
- Avoid full note bodies and chunk bodies.
- Respect the index compatibility checks already used by retrieval and
  orientation surfaces.
- Use bounded limits for global responses.
- Preserve `related` as content similarity and keep explicit links separate.
