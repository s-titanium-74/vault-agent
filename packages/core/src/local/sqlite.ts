import type { IndexStore } from "../index-store.js";
import type { Config } from "../config.js";
import type {
  MetadataLexicalStore,
  VectorStore,
  PageRequest,
  RetrievalContext,
  EmbeddingProviderContract,
} from "../portable/contracts.js";
import {
  noteMatchesSearchFilters,
  type NormalizedSearchFilters,
} from "../search-filters.js";
import { pageLimit, SourceError } from "../portable/source-policy.js";

export class SqliteMetadataStore implements MetadataLexicalStore {
  constructor(
    readonly store: IndexStore,
    readonly vaultId: string,
  ) {}
  async getManifest() {
    return this.store.getManifest();
  }
  async getNote(id: string) {
    return this.store.getNote(id);
  }
  async getChunk(id: string, index: number) {
    return this.store.getChunk(id, index);
  }
  async getChunkById(id: string) {
    return this.store.getChunkById(id);
  }
  async getChunks(id: string, request: PageRequest) {
    pageLimit(request.limit);
    request.signal?.throwIfAborted();
    const offset = request.cursor === undefined ? 0 : Number(request.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new SourceError("INVALID_CURSOR");
    const items = this.store.getChunks(id, request.limit + 1, offset);
    const more = items.length > request.limit;
    if (more) items.pop();
    return { items, cursor: more ? String(offset + items.length) : undefined };
  }
  async hasMatchingNotes(filters: NormalizedSearchFilters) {
    return this.matchingIds(filters)!.length > 0;
  }
  async listNotes(request: PageRequest) {
    pageLimit(request.limit);
    request.signal?.throwIfAborted();
    const after = request.cursor ?? "";
    const items = this.store
      .getDb()
      .prepare("SELECT * FROM notes WHERE path > ? ORDER BY path LIMIT ?")
      .all(after, request.limit + 1) as Record<string, unknown>[];
    const more = items.length > request.limit;
    if (more) items.pop();
    return { items, cursor: more ? String(items.at(-1)!.path) : undefined };
  }
  matchingIds(filters?: NormalizedSearchFilters) {
    return filters
      ? this.store
          .getAllNotes()
          .filter((n) => noteMatchesSearchFilters(n, filters))
          .map((n) => n.note_id as string)
      : undefined;
  }
  async searchLexical(
    query: string,
    limit: number,
    filters?: NormalizedSearchFilters,
  ) {
    return this.store
      .searchLexical(query, Math.ceil(limit / 3), this.matchingIds(filters))
      .slice(0, limit);
  }
  async searchTrigrams(
    query: string,
    limit: number,
    filters?: NormalizedSearchFilters,
  ) {
    return this.store
      .searchTrigrams(query, Math.ceil(limit / 3), this.matchingIds(filters))
      .slice(0, limit);
  }
  async searchNotes(
    query: string,
    limit: number,
    filters?: NormalizedSearchFilters,
  ) {
    return this.store.searchNotes(query, limit, this.matchingIds(filters));
  }
}
export class SqliteVectorStore implements VectorStore {
  readonly minimumScore = 0.5;
  constructor(private metadata: SqliteMetadataStore) {}
  get vaultId() {
    return this.metadata.vaultId;
  }
  async available() {
    return this.metadata.store.isVecAvailable();
  }
  async query(
    vector: Float32Array,
    limit: number,
    filters?: NormalizedSearchFilters,
  ) {
    const noteIds = this.metadata.matchingIds(filters);
    const chunkIds = noteIds?.flatMap((id) =>
      this.metadata.store.getChunks(id).map((c) => c.chunk_id as string),
    );
    return this.metadata.store.searchEmbeddingVectors(vector, limit, chunkIds);
  }
  async upsert(entries: Parameters<VectorStore["upsert"]>[0]) {
    if (entries.length && !this.metadata.store.isVecAvailable())
      return { id: null, state: "failed" as const };
    this.metadata.store.storeEmbeddings(
      entries.map((e) => e.chunkId),
      entries.map((e) => e.values),
      entries.map((e) => e.contentHash),
    );
    return { id: null, state: "complete" as const };
  }
  async delete(ids: readonly string[]) {
    if (!this.metadata.store.isVecAvailable())
      return { id: null, state: "complete" as const };
    const stmt = this.metadata.store
      .getDb()
      .prepare("DELETE FROM vec_chunks WHERE chunk_id = ?");
    this.metadata.store.getDb().transaction(() => {
      for (const id of ids) stmt.run(id);
    })();
    return { id: null, state: "complete" as const };
  }
  async mutationStatus(mutation: Parameters<VectorStore["mutationStatus"]>[0]) {
    return mutation.id === null ? mutation.state : ("failed" as const);
  }
  score(distance: number) {
    return Number.isFinite(distance) && distance >= 0 ? 1 / (1 + distance) : 0;
  }
}
export function localRetrievalContext(
  store: IndexStore,
  config: Config,
  embeddingProvider?: EmbeddingProviderContract,
): RetrievalContext {
  const metadata = new SqliteMetadataStore(
    store,
    store.getManifest()?.vaultIdentity ?? "local",
  );
  return {
    metadata,
    vectors: new SqliteVectorStore(metadata),
    embeddingEnabled: config.embedding.enabled,
    embeddingProvider,
    compatibility: store.checkStaleness(config),
  };
}
