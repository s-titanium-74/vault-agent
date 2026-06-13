# Phase 1 Retrieval Specification

Status: Draft

This file is part of the Phase 1 specification. See ../requirements.md for requirements and this directory for the domain specifications.

## Search And Related Limits

Default result limit: 10.

Maximum result limit: 50.

Requests with limits above the maximum are rejected with a validation error rather than silently clamped.

## Snippets

Search and related snippets have a maximum length of 240 characters.

When possible, snippets should be selected around lexical matches or the most relevant text span. If no focused span is available, use the beginning of the matched chunk text.

Snippets are not independently retrievable and must not equal a full chunk. If a matched chunk is short enough that any useful excerpt would return the whole chunk, the snippet should be an empty string and the result should rely on title, path, heading, score, and reason.

## Ranking

Lexical search uses SQLite FTS5 ranking.

Lexical search also uses a supplemental trigram candidate index to improve matching for non-whitespace languages. FTS5 and trigram candidate lists are fused before or during lexical ranking.

The trigram index uses the same source text as lexical index text: title, aliases, tags, heading path, and chunk text.

Trigram indexing is chunk-level and stores gram-to-chunk mappings.

The default gram size is 3. For 2-character queries, the implementation may use bigram fallback. Queries shorter than 2 characters do not use trigram or bigram candidate matching.

Trigram candidate ranking uses query gram coverage, such as matched query grams divided by total query grams, rather than raw matched gram count. Trigram candidates are fused with FTS5 candidates using RRF.

Embedding search uses `sqlite-vec` nearest-neighbor results.

Hybrid search uses Reciprocal Rank Fusion to merge lexical and embedding result lists. Hybrid ranking must not directly add raw BM25 scores and raw vector distances.

Default RRF constant: 60.

Hybrid search should retrieve more candidates internally than the requested result limit from each source, then fuse and truncate to the requested limit. The internal candidate multiplier is an implementation detail, but it must not cause result responses to exceed the requested limit.

For `related`, resolved direct wikilinks may be added as a weak supplemental ranking signal. The link signal should be represented as another ranked candidate list and fused with the primary retrieval mode using RRF.

## Search Result Unit

Search and related results are chunk-primary in Phase 1.

Each result represents a chunk by default and includes note-level metadata such as `noteId`, vault-relative `path`, title, and compact allowlisted frontmatter metadata.

Notes without searchable chunks, such as empty or oversized notes, may appear as note-type results when title, path, or compact indexed metadata matches. Note-type results do not include body content and use an empty snippet.

Note body retrieval remains explicit through note retrieval endpoints and CLI commands.

## Search API

`POST /search` request body:

```json
{
  "query": "search text",
  "mode": "hybrid",
  "limit": 10
}
```

Fields:

- `query`: required non-empty string.
- `mode`: optional search mode. Allowed values are `lexical`, `embedding`, and `hybrid`.
- `limit`: optional integer from 1 to 50. Default is 10.

Maximum query length: 1,000 characters.

Empty or whitespace-only queries are invalid and return `400` with `INVALID_QUERY`.

If `mode` is omitted, the server chooses the default mode based on embedding availability.

Phase 1 does not include structured search filters such as path prefix or tag filters.

If embeddings are configured but unavailable and `mode` is omitted, search falls back to lexical with an `EMBEDDING_UNAVAILABLE` warning.

If `mode` is explicitly `hybrid` and embeddings are unavailable, search falls back to lexical with an `EMBEDDING_UNAVAILABLE` warning.

If `mode` is explicitly `embedding` and embeddings are unavailable, search fails with `503` and `EMBEDDING_UNAVAILABLE`.

## Related API

`POST /related` request body:

```json
{
  "type": "chunk",
  "id": "note-id:0",
  "mode": "embedding",
  "limit": 10
}
```

Fields:

- `type`: required input type. Allowed values are `note` and `chunk`.
- `id`: required note ID or chunk ID matching `type`.
- `mode`: optional retrieval mode. Allowed values are `lexical`, `embedding`, and `hybrid`.
- `limit`: optional integer from 1 to 50. Default is 10.

If `mode` is omitted, related defaults to embedding when embeddings are configured and available. If embeddings are not configured, related defaults to lexical without a warning. If embeddings are configured but unavailable, related falls back to lexical with an `EMBEDDING_UNAVAILABLE` warning.

Resolved links may be used as a supplemental related signal regardless of the requested related mode. The requested mode describes the primary retrieval signal.

Related input handling:

- For note input, related uses the note's chunks, compact metadata, and resolved note links as the source context.
- For chunk input, related uses that chunk's text, embedding, compact metadata, and resolved links from that chunk as the source context.
- For note input, all chunks from the input note are excluded from results.
- For chunk input, the input chunk is excluded from results.
- Resolved linked notes are returned as chunk-primary results using the linked note's first chunk as the representative result.
- Unresolved links are not used for ranking but may remain in explicit retrieval metadata.

For lexical related on a note input, the implementation builds an internal query from the note's chunk text and compact metadata. Related internal query text is capped at 4,000 characters.

Related result `reason` values include `related_embedding`, `related_lexical`, `related_link`, and `related_hybrid`.

If related defaults from embedding to lexical because embeddings are unavailable, the response includes an `EMBEDDING_UNAVAILABLE` warning.

Missing related input notes return `404` with `NOTE_NOT_FOUND`. Missing related input chunks return `404` with `CHUNK_NOT_FOUND`.

## Search And Related Response Shape

`POST /search` successful response data:

```json
{
  "requestedMode": "hybrid",
  "usedMode": "hybrid",
  "limit": 10,
  "results": []
}
```

