import { matchFallbackNotes } from "./index-store-fts.js";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { vaultIdentity } from "./identifiers.js";
import { Config } from "./config.js";
import { IndexManifest, Note } from "./types.js";
import {
  INDEX_SCHEMA_VERSION,
  DEFAULT_EXCLUDE_PATTERNS,
  TARGET_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  INDEXED_EXTENSIONS,
} from "./schemas.js";
import { resolveIndexDir } from "./paths.js";
import { prepareIndexRows } from "./portable/index-data.js";
import type { IndexRow, PreparedEmbedding } from "./portable/index.js";
import { escapeFTSQuery, textToTrigrams } from "./index-store-fts.js";
import { SCHEMA_SQL, VEC_SCHEMA_SQL } from "./index-store-sql.js";
import {
  float32ArrayToBuffer,
  parseVectorDimension,
} from "./index-store-vectors.js";

export class IndexStore {
  private db: Database.Database;
  private dbPath: string;
  private vecLoaded = false;

  private constructor(db: Database.Database, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  static async open(
    dbPath: string,
    embeddingDimension?: number,
  ): Promise<IndexStore> {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");

    const store = new IndexStore(db, dbPath);
    db.exec(SCHEMA_SQL);

    // Schema migration: add frontmatter_fields_json column to existing notes tables.
    try {
      db.exec("ALTER TABLE notes ADD COLUMN frontmatter_fields_json TEXT");
    } catch {
      // Column already exists; ignore.
    }

    for (const sql of [
      "ALTER TABLE notes ADD COLUMN wikilinks_json TEXT",
      "ALTER TABLE chunks ADD COLUMN embedding_key TEXT DEFAULT 'legacy'",
    ]) {
      try {
        db.exec(sql);
      } catch {
        /* Additive column already exists. */
      }
    }

    try {
      const vecModule = await import("sqlite-vec");
      const loadablePath = vecModule.getLoadablePath();
      db.loadExtension(loadablePath);
      store.vecLoaded = true;

      if (embeddingDimension && embeddingDimension > 0) {
        store.initVecTable(embeddingDimension);
      }
    } catch {
      store.vecLoaded = false;
    }

    return store;
  }

  static async openReadOnly(dbPath: string): Promise<IndexStore> {
    const db = new Database(dbPath, { readonly: true });
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");

    const store = new IndexStore(db, dbPath);

    try {
      const vecModule = await import("sqlite-vec");
      const loadablePath = vecModule.getLoadablePath();
      db.loadExtension(loadablePath);
      store.vecLoaded = true;
    } catch {
      store.vecLoaded = false;
    }

    return store;
  }

  initVecTable(dimension: number): void {
    if (!this.vecLoaded) return;
    try {
      this.db.exec(VEC_SCHEMA_SQL(dimension));
    } catch {
      // vec_chunks may already exist
    }
  }

  isVecAvailable(): boolean {
    return this.vecLoaded;
  }

  getManifest(): IndexManifest | null {
    const row = this.db.prepare("SELECT * FROM manifest WHERE id = 1").get() as
      Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      schemaVersion: row.schema_version as number,
      vaultIdentity: row.vault_identity as string,
      indexedFileExtensions: INDEXED_EXTENSIONS,
      effectiveExcludePatterns: JSON.parse(
        row.effective_exclude_patterns as string,
      ),
      targetChunkSize: row.target_chunk_size as number,
      maxChunkSize: row.max_chunk_size as number,
      embeddingModel: (row.embedding_model as string) ?? null,
      embeddingDimension: (row.embedding_dimension as number) ?? null,
      noteCount: row.note_count as number,
      chunkCount: row.chunk_count as number,
      indexedAt: row.indexed_at as number,
    };
  }

