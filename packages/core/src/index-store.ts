import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { vaultIdentity } from "./identifiers.js";
import { Config } from "./config.js";
import { IndexManifest, Note, Chunk } from "./types.js";
import {
  INDEX_SCHEMA_VERSION,
  DEFAULT_EXCLUDE_PATTERNS,
  TARGET_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  INDEXED_EXTENSIONS,
} from "./schemas.js";
import { resolveIndexDir } from "./paths.js";
import {
  generateLexicalIndexText,
  generateEmbeddingInputText,
} from "./markdown.js";
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
      | Record<string, unknown>
      | undefined;
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

    const staleReasons: string[] = [];

    const effectiveExclude = [
      ...DEFAULT_EXCLUDE_PATTERNS,
      ...config.vault.exclude,
    ].sort();
    const indexedExclude = [...manifest.effectiveExcludePatterns].sort();
    if (JSON.stringify(effectiveExclude) !== JSON.stringify(indexedExclude)) {
      staleReasons.push("Exclude patterns have changed since indexing");
    }

    if (manifest.targetChunkSize !== TARGET_CHUNK_SIZE) {
      staleReasons.push("Target chunk size configuration has changed");
    }
    if (manifest.maxChunkSize !== MAX_CHUNK_SIZE) {
      staleReasons.push("Max chunk size configuration has changed");
    }

    const configuredModel = config.embedding.enabled
      ? config.embedding.model
      : null;
    if (manifest.embeddingModel !== configuredModel) {
      staleReasons.push("Embedding model configuration has changed");
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
    const existing = this.db
      .prepare("SELECT note_id FROM notes WHERE note_id = ?")
      .get(note.noteId);
    if (existing) {
      this.deleteNoteChunks(note.noteId);
    }

    const linksJson = JSON.stringify(note.links ?? []);
    const attachmentRefsJson = JSON.stringify(note.attachmentReferences ?? []);
    const aliasesJson = JSON.stringify(note.frontmatter?.aliases ?? []);
    const tagsJson = JSON.stringify(note.frontmatter?.tags ?? []);

    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO notes (note_id, path, title, file_size, content_hash, mtime_ms,
        frontmatter_title, aliases_json, tags_json, date_value, created_value, updated_value,
        has_frontmatter, frontmatter_degraded, links_json, attachment_refs_json, body_text,
        oversized, empty)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        note.noteId,
        note.vaultRelativePath,
        note.title,
        note.size,
        note.contentHash,
        note.mtimeMs,
        note.frontmatter?.title ?? null,
        aliasesJson,
        tagsJson,
        note.frontmatter?.date ?? null,
        note.frontmatter?.created ?? null,
        note.frontmatter?.updated ?? null,
        note.frontmatter ? 1 : 0,
        note.frontmatterDegraded ? 1 : 0,
        linksJson,
        attachmentRefsJson,
        note.chunks.map((c) => c.content).join("\n"),
        note.chunks.length === 0 && note.size > 2 * 1024 * 1024 ? 1 : 0,
        note.chunks.length === 0 && note.size <= 2 * 1024 * 1024 ? 1 : 0,
      );

    for (const chunk of note.chunks) {
      this.insertChunk(
        chunk,
        note.frontmatter?.aliases ?? [],
        note.frontmatter?.tags ?? [],
      );
    }
  }

  private insertChunk(chunk: Chunk, aliases: string[], tags: string[]): void {
    const headingPathJson = JSON.stringify(chunk.headingPath);
    const chunkId = `${chunk.noteId}:${chunk.chunkIndex}`;

    const lexicalText = generateLexicalIndexText({
      title: chunk.title,
      aliases,
      tags,
      headingPath: chunk.headingPath,
      content: chunk.content,
    });

    const embeddingInputText = generateEmbeddingInputText({
      title: chunk.title,
      headingPath: chunk.headingPath,
      content: chunk.content,
    });

    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO chunks (chunk_id, note_id, chunk_index, path, title, heading,
        heading_path_json, content, content_hash, char_start, char_end, lexical_text, embedding_input_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        chunkId,
        chunk.noteId,
        chunk.chunkIndex,
        chunk.vaultRelativePath,
        chunk.title,
        chunk.heading,
        headingPathJson,
        chunk.content,
        chunk.contentHash,
        chunk.charStart,
        chunk.charEnd,
        lexicalText,
        embeddingInputText,
      );

    this.insertTrigrams(chunkId, lexicalText);
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
    for (const chunk of chunks) {
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

  getChunks(noteId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare("SELECT * FROM chunks WHERE note_id = ? ORDER BY chunk_index")
      .all(noteId) as Array<Record<string, unknown>>;
  }

  getChunk(noteId: string, chunkIndex: number): Record<string, unknown> | null {
    const chunkId = `${noteId}:${chunkIndex}`;
    return (
      (this.db
        .prepare("SELECT * FROM chunks WHERE chunk_id = ?")
        .get(chunkId) as Record<string, unknown> | undefined) ?? null
    );
  }

  searchLexical(query: string, limit: number): Array<Record<string, unknown>> {
    const escapedQuery = escapeFTSQuery(query);
    if (!escapedQuery) return [];

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
      ORDER BY rank
      LIMIT ?
    `,
      )
      .all(escapedQuery, limit * 3) as Array<Record<string, unknown>>;

    return ftsResults;
  }

  searchTrigrams(query: string, limit: number): Array<Record<string, unknown>> {
    const gramsArray = textToTrigrams(query);
    if (gramsArray.length === 0) return [];

    const placeholders = gramsArray.map(() => "?").join(",");

    const results = this.db
      .prepare(
        `
      SELECT chunk_id,
        COUNT(DISTINCT gram) as matched_grams,
        ? as total_query_grams,
        CAST(COUNT(DISTINCT gram) AS REAL) / ? as coverage
      FROM trigrams
      WHERE gram IN (${placeholders})
      GROUP BY chunk_id
      HAVING coverage >= 0.3
      ORDER BY coverage DESC
      LIMIT ?
    `,
      )
      .all(
        gramsArray.length,
        gramsArray.length,
        ...gramsArray,
        limit * 3,
      ) as Array<Record<string, unknown>>;

    return results.map((r) => ({
      chunk_id: r.chunk_id,
      matched_grams: r.matched_grams,
      total_query_grams: r.total_query_grams,
      coverage: r.coverage,
    }));
  }

  searchNotes(query: string, limit: number): Array<Record<string, unknown>> {
    const rows = this.db
      .prepare("SELECT * FROM notes WHERE oversized = 1 OR empty = 1")
      .all() as Array<Record<string, unknown>>;

    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);

    const matched = rows.filter((row) => {
      const title = ((row.title as string) ?? "").toLowerCase();
      const path = ((row.path as string) ?? "").toLowerCase();
      const aliases = JSON.parse(
        (row.aliases_json as string) ?? "[]",
      ) as string[];
      const tags = JSON.parse((row.tags_json as string) ?? "[]") as string[];

      const searchable = [
        title,
        path,
        ...aliases.map((a) => a.toLowerCase()),
        ...tags.map((t) => t.toLowerCase()),
      ].join(" ");

      return tokens.some((token) => searchable.includes(token));
    });

    return matched.slice(0, limit);
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
  ): void {
    if (!this.vecLoaded) return;

    const insertVec = this.db.prepare(
      "INSERT OR REPLACE INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)",
    );

    const insertHash = this.db.prepare(
      "UPDATE chunks SET content_hash = ? WHERE chunk_id = ?",
    );

    const transaction = this.db.transaction(() => {
      for (let i = 0; i < chunkIds.length; i++) {
        const chunkId = chunkIds[i]!;
        const embedding = embeddings[i]!;
        const hash = contentHashes[i] ?? "";
        insertVec.run(chunkId, float32ArrayToBuffer(embedding));
        if (hash) {
          insertHash.run(hash, chunkId);
        }
      }
    });

    transaction();
  }

  searchEmbeddingVectors(
    queryEmbedding: Float32Array,
    limit: number,
  ): Array<{ chunk_id: string; distance: number }> {
    if (!this.vecLoaded) return [];

    try {
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
