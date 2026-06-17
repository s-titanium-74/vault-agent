import { Config } from "./config.js";
import { IndexStore } from "./index-store.js";
import { IndexResult, IndexWarning, Note } from "./types.js";
import { parseMarkdown } from "./markdown.js";
import { chunkNote } from "./chunking.js";
import { noteIdFromPath } from "./identifiers.js";
import { IndexError } from "./errors.js";
import {
  MAX_MARKDOWN_SIZE_FOR_INDEXING,
  INDEXED_EXTENSIONS,
} from "./schemas.js";
import { VaultDiscovery } from "./discovery.js";
import {
  PathSafetyError,
  resolveVaultRelativePath,
  toVaultRelative,
} from "./pathsafety.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

export interface IncrementalIndexOptions {
  paths: string[];
  requireEmbeddings?: boolean;
}

export interface IncrementalIndexUpdate {
  added: string[];
  modified: string[];
  deleted: string[];
  degraded: string[];
}

export async function incrementalIndexUpdate(
  store: IndexStore,
  config: Config,
  options: IncrementalIndexOptions,
): Promise<IndexResult> {
  const { paths } = options;
  if (paths.length === 0) {
    return {
      mode: "incremental",
      notesIndexed: 0,
      chunksIndexed: 0,
      notesSkipped: 0,
      warnings: [],
    };
  }

  const warnings: IndexWarning[] = [];
  let notesIndexed = 0;
  let chunksIndexed = 0;
  let notesSkipped = 0;

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
    throw new IndexError(
      code,
      `${reasons}. Run vault-agent reindex to rebuild the index.`,
    );
  }
  if (staleness.stale) {
    warnings.push({
      code: "INDEX_STALE",
      message: `Index is stale: ${staleness.details}. Incremental updates may be out of sync.`,
    });
  }

  const vaultRoot = path.resolve(config.vault.root);

  const markdownPaths = new Set<string>();
  const attachmentPaths = new Set<string>();

  for (const p of paths) {
    const normalizedPath = normalizeIncrementalPath(vaultRoot, p);
    if (!normalizedPath || normalizedPath === ".") continue;

    const ext = path.extname(normalizedPath).toLowerCase();
    if (INDEXED_EXTENSIONS.includes(ext)) {
      markdownPaths.add(normalizedPath);
    } else {
      attachmentPaths.add(normalizedPath);
    }
  }

  const deletedPaths: string[] = [];
  const modifiedPaths: string[] = [];

  for (const p of markdownPaths) {
    const absolutePath = path.join(vaultRoot, p);
    if (!fs.existsSync(absolutePath)) {
      deletedPaths.push(p);
    } else {
      modifiedPaths.push(p);
    }
  }

  const existingNoteStems = store.getAllNoteStems();
  const affectedNoteIds = new Set<string>();
  const newNoteIds = new Set<string>();

  for (const modifiedPath of modifiedPaths) {
    const existing = store.getNoteByPath(modifiedPath);
    if (!existing) {
      const candidateId = noteIdFromPath(modifiedPath);
      if (newNoteIds.has(candidateId)) {
        throw new IndexError(
          "INDEX_ID_COLLISION",
          `ID collision detected for path: ${modifiedPath}. A full reindex is required.`,
        );
      }
      newNoteIds.add(candidateId);
    }
  }

  store.beginTransaction();
  try {
    for (const deletedPath of deletedPaths) {
      const noteId = noteIdFromPath(deletedPath);
      store.deleteNoteByPath(deletedPath);
      affectedNoteIds.add(noteId);

      const filename = deletedPath.split("/").pop() ?? "";
      const stem = filename.replace(/\.(md|markdown)$/i, "");
      const stemEntries = existingNoteStems
        .get(stem)
        ?.filter((e) => e.noteId !== noteId);
      if (stemEntries && stemEntries.length > 0) {
        existingNoteStems.set(stem, stemEntries);
      } else {
        existingNoteStems.delete(stem);
      }
    }

    for (const vaultRelativePath of modifiedPaths) {
      const absolutePath = path.join(vaultRoot, vaultRelativePath);

      try {
        const stat = fs.statSync(absolutePath);
        const existing = store.getNoteByPath(vaultRelativePath);

        if (
          existing &&
          existing.file_size === stat.size &&
          existing.mtime_ms === stat.mtimeMs
        ) {
          notesSkipped++;
          continue;
        }

        const content = new TextDecoder("utf-8", { fatal: false }).decode(
          fs.readFileSync(absolutePath),
        );

        if (content.includes("\0")) {
          warnings.push({
            code: "INDEX_FILE_BINARY",
            message: `File contains null bytes: ${vaultRelativePath}`,
            path: vaultRelativePath,
          });
          continue;
        }

        const parsed = parseMarkdown(content);
        const noteId = existing
          ? (existing.note_id as string)
          : noteIdFromPath(vaultRelativePath);
        const contentHash = hashContent(content);

        const chunkResult = chunkNote({
          noteId,
          vaultRelativePath,
          title: parsed.title,
          headingPath: [],
          body: parsed.body,
          fileSize: stat.size,
        });

        if (stat.size > MAX_MARKDOWN_SIZE_FOR_INDEXING) {
          warnings.push({
            code: "INDEX_FILE_TOO_LARGE",
            message: `File too large for indexing: ${vaultRelativePath}`,
            path: vaultRelativePath,
            size: stat.size,
          });
        }

        if (parsed.frontmatterDegraded) {
          warnings.push({
            code: "INDEX_FRONTMATTER_PARSE_FAILED",
            message: `Malformed frontmatter in: ${vaultRelativePath}`,
            path: vaultRelativePath,
          });
        }

        const note: Note = {
          noteId,
          vaultRelativePath,
          title: parsed.title,
          filePath: absolutePath,
          frontmatter: parsed.frontmatter,
          frontmatterDegraded: parsed.frontmatterDegraded,
          size: stat.size,
          contentHash,
          mtimeMs: stat.mtimeMs,
          chunks: chunkResult.chunks,
          links: parsed.wikilinks,
          attachmentReferences: parsed.attachmentReferences,
        };

        store.upsertNote(note);
        notesIndexed++;
        chunksIndexed += note.chunks.length;
        affectedNoteIds.add(noteId);

        const filename = vaultRelativePath.split("/").pop() ?? "";
        const stem = filename.replace(/\.(md|markdown)$/i, "");
        const stemEntries =
          existingNoteStems.get(stem)?.filter((e) => e.noteId !== noteId) ?? [];
        stemEntries.push({
          noteId,
          title: parsed.title,
          aliases: parsed.aliases,
        });
        existingNoteStems.set(stem, stemEntries);
      } catch (err) {
        if (err instanceof Error && err.message.includes("encoding")) {
          warnings.push({
            code: "INDEX_FILE_NOT_UTF8",
            message: `Failed to read file: ${vaultRelativePath}`,
            path: vaultRelativePath,
          });
        } else {
          warnings.push({
            code: "INDEX_FILE_READ_FAILED",
            message: `Failed to process file: ${vaultRelativePath}: ${(err as Error).message}`,
            path: vaultRelativePath,
          });
        }
      }
    }

    for (const attachmentPath of attachmentPaths) {
      const absolutePath = path.join(vaultRoot, attachmentPath);
      if (!fs.existsSync(absolutePath)) {
        continue;
      }
      try {
        fs.statSync(absolutePath);
        if (
          VaultDiscovery.isAttachmentAllowed(
            vaultRoot,
            attachmentPath,
            config.vault.exclude,
          )
        ) {
          // Attachments are tracked via note's attachmentReferences
          // No direct attachment indexing needed for search
        }
      } catch {
        // Ignore attachment stat errors
      }
    }

    const manifest = store.getManifest();
    if (manifest) {
      store.setManifest({
        ...manifest,
        noteCount: store.getAllNotes().length,
        chunkCount: store.getAllChunkIds().length,
        indexedAt: Date.now(),
      });
    }

    store.commit();
  } catch (err) {
    store.rollback();
    throw err;
  }

  return {
    mode: "incremental",
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

function normalizeIncrementalPath(
  vaultRoot: string,
  inputPath: string,
): string {
  try {
    const absolutePath = resolveVaultRelativePath(vaultRoot, inputPath);
    return toVaultRelative(absolutePath, vaultRoot);
  } catch (err) {
    if (err instanceof PathSafetyError) {
      throw new IndexError(
        "INDEX_UPDATE_FAILED",
        "Changed path resolves outside the vault root.",
      );
    }
    throw err;
  }
}
