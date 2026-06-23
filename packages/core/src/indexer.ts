import { IndexStore, getIndexPath } from "./index-store.js";
import { VaultDiscovery } from "./discovery.js";
import { parseMarkdown, resolveWikilinks } from "./markdown.js";
import { chunkNote } from "./chunking.js";
import { noteIdFromPath, vaultIdentity } from "./identifiers.js";
import { validateVaultPath } from "./pathsafety.js";
import { Config } from "./config.js";
import { Note, IndexManifest, IndexResult, IndexWarning } from "./types.js";
import {
  INDEX_SCHEMA_VERSION,
  DEFAULT_EXCLUDE_PATTERNS,
  MAX_MARKDOWN_SIZE_FOR_INDEXING,
  CHUNK_EMBEDDING_INPUT_CAP,
} from "./schemas.js";
import { resolveIndexDir } from "./paths.js";
import { IndexError } from "./errors.js";
import {
  EmbeddingProvider,
  EmbeddingProviderError,
  validateEmbeddingEndpoint,
} from "./embedding.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

export interface IndexOptions {
  requireEmbeddings?: boolean;
}

export async function indexVault(
  config: Config,
  options?: IndexOptions,
): Promise<IndexResult> {
  const lockPath = getLockFilePath(config);
  acquireLock(lockPath);
  try {
    const vaultRoot = validateVaultPath(config.vault.root);
    const dbPath = getIndexPath(config);
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const store = await IndexStore.open(dbPath);

    try {
      const vid = vaultIdentity(vaultRoot);

      return await performIndex(
        store,
        config,
        vaultRoot,
        vid,
        false,
        options?.requireEmbeddings,
      );
    } finally {
      store.close();
    }
  } finally {
    releaseLock(lockPath);
  }
}

