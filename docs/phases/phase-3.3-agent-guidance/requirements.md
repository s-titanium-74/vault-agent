# Phase 3.3 Agent Guidance Discovery Requirements

Status: Draft

## Purpose

Phase 3.3 adds read-only discovery for vault-local agent guidance files such as
`AGENTS.md`, `CLAUDE.md`, `README.md`, `.cursorrules`, and `.cursor/rules/*`.

The feature helps agents find local conventions before creating or updating
notes while preserving the product direction from `docs/product-plan.md`:
local-first, private-by-default, deterministic retrieval, progressive
disclosure, one vault root per server process, and separate core, server, CLI,
and MCP responsibilities.

## Scope

Phase 3.3 must include:

- Core guidance discovery shared by HTTP and MCP.
- HTTP `GET /agent-guidance` returning compact candidates without file bodies.
- HTTP `GET /agent-guidance/*` returning one explicitly requested guidance file.
- MCP `vault_guidance_list` returning compact candidates.
- MCP `vault_guidance_get` returning one explicitly requested guidance file.
- Vault-relative paths only in responses.
- Path safety, vault-boundary checks, configured exclude handling, and size
  limits for body retrieval.
- Tests using only synthetic public-safe fixture content.

Phase 3.3 must not include:

- Note writing or editing behavior.
- LLM answer generation.
- Automatic injection of guidance file bodies into search, related, or
  orientation responses.
- Treating guidance content as higher-priority system instructions.
- Returning private absolute paths.
- Multiple vaults in one server process.
- User-configurable guidance allowlists.

## Guidance Model

Guidance discovery returns compact candidate metadata:

```json
{
  "path": "Projects/App/AGENTS.md",
  "kind": "agents",
  "scope": "Projects/App",
  "appliesTo": "Projects/App/**",
  "size": 3421,
  "updated": "2026-07-03T00:00:00.000Z"
}
```

Initial guidance kinds:

- `agents` for `AGENTS.md`
- `claude` for `CLAUDE.md`
- `readme` for `README.md`
- `cursorrules` for `.cursorrules`
- `cursor_rule` for files directly under `.cursor/rules/`

Candidates are sorted by path. The root scope is represented by an empty
`scope` and `appliesTo: "**"`.

## HTTP API

`GET /agent-guidance` returns:

```json
{
  "data": {
    "guidance": []
  },
  "warnings": []
}
```

`GET /agent-guidance/{vaultRelativePath}` returns:

```json
{
  "data": {
    "path": "AGENTS.md",
    "kind": "agents",
    "scope": "",
    "appliesTo": "**",
    "content": "# Agent guidance\n",
    "contentType": "text/markdown; charset=utf-8",
    "size": 17,
    "updated": "2026-07-03T00:00:00.000Z"
  },
  "warnings": []
}
```

Body retrieval accepts optional `allowLarge=true`. Without it, files larger than
the note retrieval size limit are rejected.

## MCP Tools

`vault_guidance_list` returns the same inner payload as `GET /agent-guidance`
plus a top-level `warnings` array.

`vault_guidance_get` accepts:

```json
{
  "path": "AGENTS.md",
  "allowLarge": false
}
```

It returns the same inner payload as `GET /agent-guidance/{path}` plus a
top-level `warnings` array.

Both tools are read-only, idempotent, and non-destructive.

## Safety

Guidance discovery must:

- Respect configured vault exclusions.
- Reject or ignore paths outside the vault.
- Include only allowlisted guidance file names and `.cursor/rules/*` files.
- Include hidden files and dot-directories only for the explicit allowlisted
  guidance paths.
- Return vault-relative paths only.
- Avoid returning file bodies from list operations.
- Use explicit retrieval with size limits for file bodies.
