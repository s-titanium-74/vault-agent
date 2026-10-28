import type {
  MetadataLexicalStore,
  RetrievalContext,
  VectorStore,
  EmbeddingProviderContract,
} from "./contracts.js";
import {
  SearchMode,
  SearchResult,
  SearchResultItem,
  WarningItem,
  MAX_RESULT_LIMIT,
  CHUNK_EMBEDDING_INPUT_CAP,
  SearchFiltersInput,
} from "../schemas.js";
import { SearchError } from "../errors.js";
import { EmbeddingProviderError } from "./embedding.js";
import { chunkToResultItem, noteRowToResultItem } from "./results.js";
import {
  matchesSearchFilters,
  normalizeSearchFilters,
  NormalizedSearchFilters,
} from "../search-filters.js";

const MIN_RESULT_SCORE = 0.000001;

export async function search(
  context: RetrievalContext,
  query: string,
  mode: SearchMode | undefined,
  limit: number,
  filters?: SearchFiltersInput,
): Promise<SearchResult> {
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

  const effectiveLimit = limit;
  const normalizedFilters = normalizeSearchFilters(filters);
  const warnings: WarningItem[] = [];

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

  let usedMode: SearchMode;
  let requestedMode = mode ?? "hybrid";
  const embeddingsAvailable =
    mode !== "lexical" &&
    context.embeddingEnabled &&
    manifest.embeddingModel !== null &&
    (await vectors.available());

  if (!mode) {
    if (embeddingsAvailable) {
      usedMode = "hybrid";
    } else {
      usedMode = "lexical";
      if (context.embeddingEnabled) {
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

  if (normalizedFilters && !(await store.hasMatchingNotes(normalizedFilters))) {
    return {
      requestedMode,
      usedMode,
      limit: effectiveLimit,
      results: [],
      warnings,
    };
  }
  if (usedMode === "lexical" || usedMode === "hybrid") {
    const lexicalResults = await searchLexical(
      store,
      query,
      effectiveLimit,
      normalizedFilters,
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
          vectors,
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
        vectors,
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

async function searchLexical(
  store: MetadataLexicalStore,
  query: string,
  limit: number,
  filters?: NormalizedSearchFilters,
): Promise<SearchResultItem[]> {
  const ftsRows = await store.searchLexical(query, limit * 3, filters);
  const trigramRows = await store.searchTrigrams(query, limit * 3, filters);

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

  const chunkResults = (
    await filterResults(
      store,
      await Promise.all(
        sorted.map(([chunkId, score]) =>
          chunkToResultItem(store, chunkId, score, "lexical_match"),
        ),
      ),
      filters,
    )
  ).slice(0, limit);

  const noteResults = await searchNoteTypeResults(store, query, limit, filters);
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
  store: MetadataLexicalStore,
  query: string,
  limit: number,
  embeddingProvider: EmbeddingProviderContract | undefined,
  filters: NormalizedSearchFilters | undefined,
  vectors: VectorStore,
): Promise<SearchResultItem[]> {
  if (!embeddingProvider) return [];

  const queryText = query.slice(0, CHUNK_EMBEDDING_INPUT_CAP);
  const response = await embeddingProvider.embed([queryText]);
  const queryEmbedding = response.embeddings[0];
  if (!queryEmbedding) return [];

  const vecResults = await vectors.query(queryEmbedding, limit * 3, filters);

  if (vecResults.length === 0) return [];

  return (
    await filterResults(
      store,
      await Promise.all(
        vecResults
          .map(({ chunk_id, distance }) => {
            const score = vectors.score(distance);
            return { chunk_id, score };
          })
          .filter(({ score }) => score >= vectors.minimumScore)
          .map(({ chunk_id, score }) =>
            chunkToResultItem(store, chunk_id, score, "embedding_match"),
          ),
      ),
      filters,
    )
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

export function fuseResults(
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

async function searchNoteTypeResults(
  store: MetadataLexicalStore,
  query: string,
  limit: number,
  filters?: NormalizedSearchFilters,
): Promise<SearchResultItem[]> {
  const rows = await store.searchNotes(query, limit, filters);
  return filterResults(
    store,
    rows.map((row) => noteRowToResultItem(row, "lexical_match")),
    filters,
  );
}
async function filterResults(
  store: MetadataLexicalStore,
  results: (SearchResultItem | null)[],
  filters?: NormalizedSearchFilters,
): Promise<SearchResultItem[]> {
  const present = results.filter(
    (item): item is SearchResultItem => item !== null,
  );
  if (!filters) return present;
  const matches = await Promise.all(
    present.map(async (item) =>
      matchesSearchFilters(item, await store.getNote(item.noteId), filters),
    ),
  );
  return present.filter((_, i) => matches[i]);
}