export async function reindexVault(
  config: Config,
  options?: IndexOptions,
): Promise<IndexResult> {
  const lockPath = getLockFilePath(config);
  acquireLock(lockPath);
  try {
    const vaultRoot = validateVaultPath(config.vault.root);
    const dbPath = getIndexPath(config);
    const { indexPath, tmpPath } = getReindexPaths(dbPath);

    const dir = path.dirname(indexPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tmpStore = await IndexStore.open(tmpPath);

    let result: IndexResult;
    try {
      const vid = vaultIdentity(vaultRoot);
      result = await performIndex(
        tmpStore,
        config,
        vaultRoot,
        vid,
        true,
        options?.requireEmbeddings,
      );
    } catch (error) {
      tmpStore.close();
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
      if (fs.existsSync(tmpPath + "-wal")) {
        fs.unlinkSync(tmpPath + "-wal");
      }
      if (fs.existsSync(tmpPath + "-shm")) {
        fs.unlinkSync(tmpPath + "-shm");
      }
      throw error;
    }

    tmpStore.close();

    if (fs.existsSync(indexPath + "-wal")) {
      fs.unlinkSync(indexPath + "-wal");
    }
    if (fs.existsSync(indexPath + "-shm")) {
      fs.unlinkSync(indexPath + "-shm");
    }

    fs.renameSync(tmpPath, indexPath);

    if (fs.existsSync(tmpPath + "-wal")) {
      fs.unlinkSync(tmpPath + "-wal");
    }
    if (fs.existsSync(tmpPath + "-shm")) {
      fs.unlinkSync(tmpPath + "-shm");
    }

    return result;
  } finally {
    releaseLock(lockPath);
  }
}

function getReindexPaths(dbPath: string): {
  indexPath: string;
  tmpPath: string;
} {
  return {
    indexPath: dbPath,
    tmpPath: dbPath.replace("index.sqlite", "index.tmp.sqlite"),
  };
}

async function performIndex(
  store: IndexStore,
  config: Config,
  vaultRoot: string,
  vid: string,
  isFull: boolean,
  requireEmbeddingsOverride?: boolean,
): Promise<IndexResult> {
  const effectiveRequireEmbeddings =
    requireEmbeddingsOverride ?? config.embedding.require;

  const discovery = new VaultDiscovery(vaultRoot, config.vault.exclude);
  const discovered = discovery.discover();

  const allNoteStems: Map<
    string,
    Array<{ noteId: string; title: string | null; aliases: string[] }>
  > = isFull ? new Map() : store.getAllNoteStems();
  const rawNotes: Note[] = [];
  const warnings: IndexWarning[] = [];
  let notesIndexed = 0;
  let chunksIndexed = 0;
  let notesSkipped = 0;

  const existingManifest = isFull ? null : store.getManifest();
  const forceRewriteExisting =
    existingManifest !== null &&
    existingManifest.schemaVersion !== INDEX_SCHEMA_VERSION;

  const existingPaths = new Set<string>();
  if (!isFull) {
    for (const p of store.getAllNotePaths()) {
      existingPaths.add(p);
    }
  }

  for (const file of discovered.files) {
    try {
      if (!isFull) {
        existingPaths.delete(file.vaultRelativePath);
      }

      if (!isFull && !forceRewriteExisting) {
        const existing = store.getNoteByPath(file.vaultRelativePath);
        if (
          existing &&
          existing.file_size === file.size &&
          existing.mtime_ms === file.mtimeMs
        ) {
          notesSkipped++;
          continue;
        }
      }

      const content = new TextDecoder("utf-8", { fatal: true }).decode(
        fs.readFileSync(file.absolutePath),
      );

      if (content.includes("\0")) {
        warnings.push({
          code: "FILE_BINARY",
          message: `File contains null bytes: ${file.vaultRelativePath}`,
          path: file.vaultRelativePath,
        });
        continue;
      }

      const parsed = parseMarkdown(content);
      const noteId = noteIdFromPath(file.vaultRelativePath);

      const chunkResult = chunkNote({
        noteId,
        vaultRelativePath: file.vaultRelativePath,
        title: parsed.title,
        headingPath: [],
        body: parsed.body,
        fileSize: file.size,
      });

      if (file.size > MAX_MARKDOWN_SIZE_FOR_INDEXING) {
        warnings.push({
          code: "FILE_TOO_LARGE_FOR_INDEXING",
          message: `File too large for indexing: ${file.vaultRelativePath}`,
          path: file.vaultRelativePath,
          size: file.size,
        });
      }

      if (parsed.frontmatterDegraded) {
        warnings.push({
          code: "FRONTMATTER_PARSE_FAILED",
          message: `Malformed frontmatter in: ${file.vaultRelativePath}`,
          path: file.vaultRelativePath,
        });
      }

      const contentHash = hashContent(content);

      const note: Note = {
        noteId,
        vaultRelativePath: file.vaultRelativePath,
        title: parsed.title,
        filePath: file.absolutePath,
        frontmatter: parsed.frontmatter,
        frontmatterDegraded: parsed.frontmatterDegraded,
        size: file.size,
        contentHash,
        mtimeMs: file.mtimeMs,
        chunks: chunkResult.chunks,
        links: parsed.wikilinks,
        attachmentReferences: parsed.attachmentReferences,
      };

      rawNotes.push(note);

      const stem = file.vaultRelativePath
        .split("/")
        .pop()!
        .replace(/\.(md|markdown)$/i, "");
      const stemEntries =
        allNoteStems.get(stem)?.filter((entry) => entry.noteId !== noteId) ??
        [];
      stemEntries.push({
        noteId,
        title: parsed.title,
        aliases: parsed.aliases,
      });
      allNoteStems.set(stem, stemEntries);
    } catch {
      warnings.push({
        code: "FILE_NOT_UTF8",
        message: `Failed to read file: ${file.vaultRelativePath}`,
        path: file.vaultRelativePath,
      });
    }
  }

  for (const deletedPath of existingPaths) {
    const deletedNoteId = noteIdFromPath(deletedPath);
    for (const [stem, entries] of allNoteStems) {
      const remaining = entries.filter(
        (entry) => entry.noteId !== deletedNoteId,
      );
      if (remaining.length === 0) {
        allNoteStems.delete(stem);
      } else if (remaining.length !== entries.length) {
        allNoteStems.set(stem, remaining);
      }
    }
  }

  const resolver = resolveWikilinks(allNoteStems);
  for (const note of rawNotes) {
    note.links = note.links.map(resolver);
  }

  const deletedPaths = Array.from(existingPaths);

  store.beginTransaction();
  try {
    for (const p of deletedPaths) {
      store.deleteNoteByPath(p);
    }

    for (const note of rawNotes) {
      store.upsertNote(note);
      notesIndexed++;
      chunksIndexed += note.chunks.length;
    }

    const manifest: IndexManifest = {
      schemaVersion: INDEX_SCHEMA_VERSION,
      vaultIdentity: vid,
      indexedFileExtensions: [".md", ".markdown"],
      effectiveExcludePatterns: [
        ...DEFAULT_EXCLUDE_PATTERNS,
        ...config.vault.exclude,
      ],
      targetChunkSize: 2000,
      maxChunkSize: 4000,
      embeddingModel: null,
      embeddingDimension: null,
      noteCount: store.getAllNotes().length,
      chunkCount: store.getAllChunkIds().length,
      indexedAt: Date.now(),
    };

    if (config.embedding.enabled && !store.isVecAvailable()) {
      if (effectiveRequireEmbeddings) {
        throw new IndexError(
          "EMBEDDING_UNAVAILABLE",
          "Embedding search is unavailable because sqlite-vec could not be loaded.",
        );
      }
      warnings.push({
        code: "EMBEDDING_UNAVAILABLE",
        message:
          "Embedding search is unavailable because sqlite-vec could not be loaded. Lexical index is still usable.",
      });
    } else if (config.embedding.enabled) {
      if (!config.embedding.model) {
        if (effectiveRequireEmbeddings) {
          throw new IndexError(
            "EMBEDDING_CONFIG_INVALID",
            "Embedding model is required when embeddings are enabled with require=true",
          );
        }
        warnings.push({
          code: "EMBEDDING_NO_MODEL",
          message:
            "Embedding is enabled but no model is configured. Skipping embedding generation.",
        });
      } else {
        const endpointError = validateEmbeddingEndpoint(
          config.embedding.endpoint,
          config.embedding.allow_private_network_endpoint,
        );
        if (endpointError) {
          if (effectiveRequireEmbeddings) {
            throw new IndexError("EMBEDDING_CONFIG_INVALID", endpointError);
          }
          warnings.push({
            code: "EMBEDDING_CONFIG_INVALID",
            message: endpointError,
          });
        } else {
          try {
            const provider = new EmbeddingProvider(config);
            const chunkIds = store.getAllChunkIds();
            const chunksData: {
              chunkId: string;
              text: string;
              hash: string;
            }[] = [];
            for (const chunkId of chunkIds) {
              const chunk = store.getChunkById(chunkId);
              if (chunk) {
                const text =
                  (chunk.embedding_input_text as string) ??
                  (chunk.content as string) ??
                  "";
                chunksData.push({
                  chunkId,
                  text: text.slice(0, CHUNK_EMBEDDING_INPUT_CAP),
                  hash: chunk.content_hash as string,
                });
              }
            }

            if (chunksData.length > 0) {
              const texts = chunksData.map((d) => d.text);
              const hashes = chunksData.map((d) => d.hash);

              const result = await provider.embed(texts);

              store.initVecTable(result.dimension);

              store.storeEmbeddings(
                chunksData.map((d) => d.chunkId),
                result.embeddings,
                hashes,
              );

              manifest.embeddingModel = result.model;
              manifest.embeddingDimension = result.dimension;
            }
          } catch (error) {
            if (effectiveRequireEmbeddings) {
              if (error instanceof EmbeddingProviderError) {
                throw new IndexError("EMBEDDING_FAILED", error.message);
              }
              throw new IndexError(
                "EMBEDDING_FAILED",
                `Embedding generation failed: ${(error as Error).message}`,
              );
            }
            warnings.push({
              code: "EMBEDDING_FAILED",
              message: `Embedding generation failed: ${(error as Error).message}. Lexical index is still usable.`,
            });
          }
        }
      }
    }

    store.setManifest(manifest);
    store.commit();
  } catch (error) {
    store.rollback();
    throw error;
  }

  return {
    mode: isFull ? "full" : "incremental",
    notesIndexed,
    chunksIndexed,
    notesSkipped,
    warnings: warnings.slice(0, 100),
  };
}

function hashContent(content: string): string {
  return crypto
    .createHash("sha-256")
    .update(content)
    .digest("hex")
    .slice(0, 32);
}

function getLockFilePath(config: Config): string {
  const vaultRoot = config.vault.root;
  const resolvedVault = path.resolve(vaultRoot);
  const vid = vaultIdentity(resolvedVault);
  const indexDir = resolveIndexDir(config.index.dir || undefined);
  return path.join(indexDir, vid, "index.lock");
}

function acquireLock(lockPath: string): void {
  if (fs.existsSync(lockPath)) {
    try {
      const content = fs.readFileSync(lockPath, "utf-8");
      const data = JSON.parse(content) as { pid: number; timestamp: number };
      if (isProcessRunning(data.pid)) {
        throw new IndexError(
          "INDEX_BUSY",
          `Index is already being built by process ${data.pid}`,
          { pid: data.pid },
        );
      }
    } catch (e) {
      if (e instanceof IndexError) throw e;
    }
    fs.unlinkSync(lockPath);
  }

  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, timestamp: Date.now() }),
  );
}

function releaseLock(lockPath: string): void {
  try {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  } catch {}
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