  checkStaleness(config: Config): {
    stale: boolean;
    incompatible: boolean;
    details: string;
  } {
    const manifest = this.getManifest();
    if (!manifest) {
      return {
        stale: false,
        incompatible: true,
        details: "No index manifest found",
      };
    }

    const vid = vaultIdentity(path.resolve(config.vault.root));

    if (manifest.schemaVersion !== INDEX_SCHEMA_VERSION) {
      return {
        stale: false,
        incompatible: true,
        details: `Schema version mismatch: index has v${manifest.schemaVersion}, expected v${INDEX_SCHEMA_VERSION}`,
      };
    }

    if (manifest.vaultIdentity !== vid) {
      return {
        stale: false,
        incompatible: true,
        details:
          "Vault identity mismatch: index was built for a different vault",
      };
    }

    const incompatibleReasons: string[] = [];
    const staleReasons: string[] = [];

    const effectiveExclude = [
      ...DEFAULT_EXCLUDE_PATTERNS,
      ...config.vault.exclude,
    ].sort();
    const indexedExclude = [...manifest.effectiveExcludePatterns].sort();
    if (JSON.stringify(effectiveExclude) !== JSON.stringify(indexedExclude)) {
      incompatibleReasons.push("Exclude patterns have changed since indexing");
    }

    if (manifest.targetChunkSize !== TARGET_CHUNK_SIZE) {
      incompatibleReasons.push("Target chunk size configuration has changed");
    }
    if (manifest.maxChunkSize !== MAX_CHUNK_SIZE) {
      incompatibleReasons.push("Max chunk size configuration has changed");
    }

    const configuredModel = config.embedding.enabled
      ? config.embedding.model || null
      : null;
    if (manifest.embeddingModel !== configuredModel) {
      incompatibleReasons.push("Embedding model configuration has changed");
    }

    if (
      manifest.embeddingDimension !== null &&
      config.embedding.enabled &&
      configuredModel !== null
    ) {
      const currentDimension =
        (config.embedding as { dimension?: number | null }).dimension ?? null;
      if (
        currentDimension !== null &&
        manifest.embeddingDimension !== currentDimension
      ) {
        incompatibleReasons.push("Embedding dimension mismatch");
      }
    }

    if (incompatibleReasons.length > 0) {
      return {
        stale: false,
        incompatible: true,
        details: incompatibleReasons.join("; "),
      };
    }

    if (staleReasons.length > 0) {
      return {
        stale: true,
        incompatible: false,
        details: staleReasons.join("; "),
      };
    }

    return { stale: false, incompatible: false, details: "" };
  }

