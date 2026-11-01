import {
  contentRevision,
  EmbeddingProviderError,
  noteMatchesSearchFilters,
  type VectorStore,
  type VectorEntry,
  type VectorMutation,
  type NormalizedSearchFilters,
} from "@vault-agent/core/portable";
import type { D1MetadataStore } from "./d1.js";
import { CloudError } from "./errors.js";
import {
  descriptor,
  DIMENSION,
  MODEL,
  ProviderOperations,
  validVector,
} from "./provider.js";

export type VectorBinding = Pick<
  Vectorize,
  "query" | "getByIds" | "upsert" | "deleteByIds" | "describe"
>;
export class VectorizeStore implements VectorStore {
  readonly vaultId: string;
  readonly minimumScore = 0;
  constructor(
    readonly index: VectorBinding | undefined,
    readonly metadata: D1MetadataStore,
    readonly modelRevision: string,
    readonly operations = new ProviderOperations(),
  ) {
    this.vaultId = metadata.vaultId;
  }
  async identity() {
    const generation = await contentRevision(
      JSON.stringify(descriptor(this.modelRevision)),
    );
    const namespace = await contentRevision(
      JSON.stringify([this.vaultId, this.metadata.revision, generation]),
    );
    return { generation, namespace };
  }
  async id(chunkId: string, inputKey?: string, publicationId?: string) {
    return contentRevision(
      JSON.stringify(
        inputKey
          ? [
              (await this.identity()).namespace,
              chunkId,
              inputKey,
              publicationId ?? null,
            ]
          : [(await this.identity()).namespace, chunkId],
      ),
    );
  }
  async available() {
    if (
      !this.index ||
      this.metadata.manifest.embeddingModel !== MODEL ||
      this.metadata.manifest.embeddingDimension !== DIMENSION
    )
      return false;
    const row = await this.metadata.db
      .prepare(
        "SELECT generation,descriptor,state FROM embedding_generations WHERE revision=?",
      )
      .bind(this.metadata.revision)
      .first<{ generation: string; descriptor: string; state: string }>();
    const { generation } = await this.identity();
    if (
      !row ||
      row.state !== "ready" ||
      row.generation !== generation ||
      row.descriptor !== JSON.stringify(descriptor(this.modelRevision))
    )
      return false;
    try {
      return (
        (await this.operations.run(() => this.index!.describe())).dimensions ===
        DIMENSION
      );
    } catch {
      return false;
    }
  }
  score(distance: number) {
    return Math.max(0, Math.min(1, 1 - distance / 2));
  }
  async query(
    vector: Float32Array,
    limit: number,
    filters?: NormalizedSearchFilters,
  ) {
    if (
      !this.index ||
      !validVector(vector) ||
      !Number.isSafeInteger(limit) ||
      limit < 1
    )
      throw new EmbeddingProviderError("Cloud vectors are unavailable.");
    const { generation, namespace } = await this.identity();
    this.operations.counts.vectorQueries++;
    const response = await this.operations.run(() =>
      this.index!.query(vector, {
        namespace,
        topK: Math.min(100, Math.max(1, limit)),
        returnValues: false,
        returnMetadata: "none",
      }),
    );
    if (!response || !Array.isArray(response.matches))
      throw new EmbeddingProviderError("Invalid vector response.");
    const matches = response.matches.slice(0, Math.min(100, limit));
    this.operations.counts.vectorCandidates += matches.length;
    if (!matches.length) return [];
    const records = await this.operations.run(() =>
      this.index!.getByIds(matches.map((m) => m.id)),
    );
    if (!Array.isArray(records))
      throw new EmbeddingProviderError("Invalid vector response.");
    const byId = new Map(records.map((record) => [record.id, record]));
    const results: { chunk_id: string; distance: number }[] = [];
    const seen = new Set<string>();
    for (const match of matches) {
      const record = byId.get(match.id);
      const meta = record?.metadata;
      const work =
        this.metadata.incremental && typeof meta?.chunkId === "string"
          ? await this.metadata.db
              .prepare(
                "SELECT vector_id,input_key FROM vector_work WHERE revision=? AND chunk_id=?",
              )
              .bind(this.metadata.revision, meta.chunkId)
              .first<{ vector_id: string; input_key: string }>()
          : null;
      if (
        !record ||
        record.namespace !== namespace ||
        meta?.generation !== generation ||
        typeof meta.chunkId !== "string" ||
        typeof meta.contentHash !== "string" ||
        !Number.isFinite(match.score) ||
        match.score < -1 ||
        match.score > 1 ||
        seen.has(match.id) ||
        match.id !== (work?.vector_id ?? (await this.id(meta.chunkId))) ||
        (work && meta.inputKey !== work.input_key)
      )
        continue;
      let chunk;
      try {
        chunk = await this.metadata.getChunkById(meta.chunkId);
      } catch (error) {
        if (error instanceof CloudError && error.code === "SOURCE_EXCLUDED")
          continue;
        throw error;
      }
      if (!chunk || chunk.content_hash !== meta.contentHash) continue;
      const note = await this.metadata.getNote(String(chunk.note_id));
      if (!note || (filters && !noteMatchesSearchFilters(note, filters)))
        continue;
      const source = await this.metadata.db
        .prepare(
          "SELECT digest FROM sources WHERE revision=? AND path=? AND kind='note'",
        )
        .bind(this.metadata.revision, String(note.path))
        .first<{ digest: string }>();
      if (!source || source.digest !== note.content_hash)
        throw new CloudError("SOURCE_REVISION_MISMATCH", 409);
      seen.add(match.id);
      results.push({ chunk_id: meta.chunkId, distance: 1 - match.score });
    }
    return results;
  }
  async upsert(entries: readonly VectorEntry[]): Promise<VectorMutation> {
    if (!this.index || !entries.length || entries.length > 100)
      throw new EmbeddingProviderError("Invalid vector batch.");
    const { generation, namespace } = await this.identity();
    const staging = await this.metadata.db
      .prepare(
        "SELECT g.generation FROM embedding_generations g WHERE g.revision=? AND g.state='pending' AND NOT EXISTS (SELECT 1 FROM deployment WHERE revision=g.revision)",
      )
      .bind(this.metadata.revision)
      .first<{ generation: string }>();
    if (staging?.generation !== generation)
      throw new EmbeddingProviderError("Generation is not writable.");
    const records: VectorizeVector[] = [];
    for (const entry of entries) {
      const chunk = await this.metadata.getChunkById(entry.chunkId);
      if (
        !validVector(entry.values) ||
        !chunk ||
        entry.contentHash !== chunk.content_hash
      )
        throw new EmbeddingProviderError("Invalid vector batch.");
      records.push({
        id: await this.id(entry.chunkId),
        namespace,
        values: entry.values,
        metadata: {
          chunkId: entry.chunkId,
          contentHash: entry.contentHash,
          generation,
        },
      });
    }
    this.operations.counts.vectorWrites += records.length;
    const result = await this.operations.run(() => this.index!.upsert(records));
    if (!result || typeof result.mutationId !== "string" || !result.mutationId)
      throw new EmbeddingProviderError("Invalid vector receipt.");
    return { id: result.mutationId, state: "pending" };
  }
  async delete(chunkIds: readonly string[]): Promise<VectorMutation> {
    if (!this.index || !chunkIds.length || chunkIds.length > 100)
      throw new EmbeddingProviderError("Invalid vector batch.");
    const active = await this.metadata.db
      .prepare("SELECT revision FROM deployment WHERE id=1")
      .first<{ revision: string }>();
    if (active?.revision === this.metadata.revision)
      throw new EmbeddingProviderError("Active generation cannot be deleted.");
    const ids = await Promise.all(chunkIds.map((id) => this.id(id)));
    this.operations.counts.vectorDeletes += ids.length;
    const result = await this.operations.run(() =>
      this.index!.deleteByIds(ids),
    );
    if (!result || typeof result.mutationId !== "string" || !result.mutationId)
      throw new EmbeddingProviderError("Invalid vector receipt.");
    return { id: result.mutationId, state: "pending" };
  }
  async mutationStatus(
    mutation: VectorMutation,
  ): Promise<VectorMutation["state"]> {
    // V2 has no per-mutation completion API. UUIDs cannot be ordered. The
    // publisher must persist receipts and verify visibility separately.
    return mutation.state;
  }
  async visible(entries: readonly VectorEntry[]) {
    if (!this.index || !entries.length || entries.length > 16)
      throw new EmbeddingProviderError("Invalid visibility batch.");
    const { namespace, generation } = await this.identity();
    for (const entry of entries) {
      if (!validVector(entry.values)) return false;
      const id = await this.id(entry.chunkId);
      this.operations.counts.vectorQueries++;
      const response = await this.operations.run(() =>
        this.index!.query(entry.values, {
          namespace,
          topK: 1,
          filter: { chunkId: entry.chunkId },
          returnMetadata: "all",
          returnValues: false,
        }),
      );
      if (!response || !Array.isArray(response.matches))
        throw new EmbeddingProviderError("Invalid vector response.");
      this.operations.counts.vectorCandidates += response.matches.length;
      // A visibility check must identify the exact vector, not a nearby match.
      if (
        !response.matches.some(
          (m) =>
            m.id === id &&
            m.metadata?.contentHash === entry.contentHash &&
            m.metadata?.generation === generation,
        )
      )
        return false;
    }
    return true;
  }
}
