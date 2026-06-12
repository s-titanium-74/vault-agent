import crypto from "node:crypto";
import path from "node:path";

export function vaultIdentity(vaultRootRealPath: string): string {
  return hashPath(vaultRootRealPath);
}

export function noteIdFromPath(vaultRelativePath: string): string {
  const normalized = normalizeVaultRelativePath(vaultRelativePath);
  return hashPath(normalized);
}

function hashPath(input: string): string {
  return crypto.createHash("sha-256").update(input).digest("hex").slice(0, 32);
}

function normalizeVaultRelativePath(p: string): string {
  const normalized = p.split(path.sep).join("/");
  const segments = normalized.split("/").filter((s) => s !== ".");
  return segments.join("/");
}

export function parseChunkId(
  chunkId: string,
): { noteId: string; chunkIndex: number } | null {
  const parts = chunkId.split(":");
  if (parts.length !== 2) return null;
  const noteId = parts[0]!;
  const chunkIndex = parseInt(parts[1]!, 10);
  if (!/^[0-9a-f]{32}$/.test(noteId)) return null;
  if (isNaN(chunkIndex) || chunkIndex < 0) return null;
  return { noteId, chunkIndex };
}

export function isValidNoteId(id: string): boolean {
  return /^[0-9a-f]{32}$/.test(id);
}
