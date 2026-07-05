# Phase 3.5 Style and Metadata Profile Discovery Requirements

Status: Draft

## Purpose

Phase 3.5 adds read-only profile discovery for a scoped set of notes so agents
can understand local vault conventions without reading many full notes.

The feature preserves the product direction from `docs/product-plan.md`:
local-first, private-by-default, deterministic retrieval, progressive
disclosure, one vault root per server process, and clear separation between
core, server, CLI, and MCP responsibilities.

## Scope

Phase 3.5 must include:

- Core profile discovery from indexed note metadata and indexed Markdown text.
- HTTP APIs for metadata profiles and style profiles.
- CLI commands for both profile surfaces.
- MCP tools for both profile surfaces.
- Scoping by vault-relative `pathPrefix`, frontmatter tags, allowlisted
  frontmatter fields, and explicit note IDs.
- Vault-relative paths and stable note IDs only.
- Compact aggregate responses without note bodies or chunk bodies.
- Tests using only synthetic public-safe Markdown fixtures.

Phase 3.5 must not include:

- LLM answer generation.
- Note writing or style enforcement.
- Automatic retrieval of representative note bodies.
- Arbitrary unbounded frontmatter value exposure.
- Stored profile caches or precomputed profile tables.
- Multiple vaults in one server process.

## Profile Model

Metadata profiles summarize frontmatter conventions:

- total scoped note count
- common frontmatter keys and note counts
- value counts only for the existing allowlisted fields: `type` and `status`
- common frontmatter tags
- degraded frontmatter count
- compact representative examples with note ID, path, and title
- example selection policy, either stable path order or deterministic
  representative scoring

Style profiles summarize Markdown and linking conventions:

- heading level distribution
- common heading names
- count of notes whose first H1 matches the note title or filename stem
- count of notes using wiki links and Markdown links
- attachment reference count summary
- simple deterministic naming pattern counts for path basenames
- compact representative examples with note ID, path, and title
- example selection policy, either stable path order or deterministic
  representative scoring

Profile filters use AND semantics across filter types:

- `pathPrefix`: include notes under any requested vault-relative path prefix.
- `tag`: include notes with any requested frontmatter tag.
- `frontmatter.type` / `frontmatter.status`: include notes with any requested
  allowlisted field value.
- `noteId`: include only explicitly listed notes.

Representative examples never include note bodies. The default selection policy
is `path`, which returns stable vault-relative path order. The
`representative` policy deterministically ranks examples by indexed metadata
density such as frontmatter fields, tags, links, and attachment references, then
breaks ties by path.

Frontmatter value exposure defaults to the fixed allowlist `type` and `status`.
Additional value exposure is allowed only through user-local configuration:

```toml
[profiles]
frontmatter_value_allowlist = ["category"]
```

This configuration must not be committed with private field names or values.

## HTTP API

Required endpoints:

- `GET /profiles/metadata?pathPrefix=Projects&limit=20`
- `GET /profiles/style?pathPrefix=Projects&limit=20`
- `GET /profiles/metadata?tag=project&frontmatterStatus=active`
- `GET /profiles/style?noteId=<note-id>&exampleSelection=representative`

All endpoint responses use the existing HTTP envelope:

```json
{
  "data": {},
  "warnings": []
}
```

The `pathPrefix` parameter is optional. When omitted, the profile covers the
whole vault. When present, it must be a vault-relative prefix and must reject
absolute paths, URL-like paths, and traversal segments.

Supported query parameters:

- `pathPrefix`
- repeated `tag`
- repeated `frontmatterType`
- repeated `frontmatterStatus`
- repeated `noteId`
- `exampleSelection=path|representative`
- `limit`

## CLI

Required commands:

- `vault-agent profile metadata [--path <prefix>] [--limit <n>]`
- `vault-agent profile style [--path <prefix>] [--limit <n>]`

Both commands support repeated `--tag`, repeated `--frontmatter type=value` or
`--frontmatter status=value`, repeated `--note-id`, `--examples
path|representative`, and `--json`. Human-readable output must remain compact
and must not print note bodies.

## MCP Tools

Required read-only tools:

- `vault_metadata_profile`
- `vault_style_profile`

MCP responses use the same inner payloads as the HTTP API plus a top-level
`warnings` array.

Both tools are read-only, idempotent, and non-destructive.

Tool inputs include optional `path_prefix`, `filters.tags`,
`filters.frontmatter.type`, `filters.frontmatter.status`, `filters.note_ids`,
`example_selection`, and `limit`.

## Safety

Profile discovery must:

- Return vault-relative paths only.
- Avoid full note bodies and chunk bodies.
- Respect the fixed frontmatter value allowlist used by facets and structured
  search filters, plus only user-local configured profile value allowlist
  fields.
- Use bounded limits for examples and common-value lists.
- Preserve `search`, `get`, and `related` responsibilities.
- Avoid logging full notes, full chunks, frontmatter values, private absolute
  paths, or request bodies containing note content.

## Acceptance Criteria

- Profile discovery is read-only and deterministic.
- Metadata profiles expose frontmatter values only for `type` and `status`.
- Metadata profiles may expose additional frontmatter values only when those
  fields are explicitly allowlisted in user-local config.
- Profile filters support path prefix, tags, `type`, `status`, and explicit
  note IDs.
- Profile examples support stable path-order and deterministic representative
  selection.
- Style profiles include heading, title, link-style, attachment, and naming
  pattern statistics.
- Both profiles work for a folder/path-prefix scope.
- HTTP, CLI, and MCP surfaces are available.
- Tests use synthetic vault fixtures only.
