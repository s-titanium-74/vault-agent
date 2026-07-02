# Phase 3.1 Orientation Specification

Status: Draft

This file is part of the Phase 3.1 specification. See ../requirements.md for requirements and this directory for the domain specifications.

## Data Model

Orientation surfaces read from the existing Phase 1 index tables. Phase 3.1 does not add new index tables or orientation-specific caches.

Required indexed data:

- Note records (id, vault-relative path, title metadata).
- Chunk records (chunk index per note).
- Note-level frontmatter metadata (title, aliases, tags, type, status, date, created, updated).
- Index manifest (schema version, vault identity, freshness state from Phase 2).

## Orientation Core Functions

Orientation logic lives in `packages/core/src` and exposes functions used by server route handlers and the MCP adapter.

Functions:

- `getOverview(ctx): OverviewResult`
- `getTree(ctx, params): TreeResult`
- `getTags(ctx, params): TagsResult`
- `getFacets(ctx, params): FacetsResult`

All functions accept a core context `ctx` containing the index connection, vault root, and configuration.

All functions return a data payload object. The caller (server route handler or MCP adapter) combines the data payload with the separately-returned warnings array into the Phase 1 response envelope:

```json
{
  "data": { data payload },
  "warnings": [ warnings ]
}
```

The data payload must not contain a `warnings` field. Core functions return warnings separately so that the server/MCP adapter can place them at the envelope level only.

### Function: getOverview

Parameters: none.

Behavior:

1. Read total note count from the note table.
2. Read total chunk count from the chunk table.
3. Build top-level folder list:
   - Collect distinct first path segments from all indexed note vault-relative paths.
   - Count notes recursively within each top-level folder.
   - Sort by `noteCount` descending, then by `path` ascending.
   - Truncate to limit 20. Emit `TOP_LEVEL_FOLDERS_TRUNCATED` warning if truncated.
   - Notes placed directly in the vault root have no first path segment and are excluded from `topLevelFolders`, but are included in the total `noteCount`.
4. Build top tags list:
   - Aggregate note-level tag counts from frontmatter `tags`.
   - Sort by `noteCount` descending, then by `tag` ascending.
   - Truncate to limit 50. Emit `TOP_TAGS_TRUNCATED` warning if truncated.
5. Build frontmatter field list:
   - Aggregate note counts per frontmatter field name.
   - Sort by `noteCount` descending, then by `name` ascending.
   - Truncate to limit 50. Emit `FRONTMATTER_FIELDS_TRUNCATED` warning if truncated.
6. Read current freshness state. If not `fresh`, add a freshness warning.
7. Return the data payload and the warnings array separately to the caller.

Return shape:

```json
{
  "noteCount": 1240,
  "chunkCount": 3920,
  "topLevelFolders": [
    { "path": "Projects", "noteCount": 320 },
    { "path": "Areas", "noteCount": 180 }
  ],
  "topTags": [
    { "tag": "meeting", "noteCount": 84 },
    { "tag": "idea", "noteCount": 62 }
  ],
  "frontmatterFields": [
    { "name": "type", "noteCount": 400 },
    { "name": "status", "noteCount": 130 }
  ],
  "indexFreshness": "fresh"
}
```

Warnings are returned separately to the caller.

### Function: getTree

Parameters:

- `depth`: integer, 1–10. Default: 2.
- `limit`: integer, 1–500. Default: 50.
- `directOnly`: boolean. Default: false.

Behavior:

1. Build a folder tree from indexed note vault-relative paths.
2. For each folder node, compute:
   - `noteCount`: recursive note count by default; direct-only count when `directOnly` is true.
   - `childFolders`: number of immediate child folders.
   - `children`: child folder nodes, sorted alphabetically by `path`.
3. Exclude directories matching Phase 1 default exclusions and user-configured exclusions.
4. Bound output by `depth` and `limit`:
   - The root node counts toward `limit`.
   - Use breadth-first traversal to select nodes up to `limit`.
   - Within each depth level, keep nodes in alphabetical order by `path`.
   - When nodes are omitted due to `limit`, emit `TREE_LIMIT_EXCEEDED` warning.
5. Include current freshness state.
6. Return the data payload and the warnings array separately to the caller.

Root representation:

