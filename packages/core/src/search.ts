import { IndexStore } from "./index-store.js";
import {
  SearchMode,
  SearchResult,
  SearchResultItem,
  WarningItem,
  MAX_RESULT_LIMIT,
  CHUNK_EMBEDDING_INPUT_CAP,
  SearchFiltersInput,
} from "./schemas.js";
import { Config } from "./config.js";
import { SearchError } from "./errors.js";
import { EmbeddingProvider, EmbeddingProviderError } from "./embedding.js";
import { chunkToResultItem, noteRowToResultItem } from "./result-helpers.js";
import {
  matchesSearchFilters,
  noteMatchesSearchFilters,
  normalizeSearchFilters,
  NormalizedSearchFilters,
} from "./search-filters.js";

const MIN_RESULT_SCORE = 0.000001;
const MIN_EMBEDDING_DISTANCE_SCORE = 0.5;

export async function search(
  store: IndexStore,
  query: string,
  mode: SearchMode | undefined,
  limit: number,
  config: Config,
  embeddingProvider?: EmbeddingProvider,
  filters?: SearchFiltersInput,
): Promise<SearchResult> {
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

  const effectiveLimit = limit;
  const normalizedFilters = normalizeSearchFilters(filters);
  const warnings: WarningItem[] = [];

  const staleness = store.checkStaleness(config);
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

  let usedMode: SearchMode;
  let requestedMode = mode ?? "hybrid";
  const embeddingsAvailable =
    config.embedding.enabled &&
    manifest.embeddingModel !== null &&
    store.isVecAvailable();

  if (!mode) {
    if (embeddingsAvailable) {
      usedMode = "hybrid";
    } else {
      usedMode = "lexical";
      if (config.embedding.enabled) {
        warnings.push({
          code: "EMBEDDING_UNAVAILABLE",
          message:
            "Embeddings are configured but unavailable. Falling back to lexical search.",
        });
      }
    }
  } else if (mode === "embedding") {
    if (!embeddingsAvailable) {
      throw new SearchError(
        "EMBEDDING_UNAVAILABLE",
        "Embeddings are unavailable. Cannot perform embedding-only search.",
      );
    }
    usedMode = "embedding";
  } else if (mode === "hybrid") {
    if (embeddingsAvailable) {
      usedMode = "hybrid";
    } else {
      usedMode = "lexical";
      warnings.push({
        code: "EMBEDDING_UNAVAILABLE",
        message: "Embeddings are unavailable. Falling back to lexical search.",
      });
    }
  } else {
    usedMode = "lexical";
  }

  const allowedNoteIds = normalizedFilters
    ? matchingNoteIds(store, normalizedFilters)
    : undefined;

  if (allowedNoteIds && allowedNoteIds.length === 0) {
    return {
      requestedMode,
      usedMode,
      limit: effectiveLimit,
      results: [],
      warnings,
    };
  }

  if (usedMode === "lexical" || usedMode === "hybrid") {
    const lexicalResults = searchLexical(
      store,
      query,
      effectiveLimit,
      normalizedFilters,
      allowedNoteIds,
    );
    if (usedMode === "lexical") {
      return {
        requestedMode,
        usedMode,
        limit: effectiveLimit,
        results: lexicalResults.slice(0, effectiveLimit),
        warnings,
      };
    }

    if (embeddingsAvailable) {
      let embeddingResults: SearchResultItem[];
      try {
        embeddingResults = await searchEmbedding(
          store,
          query,
          effectiveLimit,
          embeddingProvider,
          normalizedFilters,
          allowedNoteIds,
        );
      } catch (error) {
        if (!(error instanceof EmbeddingProviderError)) throw error;
        warnings.push({
          code: "EMBEDDING_UNAVAILABLE",
          message:
            "Embeddings are unavailable. Falling back to lexical search.",
        });
        return {
          requestedMode,
          usedMode: "lexical",
          limit: effectiveLimit,
          results: lexicalResults.slice(0, effectiveLimit),
          warnings,
        };
      }
      return {
        requestedMode,
        usedMode: "hybrid",
        limit: effectiveLimit,
        results: fuseResults(lexicalResults, embeddingResults, effectiveLimit),
        warnings,
      };
    }

    return {
      requestedMode,
      usedMode,
      limit: effectiveLimit,
      results: lexicalResults.slice(0, effectiveLimit),
      warnings,
    };
  }

  if (usedMode === "embedding") {
    let embeddingResults: SearchResultItem[];
    try {
      embeddingResults = await searchEmbedding(
        store,
        query,
        effectiveLimit,
        embeddingProvider,
        normalizedFilters,
        allowedNoteIds,
      );
    } catch (error) {
      if (!(error instanceof EmbeddingProviderError)) throw error;
      throw new SearchError(
        "EMBEDDING_UNAVAILABLE",
        "Embeddings are unavailable. Cannot perform embedding-only search.",
      );
    }
    return {
      requestedMode,
      usedMode,
      limit: effectiveLimit,
      results: embeddingResults.slice(0, effectiveLimit),
      warnings,
    };
  }

  return {
    requestedMode,
    usedMode,
    limit: effectiveLimit,
    results: [],
    warnings,
  };
}

