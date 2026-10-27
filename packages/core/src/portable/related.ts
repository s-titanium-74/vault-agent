import type {
  MetadataLexicalStore,
  RetrievalContext,
  VectorStore,
} from "./contracts.js";
import {
  SearchMode,
  RelatedResult,
  SearchResultItem,
  WarningItem,
  MAX_RESULT_LIMIT,
  CHUNK_EMBEDDING_INPUT_CAP,
} from "../schemas.js";
import { isValidNoteId, parseChunkId } from "./id-validation.js";
import { SearchError } from "../errors.js";
import { EmbeddingProviderError } from "./embedding.js";
import { chunkToResultItem } from "./results.js";

export async function getRelated(
  context: RetrievalContext,
  type: "note" | "chunk",
  id: string,
  mode: SearchMode | undefined,
  limit: number,
): Promise<RelatedResult> {
  const { metadata: store, vectors, embeddingProvider } = context;
  if (store.vaultId !== vectors.vaultId)
    throw new SearchError(
      "INDEX_VAULT_IDENTITY_CHANGED",
      "Index adapters belong to different vaults.",
    );
  const manifest = await store.getManifest();
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

  const staleness = context.compatibility;
  if (staleness.incompatible) {
    const reasons = staleness.details;
    let code = "INDEX_INCOMPATIBLE";
    if (reasons.includes("Schema version")) {
      code = "INDEX_SCHEMA_INCOMPATIBLE";
    } else if (reasons.includes("Vault identity")) {
      code = "INDEX_VAULT_IDENTITY_CHANGED";
    } else if (reasons.includes("Exclude patterns")) {
      code = "INDEX_EXCLUDES_CHANGED";
    } else if (
      reasons.includes("chunk size") ||
      reasons.includes("Max chunk size")
    ) {
      code = "INDEX_CHUNKING_CHANGED";
    } else if (reasons.includes("Embedding model")) {
      code = "INDEX_EMBEDDINGS_STALE";
    } else if (reasons.includes("Embedding dimension")) {
      code = "INDEX_EMBEDDING_DIMENSION_MISMATCH";
    }
    throw new SearchError(code, reasons);
  }
  if (staleness.stale) {
    warnings.push({
      code: "INDEX_STALE",
      message: staleness.details,
    });
  }

  const embeddingsAvailable =
    context.embeddingEnabled &&
    manifest.embeddingModel !== null &&
    (await vectors.available());

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
  const note = await store.getNote(noteId);

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
      const chunk = await store.getChunk(parsed.noteId, parsed.chunkIndex);
      if (!chunk) {
        throw new SearchError("CHUNK_NOT_FOUND", `Chunk not found: ${id}`);
      }
    }
  }

  if (!mode) {
    if (embeddingsAvailable) {
      usedMode = "embedding";
    } else if (context.embeddingEnabled) {
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

  let queryText = "";

  if (type === "chunk") {
    const parsed = parseChunkId(id);
    if (parsed) {
      const chunk = await store.getChunk(parsed.noteId, parsed.chunkIndex);
      if (chunk) {
        queryText =
          (chunk.embedding_input_text as string) ??
          (chunk.content as string) ??
          "";
      }
    }
  } else {
    let cursor: string | undefined;
    do {
      const page = await store.getChunks(noteId, { limit: 32, cursor });
      for (const chunk of page.items) {
        queryText += ((chunk.embedding_input_text as string) ?? "") + " ";
        if (queryText.trim().length >= 4000) break;
      }
      cursor = page.cursor;
    } while (cursor && queryText.trim().length < 4000);
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
  const lexicalResults = await store.searchLexical(
    queryText,
    effectiveLimit * 9,
  );
  const trigramResults = await store.searchTrigrams(
    queryText,
    effectiveLimit * 9,
  );

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
    const item = await rowToResultItem(store, chunkId, row, "related_lexical");
    if (item) items.push(item);
  }

  for (const row of trigramResults) {
    const chunkId = row.chunk_id as string;
    if (seenIds.has(chunkId)) continue;
    seenIds.add(chunkId);
    const isExcluded =
      type === "note" ? chunkId.startsWith(noteId + ":") : chunkId === id;
    if (isExcluded) continue;
    const item = await rowToResultItem(store, chunkId, row, "related_lexical");
    if (item) items.push(item);
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
        const vecResults = await vectors.query(
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
          const item = await chunkIdToResultItem(
            store,
            chunk_id,
            distance,
            "related_embedding",
            vectors,
          );
          if (!item) continue;
          seenIds.add(chunk_id);
          items.push(item);
        }
      }
    } catch (error) {
      if (!(error instanceof EmbeddingProviderError)) throw error;
      if (mode === "embedding") {
        throw new SearchError(
          "EMBEDDING_UNAVAILABLE",
          "Embeddings are unavailable. Cannot perform embedding-only retrieval.",
        );
      }
      usedMode = "lexical";
      warnings.push({
        code: "EMBEDDING_UNAVAILABLE",
        message:
          "Embeddings are unavailable. Falling back to lexical retrieval.",
      });
    }
  }

  // Add link-based related items
  const linksJson = note.links_json as string | null;
  if (linksJson) {
    try {
      const links = JSON.parse(linksJson);
      for (const link of links) {
        if (link.resolved) {
          const linkedChunks = (
            await store.getChunks(link.resolved, { limit: 1 })
          ).items;
          if (linkedChunks.length > 0) {
            const firstChunk = linkedChunks[0]!;
            const chunkId = `${firstChunk.note_id}:${firstChunk.chunk_index}`;
            const isLinkExcluded =
              type === "note"
                ? chunkId.startsWith(noteId + ":")
                : chunkId === id;
            if (!seenIds.has(chunkId) && !isLinkExcluded) {
              seenIds.add(chunkId);
              const item = await rowToResultItem(
                store,
                chunkId,
                firstChunk,
                "related_link",
              );
              if (item) items.push(item);
            }
          }
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  const relevantItems = items.filter((item) => item.score > 0);
  relevantItems.sort((a, b) => b.score - a.score);

  return {
    input: { type, id },
    requestedMode,
    usedMode,
    limit: effectiveLimit,
    results: relevantItems.slice(0, effectiveLimit),
    warnings,
  };
}

async function rowToResultItem(
  store: MetadataLexicalStore,
  chunkId: string,
  row: Record<string, unknown>,
  reason: string,
): Promise<SearchResultItem | null> {
  return chunkToResultItem(store, chunkId, 0.5, reason);
}

async function chunkIdToResultItem(
  store: MetadataLexicalStore,
  chunkId: string,
  distance: number,
  reason: string,
  vectors: VectorStore,
): Promise<SearchResultItem | null> {
  const score = vectors.score(distance);
  if (score < vectors.minimumScore) return null;
  return chunkToResultItem(store, chunkId, score, reason);
}
