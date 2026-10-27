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

export { parseChunkId, isValidNoteId } from "./portable/id-validation.js";