- The tree starts at the vault root, represented as `path: ""` (empty string).
- The root node's `children` are top-level folders.
- The root node itself is included in the returned tree data payload.
- When `limit=1`, the response contains only the root node with empty `children`.

Return shape:

```json
{
  "tree": {
    "path": "",
    "noteCount": 1240,
    "childFolders": 5,
    "children": [
      {
        "path": "Projects",
        "noteCount": 320,
        "childFolders": 3,
        "children": []
      }
    ]
  },
  "indexFreshness": "fresh"
}
```

Warnings are returned separately to the caller.

### Function: getTags

Parameters:

- `limit`: integer, 1–200. Default: 50.

Behavior:

1. Aggregate note-level tag counts from frontmatter `tags` field values.
2. Normalize tags per Phase 1 rules: strip leading `#`, store as string, ignore malformed tag values.
3. Sort by `noteCount` descending, then by `tag` ascending.
4. Truncate to `limit`. Do not emit a truncation warning when truncated (limit is explicit).
5. Include freshness state and any warnings in the separately-returned warnings array.

Return shape:

```json
{
  "tags": [
    { "tag": "meeting", "noteCount": 84 },
    { "tag": "idea", "noteCount": 62 }
  ],
  "indexFreshness": "fresh"
}
```

Warnings are returned separately to the caller.

### Function: getFacets

Parameters:

- `limit`: integer, 1–200. Default: 50.

Behavior:

1. Aggregate note counts per frontmatter field name.
2. For allowlisted fields (`type`, `status`), compute value counts.
3. Apply normalization rules:
   - Array values: expand each element as a separate value; the same note can contribute to multiple value counts.
   - Strings: case-sensitive.
   - Numbers and booleans: coerce to strings.
   - Null and empty strings: excluded.
4. Sort fields by `noteCount` descending, then by `name` ascending.
5. Sort values within each allowlisted field by `noteCount` descending, then by `value` ascending.
6. Truncate fields to `limit`. Do not emit truncation warning when truncated.
7. Include freshness state and any warnings in the separately-returned warnings array.

Return shape:

```json
{
  "fields": [
    {
      "name": "type",
      "noteCount": 400,
      "values": [
        { "value": "project", "noteCount": 250 },
        { "value": "area", "noteCount": 150 }
      ]
    },
    {
      "name": "status",
      "noteCount": 130,
      "values": [
        { "value": "active", "noteCount": 80 },
        { "value": "draft", "noteCount": 50 }
      ]
    },
    {
      "name": "priority",
      "noteCount": 90
    }
  ],
  "indexFreshness": "fresh"
}
```

Warnings are returned separately to the caller.

## Error Handling

Core functions throw typed errors that map to HTTP and MCP error responses.

Error codes:

- `INDEX_NOT_FOUND`: no usable index exists. Maps to HTTP `409`.
- `INDEX_INCOMPATIBLE`: index schema, vault identity, or configuration fingerprint mismatch. Maps to HTTP `409`.

Core functions do not emit `INDEX_NOT_FOUND` for empty vaults. A usable index with zero notes returns valid zero-count responses.

## Snapshot Isolation

Orientation reads use the same database connection rules as Phase 1 search and Phase 2 retrieval. During an active incremental index update, reads must use the last committed snapshot and must not observe partially-written index state.

## Exclusions

Orientation surfaces respect Phase 1 default exclusions and user-configured `[vault].exclude` patterns:

- Hidden files and directories.
- `.obsidian/`
- `.git/`
- `node_modules/`
- Common build, cache, output, and generated-data directories.
- User-configured exclude patterns.

Excluded paths must not appear in tree output or orientation counts.

## Performance Considerations

Orientation aggregates data at request time without caching. For large vaults, implementations should consider:

- Using indexed column counts where available (note count, chunk count).
- Using single-pass aggregation queries for folder, tag, and field counts.
- Avoiding full table scans where practical.

Response time targets are not requirements. As implementation guidance, orientation endpoints should aim to return within 2 seconds for a vault of 5,000 indexed notes on reference hardware. Request-time aggregation without caching is a known risk for very large vaults; implementers should optimize aggregation queries accordingly.

## Logging

Orientation functions must follow Phase 1 logging policy:

- Allowed log fields: event type, status code, duration, result count, freshness state, warning/error code.
- Do not log: full notes, full chunks, snippets, raw queries, request bodies, frontmatter values, private absolute paths.
