import { IndexStore } from "./index-store.js";
import {
  SearchMode,
  RelatedResult,
  SearchResultItem,
  WarningItem,
  MAX_RESULT_LIMIT,
  CHUNK_EMBEDDING_INPUT_CAP,
} from "./schemas.js";
import { Config } from "./config.js";
import { isValidNoteId, parseChunkId } from "./identifiers.js";
import { SearchError } from "./errors.js";
import { EmbeddingProvider } from "./embedding.js";
import {
  chunkToResultItem,
} from "./result-helpers.js";

export async function getRelated(
  store: IndexStore,
  type: "note" | "chunk",
  id: string,
  mode: SearchMode | undefined,
  limit: number,
  config: Config,
  embeddingProvider?: EmbeddingProvider,
): Promise<RelatedResult> {
  const manifest = store.getManifest();
  if (!manifest) {
    throw new SearchError(
      "INDEX_NOT_FOUND",
      "No usable index exists. Run vault-agent index or restart the server to run first-start bootstrap.",
    );
  }

  if (limit < 1 || limit > MAX_RESULT_LIMIT) {
    throw new SearchError(
      "INVALID_LIMIT",
      `Result limit must be between 1 and ${MAX_RESULT_LIMIT}.`,
    );
  }

  const warnings: WarningItem[] = [];
  const effectiveLimit = limit;

  const staleness = store.checkStaleness(config);
  if (staleness.incompatible) {
    throw new SearchError("INDEX_INCOMPATIBLE", staleness.details);
  }
  if (staleness.stale) {
    warnings.push({
      code: "INDEX_STALE",
      message: staleness.details,
    });
  }

  const embeddingsAvailable =
    config.embedding.enabled &&
    manifest.embeddingModel !== null &&
    store.isVecAvailable();

  let requestedMode = mode ?? "embedding";
  let usedMode: SearchMode = "lexical";

  if (type === "note" && !isValidNoteId(id)) {
    throw new SearchError("INVALID_ID", "Invalid note ID format.");
  }

  if (type === "chunk") {
    const parsed = parseChunkId(id);
    if (!parsed) {
      throw new SearchError("INVALID_ID", "Invalid chunk ID format.");
    }
  }

  const noteId = type === "note" ? id : id.split(":")[0]!;
  const note = store.getNote(noteId);

  if (!note) {
    if (type === "note") {
      throw new SearchError("NOTE_NOT_FOUND", `Note not found: ${id}`);
    } else {
      throw new SearchError("CHUNK_NOT_FOUND", `Chunk not found: ${id}`);
    }
  }

  if (type === "chunk") {
    const parsed = parseChunkId(id);
    if (parsed) {
      const chunk = store.getChunk(parsed.noteId, parsed.chunkIndex);
      if (!chunk) {
        throw new SearchError("CHUNK_NOT_FOUND", `Chunk not found: ${id}`);
      }
    }
  }

  if (!mode) {
    if (embeddingsAvailable) {
      usedMode = "embedding";
    } else if (config.embedding.enabled) {
      usedMode = "lexical";
      warnings.push({
        code: "EMBEDDING_UNAVAILABLE",
        message:
          "Embeddings are configured but unavailable. Falling back to lexical retrieval.",
      });
    } else {
      usedMode = "lexical";
    }
  } else if (mode === "embedding" && !embeddingsAvailable) {
    throw new SearchError(
      "EMBEDDING_UNAVAILABLE",
      "Embeddings are unavailable. Cannot perform embedding-only retrieval.",
    );
  } else {
    usedMode = mode;
    if (mode === "hybrid" && !embeddingsAvailable) {
      usedMode = "lexical";
      warnings.push({
        code: "EMBEDDING_UNAVAILABLE",
        message:
          "Embeddings are unavailable. Falling back to lexical retrieval.",
      });
    }
  }

  const chunks = store.getChunks(noteId);
  let queryText = "";

  if (type === "chunk") {
    const parsed = parseChunkId(id);
    if (parsed) {
      const chunk = store.getChunk(parsed.noteId, parsed.chunkIndex);
      if (chunk) {
        queryText =
          (chunk.embedding_input_text as string) ??
          (chunk.content as string) ??
          "";
      }
    }
  } else {
    for (const chunk of chunks) {
      queryText += (chunk.embedding_input_text as string) ?? "";
      queryText += " ";
    }
  }

  queryText = queryText.trim().slice(0, 4000);

  if (!queryText) {
    return {
      input: { type, id },
      requestedMode,
      usedMode,
      limit: effectiveLimit,
      results: [],
      warnings,
    };
  }

  // Use lexical search for related candidates
  const lexicalResults = store.searchLexical(queryText, effectiveLimit * 3);
  const trigramResults = store.searchTrigrams(queryText, effectiveLimit * 3);

  // Convert to result items and filter excluded
  const items: SearchResultItem[] = [];

  const seenIds = new Set<string>();
  for (const row of lexicalResults) {
    const chunkId = row.chunk_id as string;
    if (seenIds.has(chunkId)) continue;
    seenIds.add(chunkId);
    const isExcluded =
      type === "note" ? chunkId.startsWith(noteId + ":") : chunkId === id;
    if (isExcluded) continue;
    items.push(rowToResultItem(store, chunkId, row, "related_lexical"));
  }

  for (const row of trigramResults) {
    const chunkId = row.chunk_id as string;
    if (seenIds.has(chunkId)) continue;
    seenIds.add(chunkId);
    const isExcluded =
      type === "note" ? chunkId.startsWith(noteId + ":") : chunkId === id;
    if (isExcluded) continue;
    items.push(rowToResultItem(store, chunkId, row, "related_lexical"));
  }

  // Embedding/vector search when available
  if (
    (usedMode === "embedding" || usedMode === "hybrid") &&
    embeddingsAvailable &&
    embeddingProvider
  ) {
    try {
      const embedText = queryText.slice(0, CHUNK_EMBEDDING_INPUT_CAP);
      const response = await embeddingProvider.embed([embedText]);
      const queryEmbedding = response.embeddings[0];
      if (queryEmbedding) {
        const vecResults = store.searchEmbeddingVectors(
          queryEmbedding,
          effectiveLimit * 3,
        );
        for (const { chunk_id, distance } of vecResults) {
          if (seenIds.has(chunk_id)) continue;
          const isExcluded =
            type === "note"
              ? chunk_id.startsWith(noteId + ":")
              : chunk_id === id;
          if (isExcluded) continue;
          seenIds.add(chunk_id);
          items.push(
            chunkIdToResultItem(store, chunk_id, distance, "related_embedding"),
          );
        }
      }
    } catch {
      // Embedding search failed, continue with lexical only
    }
  }

  // Add link-based related items
  const linksJson = note.links_json as string | null;
  if (linksJson) {
    try {
      const links = JSON.parse(linksJson);
      for (const link of links) {
        if (link.resolved) {
          const linkedChunks = store.getChunks(link.resolved);
          if (linkedChunks.length > 0) {
            const firstChunk = linkedChunks[0]!;
            const chunkId = `${firstChunk.note_id}:${firstChunk.chunk_index}`;
            const isLinkExcluded =
              type === "note"
                ? chunkId.startsWith(noteId + ":")
                : chunkId === id;
            if (!seenIds.has(chunkId) && !isLinkExcluded) {
              seenIds.add(chunkId);
              items.push(
                rowToResultItem(store, chunkId, firstChunk, "related_link"),
              );
            }
          }
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  items.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  return {
    input: { type, id },
    requestedMode,
    usedMode,
    limit: effectiveLimit,
    results: items.slice(0, effectiveLimit),
    warnings,
  };
}

function rowToResultItem(
  store: IndexStore,
  chunkId: string,
  row: Record<string, unknown>,
  reason: string,
): SearchResultItem {
  return chunkToResultItem(store, chunkId, 0.5, reason);
}

function chunkIdToResultItem(
  store: IndexStore,
  chunkId: string,
  distance: number,
  reason: string,
): SearchResultItem {
  const item = chunkToResultItem(store, chunkId, 1 - distance, reason);
  if (item.score === 0) item.score = 1 - distance;
  return item;
}