`POST /related` successful response data:

```json
{
  "input": {
    "type": "chunk",
    "id": "note-id:0"
  },
  "requestedMode": "embedding",
  "usedMode": "embedding",
  "limit": 10,
  "results": []
}
```

Warnings are returned in the top-level response envelope.

Result item shape:

```json
{
  "id": "note-id:0",
  "type": "chunk",
  "noteId": "note-id",
  "chunkIndex": 0,
  "path": "Folder/Note.md",
  "title": "Note title",
  "heading": "Heading",
  "headingPath": ["Parent", "Heading"],
  "snippet": "Short snippet...",
  "score": 0.123,
  "reason": "hybrid_match",
  "metadata": {
    "aliases": [],
    "tags": [],
    "date": null,
    "created": null,
    "updated": null,
    "attachmentCount": 0
  }
}
```

Result items must not include full note bodies or full chunk bodies.

For note-type results, `id` is the note ID, `type` is `note`, `chunkIndex` is `null`, `heading` is `null`, and `headingPath` is an empty array.

`score` is a normalized display score from 0 to 1, where higher is better.

Raw BM25 scores, vector distances, and RRF internals are not included in Phase 1 responses.

`reason` uses stable string values, such as `lexical_match`, `embedding_match`, and `hybrid_match`.

## Note Retrieval API

`GET /notes/{noteId}` returns the original Markdown note content, including YAML frontmatter when present.

The HTTP response is JSON. The `contentType` field for note content is `text/markdown; charset=utf-8`.

Optional query parameters:

- `allowLarge=true`

Successful response data:

```json
{
  "id": "note-id",
  "path": "Folder/Note.md",
  "title": "Note title",
  "metadata": {
    "aliases": [],
    "tags": [],
    "date": null,
    "created": null,
    "updated": null
  },
  "content": "---\ntitle: Note title\n---\n\nMarkdown content",
  "contentType": "text/markdown; charset=utf-8",
  "size": 1234
}
```

Parsed arbitrary frontmatter fields are not returned separately.

Note retrieval may include compact link and attachment summaries:

```json
{
  "links": {
    "resolved": [],
    "unresolved": []
  },
  "attachments": []
}
```

## Chunk Retrieval API

`GET /chunks/{noteId}/{chunkIndex}` returns only the requested chunk content.

The HTTP response is JSON. The `contentType` field for chunk content is `text/markdown; charset=utf-8`.

Successful response data:

```json
{
  "id": "note-id:0",
  "noteId": "note-id",
  "chunkIndex": 0,
  "path": "Folder/Note.md",
  "title": "Note title",
  "heading": "Heading",
  "headingPath": ["Parent", "Heading"],
  "metadata": {
    "aliases": [],
    "tags": [],
    "date": null,
    "created": null,
    "updated": null
  },
  "content": "Chunk Markdown content",
  "contentType": "text/markdown; charset=utf-8",
  "size": 1234
}
```

Chunk content does not include YAML frontmatter unless the frontmatter text is part of the chunk, which Phase 1 chunking should avoid.

Chunk retrieval may include compact link and attachment summaries for references contained in that chunk.

## Explicit Retrieval Size Limits

Default note retrieval size limit: 200 KiB.

Default attachment download size limit: 10 MiB.

If a note exceeds the note retrieval limit, note retrieval fails unless the request includes the explicit large-content allow option.

If an attachment exceeds the attachment download limit, byte download fails unless the request includes the explicit large-content allow option.

Attachment metadata retrieval is not subject to the attachment byte download size limit because it does not return file contents.

The HTTP query parameter for large-content retrieval is `allowLarge=true`.

The CLI option is `--allow-large`.

## Attachment Retrieval

Attachment metadata retrieval:

```text
GET /attachments/{*vaultRelativePath}
```

Attachment byte download:

```text
GET /attachments/{*vaultRelativePath}?download=true
```

By default, attachment retrieval returns metadata only.

When `download=true`, the server returns file bytes if the attachment is within the configured size limit or `allowLarge=true` is set.

Attachment retrieval must apply the same vault-root path safety checks as note retrieval.

Attachment routes use a wildcard path segment so attachments may live in nested vault subdirectories. The server URL-decodes the wildcard path as UTF-8, treats it as a vault-relative path, and rejects it if normalization or realpath resolution would leave the configured vault root.

Attachment retrieval is allowed only for regular files that are not indexed Markdown notes and are not excluded by default or user-configured vault exclude patterns. Paths with `.md` or `.markdown` extensions must be retrieved through note APIs rather than attachment APIs. Hidden files and directories, `.git/`, `.obsidian/`, `node_modules/`, generated-data directories, and user-excluded paths are not retrievable as attachments.

Attachment paths that resolve to disallowed files return `403` with `ATTACHMENT_NOT_ALLOWED`. Missing allowed attachment paths return `404` with `ATTACHMENT_NOT_FOUND`.

Phase 1 uses the `mime-types` package for attachment `Content-Type` detection.

Unknown attachment content types use `application/octet-stream`.

Attachment metadata response data:

```json
{
  "path": "attachments/file.pdf",
  "fileName": "file.pdf",
  "contentType": "application/pdf",
  "size": 12345,
  "downloadAvailable": true
}
```

Phase 1 attachment metadata does not include file hashes or filesystem timestamps.

Successful attachment byte downloads return raw file bytes with the detected `Content-Type`. They do not use the JSON response envelope.

Attachment byte downloads should include `Content-Disposition: attachment` with the attachment filename where practical.

Attachment download errors still use the standard JSON error envelope.
