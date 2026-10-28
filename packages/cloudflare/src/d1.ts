import {
  escapeFTSQuery,
  textToTrigrams,
  matchFallbackNotes,
  noteMatchesSearchFilters,
  type MetadataLexicalStore,
  type IndexRow,
  type IndexManifest,
  type NormalizedSearchFilters,
  type PageRequest,
  type AggregateIndexView,
} from "@vault-agent/core/portable";
import { CloudError } from "./errors.js";

export function ftsName(revision: string) {
  if (!/^[a-f0-9]{64}$/.test(revision))
    throw new CloudError("INDEX_INCOMPATIBLE", 409);
  return `fts_${revision}`;
}
export class D1MetadataStore implements MetadataLexicalStore {
  constructor(
    readonly db: D1Database,
    readonly vaultId: string,
    readonly revision: string,
    readonly manifest: IndexManifest,
    readonly allowed: (path: string) => boolean,
  ) {}
  async getManifest() {
    return this.manifest;
  }
  async rows(sql: string, values: (string | number | null)[] = []) {
    const result = await this.db
      .prepare(sql)
      .bind(...values)
      .all<IndexRow>();
    if (!result.success) throw new CloudError("INDEX_UNAVAILABLE", 503);
    return result.results;
  }
  decode(row: IndexRow): IndexRow {
    const data: IndexRow = JSON.parse(String(row.data));
    if (!this.allowed(String(data.path)))
      throw new CloudError("SOURCE_EXCLUDED", 403);
    return data;
  }
  async getNote(id: string) {
    const rows = await this.rows(
      "SELECT data FROM notes WHERE revision=? AND note_id=?",
      [this.revision, id],
    );
    return rows[0] ? this.decode(rows[0]) : null;
  }
  async getChunk(note: string, index: number) {
    return this.getChunkById(`${note}:${index}`);
  }
  async getChunkById(id: string) {
    const rows = await this.rows(
      "SELECT data FROM chunks WHERE revision=? AND chunk_id=?",
      [this.revision, id],
    );
    return rows[0] ? this.decode(rows[0]) : null;
  }
  async getChunks(id: string, request: PageRequest) {
    const offset = this.page(request);
    const rows = await this.rows(
      "SELECT data FROM chunks WHERE revision=? AND note_id=? ORDER BY chunk_index LIMIT ? OFFSET ?",
      [this.revision, id, request.limit + 1, offset],
    );
    return this.resultPage(rows, request.limit, offset);
  }
  page(request: PageRequest) {
    request.signal?.throwIfAborted();
    const offset = request.cursor === undefined ? 0 : Number(request.cursor);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 500
    )
      throw new CloudError("INVALID_CURSOR");
    return offset;
  }
  resultPage(rows: IndexRow[], limit: number, offset: number) {
    return {
      items: rows.slice(0, limit).map((r) => this.decode(r)),
      cursor: rows.length > limit ? String(offset + limit) : undefined,
    };
  }
  async listNotes(request: PageRequest) {
    const offset = this.page(request);
    return this.resultPage(
      await this.rows(
        "SELECT data FROM notes WHERE revision=? ORDER BY path LIMIT ? OFFSET ?",
        [this.revision, request.limit + 1, offset],
      ),
      request.limit,
      offset,
    );
  }
  async notes() {
    const rows = await this.rows(
      "SELECT data FROM notes WHERE revision=? ORDER BY path LIMIT 501",
      [this.revision],
    );
    if (rows.length > 500) throw new CloudError("INDEX_BUDGET_EXCEEDED", 413);
    return rows.map((r) => this.decode(r));
  }
  async matchingIds(filters?: NormalizedSearchFilters) {
    return (await this.notes())
      .filter((n) => !filters || noteMatchesSearchFilters(n, filters))
      .map((n) => String(n.note_id));
  }
  async hasMatchingNotes(filters: NormalizedSearchFilters) {
    return (await this.matchingIds(filters)).length > 0;
  }
  async searchLexical(
    query: string,
    limit: number,
    filters?: NormalizedSearchFilters,
  ) {
    const match = escapeFTSQuery(query);
    if (!match) return [];
    const ids = await this.matchingIds(filters);
    const fts = ftsName(this.revision);
    return this.rows(
      `SELECT f.chunk_id, bm25(${fts}) AS rank FROM ${fts} f JOIN chunks c ON c.revision=? AND c.chunk_id=f.chunk_id WHERE ${fts} MATCH ? AND c.note_id IN (SELECT value FROM json_each(?)) ORDER BY rank, f.rowid LIMIT ?`,
      [this.revision, match, JSON.stringify(ids), limit],
    );
  }
  async searchTrigrams(
    query: string,
    limit: number,
    filters?: NormalizedSearchFilters,
  ) {
    const grams = textToTrigrams(query);
    if (!grams.length) return [];
    const ids = await this.matchingIds(filters);
    return this.rows(
      `SELECT g.chunk_id, COUNT(DISTINCT gram) AS matched_grams, ? AS total_query_grams, CAST(COUNT(DISTINCT gram) AS REAL)/? AS coverage FROM grams g JOIN chunks c ON c.revision=g.revision AND c.chunk_id=g.chunk_id WHERE g.revision=? AND gram IN (SELECT value FROM json_each(?)) AND c.note_id IN (SELECT value FROM json_each(?)) GROUP BY g.chunk_id HAVING coverage>=0.3 ORDER BY coverage DESC, g.chunk_id LIMIT ?`,
      [
        grams.length,
        grams.length,
        this.revision,
        JSON.stringify(grams),
        JSON.stringify(ids),
        limit,
      ],
    );
  }
  async searchNotes(
    query: string,
    limit: number,
    filters?: NormalizedSearchFilters,
  ) {
    return matchFallbackNotes(
      (await this.notes()).filter(
        (n) =>
          (n.oversized || n.empty) &&
          (!filters || noteMatchesSearchFilters(n, filters)),
      ),
      query,
      limit,
    );
  }

  async aggregate(): Promise<AggregateIndexView> {
    const notes = await this.notes();
    const raw = await this.rows(
      "SELECT data FROM chunks WHERE revision=? ORDER BY chunk_id LIMIT 2001",
      [this.revision],
    );
    if (
      raw.length > 2000 ||
      raw.reduce(
        (sum, r) => sum + new TextEncoder().encode(String(r.data)).length,
        0,
      ) >
        16 * 1024 * 1024
    )
      throw new CloudError("INDEX_BUDGET_EXCEEDED", 413);
    const chunks = new Map(
      raw.map((r) => {
        const c = this.decode(r);
        return [String(c.chunk_id), c] as const;
      }),
    );
    return {
      getManifest: () => this.manifest,
      getAllNotes: () => notes,
      getAllChunkIds: () => [...chunks.keys()],
      getChunkById: (id) => chunks.get(id) ?? null,
    };
  }
}
