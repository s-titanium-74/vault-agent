import fs from "node:fs";
import path from "node:path";
import mime from "mime-types";
import { IndexStore } from "./index-store.js";
import {
  NoteRetrieveResult,
  ChunkRetrieveResult,
  AttachmentMetadataResult,
  DEFAULT_NOTE_RETRIEVAL_SIZE_LIMIT,
  DEFAULT_ATTACHMENT_DOWNLOAD_SIZE_LIMIT,
} from "./schemas.js";
import { isValidNoteId } from "./identifiers.js";
import { validateVaultPath, resolveVaultRelativePath } from "./pathsafety.js";
import { PathSafetyError } from "./pathsafety.js";
import { VaultDiscovery } from "./discovery.js";
import { RetrievalSizeError } from "./errors.js";

export function getNote(
  store: IndexStore,
  noteId: string,
  vaultRoot: string,
  allowLarge?: boolean,
): NoteRetrieveResult | null {
  if (!isValidNoteId(noteId)) {
    return null;
  }

  const note = store.getNote(noteId);
  if (!note) return null;

  const vaultRealPath = validateVaultPath(vaultRoot);
  const vrp = note.path as string;
  const absolutePath = path.join(vaultRealPath, vrp);

  let content: string;
  try {
    content = fs.readFileSync(absolutePath, "utf-8");
  } catch {
    return null;
  }

  const size = Buffer.byteLength(content, "utf-8");
  const sizeLimit = DEFAULT_NOTE_RETRIEVAL_SIZE_LIMIT;

  if (size > sizeLimit && !allowLarge) {
    throw new RetrievalSizeError(
      "NOTE_TOO_LARGE",
      `Note exceeds size limit (${size} bytes, limit ${sizeLimit} bytes)`,
      { size, limit: sizeLimit },
    );
  }

  const linksJson = note.links_json as string | null;
  const attachmentRefsJson = note.attachment_refs_json as string | null;

  let links: { resolved: string[]; unresolved: string[] } | undefined;
  let attachments: string[] | undefined;

  if (linksJson) {
    try {
      const parsed = JSON.parse(linksJson);
      links = {
        resolved: parsed
          .filter((l: { resolved: string | null }) => l.resolved !== null)
          .map((l: { resolved: string }) => l.resolved),
        unresolved: parsed
          .filter((l: { resolved: string | null }) => l.resolved === null)
          .map((l: { target: string }) => l.target),
      };
    } catch {
      links = undefined;
    }
  }

  if (attachmentRefsJson) {
    try {
      attachments = JSON.parse(attachmentRefsJson);
    } catch {
      attachments = undefined;
    }
  }

  return {
    id: noteId,
    path: vrp,
    title: note.frontmatter_title as string | null,
    metadata: {
      aliases: JSON.parse((note.aliases_json as string) ?? "[]"),
      tags: JSON.parse((note.tags_json as string) ?? "[]"),
      date: note.date_value as string | null,
      created: note.created_value as string | null,
      updated: note.updated_value as string | null,
      attachmentCount: JSON.parse((note.attachment_refs_json as string) ?? "[]")
        .length as number,
    },
    content,
    contentType: "text/markdown; charset=utf-8",
    size,
    links,
    attachments,
  };
}

export function getChunk(
  store: IndexStore,
  noteId: string,
  chunkIndex: number,
): ChunkRetrieveResult | null {
  if (!isValidNoteId(noteId)) {
    return null;
  }

  const chunk = store.getChunk(noteId, chunkIndex);
  if (!chunk) return null;

  const note = store.getNote(noteId);

  return {
    id: `${noteId}:${chunkIndex}`,
    noteId,
    chunkIndex,
    path: chunk.path as string,
    title: (chunk.title as string) ?? null,
    heading: (chunk.heading as string) ?? null,
    headingPath: JSON.parse((chunk.heading_path_json as string) ?? "[]"),
    metadata: {
      aliases: JSON.parse((note?.aliases_json as string) ?? "[]"),
      tags: JSON.parse((note?.tags_json as string) ?? "[]"),
      date: (note?.date_value as string) ?? null,
      created: (note?.created_value as string) ?? null,
      updated: (note?.updated_value as string) ?? null,
      attachmentCount: JSON.parse(
        (note?.attachment_refs_json as string) ?? "[]",
      ).length as number,
    },
    content: chunk.content as string,
    contentType: "text/markdown; charset=utf-8",
    size: (chunk.content as string).length,
  };
}

