import type { IndexManifest } from "../types.js";
import type { NormalizedSearchFilters } from "../search-filters.js";

export type IndexRow = Record<string, unknown>;
/** Already loaded, bounded inputs for deterministic metadata aggregation. */
export interface AggregateIndexView {
  getManifest(): IndexManifest | null;
  getAllNotes(): IndexRow[];
  getAllChunkIds(): string[];
  getChunkById(id: string): IndexRow | null;
}
export interface PageRequest {
  limit: number;
  cursor?: string;
  signal?: AbortSignal;
}
export interface Page<T> {
  items: T[];
  cursor?: string;
}
export type SourceKind = "note" | "attachment" | "guidance";
export interface SourceEntry {
  path: string;
  kind: SourceKind;
  size: number;
  revision: string;
  updated: string;
}
export interface SourceReadOptions {
  expectedRevision: string;
  maxBytes: number;
  signal?: AbortSignal;
}
/** One allowed vault, fixed at construction. Reads never change source data. */
export interface VaultSource {
  readonly vaultId: string;
  list(request: PageRequest): Promise<Page<SourceEntry>>;
  stat(path: string, signal?: AbortSignal): Promise<SourceEntry | null>;
  readText(path: string, options: SourceReadOptions): Promise<string>;
  readBytes(
    path: string,
    options: SourceReadOptions,
  ): Promise<ReadableStream<Uint8Array>>;
}
/** One committed index view. Candidate limits are hard upper bounds. */
export interface MetadataLexicalStore {
  readonly vaultId: string;
  getManifest(): Promise<IndexManifest | null>;
  getNote(id: string): Promise<IndexRow | null>;
  getChunk(noteId: string, index: number): Promise<IndexRow | null>;
  getChunkById(id: string): Promise<IndexRow | null>;
  getChunks(noteId: string, request: PageRequest): Promise<Page<IndexRow>>;
  hasMatchingNotes(filters: NormalizedSearchFilters): Promise<boolean>;
  listNotes(request: PageRequest): Promise<Page<IndexRow>>;
  searchLexical(
    query: string,
    limit: number,
    filters?: NormalizedSearchFilters,
  ): Promise<IndexRow[]>;
  searchTrigrams(
    query: string,
    limit: number,
    filters?: NormalizedSearchFilters,
  ): Promise<IndexRow[]>;
  searchNotes(
    query: string,
    limit: number,
    filters?: NormalizedSearchFilters,
  ): Promise<IndexRow[]>;
}
export interface VectorMatch {
  chunk_id: string;
  distance: number;
}
export interface VectorEntry {
  chunkId: string;
  values: Float32Array;
  contentHash: string;
}
export interface VectorMutation {
  id: string | null;
  state: "pending" | "complete" | "failed";
}
export interface VectorStore {
  readonly vaultId: string;
  available(): Promise<boolean>;
  query(
    vector: Float32Array,
    limit: number,
    filters?: NormalizedSearchFilters,
  ): Promise<VectorMatch[]>;
  upsert(entries: readonly VectorEntry[]): Promise<VectorMutation>;
  delete(chunkIds: readonly string[]): Promise<VectorMutation>;
  mutationStatus(mutation: VectorMutation): Promise<VectorMutation["state"]>;
  /** Backend-specific conversion; never reuse sqlite-vec thresholds implicitly. */
  score(distance: number): number;
  readonly minimumScore: number;
}
export interface EmbeddingDescriptor {
  provider: string;
  model: string;
  modelRevision: string | null;
  metric: "l2" | "cosine" | "dot" | null;
  normalization: "none" | "unit" | null;
  maxInputTokens: number | null;
  dimension: number | null;
  inputFormat: string;
  maxBatchSize: number;
  maxInputCharacters: number;
}
export interface EmbeddingResponse {
  embeddings: Float32Array[];
  model: string;
  dimension: number;
}
export interface EmbeddingProviderContract {
  describe(): EmbeddingDescriptor;
  embed(
    texts: string[],
    options?: { signal?: AbortSignal },
  ): Promise<EmbeddingResponse>;
}
export interface IndexCompatibility {
  stale: boolean;
  incompatible: boolean;
  details: string;
}
export interface RetrievalContext {
  metadata: MetadataLexicalStore;
  vectors: VectorStore;
  embeddingEnabled: boolean;
  embeddingProvider?: EmbeddingProviderContract;
  compatibility: IndexCompatibility;
}
