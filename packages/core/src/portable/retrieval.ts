import type { MetadataLexicalStore, VaultSource } from "./contracts.js";
import { isValidNoteId } from "./id-validation.js";
import { noteFromRow, chunkFromRows } from "../retrieval-shared.js";
import { DEFAULT_NOTE_RETRIEVAL_SIZE_LIMIT } from "../schemas.js";
import { SourceError } from "./source-policy.js";
import { RetrievalSizeError } from "../errors.js";
import { contentRevision } from "./identifiers.js";

export async function getNote(
  store: MetadataLexicalStore,
  source: VaultSource,
  id: string,
  options: {
    allowLarge?: boolean;
    maxBytes?: number;
    signal?: AbortSignal;
  } = {},
) {
  if (store.vaultId !== source.vaultId)
    throw new SourceError("SOURCE_EXCLUDED", "Vault identity does not match.");
  if (!isValidNoteId(id)) return null;
  const note = await store.getNote(id);
  if (!note) return null;
  const entry = await source.stat(note.path as string, options.signal);
  if (!entry) return null;
  const hash = note.content_hash;
  if (
    typeof hash !== "string" ||
    (hash.length !== 32 && hash.length !== 64) ||
    !/^[a-f0-9]+$/.test(hash) ||
    (hash.length === 64 && entry.revision !== hash)
  )
    throw new SourceError(
      "SOURCE_REVISION_MISMATCH",
      "Source and index revisions differ.",
    );
  if (!options.allowLarge && entry.size > DEFAULT_NOTE_RETRIEVAL_SIZE_LIMIT)
    throw new RetrievalSizeError("NOTE_TOO_LARGE", "Note exceeds size limit.", {
      size: entry.size,
      limit: DEFAULT_NOTE_RETRIEVAL_SIZE_LIMIT,
    });
  const content = await source.readText(entry.path, {
    expectedRevision: entry.revision,
    maxBytes:
      options.maxBytes ??
      (options.allowLarge
        ? 2 * 1024 * 1024
        : DEFAULT_NOTE_RETRIEVAL_SIZE_LIMIT),
    signal: options.signal,
  });
  // Legacy SQLite hashes decoded text (including UTF-8 BOM handling), while
  // portable source revisions hash exact bytes. Do not confuse the two.
  if (
    hash.length === 32 &&
    (await contentRevision(content)).slice(0, 32) !== hash
  )
    throw new SourceError(
      "SOURCE_REVISION_MISMATCH",
      "Source and index revisions differ.",
    );
  return noteFromRow(
    id,
    note,
    content,
    new TextEncoder().encode(content).byteLength,
  );
}
export async function getChunk(
  store: MetadataLexicalStore,
  id: string,
  index: number,
) {
  if (!isValidNoteId(id) || !Number.isSafeInteger(index) || index < 0)
    return null;
  const chunk = await store.getChunk(id, index);
  if (!chunk) return null;
  const note = await store.getNote(id);
  if (!note) return null;
  return chunkFromRows(id, index, chunk, note);
}
