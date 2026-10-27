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