export class InvalidPathError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "InvalidPathError";
  }
}

export function getAttachmentMetadata(
  vaultRoot: string,
  vaultRelativePath: string,
  userExcludePatterns: string[] = [],
): AttachmentMetadataResult | null {
  const vaultRealPath = validateVaultPath(vaultRoot);

  try {
    const resolved = resolveVaultRelativePath(vaultRealPath, vaultRelativePath);
    const stat = fs.statSync(resolved);

    if (stat.isDirectory()) {
      throw new InvalidPathError(
        "INVALID_PATH",
        `Path is a directory, not a file: ${vaultRelativePath}`,
      );
    }

    const ext = path.extname(resolved).toLowerCase();
    if (ext === ".md" || ext === ".markdown") {
      return null;
    }

    if (
      !VaultDiscovery.isAttachmentAllowed(
        vaultRealPath,
        vaultRelativePath,
        userExcludePatterns,
      )
    ) {
      return null;
    }

    const contentType = getContentType(resolved);

    return {
      path: vaultRelativePath,
      fileName: path.basename(resolved),
      contentType,
      size: stat.size,
      downloadAvailable: stat.size <= DEFAULT_ATTACHMENT_DOWNLOAD_SIZE_LIMIT,
    };
  } catch (error) {
    if (error instanceof PathSafetyError) throw error;
    if (error instanceof InvalidPathError) throw error;
    return null;
  }
}

export function getAttachmentBytes(
  vaultRoot: string,
  vaultRelativePath: string,
  allowLarge?: boolean,
  userExcludePatterns: string[] = [],
): { bytes: Buffer; contentType: string; fileName: string } | null {
  const vaultRealPath = validateVaultPath(vaultRoot);

  try {
    const resolved = resolveVaultRelativePath(vaultRealPath, vaultRelativePath);
    const stat = fs.statSync(resolved);

    if (stat.isDirectory()) {
      throw new InvalidPathError(
        "INVALID_PATH",
        `Path is a directory, not a file: ${vaultRelativePath}`,
      );
    }

    const ext = path.extname(resolved).toLowerCase();
    if (ext === ".md" || ext === ".markdown") {
      return null;
    }

    if (
      !VaultDiscovery.isAttachmentAllowed(
        vaultRealPath,
        vaultRelativePath,
        userExcludePatterns,
      )
    ) {
      return null;
    }

    if (!allowLarge && stat.size > DEFAULT_ATTACHMENT_DOWNLOAD_SIZE_LIMIT) {
      throw new RetrievalSizeError(
        "ATTACHMENT_TOO_LARGE",
        `Attachment exceeds download size limit (${stat.size} bytes, limit ${DEFAULT_ATTACHMENT_DOWNLOAD_SIZE_LIMIT} bytes)`,
        { size: stat.size, limit: DEFAULT_ATTACHMENT_DOWNLOAD_SIZE_LIMIT },
      );
    }

    const bytes = fs.readFileSync(resolved);
    const contentType = getContentType(resolved);
    const fileName = path.basename(resolved);

    return { bytes, contentType, fileName };
  } catch (error) {
    if (error instanceof PathSafetyError) throw error;
    if (error instanceof RetrievalSizeError) throw error;
    if (error instanceof InvalidPathError) throw error;
    return null;
  }
}

function getContentType(filePath: string): string {
  const mimeType = mime.lookup(filePath);
  return mimeType || "application/octet-stream";
}
