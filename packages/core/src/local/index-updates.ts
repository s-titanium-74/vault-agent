import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import type { IndexStore } from "../index-store.js";
import type { IndexManifest, IndexResult, IndexWarning } from "../types.js";
import type { IndexRow, SourceEntry } from "../portable/contracts.js";
import {
  planSourceChanges,
  prepareNoteUpdate,
  prepareEmbeddingBatch,
  indexRowsEqual,
  type PreparedEmbedding,
  type SourceObservation,
  type IndexedSource,
} from "../portable/index-updates.js";
import { createIndexLinkResolver } from "../portable/index-data.js";
import { EmbeddingProvider, validateEmbeddingEndpoint } from "../embedding.js";
import { VaultDiscovery } from "../discovery.js";
import { resolveVaultRelativePath, toVaultRelative } from "../pathsafety.js";
import { noteIdFromPath } from "../identifiers.js";
import { IndexError } from "../errors.js";
import {
  INDEX_SCHEMA_VERSION,
  DEFAULT_EXCLUDE_PATTERNS,
  TARGET_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  INDEXED_EXTENSIONS,
  CHUNK_EMBEDDING_INPUT_CAP,
} from "../schemas.js";

export interface LocalIndexUpdateOptions {
  paths?: readonly string[];
  full?: boolean;
  vaultIdentity: string;
  requireEmbeddings?: boolean;
  cacheSource?: IndexStore;
}
/** Runtime adapter: asynchronous preparation, then one synchronous SQLite publication. */
export async function updateLocalIndex(
  store: IndexStore,
  config: Config,
  options: LocalIndexUpdateOptions,
): Promise<IndexResult> {
  const priorManifest = store.getManifest();
  const priorSignature = JSON.stringify(priorManifest);
  const previousRows = store.getAllNotes();
  const previous = new Map(previousRows.map((row) => [String(row.path), row]));
  const before: IndexedSource[] = previousRows.map((row) => ({
    path: String(row.path),
    kind: "note",
    revision: String(row.content_hash),
  }));
  const root = path.resolve(config.vault.root),
    discovery = new VaultDiscovery(root, config.vault.exclude);
  const paths =
    options.paths ?? discovery.discover().files.map((f) => f.vaultRelativePath);
  const observations: SourceObservation[] = [];
  const reads = new Map<
    string,
    { entry: SourceEntry; text: string; mtimeMs: number }
  >();
  const warnings: IndexWarning[] = [];
  const watched = options.paths !== undefined;
  const warn = (kind: string, p: string, size?: number) => {
    const names: Record<string, string> = {
      binary: watched ? "INDEX_FILE_BINARY" : "FILE_BINARY",
      read: watched ? "INDEX_FILE_READ_FAILED" : "FILE_NOT_UTF8",
      encoding: watched ? "INDEX_FILE_NOT_UTF8" : "FILE_NOT_UTF8",
      large: watched ? "INDEX_FILE_TOO_LARGE" : "FILE_TOO_LARGE_FOR_INDEXING",
      frontmatter: watched
        ? "INDEX_FRONTMATTER_PARSE_FAILED"
        : "FRONTMATTER_PARSE_FAILED",
    };
    warnings.push({
      code: names[kind]!,
      message: `Index source ${kind}: ${p}`,
      path: p,
      ...(size === undefined ? {} : { size }),
    });
  };
  for (const candidate of new Set(paths)) {
    const absolute = resolveVaultRelativePath(root, candidate),
      p = toVaultRelative(absolute, root);
    if (!p || p === ".") continue;
    if (!INDEXED_EXTENSIONS.includes(path.extname(p).toLowerCase())) continue;
    const observation: SourceObservation = { path: p, source: null };
    observations.push(observation);
    if (
      p.split("/").some((segment) => segment.startsWith(".")) ||
      !discovery.isIndexPathInsideVault(p)
    )
      continue;
    try {
      let current = root,
        symlink = false;
      for (const segment of p.split("/")) {
        current = path.join(current, segment);
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
          symlink = true;
          break;
        }
      }
      if (symlink || !fs.existsSync(absolute)) continue;
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) continue;
      observation.unavailable = true;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(
          fs.readFileSync(absolute),
        );
      } catch {
        warn("encoding", p);
        continue;
      }
      if (text.includes("\0")) {
        warn("binary", p);
        continue;
      }
      const after = fs.statSync(absolute);
      if (
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs
      ) {
        warn("read", p);
        continue;
      }
      const revision = createHash("sha256")
        .update(text)
        .digest("hex")
        .slice(0, 32);
      const entry: SourceEntry = {
        path: p,
        kind: "note",
        size: stat.size,
        revision,
        updated: stat.mtime.toISOString(),
      };
      observation.unavailable = false;
      observation.source = { path: p, kind: "note", revision };
      reads.set(p, { entry, text, mtimeMs: stat.mtimeMs });
    } catch {
      observation.unavailable = true;
      warn("read", p);
    }
  }
  const force =
    options.full ||
    (!!priorManifest && priorManifest.schemaVersion !== INDEX_SCHEMA_VERSION);
  const changes = planSourceChanges(before, observations, {
    complete: !watched,
    force,
  });
  const target = new Map(previous);
  const prepared: { note: IndexRow; chunks: IndexRow[] }[] = [];
  const reused: IndexRow[] = [];
  const removed: string[] = [];
  let notesSkipped = 0;
  const ids = new Map(
    previousRows.map((row) => [String(row.note_id), String(row.path)]),
  );
  for (const change of changes) {
    if (change.action === "remove") {
      target.delete(change.path);
      removed.push(change.path);
      continue;
    }
    if (change.action === "ignore" || change.action === "preserve") continue;
    const read = reads.get(change.path)!;
    const id = String(
      previous.get(change.path)?.note_id ?? noteIdFromPath(change.path),
    );
    if (ids.has(id) && ids.get(id) !== change.path)
      throw new IndexError(
        "INDEX_ID_COLLISION",
        "Index ID collision requires a full rebuild.",
      );
    ids.set(id, change.path);
    try {
      const update = await prepareNoteUpdate(
        read.entry,
        previous.get(change.path) ?? null,
        async () => read.text,
        { force, noteId: id, mtimeMs: read.mtimeMs },
      );
      target.set(change.path, update.note);
      if (update.action === "reuse") {
        notesSkipped++;
        reused.push(update.note);
        continue;
      }
      prepared.push(update);
      if (update.oversized) warn("large", change.path, read.entry.size);
      if (update.frontmatterDegraded) warn("frontmatter", change.path);
    } catch {
      warn("read", change.path);
    }
  }
  const replacedIds = new Set(prepared.map((p) => String(p.note.note_id)));
  const remainingIds = new Set(
    [...target.values()].map((row) => String(row.note_id)),
  );
  const chunkRows: IndexRow[] = store.getAllChunkIds().flatMap((id) => {
    const chunk = store.getChunkById(id);
    return chunk &&
      remainingIds.has(String(chunk.note_id)) &&
      !replacedIds.has(String(chunk.note_id))
      ? [chunk]
      : [];
  });
  for (const p of prepared) chunkRows.push(...p.chunks);
  const vectors: PreparedEmbedding[] = [];
  const required = options.requireEmbeddings ?? config.embedding.require;
  let dimension: number | null = null;
  const model = config.embedding.enabled
    ? config.embedding.model || null
    : null;
  if (config.embedding.enabled) {
    const endpointError = model
      ? validateEmbeddingEndpoint(
          config.embedding.endpoint,
          config.embedding.allow_private_network_endpoint,
        )
      : "Embedding model is required.";
    const unavailable = !store.isVecAvailable();
    if (unavailable || endpointError) {
      const code = unavailable
        ? "EMBEDDING_UNAVAILABLE"
        : model
          ? "EMBEDDING_CONFIG_INVALID"
          : "EMBEDDING_NO_MODEL";
      if (required)
        throw new IndexError(
          unavailable ? code : "EMBEDDING_CONFIG_INVALID",
          "Embeddings are unavailable or misconfigured.",
        );
      warnings.push({
        code,
        message:
          "Embeddings are unavailable or misconfigured; lexical indexing remains usable.",
      });
    } else {
      const provider = new EmbeddingProvider(config),
        cacheSource = options.cacheSource ?? store;
      let descriptor = provider.describe();
      const cachedManifest = cacheSource.getManifest();
      if (cachedManifest?.embeddingModel === model)
        descriptor = {
          ...descriptor,
          dimension:
            cacheSource.getEmbeddingDimension() ??
            cachedManifest.embeddingDimension,
        };
      try {
        for (
          let offset = 0;
          offset < chunkRows.length;
          offset += descriptor.maxBatchSize
        ) {
          const batch = chunkRows
            .slice(offset, offset + descriptor.maxBatchSize)
            .map((row) => ({
              chunkId: String(row.chunk_id),
              contentHash: String(row.content_hash),
              text: String(row.embedding_input_text ?? row.content ?? "").slice(
                0,
                CHUNK_EMBEDDING_INPUT_CAP,
              ),
              vectorKey: replacedIds.has(String(row.note_id))
                ? null
                : (row.embedding_key as string | null | undefined),
            }));
          const result = await prepareEmbeddingBatch(batch, {
            enabled: true,
            provider,
            descriptor,
            cache: {
              get: async (key) =>
                store.getEmbeddingCache(key) ??
                cacheSource.getEmbeddingCache(key),
            },
          });
          vectors.push(...result);
          if (result.length) {
            dimension = result[0]!.values.length;
            descriptor = { ...descriptor, dimension };
          }
        }
        const current = store.getEmbeddingDimension();
        if (dimension !== null && current !== null && dimension !== current)
          throw new IndexError(
            "INDEX_EMBEDDING_DIMENSION_MISMATCH",
            "Embedding dimensions changed; a full rebuild is required.",
          );
      } catch (error) {
        if (required)
          throw new IndexError(
            error instanceof IndexError ? error.code : "EMBEDDING_FAILED",
            "Embedding preparation failed; the previous index was preserved.",
          );
        vectors.length = 0;
        dimension = store.getEmbeddingDimension();
        warnings.push({
          code: "EMBEDDING_FAILED",
          message:
            "Embedding preparation failed; lexical indexing remains usable.",
        });
      }
    }
  }
  const resolve = createIndexLinkResolver(target.values());
  const linked: IndexRow[] = [...target.values()].map(resolve);
  const manifest: IndexManifest = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    vaultIdentity: options.vaultIdentity,
    indexedFileExtensions: [...INDEXED_EXTENSIONS],
    effectiveExcludePatterns: [
      ...DEFAULT_EXCLUDE_PATTERNS,
      ...config.vault.exclude,
    ],
    targetChunkSize: TARGET_CHUNK_SIZE,
    maxChunkSize: MAX_CHUNK_SIZE,
    embeddingModel: model,
    embeddingDimension:
      dimension ?? (model ? store.getEmbeddingDimension() : null),
    noteCount: target.size,
    chunkCount: chunkRows.length,
    indexedAt: Date.now(),
  };
  store.beginTransaction();
  try {
    if (JSON.stringify(store.getManifest()) !== priorSignature)
      throw new IndexError(
        "INDEX_BUSY",
        "Index changed while update data was being prepared.",
      );
    for (const p of removed) store.deleteNoteByPath(p);
    for (const p of prepared) store.upsertPreparedNote(p.note, p.chunks);
    for (const row of reused) {
      const old = previous.get(String(row.path));
      if (old?.file_size !== row.file_size || old?.mtime_ms !== row.mtime_ms)
        store.updateNoteObservation(row);
    }
    for (const row of linked) {
      const old = target.get(String(row.path));
      if (
        !indexRowsEqual(old?.links_json, row.links_json) ||
        !indexRowsEqual(old?.wikilinks_json, row.wikilinks_json)
      )
        store.updateNoteLinks(row);
    }
    if (vectors.length) {
      store.initVecTable(dimension!);
      store.storePreparedEmbeddings(vectors);
    }
    store.setManifest(manifest);
    store.commit();
  } catch (error) {
    store.rollback();
    throw error;
  }
  return {
    mode: options.full ? "full" : "incremental",
    notesIndexed: prepared.length,
    chunksIndexed: prepared.reduce((n, p) => n + p.chunks.length, 0),
    notesSkipped,
    warnings: warnings.slice(0, 100),
  };
}