function searchLexical(
  store: IndexStore,
  query: string,
  limit: number,
  filters?: NormalizedSearchFilters,
  allowedNoteIds?: readonly string[],
): SearchResultItem[] {
  const ftsRows = store.searchLexical(query, limit, allowedNoteIds);
  const trigramRows = store.searchTrigrams(query, limit, allowedNoteIds);

  const ftsScores = new Map<string, number>();
  const allChunkIds = new Set<string>();

  let minFts = Infinity;
  let maxFts = -Infinity;

  for (const row of ftsRows) {
    const chunkId = row.chunk_id as string;
    const rank = Math.abs(row.rank as number);
    ftsScores.set(chunkId, rank);
    allChunkIds.add(chunkId);
    minFts = Math.min(minFts, rank);
    maxFts = Math.max(maxFts, rank);
  }

  const trigramScores = new Map<string, number>();
  for (const row of trigramRows) {
    const chunkId = row.chunk_id as string;
    trigramScores.set(chunkId, row.coverage as number);
    allChunkIds.add(chunkId);
  }

  const ftsRange = maxFts - minFts || 1;

  const combined = new Map<string, number>();

  for (const chunkId of allChunkIds) {
    let ftsNorm = 0;
    const ftsRaw = ftsScores.get(chunkId);
    if (ftsRaw !== undefined) {
      ftsNorm = Math.max(1 - (ftsRaw - minFts) / ftsRange, MIN_RESULT_SCORE);
    }

    let trigramNorm = 0;
    const trigramRaw = trigramScores.get(chunkId);
    if (trigramRaw !== undefined) {
      trigramNorm = trigramRaw;
    }

    const rrfScore = rrf(
      ftsNorm !== 0 ? [ftsNorm] : [],
      trigramNorm !== 0 ? [trigramNorm] : [],
      60,
    );
    combined.set(chunkId, rrfScore);
  }

  const sorted = Array.from(combined.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  const chunkResults = filterResults(
    store,
    sorted.map(([chunkId, score]) =>
      chunkToResultItem(store, chunkId, score, "lexical_match"),
    ),
    filters,
  ).slice(0, limit);

  const noteResults = searchNoteTypeResults(
    store,
    query,
    limit,
    filters,
    allowedNoteIds,
  );
  const chunkNoteIds = new Set(chunkResults.map((r) => r.noteId));
  const filteredNoteResults = noteResults.filter(
    (r) => !chunkNoteIds.has(r.noteId),
  );

  const minChunkScore =
    chunkResults.length > 0 ? Math.min(...chunkResults.map((r) => r.score)) : 1;
  const noteBaseScore = chunkResults.length > 0 ? minChunkScore * 0.5 : 0.5;

  for (let i = 0; i < filteredNoteResults.length; i++) {
    filteredNoteResults[i]!.score = noteBaseScore * (1 - i * 0.05);
  }

  const scoredNoteResults = filteredNoteResults.filter(
    (item) => item.score > 0,
  );

  return [...chunkResults, ...scoredNoteResults].slice(0, limit);
}

async function searchEmbedding(
  store: IndexStore,
  query: string,
  limit: number,
  embeddingProvider?: EmbeddingProvider,
  filters?: NormalizedSearchFilters,
  allowedNoteIds?: readonly string[],
): Promise<SearchResultItem[]> {
  if (!embeddingProvider) return [];

  const queryText = query.slice(0, CHUNK_EMBEDDING_INPUT_CAP);
  const response = await embeddingProvider.embed([queryText]);
  const queryEmbedding = response.embeddings[0];
  if (!queryEmbedding) return [];

  const vecResults = store.searchEmbeddingVectors(
    queryEmbedding,
    limit * 3,
    allowedNoteIds ? matchingChunkIds(store, allowedNoteIds) : undefined,
  );

  if (vecResults.length === 0) return [];

  return filterResults(
    store,
    vecResults
      .map(({ chunk_id, distance }) => {
        const score = distanceToScore(distance);
        return { chunk_id, score };
      })
      .filter(({ score }) => score >= MIN_EMBEDDING_DISTANCE_SCORE)
      .map(({ chunk_id, score }) =>
        chunkToResultItem(store, chunk_id, score, "embedding_match"),
      ),
    filters,
  ).slice(0, limit);
}

function rrf(leftScores: number[], rightScores: number[], k: number): number {
  let score = 0;
  for (let i = 0; i < leftScores.length; i++) {
    score += 1 / (k + i + 1);
  }
  for (let i = 0; i < rightScores.length; i++) {
    score += 1 / (k + i + 1);
  }
  return score;
}

function fuseResults(
  lexical: SearchResultItem[],
  embedding: SearchResultItem[],
  limit: number,
): SearchResultItem[] {
  const allIds = new Map<string, { lexical?: number; embedding?: number }>();

  for (let i = 0; i < lexical.length; i++) {
    allIds.set(lexical[i]!.id, { lexical: i });
  }
  for (let i = 0; i < embedding.length; i++) {
    const entry = allIds.get(embedding[i]!.id) ?? {};
    entry.embedding = i;
    allIds.set(embedding[i]!.id, entry);
  }

  const k = 60;
  const scores = new Map<string, number>();
  for (const [id, ranks] of allIds) {
    let score = 0;
    if (ranks.lexical !== undefined) score += 1 / (k + ranks.lexical + 1);
    if (ranks.embedding !== undefined) score += 1 / (k + ranks.embedding + 1);
    scores.set(id, score);
  }

  const sorted = Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  const resultMap = new Map<string, SearchResultItem>();
  for (const item of [...lexical, ...embedding]) {
    resultMap.set(item.id, item);
  }

  return sorted
    .map(([id, score]) => {
      const normalizedScore = normalizeScore(score, sorted);
      return { id, score: normalizedScore };
    })
    .filter(({ score }) => score > 0)
    .map(({ id, score }) => {
      const existing = resultMap.get(id);
      if (existing) {
        return {
          ...existing,
          score,
          reason: "hybrid_match",
        };
      }
      return {
        id,
        type: "chunk" as const,
        noteId: id.split(":")[0] ?? id,
        chunkIndex: parseInt(id.split(":")[1] ?? "0"),
        path: "",
        title: null,
        heading: null,
        headingPath: [],
        snippet: "",
        score,
        reason: "hybrid_match",
        metadata: {
          aliases: [],
          tags: [],
          date: null,
          created: null,
          updated: null,
          attachmentCount: 0,
        },
      };
    });
}

function normalizeScore(
  rawScore: number,
  allScores: Array<[string, number]>,
): number {
  if (allScores.length <= 1) return rawScore > 0 ? 1 : 0;
  const maxScore = allScores[0]![1];
  const minScore = allScores[allScores.length - 1]![1];
  const range = maxScore - minScore || 1;
  return Math.max((rawScore - minScore) / range, MIN_RESULT_SCORE);
}

function distanceToScore(distance: number): number {
  if (!Number.isFinite(distance) || distance < 0) return 0;
  return 1 / (1 + distance);
}

function searchNoteTypeResults(
  store: IndexStore,
  query: string,
  limit: number,
  filters?: NormalizedSearchFilters,
  allowedNoteIds?: readonly string[],
): SearchResultItem[] {
  const noteRows = store.searchNotes(query, limit, allowedNoteIds);
  return noteRows
    .map((row) => noteRowToResultItem(row, "lexical_match"))
    .filter((item) =>
      matchesSearchFilters(item, store.getNote(item.noteId), filters),
    );
}

function filterResults(
  store: IndexStore,
  results: SearchResultItem[],
  filters?: NormalizedSearchFilters,
): SearchResultItem[] {
  if (!filters) return results;
  return results.filter((item) =>
    matchesSearchFilters(item, store.getNote(item.noteId), filters),
  );
}

function matchingNoteIds(
  store: IndexStore,
  filters?: NormalizedSearchFilters,
): string[] {
  if (!filters) return [];
  return store
    .getAllNotes()
    .filter((note) => noteMatchesSearchFilters(note, filters))
    .map((note) => note.note_id as string);
}

function matchingChunkIds(
  store: IndexStore,
  noteIds: readonly string[],
): string[] {
  return noteIds.flatMap((noteId) =>
    store.getChunks(noteId).map((chunk) => chunk.chunk_id as string),
  );
}