  setManifest(manifest: IndexManifest): void {
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO manifest (id, schema_version, vault_identity, effective_exclude_patterns,
        target_chunk_size, max_chunk_size, embedding_model, embedding_dimension,
        note_count, chunk_count, indexed_at, config_fingerprint)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        manifest.schemaVersion,
        manifest.vaultIdentity,
        JSON.stringify(manifest.effectiveExcludePatterns),
        manifest.targetChunkSize,
        manifest.maxChunkSize,
        manifest.embeddingModel,
        manifest.embeddingDimension,
        manifest.noteCount,
        manifest.chunkCount,
        manifest.indexedAt,
        this.computeConfigFingerprint(manifest),
      );
  }

  private computeConfigFingerprint(manifest: IndexManifest): string {
    const parts = [
      String(manifest.schemaVersion),
      manifest.vaultIdentity,
      JSON.stringify(manifest.effectiveExcludePatterns),
      String(manifest.targetChunkSize),
      String(manifest.maxChunkSize),
      manifest.embeddingModel ?? "",
    ];
    return parts.join("|");
  }

  upsertNote(note: Note): void {
    const prepared = prepareIndexRows(note);
    this.upsertPreparedNote(prepared.note, prepared.chunks);
  }

  upsertPreparedNote(note: IndexRow, chunks: readonly IndexRow[]): void {
    this.deleteNoteChunks(String(note.note_id));
    const columns = [
      "note_id",
      "path",
      "title",
      "file_size",
      "content_hash",
      "mtime_ms",
      "frontmatter_title",
      "aliases_json",
      "tags_json",
      "date_value",
      "created_value",
      "updated_value",
      "has_frontmatter",
      "frontmatter_degraded",
      "frontmatter_fields_json",
      "links_json",
      "wikilinks_json",
      "attachment_refs_json",
      "body_text",
      "oversized",
      "empty",
    ];
    this.db
      .prepare(
        `INSERT OR REPLACE INTO notes (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      )
      .run(...columns.map((k) => note[k] ?? null));
    const keys = [
      "chunk_id",
      "note_id",
      "chunk_index",
      "path",
      "title",
      "heading",
      "heading_path_json",
      "content",
      "content_hash",
      "char_start",
      "char_end",
      "lexical_text",
      "embedding_input_text",
    ];
    const insert = this.db.prepare(
      `INSERT INTO chunks (${keys.join(",")},embedding_key) VALUES (${keys.map(() => "?").join(",")},NULL)`,
    );
    for (const chunk of chunks) {
      insert.run(...keys.map((k) => chunk[k] ?? null));
      this.insertTrigrams(String(chunk.chunk_id), String(chunk.lexical_text));
    }
  }

  updateNoteLinks(row: IndexRow): void {
    this.db
      .prepare("UPDATE notes SET links_json=?,wikilinks_json=? WHERE note_id=?")
      .run(row.links_json, row.wikilinks_json, row.note_id);
  }
  updateNoteObservation(row: IndexRow): void {
    this.db
      .prepare("UPDATE notes SET file_size=?,mtime_ms=? WHERE note_id=?")
      .run(row.file_size, row.mtime_ms, row.note_id);
  }
  getEmbeddingCache(key: string): Float32Array | null {
    try {
      const row = this.db
        .prepare("SELECT values_json FROM embedding_cache WHERE key=?")
        .get(key) as { values_json: string } | undefined;
      return row ? Float32Array.from(JSON.parse(row.values_json)) : null;
    } catch {
      return null;
    }
  }
  storePreparedEmbeddings(entries: readonly PreparedEmbedding[]): void {
    const cache = this.db.prepare(
      "INSERT OR REPLACE INTO embedding_cache VALUES(?,?,?)",
    );
    for (const entry of entries)
      cache.run(
        entry.cacheKey,
        JSON.stringify(Array.from(entry.values)),
        Date.now(),
      );
    const writes = entries.filter((e) => e.needsWrite);
    if (writes.length)
      this.storeEmbeddings(
        writes.map((e) => e.chunkId),
        writes.map((e) => e.values),
        writes.map((e) => e.contentHash),
        writes.map((e) => e.cacheKey),
      );
  }

  private insertTrigrams(chunkId: string, text: string): void {
    const insert = this.db.prepare(
      "INSERT INTO trigrams (chunk_id, gram) VALUES (?, ?)",
    );
    const insertMany = this.db.transaction((grams2: string[]) => {
      for (const gram of grams2) {
        insert.run(chunkId, gram);
      }
    });
    insertMany(textToTrigrams(text));
  }

  private deleteNoteChunks(noteId: string): void {
    const chunks = this.db
      .prepare("SELECT chunk_id FROM chunks WHERE note_id = ?")
      .all(noteId) as Array<{ chunk_id: string }>;
    const deleteTrigram = this.db.prepare(
      "DELETE FROM trigrams WHERE chunk_id = ?",
    );
    const deleteChunks = this.db.prepare(
      "DELETE FROM chunks WHERE note_id = ?",
    );
    const deleteVector =
      this.vecLoaded && this.getEmbeddingDimension() !== null
        ? this.db.prepare("DELETE FROM vec_chunks WHERE chunk_id=?")
        : null;
    for (const chunk of chunks) {
      deleteVector?.run(chunk.chunk_id);
      deleteTrigram.run(chunk.chunk_id);
    }
    deleteChunks.run(noteId);
  }

  deleteNote(noteId: string): void {
    this.deleteNoteChunks(noteId);
    this.db.prepare("DELETE FROM notes WHERE note_id = ?").run(noteId);
  }

  deleteNoteByPath(vaultRelativePath: string): void {
    const row = this.db
      .prepare("SELECT note_id FROM notes WHERE path = ?")
      .get(vaultRelativePath) as { note_id: string } | undefined;
    if (row) {
      this.deleteNote(row.note_id);
    }
  }

  getNote(noteId: string): Record<string, unknown> | null {
    const row = this.db
      .prepare("SELECT * FROM notes WHERE note_id = ?")
      .get(noteId) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  getNoteByPath(vaultRelativePath: string): Record<string, unknown> | null {
    const row = this.db
      .prepare("SELECT * FROM notes WHERE path = ?")
      .get(vaultRelativePath) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  getAllNotePaths(): string[] {
    const rows = this.db.prepare("SELECT path FROM notes").all() as Array<{
      path: string;
    }>;
    return rows.map((r) => r.path);
  }

  getChunks(
    noteId: string,
    limit = -1,
    offset = 0,
  ): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        "SELECT * FROM chunks WHERE note_id = ? ORDER BY chunk_index LIMIT ? OFFSET ?",
      )
      .all(noteId, limit, offset) as Array<Record<string, unknown>>;
  }

  getChunk(noteId: string, chunkIndex: number): Record<string, unknown> | null {
    const chunkId = `${noteId}:${chunkIndex}`;
    return (
      (this.db
        .prepare("SELECT * FROM chunks WHERE chunk_id = ?")
        .get(chunkId) as Record<string, unknown> | undefined) ?? null
    );
  }

  searchLexical(
    query: string,
    limit: number,
    allowedNoteIds?: readonly string[],
  ): Array<Record<string, unknown>> {
    const escapedQuery = escapeFTSQuery(query);
    if (!escapedQuery) return [];
    if (allowedNoteIds && allowedNoteIds.length === 0) return [];

    const noteFilter = sqlInFilter("c.note_id", allowedNoteIds);

    const ftsResults = this.db
      .prepare(
        `
      SELECT c.chunk_id, c.note_id, c.chunk_index, c.path, c.title, c.heading,
        c.heading_path_json, c.content, c.content_hash, c.char_start, c.char_end,
        c.lexical_text, c.embedding_input_text,
        bm25(fts_chunks) as rank
      FROM fts_chunks f
      JOIN chunks c ON f.chunk_id = c.chunk_id
      WHERE fts_chunks MATCH ?
        ${noteFilter.sql}
      ORDER BY rank
      LIMIT ?
    `,
      )
      .all(escapedQuery, ...noteFilter.params, limit * 3) as Array<
      Record<string, unknown>
    >;

    return ftsResults;
  }

  searchTrigrams(
    query: string,
    limit: number,
    allowedNoteIds?: readonly string[],
  ): Array<Record<string, unknown>> {
    const gramsArray = textToTrigrams(query);
    if (gramsArray.length === 0) return [];
    if (allowedNoteIds && allowedNoteIds.length === 0) return [];

    const placeholders = gramsArray.map(() => "?").join(",");
    const noteFilter = sqlInFilter("c.note_id", allowedNoteIds);

    const results = this.db
      .prepare(
        `
      SELECT t.chunk_id,
        COUNT(DISTINCT gram) as matched_grams,
        ? as total_query_grams,
        CAST(COUNT(DISTINCT gram) AS REAL) / ? as coverage
      FROM trigrams t
      JOIN chunks c ON t.chunk_id = c.chunk_id
      WHERE gram IN (${placeholders})
        ${noteFilter.sql}
      GROUP BY t.chunk_id
      HAVING coverage >= 0.3
      ORDER BY coverage DESC
      LIMIT ?
    `,
      )
      .all(
        gramsArray.length,
        gramsArray.length,
        ...gramsArray,
        ...noteFilter.params,
        limit * 3,
      ) as Array<Record<string, unknown>>;

    return results.map((r) => ({
      chunk_id: r.chunk_id,
      matched_grams: r.matched_grams,
      total_query_grams: r.total_query_grams,
      coverage: r.coverage,
    }));
  }

  searchNotes(
    query: string,
    limit: number,
    allowedNoteIds?: readonly string[],
  ): Array<Record<string, unknown>> {
    if (allowedNoteIds && allowedNoteIds.length === 0) return [];
    const allowed = allowedNoteIds ? new Set(allowedNoteIds) : undefined;
    const rows = this.db
      .prepare("SELECT * FROM notes WHERE oversized = 1 OR empty = 1")
      .all() as Array<Record<string, unknown>>;

    return matchFallbackNotes(
      rows.filter((row) => !allowed || allowed.has(row.note_id as string)),
      query,
      limit,
    );
  }

  getAllNotes(): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM notes").all() as Array<
      Record<string, unknown>
    >;
  }

  getAllChunkIds(): string[] {
    const rows = this.db.prepare("SELECT chunk_id FROM chunks").all() as Array<{
      chunk_id: string;
    }>;
    return rows.map((r) => r.chunk_id);
  }

  getAllNoteStems(): Map<
    string,
    Array<{ noteId: string; title: string | null; aliases: string[] }>
  > {
    const notes = this.getAllNotes();
    const map = new Map<
      string,
      Array<{ noteId: string; title: string | null; aliases: string[] }>
    >();

    for (const note of notes) {
      const path = note.path as string;
      const filename = path.split("/").pop() ?? path;
      const stem = filename.replace(/\.(md|markdown)$/i, "");
      const noteId = note.note_id as string;

      const title = (note.title as string) ?? null;
      const aliases = JSON.parse(
        (note.aliases_json as string) ?? "[]",
      ) as string[];

      const entries = map.get(stem) ?? [];
      entries.push({ noteId, title, aliases });
      map.set(stem, entries);
    }

    return map;
  }

  getChunkById(chunkId: string): Record<string, unknown> | null {
    return (
      (this.db
        .prepare("SELECT * FROM chunks WHERE chunk_id = ?")
        .get(chunkId) as Record<string, unknown> | undefined) ?? null
    );
  }

  storeEmbeddings(
    chunkIds: string[],
    embeddings: Float32Array[],
    contentHashes: string[],
    cacheKeys?: string[],
  ): void {
    if (!this.vecLoaded) return;

    const insertVec = this.db.prepare(
      "INSERT OR REPLACE INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)",
    );

    const insertHash = this.db.prepare(
      "UPDATE chunks SET content_hash = CASE WHEN ? <> '' THEN ? ELSE content_hash END, embedding_key=? WHERE chunk_id = ?",
    );

    const transaction = this.db.transaction(() => {
      for (let i = 0; i < chunkIds.length; i++) {
        const chunkId = chunkIds[i]!;
        const embedding = embeddings[i]!;
        const hash = contentHashes[i] ?? "";
        insertVec.run(chunkId, float32ArrayToBuffer(embedding));
        insertHash.run(hash, hash, cacheKeys?.[i] ?? "legacy", chunkId);
      }
    });

    transaction();
  }

  searchEmbeddingVectors(
    queryEmbedding: Float32Array,
    limit: number,
    allowedChunkIds?: readonly string[],
  ): Array<{ chunk_id: string; distance: number }> {
    if (!this.vecLoaded) return [];
    if (allowedChunkIds && allowedChunkIds.length === 0) return [];

    try {
      if (allowedChunkIds) {
        const chunkFilter = sqlInFilter("chunk_id", allowedChunkIds);
        const rows = this.db
          .prepare(
            `SELECT chunk_id, distance
             FROM vec_chunks
             WHERE embedding MATCH ?
              ${chunkFilter.sql}
             ORDER BY distance
             LIMIT ?`,
          )
          .all(
            float32ArrayToBuffer(queryEmbedding),
            ...chunkFilter.params,
            limit,
          ) as Array<{
          chunk_id: string;
          distance: number;
        }>;

        return rows;
      }

      const rows = this.db
        .prepare(
          `SELECT chunk_id, distance
           FROM vec_chunks
           WHERE embedding MATCH ?
           ORDER BY distance
           LIMIT ?`,
        )
        .all(float32ArrayToBuffer(queryEmbedding), limit) as Array<{
        chunk_id: string;
        distance: number;
      }>;

      return rows;
    } catch {
      if (allowedChunkIds) {
        const allowed = new Set(allowedChunkIds);
        return this.searchAllEmbeddingVectors(
          queryEmbedding,
          this.getAllChunkIds().length,
        )
          .filter(({ chunk_id }) => allowed.has(chunk_id))
          .slice(0, limit);
      }
      return [];
    }
  }

  private searchAllEmbeddingVectors(
    queryEmbedding: Float32Array,
    limit: number,
  ): Array<{ chunk_id: string; distance: number }> {
    try {
      const fullLimit = Math.max(limit, this.getAllChunkIds().length);
      const rows = this.db
        .prepare(
          `SELECT chunk_id, distance
           FROM vec_chunks
           WHERE embedding MATCH ?
           ORDER BY distance
           LIMIT ?`,
        )
        .all(float32ArrayToBuffer(queryEmbedding), fullLimit) as Array<{
        chunk_id: string;
        distance: number;
      }>;

      return rows.slice(0, limit);
    } catch {
      return [];
    }
  }

  getEmbeddingDimension(): number | null {
    if (!this.vecLoaded) return null;
    try {
      const row = this.db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name = 'vec_chunks' AND type = 'table'",
        )
        .get() as { sql: string } | undefined;
      if (!row?.sql) return null;
      return parseVectorDimension(row.sql);
    } catch {
      return null;
    }
  }

  isEmbeddingReady(): boolean {
    return (
      this.isVecAvailable() &&
      this.getEmbeddingDimension() !== null &&
      !this.hasPendingEmbeddings()
    );
  }

  hasPendingEmbeddings(): boolean {
    try {
      return !!this.db
        .prepare("SELECT 1 FROM chunks WHERE embedding_key IS NULL LIMIT 1")
        .get();
    } catch {
      return false;
    }
  }

  beginTransaction(): void {
    this.db.exec("BEGIN TRANSACTION");
  }

  commit(): void {
    this.db.exec("COMMIT");
  }

  rollback(): void {
    this.db.exec("ROLLBACK");
  }

  close(): void {
    this.db.close();
  }

  getDbPath(): string {
    return this.dbPath;
  }

  getDb(): Database.Database {
    return this.db;
  }
}

export function getIndexPath(config: Config): string {
  const vaultRoot = config.vault.root;
  const resolvedVault = path.resolve(vaultRoot);
  const vid = vaultIdentity(resolvedVault);
  const indexDir = resolveIndexDir(config.index.dir || undefined);

  return path.join(indexDir, vid, "index.sqlite");
}

function sqlInFilter(
  column: string,
  values?: readonly string[],
): { sql: string; params: string[] } {
  if (!values) return { sql: "", params: [] };
  if (values.length === 0) return { sql: "AND 1 = 0", params: [] };
  return {
    sql: `AND ${column} IN (${values.map(() => "?").join(",")})`,
    params: [...values],
  };
}
